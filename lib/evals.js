/**
 * EVAL: evidence-backed replay checks for learned skills.
 *
 * Each case recreates the situation a skill was learned from. The model answers
 * it twice without tools, once with the skill loaded (A) and once without (B).
 * Every check grades one property: code checks run locally, and each
 * `llm-judge` criterion gets its own judge call. A skill's pass rate and its
 * lift over the baseline feed lifecycle ranking. Failures are fed back to the
 * next reflection so the skill gets patched (hill-climbing on its own evidence).
 *
 * This is a proxy: a tool-less single answer is not an agentic rerun. The
 * report keeps every answer and verdict so a human can audit the graders.
 *
 * @module dsh-autoharness/evals
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { VARIANTS, answerHash } from './labels.js'
import { complete, completeJson } from './llm.js'
import { ANSWER_SYSTEM, JUDGE_SYSTEM } from './prompts.js'
import { redact } from './redact.js'
import { LEDGER, SIDECAR, appendJsonl, atomicWrite, readJsonl, readOwnedSkill, writeJson } from './store.js'

function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/**
 * Grade one code check locally.
 * @param {{ kind: string, pattern?: string, flags?: string }} check - check definition.
 * @param {string} answer - model answer.
 * @returns {{ pass: boolean, why: string }} verdict.
 */
export function runCodeCheck(check, answer) {
  const text = String(answer ?? '')
  switch (check.kind) {
    case 'contains': {
      const pass = text.toLowerCase().includes(check.pattern.toLowerCase())
      return { pass, why: pass ? `contains "${check.pattern}"` : `missing "${check.pattern}"` }
    }
    case 'not-contains': {
      const pass = !text.toLowerCase().includes(check.pattern.toLowerCase())
      return { pass, why: pass ? `does not contain "${check.pattern}"` : `contains forbidden "${check.pattern}"` }
    }
    case 'regex': {
      const pass = new RegExp(check.pattern, check.flags ?? '').test(text)
      return { pass, why: pass ? `matches /${check.pattern}/` : `does not match /${check.pattern}/` }
    }
    default:
      throw new Error(`not a code check: ${check.kind}`)
  }
}

/**
 * Judge one criterion with the model.
 * @returns {Promise<{ pass: boolean, why: string }>} verdict; a malformed judge reply counts as a failed check with the parse error as reason.
 */
export async function judge(llm, route, { task, answer, criterion, signal }) {
  const user = ['TASK', task, 'ANSWER', answer, 'CRITERION', criterion].join('\n\n')
  try {
    const value = await completeJson(llm, { route, signal, system: JUDGE_SYSTEM, user, maxTokens: 400 })
    if (typeof value.pass !== 'boolean') throw new Error('judge reply has no boolean "pass"')
    return { pass: value.pass, why: clip(value.why ?? '', 300) }
  } catch (error) {
    if (signal?.aborted) throw error
    return { pass: false, why: `judge error: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function grade(llm, route, check, task, answer, signal) {
  if (check.kind === 'llm-judge') return judge(llm, route, { task, answer, criterion: check.criterion, signal })
  return runCodeCheck(check, answer)
}

function describeCheck(check) {
  return check.kind === 'llm-judge' ? check.criterion : `${check.kind} ${check.pattern}`
}

/**
 * Run every case of one skill and collect raw verdicts. Scoring is separate
 * ({@link scoreResult}) so human labels can override graders without
 * re-running the model.
 * @param {object} options - eval inputs.
 * @param {{ stream: Function }} options.llm - the `ctx.llm` service.
 * @param {{ provider: string, model: string }} options.route - model route.
 * @param {{ name: string, body: string }} options.skill - the skill under test.
 * @param {object[]} options.cases - eval cases from the skill's `evals/` directory.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{ skill: string, cases: object[] } | null>} raw verdicts, or null without cases.
 */
export async function evalSkill({ llm, route, skill, cases, signal }) {
  if (cases.length === 0) return null
  const out = []
  for (const item of cases) {
    const withSkill = `SKILL "${skill.name}" (loaded for this task)\n${skill.body}\n\nTASK\n${item.task}`
    const answers = {
      withSkill: redact(await complete(llm, { route, signal, system: ANSWER_SYSTEM, user: withSkill, maxTokens: 1500 })),
      baseline: redact(await complete(llm, { route, signal, system: ANSWER_SYSTEM, user: `TASK\n${item.task}`, maxTokens: 1500 })),
    }
    const checks = []
    for (const check of item.checks ?? []) {
      const verdicts = {}
      for (const variant of VARIANTS) verdicts[variant] = await grade(llm, route, check, item.task, answers[variant], signal)
      checks.push({ id: check.id, kind: check.kind, check: describeCheck(check), verdicts })
    }
    out.push({
      id: item.id,
      task: item.task,
      evidence: item.evidence,
      answers,
      hashes: { withSkill: answerHash(answers.withSkill), baseline: answerHash(answers.baseline) },
      checks,
    })
  }
  return { skill: skill.name, cases: out }
}

/**
 * Fold a scored result into a sidecar. A skill needs a patch when it fails
 * the threshold or does worse than no skill at all. A result with nothing
 * countable (every grader distrusted, no labels) changes no verdict.
 */
export function applyEvalResult(sidecar, result, { evalPassThreshold }, now = Date.now()) {
  const counted = result.passRate !== null && result.passRate !== undefined
  const needsPatch = counted ? result.passRate < evalPassThreshold || (result.lift ?? 0) < 0 : sidecar.needsPatch === true
  return {
    ...sidecar,
    eval: {
      passRate: result.passRate,
      baseline: result.baseline,
      lift: result.lift,
      checks: result.checks,
      runs: (sidecar.eval?.runs ?? 0) + (result.rescored ? 0 : 1),
      at: new Date(now).toISOString(),
      ...(result.runId ? { run: result.runId } : {}),
      ...(result.graders ? { graders: result.graders } : {}),
    },
    needsPatch,
    evalFailures: needsPatch ? (result.failures ?? []).slice(0, 5) : [],
  }
}

const pct = (value) => (typeof value === 'number' ? `${(value * 100).toFixed(0)}%` : 'n/a')

/**
 * Persist one scored result: sidecar (re-read from disk so concurrent usage
 * counts survive), ledger line, and the layer's results log. Call under the
 * layer lock.
 * @returns {Promise<object | null>} the new sidecar, or null when the skill vanished.
 */
export async function recordEval({ skillDir, dirs, result, runId, config, now = Date.now() }) {
  const current = readOwnedSkill(skillDir)
  if (!current) return null
  const sidecar = applyEvalResult(current.sidecar, { ...result, runId: result.runId ?? runId }, config, now)
  await writeJson(join(skillDir, SIDECAR), sidecar)
  const graders = result.graders?.labeled ? `; graders agree with ${result.graders.agreed}/${result.graders.labeled} human labels` : ''
  await appendJsonl(join(skillDir, LEDGER), {
    at: new Date(now).toISOString(),
    run: runId,
    op: result.rescored ? 'rescore' : 'eval',
    reason: `pass ${pct(result.passRate)} vs baseline ${pct(result.baseline)} over ${result.checks} checks${graders}`,
  })
  if (!result.rescored) await appendJsonl(join(dirs.evalResults, `${runId}.jsonl`), { at: new Date(now).toISOString(), ...result })
  return sidecar
}

/** Find the latest raw result of a skill in a layer's results log. */
export async function latestResult(dirs, skill, runId) {
  const all = (await readdir(dirs.evalResults).catch(() => [])).filter((name) => name.endsWith('.jsonl')).sort().reverse()
  // Prefer the run the sidecar points at; fall back to the newest log that has the skill.
  const names = runId && all.includes(`${runId}.jsonl`) ? [`${runId}.jsonl`, ...all.filter((name) => name !== `${runId}.jsonl`)] : all
  for (const name of names) {
    const lines = await readJsonl(join(dirs.evalResults, name))
    // Logs written before 0.2.0 lack raw answers and hashes; they cannot be rescored.
    const hit = lines.filter((line) => line.skill === skill && Array.isArray(line.cases) && line.cases.every((c) => c.answers && c.hashes)).at(-1)
    if (hit) return { ...hit, runId: name.slice(0, -'.jsonl'.length) }
  }
  return null
}

/**
 * Render a human-review report: every answer and every verdict with where it
 * came from (grader, human label, or excluded because its grader is
 * distrusted), so graders can be audited before their scores are trusted.
 * @param {string} runId - eval run id.
 * @param {object[]} results - scored results.
 * @returns {string} Markdown.
 */
export function renderReport(runId, results) {
  const lines = [`# autoharness eval report \`${runId}\``, '']
  lines.push('| skill | checks | with skill | baseline | lift | graders vs humans |', '|---|---|---|---|---|---|')
  for (const r of results) {
    const g = r.graders?.labeled ? `${r.graders.agreed}/${r.graders.labeled} agree${r.graders.untrusted.length ? `, ${r.graders.untrusted.length} distrusted` : ''}` : 'no labels yet'
    const lift = typeof r.lift === 'number' ? `${(r.lift * 100).toFixed(0)} pts` : 'n/a'
    lines.push(`| ${r.skill} | ${r.checks} | ${pct(r.passRate)} | ${pct(r.baseline)} | ${lift} | ${g} |`)
  }
  lines.push('', 'Label answers in `review.html` (run `/autoharness review`), then import the download with `/autoharness labels <file>`.')
  const cell = (verdict, scored) => {
    const shown = scored.source === 'human' ? `HUMAN ${scored.pass ? 'PASS' : 'FAIL'}` : scored.source === 'excluded' ? 'EXCLUDED' : verdict.pass ? 'PASS' : 'FAIL'
    return `${shown}: ${verdict.why.replace(/\|/g, '\\|').replace(/\n/g, ' ')}`
  }
  for (const r of results) {
    lines.push('', `## ${r.skill}`)
    for (const c of r.cases) {
      lines.push('', `### case \`${c.id}\``, '', `**Task:** ${c.task}`)
      if (c.evidence) lines.push('', `Evidence: \`${c.evidence}\` (inside the skill directory)`)
      lines.push('', '| check | with skill | baseline |', '|---|---|---|')
      for (const k of c.checks) lines.push(`| ${k.check.replace(/\|/g, '\\|')} | ${cell(k.verdicts.withSkill, k.scored.withSkill)} | ${cell(k.verdicts.baseline, k.scored.baseline)} |`)
      lines.push('', '<details><summary>Answer with skill</summary>', '', '```text', c.answers.withSkill.replace(/```/g, "'''"), '```', '</details>')
      lines.push('', '<details><summary>Baseline answer</summary>', '', '```text', c.answers.baseline.replace(/```/g, "'''"), '```', '</details>')
    }
  }
  return `${lines.join('\n')}\n`
}

/** Write the report into the layer's eval directory as `report.md` and `<runId>.md`. */
export async function writeReport(dirs, runId, results) {
  const text = renderReport(runId, results)
  const base = join(dirs.evalResults, '..')
  await atomicWrite(join(base, `report-${runId}.md`), text)
  await atomicWrite(join(base, 'report.md'), text)
  return join(base, 'report.md')
}
