import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS, resolveConfig } from '../lib/config.js'
import { complete, parseJsonObject, resolveRoute } from '../lib/llm.js'
import { containsSecret, redact } from '../lib/redact.js'
import { isSkillName, parseSkill, renderSkill } from '../lib/skillfile.js'
import { scriptedLlm } from './helpers.js'

test('config: defaults, patch values, and env overrides in that precedence', () => {
  assert.equal(resolveConfig({}, {}).reflectEveryN, DEFAULTS.reflectEveryN)
  assert.equal(resolveConfig({ reflectEveryN: 10 }, {}).reflectEveryN, 10)
  const config = resolveConfig({ reflectEveryN: 10 }, {
    AUTOHARNESS_REFLECT_EVERY_N: '3',
    AUTOHARNESS_INDEX_SUSPENDED: '1',
    AUTOHARNESS_GRADUATION_SUSPENDED: 'yes',
    AUTOHARNESS_EVAL_PASS_THRESHOLD: '0.75',
    AUTOHARNESS_MODEL: 'deepseek-chat',
  })
  assert.equal(config.reflectEveryN, 3)
  assert.equal(config.indexEnabled, false)
  assert.equal(config.graduationSuspended, true)
  assert.equal(config.evalPassThreshold, 0.75)
  assert.equal(config.model, 'deepseek-chat')
  assert.ok(Object.isFrozen(config))
})

test('config: invalid values fail loudly', () => {
  assert.throws(() => resolveConfig({}, { AUTOHARNESS_REFLECT_EVERY_N: 'many' }), /non-negative integer/)
  assert.throws(() => resolveConfig({}, { AUTOHARNESS_PAUSED: 'maybe' }), /boolean/)
  assert.throws(() => resolveConfig({ reflectEveryN: '5' }, {}), /must be a number/)
  assert.throws(() => resolveConfig({ reflectEveryN: 0 }, {}), /at least 1/)
})

test('redact: secrets are masked, placeholders and lookalikes survive', () => {
  const raw = [
    'key sk-abcdefghijklmnopqrstuvwxyz123456',
    'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'export DEEPSEEK_API_KEY=supersecretvalue123',
    'Authorization: Bearer abc.def.ghi',
    '"password": "hunter22"',
    'https://user:pa55@example.com/repo.git',
  ].join('\n')
  const out = redact(raw, { home: '/home/someone' })
  for (const leaked of ['sk-abcdef', 'ghp_abc', 'supersecretvalue123', 'abc.def.ghi', 'hunter22', 'pa55']) assert.ok(!out.includes(leaked), `leaked ${leaked}: ${out}`)
  assert.equal(redact('export DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY'), 'export DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY')
  assert.equal(redact('MAX_TOKENS=4096 and max_tokens: 100'), 'MAX_TOKENS=4096 and max_tokens: 100')
  assert.equal(redact('cat /home/someone/project/a.txt', { home: '/home/someone' }), 'cat ~/project/a.txt')
  assert.ok(containsSecret('token sk-ant-abcdefghijklmnopqrstuvwx'))
  assert.ok(!containsSecret('run pnpm test --filter api'))
})

test('skillfile: JSON-scalar frontmatter round-trips and stays YAML-readable', () => {
  const skill = {
    name: 'run-api-tests',
    description: 'Run the API tests: use "pnpm --filter api test", not npm.',
    whenToUse: 'When touching packages/api',
    metadata: { autoharness: { version: 1, layer: 'project', category: 'testing' } },
    body: '# Steps\n\n1. `pnpm --filter api test`\n2. 中文也可以',
  }
  const text = renderSkill(skill)
  assert.match(text, /^---\nname: "run-api-tests"\n/)
  const parsed = parseSkill(text)
  assert.equal(parsed.frontmatter.name, skill.name)
  assert.equal(parsed.frontmatter.description, skill.description)
  assert.deepEqual(parsed.frontmatter.metadata, skill.metadata)
  assert.equal(parsed.body, skill.body)
  assert.equal(parseSkill('---\nname: plain-skill\ndescription: plain text: with colon\n---\nbody').frontmatter.description, 'plain text: with colon')
  assert.equal(parseSkill('no frontmatter'), null)
  assert.ok(isSkillName('a-b-1'))
  assert.ok(!isSkillName('A-b') && !isSkillName('a--b') && !isSkillName('-a') && !isSkillName('a'.repeat(65)))
})

test('llm: final text block wins, failures surface, JSON is extracted from fences', async () => {
  const llm = scriptedLlm(() => 'here:\n```json\n{"intents":[]}\n```')
  const text = await complete(llm, { route: { provider: 'p', model: 'm' }, system: 's', user: 'u' })
  assert.deepEqual(parseJsonObject(text), { intents: [] })
  assert.equal(llm.calls[0].options.temperature, 0)
  const failing = scriptedLlm(() => new Error('quota'))
  await assert.rejects(complete(failing, { route: { provider: 'p', model: 'm' }, system: 's', user: 'u' }), /error: boom quota/)
  assert.throws(() => parseJsonObject('no json'), /no JSON object/)
  assert.throws(() => parseJsonObject('[1,2]'), /no JSON object|not a JSON object/)
})

test('llm: route comes from config first, then the session header', () => {
  const session = { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }) }
  assert.deepEqual(resolveRoute({ provider: '', model: '' }, session), { provider: 'deepseek', model: 'deepseek-chat' })
  assert.deepEqual(resolveRoute({ provider: 'x', model: 'y' }, session), { provider: 'x', model: 'y' })
  assert.deepEqual(resolveRoute({ provider: '', model: 'deepseek-reasoner' }, session), { provider: 'deepseek', model: 'deepseek-reasoner' })
  assert.equal(resolveRoute({ provider: '', model: '' }, { requestHeader: () => undefined }), null)
})
