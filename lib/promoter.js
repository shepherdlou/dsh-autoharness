/**
 * Promoter: the only component that writes skill trees. It lints every intent,
 * builds the new skill in a staging directory, snapshots what it replaces, and
 * swaps the result in with renames so the skill catalog never observes a
 * half-written bundle. Rejections are recorded, never partially applied.
 *
 * @module dsh-autoharness/promoter
 */
import { readdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { lintIntent, sanitizeEvals } from './lint.js'
import { LAYERS, ensureStateDir } from './paths.js'
import { redact, redactDeep } from './redact.js'
import { renderSkill } from './skillfile.js'
import {
  LEDGER, OWNER, SIDECAR, appendJsonl, atomicWrite, copyDir, listOwnedSkills, moveDir, newId,
  readJson, readOwnedSkill, removeDir, skillExistsIn, withLock, writeJson,
} from './store.js'
import { renderTranscript } from './transcript.js'

/** Run `fn` holding every layer's lock, in a fixed order so processes cannot deadlock. */
export function withLayersLock(layout, fn) {
  const names = LAYERS.filter((layer) => layout.layers[layer])
  const step = (i) => (i === names.length ? fn() : withLock(layout.layers[names[i]].lock, () => step(i + 1)))
  for (const layer of names) ensureStateDir(layout.layers[layer])
  return step(0)
}

function countEvalFiles(dir) {
  try {
    return readdirSync(join(dir, 'evals')).filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}

/**
 * Every self-authored live skill across layers; a project skill shadows a
 * global one with the same name.
 * @param {ReturnType<import('./paths.js').layoutFor>} layout - project layout.
 * @returns {Map<string, object>} skills by name.
 */
export function ownedSkills(layout) {
  const owned = new Map()
  for (const layer of LAYERS) {
    const dirs = layout.layers[layer]
    if (!dirs) continue
    for (const skill of listOwnedSkills(dirs.skills, layer)) {
      if (!owned.has(skill.name)) owned.set(skill.name, { ...skill, evalCount: countEvalFiles(skill.dir) })
    }
  }
  return owned
}

/** Build the foreign-name predicate: other roots on disk plus the live registry catalog. */
export function foreignNamePredicate(layout, externalNames = new Set()) {
  const roots = [...LAYERS.map((layer) => layout.layers[layer]?.skills).filter(Boolean), ...layout.foreignRoots]
  return (name) => externalNames.has(name) || roots.some((root) => skillExistsIn(root, name))
}

function freshSidecar({ name, layer, category, now, createdAtRequest }) {
  return {
    owner: OWNER,
    version: 1,
    name,
    layer,
    category,
    createdAt: new Date(now).toISOString(),
    createdAtRequest,
    status: 'probation',
    uses: 0,
    views: 0,
    patches: 0,
    lastUsedAt: null,
    eval: null,
    needsPatch: false,
    evalFailures: [],
  }
}

async function writeEvidence(dir, { run, episode, evidence, reason, now }) {
  if (!episode || !evidence) return undefined
  const id = newId(now)
  const rel = `references/evidence-${id}.md`
  const slice = episode.entries.filter((entry) => entry.seq >= evidence.fromSeq && entry.seq <= evidence.toSeq)
  const text = [
    `# Evidence ${id}`,
    '',
    `- run: \`${run.id}\``,
    `- session: \`${episode.sessionId}\``,
    `- seq: ${evidence.fromSeq}..${evidence.toSeq}`,
    `- reason: ${redact(reason).replace(/\n/g, ' ')}`,
    '',
    '```text',
    renderTranscript(slice).replace(/```/g, "'''"),
    '```',
    '',
  ].join('\n')
  await atomicWrite(join(dir, rel), text)
  return rel
}

async function writeEvalCases(dir, { name, evals, run, evidenceRel, now }) {
  const ids = []
  for (const item of evals ?? []) {
    const id = newId(now)
    const value = {
      id,
      skill: name,
      createdAt: new Date(now).toISOString(),
      run: run.id,
      task: item.task,
      checks: item.checks.map((check, i) => ({ id: `c${i + 1}`, ...check })),
      ...(evidenceRel ? { evidence: evidenceRel } : {}),
    }
    await writeJson(join(dir, 'evals', `case-${id}.json`), redactDeep(value))
    ids.push(id)
  }
  return ids
}

function ledgerEntry(op, { run, reason, now, ...rest }) {
  return { at: new Date(now).toISOString(), run: run.id, op, reason: redact(reason ?? ''), ...rest }
}

function renderFor(name, layer, category, { description, whenToUse, body }) {
  return renderSkill({
    name,
    description: description.trim(),
    ...(whenToUse ? { whenToUse: whenToUse.trim() } : {}),
    metadata: { autoharness: { version: 1, layer, category } },
    body,
  })
}

/** Replace a live skill directory with a staged one, keeping a snapshot. */
async function swapIn(live, staged, snapshot) {
  await moveDir(live, snapshot)
  try {
    await moveDir(staged, live)
  } catch (error) {
    await moveDir(snapshot, live).catch(() => {})
    throw error
  }
}

/**
 * Archive one live self-authored skill: ledger + sidecar update, then move it
 * out of the skill root into the layer's archive (never deleted).
 */
export async function archiveSkill(skill, dirs, { run, reason, now }) {
  await appendJsonl(join(skill.dir, LEDGER), ledgerEntry('archive', { run, reason, now }))
  const sidecar = { ...skill.sidecar, status: 'archived', archivedAt: new Date(now).toISOString(), archiveReason: reason }
  await writeJson(join(skill.dir, SIDECAR), sidecar)
  const target = join(dirs.archive, `${skill.name}--${run.id}`)
  await moveDir(skill.dir, target)
  return target
}

async function applyCreate(intent, ctx) {
  const { layout, run, episode, now, requests } = ctx
  const layer = intent.scope ?? 'project'
  const dirs = layout.layers[layer]
  const category = intent.category ?? 'general'
  const staged = join(dirs.staging, run.id, intent.name)
  await removeDir(staged)
  const evidenceRel = await writeEvidence(staged, { run, episode, evidence: intent.evidence, reason: intent.reason, now })
  await writeEvalCases(staged, { name: intent.name, evals: intent.evals, run, evidenceRel, now })
  await atomicWrite(join(staged, 'SKILL.md'), renderFor(intent.name, layer, category, intent))
  await writeJson(join(staged, SIDECAR), freshSidecar({ name: intent.name, layer, category, now, createdAtRequest: requests[layer] ?? 0 }))
  await appendJsonl(join(staged, LEDGER), ledgerEntry('create', { run, reason: intent.reason, now, session: episode?.sessionId, evidence: evidenceRel }))
  const live = join(dirs.skills, intent.name)
  await moveDir(staged, live)
  return { op: 'create', name: intent.name, layer, dir: live }
}

async function applyPatch(intent, ctx) {
  const { layout, run, episode, now, owned } = ctx
  const skill = owned.get(intent.name)
  const dirs = layout.layers[skill.layer]
  const staged = join(dirs.staging, run.id, intent.name)
  await removeDir(staged)
  await copyDir(skill.dir, staged)
  // The old cases stay in the snapshot; labels keep their history.
  if (intent.replaceEvals === true) for (const name of await readdir(join(staged, 'evals')).catch(() => [])) if (name.startsWith('case-')) await removeDir(join(staged, 'evals', name))
  const category = skill.sidecar.category ?? 'general'
  const evidenceRel = await writeEvidence(staged, { run, episode, evidence: intent.evidence, reason: intent.reason, now })
  await writeEvalCases(staged, { name: intent.name, evals: intent.evals, run, evidenceRel, now })
  await atomicWrite(join(staged, 'SKILL.md'), renderFor(intent.name, skill.layer, category, {
    description: intent.description ?? skill.description,
    whenToUse: intent.whenToUse ?? skill.whenToUse,
    body: intent.body ?? skill.body,
  }))
  await writeJson(join(staged, SIDECAR), { ...skill.sidecar, patches: (skill.sidecar.patches ?? 0) + 1, needsPatch: false, evalFailures: [], ...(intent.replaceEvals === true ? { eval: null } : {}) })
  await appendJsonl(join(staged, LEDGER), ledgerEntry('patch', { run, reason: intent.reason, now, session: episode?.sessionId, evidence: evidenceRel, ...(intent.replaceEvals === true ? { replacedEvals: true } : {}) }))
  await swapIn(skill.dir, staged, join(dirs.snapshots, run.id, intent.name))
  return { op: 'patch', name: intent.name, layer: skill.layer, dir: skill.dir }
}

async function copyResources(from, staged, prefix) {
  for (const sub of ['evals', 'references']) {
    let names
    try {
      names = await readdir(join(from, sub))
    } catch {
      continue
    }
    for (const name of names) {
      const target = sub === 'evals' ? name : `${prefix}-${name}`
      await copyDir(join(from, sub, name), join(staged, sub, target))
    }
  }
}

async function applyMerge(intent, ctx) {
  const { layout, run, now, owned } = ctx
  const sources = intent.from.map((name) => owned.get(name))
  const existing = owned.get(intent.into)
  const layer = existing?.layer ?? intent.scope ?? sources[0].layer
  const dirs = layout.layers[layer] ?? layout.layers.project
  const category = intent.category ?? existing?.sidecar.category ?? sources[0].sidecar.category ?? 'general'
  const staged = join(dirs.staging, run.id, intent.into)
  await removeDir(staged)
  let sidecar
  if (existing) {
    await copyDir(existing.dir, staged)
    sidecar = { ...existing.sidecar, patches: (existing.sidecar.patches ?? 0) + 1 }
  } else {
    sidecar = freshSidecar({
      name: intent.into,
      layer,
      category,
      now,
      createdAtRequest: Math.min(...sources.map((s) => s.sidecar.createdAtRequest ?? 0)),
    })
    sidecar.status = sources.some((s) => s.sidecar.status === 'mature') ? 'mature' : 'probation'
  }
  for (const source of sources) {
    await copyResources(source.dir, staged, source.name)
    sidecar.uses = (sidecar.uses ?? 0) + (source.sidecar.uses ?? 0)
    sidecar.views = (sidecar.views ?? 0) + (source.sidecar.views ?? 0)
  }
  sidecar = { ...sidecar, category, needsPatch: false, evalFailures: [], eval: null }
  await writeEvalCases(staged, { name: intent.into, evals: intent.evals, run, now })
  await atomicWrite(join(staged, 'SKILL.md'), renderFor(intent.into, layer, category, intent))
  await writeJson(join(staged, SIDECAR), sidecar)
  await appendJsonl(join(staged, LEDGER), ledgerEntry('merge', { run, reason: intent.reason, now, from: intent.from }))
  const live = join(dirs.skills, intent.into)
  if (existing) await swapIn(existing.dir, staged, join(dirs.snapshots, run.id, intent.into))
  else await moveDir(staged, live)
  for (const source of sources) {
    const sourceDirs = layout.layers[source.layer]
    await copyDir(source.dir, join(sourceDirs.snapshots, run.id, source.name))
    const current = readOwnedSkill(source.dir)
    await archiveSkill({ ...source, sidecar: current?.sidecar ?? source.sidecar }, sourceDirs, { run, reason: `merged into ${intent.into}: ${intent.reason}`, now })
  }
  return { op: 'merge', name: intent.into, layer, dir: live, from: intent.from }
}

async function applyArchive(intent, ctx) {
  const { layout, run, now, owned } = ctx
  const skill = owned.get(intent.name)
  const dirs = layout.layers[skill.layer]
  await copyDir(skill.dir, join(dirs.snapshots, run.id, intent.name))
  await archiveSkill(skill, dirs, { run, reason: intent.reason, now })
  return { op: 'archive', name: intent.name, layer: skill.layer }
}

const APPLY = { create: applyCreate, patch: applyPatch, merge: applyMerge, archive: applyArchive }

/**
 * Record a run that failed before anything could land, so `status` and
 * `last_run.json` show the failure instead of the previous success.
 */
export async function recordFailedRun({ layout, run, error, now = Date.now() }) {
  const id = run.id ?? newId(now)
  const record = redactDeep({
    id,
    at: new Date(now).toISOString(),
    trigger: run.trigger,
    sessionId: run.sessionId,
    route: run.route,
    error: error instanceof Error ? error.message : String(error),
    landed: [],
    rejected: [],
    none: [],
  })
  await withLayersLock(layout, async () => {
    await writeJson(join(layout.layers.project.runs, `${id}.json`), record)
    await writeJson(join(layout.layers.project.state, 'last_run.json'), record)
  })
  return record
}

/**
 * Lint and apply a batch of intents.
 * @param {object} options - promotion inputs.
 * @param {object[]} options.intents - proposals from the reflector or curator.
 * @param {ReturnType<import('./paths.js').layoutFor>} options.layout - project layout.
 * @param {Readonly<object>} options.config - effective configuration.
 * @param {{ sessionId: string, fromSeq: number, toSeq: number, entries: object[] } | null} options.episode - the episode evidence must come from; null for curator runs.
 * @param {{ id?: string, trigger: string, sessionId?: string, route?: object }} options.run - run metadata.
 * @param {Set<string>} [options.externalNames] - names the live skill registry already serves.
 * @param {number} [options.now] - clock for deterministic tests.
 * @returns {Promise<{ runId: string, landed: object[], rejected: object[] }>} what landed and what was rejected, with reasons.
 */
export async function promote({ intents, layout, config, episode, run, externalNames, now = Date.now() }) {
  const runMeta = { ...run, id: run.id ?? newId(now) }
  return withLayersLock(layout, async () => {
    const requests = {}
    for (const layer of LAYERS) {
      if (!layout.layers[layer]) continue
      requests[layer] = (await readJson(layout.layers[layer].stateFile, {})).requests ?? 0
    }
    const landed = []
    const rejected = []
    const warnings = []
    const claimed = new Set()
    const touched = new Set()
    const actionable = (intents ?? []).filter((intent) => intent?.op !== 'none')
    for (const [i, proposed] of actionable.entries()) {
      const { intent, warnings: dropped } = sanitizeEvals(proposed)
      const label = { op: intent?.op, name: intent?.name ?? intent?.into }
      for (const warning of dropped) warnings.push(`${label.op} ${label.name}: ${warning}`)
      if (i >= config.maxIntentsPerRun) {
        rejected.push({ ...label, errors: [`over the per-run limit of ${config.maxIntentsPerRun} intents`] })
        continue
      }
      const owned = ownedSkills(layout)
      const errors = lintIntent(intent, { config, owned, isTaken: foreignNamePredicate(layout, externalNames), episode, claimed })
      const names = [intent.name, intent.into, ...(intent.from ?? [])].filter(Boolean)
      if (errors.length === 0 && names.some((name) => touched.has(name))) errors.push('a skill may change at most once per run')
      if (errors.length > 0) {
        rejected.push({ ...label, errors })
        continue
      }
      try {
        landed.push(await APPLY[intent.op](intent, { layout, run: runMeta, episode, now, owned, requests }))
        for (const name of names) touched.add(name)
        if (intent.op === 'create') claimed.add(intent.name)
        if (intent.op === 'merge') claimed.add(intent.into)
      } catch (error) {
        rejected.push({ ...label, errors: [`write failed: ${error instanceof Error ? error.message : String(error)}`] })
      }
    }
    for (const layer of LAYERS) if (layout.layers[layer]) await removeDir(join(layout.layers[layer].staging, runMeta.id))
    const record = redactDeep({
      id: runMeta.id,
      at: new Date(now).toISOString(),
      trigger: runMeta.trigger,
      sessionId: runMeta.sessionId,
      route: runMeta.route,
      episode: episode ? { sessionId: episode.sessionId, fromSeq: episode.fromSeq, toSeq: episode.toSeq } : null,
      proposed: intents?.length ?? 0,
      none: (intents ?? []).filter((intent) => intent?.op === 'none').map((intent) => intent.reason ?? ''),
      landed: landed.map(({ dir, ...rest }) => rest),
      rejected,
      ...(warnings.length ? { warnings } : {}),
    })
    const project = layout.layers.project
    await writeJson(join(project.runs, `${runMeta.id}.json`), record)
    await writeJson(join(project.state, 'last_run.json'), record)
    return { runId: runMeta.id, landed, rejected, warnings }
  })
}
