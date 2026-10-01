// Shared test doubles: temp projects, a scripted LLM, and a minimal cordis-like context.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { layoutFor } from '../lib/paths.js'

/** A temp git project plus isolated DSH_HOME / DSH_AGENTS_HOME. */
export function tempProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'autoharness-'))
  const project = join(root, 'project')
  mkdirSync(join(project, '.git'), { recursive: true })
  const env = { DSH_HOME: join(root, 'dsh-home'), DSH_AGENTS_HOME: join(root, 'agents-home') }
  t?.after?.(() => rmSync(root, { recursive: true, force: true }))
  return { root, project, env }
}

export function testConfig(overrides = {}) {
  return resolveConfig({ ...overrides }, {})
}

export function testLayout(project, env, config = testConfig()) {
  return layoutFor(project, { globalLayer: config.globalLayer }, env)
}

/** Write a hand-authored (foreign) skill. */
export function writeForeignSkill(dir, name, body = 'Do the thing.') {
  mkdirSync(join(dir, name), { recursive: true })
  const text = `---\nname: ${name}\ndescription: A hand-written skill that autoharness must never touch.\n---\n\n${body}\n`
  writeFileSync(join(dir, name, 'SKILL.md'), text)
  return text
}

/**
 * A scripted `ctx.llm`: `respond({ system, user })` returns the final text.
 * Streams one reasoning block and one text block per call, like a real adapter.
 */
export function scriptedLlm(respond) {
  const calls = []
  return {
    calls,
    stream(options) {
      const user = options.messages[0].content[0].text
      calls.push({ system: options.system, user, options })
      return (async function* () {
        const reply = await respond({ system: options.system, user, options })
        if (reply instanceof Error) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'boom', message: reply.message } } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: 'thinking…' }
        yield { type: 'block-start', index: 1, blockType: 'text' }
        const text = typeof reply === 'string' ? reply : JSON.stringify(reply)
        for (let i = 0; i < text.length; i += 40) yield { type: 'text-delta', index: 1, text: text.slice(i, i + 40) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** Minimal cordis-like context recording listeners, effects, and commands. */
export function fakeCtx({ llm, skills, services = {} } = {}) {
  const listeners = new Map()
  const disposers = []
  const warnings = []
  const infos = []
  const commands = []
  const ctx = {
    llm,
    warnings,
    infos,
    commands,
    logger: { info: (msg) => infos.push(msg), warn: (msg) => warnings.push(msg) },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    effect(fn) {
      disposers.push(fn())
    },
    inject(_deps, fn) {
      fn(ctx)
    },
    get(name) {
      return name === 'skills' ? skills : services[name]
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    async emit(name, ...args) {
      for (const fn of listeners.get(name) ?? []) await fn(...args)
    },
    listenerNames() {
      return [...listeners.keys()]
    },
    async dispose() {
      for (const dispose of disposers) await dispose?.()
    },
    command(name) {
      return commands.find((definition) => definition.name === name)
    },
  }
  ctx.commandsList = commands
  return ctx
}

let messageCounter = 0
export function fakeCreateUserMessage(input) {
  return Object.freeze({ id: `m${++messageCounter}`, role: 'user', ...input })
}

/** A live-session double with a request route and an event log. */
export function fakeSession({ id = 's1', cwd, origin, route = { provider: 'fake', model: 'fake-model' } } = {}) {
  let seq = 0
  return {
    header: { id, cwd, createdAt: 0, isSeeded: false, ...(origin ? { origin } : {}) },
    requestHeader: () => (route ? { config: route } : undefined),
    nextSeq: () => seq++,
  }
}

export function fakeAgent(session) {
  return {
    session,
    injected: [],
    inject(message) {
      this.injected.push(message)
    },
  }
}

/** Build session events for one turn: a user prompt, assistant text, N tool calls with results, turn end. */
export function turnEvents(session, { turn = 1, prompt = 'run the tests', calls = [] } = {}) {
  const events = []
  const push = (type, data) => events.push({ seq: session.nextSeq(), type, data })
  push('turn/start', { turn })
  push('user/message', { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
  push('assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'Working on it.' }] }, stream: [] })
  calls.forEach((call, i) => {
    const callId = `c${turn}-${i}`
    push('tool/call', { turn, step: 1, callId, name: call.name ?? 'bash', arguments: JSON.stringify(call.args ?? { command: 'ls' }) })
    push('tool/result', { turn, step: 1, message: { toolCallId: callId, isError: call.isError === true, content: [{ type: 'text', text: call.result ?? 'ok' }] } })
  })
  push('turn/end', { turn, reason: { kind: 'completed' } })
  return events
}
