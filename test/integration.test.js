// Integration with the real harness packages: cordis loads the plugin, the
// real command registry runs its commands, and the real filesystem skill
// provider reads the SKILL.md files the promoter writes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as commandsPlugin from '@deepseek-ai/dsh-commands'
import * as llmPlugin from '@deepseek-ai/dsh-llm'
import * as skillPlugin from '@deepseek-ai/dsh-skill'
import * as skillFsPlugin from '@deepseek-ai/dsh-skill-filesystem'
import * as autoharness from '../lib/index.js'
import { promote } from '../lib/promoter.js'
import { tempProject, testConfig, testLayout } from './helpers.js'

const settle = () => new Promise((done) => setTimeout(done, 100))

test('integration: cordis loads the plugin; /learn and /autoharness run through the real command registry', async (t) => {
  const { project, env } = tempProject(t)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = env.DSH_HOME
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
  const ctx = new Context()
  await ctx.plugin(llmPlugin.default ?? llmPlugin)
  await ctx.plugin(commandsPlugin.default ?? commandsPlugin)
  const fiber = ctx.plugin(autoharness, { reflectEveryN: 5 })
  await fiber
  await settle()
  const agent = { session: { header: { id: 'integration', cwd: project } }, ctx }
  const names = ctx.commands.list(agent).map((command) => command.name)
  assert.ok(names.includes('learn') && names.includes('autoharness'), names.join(','))
  const run = (name, rawInput) => ctx.commands.find(agent, name).handler({ rawInput, agent, signal: new AbortController().signal, commandId: 'c' })
  const status = await run('autoharness', 'status')
  assert.equal(status.kind, 'success')
  assert.match(status.text, /no learned skills yet/)
  assert.match((await run('learn', '')).text, /Skipped: nothing captured/)
  await fiber.dispose?.()
})

test('integration: the real dsh-skill-filesystem provider reads promoted skills', async (t) => {
  const { project, env } = tempProject(t)
  const config = testConfig()
  const layout = testLayout(project, env, config)
  const result = await promote({
    layout,
    config,
    episode: null,
    run: { trigger: 'integration' },
    intents: [{
      op: 'create',
      name: 'yaml-roundtrip-check',
      category: 'testing',
      description: 'Checks: "quotes", colons: and unicode 中文 survive the YAML parser.',
      whenToUse: 'When verifying frontmatter: always',
      body: '1. Run `pnpm test`\n2. Done: yes',
      reason: 'integration',
      evals: [{ task: 'How do I run the tests here?', checks: [{ kind: 'contains', pattern: 'pnpm test' }] }],
    }],
  })
  assert.deepEqual(result.rejected, [])
  const ctx = new Context()
  await ctx.plugin(skillPlugin.default ?? skillPlugin)
  await ctx.plugin(skillFsPlugin, { watch: false, dshHome: env.DSH_HOME, agentsHome: env.DSH_AGENTS_HOME })
  await settle()
  const summary = (await ctx.skills.list({ cwd: project })).find((skill) => skill.name === 'yaml-roundtrip-check')
  assert.ok(summary, 'the provider discovers the skill')
  assert.equal(summary.description, 'Checks: "quotes", colons: and unicode 中文 survive the YAML parser.')
  assert.equal(summary.whenToUse, 'When verifying frontmatter: always')
  assert.equal(summary.source, 'project-dsh')
  const definition = await ctx.skills.get('yaml-roundtrip-check', { cwd: project })
  assert.deepEqual(definition.metadata, { autoharness: { version: 1, layer: 'project', category: 'testing' } })
  assert.equal(definition.content, '1. Run `pnpm test`\n2. Done: yes')
})

test('integration: entry exports a valid cordis plugin shape', () => {
  assert.equal(autoharness.name, 'autoharness')
  assert.deepEqual(autoharness.inject, ['llm'])
  const config = new autoharness.Config({ reflectEveryN: 7 })
  assert.equal(config.reflectEveryN, 7)
  assert.equal(config.consolidateEveryN, 250)
  assert.throws(() => new autoharness.Config({ reflectEveryN: 0 }))
})
