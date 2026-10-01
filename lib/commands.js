/**
 * Human-facing commands: `/learn` and `/autoharness <subcommand>`.
 *
 * @module dsh-autoharness/commands
 */
import { relative } from 'node:path'
import { usageRate } from './lifecycle.js'

const USAGE = `Usage: /autoharness <subcommand>
  status            library, counters, and the last run
  eval [skill]      replay eval cases (all skills, or one) and write a review report
  review [skill]    build review.html to label answers and check the graders
  labels <file>     import labels exported from review.html and rescore
  curate            merge near-duplicate skills now
  archive <skill>   archive a self-authored skill
  revive <skill>    restore the latest archived copy (restarts probation)
  pause | resume    stop or restart learning in this project`

const pct = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '—')

/** Summarize a promotion outcome for humans. */
export function formatOutcome(outcome) {
  if (!outcome) return 'Nothing to do.'
  if (outcome.skipped) return `Skipped: ${outcome.skipped}.`
  const lines = [`autoharness run ${outcome.runId ?? '—'}: ${outcome.landed.length} landed, ${outcome.rejected.length} rejected.`]
  for (const item of outcome.landed) lines.push(`  + ${item.op} ${item.name} (${item.layer})${item.from ? ` ← ${item.from.join(', ')}` : ''}`)
  for (const item of outcome.rejected) lines.push(`  x ${item.op ?? '?'} ${item.name ?? ''}: ${item.errors.join('; ')}`)
  for (const result of outcome.evals ?? []) lines.push(`  eval ${result.skill}: ${pct(result.passRate)} with skill vs ${pct(result.baseline)} baseline over ${result.checks} checks`)
  if (outcome.landed.length === 0 && outcome.rejected.length === 0) lines.push('  The reflector found no new reusable lesson.')
  return lines.join('\n')
}

/** Render `/autoharness status`. */
export function formatStatus(status) {
  const { layout, skills, states, lastRun, paused, sinceReflect } = status
  const lines = [`autoharness ${paused ? '(PAUSED) ' : ''}for ${layout.projectRoot}`]
  for (const [layer, state] of Object.entries(states)) lines.push(`  ${layer}: ${state.requests ?? 0} requests, ${state.toolCalls ?? 0} tool calls`)
  lines.push(`  this session: ${sinceReflect} tool calls since the last reflection`)
  if (skills.length === 0) lines.push('  no learned skills yet')
  else {
    lines.push('', '  skill | layer | status | uses | rate | eval | lift | graders')
    for (const skill of skills) {
      const s = skill.sidecar
      const requests = states[skill.layer]?.requests ?? 0
      const lift = typeof s.eval?.lift === 'number' ? `${Math.round(s.eval.lift * 100)} pts` : '—'
      const g = s.eval?.graders
      const graders = g?.labeled ? `${g.agreed}/${g.labeled} agree${g.untrusted?.length ? `, ${g.untrusted.length} distrusted` : ''}` : 'unlabeled'
      lines.push(`  ${skill.name}${s.needsPatch ? ' (needs patch)' : ''} | ${skill.layer} | ${s.status} | ${s.uses ?? 0} | ${usageRate(s, requests).toFixed(3)} | ${pct(s.eval?.passRate)} | ${lift} | ${graders}`)
    }
  }
  if (lastRun) lines.push('', `  last run ${lastRun.id} (${lastRun.trigger}) at ${lastRun.at}: ${lastRun.landed?.length ?? 0} landed, ${lastRun.rejected?.length ?? 0} rejected`)
  return lines.join('\n')
}

function ok(text) {
  return { kind: 'success', text }
}

function fail(error) {
  return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
}

/**
 * Build the command definitions for `ctx.commands.register`.
 * @param {import('./runtime.js').AutoharnessRuntime} runtime - the plugin runtime.
 * @returns {object[]} command definitions.
 */
export function commandDefinitions(runtime) {
  const learn = {
    definitionId: 'dsh-autoharness/learn',
    name: 'learn',
    description: 'Distill the current session into skills now (autoharness)',
    handler: async (invocation) => {
      if (invocation.rawInput.trim()) return { kind: 'error', text: 'Usage: /learn (no arguments)' }
      try {
        return ok(formatOutcome(await runtime.learn(invocation.agent, invocation.signal)))
      } catch (error) {
        return fail(error)
      }
    },
  }
  const autoharness = {
    definitionId: 'dsh-autoharness/autoharness',
    name: 'autoharness',
    description: 'Inspect and steer the self-learning skill layer: status, eval, review, labels, curate, archive, revive, pause, resume',
    handler: async (invocation) => {
      const [sub = 'status', arg, extra] = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      const agent = invocation.agent
      try {
        if (extra !== undefined) return { kind: 'error', text: USAGE }
        switch (sub) {
          case 'status':
            return ok(formatStatus(await runtime.status(agent)))
          case 'eval': {
            const { results, report } = await runtime.evalCommand(agent, arg, invocation.signal)
            if (results.length === 0) return ok(arg ? `No eval cases for "${arg}" (or it is not an autoharness skill).` : 'No skill has eval cases yet.')
            const lines = results.map((r) => `  ${r.skill}: ${pct(r.passRate)} with skill vs ${pct(r.baseline)} baseline over ${r.checks} checks`)
            return ok([`Eval finished for ${results.length} skill(s):`, ...lines, `Review answers and verdicts: ${relative(process.cwd(), report) || report}`].join('\n'))
          }
          case 'review': {
            const { path, skills, answers } = await runtime.review(agent, arg)
            return ok([
              `Review page for ${skills} skill(s), ${answers} graded answers:`,
              `  ${path}`,
              'Open it in a browser, label answers (grader verdicts stay hidden until you do), click "Download labels",',
              'then run /autoharness labels <downloaded file>.',
            ].join('\n'))
          }
          case 'labels': {
            if (!arg) return { kind: 'error', text: USAGE }
            const outcomes = await runtime.importLabels(agent, arg)
            if (outcomes.length === 0) return ok('The file holds no labels.')
            const lines = outcomes.map((o) => (o.skipped
              ? `  ${o.skill}: skipped (${o.skipped})`
              : `  ${o.skill}: +${o.added} labels${o.graders ? `; graders agree ${o.graders.agreed}/${o.graders.labeled}${o.graders.untrusted.length ? `, distrusted: ${o.graders.untrusted.join(', ')}` : ''}; now ${pct(o.passRate)} with skill vs ${pct(o.baseline)} baseline` : ''}`))
            return ok(['Labels imported:', ...lines].join('\n'))
          }
          case 'curate':
            return ok(formatOutcome(await runtime.curateCommand(agent, invocation.signal)))
          case 'archive':
            if (!arg) return { kind: 'error', text: USAGE }
            return ok(await runtime.archive(agent, arg))
          case 'revive':
            if (!arg) return { kind: 'error', text: USAGE }
            return ok(await runtime.revive(agent, arg))
          case 'pause':
            await runtime.setPaused(agent, true)
            return ok('autoharness paused for this project. Skills stay loadable; nothing new is learned.')
          case 'resume':
            await runtime.setPaused(agent, false)
            return ok('autoharness resumed for this project.')
          case 'help':
            return ok(USAGE)
          default:
            return { kind: 'error', text: USAGE }
        }
      } catch (error) {
        return fail(error)
      }
    },
  }
  return [learn, autoharness]
}
