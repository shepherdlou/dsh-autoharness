/**
 * Agentic replay: run a skill's eval cases as real `dsh headless` tasks in a
 * disposable copy of the project, once with the skill and once without, and
 * grade what the agent actually did.
 *
 * The one-shot eval answers without tools or repository access, so it cannot
 * tell whether a skill saves an agent from a failed command. A replay can: the
 * baseline agent sees the same repository, the same other skills, and the
 * same model; only the skill under test differs. Each run reports its tool
 * calls, failed calls, tokens, and time next to the usual checks.
 *
 * Safety. The copy is a fresh clone without remotes, and dsh's file sandbox
 * runs the child with `workspace-write` and approval `never`: writes outside
 * the copy (and /tmp) are denied, escalations are refused. dsh does not
 * isolate the network, so replays only run on request, and tasks that look
 * like external effects (push, deploy, publish, ssh, ...) are skipped.
 *
 * @module dsh-autoharness/replay
 */
import { execFile, spawn } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { VARIANTS, answerHash } from './labels.js'
import { grade, describeCheck } from './evals.js'
import { redact } from './redact.js'

const run = promisify(execFile)

/** Task wording that suggests effects outside the copy; such cases are skipped. */
const EXTERNAL_EFFECTS = [
  [/\bgit\s+push\b|\bpush (?:it|this|the (?:branch|changes|commit))\b/i, 'pushes to a remote'],
  [/\bdeploy/i, 'deploys'],
  [/\b(?:npm|pnpm|yarn|cargo|twine|gem)\s+publish\b|\bpublish (?:the|a|it|to)\b/i, 'publishes a package'],
  [/\b(?:create|cut|tag) (?:a |the )?release\b/i, 'cuts a release'],
  [/\bsend (?:an? |the )?(?:e-?mail|message|notification|slack)\b/i, 'sends a message'],
  [/\bcurl\b[^\n]*-X\s*(?:POST|PUT|PATCH|DELETE)\b/i, 'writes to a remote API'],
  [/\b(?:kubectl|terraform|helm|pulumi)\s+(?:apply|delete|destroy|install|upgrade|up)\b/i, 'changes infrastructure'],
  [/\bssh\b|\bscp\b|\brsync\b[^\n]*:/i, 'reaches another machine'],
  [/\bdrop\s+(?:table|database)\b/i, 'drops data'],
  [/\b(?:in|on|against|to) (?:prod|production)\b/i, 'touches production'],
]

/**
 * Decide whether a task may be replayed.
 * @param {string} task - eval task text.
 * @returns {{ ok: true } | { ok: false, reason: string }} the verdict.
 */
export function screenTask(task) {
  for (const [pattern, label] of EXTERNAL_EFFECTS) if (pattern.test(String(task))) return { ok: false, reason: `the task ${label}; replays only run local work` }
  return { ok: true }
}

/**
 * Find the dsh executable the host itself was started from.
 * @param {{ dshCommand?: string }} config - effective configuration.
 * @returns {{ command: string, args: string[] } | null} how to spawn dsh, or null.
 */
export function locateDsh(config, argv = process.argv, execPath = process.execPath) {
  const viaNode = (path) => ({ command: execPath, args: [path] })
  if (config.dshCommand) return /\.(?:c|m)?js$/.test(config.dshCommand) ? viaNode(resolve(config.dshCommand)) : { command: config.dshCommand, args: [] }
  const entry = argv[1]
  if (entry && (basename(entry) === 'dsh' || /dsh[\\/]lib[\\/]bin\.js$/.test(entry))) return viaNode(entry)
  return null
}

async function git(cwd, args, signal) {
  return run('git', args, { cwd, signal, maxBuffer: 64 * 1024 * 1024 })
}

/**
 * Make a disposable copy of the project: a clone of HEAD plus the working
 * tree's tracked changes and untracked (not ignored) files, without remotes.
 * Top-level dependency directories are linked back read-only (the sandbox
 * denies writes through the link).
 * @param {{ projectRoot: string, dest: string, signal?: AbortSignal }} options - source and destination.
 */
export async function prepareCopy({ projectRoot, dest, signal }) {
  const hasHistory = existsSync(join(projectRoot, '.git')) && await git(projectRoot, ['rev-parse', '--verify', 'HEAD'], signal).then(() => true, () => false)
  if (hasHistory) {
    await git(dirname(dest), ['clone', '--quiet', '--no-hardlinks', projectRoot, dest], signal)
    const { stdout: diff } = await git(projectRoot, ['diff', 'HEAD', '--binary'], signal)
    if (diff.trim()) {
      const patchFile = `${dest}.patch`
      await writeFile(patchFile, diff)
      await git(dest, ['apply', '--whitespace=nowarn', patchFile], signal)
      await rm(patchFile, { force: true })
    }
    const { stdout: untracked } = await git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z'], signal)
    for (const rel of untracked.split('\0').filter(Boolean)) {
      if (rel.startsWith(`.dsh${sep}`) || rel.startsWith('.dsh/')) continue
      await mkdir(dirname(join(dest, rel)), { recursive: true })
      await cp(join(projectRoot, rel), join(dest, rel), { recursive: true }).catch(() => {})
    }
    const { stdout: remotes } = await git(dest, ['remote'], signal)
    for (const remote of remotes.split('\n').filter(Boolean)) await git(dest, ['remote', 'remove', remote], signal)
  } else {
    // Not a repository with commits: copy the files (no history, so no remotes either).
    const skip = new Set(['node_modules', '.git', '.venv', 'venv'])
    await cp(projectRoot, dest, { recursive: true, filter: (src) => !skip.has(basename(src)) && !src.includes(`${sep}.dsh${sep}autoharness`) })
  }
  for (const name of ['node_modules', '.venv', 'venv', 'vendor']) {
    if (existsSync(join(projectRoot, name)) && !existsSync(join(dest, name))) await symlink(join(projectRoot, name), join(dest, name), 'dir')
  }
  await rm(join(dest, '.dsh', 'skills'), { recursive: true, force: true })
  await rm(join(dest, '.dsh', 'autoharness'), { recursive: true, force: true })
}

async function copySkills(from, to, exclude) {
  let names
  try {
    names = await readdir(from, { withFileTypes: true })
  } catch {
    return
  }
  await mkdir(to, { recursive: true })
  for (const entry of names) {
    if (entry.name.startsWith('.') || entry.name === exclude || entry.name === `${exclude}.md`) continue
    await cp(join(from, entry.name), join(to, entry.name), { recursive: true })
  }
}

/** Absolute path of this plugin's entry, loaded paused inside replays so the skill index matches real use. */
export const PLUGIN_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url))

/**
 * The overlay a replay child runs with.
 * @param {object} options - patch inputs.
 * @param {{ provider: string, model: string }} options.route - model route of the session being evaluated.
 * @param {string | null} options.credentialsPath - the user's credentials file, when it exists.
 * @param {string} options.childHome - the child's harness home (its global skill root lives here).
 * @param {string} [options.extraPatch] - extra YAML appended verbatim (tests insert a scripted provider).
 * @returns {string} YAML.
 */
export function childPatch({ route, credentialsPath, childHome, extraPatch }) {
  const q = (value) => JSON.stringify(value)
  const lines = [
    '- insert:',
    '    - id: autoharness-replay',
    `      name: ${q(PLUGIN_ENTRY)}`,
    '      config:',
    '        paused: true',
    `        dshHome: ${q(childHome)}`,
    '- id: agent-default-model',
    '  config:',
    `    provider: ${q(route.provider)}`,
    `    model: ${q(route.model)}`,
    '- id: permission',
    '  config:',
    '    presets:',
    '      replay:',
    '        sandbox: workspace-write',
    '        approval: never',
    '    defaultPreset: replay',
  ]
  if (credentialsPath) lines.push('- id: credentials', '  config:', `    path: ${q(credentialsPath)}`)
  if (extraPatch) lines.push(extraPatch.trimEnd())
  return `${lines.join('\n')}\n`
}

/**
 * Summarize a `dsh headless --json` event stream.
 * @param {object[]} events - parsed JSON lines.
 * @returns {{ final: string, calls: object[], failed: number, tokens: number, endReason: string, transcript: string }} the trace.
 */
export function summarizeTrace(events) {
  const calls = []
  const byId = new Map()
  let final = ''
  let tokens = 0
  let endReason = 'unknown'
  for (const event of events) {
    if (event.type === 'tool_call') {
      const call = { tool: event.tool, input: event.input, ok: null }
      byId.set(event.callId, call)
      calls.push(call)
    } else if (event.type === 'tool_result') {
      const call = byId.get(event.callId)
      if (!call) continue
      const exit = /\[exit code: (\d+)\]/.exec(String(event.result ?? ''))
      call.ok = event.status !== 'error' && (!exit || exit[1] === '0')
      call.result = String(event.result ?? '').slice(0, 300)
    } else if (event.type === 'status' && event.phase === 'step_end' && event.usage) {
      tokens += (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0) + (event.usage.cacheReadTokens ?? 0) + (event.usage.cacheWriteTokens ?? 0)
    } else if (event.type === 'status' && event.phase === 'turn_end') {
      endReason = event.reason?.kind ?? 'unknown'
    } else if (event.type === 'final') {
      final = String(event.text ?? '')
    }
  }
  const describe = (call) => {
    const input = call.input ?? {}
    const what = input.command ?? input.file_path ?? input.name ?? JSON.stringify(input)
    return `- ${call.tool}${call.ok === false ? ' (FAILED)' : ''}: ${String(what).replace(/\s+/g, ' ').slice(0, 300)}`
  }
  const transcript = ['COMMANDS AND TOOLS USED:', ...(calls.length ? calls.map(describe) : ['(none)']), '', 'FINAL ANSWER:', final || '(none)'].join('\n')
  return { final, calls, failed: calls.filter((call) => call.ok === false).length, tokens, endReason, transcript: redact(transcript) }
}

/**
 * Spawn one replay child and collect its JSON events.
 * @returns {Promise<{ events: object[], stderr: string, code: number | null, seconds: number, timedOut: boolean }>} the run.
 */
export function runChild({ dsh, cwd, home, patchFile, task, timeoutMs, signal, env = {} }) {
  const started = Date.now()
  return new Promise((done, fail) => {
    const child = spawn(dsh.command, [...dsh.args, 'headless', '--patch', patchFile, '--json', task], {
      cwd,
      env: { ...process.env, ...env, DSH_HOME: home, AUTOHARNESS_PAUSED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-20_000) })
    const kill = () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    const onAbort = () => kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fail(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return fail(signal.reason ?? new Error('replay aborted'))
      const events = []
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        try {
          events.push(JSON.parse(line))
        } catch {
          // a non-JSON line (stray output) is ignored
        }
      }
      done({ events, stderr, code, seconds: Math.round((Date.now() - started) / 100) / 10, timedOut })
    })
  })
}

/**
 * Run one variant of one case in a fresh copy.
 * @returns {Promise<object>} the trace summary plus run facts.
 */
export async function replayVariant({ layout, skill, variant, task, route, dsh, config, signal, credentialsPath, homeEnvFile }) {
  const root = await mkdtemp(join(tmpdir(), 'autoharness-replay-'))
  try {
    const copy = join(root, 'repo')
    const childHome = join(root, 'home')
    await prepareCopy({ projectRoot: layout.projectRoot, dest: copy, signal })
    const exclude = variant === 'baseline' ? skill.name : undefined
    await copySkills(layout.layers.project.skills, join(copy, '.dsh', 'skills'), skill.layer === 'project' ? exclude : undefined)
    if (layout.layers.global) await copySkills(layout.layers.global.skills, join(childHome, 'skills'), skill.layer === 'global' ? exclude : undefined)
    await mkdir(childHome, { recursive: true })
    if (homeEnvFile) {
      await cp(homeEnvFile, join(childHome, '.env'))
      await chmod(join(childHome, '.env'), 0o600)
    }
    const patchFile = join(root, 'replay.yml')
    await writeFile(patchFile, childPatch({ route, credentialsPath, childHome, extraPatch: config.replayExtraPatch || undefined }))
    const result = await runChild({ dsh, cwd: copy, home: childHome, patchFile, task, timeoutMs: config.replayTimeoutMs, signal })
    const trace = summarizeTrace(result.events)
    const error = result.timedOut ? `timed out after ${Math.round(config.replayTimeoutMs / 1000)}s` : result.events.length === 0 ? `dsh exited ${result.code}: ${redact(result.stderr.trim().split('\n').slice(-3).join(' '))}` : undefined
    return { ...trace, seconds: result.seconds, ...(error ? { error } : {}) }
  } finally {
    if (!config.keepReplays) await rm(root, { recursive: true, force: true })
  }
}

/**
 * Replay every case of one skill, both variants side by side.
 * @param {object} options - replay inputs.
 * @param {object} options.llm - `ctx.llm`, for llm-judge checks.
 * @param {{ provider: string, model: string }} options.route - model route.
 * @param {string} [options.effort] - reasoning effort for judges.
 * @param {object} options.skill - the skill under test (with dir, layer, name).
 * @param {object[]} options.cases - its eval cases.
 * @param {object} options.layout - project layout.
 * @param {Readonly<object>} options.config - effective configuration.
 * @param {{ command: string, args: string[] }} options.dsh - how to spawn dsh.
 * @param {number} [options.runs] - runs per case and variant.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<object | null>} a raw result in the eval shape (`mode: 'agentic'`), or null without runnable cases.
 */
export async function replaySkill({ llm, route, effort, skill, cases, layout, config, dsh, runs = 1, signal }) {
  const credentialsPath = existsSync(join(layout.dshHome, '.credentials.yaml')) ? join(layout.dshHome, '.credentials.yaml') : null
  const homeEnvFile = existsSync(join(layout.dshHome, '.env')) ? join(layout.dshHome, '.env') : null
  const out = []
  const skipped = []
  for (const item of cases) {
    const screen = screenTask(item.task)
    if (!screen.ok) {
      skipped.push({ case: item.id, reason: screen.reason })
      continue
    }
    for (let r = 1; r <= runs; r++) {
      const traces = Object.fromEntries(await Promise.all(VARIANTS.map(async (variant) => [variant, await replayVariant({ layout, skill, variant, task: item.task, route, dsh, config, signal, credentialsPath, homeEnvFile })])))
      const answers = { withSkill: traces.withSkill.transcript, baseline: traces.baseline.transcript }
      const checks = []
      for (const check of item.checks ?? []) {
        const verdicts = {}
        for (const variant of VARIANTS) {
          verdicts[variant] = traces[variant].error
            ? { pass: false, why: `replay failed: ${traces[variant].error}` }
            : await grade(llm, route, check, item.task, answers[variant], signal, effort)
        }
        checks.push({ id: check.id, kind: check.kind, check: describeCheck(check), verdicts })
      }
      const facts = (t) => ({ calls: t.calls.length, failed: t.failed, tokens: t.tokens, seconds: t.seconds, endReason: t.endReason, ...(t.error ? { error: t.error } : {}) })
      out.push({
        id: runs > 1 ? `${item.id}#${r}` : item.id,
        task: item.task,
        evidence: item.evidence,
        answers,
        hashes: { withSkill: answerHash(answers.withSkill), baseline: answerHash(answers.baseline) },
        traces: { withSkill: facts(traces.withSkill), baseline: facts(traces.baseline) },
        checks,
      })
    }
  }
  if (out.length === 0) return skipped.length ? { skill: skill.name, mode: 'agentic', cases: [], skipped } : null
  const sum = (variant, key) => out.reduce((total, c) => total + (c.traces[variant][key] ?? 0), 0)
  const efficiency = Object.fromEntries(VARIANTS.map((variant) => [variant, { calls: sum(variant, 'calls'), failed: sum(variant, 'failed'), tokens: sum(variant, 'tokens'), seconds: Math.round(sum(variant, 'seconds')) }]))
  return { skill: skill.name, mode: 'agentic', cases: out, skipped, efficiency }
}
