/**
 * Plain-text rendering of captured episode entries, shared by reflector
 * prompts, evidence files, and eval reports.
 *
 * @module dsh-autoharness/transcript
 */

function oneLine(text) {
  return String(text ?? '').replace(/\s*\n\s*/g, ' ⏎ ')
}

/**
 * Render one entry as a single line.
 * @param {{ seq: number, kind: string, [key: string]: unknown }} entry - captured entry.
 * @returns {string} the rendered line.
 */
export function renderEntry(entry) {
  const at = `[${entry.seq}]`
  switch (entry.kind) {
    case 'user':
      return `${at} USER: ${oneLine(entry.text)}`
    case 'context':
      return `${at} CONTEXT(${entry.source}): ${oneLine(entry.text)}`
    case 'assistant':
      return `${at} ASSISTANT${entry.interrupted ? ' (interrupted)' : ''}: ${oneLine(entry.text)}`
    case 'call':
      return `${at} CALL ${entry.name} ${oneLine(entry.args)}`
    case 'result':
      return `${at} RESULT ${entry.name} ${entry.isError ? 'ERROR' : 'ok'}: ${oneLine(entry.text)}`
    case 'turn-end':
      return `${at} TURN END (${entry.reason})`
    default:
      return `${at} ${entry.kind}`
  }
}

/** Render a list of entries, one per line. */
export function renderTranscript(entries) {
  return entries.map(renderEntry).join('\n')
}
