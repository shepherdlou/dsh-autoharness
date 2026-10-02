/**
 * MNG: daemon-free lifecycle. Runs lazily when a session starts.
 *
 * - Probation: a new skill cannot be evicted until its layer has served
 *   `maturity*` requests since the skill was created. At that point it
 *   graduates, unless it was never used and never viewed, in which case it is
 *   archived.
 * - Capacity: once mature skills outnumber `capacity*`, the lowest-scoring ones
 *   are archived. Score = usage rate x (0.5 + 0.5 x eval pass rate).
 * - Archived skills move out of the skill root and can be revived. Nothing is
 *   ever deleted.
 *
 * @module dsh-autoharness/lifecycle
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LAYERS } from './paths.js'
import { archiveSkill, withLayersLock } from './promoter.js'
import {
  LEDGER, SIDECAR, appendJsonl, findArchived, listOwnedSkills, moveDir, newId, readJson,
  readOwnedSkill, removeDir, skillExistsIn, writeJson,
} from './store.js'

/** Loads per request since creation. */
export function usageRate(sidecar, requests) {
  const age = Math.max(1, requests - (sidecar.createdAtRequest ?? 0))
  return (sidecar.uses ?? 0) / age
}

/**
 * Survival score used for capacity eviction; skills without evals count as
 * passing, and an agentic replay outranks the one-shot eval when present.
 */
export function survivalScore(sidecar, requests) {
  const agentic = sidecar.eval?.agentic?.passRate
  const passRate = typeof agentic === 'number' ? agentic : typeof sidecar.eval?.passRate === 'number' ? sidecar.eval.passRate : 1
  return usageRate(sidecar, requests) * (0.5 + 0.5 * passRate)
}

function limitsFor(layer, config) {
  return layer === 'project'
    ? { maturity: config.maturityProject, capacity: config.capacityProject }
    : { maturity: config.maturityGlobal, capacity: config.capacityGlobal }
}

/**
 * Graduate, evict, and archive across layers.
 * @param {{ layout: object, config: Readonly<object>, now?: number }} options - inputs.
 * @returns {Promise<object[]>} the actions taken.
 */
export async function runLifecycle({ layout, config, now = Date.now() }) {
  return withLayersLock(layout, async () => {
    const run = { id: newId(now) }
    const actions = []
    for (const layer of LAYERS) {
      const dirs = layout.layers[layer]
      if (!dirs) continue
      const requests = (await readJson(dirs.stateFile, {})).requests ?? 0
      const { maturity, capacity } = limitsFor(layer, config)
      const skills = listOwnedSkills(dirs.skills, layer)
      const mature = []
      for (const skill of skills) {
        const sidecar = skill.sidecar
        if (sidecar.status === 'mature') {
          mature.push(skill)
          continue
        }
        if (requests - (sidecar.createdAtRequest ?? 0) < maturity) continue
        if ((sidecar.uses ?? 0) === 0 && (sidecar.views ?? 0) === 0) {
          if (config.graduationSuspended) continue
          const reason = `never loaded or viewed in ${maturity} requests of probation`
          await archiveSkill(skill, dirs, { run, reason, now })
          actions.push({ op: 'archive', name: skill.name, layer, reason })
          continue
        }
        const next = { ...sidecar, status: 'mature', maturedAt: new Date(now).toISOString() }
        await writeJson(join(skill.dir, SIDECAR), next)
        await appendJsonl(join(skill.dir, LEDGER), { at: new Date(now).toISOString(), run: run.id, op: 'graduate', reason: `survived probation with ${sidecar.uses ?? 0} uses` })
        mature.push({ ...skill, sidecar: next })
        actions.push({ op: 'graduate', name: skill.name, layer })
      }
      if (!config.graduationSuspended && mature.length > capacity) {
        const ranked = [...mature].sort((a, b) => survivalScore(a.sidecar, requests) - survivalScore(b.sidecar, requests) || a.name.localeCompare(b.name))
        for (const skill of ranked.slice(0, mature.length - capacity)) {
          const reason = `capacity ${capacity} exceeded; lowest survival score ${survivalScore(skill.sidecar, requests).toFixed(4)}`
          await archiveSkill(skill, dirs, { run, reason, now })
          actions.push({ op: 'archive', name: skill.name, layer, reason })
        }
      }
    }
    if (actions.length > 0) {
      const record = { id: run.id, at: new Date(now).toISOString(), trigger: 'lifecycle', actions }
      await writeJson(join(layout.layers.project.runs, `${run.id}.json`), record)
    }
    return actions
  })
}

/**
 * Apply batched counter deltas: requests and tool calls per layer state, and
 * uses/views per self-authored skill.
 * @param {object} options - inputs.
 * @param {object} options.layout - project layout.
 * @param {number} options.requests - top-level turns started since the last flush.
 * @param {number} options.toolCalls - top-level tool calls since the last flush.
 * @param {Map<string, { uses: number, views: number }>} options.skills - per-skill deltas.
 * @param {number} [options.now] - clock.
 * @returns {Promise<{ project: object, global?: object }>} the updated layer states.
 */
export async function flushCounters({ layout, requests, toolCalls, skills, now = Date.now() }) {
  return withLayersLock(layout, async () => {
    const states = {}
    for (const layer of LAYERS) {
      const dirs = layout.layers[layer]
      if (!dirs) continue
      const state = await readJson(dirs.stateFile, {})
      state.requests = (state.requests ?? 0) + requests
      state.toolCalls = (state.toolCalls ?? 0) + toolCalls
      if (requests || toolCalls) await writeJson(dirs.stateFile, state)
      states[layer] = state
    }
    for (const [name, delta] of skills) {
      for (const layer of LAYERS) {
        const dirs = layout.layers[layer]
        if (!dirs) continue
        const skill = readOwnedSkill(join(dirs.skills, name))
        if (!skill) continue
        await writeJson(join(skill.dir, SIDECAR), {
          ...skill.sidecar,
          uses: (skill.sidecar.uses ?? 0) + delta.uses,
          views: (skill.sidecar.views ?? 0) + delta.views,
          ...(delta.uses > 0 ? { lastUsedAt: new Date(now).toISOString() } : {}),
        })
        break
      }
    }
    return states
  })
}

/** Read-modify-write the project state under the lock. */
export async function updateProjectState(layout, mutate) {
  return withLayersLock(layout, async () => {
    const file = layout.layers.project.stateFile
    const state = await readJson(file, {})
    const next = mutate(state) ?? state
    if (next !== state) await writeJson(file, next)
    return next
  })
}

/**
 * Archive one self-authored skill on request.
 * @returns {Promise<string>} a human-readable outcome.
 */
export async function archiveByName({ layout, name, reason, now = Date.now() }) {
  return withLayersLock(layout, async () => {
    for (const layer of LAYERS) {
      const dirs = layout.layers[layer]
      if (!dirs) continue
      const skill = readOwnedSkill(join(dirs.skills, name))
      if (!skill) continue
      const run = { id: newId(now) }
      await archiveSkill(skill, dirs, { run, reason, now })
      return `Archived ${name} (${layer}).`
    }
    throw new Error(`no live autoharness skill named "${name}"`)
  })
}

/**
 * Bring the latest archived copy of a skill back. It restarts probation so
 * it has to earn its place again.
 * @returns {Promise<string>} a human-readable outcome.
 */
export async function reviveSkill({ layout, name, now = Date.now() }) {
  return withLayersLock(layout, async () => {
    for (const layer of LAYERS) {
      const dirs = layout.layers[layer]
      if (!dirs) continue
      const [latest] = findArchived(dirs.archive, name)
      if (!latest) continue
      if (skillExistsIn(dirs.skills, name)) throw new Error(`a live skill named "${name}" already exists in the ${layer} layer`)
      const requests = (await readJson(dirs.stateFile, {})).requests ?? 0
      const live = join(dirs.skills, name)
      await moveDir(latest.path, live)
      const skill = readOwnedSkill(live)
      const sidecar = { ...(skill?.sidecar ?? {}), status: 'probation', createdAtRequest: requests, archivedAt: undefined, archiveReason: undefined }
      await writeJson(join(live, SIDECAR), sidecar)
      await appendJsonl(join(live, LEDGER), { at: new Date(now).toISOString(), run: newId(now), op: 'revive', reason: 'revived by user' })
      return `Revived ${name} into the ${layer} layer (probation restarted).`
    }
    throw new Error(`no archived skill named "${name}"`)
  })
}

/** How much of the ever-growing state to keep. Archived skills are never pruned. */
export const RETENTION = Object.freeze({ runs: 200, evalLogs: 50, snapshotDays: 30, stagingHours: 24 })

async function entries(dir, filter) {
  try {
    return (await readdir(dir)).filter(filter).sort()
  } catch {
    return []
  }
}

/**
 * Prune run records, eval logs and reports, old snapshots, and staging
 * leftovers. Eval logs a live skill still points at are kept, so the review
 * page can always rebuild from them.
 * @param {{ layout: object, now?: number }} options - inputs.
 * @returns {Promise<number>} number of entries removed.
 */
export async function pruneState({ layout, now = Date.now() }) {
  return withLayersLock(layout, async () => {
    let removed = 0
    const drop = async (path) => {
      await removeDir(path)
      removed += 1
    }
    for (const layer of LAYERS) {
      const dirs = layout.layers[layer]
      if (!dirs) continue
      const referenced = new Set(listOwnedSkills(dirs.skills, layer).map((skill) => skill.sidecar.eval?.run).filter(Boolean).map((run) => `${run}.jsonl`))
      const runs = await entries(dirs.runs, (name) => name.endsWith('.json'))
      for (const name of runs.slice(0, Math.max(0, runs.length - RETENTION.runs))) await drop(join(dirs.runs, name))
      const logs = await entries(dirs.evalResults, (name) => name.endsWith('.jsonl'))
      for (const name of logs.slice(0, Math.max(0, logs.length - RETENTION.evalLogs))) if (!referenced.has(name)) await drop(join(dirs.evalResults, name))
      const reportsDir = join(dirs.evalResults, '..')
      const reports = await entries(reportsDir, (name) => name.startsWith('report-') && name.endsWith('.md'))
      for (const name of reports.slice(0, Math.max(0, reports.length - RETENTION.evalLogs))) await drop(join(reportsDir, name))
      for (const [dir, maxAge] of [[dirs.snapshots, RETENTION.snapshotDays * 86_400_000], [dirs.staging, RETENTION.stagingHours * 3_600_000]]) {
        for (const name of await entries(dir, () => true)) {
          const info = await stat(join(dir, name)).catch(() => null)
          if (info && now - info.mtimeMs > maxAge) await drop(join(dir, name))
        }
      }
    }
    return removed
  })
}
