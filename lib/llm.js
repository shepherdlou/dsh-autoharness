/**
 * One-shot model calls over `ctx.llm.stream`, the same seam the official
 * auto-review plugin uses: a fixed system prompt, one user text, temperature 0,
 * no tools. Reasoning blocks are ignored; the final text block is the answer.
 *
 * @module dsh-autoharness/llm
 */

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
 * @param {{ route: { provider: string, model: string }, system: string, user: string, maxTokens?: number, signal?: AbortSignal }} request - call inputs.
 * @returns {Promise<string>} the final text block.
 */
export async function complete(llm, { route, system, user, maxTokens, signal }) {
  const options = {
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    temperature: 0,
    ...(maxTokens ? { maxTokens } : {}),
    ...(signal ? { signal } : {}),
  }
  const texts = new Map()
  let finish
  for await (const chunk of llm.stream(options)) {
    if (chunk?.type === 'text-delta') texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text)
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  if (!finish) throw new Error('model stream ended without a finish chunk')
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
  if (start < 0 || end < start) throw new Error('model output contains no JSON object')
  const value = JSON.parse(body.slice(start, end + 1))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model output is not a JSON object')
  return value
}

/** {@link complete} followed by {@link parseJsonObject}. */
export async function completeJson(llm, request) {
  return parseJsonObject(await complete(llm, request))
}
