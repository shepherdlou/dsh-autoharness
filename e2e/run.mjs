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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
  step('e2e passed')
} finally {
  if (keep) step(`kept ${ws.work}`)
  else ws.cleanup()
}
