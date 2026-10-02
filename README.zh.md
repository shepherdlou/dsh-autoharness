# dsh-autoharness

[English](README.md) | 中文

给 DeepSeek Harness（dsh）用的插件。它会从你平时干活的会话里总结经验，写成技能。下次碰到类似的事，模型先加载这条技能再动手。

举个例子。你让 agent 跑 api 包的测试，它先跑 `npm test` 报错，后来换成 `pnpm --filter api test` 才跑通。这段会话之后，项目里会多出一个 `.dsh/skills/run-api-tests/SKILL.md`：

```markdown
---
name: "run-api-tests"
description: "Run the api package tests with pnpm workspace filtering."
metadata: {"autoharness":{"version":1,"layer":"project","category":"testing"}}
---

Run `pnpm --filter api test` from the repo root; plain `npm test` fails in this workspace.
```

下次开新会话，模型会看到有这么一条技能，加载以后直接用 pnpm。

思路来自 [tigerless-labs/autoharness](https://github.com/tigerless-labs/autoharness)，那是个 Claude Code 插件，这里按 dsh 的插件机制重写了一遍。另外参考了 Hamel Husain 点评 Claude auto-evals 的[那篇文章](https://hamel.dev/blog/posts/claude-auto-evals/)，给每条技能配了评估：学到技能的时候，把当时的场景存成几道题，之后拿这些题去问模型，看带上技能答得是不是比不带好。负责打分的模型也得让人抽查，它判错的次数多了，插件就不再信它打的分。

## 装上以后会发生什么

1. 插件监听会话事件，记下用户说了什么、模型调了哪些工具、结果如何。密钥、token 这类东西先打码，家目录路径换成 `~`。
2. 顶层会话每攒够 50 次工具调用，插件用当前会话的模型回头看一遍这段记录，问它：有没有值得记下来的经验？大多数时候答案是没有。
3. 如果有，模型会提一个改动：新建、修改、合并或者归档某条技能。写盘之前要过一遍检查，比如名字有没有和已有技能撞、正文是不是太长、里面有没有密钥、有没有教人 `rm -rf /` 或 `git push --force`、引用的证据是不是真在这段对话里、有没有附评估题。哪一项不过，这个改动就整个丢掉，原因写进 `runs/`。
4. 检查通过的技能写进 `.dsh/skills/<name>/`。dsh 自己的技能加载器会发现它，不需要重启。
5. 写完马上跑一次评估。
6. 每次开新会话，插件给模型列一个已学技能的简短索引，再顺手整理一下技能库，长期没人用的挪进归档区。

插件只改自己写出来的技能。你手写的技能、`.agents/skills` 下面的、别的插件带的，它只拿来查重名和查重复，一个字都不改。

## 评估怎么做

每条技能带 1 到 3 道题，题目取自学到它的那段对话，比如"这个仓库里 api 的测试怎么跑？"。每道题下面有几条检查，一条检查只看一件事：

- `contains`、`not-contains`、`regex`：回答里有没有某段文字，本地直接判；
- `llm-judge`：一句话的标准，比如"没有建议直接跑 npm test"，交给模型判是或否。

同一道题会问两遍，一遍把技能给模型，一遍不给，两份回答各自过一遍所有检查。带技能的通过率低于 `evalPassThreshold`（默认 0.5），或者比不带技能还低，这条技能就会被标成"需要修改"，失败的地方在下次反思时交给模型去改。

### 别让评估题泄底

题目里要是已经写了答案，评估就测不出东西：不带技能的模型照着题目抄一遍也能过。插件在三个地方防这件事：

- 让反思的模型按"用户下次会怎么问"来出题，那时候用户还不知道这条经验，所以题目里不能出现要考的命令、约定或修法；
- 写盘前检查一遍，`contains`、`regex` 这类检查要找的内容如果题目里本来就有，这条检查直接删掉，删了什么记在 `runs/` 里；
- 带不带技能都能过的检查会被记下来，报告里能看到，下次反思时也会告诉模型，模型可以用 `"replaceEvals": true` 把这条技能的题整套换掉。

答题和打分这两步用模型最低的推理档位（`evalEffort: low`，deepseek-flash 上是 `off`），省时间也省钱。模型要是把额度全花在思考上、一个字没答，就按"没回答"算，检查不通过。

### 让 agent 真跑一遍

自动评估只让模型凭空答一次：不能调工具，也看不到仓库。不带技能的那份回答对项目一无所知，基本都是 0 分，这只能说明技能里有信息，说明不了它能不能让 agent 少走弯路。想知道这个，用：

```
/autoharness replay <技能名|all> [次数]
```

具体做法：

- 把项目复制一份（克隆当前提交，再带上你还没提交的改动；去掉 git remote，依赖目录只读链接过去），在副本里用 `dsh headless` 真跑评估题。带技能跑一次，不带技能跑一次，其他条件都一样：别的技能、模型、仓库内容；
- 子进程用 `workspace-write` 加审批 `never` 的权限：往副本外面写会被 dsh 的沙箱拦下，申请提权一律拒绝；
- 用同样的检查给 agent 执行过的命令和最后的回答打分，报告里再加上两次运行各自的工具调用次数、失败次数、token 和耗时；
- 结果存在 sidecar 的 `eval.agentic` 里。有了回放结果，"需不需要修改"和存活分数就以它为准，失败的地方也会交给下次反思。

dsh 的沙箱不隔离网络，所以回放只在你手动敲命令时才跑。题目里如果有 push、deploy、publish、ssh、生产环境这类会影响外部的操作，这道题就跳过，并告诉你原因。每次回放等于把任务完整跑两遍，花费也按两遍算。

### 抽查打分模型

打分的模型也会判错，所以需要人看一部分。运行：

```
/autoharness review
```

插件会生成 `.dsh/autoharness/evals/review.html`，用浏览器直接打开，不用联网。每道题旁边摆着题目、学到这条技能时的原始对话、技能正文，还有带技能和不带技能的两份回答。你先自己判这条回答过没过，判完页面才显示打分模型的结论，这样不容易被它带着走。标完点"下载标签"，再导入：

```
/autoharness labels ~/Downloads/autoharness-labels.json
```

导入以后：

- 你标过的回答，以你的判断为准；
- 某条检查的打分模型和你的标签一致的比例不到 75%，它在你没标过的回答上就不再计分；
- 分数用最近一次评估的结果重算，不会再调模型。`/autoharness status` 里能看到一致率，比如 `3/4 agree, 1 distrusted`。

标签存在技能目录的 `evals/labels.jsonl` 里，跟题目放在一起。

这套评估只是个近似：模型只答一次，不能调工具，也看不到仓库。它能看出技能有没有把回答往对的方向带，看不出 agent 能不能真把活干完。

## 安装

```sh
dsh plugin --profile tui add dsh-autoharness          # 发布到 npm 以后
dsh plugin --profile tui add /path/to/dsh-autoharness # 从本地目录装
```

`dsh plugin add` 会把包里的 `cordis.patch.yml` 加到 profile 上。只想临时试试，可以用 overlay：

```sh
dsh tui --patch /path/to/dsh-autoharness/examples/dev-patch.yml
```

用 `--patch` 加载时，插件会在自己的目录里找依赖，要先把宿主的包软链过来，做法写在 `examples/dev-patch.yml` 开头。

## 什么时候反思

- tui、web 这种交互式的宿主：放在后台跑，不卡你下一句输入。
- `dsh headless`：答完题进程就退出了，所以要在这一轮收尾之前跑完，崩溃恢复和技能库整理也一起做掉。会话里工具调用达到 `minEpisodeToolCalls`（默认 8 次）才会跑。
- 会话结束时，没反思过的尾巴会再过一遍。进程崩了没来得及处理的记录，下次在同一个项目里开会话时补上。

想固定某种方式，设置 `reflectMode`：`background` 或 `in-turn`，默认 `auto`。

## 命令

| 命令 | 作用 |
|---|---|
| `/learn` | 马上反思当前会话，告诉你写进了什么、拒掉了什么、评估得了几分 |
| `/autoharness status` | 看技能列表、计数、上一次运行的结果 |
| `/autoharness eval [skill]` | 重跑评估，生成 `.dsh/autoharness/evals/report.md` |
| `/autoharness replay <skill\|all> [次数]` | 在项目副本里让 agent 真跑评估题，带技能和不带技能各一次，对比检查结果、工具调用、失败次数、token 和耗时 |
| `/autoharness review [skill]` | 生成 `review.html`，人工标注、抽查打分模型 |
| `/autoharness labels <file>` | 导入从 review 页面下载的标签，重新算分 |
| `/autoharness curate` | 马上整理一次技能库，合并重复的技能 |
| `/autoharness archive <skill>` | 归档一条技能 |
| `/autoharness revive <skill>` | 把最近一次归档的版本拿回来，重新进入试用期 |
| `/autoharness pause` / `resume` | 在这个项目里暂停或恢复学习。暂停期间技能照常能用，使用次数照常统计 |

## 文件放在哪

```
.dsh/skills/<name>/                 # dsh-skill-filesystem 会扫这里（项目层）
  SKILL.md                          # 技能本身
  .sidecar.json                     # 归属、状态、使用次数、评估分数
  .ledger.jsonl                     # 每次新建、修改、合并、评估、毕业、归档都记一行
  references/evidence-<id>.md       # 学到这条技能的那段对话（已打码）
  evals/case-<id>.json              # 评估题和检查
  evals/labels.jsonl                # 你在 review 页面标的结果
.dsh/autoharness/                   # 插件的运行状态，自带 .gitignore
  state.json  last_run.json  runs/  episodes/  snapshots/  archive/  evals/
$DSH_HOME/skills, $DSH_HOME/autoharness   # 全局层，放跨项目都适用的经验
```

`.dsh/skills/` 可以提交进仓库，团队共用。运行记录每层最多留 200 份，评估日志留 50 份，快照 30 天后清掉。归档的技能一直留着。

## 生命周期

新技能先进试用期。项目层要再经过 100 次请求（全局层 300 次）才算试用期满。期满时如果一次都没被加载、也没被打开看过，就归档；否则转正。转正的技能每层有上限（项目 50 条，全局 20 条），超了就把分数最低的归档。分数是使用频率乘以 `0.5 + 0.5 × 评估通过率`，所以光被用、评估却总挂的技能也会排到后面。

## 配置

写在 profile patch 里 `autoharness` 那一项的 `config:` 下面，或者用环境变量。两边都设了的话，环境变量说了算。

| 配置项 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `reflectEveryN` | `AUTOHARNESS_REFLECT_EVERY_N` | 50 | 隔多少次工具调用反思一次 |
| `consolidateEveryN` | `AUTOHARNESS_CONSOLIDATE_EVERY_N` | 250 | 隔多少次工具调用整理一次技能库，0 表示不整理 |
| `digestExchanges` | `AUTOHARNESS_DIGEST_EXCHANGES` | 20 | 反思时最多看最近几轮对话 |
| `minEpisodeToolCalls` | `AUTOHARNESS_MIN_EPISODE_TOOL_CALLS` | 8 | 工具调用少于这个数就不自动反思 |
| `maxIntentsPerRun` | `AUTOHARNESS_MAX_INTENTS_PER_RUN` | 3 | 一次最多改几条技能 |
| `indexEnabled` | `AUTOHARNESS_INDEX_SUSPENDED`（含义相反） | true | 开会话时要不要注入技能索引 |
| `indexDescMaxChars` / `indexMaxLines` | `AUTOHARNESS_INDEX_DESC_MAX_CHARS` / `_INDEX_MAX_LINES` | 60 / 40 | 索引的大小 |
| `skillDescMaxChars` / `skillBodyMaxLines` | `AUTOHARNESS_SKILL_DESC_MAX_CHARS` / `_SKILL_BODY_MAX_LINES` | 1024 / 25 | 技能描述和正文的长度上限 |
| `maturityProject` / `maturityGlobal` | `AUTOHARNESS_MATURITY_PROJECT` / `_GLOBAL` | 100 / 300 | 试用期多长，按请求数算 |
| `capacityProject` / `capacityGlobal` | `AUTOHARNESS_CAPACITY_PROJECT` / `_GLOBAL` | 50 / 20 | 每层最多留几条转正的技能 |
| `graduationSuspended` | `AUTOHARNESS_GRADUATION_SUSPENDED` | false | 设成 true 就不再自动归档 |
| `globalLayer` | `AUTOHARNESS_GLOBAL_LAYER` | true | 允许写到 `$DSH_HOME/skills` 的全局技能 |
| `evalOnPromote` | `AUTOHARNESS_EVAL_ON_PROMOTE` | true | 技能写进去后马上评估 |
| `requireEval` | `AUTOHARNESS_REQUIRE_EVAL` | true | 没附评估题的技能不收 |
| `evalPassThreshold` | `AUTOHARNESS_EVAL_PASS_THRESHOLD` | 0.5 | 通过率低于它就标成需要修改 |
| `evalEffort` | `AUTOHARNESS_EVAL_EFFORT` | low | `low` 表示答题和打分用模型最低的推理档位，`default` 表示用模型默认档位 |
| `provider` / `model` | `AUTOHARNESS_PROVIDER` / `AUTOHARNESS_MODEL` | 跟随会话 | 反思和评估用哪个模型，可以换个便宜的 |
| `reflectMode` | `AUTOHARNESS_REFLECT_MODE` | auto | `background`、`in-turn` 或 `auto` |
| `replay` | `AUTOHARNESS_REPLAY` | manual | `manual` 允许用 `/autoharness replay`，`off` 关掉 |
| `replayTimeoutMs` / `replayRuns` | `AUTOHARNESS_REPLAY_TIMEOUT_MS` / `_REPLAY_RUNS` | 600000 / 1 | 每次运行的时间上限；每道题每种条件跑几次（1 到 5） |
| `dshCommand` | `AUTOHARNESS_DSH_COMMAND` | 当前运行的 dsh | 回放时用哪个 dsh |
| `keepReplays` | `AUTOHARNESS_KEEP_REPLAYS` | false | 保留回放用的副本，方便排查 |
| `drainTimeoutMs` | `AUTOHARNESS_DRAIN_TIMEOUT_MS` | 60000 | 插件卸载时，最多等手头的活多久 |
| `paused` | `AUTOHARNESS_PAUSED` | false | 总开关 |

## 花多少钱，有什么限制

- 每次反思是一次模型请求。
- 开着 `evalOnPromote` 的话，每道题要答两遍，每条 `llm-judge` 检查还要再各判两次。在意费用就把 `provider`、`model` 指向便宜的模型。
- 回放会在项目副本里真的执行命令。副本没法往自己（和 `/tmp`）以外的地方写东西，但能联网。
- 能学到什么取决于模型。写盘前的检查只管格式和安全，管不了经验本身对不对。每次改动都有记录和证据，学错了就 `/autoharness archive` 掉。
- 目前是照着 `@deepseek-ai/dsh` 0.2.0-rc.2 写的，dsh 还在开发者预览阶段，接口以后可能会变。

## 用 DeepSeek 实测的结果

`e2e/real.mjs` 会拿真实模型（dsh 默认的 deepseek-flash）跑一遍。测试项目是个小的计费模块，测试必须带 `APP_ENV=test` 才能跑过，直接 `npm test` 会报错，错误信息里提示去看 `docs/testing.md`。一次跑四个会话：

| 会话 | 结果 |
|---|---|
| "跑一下测试" | `npm test` 报错，agent 找到文档用对了命令。插件学到 `run-billing-demo-tests`，连反思带评估一共 52 秒 |
| "给 `total([])` 加个测试再跑一遍" | agent 第一步就加载了这条技能，直接用对的命令；反思的结论是"已经有了，不用再学" |
| "提交这个测试"，同时说明团队的提交信息规范 | 学到提交规范（项目层），还学到这个沙箱里 git 的一个环境问题，agent 绕过去了（放在全局层） |
| "src/invoice.js 是干嘛的" | 只调了一次工具，没什么可学的 |

| 技能 | 带技能 | 不带 |
|---|---|---|
| run-billing-demo-tests | 100% | 0% |
| commit-messages-in-chinese-with-module-prefix | 100% | 40% |
| fix-broken-git-config-env | 100% | 25% |

真模型跑出了几个用脚本模拟发现不了的问题：推理模型的思考把评估的 token 额度用光了、评估题把要考的内容直接写进了题目、一条技能里抄了另一个问题的绕过办法。这几个都在 0.3.0 里修了。

## 开发

```sh
npm install
npm test               # 单元测试、假宿主上的端到端测试、和真实 dsh 包的集成测试
node e2e/run.mjs       # 在真实的 dsh headless 里跑学习、召回和回放，用脚本模拟模型，不需要 API key
DEEPSEEK_API_KEY=... node e2e/real.mjs   # 用真实的 DeepSeek 跑同样的流程，几分钟，几毛钱
```

`e2e/run.mjs` 会把 `@deepseek-ai/dsh` 装到 `.e2e/` 下（已经装过的话设 `DSH_PREFIX` 指过去），然后用 `e2e/fake-llm.js` 这个假模型跑两个会话。第一个会话里 `npm test` 失败、`pnpm` 成功，要求插件学到技能、存下证据和评估题、打完分。第二个会话要求模型看到索引，通过真实的 `skill` 工具加载这条技能，而且这次加载被记上。

## 许可

MIT
