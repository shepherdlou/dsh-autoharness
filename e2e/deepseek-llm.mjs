// A minimal `ctx.llm` over DeepSeek's chat completions API, for the e2e scripts
// that drive the runtime outside a dsh process (the replay step's judges).
// Development only; the plugin itself always goes through dsh's ctx.llm.

export const route = { provider: 'deepseek-official', model: process.env.DS_MODEL ?? 'deepseek-flash' }

export const llm = {
  calls: [],
  stream(options) {
    const calls = this.calls
    return (async function* () {
      const messages = [
        ...(options.system ? [{ role: 'system', content: options.system }] : []),
        ...options.messages.map((m) => ({ role: m.role, content: m.content.map((b) => b.text ?? '').join('') })),
      ]
      const body = { model: options.model, messages, temperature: options.temperature ?? 0, ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}) }
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify(body),
        signal: options.signal,
      })
      const json = await response.json()
      const choice = json.choices?.[0]
      calls.push({ status: response.status, finish: choice?.finish_reason, usage: json.usage })
      if (!response.ok || !choice) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: String(response.status), message: json.error?.message ?? 'request failed' } } }
        return
      }
      if (choice.message.reasoning_content) yield { type: 'reasoning-delta', index: 0, text: choice.message.reasoning_content }
      if (choice.message.content) yield { type: 'text-delta', index: 1, text: choice.message.content }
      yield { type: 'finish', reason: { kind: choice.finish_reason === 'length' ? 'max-tokens' : 'stop' } }
    })()
  },
}
