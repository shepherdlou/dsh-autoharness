/**
 * REF: turns one episode plus the current library into proposed intents. The
 * reflector never writes; it returns proposals for the promoter.
 *
 * @module dsh-autoharness/reflect
 */
import { BUDGET, MalformedOutputError, completeJson } from './llm.js'
import { curateSystem, reflectSystem } from './prompts.js'
import { redact } from './redact.js'
import { renderTranscript } from './transcript.js'

/** Skills whose full body is shown to the reflector; the rest are listed by summary. */
const MAX_FULL_BODIES = 12
/** Other sources' skills listed to the reflector so it does not re-learn what they cover. */
const MAX_OTHER_SKILLS = 80

function words(text) {
  return new Set(String(text).toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? [])
}

/**
 * Pick which skills get their full body in the prompt: those needing a patch
 * first, then the ones sharing the most vocabulary with the episode.
 */
export function selectFullBodies(skills, episodeText, max = MAX_FULL_BODIES) {
  const vocab = words(episodeText)
  const scored = skills.map((skill) => {
    let overlap = 0
    for (const word of words(`${skill.name.replace(/-/g, ' ')} ${skill.description} ${skill.whenToUse ?? ''}`)) if (vocab.has(word)) overlap += 1
    return { skill, score: (skill.sidecar?.needsPatch || evalsDoNotDiscriminate(skill.sidecar) ? 1000 : 0) + overlap }
  })
  scored.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
  return new Set(scored.slice(0, max).filter((item) => item.score > 0).map((item) => item.skill.name))
}

function skillRow(skill, full) {
  return {
    name: skill.name,
    layer: skill.layer,
    category: skill.sidecar?.category ?? 'general',
    description: skill.description,
    ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
    status: skill.sidecar?.status,
    uses: skill.sidecar?.uses ?? 0,
    evalCases: skill.evalCount ?? 0,
    ...(full ? { body: skill.body } : {}),
  }
}

/** Whether every counted check of a skill also passes without the skill. */
export function evalsDoNotDiscriminate(sidecar) {
  const e = sidecar?.eval
  return Boolean(e && e.checks > 0 && Array.isArray(e.nonDiscriminating) && e.nonDiscriminating.length >= e.checks)
}

/** Eval feedback rows: skills that failed their evals, and skills whose evals test nothing. */
export function evalFeedback(skills) {
  const rows = []
  for (const skill of skills) {
    const sidecar = skill.sidecar
    if (sidecar?.needsPatch) {
      rows.push({ skill: skill.name, issue: 'failing', passRate: sidecar.eval?.passRate, lift: sidecar.eval?.lift, failures: (sidecar.evalFailures ?? []).slice(0, 3) })
    } else if (evalsDoNotDiscriminate(sidecar)) {
      rows.push({ skill: skill.name, issue: 'evals do not discriminate: the answer without the skill passes every check, so the cases probably give the lesson away', checks: sidecar.eval.nonDiscriminating })
    }
  }
  return rows
}

/**
 * Build the reflector request.
 * @param {object} input - reflection inputs.
 * @param {{ sessionId: string, fromSeq: number, toSeq: number, entries: object[] }} input.episode - bounded episode.
 * @param {object[]} input.owned - self-authored skills.
 * @param {{ name: string, description: string }[]} input.otherSkills - skills from other sources (read-only).
 * @param {Readonly<object>} input.config - effective configuration.
 * @returns {{ system: string, user: string }} prompt parts.
 */
export function buildReflectRequest({ episode, owned, otherSkills = [], config }) {
  const transcript = renderTranscript(episode.entries)
  const full = selectFullBodies(owned, transcript)
  const sections = [
    'EXISTING_AUTOHARNESS_SKILLS',
    JSON.stringify(owned.map((skill) => skillRow(skill, full.has(skill.name))), null, 1),
    'OTHER_SKILLS',
    JSON.stringify(otherSkills.slice(0, MAX_OTHER_SKILLS).map((skill) => ({ name: skill.name, description: String(skill.description ?? '').replace(/\s+/g, ' ').slice(0, 160) })), null, 1),
    'EVAL_FEEDBACK',
    JSON.stringify(evalFeedback(owned), null, 1),
    `EPISODE (session ${episode.sessionId}, seq ${episode.fromSeq}..${episode.toSeq})`,
    transcript,
  ]
  return { system: reflectSystem(config), user: redact(sections.join('\n\n')) }
}

/**
 * Validate the reflector's envelope and keep object-shaped intents.
 * @param {any} value - parsed model output.
 * @returns {object[]} intents.
 */
export function normalizeIntents(value) {
  if (!value || !Array.isArray(value.intents)) throw new MalformedOutputError('reflector output must be {"intents": [...]}')
  return value.intents.filter((intent) => intent && typeof intent === 'object' && typeof intent.op === 'string')
}

/**
 * Ask for intents; a reply that is not the requested JSON gets one retry
 * with a reminder. Provider errors are not retried here.
 */
async function askForIntents(llm, request) {
  try {
    return normalizeIntents(await completeJson(llm, request))
  } catch (error) {
    if (!(error instanceof MalformedOutputError) || request.signal?.aborted) throw error
    const user = `${request.user}\n\nREMINDER: your previous reply could not be used (${error.message}). Reply with exactly one JSON object of the form {"intents": [...]} and nothing else.`
    return normalizeIntents(await completeJson(llm, { ...request, user }))
  }
}

/**
 * Ask the model for intents about one episode.
 * @param {object} options - see {@link buildReflectRequest}, plus `llm`, `route`, and `signal`.
 * @returns {Promise<object[]>} proposed intents.
 */
export async function reflect({ llm, route, signal, ...input }) {
  const request = buildReflectRequest(input)
  return askForIntents(llm, { route, signal, maxTokens: BUDGET.reflect, ...request })
}

/**
 * Ask the model to consolidate the library. Only merge, archive, and none
 * survive; anything else the curator proposes is dropped.
 * @param {{ llm: object, route: object, owned: object[], config: Readonly<object>, signal?: AbortSignal }} options - curator inputs.
 * @returns {Promise<object[]>} proposed intents.
 */
export async function curate({ llm, route, owned, config, signal }) {
  if (owned.length < 2) return []
  const library = owned.map((skill) => skillRow(skill, true))
  const user = redact(['LIBRARY', JSON.stringify(library, null, 1)].join('\n\n'))
  const intents = await askForIntents(llm, { route, signal, maxTokens: BUDGET.curate, system: curateSystem(config), user })
  return intents.filter((intent) => ['merge', 'archive', 'none'].includes(intent.op))
}
