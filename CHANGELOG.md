# Changelog

## 0.3.0

Tested end to end against DeepSeek (deepseek-flash) in `dsh headless`; these fixes came from those runs.

- Token budgets fit reasoning models: reflection and curation get 32k, eval answers 8k, judges 4k. Eval answers and judges run at the lightest reasoning effort the model offers (`evalEffort`, read from `ctx.llm.resolveModelInfo`; `off` on deepseek-flash). An answer cut off by the budget is graded as written; a budget spent entirely on reasoning becomes an explicit non-answer.
- A failed eval no longer fails the reflection: skills that landed stay landed, the watermark advances, and each skill's eval is isolated.
- Eval cases that give the answer away: the reflector prompt forbids putting the lesson in the task; the promoter drops `contains`/`regex` checks the task already satisfies; checks that pass without the skill are recorded (`nonDiscriminating`), reported, and fed back; `patch` accepts `replaceEvals` to rewrite a skill's cases. An evals-only patch needs no episode evidence.
- One lesson per skill: the reflector references another skill instead of copying its workaround.
- A malformed reflector or curator reply gets one retry with a reminder. A failed reflection is recorded in `last_run.json` and shown by `status`.
- `e2e/real.mjs`: the full loop against a real DeepSeek model.

## 0.2.0

- Grader validation. `/autoharness review` writes an offline `review.html` for labeling eval answers with the task, evidence, skill, and both answers side by side; grader verdicts stay hidden until you label. `/autoharness labels <file>` imports the download. Labeled answers are scored by the human label; a check whose grader agrees with fewer than 75% of the labels stops counting on unlabeled answers. Rescoring needs no model call. `status` and the report show grader agreement.
- One-shot hosts (`dsh headless`) now run episode recovery and consolidation inside `agent/turn-stopping` too; before, they were queued in the background and died with the process.
- The reflector sees the descriptions of hand-written and plugin skills, not only their names, so it stops re-learning what another skill already covers.
- State retention: run records and eval logs are capped per layer, snapshots and staging leftovers expire. Eval logs a live skill points at are kept.
- Eval results now keep raw verdicts, answer hashes, and the scored view separately.

## 0.1.0

- First version: capture, reflection, promoter, evidence-backed evals, index, lifecycle, curator, `/learn` and `/autoharness`; background reflection for interactive hosts and in-turn reflection for `dsh headless`.
