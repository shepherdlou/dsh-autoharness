import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { commandDefinitions } from '../lib/commands.js'
import { resolveConfig } from '../lib/config.js'
import { ownedSkills, promote } from '../lib/promoter.js'
import { AutoharnessRuntime } from '../lib/runtime.js'
import { readJsonSync, readJsonl } from '../lib/store.js'
import {
  fakeAgent, fakeCreateUserMessage, fakeCtx, fakeSession, scriptedLlm, tempProject, testLayout, turnEvents, writeForeignSkill,
} from './helpers.js'

const REFLECTOR = 'You are the reflector'
const CURATOR = 'You are the curator'
const JUDGE = 'You are a strict grader'

/** A fake model that learns "use pnpm" whenever the episode shows npm failing and pnpm working. */
function harnessLlm({ reflect } = {}) {
  return scriptedLlm(({ system, user }) => {
    if (system.startsWith(REFLECTOR)) {
      if (reflect) return reflect(user)
      const [, from, to] = /seq (\d+)\.\.(\d+)\)/.exec(user)
      if (!user.includes('pnpm --filter api test') || user.includes('"name": "run-api-tests"')) return { intents: [{ op: 'none', reason: 'nothing new' }] }
      return {
        intents: [{
          op: 'create',
          name: 'run-api-tests',
          scope: 'project',
          category: 'testing',
          description: 'Run the api package tests with pnpm workspace filtering.',
          body: 'Run `pnpm --filter api test` from the repo root; plain `npm test` fails here.',
          reason: 'npm test failed, pnpm filter worked',
          evidence: { fromSeq: Number(from), toSeq: Number(to) },
          evals: [{ task: 'How do I run the api tests in this repository?', checks: [{ kind: 'contains', pattern: 'pnpm --filter api test' }, { kind: 'llm-judge', criterion: 'The answer does not recommend plain npm test.' }] }],
        }],
      }
    }
    if (system.startsWith(CURATOR)) return { intents: [{ op: 'none', reason: 'library is tidy' }] }
    if (system.startsWith(JUDGE)) {
      const answer = user.split('ANSWER\n\n')[1].split('\n\nCRITERION')[0]
      return { pass: !/\bnpm test\b/.test(answer.replace('plain `npm test` fails', '')), why: 'checked npm usage' }
    }
    return user.startsWith('SKILL') ? 'Run `pnpm --filter api test`.' : 'Run `npm test`.'
  })
}

function setup(t, { llm = harnessLlm(), config = {}, skills, services } = {}) {
  const { project, env } = tempProject(t)
  const ctx = fakeCtx({ llm, skills, services })
  const runtime = new AutoharnessRuntime({
    ctx,
    config: resolveConfig({ reflectEveryN: 3, minEpisodeToolCalls: 2, ...config }, {}),
    createUserMessage: fakeCreateUserMessage,
    env,
  })
  runtime.attach()
  for (const definition of commandDefinitions(runtime)) ctx.commands.register(definition)
  return { project, env, ctx, runtime, llm }
}

const learningTurn = (session, turn = 1) => turnEvents(session, {
  turn,
  prompt: 'run the api tests',
  calls: [
    { name: 'bash', args: { command: 'npm test' }, isError: true, result: 'npm ERR! workspaces unsupported' },
    { name: 'bash', args: { command: 'pnpm --filter api test' }, result: '42 passing' },
    { name: 'bash', args: { command: 'git status' } },
  ],
})

async function play(ctx, session, events) {
  for (const event of events) await ctx.emit('session/event', session, event)
}

async function run(ctx, name, agent, rawInput = '') {
  return ctx.command(name).handler({ rawInput, agent, signal: new AbortController().signal, commandId: 'cmd' })
}

test('runtime: threshold → reflection → promotion → eval → index on the next session', async (t) => {
  const { project, ctx, runtime, llm } = setup(t)
  const session = fakeSession({ id: 'session-1', cwd: project })
  const agent = fakeAgent(session)
  await ctx.emit('agent/created', { agent, source: 'startup' })
  assert.equal(agent.injected.length, 0, 'no index without learned skills')
  await play(ctx, session, learningTurn(session))
  await runtime.whenIdle()

  const dir = join(project, '.dsh', 'skills', 'run-api-tests')
  assert.ok(existsSync(join(dir, 'SKILL.md')), `skill landed; warnings: ${ctx.warnings.join(' | ')}`)
  const sidecar = readJsonSync(join(dir, '.sidecar.json'))
  assert.equal(sidecar.eval.passRate, 1)
  assert.equal(sidecar.eval.baseline, 0)
  assert.equal(sidecar.needsPatch, false)
  assert.ok(existsSync(join(project, '.dsh', 'autoharness', 'evals', 'report.md')))
  const episodeLog = await readJsonl(join(project, '.dsh', 'autoharness', 'episodes', 'session-1.jsonl'))
  assert.ok(episodeLog.length >= 8)
  assert.ok(readJsonSync(join(project, '.dsh', 'autoharness', 'episodes', 'session-1.meta.json')).reflectedUpTo > 0)
  assert.equal(readJsonSync(join(project, '.dsh', 'autoharness', 'state.json')).requests, 1)
  const reflectCall = llm.calls.find((c) => c.system.startsWith(REFLECTOR))
  assert.deepEqual([reflectCall.options.provider, reflectCall.options.model], ['fake', 'fake-model'])

  const next = fakeSession({ id: 'session-2', cwd: project })
  const agent2 = fakeAgent(next)
  await ctx.emit('agent/created', { agent: agent2, source: 'startup' })
  assert.equal(agent2.injected.length, 1)
  assert.deepEqual(agent2.injected[0].source, { kind: 'autoharness' })
  assert.match(agent2.injected[0].content[0].text, /\[testing\]\n- run-api-tests: /)
  const resumed = fakeAgent(fakeSession({ id: 'session-2', cwd: project }))
  await ctx.emit('agent/created', { agent: resumed, source: 'resume' })
  assert.equal(resumed.injected.length, 0, 'a resumed session already has its index')

  await play(ctx, next, turnEvents(next, { calls: [{ name: 'skill', args: { name: 'run-api-tests' } }] }))
  await runtime.whenIdle()
  assert.equal(readJsonSync(join(dir, '.sidecar.json')).uses, 1, 'skill loads are counted')
  await ctx.dispose()
})

test('runtime: commands learn, status, eval, pause/resume, archive/revive', async (t) => {
  const { project, ctx, runtime } = setup(t, { config: { reflectEveryN: 100 } })
  const session = fakeSession({ id: 'session-cmd', cwd: project })
  const agent = fakeAgent(session)
  await ctx.emit('agent/created', { agent, source: 'startup' })
  await play(ctx, session, learningTurn(session))
  await runtime.whenIdle()
  assert.equal(ownedSkills(testLayout(project, runtime.env)).size, 0, 'below threshold, nothing learned yet')

  const learned = await run(ctx, 'learn', agent)
  assert.equal(learned.kind, 'success', learned.text)
  assert.match(learned.text, /\+ create run-api-tests \(project\)/)
  assert.match(learned.text, /eval run-api-tests: 100% with skill vs 0% baseline/)
  assert.match((await run(ctx, 'learn', agent)).text, /Skipped: nothing captured/)
  assert.equal((await run(ctx, 'learn', agent, 'extra')).kind, 'error')

  const status = await run(ctx, 'autoharness', agent, 'status')
  assert.match(status.text, /run-api-tests \| project \| probation \| 0 \|/)
  assert.match(status.text, /last run .* \(manual\)/)

  const evaluated = await run(ctx, 'autoharness', agent, 'eval run-api-tests')
  assert.match(evaluated.text, /run-api-tests: 100% with skill vs 0% baseline over 2 checks/)
  assert.match((await run(ctx, 'autoharness', agent, 'eval missing-skill')).text, /No eval cases/)

  assert.match((await run(ctx, 'autoharness', agent, 'pause')).text, /paused/)
  assert.match((await run(ctx, 'autoharness', agent, 'status')).text, /PAUSED/)
  assert.equal((await run(ctx, 'learn', agent)).kind, 'error')
  const pausedSession = fakeSession({ id: 'while-paused', cwd: project })
  const pausedAgent = fakeAgent(pausedSession)
  await ctx.emit('agent/created', { agent: pausedAgent, source: 'startup' })
  assert.equal(pausedAgent.injected.length, 1, 'recall still works while paused')
  await play(ctx, pausedSession, turnEvents(pausedSession, { calls: [{ name: 'skill', args: { name: 'run-api-tests' } }] }))
  await runtime.whenIdle()
  assert.equal(ownedSkills(testLayout(project, runtime.env)).get('run-api-tests').sidecar.uses, 1, 'usage still counts while paused')
  assert.ok(!existsSync(join(project, '.dsh', 'autoharness', 'episodes', 'while-paused.jsonl')), 'nothing is captured while paused')
  await run(ctx, 'autoharness', agent, 'resume')

  assert.match((await run(ctx, 'autoharness', agent, 'archive run-api-tests')).text, /Archived run-api-tests/)
  assert.match((await run(ctx, 'autoharness', agent, 'revive run-api-tests')).text, /Revived/)
  assert.equal((await run(ctx, 'autoharness', agent, 'bogus')).kind, 'error')
  assert.equal((await run(ctx, 'autoharness', agent, 'archive not-ours')).kind, 'error')
  await ctx.dispose()
})

test('runtime: reflection failure backs off without losing the episode', async (t) => {
  let fail = true
  const llm = harnessLlm()
  const flaky = { calls: llm.calls, stream: (options) => (fail && options.system.startsWith(REFLECTOR) ? scriptedLlm(() => new Error('rate limited')).stream(options) : llm.stream(options)) }
  const { project, ctx, runtime } = setup(t, { llm: flaky })
  const session = fakeSession({ id: 'session-flaky', cwd: project })
  await ctx.emit('agent/created', { agent: fakeAgent(session), source: 'startup' })
  await play(ctx, session, learningTurn(session))
  await runtime.whenIdle()
  assert.ok(ctx.warnings.some((w) => /rate limited/.test(w)), ctx.warnings.join('|'))
  assert.equal(runtime.capture.sessions.get('session-flaky').sinceReflect, 0, 'backed off')
  assert.ok(runtime.capture.episode('session-flaky', runtime.config).entries.length > 0, 'episode kept for the retry')
  fail = false
  await play(ctx, session, learningTurn(session, 2))
  await runtime.whenIdle()
  assert.ok(existsSync(join(project, '.dsh', 'skills', 'run-api-tests', 'SKILL.md')), ctx.warnings.join('|'))
  await ctx.dispose()
})

test('runtime: idle episodes from a crashed process are recovered on the next session', async (t) => {
  const { project, ctx, runtime } = setup(t)
  const episodes = join(project, '.dsh', 'autoharness', 'episodes')
  mkdirSync(episodes, { recursive: true })
  const crashed = fakeSession({ id: 'crashed', cwd: project })
  const lines = learningTurn(crashed).map((event) => runtime.capture.observe(crashed, event).entry).filter(Boolean)
  runtime.capture.drop('crashed')
  const file = join(episodes, 'crashed.jsonl')
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  const old = new Date(Date.now() - 60 * 60_000)
  utimesSync(file, old, old)

  const session = fakeSession({ id: 'fresh', cwd: project })
  await ctx.emit('agent/created', { agent: fakeAgent(session), source: 'startup' })
  await play(ctx, session, turnEvents(session, { calls: [{}] }))
  await runtime.whenIdle()
  assert.ok(existsSync(join(project, '.dsh', 'skills', 'run-api-tests', 'SKILL.md')), ctx.warnings.join('|'))
  assert.equal(readJsonSync(join(project, '.dsh', 'autoharness', 'last_run.json')).trigger, 'recovery')
  assert.ok(readJsonSync(join(episodes, 'crashed.meta.json')).reflectedUpTo >= lines.at(-1).seq)
  await ctx.dispose()
})

test('runtime: consolidation fires on the project tool-call budget; subagents and foreign skills are left alone', async (t) => {
  const { project, ctx, runtime, llm } = setup(t, { config: { consolidateEveryN: 4, reflectEveryN: 50 } })
  const foreign = writeForeignSkill(join(project, '.dsh', 'skills'), 'hand-written')
  const layout = testLayout(project, runtime.env)
  const seeded = ['alpha-notes', 'beta-notes'].map((name) => ({
    op: 'create', name, description: `Overlapping note ${name} for curator tests.`, body: `Remember ${name}.`, reason: 'seed',
    evals: [{ task: `What should I remember about ${name}?`, checks: [{ kind: 'contains', pattern: name }] }],
  }))
  assert.equal((await promote({ intents: seeded, layout, config: runtime.config, episode: null, run: { trigger: 'seed' } })).landed.length, 2)
  const session = fakeSession({ id: 'main', cwd: project })
  const agent = fakeAgent(session)
  await ctx.emit('agent/created', { agent, source: 'startup' })
  const child = fakeSession({ id: 'child', cwd: project, origin: 'subagent' })
  await ctx.emit('agent/created', { agent: fakeAgent(child), source: 'startup' })
  await play(ctx, child, learningTurn(child))
  await play(ctx, session, learningTurn(session))
  await play(ctx, session, turnEvents(session, { turn: 2, calls: [{}, {}] }))
  await runtime.whenIdle()
  assert.ok(llm.calls.some((c) => c.system.startsWith(CURATOR)), 'curator ran after 4+ tool calls')
  assert.equal(readFileSync(join(project, '.dsh', 'skills', 'hand-written', 'SKILL.md'), 'utf8'), foreign)
  assert.ok(!existsSync(join(project, '.dsh', 'autoharness', 'episodes', 'child.jsonl')), 'subagent traffic is not captured')
  await ctx.dispose()
})

test('runtime: session end reflects on the tail; agent/created never throws', async (t) => {
  const { project, ctx, runtime } = setup(t, { config: { reflectEveryN: 100 } })
  const session = fakeSession({ id: 'ending', cwd: project })
  const agent = fakeAgent(session)
  await ctx.emit('agent/created', { agent, source: 'startup' })
  await play(ctx, session, learningTurn(session))
  await ctx.emit('agent/disposed', { agent })
  await runtime.whenIdle()
  assert.ok(existsSync(join(project, '.dsh', 'skills', 'run-api-tests', 'SKILL.md')), ctx.warnings.join('|'))
  assert.equal(runtime.capture.sessions.has('ending'), false)
  const broken = { session: { header: { id: 'x', cwd: project }, requestHeader: () => undefined }, inject() { throw new Error('boom') } }
  writeForeignSkill(join(project, '.dsh', 'skills'), 'another-hand-written')
  await ctx.emit('agent/created', { agent: broken, source: 'startup' })
  assert.ok(ctx.warnings.some((w) => /session start hook failed: boom/.test(w)))
  await ctx.dispose()
})

test('runtime: one-shot hosts reflect inside agent/turn-stopping, before the turn closes', async (t) => {
  const { project, ctx, runtime } = setup(t, { services: { headlessStartup: {} } })
  assert.equal(runtime.reflectsInTurn(), true)
  const session = fakeSession({ id: 'one-shot', cwd: project })
  const agent = fakeAgent(session)
  await ctx.emit('agent/created', { agent, source: 'startup' })
  const events = learningTurn(session)
  await play(ctx, session, events.slice(0, -1))
  await ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  const dir = join(project, '.dsh', 'skills', 'run-api-tests')
  assert.ok(existsSync(join(dir, 'SKILL.md')), `learned before the turn closed; ${ctx.warnings.join('|')}`)
  assert.equal(readJsonSync(join(dir, '.sidecar.json')).eval.passRate, 1, 'evals also ran in-turn')
  await play(ctx, session, events.slice(-1))
  await runtime.whenIdle()
  assert.equal(readJsonSync(join(project, '.dsh', 'autoharness', 'last_run.json')).trigger, 'session-end', 'turn end did not reflect twice')
  await ctx.dispose()
})

test('runtime: interactive hosts keep reflection in the background', async (t) => {
  const { project, ctx, runtime } = setup(t)
  assert.equal(runtime.reflectsInTurn(), false)
  const session = fakeSession({ id: 'interactive', cwd: project })
  const agent = fakeAgent(session)
  const events = learningTurn(session)
  await play(ctx, session, events.slice(0, -1))
  await ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  assert.ok(!existsSync(join(project, '.dsh', 'skills', 'run-api-tests')), 'turn-stopping does not block')
  await play(ctx, session, events.slice(-1))
  await runtime.whenIdle()
  assert.ok(existsSync(join(project, '.dsh', 'skills', 'run-api-tests', 'SKILL.md')))
  await ctx.dispose()
})

test('runtime: teardown lets in-flight work finish within drainTimeoutMs, then aborts', async (t) => {
  let release
  const gate = new Promise((done) => { release = done })
  const inner = harnessLlm()
  const slow = { calls: inner.calls, stream: (options) => (async function* () {
    if (options.system.startsWith(REFLECTOR)) await gate
    yield* inner.stream(options)
  })() }
  const { project, ctx } = setup(t, { llm: slow, config: { drainTimeoutMs: 5000 } })
  const session = fakeSession({ id: 'draining', cwd: project })
  await play(ctx, session, learningTurn(session))
  setTimeout(release, 50)
  await ctx.dispose()
  assert.ok(existsSync(join(project, '.dsh', 'skills', 'run-api-tests', 'SKILL.md')), 'reflection finished during the grace period')

  const stuck = setup(t, { llm: { calls: [], stream: (options) => (async function* () {
    await new Promise((done) => options.signal.addEventListener('abort', done, { once: true }))
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'aborted', message: 'aborted' } } }
  })() }, config: { drainTimeoutMs: 50 } })
  const s2 = fakeSession({ id: 'stuck', cwd: stuck.project })
  await play(stuck.ctx, s2, learningTurn(s2))
  const started = Date.now()
  await stuck.ctx.dispose()
  assert.ok(Date.now() - started < 2000, 'a hung model call is aborted after the grace period')
})
