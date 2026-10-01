/**
 * REF: turns one episode plus the current library into proposed intents. The
 * reflector never writes; it returns proposals for the promoter.
 *
 * @module dsh-autoharness/reflect
 */
import { completeJson } from './llm.js'
import { curateSystem, reflectSystem } from './prompts.js'
import { redact } from './redact.js'
import { renderTranscript } from './transcript.js'

/** Skills whose full body is shown to the reflector; the rest are listed by summary. */
const MAX_FULL_BODIES = 12

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
    return { skill, score: (skill.sidecar?.needsPatch ? 1000 : 0) + overlap }
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

/** Eval feedback rows for skills flagged as needing a patch. */
export function evalFeedback(skills) {
  return skills
    .filter((skill) => skill.sidecar?.needsPatch)
    .map((skill) => ({
      skill: skill.name,
      passRate: skill.sidecar.eval?.passRate,
      lift: skill.sidecar.eval?.lift,
      failures: (skill.sidecar.evalFailures ?? []).slice(0, 3),
    }))
}

/**
 * Build the reflector request.
 * @param {object} input - reflection inputs.
 * @param {{ sessionId: string, fromSeq: number, toSeq: number, entries: object[] }} input.episode - bounded episode.
 * @param {object[]} input.owned - self-authored skills.
 * @param {string[]} input.otherNames - names of skills from other sources (read-only).
 * @param {Readonly<object>} input.config - effective configuration.
 * @returns {{ system: string, user: string }} prompt parts.
 */
export function buildReflectRequest({ episode, owned, otherNames, config }) {
  const transcript = renderTranscript(episode.entries)
  const full = selectFullBodies(owned, transcript)
  const sections = [
    'EXISTING_AUTOHARNESS_SKILLS',
    JSON.stringify(owned.map((skill) => skillRow(skill, full.has(skill.name))), null, 1),
    'OTHER_SKILL_NAMES',
    JSON.stringify(otherNames),
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
  if (!value || !Array.isArray(value.intents)) throw new Error('reflector output must be {"intents": [...]}')
  return value.intents.filter((intent) => intent && typeof intent === 'object' && typeof intent.op === 'string')
}

/**
 * Ask the model for intents about one episode.
 * @param {object} options - see {@link buildReflectRequest}, plus `llm`, `route`, and `signal`.
 * @returns {Promise<object[]>} proposed intents.
 */
export async function reflect({ llm, route, signal, ...input }) {
  const request = buildReflectRequest(input)
  return normalizeIntents(await completeJson(llm, { route, signal, maxTokens: 8192, ...request }))
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
  const value = await completeJson(llm, { route, signal, maxTokens: 8192, system: curateSystem(config), user })
  return normalizeIntents(value).filter((intent) => ['merge', 'archive', 'none'].includes(intent.op))
}
