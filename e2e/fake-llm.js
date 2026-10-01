// A scripted LLM provider route for end-to-end runs without an API key.
// Main-agent requests: when the autoharness index names run-api-tests, load it
// with the `skill` tool and answer; otherwise run three bash calls (npm fails,
// pnpm works) and answer. autoharness's own one-shot requests (reflector,
// curator, eval answers, judge) get canned replies.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'autoharness-fake-llm'
export const inject = ['llm']
export const ROUTE = 'autoharness-fake'

const COMMANDS = [
  'echo "npm ERR! workspaces are not supported here" && exit 1',
  'echo "pnpm --filter api test: 42 passing"',
  'echo "git status: clean"',
]

function textOf(message) {
  return (message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

function text(reply) {
  const value = typeof reply === 'string' ? reply : JSON.stringify(reply)
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCall(id, command, tool = 'bash', input = { command, description: 'scripted e2e step' }) {
  const args = JSON.stringify(input)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: tool, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: tool, arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function reply(options) {
  const system = options.system ?? ''
  const user = textOf(options.messages.find((m) => m.role === 'user'))
  if (system.startsWith('You are the reflector')) {
    if (!user.includes('pnpm --filter api test') || user.includes('"name": "run-api-tests"')) return text({ intents: [{ op: 'none', reason: 'nothing new' }] })
    const [, from, to] = /seq (\d+)\.\.(\d+)\)/.exec(user)
    return text({ intents: [{
      op: 'create', name: 'run-api-tests', scope: 'project', category: 'testing',
      description: 'Run the api package tests with pnpm workspace filtering.',
      body: 'Run `pnpm --filter api test` from the repo root; plain `npm test` fails in this workspace.',
      reason: 'npm test failed, the pnpm filter worked', evidence: { fromSeq: Number(from), toSeq: Number(to) },
      evals: [{ task: 'How do I run the api tests in this repository?', checks: [{ kind: 'contains', pattern: 'pnpm --filter api test' }, { kind: 'llm-judge', criterion: 'The answer uses pnpm rather than npm.' }] }],
    }] })
  }
  if (system.startsWith('You are the curator')) return text({ intents: [{ op: 'none', reason: 'tidy' }] })
  if (system.startsWith('You are a strict grader')) return text({ pass: user.split('CRITERION')[0].includes('pnpm'), why: 'checked for pnpm' })
  if (system.startsWith('You are a coding agent working')) return text(user.startsWith('SKILL') ? 'Run `pnpm --filter api test`.' : 'Run `npm test`.')
  if (system) return text('fake title')
  const toolResults = options.messages.filter((m) => m.role === 'tool').length
  const indexed = options.messages.some((m) => m.role === 'user' && textOf(m).includes('<autoharness-index>') && textOf(m).includes('run-api-tests'))
  if (indexed) {
    if (toolResults === 0) return toolCall('call_skill', '', 'skill', { name: 'run-api-tests' })
    return text('Loaded run-api-tests: use `pnpm --filter api test`.')
  }
  if (toolResults < COMMANDS.length) return toolCall(`call_${toolResults + 1}`, COMMANDS[toolResults])
  return text('Done: the api tests pass with `pnpm --filter api test`.')
}

class FakeAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'autoharness fake' }
  }
  async *stream(options) {
    for (const chunk of reply(options)) yield chunk
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter([ROUTE], new FakeAdapter()), 'fake llm route')
}
