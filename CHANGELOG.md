# Changelog

## 0.2.0

- Grader validation. `/autoharness review` writes an offline `review.html` for labeling eval answers with the task, evidence, skill, and both answers side by side; grader verdicts stay hidden until you label. `/autoharness labels <file>` imports the download. Labeled answers are scored by the human label; a check whose grader agrees with fewer than 75% of the labels stops counting on unlabeled answers. Rescoring needs no model call. `status` and the report show grader agreement.
- One-shot hosts (`dsh headless`) now run episode recovery and consolidation inside `agent/turn-stopping` too; before, they were queued in the background and died with the process.
- The reflector sees the descriptions of hand-written and plugin skills, not only their names, so it stops re-learning what another skill already covers.
- State retention: run records and eval logs are capped per layer, snapshots and staging leftovers expire. Eval logs a live skill points at are kept.
- Eval results now keep raw verdicts, answer hashes, and the scored view separately.

## 0.1.0

- First version: capture, reflection, promoter, evidence-backed evals, index, lifecycle, curator, `/learn` and `/autoharness`; background reflection for interactive hosts and in-turn reflection for `dsh headless`.
