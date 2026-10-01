import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Capture, boundEntries } from '../lib/capture.js'
import { buildReflectRequest, normalizeIntents, selectFullBodies } from '../lib/reflect.js'
import { renderTranscript } from '../lib/transcript.js'
import { fakeSession, testConfig, turnEvents } from './helpers.js'

test('capture: events become compact redacted entries with counters and signals', () => {
  const capture = new Capture({ home: '/home/someone' })
  const session = fakeSession({ cwd: '/repo' })
  const events = turnEvents(session, {
    prompt: 'deploy with token sk-abcdefghijklmnopqrstuvwxyz0123',
    calls: [
      { name: 'skill', args: { name: 'run-api-tests' } },
      { name: 'read', args: { file_path: '/repo/.dsh/skills/lint-rules/SKILL.md' } },
      { name: 'bash', args: { command: 'cat /home/someone/.npmrc' }, isError: true, result: 'permission denied' },
    ],
  })
  const signals = events.map((event) => capture.observe(session, event))
  const state = capture.sessions.get('s1')
  assert.equal(state.toolCalls, 3)
  assert.equal(state.sinceReflect, 3)
  assert.equal(signals.find((s) => s.skillUse)?.skillUse, 'run-api-tests')
  assert.equal(signals.find((s) => s.skillView)?.skillView, 'lint-rules')
  assert.ok(signals[0].turnStart && signals.at(-1).turnEnd)
  const kinds = state.entries.map((e) => e.kind)
  assert.deepEqual(kinds, ['user', 'assistant', 'call', 'result', 'call', 'result', 'call', 'result', 'turn-end'])
  const text = renderTranscript(state.entries)
  assert.ok(!text.includes('sk-abcdef'), 'secrets are redacted at capture time')
  assert.ok(text.includes('cat ~/.npmrc'), 'home is folded')
  assert.match(text, /RESULT bash ERROR: permission denied/)
})

test('capture: skill invocations count as uses; autoharness and subagent traffic is not learned from', () => {
  const capture = new Capture()
  const session = fakeSession({ cwd: '/repo' })
  const invoked = capture.observe(session, { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'body' }], source: { kind: 'skill-invocation', name: 'run-api-tests', form: 'instructions' } } })
  assert.equal(invoked.skillUse, 'run-api-tests')
  const ours = capture.observe(session, { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'index' }], source: { kind: 'autoharness' } } })
  assert.equal(ours.entry, undefined)
  const child = fakeSession({ id: 'child', cwd: '/repo', origin: 'subagent' })
  for (const event of turnEvents(child, { calls: [{ name: 'skill', args: { name: 'x-skill' } }] })) capture.observe(child, event)
  const childState = capture.sessions.get('child')
  assert.equal(childState.entries.length, 0)
  assert.equal(childState.toolCalls, 0)
})

test('capture: episodes respect the watermark and the exchange bound', () => {
  const capture = new Capture()
  const session = fakeSession({ cwd: '/repo' })
  for (let turn = 1; turn <= 5; turn++) for (const event of turnEvents(session, { turn, prompt: `prompt ${turn}`, calls: [{}] })) capture.observe(session, event)
  const episode = capture.episode('s1', { digestExchanges: 2 })
  assert.equal(episode.entries.filter((e) => e.kind === 'user').length, 2)
  assert.equal(episode.entries[0].text, 'prompt 4')
  capture.markReflected('s1', episode.toSeq)
  assert.equal(capture.episode('s1', { digestExchanges: 2 }), null)
  assert.equal(capture.sessions.get('s1').sinceReflect, 0)
  const big = Array.from({ length: 100 }, (_, i) => ({ seq: i, kind: 'assistant', text: 'x'.repeat(1000) }))
  assert.ok(boundEntries(big, { digestExchanges: 0, maxChars: 10_000 }).length < 12)
})

test('reflect: request carries library, feedback, and the episode; envelope is validated', () => {
  const owned = [
    { name: 'run-api-tests', layer: 'project', description: 'Run api tests with pnpm', body: 'BODY-A', sidecar: { category: 'testing', needsPatch: true, eval: { passRate: 0.2, lift: -0.1 }, evalFailures: [{ check: 'contains pnpm', why: 'missing' }] } },
    { name: 'unrelated-skill', layer: 'global', description: 'Format markdown tables', body: 'BODY-B', sidecar: { category: 'style' } },
  ]
  const episode = { sessionId: 's1', fromSeq: 3, toSeq: 9, entries: [{ seq: 3, kind: 'user', text: 'pnpm tests fail in api' }] }
  const { system, user } = buildReflectRequest({ episode, owned, otherNames: ['hand-written'], config: testConfig() })
  assert.match(system, /at most 3 intents/)
  assert.match(user, /BODY-A/)
  assert.ok(!user.includes('BODY-B'), 'unrelated bodies are summarized, not inlined')
  assert.match(user, /EVAL_FEEDBACK[\s\S]*contains pnpm/)
  assert.match(user, /OTHER_SKILL_NAMES\n\n\["hand-written"\]/)
  assert.match(user, /\[3\] USER: pnpm tests fail in api/)
  assert.deepEqual([...selectFullBodies(owned, 'nothing relevant')], ['run-api-tests'], 'needsPatch always gets its body')
  assert.throws(() => normalizeIntents({ nope: [] }), /intents/)
  assert.deepEqual(normalizeIntents({ intents: [{ op: 'none' }, 'junk', null] }), [{ op: 'none' }])
})
