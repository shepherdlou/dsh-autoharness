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
import { join } from 'node:path'
import { complete, completeJson } from './llm.js'
import { ANSWER_SYSTEM, JUDGE_SYSTEM } from './prompts.js'
import { redact } from './redact.js'
import { LEDGER, SIDECAR, appendJsonl, atomicWrite, readOwnedSkill, writeJson } from './store.js'

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
 * Run every case of one skill.
 * @param {object} options - eval inputs.
 * @param {{ stream: Function }} options.llm - the `ctx.llm` service.
 * @param {{ provider: string, model: string }} options.route - model route.
 * @param {{ name: string, body: string }} options.skill - the skill under test.
 * @param {object[]} options.cases - eval cases from the skill's `evals/` directory.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{ skill: string, cases: object[], checks: number, passRate: number, baseline: number, lift: number, failures: object[] } | null>} result, or null without cases.
 */
export async function evalSkill({ llm, route, skill, cases, signal }) {
  if (cases.length === 0) return null
  const out = []
  let total = 0
  let passA = 0
  let passB = 0
  const failures = []
  for (const item of cases) {
    const withSkill = `SKILL "${skill.name}" (loaded for this task)\n${skill.body}\n\nTASK\n${item.task}`
    const answerA = redact(await complete(llm, { route, signal, system: ANSWER_SYSTEM, user: withSkill, maxTokens: 1500 }))
    const answerB = redact(await complete(llm, { route, signal, system: ANSWER_SYSTEM, user: `TASK\n${item.task}`, maxTokens: 1500 }))
    const checks = []
    for (const check of item.checks ?? []) {
      const a = await grade(llm, route, check, item.task, answerA, signal)
      const b = await grade(llm, route, check, item.task, answerB, signal)
      total += 1
      if (a.pass) passA += 1
      else failures.push({ case: item.id, task: clip(item.task, 200), check: describeCheck(check), why: a.why })
      if (b.pass) passB += 1
      checks.push({ id: check.id, kind: check.kind, check: describeCheck(check), withSkill: a, baseline: b })
    }
    out.push({ id: item.id, task: item.task, evidence: item.evidence, answerWithSkill: answerA, answerBaseline: answerB, checks })
  }
  const passRate = total ? passA / total : 0
  const baseline = total ? passB / total : 0
  return { skill: skill.name, cases: out, checks: total, passRate, baseline, lift: passRate - baseline, failures }
}

/**
 * Fold an eval result into a sidecar. A skill needs a patch when it fails
 * the threshold or does worse than no skill at all.
 */
export function applyEvalResult(sidecar, result, { evalPassThreshold }, now = Date.now()) {
  const needsPatch = result.passRate < evalPassThreshold || result.lift < 0
  return {
    ...sidecar,
    eval: {
      passRate: result.passRate,
      baseline: result.baseline,
      lift: result.lift,
      checks: result.checks,
      runs: (sidecar.eval?.runs ?? 0) + 1,
      at: new Date(now).toISOString(),
    },
    needsPatch,
    evalFailures: needsPatch ? result.failures.slice(0, 5) : [],
  }
}

/**
 * Persist one eval result: sidecar (re-read from disk so concurrent usage
 * counts survive), ledger line, and the layer's results log. Call under the
 * layer lock.
 * @returns {Promise<object | null>} the new sidecar, or null when the skill vanished.
 */
export async function recordEval({ skillDir, dirs, result, runId, config, now = Date.now() }) {
  const current = readOwnedSkill(skillDir)
  if (!current) return null
  const sidecar = applyEvalResult(current.sidecar, result, config, now)
  await writeJson(join(skillDir, SIDECAR), sidecar)
  await appendJsonl(join(skillDir, LEDGER), {
    at: new Date(now).toISOString(),
    run: runId,
    op: 'eval',
    reason: `pass ${(result.passRate * 100).toFixed(0)}% vs baseline ${(result.baseline * 100).toFixed(0)}% over ${result.checks} checks`,
  })
  await appendJsonl(join(dirs.evalResults, `${runId}.jsonl`), { at: new Date(now).toISOString(), ...result })
  return sidecar
}

/**
 * Render a human-review report: every answer and every verdict, so graders can
 * be audited before their scores are trusted.
 * @param {string} runId - eval run id.
 * @param {object[]} results - results from {@link evalSkill}.
 * @returns {string} Markdown.
 */
export function renderReport(runId, results) {
  const lines = [`# autoharness eval report \`${runId}\``, '']
  lines.push('| skill | checks | with skill | baseline | lift |', '|---|---|---|---|---|')
  for (const r of results) lines.push(`| ${r.skill} | ${r.checks} | ${(r.passRate * 100).toFixed(0)}% | ${(r.baseline * 100).toFixed(0)}% | ${(r.lift * 100).toFixed(0)} pts |`)
  for (const r of results) {
    lines.push('', `## ${r.skill}`)
    for (const c of r.cases) {
      lines.push('', `### case \`${c.id}\``, '', `**Task:** ${c.task}`)
      if (c.evidence) lines.push('', `Evidence: \`${c.evidence}\` (inside the skill directory)`)
      lines.push('', '| check | with skill | baseline |', '|---|---|---|')
      for (const k of c.checks) {
        const cell = (v) => `${v.pass ? 'PASS' : 'FAIL'}: ${v.why.replace(/\|/g, '\\|').replace(/\n/g, ' ')}`
        lines.push(`| ${k.check.replace(/\|/g, '\\|')} | ${cell(k.withSkill)} | ${cell(k.baseline)} |`)
      }
      lines.push('', '<details><summary>Answer with skill</summary>', '', '```text', c.answerWithSkill.replace(/```/g, "'''"), '```', '</details>')
      lines.push('', '<details><summary>Baseline answer</summary>', '', '```text', c.answerBaseline.replace(/```/g, "'''"), '```', '</details>')
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
