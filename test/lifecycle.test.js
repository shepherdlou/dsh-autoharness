import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyEvalResult, evalSkill, renderReport, runCodeCheck } from '../lib/evals.js'
import { scoreResult } from '../lib/labels.js'
import { buildIndex } from '../lib/index-surface.js'
import { flushCounters, reviveSkill, runLifecycle, survivalScore, usageRate } from '../lib/lifecycle.js'
import { ownedSkills, promote } from '../lib/promoter.js'
import { SIDECAR, readJsonSync, writeJson } from '../lib/store.js'
import { scriptedLlm, tempProject, testConfig, testLayout } from './helpers.js'

function skillIntent(name, category = 'testing') {
  return {
    op: 'create',
    name,
    category,
    description: `Learned skill ${name} for lifecycle tests, long enough.`,
    body: `Do ${name}.`,
    reason: 'test',
    evals: [{ task: `How do I do ${name} in this repo?`, checks: [{ kind: 'contains', pattern: name }] }],
  }
}

async function seed(layout, names, config) {
  await promote({ intents: names.map((name) => skillIntent(name)), layout, config: { ...config, maxIntentsPerRun: 99 }, episode: null, run: { trigger: 'seed' } })
}

async function setSidecar(layout, name, patch) {
  const file = join(layout.layers.project.skills, name, SIDECAR)
  await writeJson(file, { ...readJsonSync(file), ...patch })
}

test('lifecycle math: usage rate and eval-weighted survival score', () => {
  assert.equal(usageRate({ uses: 5, createdAtRequest: 0 }, 10), 0.5)
  assert.equal(usageRate({ uses: 5, createdAtRequest: 10 }, 10), 5, 'age is at least one request')
  assert.equal(survivalScore({ uses: 5, createdAtRequest: 0 }, 10), 0.5, 'no eval counts as passing')
  assert.equal(survivalScore({ uses: 5, createdAtRequest: 0, eval: { passRate: 0 } }, 10), 0.25)
})

test('lifecycle: probation graduates used skills and archives never-used ones', async (t) => {
  const { project, env } = tempProject(t)
  const config = testConfig({ maturityProject: 10 })
  const layout = testLayout(project, env, config)
  await seed(layout, ['used-skill', 'unused-skill', 'viewed-skill', 'young-skill'], config)
  await setSidecar(layout, 'used-skill', { uses: 3 })
  await setSidecar(layout, 'viewed-skill', { views: 1 })
  await flushCounters({ layout, requests: 10, toolCalls: 0, skills: new Map() })
  await setSidecar(layout, 'young-skill', { createdAtRequest: 5 })
  const actions = await runLifecycle({ layout, config })
  const byName = Object.fromEntries(actions.map((a) => [a.name, a.op]))
  assert.deepEqual(byName, { 'used-skill': 'graduate', 'unused-skill': 'archive', 'viewed-skill': 'graduate' })
  const owned = ownedSkills(layout)
  assert.equal(owned.get('used-skill').sidecar.status, 'mature')
  assert.equal(owned.get('young-skill').sidecar.status, 'probation')
  assert.ok(!owned.has('unused-skill'))
  assert.equal(readdirSync(layout.layers.project.archive).length, 1)
})

test('lifecycle: capacity evicts the lowest survival score, eval failures count', async (t) => {
  const { project, env } = tempProject(t)
  const config = testConfig({ maturityProject: 1, capacityProject: 2 })
  const layout = testLayout(project, env, config)
  await seed(layout, ['alpha-skill', 'beta-skill', 'gamma-skill'], config)
  await setSidecar(layout, 'alpha-skill', { status: 'mature', uses: 10 })
  await setSidecar(layout, 'beta-skill', { status: 'mature', uses: 10, eval: { passRate: 0 } })
  await setSidecar(layout, 'gamma-skill', { status: 'mature', uses: 8 })
  await flushCounters({ layout, requests: 20, toolCalls: 0, skills: new Map() })
  const actions = await runLifecycle({ layout, config })
  assert.deepEqual(actions.map((a) => `${a.op}:${a.name}`), ['archive:beta-skill'])
  assert.deepEqual([...ownedSkills(layout).keys()], ['alpha-skill', 'gamma-skill'])
})

test('lifecycle: graduationSuspended freezes archival; revive restarts probation', async (t) => {
  const { project, env } = tempProject(t)
  const frozen = testConfig({ maturityProject: 1, graduationSuspended: true })
  const layout = testLayout(project, env, frozen)
  await seed(layout, ['idle-skill'], frozen)
  await flushCounters({ layout, requests: 5, toolCalls: 0, skills: new Map() })
  assert.deepEqual(await runLifecycle({ layout, config: frozen }), [])
  const live = testConfig({ maturityProject: 1 })
  assert.equal((await runLifecycle({ layout, config: live }))[0].op, 'archive')
  assert.match(await reviveSkill({ layout, name: 'idle-skill' }), /Revived idle-skill/)
  const sidecar = ownedSkills(layout).get('idle-skill').sidecar
  assert.equal(sidecar.status, 'probation')
  assert.equal(sidecar.createdAtRequest, 5)
  await assert.rejects(reviveSkill({ layout, name: 'nope-skill' }), /no archived skill/)
})

test('flushCounters: requests, tool calls, and per-skill usage land on disk', async (t) => {
  const { project, env } = tempProject(t)
  const config = testConfig()
  const layout = testLayout(project, env, config)
  await seed(layout, ['counted-skill'], config)
  const states = await flushCounters({ layout, requests: 2, toolCalls: 7, skills: new Map([['counted-skill', { uses: 2, views: 1 }], ['foreign-skill', { uses: 1, views: 0 }]]) })
  assert.equal(states.project.requests, 2)
  assert.equal(states.global.toolCalls, 7)
  const sidecar = ownedSkills(layout).get('counted-skill').sidecar
  assert.equal(sidecar.uses, 2)
  assert.equal(sidecar.views, 1)
  assert.ok(sidecar.lastUsedAt)
  assert.ok(!existsSync(join(layout.layers.project.skills, 'foreign-skill')))
})

test('index: grouped by category, descriptions clipped, overflow noted', () => {
  const skill = (name, category, uses = 0) => ({ name, layer: 'project', description: `${name} description that is fairly long indeed`, sidecar: { category, uses, createdAtRequest: 0, status: 'probation' } })
  const skills = [skill('b-skill', 'testing', 1), skill('a-skill', 'testing', 9), skill('c-skill', 'git')]
  const text = buildIndex(skills, { indexDescMaxChars: 20, indexMaxLines: 40 }, { project: 10 })
  const lines = text.split('\n')
  assert.equal(lines[0], '<autoharness-index>')
  assert.equal(lines.at(-1), '</autoharness-index>')
  assert.ok(lines.indexOf('[git]') < lines.indexOf('[testing]'))
  assert.ok(lines.findIndex((l) => l.startsWith('- a-skill')) < lines.findIndex((l) => l.startsWith('- b-skill')), 'higher score first')
  assert.ok(lines.filter((l) => l.startsWith('- ')).every((l) => l.split(': ')[1].length <= 20))
  const tight = buildIndex(skills, { indexDescMaxChars: 20, indexMaxLines: 6 }, {}).split('\n')
  assert.ok(tight.length <= 6, tight.join('\n'))
  assert.match(tight.at(-2), /more in the skill catalog/)
  assert.equal(buildIndex([], { indexDescMaxChars: 20, indexMaxLines: 40 }), '')
})

test('evals: code checks, A/B replay with one judge call per criterion, needsPatch', async () => {
  assert.equal(runCodeCheck({ kind: 'contains', pattern: 'PNPM' }, 'use pnpm').pass, true)
  assert.equal(runCodeCheck({ kind: 'not-contains', pattern: 'npm test' }, 'run npm test').pass, false)
  assert.equal(runCodeCheck({ kind: 'regex', pattern: 'filter\\s+api', flags: 'i' }, 'pnpm --FILTER api test').pass, true)

  const llm = scriptedLlm(({ system, user }) => {
    if (system.startsWith('You are a strict grader')) {
      const answer = user.split('ANSWER\n\n')[1].split('\n\nCRITERION')[0]
      return { pass: !answer.includes('npm test'), why: 'checked' }
    }
    return user.startsWith('SKILL') ? 'Run `pnpm --filter api test`.' : 'Run `npm test`.'
  })
  const skill = { name: 'run-api-tests', body: 'Use pnpm --filter api test.' }
  const cases = [{ id: 'k1', task: 'How do I run the api tests?', checks: [{ id: 'c1', kind: 'contains', pattern: 'pnpm --filter api' }, { id: 'c2', kind: 'llm-judge', criterion: 'Does not recommend npm test.' }] }]
  const raw = await evalSkill({ llm, route: { provider: 'p', model: 'm' }, skill, cases })
  assert.equal(raw.cases[0].hashes.withSkill.length, 16)
  const result = scoreResult(raw)
  assert.equal(result.passRate, 1)
  assert.equal(result.baseline, 0)
  assert.equal(result.lift, 1)
  assert.equal(llm.calls.filter((c) => c.system.startsWith('You are a strict grader')).length, 2, 'one judge call per criterion per answer')
  const sidecar = applyEvalResult({ uses: 1 }, result, { evalPassThreshold: 0.5 })
  assert.equal(sidecar.needsPatch, false)
  assert.equal(sidecar.eval.runs, 1)
  const worse = applyEvalResult(sidecar, { ...result, passRate: 0.4, lift: -0.2, failures: [{ check: 'x', why: 'y' }] }, { evalPassThreshold: 0.5 })
  assert.equal(worse.needsPatch, true)
  assert.equal(worse.eval.runs, 2)
  assert.equal(worse.evalFailures.length, 1)
  const report = renderReport('r1', [result])
  assert.match(report, /\| run-api-tests \| 2 \| 100% \| 0% \| 100 pts \| no labels yet \|/)
  assert.match(report, /Baseline answer/)
  assert.equal(await evalSkill({ llm, route: { provider: 'p', model: 'm' }, skill, cases: [] }), null)
})

test('evals: a malformed judge reply fails the check instead of passing it', async () => {
  const llm = scriptedLlm(({ system }) => (system.startsWith('You are a strict grader') ? 'I think yes' : 'answer'))
  const result = scoreResult(await evalSkill({ llm, route: { provider: 'p', model: 'm' }, skill: { name: 's', body: 'b' }, cases: [{ id: 'k', task: 'some task text', checks: [{ id: 'c1', kind: 'llm-judge', criterion: 'Is correct.' }] }] }))
  assert.equal(result.passRate, 0)
  assert.match(result.failures[0].why, /judge error/)
})
