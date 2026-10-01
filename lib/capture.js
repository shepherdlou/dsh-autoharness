/**
 * CAP: turns the live `session/event` stream into compact, redacted episode
 * entries plus the counters and usage signals the rest of the pipeline needs.
 * Pure in-memory bookkeeping; the runtime persists entries for crash recovery.
 *
 * @module dsh-autoharness/capture
 */
import { redact } from './redact.js'

/** Per-kind character caps for captured text. */
export const LIMITS = Object.freeze({ user: 1500, assistant: 800, args: 400, result: 300, error: 800, context: 200 })

/**
 * Sources whose user-role messages are our own or carry no lesson: the skill
 * catalog, per-step runtime snapshots, and AGENTS.md text the agent already has.
 */
const SKIPPED_SOURCES = new Set(['autoharness', 'tool', 'skill-catalog', 'runtime-context', 'agent-instructions'])

const SKILL_PATH = /[\\/]skills[\\/]([a-z0-9]+(?:-[a-z0-9]+)*)[\\/]/

function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…[+${value.length - max} chars]`
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
}

function parseArgs(raw) {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** Whether a session belongs to a top-level agent rather than a delegated subagent. */
export function isTopLevel(session) {
  return session?.header?.origin !== 'subagent'
}

/**
 * Bound an episode to the last `digestExchanges` user exchanges and a total
 * character budget, oldest entries dropped first.
 * @param {object[]} entries - entries after the reflection watermark.
 * @param {{ digestExchanges: number, maxChars?: number }} options - bounds.
 * @returns {object[]} the retained entries.
 */
export function boundEntries(entries, { digestExchanges, maxChars = 60_000 }) {
  let out = entries
  const userIdx = out.map((entry, i) => (entry.kind === 'user' ? i : -1)).filter((i) => i >= 0)
  if (digestExchanges > 0 && userIdx.length > digestExchanges) out = out.slice(userIdx[userIdx.length - digestExchanges])
  let size = out.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0)
  let start = 0
  while (size > maxChars && start < out.length - 1) size -= JSON.stringify(out[start++]).length
  return out.slice(start)
}

/** Per-session capture state and the event-to-entry projection. */
export class Capture {
  /**
   * @param {{ home?: string }} [options] - redaction options.
   */
  constructor(options = {}) {
    this.home = options.home
    /** @type {Map<string, { sessionId: string, cwd?: string, topLevel: boolean, entries: object[], watermark: number, toolCalls: number, sinceReflect: number, calls: Map<string, string> }>} */
    this.sessions = new Map()
  }

  /** Get or create the state of one session. */
  stateOf(session) {
    const id = session.header?.id ?? session.id
    let state = this.sessions.get(id)
    if (!state) {
      state = {
        sessionId: id,
        cwd: session.header?.cwd,
        topLevel: isTopLevel(session),
        entries: [],
        watermark: -1,
        toolCalls: 0,
        sinceReflect: 0,
        calls: new Map(),
      }
      this.sessions.set(id, state)
    }
    return state
  }

  /**
   * Observe one appended session event.
   * @param {object} session - live session.
   * @param {{ seq: number, type: string, data: any }} event - appended event.
   * @returns {{ entry?: object, toolCall: boolean, turnStart: boolean, turnEnd: boolean, skillUse?: string, skillView?: string, state: object }} the derived entry and signals.
   */
  observe(session, event) {
    const state = this.stateOf(session)
    const out = { toolCall: false, turnStart: false, turnEnd: false, state }
    const data = event?.data ?? {}
    const r = (text) => redact(text, { home: this.home })
    let entry
    switch (event?.type) {
      case 'turn/start':
        out.turnStart = true
        break
      case 'turn/end':
        out.turnEnd = true
        entry = { seq: event.seq, kind: 'turn-end', reason: data.reason?.kind ?? 'unknown' }
        break
      case 'user/message': {
        const kind = data.source?.kind
        if (kind === 'skill-invocation' && typeof data.source.name === 'string') out.skillUse = data.source.name
        if (SKIPPED_SOURCES.has(kind)) break
        const text = textOf(data.content)
        if (kind === 'user') entry = { seq: event.seq, kind: 'user', text: r(clip(text, LIMITS.user)) }
        else if (text) entry = { seq: event.seq, kind: 'context', source: String(kind ?? 'unknown'), text: r(clip(text, LIMITS.context)) }
        break
      }
      case 'assistant/message': {
        const text = textOf(data.message?.content)
        if (text) entry = { seq: event.seq, kind: 'assistant', text: r(clip(text, LIMITS.assistant)), ...(data.interrupted ? { interrupted: true } : {}) }
        break
      }
      case 'tool/call': {
        out.toolCall = true
        state.calls.set(data.callId, data.name)
        if (state.topLevel) {
          state.toolCalls += 1
          state.sinceReflect += 1
        }
        const args = parseArgs(data.arguments)
        if (data.name === 'skill' && typeof args.name === 'string') out.skillUse = args.name
        if (data.name === 'read' && typeof args.file_path === 'string') {
          const match = SKILL_PATH.exec(args.file_path)
          if (match) out.skillView = match[1]
        }
        entry = { seq: event.seq, kind: 'call', name: String(data.name), args: r(clip(data.arguments ?? '', LIMITS.args)) }
        break
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const name = state.calls.get(message.toolCallId) ?? 'tool'
        state.calls.delete(message.toolCallId)
        const isError = message.isError === true
        const text = [textOf(message.content), data.error?.reason].filter(Boolean).join('\n')
        entry = { seq: event.seq, kind: 'result', name, isError, text: r(clip(text, isError ? LIMITS.error : LIMITS.result)) }
        break
      }
    }
    if (entry && state.topLevel) {
      state.entries.push(entry)
      out.entry = entry
    }
    return out
  }

  /**
   * The bounded episode since the reflection watermark.
   * @param {string} sessionId - session id.
   * @param {{ digestExchanges: number }} config - bounds.
   * @returns {{ sessionId: string, fromSeq: number, toSeq: number, entries: object[], toolCalls: number } | null} episode, or null when empty.
   */
  episode(sessionId, config) {
    const state = this.sessions.get(sessionId)
    if (!state) return null
    return buildEpisode(sessionId, state.entries.filter((entry) => entry.seq > state.watermark), config)
  }

  /** Advance the watermark after a reflection consumed entries up to `seq`. */
  markReflected(sessionId, seq) {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.watermark = Math.max(state.watermark, seq)
    state.entries = state.entries.filter((entry) => entry.seq > state.watermark)
    // Calls captured while the reflection was in flight still count toward the next one.
    state.sinceReflect = state.entries.filter((entry) => entry.kind === 'call').length
  }

  drop(sessionId) {
    this.sessions.delete(sessionId)
  }
}

/** Build a bounded episode from raw entries. */
export function buildEpisode(sessionId, entries, config) {
  const bounded = boundEntries(entries, config)
  if (bounded.length === 0) return null
  return {
    sessionId,
    fromSeq: bounded[0].seq,
    toSeq: bounded[bounded.length - 1].seq,
    entries: bounded,
    toolCalls: bounded.filter((entry) => entry.kind === 'call').length,
  }
}
