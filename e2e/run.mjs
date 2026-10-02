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
// 5. `/autoharness replay` must run the skill's eval task as two real
//    `dsh headless` children in disposable copies, with and without the
//    skill, and record that the run without it hit a failed command.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fakeAgent, fakeCtx, scriptedLlm } from '../test/helpers.js'
import { check, dshInstall, headless, readJson, repo, step, workspace } from './setup.mjs'

const keep = process.argv.includes('--keep')
const { dsh, packages } = dshInstall()
const ws = workspace(packages, readFileSync(join(repo, 'e2e', 'patch.yml'), 'utf8'))
const run = (task) => headless({ dsh, ...ws }, task).answer
const skillDir = join(ws.project, '.dsh', 'skills', 'run-api-tests')

try {
  step('session 1: npm fails, pnpm works')
  run('run the api tests')
  check(existsSync(join(skillDir, 'SKILL.md')), 'skill run-api-tests was learned')
  check(readdirSync(join(skillDir, 'evals')).length === 1, 'one eval case was stored with it')
  check(readdirSync(join(skillDir, 'references')).some((name) => name.startsWith('evidence-')), 'evidence transcript was stored')
  const sidecar = readJson(join(skillDir, '.sidecar.json'))
  check(sidecar.owner === 'autoharness' && sidecar.status === 'probation', 'sidecar marks it self-authored and on probation')
  check(sidecar.eval?.passRate === 1 && sidecar.eval?.baseline === 0, 'eval replay: 100% with the skill vs 0% without')
  check(existsSync(join(ws.project, '.dsh', 'autoharness', 'evals', 'report.md')), 'eval review report was written')

  step('session 2: the index steers the model to the learned skill')
  const answer = run('run the api tests again')
  check(answer.includes('Loaded run-api-tests'), 'the model loaded the skill through the real skill tool')
  check(readJson(join(skillDir, '.sidecar.json')).uses === 1, 'the load was counted')
  check(readJson(join(ws.project, '.dsh', 'autoharness', 'state.json')).requests === 2, 'both requests were counted')
  step('replay: the learned skill vs no skill, as real dsh runs')
  // Give the project a history so the replay copy is a real clone.
  writeFileSync(join(ws.project, 'package.json'), '{ "name": "api-demo", "packageManager": "pnpm@9.0.0" }\n')
  const gitIn = (...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd: ws.project, stdio: 'ignore' })
  execFileSync('rm', ['-rf', join(ws.project, '.git')])
  gitIn('init', '-q')
  gitIn('add', 'package.json')
  gitIn('commit', '-qm', 'init')
  const lib = (name) => import(pathToFileURL(join(ws.plugin, 'lib', name)).href)
  const { AutoharnessRuntime } = await lib('runtime.js')
  const { resolveConfig } = await lib('config.js')
  const { commandDefinitions } = await lib('commands.js')
  // Judge for llm-judge checks: a run with a failed command does not count as using pnpm cleanly.
  const judge = scriptedLlm(({ user }) => ({ pass: !user.split('CRITERION')[0].includes('(FAILED)'), why: 'checked the run for failed commands' }))
  const ctx = fakeCtx({ llm: judge })
  const fakeLlm = JSON.stringify(join(ws.plugin, 'e2e', 'fake-llm.js'))
  const runtime = new AutoharnessRuntime({
    ctx,
    config: resolveConfig({ dshCommand: dsh, replayExtraPatch: `- insert:\n    - id: autoharness-fake-llm\n      name: ${fakeLlm}\n` }, {}),
    createUserMessage: (input) => input,
    env: { ...process.env, DSH_HOME: ws.home },
  })
  for (const definition of commandDefinitions(runtime)) ctx.commands.register(definition)
  const agent = fakeAgent({ header: { id: 'replay-e2e', cwd: ws.project }, requestHeader: () => ({ config: { provider: 'autoharness-fake', model: 'fake-1' } }) })
  const out = await ctx.command('autoharness').handler({ rawInput: 'replay run-api-tests', agent, signal: new AbortController().signal, commandId: 'e2e' })
  step(out.text.split('\n').slice(0, 3).join(' | '))
  check(out.kind === 'success', 'the replay command finished')
  const agentic = readJson(join(skillDir, '.sidecar.json')).eval?.agentic
  check(agentic?.efficiency?.withSkill?.failed === 0 && agentic.efficiency.baseline.failed > 0, `with the skill no command failed; without it ${agentic?.efficiency?.baseline?.failed} did`)
  check(agentic.efficiency.withSkill.calls < agentic.efficiency.baseline.calls, `fewer tool calls with the skill (${agentic.efficiency.withSkill.calls} vs ${agentic.efficiency.baseline.calls})`)
  check(agentic.passRate > agentic.baseline, `checks pass more often with the skill (${agentic.passRate} vs ${agentic.baseline})`)
  check(/Agent replays/.test(readFileSync(join(ws.project, '.dsh', 'autoharness', 'evals', 'report.md'), 'utf8')), 'the report shows the replay')
  await ctx.dispose()
  step('e2e passed')
} finally {
  if (keep) step(`kept ${ws.work}`)
  else ws.cleanup()
}
