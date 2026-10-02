/**
 * dsh-autoharness — a self-learning skill layer with evidence-backed evals for
 * DeepSeek Harness.
 *
 * Cordis entry: declares the plugin, its config schema, and wires the runtime
 * onto harness events. All behavior lives in `runtime.js` and the modules it
 * composes.
 *
 * @module dsh-autoharness
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { commandDefinitions } from './commands.js'
import { DEFAULTS, REFLECT_MODES, resolveConfig } from './config.js'
import { AutoharnessRuntime } from './runtime.js'

export const name = 'autoharness'

/** `ctx.llm` is required; commands and the skill registry are optional. */
export const inject = ['llm']

const d = DEFAULTS
export const Config = z.object({
  reflectEveryN: z.natural().min(1).default(d.reflectEveryN).description('Reflect after this many top-level tool calls.'),
  consolidateEveryN: z.natural().default(d.consolidateEveryN).description('Run the curator after this many tool calls in the project (0 disables).'),
  digestExchanges: z.natural().default(d.digestExchanges).description('User exchanges kept in a reflection episode.'),
  minEpisodeToolCalls: z.natural().default(d.minEpisodeToolCalls).description('Minimum tool calls for an automatic reflection.'),
  maxIntentsPerRun: z.natural().min(1).default(d.maxIntentsPerRun).description('Most skill changes one run may make.'),
  indexEnabled: z.boolean().default(d.indexEnabled).description('Inject the learned-skill index at session start.'),
  indexDescMaxChars: z.natural().min(8).default(d.indexDescMaxChars),
  indexMaxLines: z.natural().min(4).default(d.indexMaxLines),
  skillDescMaxChars: z.natural().min(20).default(d.skillDescMaxChars),
  skillBodyMaxLines: z.natural().min(1).default(d.skillBodyMaxLines),
  maturityProject: z.natural().default(d.maturityProject).description('Requests of probation for project skills.'),
  maturityGlobal: z.natural().default(d.maturityGlobal).description('Requests of probation for global skills.'),
  capacityProject: z.natural().default(d.capacityProject).description('Mature project skills kept before eviction.'),
  capacityGlobal: z.natural().default(d.capacityGlobal).description('Mature global skills kept before eviction.'),
  graduationSuspended: z.boolean().default(d.graduationSuspended).description('Freeze every archival decision.'),
  globalLayer: z.boolean().default(d.globalLayer).description('Allow cross-project skills under $DSH_HOME/skills.'),
  evalOnPromote: z.boolean().default(d.evalOnPromote).description('Replay eval cases right after a skill lands.'),
  requireEval: z.boolean().default(d.requireEval).description('Reject new skills that carry no eval case.'),
  evalPassThreshold: z.number().min(0).max(1).default(d.evalPassThreshold),
  evalEffort: z.union(['low', 'default']).default(d.evalEffort).description("Reasoning effort for eval answers and judges: 'low' uses the lightest level the model offers."),
  provider: z.string().default(d.provider).description('Model provider for reflection and evals; empty uses the session route.'),
  model: z.string().default(d.model).description('Model id for reflection and evals; empty uses the session route.'),
  paused: z.boolean().default(d.paused),
  reflectMode: z.union(REFLECT_MODES).default(d.reflectMode).description('background: never block the agent; in-turn: finish reflection before the turn closes; auto: in-turn only for one-shot hosts such as dsh headless.'),
  replay: z.union(['manual', 'off']).default(d.replay).description("Allow /autoharness replay: real agent runs of eval cases in a disposable copy ('off' disables)."),
  replayTimeoutMs: z.natural().default(d.replayTimeoutMs).description('Time limit for one replay run.'),
  replayRuns: z.natural().min(1).max(5).default(d.replayRuns).description('Runs per case and variant.'),
  dshCommand: z.string().default(d.dshCommand).description('dsh executable for replays; empty uses the one this host was started from.'),
  replayExtraPatch: z.string().default(d.replayExtraPatch).description('Extra YAML appended to replay children (testing).'),
  keepReplays: z.boolean().default(d.keepReplays).description('Keep replay copies for debugging.'),
  drainTimeoutMs: z.natural().default(d.drainTimeoutMs).description('Milliseconds teardown waits for in-flight reflection and evals (one-shot hosts exit right after answering).'),
  dshHome: z.string().default(d.dshHome).description('Harness home for global skills; empty uses $DSH_HOME or ~/.dsh.'),
})

/**
 * Install autoharness.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Partial<typeof DEFAULTS>} [config] - profile configuration.
 */
export function apply(ctx, config = {}) {
  const runtime = new AutoharnessRuntime({ ctx, config: resolveConfig(config), createUserMessage })
  runtime.attach()
  ctx.inject(['commands'], (ctx) => {
    for (const definition of commandDefinitions(runtime)) ctx.effect(() => ctx.commands.register(definition), `autoharness /${definition.name}`)
  })
}
