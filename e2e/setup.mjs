// Shared setup for the e2e scripts: a dsh install, a plugin copy wired to the
// host's packages, and a runner for one `dsh headless` session.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DSH_VERSION = process.env.DSH_VERSION ?? '0.2.0-rc.2'
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function step(message) {
  process.stdout.write(`• ${message}\n`)
}

export function fail(message) {
  process.stderr.write(`✗ ${message}\n`)
  process.exit(1)
}

export function check(condition, message) {
  if (!condition) fail(message)
  step(`ok: ${message}`)
}

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** Locate or install dsh; returns the `dsh` binary and its `@deepseek-ai` package directory. */
export function dshInstall() {
  let prefix = process.env.DSH_PREFIX && resolve(process.env.DSH_PREFIX)
  if (!prefix) {
    prefix = join(repo, '.e2e', `dsh-${DSH_VERSION}`)
    if (!existsSync(join(prefix, 'node_modules', '.bin', 'dsh'))) {
      step(`installing @deepseek-ai/dsh@${DSH_VERSION} into ${prefix}`)
      mkdirSync(prefix, { recursive: true })
      execFileSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', `@deepseek-ai/dsh@${DSH_VERSION}`], { stdio: 'inherit' })
    }
  }
  const dsh = join(prefix, 'node_modules', '.bin', 'dsh')
  const packages = join(prefix, 'node_modules', '@deepseek-ai')
  if (!existsSync(dsh) || !existsSync(join(packages, 'dsh-llm'))) fail(`no dsh install under ${prefix}`)
  return { dsh, packages }
}

/**
 * Create a scratch workspace: the plugin copied next to a node_modules
 * symlink into the host's packages (bare imports from a --patch plugin
 * resolve from its own directory), an empty project, and a DSH_HOME.
 */
export function workspace(packages, patchYaml) {
  const work = mkdtempSync(join(tmpdir(), 'autoharness-e2e-'))
  const plugin = join(work, 'plugin')
  for (const part of ['lib', 'e2e', 'package.json']) cpSync(join(repo, part), join(plugin, part), { recursive: true })
  mkdirSync(join(plugin, 'node_modules'), { recursive: true })
  symlinkSync(packages, join(plugin, 'node_modules', '@deepseek-ai'), 'dir')
  const patch = join(plugin, 'e2e', 'active-patch.yml')
  writeFileSync(patch, patchYaml)
  const project = join(work, 'project')
  mkdirSync(join(project, '.git'), { recursive: true })
  return { work, plugin, patch, project, home: join(work, 'dsh-home'), cleanup: () => rmSync(work, { recursive: true, force: true }) }
}

/** Run one headless task; returns stdout, or fails the script. */
export function headless({ dsh, patch, project, home, env = {} }, task) {
  const started = Date.now()
  const result = spawnSync(dsh, ['headless', '--patch', patch, task], {
    cwd: project,
    env: { ...process.env, DSH_HOME: home, ...env },
    encoding: 'utf8',
    timeout: 600_000,
  })
  if (result.status !== 0) fail(`dsh headless exited ${result.status}\n${result.stdout}\n${result.stderr}`)
  return { answer: result.stdout.trim(), stderr: result.stderr, seconds: Math.round((Date.now() - started) / 1000) }
}
