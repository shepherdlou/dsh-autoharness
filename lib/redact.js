/**
 * Egress redaction. Everything that leaves the live session — reflector
 * prompts, persisted episodes, evidence files, skill bodies — passes through
 * {@link redact}; the promoter additionally rejects any skill text for which
 * {@link containsSecret} is true.
 *
 * @module dsh-autoharness/redact
 */
import { homedir } from 'node:os'

/** Values that are clearly placeholders, not secrets. */
const PLACEHOLDER = /^(?:\$|<|\{|\[REDACTED|\*{3,}|x{3,}|\.{3})/i

/** [pattern, replacement] pairs; replacements may be functions. */
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google-key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  [/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[REDACTED]@'],
  [/\b(authorization\s*[:=]\s*)(?:(bearer|basic|token)\s+)?([^\s"'`,;]+)/gi, (match, head, scheme, value) =>
    PLACEHOLDER.test(value) ? match : `${head}${scheme ? `${scheme} ` : ''}[REDACTED]`],
  // SHOUTY_ENV_STYLE names ending in a secret word: API_KEY=..., GITHUB_TOKEN: ...
  [/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/g, (match, key, sep, value) =>
    PLACEHOLDER.test(value.replace(/^["']/, '')) || value.length <= 2 ? match : `${key}${sep}[REDACTED]`],
  // config-style keys: password: "...", "api_key": "...", client_secret=...
  [/\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,"'}]+)/gi, (match, key, sep, value) =>
    PLACEHOLDER.test(value.replace(/^["']/, '')) || value.length <= 2 ? match : `${key}${sep}[REDACTED]`],
]

function applyRules(text) {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

/**
 * Redact secrets and the user's home directory from text.
 * @param {string} text - raw text.
 * @param {{ home?: string }} [options] - home directory to fold to `~`.
 * @returns {string} redacted text.
 */
export function redact(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = applyRules(text)
  const home = options.home ?? homedir()
  if (home && home.length > 1) out = out.split(home).join('~')
  return out
}

/**
 * Whether redaction would change the text (ignoring home-directory folding).
 * @param {string} text - candidate skill text.
 * @returns {boolean} true when a secret-shaped value is present.
 */
export function containsSecret(text) {
  return typeof text === 'string' && applyRules(text) !== text
}

/** Redact every string inside a JSON-like value. */
export function redactDeep(value, options = {}) {
  if (typeof value === 'string') return redact(value, options)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, options))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, options)
    return out
  }
  return value
}
