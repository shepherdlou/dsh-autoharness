#!/usr/bin/env node
// A stand-in for `dsh headless --patch <file> --json <task>` used by the replay
// tests. It behaves like an agent on the demo project: with the skill
// `run-api-tests` available it runs the right command at once; without it, it
// tries `npm test` first, fails, and then finds the right command.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const patchFile = args[args.indexOf('--patch') + 1]
const task = args.at(-1)
if (process.env.FAKE_DSH_LOG) {
  appendFileSync(process.env.FAKE_DSH_LOG, `${JSON.stringify({
    args,
    cwd: process.cwd(),
    home: process.env.DSH_HOME,
    paused: process.env.AUTOHARNESS_PAUSED,
    patch: readFileSync(patchFile, 'utf8'),
    remotes: existsSync(join(process.cwd(), '.git')) ? readFileSync(join(process.cwd(), '.git', 'config'), 'utf8').includes('[remote') : null,
    hasSkill: existsSync(join(process.cwd(), '.dsh', 'skills', 'run-api-tests', 'SKILL.md')),
  })}\n`)
}
if (process.env.FAKE_DSH_HANG) setInterval(() => {}, 1000)
else {
  const hasSkill = existsSync(join(process.cwd(), '.dsh', 'skills', 'run-api-tests', 'SKILL.md'))
  const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
  out({ type: 'session', sessionId: 'fake', cwd: process.cwd() })
  let id = 0
  const call = (command, result) => {
    const callId = `c${++id}`
    out({ type: 'tool_call', callId, tool: 'bash', input: { command } })
    out({ type: 'tool_result', callId, status: 'completed', result })
    out({ type: 'status', phase: 'step_end', turn: 1, step: id, usage: { inputTokens: 100, outputTokens: 20 } })
  }
  if (hasSkill) call('skill run-api-tests && pnpm --filter api test', '42 passing\n')
  else {
    call('npm test', 'npm ERR! workspaces unsupported\n[exit code: 1]')
    call('cat package.json', '{"packageManager":"pnpm@9"}')
    call('pnpm --filter api test', '42 passing\n')
  }
  out({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
  out({ type: 'final', text: `Ran the api tests for: ${task}. They pass with pnpm --filter api test.` })
}
