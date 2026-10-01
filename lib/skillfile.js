/**
 * SKILL.md rendering and parsing. Frontmatter values are written as JSON
 * scalars and flow mappings, which YAML 1.2 reads verbatim, so the plugin needs
 * no YAML dependency and dsh-skill-filesystem still parses every file it writes.
 *
 * @module dsh-autoharness/skillfile
 */

/** Public skill-name grammar shared with `@deepseek-ai/dsh-skill`. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether a string is a valid kebab-case skill name of at most 64 characters. */
export function isSkillName(name) {
  return typeof name === 'string' && name.length <= 64 && SKILL_NAME.test(name)
}

/**
 * Render a SKILL.md file.
 * @param {{ name: string, description: string, whenToUse?: string, metadata?: object, body: string }} skill - skill content.
 * @returns {string} file text.
 */
export function renderSkill(skill) {
  const lines = ['---', `name: ${JSON.stringify(skill.name)}`, `description: ${JSON.stringify(skill.description)}`]
  if (skill.whenToUse) lines.push(`whenToUse: ${JSON.stringify(skill.whenToUse)}`)
  if (skill.metadata) lines.push(`metadata: ${JSON.stringify(skill.metadata)}`)
  lines.push('---', '', skill.body.trim(), '')
  return lines.join('\n')
}

function parseScalar(raw) {
  const value = raw.trim()
  if (value === '') return ''
  if (/^["{[]/.test(value) || /^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(value)) {
    try {
      return JSON.parse(value)
    } catch {
      // fall through to the plain-scalar reading
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

/**
 * Parse a SKILL.md file. Handles the JSON-scalar frontmatter this plugin
 * writes and plain `key: value` lines from hand-written skills; nested YAML
 * blocks in foreign files are skipped, which is enough for name lookups.
 * @param {string} text - file text.
 * @returns {{ frontmatter: Record<string, unknown>, body: string } | null} parsed parts, or null without frontmatter.
 */
export function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return null
  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):(.*)$/.exec(line)
    if (!kv) continue
    frontmatter[kv[1]] = parseScalar(kv[2])
  }
  return { frontmatter, body: match[2].replace(/^\r?\n/, '').trimEnd() }
}

/** Count the non-empty lines of a body. */
export function bodyLineCount(body) {
  return body.split(/\r?\n/).filter((line) => line.trim().length > 0).length
}
