/**
 * Configuration: defaults, patch-file config, and `AUTOHARNESS_*` environment
 * overrides. Precedence is env > config > defaults, so a shell export can tune
 * a running profile without editing its patch file (same knobs as upstream
 * autoharness where a knob exists there).
 *
 * @module dsh-autoharness/config
 */

/** Every tunable and its default. */
export const DEFAULTS = Object.freeze({
  // cadence
  reflectEveryN: 50,
  consolidateEveryN: 250,
  digestExchanges: 20,
  minEpisodeToolCalls: 8,
  maxIntentsPerRun: 3,
  // recall
  indexEnabled: true,
  indexDescMaxChars: 60,
  indexMaxLines: 40,
  skillDescMaxChars: 1024,
  skillBodyMaxLines: 25,
  // lifecycle
  maturityProject: 100,
  maturityGlobal: 300,
  capacityProject: 50,
  capacityGlobal: 20,
  graduationSuspended: false,
  globalLayer: true,
  // evals
  evalOnPromote: true,
  requireEval: true,
  evalPassThreshold: 0.5,
  // model route override; empty means "the session's current route"
  provider: '',
  model: '',
  // kill switch
  paused: false,
  // when reflection runs: 'background' never blocks the agent; 'in-turn' holds the
  // turn open until it finishes; 'auto' picks in-turn only for one-shot hosts (dsh headless)
  reflectMode: 'auto',
  // how long teardown waits for in-flight reflections and evals before aborting them
  drainTimeoutMs: 60_000,
  // where global skills and state live; empty means $DSH_HOME or ~/.dsh
  dshHome: '',
})

export const REFLECT_MODES = Object.freeze(['auto', 'background', 'in-turn'])

/** Environment variable for each key, with the value kind used to parse it. */
const ENV = {
  reflectEveryN: ['AUTOHARNESS_REFLECT_EVERY_N', 'int'],
  consolidateEveryN: ['AUTOHARNESS_CONSOLIDATE_EVERY_N', 'int'],
  digestExchanges: ['AUTOHARNESS_DIGEST_EXCHANGES', 'int'],
  minEpisodeToolCalls: ['AUTOHARNESS_MIN_EPISODE_TOOL_CALLS', 'int'],
  maxIntentsPerRun: ['AUTOHARNESS_MAX_INTENTS_PER_RUN', 'int'],
  indexEnabled: ['AUTOHARNESS_INDEX_SUSPENDED', 'not-bool'],
  indexDescMaxChars: ['AUTOHARNESS_INDEX_DESC_MAX_CHARS', 'int'],
  indexMaxLines: ['AUTOHARNESS_INDEX_MAX_LINES', 'int'],
  skillDescMaxChars: ['AUTOHARNESS_SKILL_DESC_MAX_CHARS', 'int'],
  skillBodyMaxLines: ['AUTOHARNESS_SKILL_BODY_MAX_LINES', 'int'],
  maturityProject: ['AUTOHARNESS_MATURITY_PROJECT', 'int'],
  maturityGlobal: ['AUTOHARNESS_MATURITY_GLOBAL', 'int'],
  capacityProject: ['AUTOHARNESS_CAPACITY_PROJECT', 'int'],
  capacityGlobal: ['AUTOHARNESS_CAPACITY_GLOBAL', 'int'],
  graduationSuspended: ['AUTOHARNESS_GRADUATION_SUSPENDED', 'bool'],
  globalLayer: ['AUTOHARNESS_GLOBAL_LAYER', 'bool'],
  evalOnPromote: ['AUTOHARNESS_EVAL_ON_PROMOTE', 'bool'],
  requireEval: ['AUTOHARNESS_REQUIRE_EVAL', 'bool'],
  evalPassThreshold: ['AUTOHARNESS_EVAL_PASS_THRESHOLD', 'ratio'],
  provider: ['AUTOHARNESS_PROVIDER', 'string'],
  model: ['AUTOHARNESS_MODEL', 'string'],
  paused: ['AUTOHARNESS_PAUSED', 'bool'],
  drainTimeoutMs: ['AUTOHARNESS_DRAIN_TIMEOUT_MS', 'int'],
  reflectMode: ['AUTOHARNESS_REFLECT_MODE', 'string'],
  dshHome: ['DSH_HOME', 'string'],
}

const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])

function parseBool(raw, name) {
  const value = raw.trim().toLowerCase()
  if (TRUE.has(value)) return true
  if (FALSE.has(value)) return false
  throw new Error(`autoharness: ${name} must be a boolean (1/0, true/false, yes/no, on/off), got "${raw}"`)
}

function parseEnv(raw, kind, name) {
  switch (kind) {
    case 'int': {
      const value = Number(raw)
      if (!Number.isInteger(value) || value < 0) throw new Error(`autoharness: ${name} must be a non-negative integer, got "${raw}"`)
      return value
    }
    case 'ratio': {
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`autoharness: ${name} must be a number in [0, 1], got "${raw}"`)
      return value
    }
    case 'bool':
      return parseBool(raw, name)
    case 'not-bool':
      return !parseBool(raw, name)
    default:
      return raw.trim()
  }
}

/**
 * Resolve the effective configuration.
 * @param {Partial<typeof DEFAULTS>} [config] - values from the profile patch.
 * @param {Record<string, string | undefined>} [env] - environment to read overrides from.
 * @returns {Readonly<typeof DEFAULTS>} the frozen effective configuration.
 */
export function resolveConfig(config = {}, env = process.env) {
  const out = { ...DEFAULTS }
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!(key in DEFAULTS) || value === undefined || value === null) continue
    if (typeof value !== typeof DEFAULTS[key]) throw new Error(`autoharness: config.${key} must be a ${typeof DEFAULTS[key]}`)
    out[key] = value
  }
  for (const [key, [name, kind]] of Object.entries(ENV)) {
    const raw = env[name]
    if (raw === undefined || raw === '') continue
    out[key] = parseEnv(raw, kind, name)
  }
  if (!REFLECT_MODES.includes(out.reflectMode)) throw new Error(`autoharness: reflectMode must be one of ${REFLECT_MODES.join(', ')}`)
  if (out.reflectEveryN < 1) throw new Error('autoharness: reflectEveryN must be at least 1')
  if (out.skillBodyMaxLines < 1 || out.skillDescMaxChars < 20) throw new Error('autoharness: skill size limits are too small')
  return Object.freeze(out)
}
