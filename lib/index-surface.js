/**
 * IDX: the session-start index of autoharness skills. dsh-tool-skill already
 * publishes the full catalog; this adds a compact, grouped recall hint for the
 * skills learned from this project's own history.
 *
 * @module dsh-autoharness/index-surface
 */
import { survivalScore } from './lifecycle.js'

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`
}

/**
 * Build the index text.
 * @param {object[]} skills - live self-authored skills (with `sidecar`).
 * @param {{ indexDescMaxChars: number, indexMaxLines: number }} config - size limits.
 * @param {Record<string, number>} [requests] - request counters per layer, for ordering.
 * @returns {string} the index, or '' when there is nothing to show.
 */
export function buildIndex(skills, config, requests = {}) {
  const live = skills.filter((skill) => skill.sidecar?.status !== 'archived')
  if (live.length === 0) return ''
  const groups = new Map()
  for (const skill of live) {
    const category = skill.sidecar?.category ?? 'general'
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category).push(skill)
  }
  const header = [
    '<autoharness-index>',
    'Skills learned from earlier work in this workspace. When a task matches one, load it with the `skill` tool before acting; do not act on these summaries alone.',
  ]
  const footer = '</autoharness-index>'
  let budget = Math.max(2, config.indexMaxLines - header.length - 1)
  // Reserve a line for the overflow note when everything cannot fit.
  if (groups.size + live.length > budget) budget -= 1
  const lines = []
  let shown = 0
  for (const category of [...groups.keys()].sort()) {
    const members = groups.get(category).sort((a, b) =>
      survivalScore(b.sidecar, requests[b.layer] ?? 0) - survivalScore(a.sidecar, requests[a.layer] ?? 0) || a.name.localeCompare(b.name))
    if (lines.length + 2 > budget) break
    lines.push(`[${category}]`)
    for (const skill of members) {
      if (lines.length + 1 > budget) break
      lines.push(`- ${skill.name}: ${clip(skill.description, config.indexDescMaxChars)}`)
      shown += 1
    }
  }
  if (shown < live.length) lines.push(`… ${live.length - shown} more in the skill catalog`)
  return [...header, ...lines, footer].join('\n')
}
