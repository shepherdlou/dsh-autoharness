/**
 * Grader validation. A judge's verdict is only an opinion until a human has
 * checked some of them. Humans label answers in the review page; this module
 * turns those labels into scores:
 *
 * - a labeled answer is scored by its human label, never by the grader;
 * - each check's grader is measured against the labels it has, and a grader
 *   that agrees with fewer than {@link TRUST_THRESHOLD} of them stops counting
 *   for unlabeled answers until it is fixed;
 * - unlabeled answers of trusted graders keep the grader's verdict.
 *
 * Labels live in the skill bundle (`evals/labels.jsonl`), so they travel with
 * the skill and its eval cases.
 *
 * @module dsh-autoharness/labels
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { appendJsonl, readJsonl } from './store.js'

/** Minimum share of human labels a grader must agree with to be trusted. */
export const TRUST_THRESHOLD = 0.75

export const VARIANTS = Object.freeze(['withSkill', 'baseline'])

/** Short content hash identifying one exact answer text. */
export function answerHash(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16)
}

const answerKey = (l) => `${l.case}\u0000${l.check}\u0000${l.variant}\u0000${l.answer}`
const checkKey = (caseId, checkId) => `${caseId}\u0000${checkId}`

/** Latest label per exact answer; later lines win. */
export function latestLabels(labels) {
  const latest = new Map()
  for (const label of labels) {
    if (!label || typeof label.human !== 'boolean' || !VARIANTS.includes(label.variant)) continue
    latest.set(answerKey(label), label)
  }
  return [...latest.values()]
}

/**
 * Agreement of each check's grader with human labels.
 * @param {object[]} labels - labels of one skill.
 * @returns {Map<string, { labeled: number, agreed: number, trusted: boolean }>} keyed by case and check id.
 */
export function graderAgreement(labels) {
  const out = new Map()
  for (const label of latestLabels(labels)) {
    if (typeof label.judge !== 'boolean') continue
    const key = checkKey(label.case, label.check)
    const entry = out.get(key) ?? { labeled: 0, agreed: 0, trusted: true }
    entry.labeled += 1
    if (label.judge === label.human) entry.agreed += 1
    entry.trusted = entry.agreed / entry.labeled >= TRUST_THRESHOLD
    out.set(key, entry)
  }
  return out
}

/**
 * Score a raw eval result with human labels applied.
 * @param {{ skill: string, cases: object[] }} raw - verdicts from `evalSkill`.
 * @param {object[]} [labels] - the skill's labels.
 * @returns {object} the raw result plus `checks`, `passRate`, `baseline`, `lift`
 *   (null when nothing could be counted), `failures`, and `graders`.
 */
export function scoreResult(raw, labels = []) {
  const human = new Map(latestLabels(labels).map((label) => [answerKey(label), label.human]))
  const agreement = graderAgreement(labels)
  const totals = { withSkill: { pass: 0, n: 0 }, baseline: { pass: 0, n: 0 } }
  const failures = []
  const untrusted = new Set()
  const nonDiscriminating = []
  let excluded = 0
  const cases = raw.cases.map((item) => ({
    ...item,
    checks: item.checks.map((check) => {
      const trust = agreement.get(checkKey(item.id, check.id))
      if (trust && !trust.trusted) untrusted.add(`${item.id}/${check.id}`)
      const scored = {}
      for (const variant of VARIANTS) {
        const verdict = check.verdicts[variant]
        const label = human.get(answerKey({ case: item.id, check: check.id, variant, answer: item.hashes[variant] }))
        let source
        let pass
        if (label !== undefined) {
          source = 'human'
          pass = label
        } else if (trust && !trust.trusted) {
          source = 'excluded'
          pass = null
          excluded += 1
        } else {
          source = 'grader'
          pass = verdict.pass
        }
        scored[variant] = { source, pass }
        if (pass === null) continue
        totals[variant].n += 1
        if (pass) totals[variant].pass += 1
        else if (variant === 'withSkill') failures.push({ case: item.id, task: String(item.task).slice(0, 200), check: check.check, why: source === 'human' ? 'a human labeled this answer as failing' : verdict.why })
      }
      if (scored.withSkill.pass === true && scored.baseline.pass === true) nonDiscriminating.push(`${item.id}/${check.id}`)
      return { ...check, scored }
    }),
  }))
  const rate = ({ pass, n }) => (n ? pass / n : null)
  const passRate = rate(totals.withSkill)
  const baseline = rate(totals.baseline)
  let labeled = 0
  let agreed = 0
  for (const entry of agreement.values()) {
    labeled += entry.labeled
    agreed += entry.agreed
  }
  return {
    ...raw,
    cases,
    checks: totals.withSkill.n,
    passRate,
    baseline,
    lift: passRate === null || baseline === null ? null : passRate - baseline,
    failures,
    nonDiscriminating,
    graders: { labeled, agreed, untrusted: [...untrusted], excluded },
  }
}

/** Read a skill's labels. */
export function readLabels(skillDir) {
  return readJsonl(join(skillDir, 'evals', 'labels.jsonl'))
}

/** Append labels to a skill. */
export async function appendLabels(skillDir, labels, now = Date.now()) {
  for (const label of labels) {
    await appendJsonl(join(skillDir, 'evals', 'labels.jsonl'), {
      at: new Date(now).toISOString(),
      case: label.case,
      check: label.check,
      variant: label.variant,
      answer: label.answer,
      human: label.human,
      ...(typeof label.judge === 'boolean' ? { judge: label.judge } : {}),
      ...(label.note ? { note: String(label.note).slice(0, 500) } : {}),
    })
  }
}

/**
 * Validate an exported labels file from the review page.
 * @param {any} value - parsed JSON.
 * @returns {object[]} well-formed labels.
 */
export function parseLabelExport(value) {
  if (!value || value.format !== 'autoharness-labels' || !Array.isArray(value.labels)) throw new Error('not an autoharness labels export (expected format "autoharness-labels")')
  return value.labels.filter((label) =>
    label && typeof label.skill === 'string' && typeof label.case === 'string' && typeof label.check === 'string'
    && VARIANTS.includes(label.variant) && typeof label.answer === 'string' && typeof label.human === 'boolean')
}
