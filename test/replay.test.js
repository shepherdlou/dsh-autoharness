import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { childPatch, locateDsh, prepareCopy, replaySkill, runChild, screenTask, summarizeTrace } from '../lib/replay.js'
import { ownedSkills, promote } from '../lib/promoter.js'
import { readJsonSync } from '../lib/store.js'
import { scriptedLlm, tempProject, testConfig, testLayout } from './helpers.js'

const FAKE_DSH = resolve(import.meta.dirname, '..', 'test-fixtures', 'fake-dsh.mjs')
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' })

function gitProject(t) {
  const { root, project, env } = tempProject(t)
  execFileSync('rm', ['-rf', join(project, '.git')])
  git(project, 'init', '-q')
  writeFileSync(join(project, '.gitignore'), 'node_modules/\ndist/\n')
  writeFileSync(join(project, 'a.txt'), 'committed\n')
  git(project, 'add', '-A')
  git(project, 'commit', '-qm', 'init')
  git(project, 'remote', 'add', 'origin', 'https://example.com/secret/repo.git')
  writeFileSync(join(project, 'a.txt'), 'changed in the working tree\n')
  writeFileSync(join(project, 'new.txt'), 'untracked\n')
  mkdirSync(join(project, 'dist'))
  writeFileSync(join(project, 'dist', 'build.js'), 'ignored\n')
  mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true })
  return { root, project, env }
}

test('replay: tasks with external effects are skipped', () => {
  for (const task of ['Run the api tests', 'Commit the new test with the team convention', 'Why does npm test fail here?']) assert.equal(screenTask(task).ok, true, task)
  for (const task of ['Push the branch to origin', 'git push the fix', 'Deploy the service', 'npm publish the package', 'Run the migration against production', 'ssh into the box and restart nginx', "curl -X POST https://api.example.com/hooks"]) {
    assert.equal(screenTask(task).ok, false, task)
  }
})

test('replay: dsh is found from config or from the host argv', () => {
  assert.deepEqual(locateDsh({ dshCommand: '/x/fake.mjs' }, [], '/node'), { command: '/node', args: ['/x/fake.mjs'] })
  assert.deepEqual(locateDsh({ dshCommand: '/usr/bin/dsh' }, [], '/node'), { command: '/usr/bin/dsh', args: [] })
  assert.deepEqual(locateDsh({}, ['/node', '/p/node_modules/.bin/dsh', 'headless'], '/node'), { command: '/node', args: ['/p/node_modules/.bin/dsh'] })
  assert.deepEqual(locateDsh({}, ['/node', '/p/@deepseek-ai/dsh/lib/bin.js'], '/node'), { command: '/node', args: ['/p/@deepseek-ai/dsh/lib/bin.js'] })
  assert.equal(locateDsh({}, ['/node', '/some/test-runner.js'], '/node'), null)
})

test('replay: the copy carries the working tree, drops remotes and agent state, links deps', async (t) => {
  const { root, project } = gitProject(t)
  mkdirSync(join(project, '.dsh', 'skills', 'x'), { recursive: true })
  mkdirSync(join(project, '.dsh', 'autoharness'), { recursive: true })
  const dest = join(root, 'copy')
  await prepareCopy({ projectRoot: project, dest })
  assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'changed in the working tree\n')
  assert.equal(readFileSync(join(dest, 'new.txt'), 'utf8'), 'untracked\n')
  assert.ok(!existsSync(join(dest, 'dist')), 'ignored build output stays behind')
  assert.equal(execFileSync('git', ['remote'], { cwd: dest }).toString().trim(), '', 'no remote to push to')
  assert.ok(lstatSync(join(dest, 'node_modules')).isSymbolicLink())
  assert.ok(!existsSync(join(dest, '.dsh', 'skills')) && !existsSync(join(dest, '.dsh', 'autoharness')))
})

test('replay: child patch pins the route, the sandbox, and the paused plugin', () => {
  const yaml = childPatch({ route: { provider: 'deepseek-official', model: 'deepseek-flash' }, credentialsPath: '/home/u/.dsh/.credentials.yaml', childHome: '/tmp/h', extraPatch: '- insert:\n    - id: x\n      name: ./x.js\n' })
  assert.match(yaml, /- id: autoharness-replay\n {6}name: ".*lib\/index\.js"\n {6}config:\n {8}paused: true/)
  assert.match(yaml, /provider: "deepseek-official"\n {4}model: "deepseek-flash"/)
  assert.match(yaml, /sandbox: workspace-write\n {8}approval: never\n {4}defaultPreset: replay/)
  assert.match(yaml, /- id: credentials\n {2}config:\n {4}path: "\/home\/u\/\.dsh\/\.credentials\.yaml"/)
  assert.match(yaml, /- id: x/)
  assert.ok(!childPatch({ route: { provider: 'p', model: 'm' }, credentialsPath: null, childHome: '/h' }).includes('credentials'))
})

test('replay: traces count calls, failures (error status or non-zero exit), and tokens', () => {
  const trace = summarizeTrace([
    { type: 'tool_call', callId: 'a', tool: 'bash', input: { command: 'npm test' } },
    { type: 'tool_result', callId: 'a', status: 'completed', result: 'npm ERR!\n[exit code: 1]' },
    { type: 'tool_call', callId: 'b', tool: 'read', input: { file_path: 'docs/testing.md' } },
    { type: 'tool_result', callId: 'b', status: 'error', result: 'no such file' },
    { type: 'tool_call', callId: 'c', tool: 'bash', input: { command: 'APP_ENV=test node --test' } },
    { type: 'tool_result', callId: 'c', status: 'completed', result: 'ok\n[exit code: 0]' },
    { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } },
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
    { type: 'final', text: 'All green.' },
  ])
  assert.equal(trace.calls.length, 3)
  assert.equal(trace.failed, 2)
  assert.equal(trace.tokens, 18)
  assert.equal(trace.endReason, 'completed')
  assert.match(trace.transcript, /- bash \(FAILED\): npm test\n- read \(FAILED\): docs\/testing\.md\n- bash: APP_ENV=test node --test\n\nFINAL ANSWER:\nAll green\./)
})

test('replay: a hung child is killed at the time limit', async (t) => {
  const { root } = tempProject(t)
  process.env.FAKE_DSH_HANG = '1'
  t.after(() => delete process.env.FAKE_DSH_HANG)
  writeFileSync(join(root, 'p.yml'), '')
  const started = Date.now()
  const result = await runChild({ dsh: { command: process.execPath, args: [FAKE_DSH] }, cwd: root, home: join(root, 'h'), patchFile: join(root, 'p.yml'), task: 't', timeoutMs: 300 })
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - started < 8000)
})

test('replay: with vs without the skill, graded and measured', async (t) => {
  const { root, project, env } = gitProject(t)
  mkdirSync(env.DSH_HOME, { recursive: true }); writeFileSync(join(env.DSH_HOME, '.credentials.yaml'), '')
  const config = testConfig({ dshCommand: FAKE_DSH })
  const layout = testLayout(project, env, config)
  await promote({
    intents: [{
      op: 'create', name: 'run-api-tests', description: 'Run the api package tests with pnpm workspace filtering.', body: 'Run `pnpm --filter api test`.', reason: 'seed',
      evals: [
        { task: 'Run the api tests and tell me if they pass.', checks: [{ kind: 'contains', pattern: 'pnpm --filter api test' }, { kind: 'llm-judge', criterion: 'No command in the run failed.' }] },
        { task: 'Deploy the api to production.', checks: [{ kind: 'contains', pattern: 'kubectl' }] },
      ],
    }],
    layout, config, episode: null, run: { trigger: 'seed' },
  })
  const skill = ownedSkills(layout).get('run-api-tests')
  const log = join(root, 'fake-dsh.log')
  process.env.FAKE_DSH_LOG = log
  t.after(() => delete process.env.FAKE_DSH_LOG)
  const llm = scriptedLlm(({ user }) => ({ pass: !user.split('CRITERION')[0].includes('(FAILED)'), why: 'looked for failed commands' }))
  const cases = readdirSync(join(skill.dir, 'evals')).map((name) => readJsonSync(join(skill.dir, 'evals', name)))
  const raw = await replaySkill({ llm, route: { provider: 'p', model: 'm' }, skill, cases, layout, config, dsh: locateDsh(config) })
  assert.equal(raw.mode, 'agentic')
  assert.equal(raw.skipped.length, 1, 'the deploy case was not run')
  assert.equal(raw.cases.length, 1)
  const [c] = raw.cases
  assert.deepEqual([c.traces.withSkill.calls, c.traces.baseline.calls], [1, 3])
  assert.deepEqual([c.traces.withSkill.failed, c.traces.baseline.failed], [0, 1])
  assert.deepEqual(c.checks.map((k) => [k.verdicts.withSkill.pass, k.verdicts.baseline.pass]), [[true, true], [true, false]])
  assert.deepEqual(raw.efficiency.withSkill, { calls: 1, failed: 0, tokens: 120, seconds: raw.efficiency.withSkill.seconds })

  const runs = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((r) => r.hasSkill).sort(), [false, true], 'only the skill under test differs')
  for (const r of runs) {
    assert.equal(r.paused, '1')
    assert.equal(r.remotes, false)
    assert.notEqual(r.home, env.DSH_HOME)
    assert.ok(!r.cwd.startsWith(project))
    assert.deepEqual(r.args.slice(0, 2), ['headless', '--patch'])
    assert.equal(r.args.at(-2), '--json')
    assert.match(r.patch, /- id: credentials\n  config:\n    path: ".*\.credentials\.yaml"/)
  }
  assert.ok(readdirSync(root).every((name) => !name.startsWith('autoharness-replay-')), 'copies are cleaned up')
})
