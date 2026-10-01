#!/usr/bin/env node
// The same loop against a real DeepSeek model. Needs DEEPSEEK_API_KEY; never
// runs in CI. It costs a few cents and takes a few minutes.
//
//   DEEPSEEK_API_KEY=... node e2e/real.mjs [--keep]
//
// A small billing project whose tests only pass with APP_ENV=test (the error
// message points at docs/testing.md). Four sessions:
//   1. "run the tests"        → the agent hits the error, finds the doc, and
//                               autoharness should learn a testing skill with
//                               evals that the answer without the skill fails
//   2. a different test task  → the agent should load that skill and not
//                               learn a duplicate
//   3. a commit with a stated → a convention skill, with eval tasks that do not
//      team convention          restate the convention
//   4. a plain question       → nothing to learn
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, dshInstall, fail, headless, readJson, step, workspace } from './setup.mjs'

if (!process.env.DEEPSEEK_API_KEY) fail('set DEEPSEEK_API_KEY to run the real-model e2e')
const keep = process.argv.includes('--keep')
const { dsh, packages } = dshInstall()
const ws = workspace(packages, `- insert:
    - id: autoharness
      name: ../lib/index.js
      config:
        reflectEveryN: 3
        minEpisodeToolCalls: 2
`)

const files = {
  'package.json': '{ "name": "billing-demo", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }\n',
  'src/config.js': `export function loadConfig() {
  if (process.env.APP_ENV !== 'test' && process.argv.some((a) => a.includes('test'))) {
    throw new Error("APP_ENV must be 'test' when running the test suite (see docs/testing.md)")
  }
  return { currency: 'CNY', taxRate: 0.06 }
}
`,
  'src/invoice.js': `import { loadConfig } from './config.js'
export function total(items) {
  const { taxRate } = loadConfig()
  const net = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  return Math.round(net * (1 + taxRate) * 100) / 100
}
`,
  'test/invoice.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/invoice.js'
test('total adds tax', () => { assert.equal(total([{ price: 100, qty: 2 }]), 212) })
`,
  'docs/testing.md': '# Testing\nThe suite reads config at import time. Always run it as:\n\n    APP_ENV=test node --test --test-concurrency=1\n\n`npm test` alone fails because APP_ENV is unset.\n',
}
for (const [path, text] of Object.entries(files)) {
  mkdirSync(join(ws.project, path, '..'), { recursive: true })
  writeFileSync(join(ws.project, path), text)
}
const git = (...args) => execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', ...args], { cwd: ws.project, stdio: 'ignore' })
rmSync(join(ws.project, '.git'), { recursive: true, force: true })
git('init', '-q')
git('add', '-A')
git('commit', '-qm', 'init')

const skillsDir = join(ws.project, '.dsh', 'skills')
const lastRun = () => {
  try {
    return readJson(join(ws.project, '.dsh', 'autoharness', 'last_run.json'))
  } catch {
    return { trigger: 'none yet', landed: [], rejected: [], none: [] }
  }
}
const list = (dir) => {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}
const skills = () => list(skillsDir)
let previousRun
function session(label, task, env) {
  const { seconds } = headless({ dsh, ...ws, env }, task)
  const run = lastRun()
  if (run.id === previousRun) {
    step(`${label} (${seconds}s): no reflection (fewer tool calls than minEpisodeToolCalls)`)
    return run
  }
  previousRun = run.id
  step(`${label} (${seconds}s): ${run.trigger}: ${run.error ? `FAILED: ${run.error}` : `landed ${JSON.stringify(run.landed.map((l) => `${l.op} ${l.name}`))}, rejected ${run.rejected.length}${run.none.length ? `, none: ${run.none[0].slice(0, 100)}…` : ''}`}`)
  return run
}
function evalOf(name) {
  for (const dir of [join(skillsDir, name), join(ws.home, 'skills', name)]) {
    try {
      return readJson(join(dir, '.sidecar.json')).eval
    } catch {
      // try the next layer
    }
  }
  return null
}

try {
  session('session 1', 'Run the test suite and tell me whether it passes.')
  const testing = skills().find((name) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8').includes('APP_ENV=test'))
  check(testing, `learned a testing skill (${skills().join(', ')})`)
  const e1 = evalOf(testing)
  check(e1 && e1.passRate > e1.baseline, `its evals separate with/without the skill (${e1?.passRate} vs ${e1?.baseline})`)

  const before = readJson(join(skillsDir, testing, '.sidecar.json')).uses
  session('session 2', 'Add a test that total([]) returns 0, then run the test suite.')
  check(readJson(join(skillsDir, testing, '.sidecar.json')).uses > before, 'the agent loaded the learned skill')
  check(skills().filter((name) => readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8').includes('APP_ENV=test')).length === 1, 'no duplicate testing skill')

  session('session 3', "Commit the new test. Our team convention: commit messages are written in Chinese and start with the module name and a colon, for example '发票: 新增空列表测试'. Never add a trailing period.")
  const convention = skills().find((name) => /[一-鿿]/.test(readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')) && name !== testing)
  check(convention, 'learned the commit convention')
  const cases = readdirSync(join(skillsDir, convention, 'evals')).filter((name) => name.startsWith('case-')).map((name) => readJson(join(skillsDir, convention, 'evals', name)))
  check(cases.every((c) => !/trailing period|module name and a colon/i.test(c.task)), 'its eval tasks do not restate the convention')

  session('session 4', 'What does src/invoice.js do? Answer briefly.')
  for (const name of [...skills(), ...list(join(ws.home, 'skills'))]) {
    const e = evalOf(name)
    step(`  ${name}: ${e ? `${Math.round(e.passRate * 100)}% with the skill vs ${Math.round(e.baseline * 100)}% without, ${e.checks} checks` : 'no eval yet'}`)
  }
  step(`real-model e2e passed; review answers in ${join(ws.project, '.dsh', 'autoharness', 'evals', 'report.md')}`)
} finally {
  if (keep) step(`kept ${ws.work}`)
  else ws.cleanup()
}
