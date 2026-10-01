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
| `provider` / `model` | `AUTOHARNESS_PROVIDER` / `AUTOHARNESS_MODEL` | 跟随会话 | 反思和评估用哪个模型，可以换个便宜的 |
| `reflectMode` | `AUTOHARNESS_REFLECT_MODE` | auto | `background`、`in-turn` 或 `auto` |
| `drainTimeoutMs` | `AUTOHARNESS_DRAIN_TIMEOUT_MS` | 60000 | 插件卸载时，最多等手头的活多久 |
| `paused` | `AUTOHARNESS_PAUSED` | false | 总开关 |

## 花多少钱，有什么限制

- 每次反思是一次模型请求。
- 开着 `evalOnPromote` 的话，每道题要答两遍，每条 `llm-judge` 检查还要再各判两次。在意费用就把 `provider`、`model` 指向便宜的模型。
- 能学到什么取决于模型。写盘前的检查只管格式和安全，管不了经验本身对不对。每次改动都有记录和证据，学错了就 `/autoharness archive` 掉。
- 目前是照着 `@deepseek-ai/dsh` 0.2.0-rc.2 写的，dsh 还在开发者预览阶段，接口以后可能会变。

## 开发

```sh
npm install
npm test               # 单元测试、假宿主上的端到端测试、和真实 dsh 包的集成测试
node e2e/run.mjs       # 在真实的 dsh headless 里跑一遍，用脚本模拟模型，不需要 API key
```

`e2e/run.mjs` 会把 `@deepseek-ai/dsh` 装到 `.e2e/` 下（已经装过的话设 `DSH_PREFIX` 指过去），然后用 `e2e/fake-llm.js` 这个假模型跑两个会话。第一个会话里 `npm test` 失败、`pnpm` 成功，要求插件学到技能、存下证据和评估题、打完分。第二个会话要求模型看到索引，通过真实的 `skill` 工具加载这条技能，而且这次加载被记上。

## 许可

MIT
