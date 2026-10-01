# dsh-autoharness

English | [中文](README.zh.md)

A self-learning skill layer with evidence-backed evals for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

It watches real work sessions and distills reusable lessons into skills. Examples: a user correction, a failure that got fixed, or a project command that only worked after the obvious one failed. Every new skill goes through a lint-and-promote gate and lands as an ordinary `SKILL.md` that dsh's own skill loader serves. Each skill also carries narrow eval cases built from the evidence it was learned from. Those evals are replayed to check that the skill actually changes the model's answer, and they feed both the skill's survival ranking and the next round of reflection.

This is a native dsh port of [tigerless-labs/autoharness](https://github.com/tigerless-labs/autoharness) (a Claude Code plugin), extended with the eval discipline from Hamel Husain's [notes on Claude auto-evals](https://hamel.dev/blog/posts/claude-auto-evals/): look at the data first, keep each evaluator to one binary criterion, keep code checks separate from LLM judges, and make every grader verdict auditable.

## How it works

```
session/event ─► CAP  capture ── tool calls ≥ reflectEveryN ──► REF  reflect ──intents──► PROMOTER lint + atomic write ──► .dsh/skills/<name>/
                     (redacted episode log)                         ▲  eval feedback                │ ledger · evidence · eval cases
                                                                    └──── EVAL  A/B replay + judges ◄┘ (right after promotion, or /autoharness eval)
agent/created ─► IDX  index of learned skills (injected)   ·   MNG  lifecycle: probation → mature → capacity eviction → archive
project tool calls ≥ consolidateEveryN ─► CURATOR  merges near-duplicates into umbrella skills
```

| Part | dsh extension point | What it does |
|---|---|---|
| CAP | `session/event` | Turns the session log into compact, redacted episode entries and counts tool calls, requests, skill loads (`skill` tool or `/name`), and skill views (`read` of a skill file). Persists episodes under `.dsh/autoharness/episodes/` for crash recovery. Subagent sessions are not learned from. |
| REF | `ctx.llm.stream` (one-shot) | Gets the episode, the current autoharness library, the names of other skills, and eval failures. Returns strict-JSON intents: `create`, `patch`, `merge`, `archive`, or `none`. It only proposes; it never writes. |
| Promoter | — | The only writer. It lints each intent: name grammar and collisions, sizes, framing tags, prompt injection, secrets, dangerous commands, evidence range, and eval shape. It then builds the bundle in staging, snapshots whatever it replaces, and swaps the result in with renames. Rejections are recorded in `runs/<id>.json`, never partially applied. |
| EVAL | `ctx.llm.stream` | Each case is answered twice without tools: with the skill (A) and without it (B). Every check grades one property: `contains`, `not-contains`, and `regex` run locally, and each `llm-judge` criterion gets its own judge call. Pass rate and lift (A−B) go into the sidecar; the full answers and verdicts go into `.dsh/autoharness/evals/report.md` for human review. A skill below `evalPassThreshold`, or one that scores worse than having no skill at all, is flagged `needsPatch`, and its failures are fed to the next reflection. |
| IDX | `agent/created` + `agent.inject` | A grouped index of learned skills for the top-level agent. dsh-tool-skill still owns the full catalog and loading. |
| MNG | `agent/created` (lazy) | Probation, graduation, capacity eviction by survival score (`usage rate × (0.5 + 0.5 × eval pass rate)`), and archive or revive. Nothing is deleted. |
| Curator | `ctx.llm.stream` | A rare whole-library pass that folds overlapping skills into umbrella skills. |

The plugin only ever touches skills it wrote itself. A skill counts as self-authored only when its `.sidecar.json` names `autoharness` as owner **and** its frontmatter carries `metadata.autoharness`. Hand-written skills, `.agents/skills`, and skills from other plugins are read only to avoid name collisions.

### When reflection runs

- **Interactive hosts** (`dsh tui`, `dsh web`): in the background on a per-project queue, after the turn that crosses `reflectEveryN`. The agent is never blocked.
- **One-shot hosts** (`dsh headless`): inside `agent/turn-stopping`, before the turn closes, once the session has `minEpisodeToolCalls`. The process exits as soon as the agent is idle, so the work has to finish while the model provider is still alive.
- On session end, the remaining tail is reflected (best effort). Episodes left behind by a crashed process are recovered by the next session in the same project.

`reflectMode` (`auto` | `background` | `in-turn`) overrides this choice.

## Install

```sh
dsh plugin --profile tui add dsh-autoharness          # from npm, once published
dsh plugin --profile tui add /path/to/dsh-autoharness # from a checkout
```

`dsh plugin add` appends the package's `cordis.patch.yml` as a profile layer. To try it without installing, use an overlay:

```sh
dsh tui --patch /path/to/dsh-autoharness/examples/dev-patch.yml
```

A plugin loaded through `--patch` resolves bare imports from its own directory. Link the host's packages next to it first (`examples/dev-patch.yml` explains how).

## Commands

| Command | |
|---|---|
| `/learn` | Reflect on the current session right now and report what landed, what was rejected, and the eval scores. |
| `/autoharness status` | Library, counters, last run. |
| `/autoharness eval [skill]` | Replay eval cases and write `.dsh/autoharness/evals/report.md`. |
| `/autoharness curate` | Run the curator now. |
| `/autoharness archive <skill>` / `revive <skill>` | Archive, or restore the latest archived copy (probation restarts). |
| `/autoharness pause` / `resume` | Stop or restart learning and lifecycle changes in this project. Recall and usage counting continue. |

## Files

```
.dsh/skills/<name>/                 # discovered by dsh-skill-filesystem (project layer)
  SKILL.md                          # name, description, whenToUse, metadata.autoharness, body
  .sidecar.json                     # owner, layer, status, uses/views/patches, eval scores
  .ledger.jsonl                     # append-only: create / patch / merge / eval / graduate / archive
  references/evidence-<id>.md       # redacted transcript slice that justified the change
  evals/case-<id>.json              # task + single-criterion checks
.dsh/autoharness/                   # state, git-ignored automatically
  state.json  last_run.json  runs/  episodes/  snapshots/  archive/  evals/
$DSH_HOME/skills, $DSH_HOME/autoharness   # the global layer (cross-project lessons)
```

You can commit `.dsh/skills/`; `.dsh/autoharness/` writes its own `.gitignore`.

## Configuration

Set values in the profile patch (`config:` of the `autoharness` entry) or with `AUTOHARNESS_*` environment variables. Environment variables win.

| Key | Env | Default | |
|---|---|---|---|
| `reflectEveryN` | `AUTOHARNESS_REFLECT_EVERY_N` | 50 | Top-level tool calls between reflections |
| `consolidateEveryN` | `AUTOHARNESS_CONSOLIDATE_EVERY_N` | 250 | Project tool calls between curator passes (0 disables) |
| `digestExchanges` | `AUTOHARNESS_DIGEST_EXCHANGES` | 20 | User exchanges kept in an episode |
| `minEpisodeToolCalls` | `AUTOHARNESS_MIN_EPISODE_TOOL_CALLS` | 8 | Minimum tool calls for an automatic reflection |
| `maxIntentsPerRun` | `AUTOHARNESS_MAX_INTENTS_PER_RUN` | 3 | Changes one run may make |
| `indexEnabled` | `AUTOHARNESS_INDEX_SUSPENDED` (inverted) | true | Inject the learned-skill index |
| `indexDescMaxChars` / `indexMaxLines` | `AUTOHARNESS_INDEX_DESC_MAX_CHARS` / `_INDEX_MAX_LINES` | 60 / 40 | Index size |
| `skillDescMaxChars` / `skillBodyMaxLines` | `AUTOHARNESS_SKILL_DESC_MAX_CHARS` / `_SKILL_BODY_MAX_LINES` | 1024 / 25 | Skill size limits |
| `maturityProject` / `maturityGlobal` | `AUTOHARNESS_MATURITY_PROJECT` / `_GLOBAL` | 100 / 300 | Probation length in requests |
| `capacityProject` / `capacityGlobal` | `AUTOHARNESS_CAPACITY_PROJECT` / `_GLOBAL` | 50 / 20 | Mature skills kept per layer |
| `graduationSuspended` | `AUTOHARNESS_GRADUATION_SUSPENDED` | false | Freeze all archival |
| `globalLayer` | `AUTOHARNESS_GLOBAL_LAYER` | true | Allow cross-project skills in `$DSH_HOME/skills` |
| `evalOnPromote` | `AUTOHARNESS_EVAL_ON_PROMOTE` | true | Replay evals right after a skill lands |
| `requireEval` | `AUTOHARNESS_REQUIRE_EVAL` | true | Reject skills without an eval case |
| `evalPassThreshold` | `AUTOHARNESS_EVAL_PASS_THRESHOLD` | 0.5 | Below this, the skill needs a patch |
| `provider` / `model` | `AUTOHARNESS_PROVIDER` / `AUTOHARNESS_MODEL` | session route | Model used for reflection and evals (for example a cheaper one) |
| `reflectMode` | `AUTOHARNESS_REFLECT_MODE` | auto | `background`, `in-turn`, or `auto` (in-turn only for one-shot hosts) |
| `drainTimeoutMs` | `AUTOHARNESS_DRAIN_TIMEOUT_MS` | 60000 | Grace period for in-flight work at teardown |
| `paused` | `AUTOHARNESS_PAUSED` | false | Global kill switch |

## Costs and limits

- Each reflection is one model request. With `evalOnPromote`, each case of a changed skill costs 2 answers plus one judge call per `llm-judge` check, per answer. Point `provider`/`model` at a cheaper route if that matters.
- Eval replay is a **proxy**: one answer, no tools, no repository access. It measures whether the skill steers the answer, not whether an agent would finish the task. The report keeps every answer and verdict so you can check that the graders agree with you before trusting the scores. Agentic replay (headless child process in a scratch worktree) and a labeling UI are natural next steps.
- Learning quality depends on the reflecting model. The promoter enforces structure and safety, not truth. Every change has a ledger entry and an evidence file, and `archive` and `revive` are one command each.
- Built against `@deepseek-ai/dsh` 0.2.0-rc.2 (developer preview). Upstream APIs may change.

## Development

```sh
npm install
npm test               # unit, fake-harness end-to-end, and integration with real dsh packages
node e2e/run.mjs       # real `dsh headless` run with a scripted model route, no API key
```

`e2e/run.mjs` installs `@deepseek-ai/dsh` into `.e2e/` (or uses `DSH_PREFIX`). It then runs two headless sessions against a scripted provider (`e2e/fake-llm.js`). Session 1 has to learn a skill, store its evidence and eval case, and score it. Session 2 has to see the index, load the skill through the real `skill` tool, and have that load counted.

## License

MIT
