/**
 * Durable storage primitives: atomic file writes, JSON/JSONL helpers, the
 * per-layer lock, and the self-authored skill inventory. Only the promoter and
 * lifecycle write skill trees, always through these helpers.
 *
 * @module dsh-autoharness/store
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { appendFile, cp, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseSkill } from './skillfile.js'

/** Marker every self-authored skill carries in its sidecar. */
export const OWNER = 'autoharness'
export const SIDECAR = '.sidecar.json'
export const LEDGER = '.ledger.jsonl'

/** A short sortable unique id: base36 time + random suffix. */
export function newId(now = Date.now()) {
  return `${now.toString(36)}-${randomBytes(3).toString('hex')}`
}

/** Write a file through a same-directory temp file and rename. */
export async function atomicWrite(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`)
  await writeFile(tmp, data)
  await rename(tmp, path)
}

export async function writeJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export function readJsonSync(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(value)}\n`)
}

export async function readJsonl(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // a torn trailing line from a crash is skipped, not fatal
    }
  }
  return out
}

/** Move a directory, creating the destination's parent. */
export async function moveDir(from, to) {
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to)
}

/** Copy a directory tree. */
export async function copyDir(from, to) {
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
}

export async function removeDir(path) {
  await rm(path, { recursive: true, force: true })
}

const inProcess = new Map()
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Run `fn` holding the layer lock: an in-process queue plus an `O_EXCL`
 * lockfile for other dsh processes on the same project. A lockfile older than
 * `staleMs` is presumed orphaned by a crash and broken.
 * @template T
 * @param {string} lockPath - lockfile path.
 * @param {() => Promise<T>} fn - critical section.
 * @param {{ staleMs?: number, timeoutMs?: number }} [options] - lock timing.
 * @returns {Promise<T>} the critical section's result.
 */
export function withLock(lockPath, fn, options = {}) {
  const previous = inProcess.get(lockPath) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(() => withFileLock(lockPath, fn, options))
  const tail = run.catch(() => {})
  inProcess.set(lockPath, tail)
  tail.then(() => {
    if (inProcess.get(lockPath) === tail) inProcess.delete(lockPath)
  })
  return run
}

async function withFileLock(lockPath, fn, { staleMs = 10 * 60_000, timeoutMs = 30_000 } = {}) {
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let handle
  for (let delay = 25; ; delay = Math.min(delay * 2, 500)) {
    try {
      handle = await open(lockPath, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        continue
      }
      if (Date.now() > deadline) throw new Error(`autoharness: timed out waiting for lock ${lockPath}`)
      await sleep(delay)
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
    await handle.close()
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => {})
  }
}

/**
 * Read one skill directory if it is self-authored: the sidecar names this
 * plugin as owner and the frontmatter carries the autoharness metadata.
 * @param {string} dir - skill bundle directory.
 * @returns the skill record, or null for foreign or malformed skills.
 */
export function readOwnedSkill(dir) {
  const sidecar = readJsonSync(join(dir, SIDECAR), null)
  if (!sidecar || sidecar.owner !== OWNER) return null
  let text
  try {
    text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
  const parsed = parseSkill(text)
  const meta = parsed?.frontmatter?.metadata
  if (!parsed || !meta || typeof meta !== 'object' || !meta.autoharness) return null
  return {
    name: String(parsed.frontmatter.name),
    description: String(parsed.frontmatter.description ?? ''),
    whenToUse: parsed.frontmatter.whenToUse ? String(parsed.frontmatter.whenToUse) : undefined,
    metadata: meta,
    body: parsed.body,
    dir,
    sidecar,
  }
}

/**
 * List the self-authored skills in one skill root.
 * @param {string} root - skill root directory.
 * @param {string} layer - layer label stamped on each record.
 * @returns {Array<ReturnType<typeof readOwnedSkill> & { layer: string }>} owned skills sorted by name.
 */
export function listOwnedSkills(root, layer) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const skill = readOwnedSkill(join(root, entry.name))
    if (skill && skill.name === entry.name) out.push({ ...skill, layer })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Whether a root holds any skill (bundle or flat file) with this name. */
export function skillExistsIn(root, name) {
  return existsSync(join(root, name)) || existsSync(join(root, `${name}.md`))
}

/** List eval case files of a skill. */
export async function readEvalCases(skillDir) {
  const dir = join(skillDir, 'evals')
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const cases = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue
    const value = await readJson(join(dir, name), null)
    if (value && typeof value === 'object') cases.push(value)
  }
  return cases
}

/** Latest-first archived copies of a skill in an archive directory. */
export function findArchived(archiveDir, name) {
  let entries
  try {
    entries = readdirSync(archiveDir)
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry === name || entry.startsWith(`${name}--`))
    .map((entry) => ({ entry, path: join(archiveDir, entry), mtime: statSync(join(archiveDir, entry)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
}
