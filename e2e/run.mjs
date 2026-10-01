#!/usr/bin/env node
// End-to-end check in a real `dsh headless` process, no API key needed.
//
// 1. Install @deepseek-ai/dsh (or reuse $DSH_PREFIX, a directory whose
//    node_modules holds it).
// 2. Copy the plugin next to a node_modules/@deepseek-ai symlink into that
//    install, so bare imports resolve to the host's own packages.
// 3. Session 1 runs three tool calls; autoharness must learn, store, and eval
//    a skill before the one-shot process exits.
// 4. Session 2 must see the skill index, load the skill through the real
//    `skill` tool, and have the load counted.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_VERSION = process.env.DSH_VERSION ?? '0.2.0-rc.2'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')

function step(message) {
  process.stdout.write(`• ${message}\n`)
}

function fail(message) {
  process.stderr.write(`✗ ${message}\n`)
  process.exit(1)
}

function check(condition, message) {
  if (!condition) fail(message)
  step(`ok: ${message}`)
}

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
const hostPackages = join(prefix, 'node_modules', '@deepseek-ai')
if (!existsSync(dsh) || !existsSync(join(hostPackages, 'dsh-llm'))) fail(`no dsh install under ${prefix}`)

const work = mkdtempSync(join(tmpdir(), 'autoharness-e2e-'))
const plugin = join(work, 'plugin')
const project = join(work, 'project')
const home = join(work, 'dsh-home')
for (const part of ['lib', 'e2e', 'package.json']) cpSync(join(repo, part), join(plugin, part), { recursive: true })
mkdirSync(join(plugin, 'node_modules'), { recursive: true })
symlinkSync(hostPackages, join(plugin, 'node_modules', '@deepseek-ai'), 'dir')
mkdirSync(join(project, '.git'), { recursive: true })

function headless(task) {
  const result = spawnSync(dsh, ['headless', '--patch', join(plugin, 'e2e', 'patch.yml'), task], {
    cwd: project,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 180_000,
  })
  if (result.status !== 0) fail(`dsh headless exited ${result.status}\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const skillDir = join(project, '.dsh', 'skills', 'run-api-tests')

try {
  step('session 1: npm fails, pnpm works')
  headless('run the api tests')
  check(existsSync(join(skillDir, 'SKILL.md')), 'skill run-api-tests was learned')
  check(readdirSync(join(skillDir, 'evals')).length === 1, 'one eval case was stored with it')
  check(readdirSync(join(skillDir, 'references')).some((name) => name.startsWith('evidence-')), 'evidence transcript was stored')
  const sidecar = readJson(join(skillDir, '.sidecar.json'))
  check(sidecar.owner === 'autoharness' && sidecar.status === 'probation', 'sidecar marks it self-authored and on probation')
  check(sidecar.eval?.passRate === 1 && sidecar.eval?.baseline === 0, 'eval replay: 100% with the skill vs 0% without')
  check(existsSync(join(project, '.dsh', 'autoharness', 'evals', 'report.md')), 'eval review report was written')

  step('session 2: the index steers the model to the learned skill')
  const answer = headless('run the api tests again')
  check(answer.includes('Loaded run-api-tests'), 'the model loaded the skill through the real skill tool')
  check(readJson(join(skillDir, '.sidecar.json')).uses === 1, 'the load was counted')
  check(readJson(join(project, '.dsh', 'autoharness', 'state.json')).requests === 2, 'both requests were counted')
  step('e2e passed')
} finally {
  if (keep) step(`kept ${work}`)
  else rmSync(work, { recursive: true, force: true })
}
