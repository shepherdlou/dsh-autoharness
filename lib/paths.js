/**
 * Filesystem layout. Skills live where `dsh-skill-filesystem` discovers them
 * (`<project>/.dsh/skills`, `<dshHome>/skills`); autoharness state lives next
 * to each layer in an `autoharness` directory outside every skill root, so
 * archived skills and staging trees never reach the catalog.
 *
 * @module dsh-autoharness/paths
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Layers in precedence order: project skills shadow global ones. */
export const LAYERS = Object.freeze(['project', 'global'])

/**
 * Nearest ancestor containing `.git` (directory or worktree file), matching
 * dsh-skill-filesystem's project-root rule; falls back to `cwd`.
 * @param {string} cwd - absolute working directory.
 * @returns {string} the project root.
 */
export function findProjectRoot(cwd) {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(cwd)
    dir = parent
  }
}

/** Resolve the harness home the same way dsh does: config, `$DSH_HOME`, `~/.dsh`. */
export function resolveDshHome(configured, env = process.env) {
  if (configured) return resolve(configured)
  if (env.DSH_HOME) return resolve(env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/** Resolve the shared agents home: `$DSH_AGENTS_HOME` or `~/.agents`. */
export function resolveAgentsHome(env = process.env) {
  return env.DSH_AGENTS_HOME ? resolve(env.DSH_AGENTS_HOME) : join(homedir(), '.agents')
}

function layerDirs(skills, state) {
  return Object.freeze({
    skills,
    state,
    episodes: join(state, 'episodes'),
    runs: join(state, 'runs'),
    snapshots: join(state, 'snapshots'),
    archive: join(state, 'archive'),
    staging: join(state, 'staging'),
    evalResults: join(state, 'evals', 'results'),
    stateFile: join(state, 'state.json'),
    lock: join(state, 'lock'),
  })
}

/**
 * Build the layout for one project.
 * @param {string} cwd - session working directory.
 * @param {{ dshHome?: string, globalLayer?: boolean }} [options] - layer options.
 * @returns the project root, per-layer directories, and read-only foreign skill roots.
 */
export function layoutFor(cwd, options = {}, env = process.env) {
  const projectRoot = findProjectRoot(cwd)
  const dshHome = resolveDshHome(options.dshHome, env)
  const agentsHome = resolveAgentsHome(env)
  const layers = {
    project: layerDirs(join(projectRoot, '.dsh', 'skills'), join(projectRoot, '.dsh', 'autoharness')),
  }
  if (options.globalLayer !== false) layers.global = layerDirs(join(dshHome, 'skills'), join(dshHome, 'autoharness'))
  return Object.freeze({
    projectRoot,
    dshHome,
    layers: Object.freeze(layers),
    // Roots other providers scan; autoharness only reads them for name collisions.
    foreignRoots: Object.freeze([
      join(projectRoot, '.agents', 'skills'),
      join(agentsHome, 'skills'),
    ]),
  })
}

/**
 * Create a layer's state directory and keep it out of version control.
 * @param {{ state: string }} dirs - one layer's directories.
 */
export function ensureStateDir(dirs) {
  mkdirSync(dirs.state, { recursive: true })
  const ignore = join(dirs.state, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '# autoharness runtime state; never commit\n*\n')
}
