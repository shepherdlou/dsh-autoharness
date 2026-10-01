/**
 * One-shot model calls over `ctx.llm.stream`, the same seam the official
 * auto-review plugin uses: a fixed system prompt, one user text, temperature 0,
 * no tools. Reasoning blocks are ignored; the final text block is the answer.
 *
 * @module dsh-autoharness/llm
 */

/**
 * Output budgets per call kind. Reasoning models (deepseek-flash among them)
 * spend reasoning tokens from the same `max_tokens`, so these are generous;
 * only tokens actually generated are billed.
 */
export const BUDGET = Object.freeze({ reflect: 32_768, curate: 32_768, answer: 8_192, judge: 4_096 })

/** The model replied, but not in the shape the caller asked for. Worth one retry. */
export class MalformedOutputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MalformedOutputError'
  }
}

/** Text an eval answer gets when the model spends its whole budget without answering. */
export const NO_ANSWER = '(no answer: the model used its whole token budget without replying)'

const LIGHT_EFFORT = [/^none$/i, /^off$/i, /^minimal$/i, /^lowest$/i, /^low$/i]
const effortCache = new Map()

/**
 * The lightest reasoning effort a route offers, for calls that need no deep
 * thought (eval answers and judges). Resolved once per route through
 * `ctx.llm.resolveModelInfo`; undefined keeps the provider default.
 * @param {{ resolveModelInfo?: Function }} llm - the `ctx.llm` service.
 * @param {{ provider: string, model: string }} route - model route.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<string | undefined>} an effort id, or undefined.
 */
export async function lightEffort(llm, route, signal) {
  if (typeof llm?.resolveModelInfo !== 'function') return undefined
  const key = `${route.provider}\u0000${route.model}`
  if (!effortCache.has(key)) {
    effortCache.set(key, (async () => {
      try {
        const info = await llm.resolveModelInfo(route.provider, route.model, signal)
        const ids = (info?.reasoning?.efforts ?? []).map((effort) => effort.id)
        for (const pattern of LIGHT_EFFORT) {
          const hit = ids.find((id) => pattern.test(String(id)))
          if (hit) return hit
        }
      } catch {
        // unknown metadata keeps the provider default
      }
      return undefined
    })())
  }
  return effortCache.get(key)
}

/**
 * Resolve the model route: explicit config wins, otherwise the session's
 * latest request header.
 * @param {{ provider?: string, model?: string }} config - effective configuration.
 * @param {object} [session] - live session with `requestHeader()`.
 * @returns {{ provider: string, model: string } | null} the route, or null when none is known yet.
 */
export function resolveRoute(config, session) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  let header
  try {
    header = session?.requestHeader?.()
  } catch {
    header = undefined
  }
  const provider = config.provider || header?.config?.provider
  const model = config.model || header?.config?.model
  return provider && model ? { provider, model } : null
}

/**
 * Stream one completion and return its final text block.
 * @param {{ stream: (options: object) => AsyncIterable<any> }} llm - the `ctx.llm` service.
 * @param {{ route: { provider: string, model: string }, system: string, user: string, maxTokens?: number, signal?: AbortSignal, allowTruncated?: boolean, effort?: string }} request - call inputs;
 *   `allowTruncated` accepts text cut off by the token budget (or {@link NO_ANSWER} when nothing was written) instead of failing.
 * @returns {Promise<string>} the final text block.
 */
export async function complete(llm, { route, system, user, maxTokens, signal, allowTruncated = false, effort }) {
  const options = {
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    temperature: 0,
    ...(maxTokens ? { maxTokens } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(signal ? { signal } : {}),
  }
  const texts = new Map()
  let finish
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === 'text-delta') texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text)
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  if (!finish) throw new Error('model stream ended without a finish chunk')
  if (finish.kind === 'max-tokens' && allowTruncated) {
    const text = texts.size ? texts.get(Math.max(...texts.keys())) : ''
    return text.trim() ? text : NO_ANSWER
  }
  if (finish.kind !== 'stop') {
    const detail = finish.failure ? `: ${finish.failure.code ?? ''} ${finish.failure.message ?? ''}`.trimEnd() : ''
    throw new Error(`model ended with ${finish.kind}${detail}`)
  }
  if (texts.size === 0) return ''
  return texts.get(Math.max(...texts.keys()))
}

/**
 * Parse the first JSON object in model text, tolerating a Markdown fence or
 * stray prose around it.
 * @param {string} text - model output.
 * @returns {any} the parsed object.
 */
export function parseJsonObject(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end < start) throw new MalformedOutputError('model output contains no JSON object')
  let value
  try {
    value = JSON.parse(body.slice(start, end + 1))
  } catch (error) {
    throw new MalformedOutputError(`model output is not valid JSON: ${error.message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MalformedOutputError('model output is not a JSON object')
  return value
}

/** {@link complete} followed by {@link parseJsonObject}. */
export async function completeJson(llm, request) {
  return parseJsonObject(await complete(llm, request))
}
