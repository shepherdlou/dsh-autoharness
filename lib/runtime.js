/**
 * The orchestrator behind the cordis entry. It is plain JavaScript over a
 * duck-typed context (`on`, `effect`, `llm`, `logger`, optional `get`) so it
 * can be tested without a harness.
 *
 * Event flow:
 * - `session/event` → capture entries, counters, and usage signals; at
 *   `turn/end`, flush counters and, past `reflectEveryN` tool calls, queue a
 *   reflection (or a consolidation past `consolidateEveryN`).
 * - `agent/created` → inject the skill index, run the lazy lifecycle, and arm
 *   recovery of episodes a crashed process never reflected on.
 * - `agent/disposed` → reflect on the tail of the session, best effort.
 *
 * Model work runs detached on a per-project queue, never inside the agent's
 * turn, so the user is never blocked waiting for reflection.
 *
 * @module dsh-autoharness/runtime
 */
import { readdirSync, statSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { Capture, buildEpisode, isTopLevel } from './capture.js'
import { evalSkill, latestResult, recordEval, writeReport } from './evals.js'
import { buildIndex } from './index-surface.js'
import { appendLabels, latestLabels, parseLabelExport, readLabels, scoreResult } from './labels.js'
import { archiveByName, flushCounters, pruneState, reviveSkill, runLifecycle, updateProjectState } from './lifecycle.js'
import { lightEffort, resolveRoute } from './llm.js'
import { LAYERS, ensureStateDir, layoutFor } from './paths.js'
import { ownedSkills, promote, recordFailedRun, withLayersLock } from './promoter.js'
import { curate, reflect } from './reflect.js'
import { renderReviewPage } from './review.js'
import { appendJsonl, atomicWrite, newId, readEvalCases, readJson, readJsonSync, readJsonl, writeJson } from './store.js'

/** Message source stamped on everything autoharness injects. */
export const SOURCE = Object.freeze({ kind: 'autoharness' })

/** Episodes untouched this long are presumed abandoned and may be recovered. */
const RECOVERY_IDLE_MS = 10 * 60_000
/** Episode logs older than this are deleted once recovery has seen them. */
const EPISODE_RETENTION_MS = 14 * 24 * 60 * 60_000

function fileSafe(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, '_')
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

export class AutoharnessRuntime {
  /**
   * @param {object} options - runtime dependencies.
   * @param {any} options.ctx - cordis context (or a test double).
   * @param {Readonly<object>} options.config - effective configuration.
   * @param {(input: { content: object[], source: object }) => object} options.createUserMessage - message factory from `@deepseek-ai/dsh-llm`.
   * @param {Record<string, string | undefined>} [options.env] - environment for path resolution.
   * @param {() => number} [options.now] - clock.
   */
  constructor({ ctx, config, createUserMessage, env = process.env, now = () => Date.now() }) {
    this.ctx = ctx
    this.config = config
    this.createUserMessage = createUserMessage
    this.env = env
    this.now = now
    this.logger = ctx.logger ?? console
    this.capture = new Capture({ home: homedir() })
    this.layouts = new Map()
    this.sessionsById = new Map()
    this.routes = new Map()
    this.pending = new Map()
    this.jobs = new Map()
    this.reflectQueued = new Set()
    this.recoveryArmed = new Set()
    this.inflight = new Set()
    this.writeChains = new Map()
    this.pausedCache = new Map()
    this.lifecycle = new AbortController()
  }

  /** Register listeners on the context. */
  attach() {
    const { ctx } = this
    ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
    ctx.on('agent/created', (payload) => this.onAgentCreated(payload))
    ctx.on('agent/turn-stopping', (payload) => this.onTurnStopping(payload))
    ctx.on('agent/disposed', (payload) => this.onAgentDisposed(payload))
    ctx.effect(() => () => this.dispose(), 'autoharness: drain background work')
  }

  // ---------------------------------------------------------------- plumbing

  layoutOf(cwd) {
    let layout = this.layouts.get(cwd)
    if (!layout) {
      layout = layoutFor(cwd, { dshHome: this.config.dshHome, globalLayer: this.config.globalLayer }, this.env)
      this.layouts.set(cwd, layout)
    }
    return layout
  }

  isPaused(layout) {
    if (this.config.paused) return true
    const cached = this.pausedCache.get(layout.projectRoot)
    if (cached && this.now() - cached.at < 5000) return cached.value
    let value = false
    try {
      value = readJsonSync(layout.layers.project.stateFile, {})?.paused === true
    } catch {
      value = false
    }
    this.pausedCache.set(layout.projectRoot, { at: this.now(), value })
    return value
  }

  /** A one-shot host answers one task and exits as soon as the agent is idle. */
  isOneShot() {
    try {
      return this.ctx.get?.('headlessStartup') !== undefined
    } catch {
      return false
    }
  }

  reflectsInTurn() {
    const mode = this.config.reflectMode
    return mode === 'in-turn' || (mode === 'auto' && this.isOneShot())
  }

  track(promise) {
    this.inflight.add(promise)
    const done = () => this.inflight.delete(promise)
    promise.then(done, done)
    return promise
  }

  signal(extra) {
    return extra ? AbortSignal.any([this.lifecycle.signal, extra]) : this.lifecycle.signal
  }

  /** Serialize model jobs per project so two reflections never race on one library. */
  enqueue(layout, label, job, extraSignal) {
    const key = layout.projectRoot
    const previous = this.jobs.get(key) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => {
      if (this.lifecycle.signal.aborted) throw new Error('autoharness is shutting down')
      return job(this.signal(extraSignal))
    })
    const tail = run.catch((error) => {
      if (!this.lifecycle.signal.aborted) this.logger.warn(`autoharness: ${label} failed: ${errorText(error)}`)
    })
    this.jobs.set(key, tail)
    this.track(tail)
    return run
  }

  persist(layout, sessionId, entry) {
    const file = join(layout.layers.project.episodes, `${fileSafe(sessionId)}.jsonl`)
    const previous = this.writeChains.get(file) ?? Promise.resolve()
    const next = previous.then(() => appendJsonl(file, entry)).catch((error) => {
      this.logger.warn(`autoharness: could not persist episode entry: ${errorText(error)}`)
    })
    this.writeChains.set(file, next)
    this.track(next)
    next.then(() => {
      if (this.writeChains.get(file) === next) this.writeChains.delete(file)
    })
  }

  async persistWatermark(layout, sessionId, seq) {
    const file = join(layout.layers.project.episodes, `${fileSafe(sessionId)}.meta.json`)
    const meta = await readJson(file, {})
    await writeJson(file, { ...meta, sessionId, reflectedUpTo: Math.max(meta.reflectedUpTo ?? -1, seq), updatedAt: new Date(this.now()).toISOString() })
  }

  deltasFor(layout) {
    let deltas = this.pending.get(layout.projectRoot)
    if (!deltas) {
      deltas = { layout, requests: 0, toolCalls: 0, skills: new Map() }
      this.pending.set(layout.projectRoot, deltas)
    }
    return deltas
  }

  bumpSkill(layout, name, field) {
    const deltas = this.deltasFor(layout)
    const entry = deltas.skills.get(name) ?? { uses: 0, views: 0 }
    entry[field] += 1
    deltas.skills.set(name, entry)
  }

  async flush(layout) {
    const deltas = this.pending.get(layout.projectRoot)
    if (!deltas || (deltas.requests === 0 && deltas.toolCalls === 0 && deltas.skills.size === 0)) return null
    this.pending.delete(layout.projectRoot)
    return flushCounters({ layout, requests: deltas.requests, toolCalls: deltas.toolCalls, skills: deltas.skills, now: this.now() })
  }

  /** Skills other sources serve (hand-written, other plugins), by name with their description. */
  async externalSkills(cwd, owned) {
    const registry = this.ctx.get?.('skills') ?? this.ctx.skills
    if (!registry?.list) return new Map()
    try {
      const skills = await registry.list({ cwd })
      return new Map(skills.filter((skill) => !owned.has(skill.name)).map((skill) => [skill.name, String(skill.description ?? '')]))
    } catch {
      return new Map()
    }
  }

  // ------------------------------------------------------------------ events

  onSessionEvent(session, event) {
    try {
      const cwd = session?.header?.cwd
      if (!cwd) return
      const layout = this.layoutOf(cwd)
      const out = this.capture.observe(session, event)
      const id = out.state.sessionId
      this.sessionsById.set(id, session)
      if (out.skillUse) this.bumpSkill(layout, out.skillUse, 'uses')
      if (out.skillView) this.bumpSkill(layout, out.skillView, 'views')
      if (!out.state.topLevel) return
      if (out.turnStart) this.deltasFor(layout).requests += 1
      if (out.toolCall) this.deltasFor(layout).toolCalls += 1
      const paused = this.isPaused(layout)
      if (out.entry && !paused) this.persist(layout, id, out.entry)
      if (out.turnEnd) this.onTurnEnd(layout, session, out.state, paused)
    } catch (error) {
      this.logger.warn(`autoharness: capture failed: ${errorText(error)}`)
    }
  }

  onTurnEnd(layout, session, state, paused) {
    const route = resolveRoute(this.config, session)
    if (route) this.routes.set(state.sessionId, route)
    // Usage keeps counting while paused; only autonomous changes stop.
    // In-turn hosts already ran reflection, recovery, and consolidation in agent/turn-stopping.
    const background = !paused && !this.reflectsInTurn()
    this.track(this.flush(layout).then((states) => {
      if (background && route && this.consolidationDue(states?.project)) this.enqueue(layout, 'consolidation', (signal) => this.consolidateIfDue(layout, route, signal))
    }).catch((error) => {
      this.logger.warn(`autoharness: counter flush failed: ${errorText(error)}`)
    }))
    if (!background) return
    if (state.sinceReflect >= this.config.reflectEveryN) this.scheduleReflect(layout, state.sessionId, 'threshold')
    if (route && this.recoveryArmed.delete(layout.projectRoot)) this.enqueue(layout, 'episode recovery', (signal) => this.recover(layout, route, signal))
  }

  consolidationDue(projectState, pendingCalls = 0) {
    if (!projectState || this.config.consolidateEveryN === 0) return false
    return (projectState.toolCalls ?? 0) + pendingCalls - (projectState.lastConsolidateAt ?? 0) >= this.config.consolidateEveryN
  }

  /**
   * Consolidate when the project crossed `consolidateEveryN` tool calls since
   * the last pass. The mark moves before the model call, so a failing curator
   * waits for the next budget instead of retrying every turn.
   */
  async consolidateIfDue(layout, route, signal) {
    const pendingCalls = this.pending.get(layout.projectRoot)?.toolCalls ?? 0
    let due = false
    await updateProjectState(layout, (state) => {
      if (!this.consolidationDue(state, pendingCalls)) return state
      due = true
      return { ...state, lastConsolidateAt: (state.toolCalls ?? 0) + pendingCalls }
    })
    return due ? this.consolidate(layout, route, signal, 'consolidate') : null
  }

  async onAgentCreated({ agent, source }) {
    try {
      const session = agent?.session
      const cwd = session?.header?.cwd
      if (!cwd || !isTopLevel(session)) return
      const layout = this.layoutOf(cwd)
      for (const layer of LAYERS) if (layout.layers[layer]) ensureStateDir(layout.layers[layer])
      // Recall works even while paused: pausing stops learning and lifecycle changes, not loading.
      if (this.config.indexEnabled && source !== 'resume') {
        const requests = {}
        for (const layer of LAYERS) if (layout.layers[layer]) requests[layer] = readJsonSync(layout.layers[layer].stateFile, {})?.requests ?? 0
        const text = buildIndex([...ownedSkills(layout).values()], this.config, requests)
        if (text) agent.inject(this.createUserMessage({ content: [{ type: 'text', text }], source: SOURCE }))
      }
      if (this.isPaused(layout)) return
      this.track(runLifecycle({ layout, config: this.config, now: this.now() }).then((actions) => {
        for (const action of actions) this.logger.info?.(`autoharness: ${action.op} ${action.name} (${action.layer})${action.reason ? `: ${action.reason}` : ''}`)
        return pruneState({ layout, now: this.now() })
      }).catch((error) => this.logger.warn(`autoharness: lifecycle failed: ${errorText(error)}`)))
      this.recoveryArmed.add(layout.projectRoot)
    } catch (error) {
      // A throw here would fail agent creation; never let it escape.
      this.logger.warn(`autoharness: session start hook failed: ${errorText(error)}`)
    }
  }

  /**
   * In-turn reflection: `agent/turn-stopping` is awaited before the turn
   * closes, so a one-shot host (which exits once the agent is idle) keeps
   * running until the reflection and its evals are done. A one-shot session
   * ends with this turn, so its tail is due at `minEpisodeToolCalls`.
   */
  async onTurnStopping({ agent, signal }) {
    try {
      const session = agent?.session
      const id = session?.header?.id
      const cwd = session?.header?.cwd
      if (!id || !cwd || !isTopLevel(session) || !this.reflectsInTurn()) return
      const layout = this.layoutOf(cwd)
      const state = this.capture.sessions.get(id)
      if (!state || this.isPaused(layout)) return
      const oneShot = this.isOneShot()
      const due = Math.max(1, oneShot ? this.config.minEpisodeToolCalls : this.config.reflectEveryN)
      const route = resolveRoute(this.config, session)
      if (route) this.routes.set(id, route)
      if (state.sinceReflect >= due) await this.scheduleReflect(layout, id, oneShot ? 'session-end' : 'threshold', signal)
      if (!route) return
      // A one-shot process exits right after this turn: background work would die with it.
      if (this.recoveryArmed.delete(layout.projectRoot)) await this.enqueue(layout, 'episode recovery', (jobSignal) => this.recover(layout, route, jobSignal), signal).catch(() => {})
      await this.enqueue(layout, 'consolidation', (jobSignal) => this.consolidateIfDue(layout, route, jobSignal), signal).catch(() => {})
    } catch (error) {
      this.logger.warn(`autoharness: in-turn reflection failed: ${errorText(error)}`)
    }
  }

  onAgentDisposed({ agent }) {
    try {
      const session = agent?.session
      const id = session?.header?.id
      const cwd = session?.header?.cwd
      if (!id || !cwd) return
      const layout = this.layoutOf(cwd)
      const state = this.capture.sessions.get(id)
      this.track(this.flush(layout).catch(() => {}))
      if (state?.topLevel && !this.isPaused(layout) && state.sinceReflect >= this.config.minEpisodeToolCalls) {
        this.track(this.scheduleReflect(layout, id, 'session-end').finally(() => this.forget(id)))
      } else {
        this.forget(id)
      }
    } catch (error) {
      this.logger.warn(`autoharness: session end hook failed: ${errorText(error)}`)
    }
  }

  forget(id) {
    this.capture.drop(id)
    this.sessionsById.delete(id)
    this.routes.delete(id)
  }

  // -------------------------------------------------------------- pipelines

  scheduleReflect(layout, sessionId, trigger, extraSignal) {
    if (this.reflectQueued.has(sessionId)) return Promise.resolve(null)
    this.reflectQueued.add(sessionId)
    return this.track(this.enqueue(layout, `reflection (${trigger})`, (signal) => this.reflectSession(layout, sessionId, trigger, signal), extraSignal)
      .catch(() => null)
      .finally(() => this.reflectQueued.delete(sessionId)))
  }

  /**
   * Reflect on one live session's episode since its watermark.
   * @returns {Promise<{ skipped?: string, runId?: string, landed?: object[], rejected?: object[], evals?: object[] }>} outcome.
   */
  async reflectSession(layout, sessionId, trigger, signal) {
    const state = this.capture.sessions.get(sessionId)
    const episode = this.capture.episode(sessionId, this.config)
    if (!state || !episode) return { skipped: 'nothing captured since the last reflection' }
    if (trigger !== 'manual' && episode.toolCalls < this.config.minEpisodeToolCalls) return { skipped: `only ${episode.toolCalls} tool calls since the last reflection` }
    const route = resolveRoute(this.config, this.sessionsById.get(sessionId)) ?? this.routes.get(sessionId)
    if (!route) return { skipped: 'no model route is known for this session yet' }
    let outcome
    try {
      outcome = await this.reflectEpisode(layout, episode, route, trigger, signal)
    } catch (error) {
      // Back off: try again after another reflectEveryN calls, on the same entries.
      state.sinceReflect = 0
      if (!signal?.aborted) await recordFailedRun({ layout, run: { trigger, sessionId, route }, error, now: this.now() }).catch(() => {})
      throw error
    }
    this.capture.markReflected(sessionId, episode.toSeq)
    await this.persistWatermark(layout, sessionId, episode.toSeq)
    return outcome
  }

  async reflectEpisode(layout, episode, route, trigger, signal) {
    const owned = ownedSkills(layout)
    const external = await this.externalSkills(layout.projectRoot, owned)
    const intents = await reflect({
      llm: this.ctx.llm,
      route,
      signal,
      episode,
      owned: [...owned.values()],
      otherSkills: [...external].map(([name, description]) => ({ name, description })),
      config: this.config,
    })
    const result = await promote({
      intents,
      layout,
      config: this.config,
      episode,
      run: { trigger, sessionId: episode.sessionId, route },
      externalNames: new Set(external.keys()),
      now: this.now(),
    })
    this.report(result, trigger)
    const evals = this.config.evalOnPromote ? await this.evaluate(layout, result.landed.filter((l) => l.op !== 'archive').map((l) => l.name), route, signal) : []
    return { ...result, evals, ...(this.evalErrors(evals)) }
  }

  /** Eval failures never undo a promotion; they are reported next to it. */
  evalErrors(evals) {
    const errors = evals.filter((r) => r.error).map((r) => `${r.skill}: ${r.error}`)
    return errors.length ? { evalErrors: errors } : {}
  }

  report(result, trigger) {
    for (const item of result.landed) this.logger.info?.(`autoharness: ${trigger}: ${item.op} ${item.name} (${item.layer})`)
    for (const item of result.rejected) this.logger.info?.(`autoharness: ${trigger}: rejected ${item.op} ${item.name ?? ''}: ${item.errors.join('; ')}`)
  }

  /**
   * Run eval cases for the named skills (all self-authored skills when `names` is null).
   * @returns {Promise<object[]>} eval results.
   */
  async evaluate(layout, names, route, signal) {
    if (names && names.length === 0) return []
    const owned = ownedSkills(layout)
    const targets = names ? names.map((name) => owned.get(name)).filter(Boolean) : [...owned.values()]
    const runId = newId(this.now())
    const results = []
    const effort = this.config.evalEffort === 'low' ? await lightEffort(this.ctx.llm, route, signal) : undefined
    for (const skill of targets) {
      try {
        const cases = await readEvalCases(skill.dir)
        const raw = await evalSkill({ llm: this.ctx.llm, route, skill, cases, signal, effort })
        if (!raw) continue
        const result = scoreResult(raw, await readLabels(skill.dir))
        await withLayersLock(layout, () => recordEval({ skillDir: skill.dir, dirs: layout.layers[skill.layer], result, runId, config: this.config, now: this.now() }))
        results.push(result)
      } catch (error) {
        if (signal?.aborted) throw error
        // One skill's failed eval must not stop the others or undo what already landed.
        this.logger.warn(`autoharness: eval of ${skill.name} failed: ${errorText(error)}`)
        results.push({ skill: skill.name, error: errorText(error) })
      }
    }
    const scored = results.filter((r) => !r.error)
    if (scored.length > 0) await writeReport(layout.layers.project, runId, scored)
    return results
  }

  async consolidate(layout, route, signal, trigger) {
    const owned = ownedSkills(layout)
    const intents = await curate({ llm: this.ctx.llm, route, owned: [...owned.values()], config: this.config, signal })
    if (intents.length === 0) return { runId: null, landed: [], rejected: [], evals: [] }
    const result = await promote({ intents, layout, config: this.config, episode: null, run: { trigger, route }, now: this.now() })
    this.report(result, trigger)
    const evals = this.config.evalOnPromote ? await this.evaluate(layout, result.landed.filter((l) => l.op === 'merge').map((l) => l.name), route, signal) : []
    return { ...result, evals, ...(this.evalErrors(evals)) }
  }

  /** Reflect on idle episode logs that no live session owns, then prune old logs. */
  async recover(layout, route, signal) {
    const dir = layout.layers.project.episodes
    let names
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return []
    }
    const live = new Set([...this.capture.sessions.keys()].map(fileSafe))
    const outcomes = []
    for (const name of names) {
      const base = name.slice(0, -'.jsonl'.length)
      if (live.has(base)) continue
      const file = join(dir, name)
      const metaFile = join(dir, `${base}.meta.json`)
      const age = this.now() - statSync(file).mtimeMs
      if (age < RECOVERY_IDLE_MS) continue
      const meta = await readJson(metaFile, {})
      const entries = (await readJsonl(file)).filter((entry) => entry.seq > (meta.reflectedUpTo ?? -1))
      const calls = entries.filter((entry) => entry.kind === 'call').length
      if (calls >= this.config.minEpisodeToolCalls) {
        const episode = buildEpisode(meta.sessionId ?? base, entries, this.config)
        outcomes.push(await this.reflectEpisode(layout, episode, route, 'recovery', signal))
        await writeJson(metaFile, { ...meta, sessionId: episode.sessionId, reflectedUpTo: entries[entries.length - 1].seq, updatedAt: new Date(this.now()).toISOString() })
      } else if (age > EPISODE_RETENTION_MS || calls === 0) {
        await unlink(file).catch(() => {})
        await unlink(metaFile).catch(() => {})
      }
    }
    return outcomes
  }

  // ---------------------------------------------------------------- commands

  /** `/learn`: reflect on the invoking session right now. */
  async learn(agent, signal) {
    const session = agent?.session
    const id = session?.header?.id
    const cwd = session?.header?.cwd
    if (!id || !cwd) throw new Error('/learn needs a session with a working directory')
    const layout = this.layoutOf(cwd)
    if (this.isPaused(layout)) throw new Error('autoharness is paused; run /autoharness resume first')
    this.sessionsById.set(id, session)
    return this.enqueue(layout, 'manual reflection', (jobSignal) => this.reflectSession(layout, id, 'manual', jobSignal), signal)
  }

  async evalCommand(agent, name, signal) {
    const session = agent?.session
    const cwd = session?.header?.cwd
    if (!cwd) throw new Error('eval needs a session with a working directory')
    const layout = this.layoutOf(cwd)
    const route = resolveRoute(this.config, session)
    if (!route) throw new Error('no model route is known for this session yet; send one message first')
    const results = await this.enqueue(layout, 'eval', (jobSignal) => this.evaluate(layout, name ? [name] : null, route, jobSignal), signal)
    return { results, report: join(layout.layers.project.state, 'evals', 'report.md') }
  }

  async curateCommand(agent, signal) {
    const session = agent?.session
    const cwd = session?.header?.cwd
    if (!cwd) throw new Error('curate needs a session with a working directory')
    const layout = this.layoutOf(cwd)
    const route = resolveRoute(this.config, session)
    if (!route) throw new Error('no model route is known for this session yet; send one message first')
    return this.enqueue(layout, 'manual consolidation', (jobSignal) => this.consolidate(layout, route, jobSignal, 'manual-curate'), signal)
  }

  /**
   * Build the grader review page from each skill's latest eval result.
   * @returns {Promise<{ path: string, skills: number, answers: number }>} where the page was written.
   */
  async review(agent, name) {
    const cwd = agent?.session?.header?.cwd
    if (!cwd) throw new Error('review needs a session with a working directory')
    const layout = this.layoutOf(cwd)
    const owned = ownedSkills(layout)
    const targets = name ? [owned.get(name)].filter(Boolean) : [...owned.values()]
    const skills = []
    let answers = 0
    for (const skill of targets) {
      const raw = await latestResult(layout.layers[skill.layer], skill.name, skill.sidecar.eval?.run)
      if (!raw) continue
      const labels = await readLabels(skill.dir)
      const scored = scoreResult(raw, labels)
      const cases = []
      for (const item of scored.cases) {
        let evidenceText = ''
        if (item.evidence) evidenceText = await readFile(join(skill.dir, item.evidence), 'utf8').catch(() => '')
        cases.push({ ...item, evidenceText: evidenceText.slice(0, 8000) })
        answers += item.checks.length * 2
      }
      skills.push({ skill: skill.name, layer: skill.layer, run: raw.runId, description: skill.description, body: skill.body, cases, labels: latestLabels(labels), graders: scored.graders })
    }
    if (skills.length === 0) throw new Error(name ? `no eval result for "${name}" yet; run /autoharness eval ${name} first` : 'no eval results yet; run /autoharness eval first')
    const path = join(layout.layers.project.state, 'evals', 'review.html')
    await atomicWrite(path, renderReviewPage({ project: layout.projectRoot, generatedAt: new Date(this.now()).toISOString(), skills }))
    return { path, skills: skills.length, answers }
  }

  /**
   * Import labels exported from the review page, then rescore the affected
   * skills from their latest results without calling the model.
   * @returns {Promise<object[]>} per-skill outcome.
   */
  async importLabels(agent, file) {
    const cwd = agent?.session?.header?.cwd
    if (!cwd) throw new Error('labels needs a session with a working directory')
    if (!file) throw new Error('usage: /autoharness labels <exported-labels.json>')
    const layout = this.layoutOf(cwd)
    const path = isAbsolute(file) ? file : resolve(cwd, file)
    let value
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      throw new Error(`cannot read ${relative(cwd, path) || path}: ${errorText(error)}`)
    }
    const labels = parseLabelExport(value)
    const bySkill = new Map()
    for (const label of labels) bySkill.set(label.skill, [...(bySkill.get(label.skill) ?? []), label])
    const outcomes = []
    for (const [name, items] of bySkill) {
      const outcome = await withLayersLock(layout, async () => {
        const skill = ownedSkills(layout).get(name)
        if (!skill) return { skill: name, skipped: 'not a live autoharness skill' }
        await appendLabels(skill.dir, items, this.now())
        const raw = await latestResult(layout.layers[skill.layer], name, skill.sidecar.eval?.run)
        if (!raw) return { skill: name, added: items.length }
        const scored = scoreResult(raw, await readLabels(skill.dir))
        await recordEval({ skillDir: skill.dir, dirs: layout.layers[skill.layer], result: { ...scored, rescored: true }, runId: raw.runId, config: this.config, now: this.now() })
        return { skill: name, added: items.length, passRate: scored.passRate, baseline: scored.baseline, graders: scored.graders }
      })
      outcomes.push(outcome)
    }
    return outcomes
  }

  async status(agent) {
    const cwd = agent?.session?.header?.cwd
    if (!cwd) throw new Error('status needs a session with a working directory')
    const layout = this.layoutOf(cwd)
    const skills = [...ownedSkills(layout).values()]
    const states = {}
    for (const layer of LAYERS) if (layout.layers[layer]) states[layer] = await readJson(layout.layers[layer].stateFile, {})
    const lastRun = await readJson(join(layout.layers.project.state, 'last_run.json'), null)
    const state = this.capture.sessions.get(agent.session.header.id)
    return { layout, skills, states, lastRun, paused: this.isPaused(layout), sinceReflect: state?.sinceReflect ?? 0 }
  }

  async setPaused(agent, paused) {
    const cwd = agent?.session?.header?.cwd
    if (!cwd) throw new Error('pause/resume needs a session with a working directory')
    const layout = this.layoutOf(cwd)
    await updateProjectState(layout, (state) => ({ ...state, paused }))
    this.pausedCache.delete(layout.projectRoot)
  }

  async archive(agent, name) {
    const layout = this.layoutOf(agent?.session?.header?.cwd ?? process.cwd())
    return archiveByName({ layout, name, reason: 'archived by user', now: this.now() })
  }

  async revive(agent, name) {
    const layout = this.layoutOf(agent?.session?.header?.cwd ?? process.cwd())
    return reviveSkill({ layout, name, now: this.now() })
  }

  // ---------------------------------------------------------------- teardown

  /** Resolve once no background work (writes, reflections, evals) remains. */
  async whenIdle() {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
  }

  /**
   * Teardown: flush counters, give in-flight reflections and evals up to
   * `drainTimeoutMs` to finish (one-shot hosts such as `dsh headless` exit
   * right after the answer), then abort whatever is left and wait for it.
   */
  async dispose() {
    await Promise.allSettled([...this.pending.values()].map((deltas) => this.flush(deltas.layout)))
    if (this.inflight.size > 0 && this.config.drainTimeoutMs > 0) {
      let timer
      const deadline = new Promise((done) => {
        timer = setTimeout(done, this.config.drainTimeoutMs)
      })
      await Promise.race([this.whenIdle(), deadline])
      clearTimeout(timer)
    }
    this.lifecycle.abort(new Error('autoharness disposed'))
    await this.whenIdle()
  }
}
