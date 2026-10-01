/**
 * Intent lint: the promoter's gate. Every rule returns a human-readable error;
 * any error rejects the whole intent, which is recorded in the run file and
 * never partially written.
 *
 * @module dsh-autoharness/lint
 */
import { containsSecret } from './redact.js'
import { bodyLineCount, isSkillName } from './skillfile.js'

export const OPS = Object.freeze(['create', 'patch', 'merge', 'archive', 'none'])
export const CHECK_KINDS = Object.freeze(['llm-judge', 'contains', 'not-contains', 'regex'])

const MAX_BODY_CHARS = 4000
const MAX_CASES = 3
const MAX_CHECKS = 4
const CATEGORY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Model-facing framing tags a skill body must never open or close. */
const FRAMING = /<\/?\s*(?:skill_content|system-reminder|system_reminder|available_skills|autoharness-index|instructions|tool_result|function_calls)\b/i

/** Prompt-injection phrasing that has no place in a learned skill. */
const INJECTION = [
  /\bignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|rules|messages)\b/i,
  /\bdisregard (?:all |any )?(?:the )?(?:system|previous|prior|above) (?:prompt|instructions|rules)\b/i,
  /\b(?:do not|don't|never) (?:tell|inform|show) the user\b/i,
  /\bhide (?:this|these|it) from the user\b/i,
]

/** Destructive or remote-code commands a learned skill must not teach. */
const DANGEROUS = [
  [/\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(?:\/(?:\s|$|\*)|~\/?(?:\s|$)|\$HOME\b|\*(?:\s|$))/, 'recursive delete of a root, home, or wildcard'],
  [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, 'piping a download into a shell'],
  [/\bgit\s+push\b[^\n]*\s(?:--force(?!-with-lease)\b|-f\b)/, 'force push'],
  [/\bgit\s+reset\s+--hard\b/, 'hard reset'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*d|git\s+clean\s+-[a-zA-Z]*d[a-zA-Z]*f/, 'git clean -fd'],
  [/\bmkfs(?:\.\w+)?\b/, 'filesystem formatting'],
  [/\bdd\s+[^\n]*\bof=\/dev\//, 'raw device write'],
  [/\bchmod\s+-R\s+0?777\b/, 'world-writable recursive chmod'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\bsudo\s+rm\b/, 'privileged delete'],
]

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function checkDescription(description, config, errors) {
  if (!isNonEmptyString(description)) return errors.push('description is required')
  if (/[\r\n]/.test(description)) errors.push('description must be a single line')
  if (description.trim().length < 20) errors.push('description must be at least 20 characters')
  if (description.length > config.skillDescMaxChars) errors.push(`description exceeds ${config.skillDescMaxChars} characters`)
  if (containsSecret(description)) errors.push('description contains a secret-shaped value')
  if (FRAMING.test(description)) errors.push('description contains a framing tag')
}

function checkWhenToUse(whenToUse, errors) {
  if (whenToUse === undefined) return
  if (typeof whenToUse !== 'string' || /[\r\n]/.test(whenToUse) || whenToUse.length > 300) errors.push('whenToUse must be a single line of at most 300 characters')
  else if (containsSecret(whenToUse)) errors.push('whenToUse contains a secret-shaped value')
}

/**
 * Lint a skill body.
 * @param {unknown} body - candidate body.
 * @param {{ skillBodyMaxLines: number }} config - size limits.
 * @returns {string[]} errors.
 */
export function lintBody(body, config) {
  const errors = []
  if (!isNonEmptyString(body)) return ['body is required']
  if (bodyLineCount(body) > config.skillBodyMaxLines) errors.push(`body exceeds ${config.skillBodyMaxLines} non-empty lines`)
  if (body.length > MAX_BODY_CHARS) errors.push(`body exceeds ${MAX_BODY_CHARS} characters`)
  if (/^\s*---/.test(body)) errors.push('body must not start with a frontmatter delimiter')
  if (FRAMING.test(body)) errors.push('body contains a model-facing framing tag')
  for (const pattern of INJECTION) if (pattern.test(body)) errors.push('body contains prompt-injection phrasing')
  if (containsSecret(body)) errors.push('body contains a secret-shaped value')
  for (const [pattern, label] of DANGEROUS) if (pattern.test(body)) errors.push(`body teaches a dangerous command (${label})`)
  return errors
}

/**
 * Lint eval cases. Each check carries exactly one criterion so a failure
 * points at one behavior (narrow evaluators, code checks kept separate from
 * LLM judges).
 * @param {unknown} evals - candidate cases.
 * @returns {string[]} errors.
 */
export function lintEvals(evals) {
  const errors = []
  if (!Array.isArray(evals)) return ['evals must be an array']
  if (evals.length > MAX_CASES) errors.push(`at most ${MAX_CASES} eval cases per intent`)
  evals.forEach((item, i) => {
    const at = `evals[${i}]`
    if (!item || typeof item !== 'object') return errors.push(`${at} must be an object`)
    if (!isNonEmptyString(item.task) || item.task.trim().length < 10 || item.task.length > 2000) errors.push(`${at}.task must be 10-2000 characters`)
    else if (containsSecret(item.task)) errors.push(`${at}.task contains a secret-shaped value`)
    if (!Array.isArray(item.checks) || item.checks.length === 0 || item.checks.length > MAX_CHECKS) {
      errors.push(`${at}.checks must hold 1-${MAX_CHECKS} checks`)
      return
    }
    item.checks.forEach((check, j) => {
      const cat = `${at}.checks[${j}]`
      if (!check || !CHECK_KINDS.includes(check.kind)) return errors.push(`${cat}.kind must be one of ${CHECK_KINDS.join(', ')}`)
      if (check.kind === 'llm-judge') {
        if (!isNonEmptyString(check.criterion) || /[\r\n]/.test(check.criterion) || check.criterion.length > 300) errors.push(`${cat}.criterion must be one line of at most 300 characters`)
        return
      }
      if (!isNonEmptyString(check.pattern) || check.pattern.length > 200) return errors.push(`${cat}.pattern must be 1-200 characters`)
      if (check.kind === 'regex') {
        if (check.flags !== undefined && !/^[imsu]*$/.test(check.flags)) errors.push(`${cat}.flags may only use i, m, s, u`)
        try {
          new RegExp(check.pattern, check.flags ?? '')
        } catch {
          errors.push(`${cat}.pattern is not a valid regular expression`)
        }
      }
    })
  })
  return errors
}

function checkEvidence(evidence, episode, errors) {
  if (!episode) return
  if (!evidence || !Number.isInteger(evidence.fromSeq) || !Number.isInteger(evidence.toSeq) || evidence.fromSeq > evidence.toSeq) {
    errors.push('evidence must be {fromSeq, toSeq} integers with fromSeq <= toSeq')
    return
  }
  if (evidence.fromSeq < episode.fromSeq || evidence.toSeq > episode.toSeq) errors.push(`evidence ${evidence.fromSeq}..${evidence.toSeq} is outside the episode ${episode.fromSeq}..${episode.toSeq}`)
}

/**
 * Lint one intent.
 * @param {any} intent - the reflector's or curator's proposal.
 * @param {object} context - lint context.
 * @param {Readonly<object>} context.config - effective configuration.
 * @param {Map<string, { evalCount?: number }>} context.owned - self-authored skills by name, across layers.
 * @param {(name: string) => boolean} context.isTaken - whether a foreign skill already uses a name.
 * @param {{ fromSeq: number, toSeq: number } | null} context.episode - seq range evidence must fall within; null for curator runs.
 * @param {Set<string>} [context.claimed] - names created or merged earlier in this run.
 * @returns {string[]} errors; empty means the intent may land.
 */
export function lintIntent(intent, context) {
  const { config, owned, isTaken, episode, claimed = new Set() } = context
  const errors = []
  if (!intent || typeof intent !== 'object' || !OPS.includes(intent.op)) return [`op must be one of ${OPS.join(', ')}`]
  if (intent.op === 'none') return errors
  if (!isNonEmptyString(intent.reason)) errors.push('reason is required')

  const ownedName = (name, label) => {
    if (!isSkillName(name)) errors.push(`${label} "${name}" is not a valid kebab-case skill name`)
    else if (!owned.has(name)) errors.push(`${label} "${name}" is not a skill autoharness authored`)
  }
  const freeName = (name, label) => {
    if (!isSkillName(name)) errors.push(`${label} "${name}" is not a valid kebab-case skill name (max 64 chars)`)
    else if (owned.has(name) || claimed.has(name) || isTaken(name)) errors.push(`${label} "${name}" already exists`)
  }

  switch (intent.op) {
    case 'create': {
      freeName(intent.name, 'name')
      const scope = intent.scope ?? 'project'
      if (scope !== 'project' && scope !== 'global') errors.push('scope must be project or global')
      if (scope === 'global' && !config.globalLayer) errors.push('the global layer is disabled')
      if (intent.category !== undefined && (!CATEGORY.test(intent.category) || intent.category.length > 24)) errors.push('category must be kebab-case, at most 24 characters')
      checkDescription(intent.description, config, errors)
      checkWhenToUse(intent.whenToUse, errors)
      errors.push(...lintBody(intent.body, config))
      checkEvidence(intent.evidence, episode, errors)
      if (intent.evals !== undefined) errors.push(...lintEvals(intent.evals))
      if (config.requireEval && (!Array.isArray(intent.evals) || intent.evals.length === 0)) errors.push('at least one eval case is required')
      break
    }
    case 'patch': {
      ownedName(intent.name, 'name')
      if (intent.description === undefined && intent.body === undefined && intent.whenToUse === undefined) errors.push('patch must change description, whenToUse, or body')
      if (intent.description !== undefined) checkDescription(intent.description, config, errors)
      checkWhenToUse(intent.whenToUse, errors)
      if (intent.body !== undefined) errors.push(...lintBody(intent.body, config))
      checkEvidence(intent.evidence, episode, errors)
      if (intent.evals !== undefined) errors.push(...lintEvals(intent.evals))
      const existing = owned.get(intent.name)?.evalCount ?? 0
      if (config.requireEval && existing === 0 && (!Array.isArray(intent.evals) || intent.evals.length === 0)) errors.push('the skill has no eval case yet; the patch must add one')
      break
    }
    case 'merge': {
      if (!Array.isArray(intent.from) || intent.from.length === 0) errors.push('merge.from must list at least one skill')
      else {
        if (new Set(intent.from).size !== intent.from.length) errors.push('merge.from has duplicates')
        for (const name of intent.from) ownedName(name, 'merge.from')
        if (intent.from.includes(intent.into)) errors.push('merge.into must not also appear in merge.from')
      }
      if (!isSkillName(intent.into)) errors.push(`merge.into "${intent.into}" is not a valid kebab-case skill name`)
      else if (!owned.has(intent.into) && (claimed.has(intent.into) || isTaken(intent.into))) errors.push(`merge.into "${intent.into}" already exists and is not autoharness-authored`)
      if (intent.category !== undefined && (!CATEGORY.test(intent.category) || intent.category.length > 24)) errors.push('category must be kebab-case, at most 24 characters')
      checkDescription(intent.description, config, errors)
      checkWhenToUse(intent.whenToUse, errors)
      errors.push(...lintBody(intent.body, config))
      if (intent.evals !== undefined) errors.push(...lintEvals(intent.evals))
      break
    }
    case 'archive':
      ownedName(intent.name, 'name')
      break
  }
  return errors
}
