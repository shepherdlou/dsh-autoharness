# dsh-autoharness

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的**自学习技能层**，每条技能都有证据支撑的评估。

插件观察真实的工作会话，把可复用的经验沉淀成技能。比如用户的纠正、一次先失败后修好的排错、一条"显而易见的命令不行、换一条才行"的项目命令。每条新技能都要先通过 lint 和晋升关卡，最后落成一个普通的 `SKILL.md`，由 dsh 自带的技能加载器提供给模型。每条技能还带着从学到它的那段证据里提炼出的窄评估用例。插件会回放这些用例，确认技能确实改变了模型的回答；结果既参与技能的存活排名，也会作为反馈进入下一轮反思。

本项目是 [tigerless-labs/autoharness](https://github.com/tigerless-labs/autoharness)（Claude Code 插件）在 dsh 上的原生移植，并加入了 Hamel Husain 在 [Claude auto-evals 评述](https://hamel.dev/blog/posts/claude-auto-evals/) 里强调的评估纪律：先看数据；每个 evaluator 只判一个二元标准；代码检查和 LLM judge 分开；每条判语都可以人工复核。

## 工作原理

```
session/event ─► CAP 捕获 ── 工具调用 ≥ reflectEveryN ──► REF 反思 ──intents──► Promoter lint + 原子写入 ──► .dsh/skills/<name>/
                  (脱敏 episode 日志)                       ▲ eval 失败反馈                  │ ledger · evidence · eval cases
                                                           └──── EVAL A/B 回放 + 单判据 judge ◄┘（晋升后立即跑，或 /autoharness eval）
agent/created ─► IDX 注入已学技能索引   ·   MNG 生命周期：试用期 → 成熟 → 容量淘汰 → 归档
项目工具调用 ≥ consolidateEveryN ─► Curator 把近似重复的技能合并成 umbrella 技能
```

| 组件 | dsh 扩展点 | 作用 |
|---|---|---|
| CAP | `session/event` | 把会话日志转成紧凑、已脱敏的 episode 条目；统计工具调用、请求数、技能加载（`skill` 工具或 `/name`）和技能查看（`read` 技能文件）。episode 持久化到 `.dsh/autoharness/episodes/`，用于崩溃恢复。子 agent 的会话不参与学习。 |
| REF | `ctx.llm.stream`（一次性请求） | 输入 episode、现有 autoharness 技能库、其他技能名和 eval 失败记录，输出严格 JSON 的 intent：`create`、`patch`、`merge`、`archive` 或 `none`。只提案，不写盘。 |
| Promoter | — | 唯一的写入者。先 lint：名称语法与重名、长度、框架标签、提示注入、密钥、危险命令、证据范围、eval 结构。通过后在 staging 里组装，快照被替换的内容，再用 rename 原子换入。拒收的 intent 记在 `runs/<id>.json`，绝不部分写入。 |
| EVAL | `ctx.llm.stream` | 每个用例在无工具条件下回答两次：带技能（A）和不带技能（B）。每个 check 只判一个属性：`contains`、`not-contains`、`regex` 在本地执行，每个 `llm-judge` 判据单独调用一次 judge。通过率和提升（A−B）写进 sidecar；完整的回答和判语写进 `.dsh/autoharness/evals/report.md` 供人工复核。通过率低于 `evalPassThreshold`、或者比不带技能还差的技能会被标为 `needsPatch`，失败原因交给下一轮反思（爬坡）。 |
| IDX | `agent/created` + `agent.inject` | 给顶层 agent 注入按类别分组的已学技能索引。完整目录和加载仍由 dsh-tool-skill 负责。 |
| MNG | `agent/created`（惰性执行） | 试用期、毕业、按存活分（`使用率 × (0.5 + 0.5 × eval 通过率)`）做容量淘汰，以及归档和恢复。从不删除。 |
| Curator | `ctx.llm.stream` | 偶尔对整个技能库做一次整理，把重叠的技能合并成 umbrella 技能。 |

**只改自己写的技能**：`.sidecar.json` 的 owner 是 `autoharness`，**并且** frontmatter 里带 `metadata.autoharness`，两个条件同时满足才算自有技能。手写的技能、`.agents/skills` 和其他插件的技能只用来检查重名，不会被修改。

### 反思何时运行

- **交互式宿主**（`dsh tui`、`dsh web`）：越过 `reflectEveryN` 的那一轮结束后，在每个项目自己的后台队列里运行，不阻塞 agent。
- **一次性宿主**（`dsh headless`）：会话的工具调用达到 `minEpisodeToolCalls` 后，在 `agent/turn-stopping` 里、本轮关闭之前运行。headless 在 agent 空闲后马上退出，所以必须趁模型 provider 还在的时候做完。
- 会话结束时，会尽力对剩余的尾段再反思一次。崩溃进程留下的 episode，由同一项目的下一个会话补做。

可以用 `reflectMode`（`auto` | `background` | `in-turn`）强制指定模式。

## 安装

```sh
dsh plugin --profile tui add dsh-autoharness          # 发布到 npm 后
dsh plugin --profile tui add /path/to/dsh-autoharness # 从本地仓库安装
```

`dsh plugin add` 会把包里的 `cordis.patch.yml` 作为一层 profile 叠加上去。不想安装的话，可以用 overlay 临时试用：

```sh
dsh tui --patch /path/to/dsh-autoharness/examples/dev-patch.yml
```

通过 `--patch` 加载的插件会从它自己的目录解析裸 import，所以要先把宿主的包软链过来（见 `examples/dev-patch.yml` 里的说明）。

## 命令

| 命令 | |
|---|---|
| `/learn` | 立即反思当前会话，报告落地、拒收的结果和 eval 分数 |
| `/autoharness status` | 查看技能库、计数器和最近一次运行 |
| `/autoharness eval [skill]` | 回放 eval 用例，生成 `.dsh/autoharness/evals/report.md` |
| `/autoharness curate` | 立即运行一次整理 |
| `/autoharness archive <skill>` / `revive <skill>` | 归档，或恢复最近一次归档的版本（重新进入试用期） |
| `/autoharness pause` / `resume` | 暂停或恢复本项目的学习与生命周期变更；索引召回和用量统计照常进行 |

## 文件

```
.dsh/skills/<name>/                 # 由 dsh-skill-filesystem 发现（项目层）
  SKILL.md                          # name, description, whenToUse, metadata.autoharness, 正文
  .sidecar.json                     # owner、层、状态、uses/views/patches、eval 分数
  .ledger.jsonl                     # 只追加：create / patch / merge / eval / graduate / archive
  references/evidence-<id>.md       # 支撑这次变更的脱敏对话切片
  evals/case-<id>.json              # 任务 + 单判据 checks
.dsh/autoharness/                   # 运行状态，自动写 .gitignore
  state.json  last_run.json  runs/  episodes/  snapshots/  archive/  evals/
$DSH_HOME/skills, $DSH_HOME/autoharness   # 全局层（跨项目的经验）
```

`.dsh/skills/` 可以提交进仓库；`.dsh/autoharness/` 会自己写好 `.gitignore`。

## 配置

可以在 profile patch 里 `autoharness` 条目的 `config:` 下配置，也可以用 `AUTOHARNESS_*` 环境变量（环境变量优先）。完整列表见 [README.md](README.md#configuration)，常用的几项：

- `reflectEveryN`（默认 50）：反思之间相隔的顶层工具调用数
- `consolidateEveryN`（250）：整理之间相隔的项目工具调用数，设为 0 关闭
- `minEpisodeToolCalls`（8）：自动反思的最少工具调用数
- `skillBodyMaxLines`（25）、`skillDescMaxChars`（1024）：技能大小上限
- `maturityProject/Global`（100/300）：试用期长度（按请求数计）
- `capacityProject/Global`（50/20）：每层保留的成熟技能数
- `evalOnPromote`（true）：技能落地后立即回放 eval
- `requireEval`（true）：拒收不带 eval 用例的技能
- `evalPassThreshold`（0.5）：低于此通过率的技能需要修补
- `provider` / `model`：反思和评估使用的模型路由，默认沿用会话当前的路由，可以换成更便宜的模型
- `reflectMode`（auto）：`background`、`in-turn` 或 `auto`（只对一次性宿主用 in-turn）
- `drainTimeoutMs`（60000）：卸载时等待进行中任务的宽限时间
- `paused`：总开关

## 成本与局限

- 每次反思是一次模型请求。开启 `evalOnPromote` 时，被改动技能的每个用例需要 2 次回答，再加上每个回答、每个 `llm-judge` check 各一次 judge 调用。在意成本的话可以把 `provider`/`model` 指向更便宜的路由。
- Eval 回放只是**代理指标**：一次回答、不调工具、不访问仓库。它衡量的是技能能不能把回答引向正确方向，而不是 agent 能不能真的完成任务。报告保留了全部回答和判语，先人工确认 grader 的判断和你一致，再去信任分数。真正的 agent 回放（在临时 worktree 里跑 headless 子进程）和网页标注界面是后续方向。
- 学到的内容质量取决于做反思的模型。Promoter 保证结构和安全，但保证不了内容正确。每次变更都有 ledger 记录和证据文件，`archive` 和 `revive` 都只需一条命令。
- 基于 `@deepseek-ai/dsh` 0.2.0-rc.2（开发者预览版）构建，上游 API 可能会变。

## 开发

```sh
npm install
npm test               # 单元测试、假宿主端到端测试、以及与真实 dsh 包的集成测试
node e2e/run.mjs       # 用脚本化的模型路由跑真实的 `dsh headless`，不需要 API key
```

`e2e/run.mjs` 会把 `@deepseek-ai/dsh` 装到 `.e2e/`（也可以通过 `DSH_PREFIX` 复用已有安装），然后用脚本化的 provider（`e2e/fake-llm.js`）跑两个 headless 会话。第一个会话必须学到技能、存下证据和 eval 用例，并完成评分。第二个会话必须看到索引、通过真实的 `skill` 工具加载这条技能，并且这次加载被计数。

## 许可

MIT
