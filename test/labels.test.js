import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyEvalResult } from '../lib/evals.js'
import { TRUST_THRESHOLD, answerHash, graderAgreement, parseLabelExport, scoreResult } from '../lib/labels.js'
import { RETENTION, pruneState } from '../lib/lifecycle.js'
import { promote } from '../lib/promoter.js'
import { renderReviewPage } from '../lib/review.js'
import { SIDECAR, readJsonSync, writeJson } from '../lib/store.js'
import { tempProject, testConfig, testLayout } from './helpers.js'

function raw() {
  const answers = { withSkill: 'Run pnpm --filter api test', baseline: 'Run npm test' }
  return {
    skill: 's',
    cases: [{
      id: 'k1',
      task: 'how to test',
      answers,
      hashes: { withSkill: answerHash(answers.withSkill), baseline: answerHash(answers.baseline) },
      checks: [
        { id: 'c1', kind: 'contains', check: 'contains pnpm', verdicts: { withSkill: { pass: true, why: 'has pnpm' }, baseline: { pass: false, why: 'no pnpm' } } },
        { id: 'c2', kind: 'llm-judge', check: 'Avoids npm', verdicts: { withSkill: { pass: false, why: 'judge thinks npm' }, baseline: { pass: true, why: 'judge is wrong' } } },
      ],
    }],
  }
}

const label = (r, check, variant, human) => ({ case: 'k1', check, variant, answer: r.cases[0].hashes[variant], human, judge: r.cases[0].checks.find((c) => c.id === check).verdicts[variant].pass })

test('labels: without labels every grader counts', () => {
  const scored = scoreResult(raw())
  assert.equal(scored.checks, 2)
  assert.equal(scored.passRate, 0.5)
  assert.equal(scored.baseline, 0.5)
  assert.deepEqual(scored.graders, { labeled: 0, agreed: 0, untrusted: [], excluded: 0 })
})

test('labels: a human label overrides its answer, a disagreeing grader stops counting elsewhere', () => {
  const r = raw()
  const scored = scoreResult(r, [label(r, 'c2', 'withSkill', true)])
  assert.equal(scored.cases[0].checks[1].scored.withSkill.source, 'human')
  assert.equal(scored.cases[0].checks[1].scored.baseline.source, 'excluded', 'the distrusted judge no longer grades unlabeled answers')
  assert.deepEqual(scored.graders.untrusted, ['k1/c2'])
  assert.equal(scored.passRate, 1, 'c1 pass + human pass')
  assert.equal(scored.baseline, 0, 'only c1 counts for the baseline')
  assert.equal(scored.lift, 1)
  assert.equal(scored.failures.length, 0)
})

test('labels: agreement is computed on the latest label per answer; trusted graders keep counting', () => {
  const r = raw()
  const labels = [label(r, 'c1', 'withSkill', false), label(r, 'c1', 'withSkill', true), label(r, 'c1', 'baseline', false)]
  const agreement = graderAgreement(labels)
  assert.deepEqual(agreement.get('k1\u0000c1'), { labeled: 2, agreed: 2, trusted: true })
  assert.ok(TRUST_THRESHOLD > 0.5 && TRUST_THRESHOLD <= 1)
  const scored = scoreResult(r, labels)
  assert.equal(scored.cases[0].checks[1].scored.withSkill.source, 'grader')
  assert.equal(scored.graders.labeled, 2)
})

test('labels: a result with nothing countable leaves the verdict alone', () => {
  const r = raw()
  r.cases[0].checks = [r.cases[0].checks[1]]
  r.cases[0].hashes.withSkill = 'other-answer'
  const labels = [{ ...label(raw(), 'c2', 'withSkill', true) }]
  const scored = scoreResult(r, labels)
  assert.equal(scored.passRate, null)
  assert.equal(scored.lift, null)
  const sidecar = applyEvalResult({ needsPatch: true, eval: { runs: 3 } }, { ...scored, rescored: true }, { evalPassThreshold: 0.5 })
  assert.equal(sidecar.needsPatch, true)
  assert.equal(sidecar.eval.runs, 3, 'a rescore is not a new run')
})

test('labels: exports are validated', () => {
  assert.throws(() => parseLabelExport({ labels: [] }), /autoharness-labels/)
  const ok = { skill: 's', case: 'k', check: 'c', variant: 'baseline', answer: 'h', human: false }
  assert.deepEqual(parseLabelExport({ format: 'autoharness-labels', labels: [ok, { ...ok, variant: 'x' }, { ...ok, human: 'yes' }] }), [ok])
})

test('review page: data is embedded inert, hostile model output cannot break out', () => {
  const r = scoreResult(raw())
  r.cases[0].answers.withSkill = '</script><script>alert(1)</script>'
  const html = renderReviewPage({ project: '/p', generatedAt: 'now', skills: [{ skill: 's', layer: 'project', run: 'r1', description: 'd', body: 'b', cases: r.cases, labels: [], graders: r.graders }] })
  assert.ok(!html.includes('<script>alert(1)'), 'raw tag never reaches the HTML')
  const json = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html)[1]
  const data = JSON.parse(json)
  assert.equal(data.skills[0].cases[0].answers.withSkill, '</script><script>alert(1)</script>')
  assert.equal(data.format, 'autoharness-review')
  assert.match(html, /textContent/)
  assert.ok(!/innerHTML/.test(html), 'the page never parses data as HTML')
})

test('pruneState: bounded runs and logs, referenced logs and fresh snapshots kept', async (t) => {
  const { project, env } = tempProject(t)
  const config = testConfig()
  const layout = testLayout(project, env, config)
  await promote({ intents: [{ op: 'create', name: 'kept-skill', description: 'A skill whose eval log must survive pruning.', body: 'b', reason: 'r', evals: [{ task: 'a task long enough', checks: [{ kind: 'contains', pattern: 'b' }] }] }], layout, config, episode: null, run: { trigger: 't' } })
  const dirs = layout.layers.project
  mkdirSync(dirs.evalResults, { recursive: true })
  for (let i = 0; i < RETENTION.runs + 5; i++) writeFileSync(join(dirs.runs, `a${String(i).padStart(4, '0')}.json`), '{}')
  for (let i = 0; i < RETENTION.evalLogs + 3; i++) writeFileSync(join(dirs.evalResults, `a${String(i).padStart(4, '0')}.jsonl`), '')
  const sidecarFile = join(dirs.skills, 'kept-skill', SIDECAR)
  await writeJson(sidecarFile, { ...readJsonSync(sidecarFile), eval: { run: 'a0000' } })
  mkdirSync(join(dirs.snapshots, 'old-run'), { recursive: true })
  mkdirSync(join(dirs.snapshots, 'new-run'), { recursive: true })
  const old = new Date(Date.now() - 40 * 86_400_000)
  utimesSync(join(dirs.snapshots, 'old-run'), old, old)
  await pruneState({ layout })
  assert.equal(readdirSync(dirs.runs).length, RETENTION.runs)
  const logs = readdirSync(dirs.evalResults)
  assert.ok(logs.includes('a0000.jsonl'), 'a live skill still points at it')
  assert.equal(logs.length, RETENTION.evalLogs + 1)
  assert.deepEqual(readdirSync(dirs.snapshots), ['new-run'])
})
