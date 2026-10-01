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
| EVAL | `ctx.llm.stream` | Each case is answered twice without tools: with the skill (A) and without it (B). Every check grades one property: `contains`, `not-contains`, and `regex` run locally, and each `llm-judge` criterion gets its own judge call. Pass rate and lift (A−B) go into the sidecar; the full answers and verdicts go into `.dsh/autoharness/evals/report.md`. A skill below `evalPassThreshold`, or one that scores worse than having no skill at all, is flagged `needsPatch`, and its failures are fed to the next reflection. |
| Grader review | `/autoharness review`, `/autoharness labels` | A self-contained `review.html` for labeling answers with full context; human labels override graders, and graders that disagree with humans stop counting (see below). |
| IDX | `agent/created` + `agent.inject` | A grouped index of learned skills for the top-level agent. dsh-tool-skill still owns the full catalog and loading. |
| MNG | `agent/created` (lazy) | Probation, graduation, capacity eviction by survival score (`usage rate × (0.5 + 0.5 × eval pass rate)`), and archive or revive. Nothing is deleted. |
| Curator | `ctx.llm.stream` | A rare whole-library pass that folds overlapping skills into umbrella skills. |

The plugin only ever touches skills it wrote itself. A skill counts as self-authored only when its `.sidecar.json` names `autoharness` as owner **and** its frontmatter carries `metadata.autoharness`. Hand-written skills, `.agents/skills`, and skills from other plugins are read only to avoid name collisions.

### Evals that test something

An eval case whose task already contains the answer measures nothing: the model without the skill passes too. Three things guard against that:

- the reflector is told to write the task as the user's next request *before* they knew the lesson;
- the promoter drops any `contains`/`regex` check whose pattern already appears in the task text (the run record lists what it dropped);
- checks that pass with and without the skill are recorded as non-discriminating, shown in the report, and fed back to the reflector, which can rewrite a skill's cases with `"replaceEvals": true`.

Eval answers and judges run at the lightest reasoning effort the model offers (`evalEffort: low`; for deepseek-flash that is `off`). A model that spends its whole budget without answering gets an explicit non-answer that fails its checks.

### Checking the graders

A judge model's verdict is an opinion until someone has checked it. `/autoharness review` writes `.dsh/autoharness/evals/review.html`, a single offline page. Each case shows the task, the conversation the skill was learned from, the skill body, and both answers side by side. You mark each answer pass or fail against each criterion. The grader's own verdict stays hidden until you have labeled, so it cannot anchor you. **Download labels** saves a JSON file; `/autoharness labels <file>` imports it.

After an import:

- an answer you labeled is scored by your label, never by the grader;
- a check whose grader agrees with fewer than 75% of your labels stops counting on unlabeled answers;
- the skill is rescored from its last eval run without calling the model, and `status` shows the agreement (`3/4 agree, 1 distrusted`).

Labels are stored in the skill bundle (`evals/labels.jsonl`), next to the cases they judge.

### When reflection runs

- **Interactive hosts** (`dsh tui`, `dsh web`): in the background on a per-project queue, after the turn that crosses `reflectEveryN`. The agent is never blocked.
- **One-shot hosts** (`dsh headless`): inside `agent/turn-stopping`, before the turn closes, once the session has `minEpisodeToolCalls`. The process exits as soon as the agent is idle, so the work, including episode recovery and consolidation, has to finish while the model provider is still alive.
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
| `/autoharness review [skill]` | Build `review.html` to label answers and audit the graders. |
| `/autoharness labels <file>` | Import labels downloaded from the review page and rescore. |
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
  evals/labels.jsonl                # human labels from the review page
.dsh/autoharness/                   # state, git-ignored automatically
  state.json  last_run.json  runs/  episodes/  snapshots/  archive/  evals/ (report.md, review.html)
$DSH_HOME/skills, $DSH_HOME/autoharness   # the global layer (cross-project lessons)
```

You can commit `.dsh/skills/`; `.dsh/autoharness/` writes its own `.gitignore`. Run records and eval logs are capped (200 and 50 per layer), snapshots expire after 30 days, and archived skills are kept.

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
| `evalEffort` | `AUTOHARNESS_EVAL_EFFORT` | low | `low` runs eval answers and judges at the lightest reasoning effort the model offers; `default` keeps the provider default |
| `provider` / `model` | `AUTOHARNESS_PROVIDER` / `AUTOHARNESS_MODEL` | session route | Model used for reflection and evals (for example a cheaper one) |
| `reflectMode` | `AUTOHARNESS_REFLECT_MODE` | auto | `background`, `in-turn`, or `auto` (in-turn only for one-shot hosts) |
| `drainTimeoutMs` | `AUTOHARNESS_DRAIN_TIMEOUT_MS` | 60000 | Grace period for in-flight work at teardown |
| `paused` | `AUTOHARNESS_PAUSED` | false | Global kill switch |

## Costs and limits

- Each reflection is one model request. With `evalOnPromote`, each case of a changed skill costs 2 answers plus one judge call per `llm-judge` check, per answer. Point `provider`/`model` at a cheaper route if that matters.
- Eval replay is a **proxy**: one answer, no tools, no repository access. It measures whether the skill steers the answer, not whether an agent would finish the task. Label a sample in the review page before you trust the scores. Agentic replay (a headless child process in a scratch worktree) is the natural next step.
- Learning quality depends on the reflecting model. The promoter enforces structure and safety, not truth. Every change has a ledger entry and an evidence file, and `archive` and `revive` are one command each.
- Built against `@deepseek-ai/dsh` 0.2.0-rc.2 (developer preview). Upstream APIs may change.

## Tested with DeepSeek

`e2e/real.mjs` runs the loop against a real model (deepseek-flash, the dsh default) on a small billing project whose tests only pass with `APP_ENV=test`. One run, four sessions:

| Session | What happened |
|---|---|
| "Run the test suite" | `npm test` failed, the agent found `docs/testing.md`; autoharness learned `run-billing-demo-tests` (52 s including reflection and evals) |
| "Add a test for `total([])`, then run the suite" | the agent loaded the skill first and ran the right command directly; the reflector answered `none` (already covered) |
| "Commit the new test" with a stated team convention | learned the convention (project) and a sandbox git quirk the agent had to work around (global layer) |
| "What does src/invoice.js do?" | one tool call, nothing to learn |

| Skill | With the skill | Without |
|---|---|---|
| run-billing-demo-tests | 100% | 0% |
| commit-messages-in-chinese-with-module-prefix | 100% | 40% |
| fix-broken-git-config-env | 100% | 25% |

Real-model runs found problems the scripted tests could not: reasoning tokens exhausting the old eval budgets, eval tasks that restated the lesson, and one workaround copied into an unrelated skill. All three are fixed in 0.3.0.

## Development

```sh
npm install
npm test               # unit, fake-harness end-to-end, and integration with real dsh packages
node e2e/run.mjs       # real `dsh headless` run with a scripted model route, no API key
DEEPSEEK_API_KEY=... node e2e/real.mjs   # the same loop against DeepSeek (a few minutes, a few cents)
```

`e2e/run.mjs` installs `@deepseek-ai/dsh` into `.e2e/` (or uses `DSH_PREFIX`). It then runs two headless sessions against a scripted provider (`e2e/fake-llm.js`). Session 1 has to learn a skill, store its evidence and eval case, and score it. Session 2 has to see the index, load the skill through the real `skill` tool, and have that load counted.

## License

MIT
