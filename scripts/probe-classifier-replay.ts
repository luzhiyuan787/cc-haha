/**
 * End-to-end check: replay the REAL auto-mode classifier request (with its
 * forced `classify_result` tool_choice) through the proxy against OpenCode
 * Console Go, and confirm the CLI still receives a tool_use verdict.
 *
 * Run: bun scripts/probe-classifier-replay.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const realDir = path.join(os.homedir(), '.claude', 'cc-haha')
const providers = JSON.parse(fs.readFileSync(path.join(realDir, 'providers.json'), 'utf8')).providers
const opencode = providers.find((p: any) => p.name === 'opencode-glm-5.3-flash')

// Mirrors what Claude Code's auto-mode permission classifier sends: a forced
// `classify_result` tool call over the pending agent action.
const classifier = {
  model: 'deepseek-v4.1-flash',
  max_tokens: 4096,
  system: 'You are a security classifier for tool calls made by a coding agent. Report the classification result.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'User: 帮我把这个仓库的代码全量更新\nBash rm -rf node_modules && bun install\n' }] },
  ],
  tools: [{
    name: 'classify_result',
    description: 'Report the security classification result for the agent action',
    input_schema: {
      type: 'object',
      properties: {
        thinking: { type: 'string', description: 'Brief step-by-step reasoning.' },
        shouldBlock: { type: 'boolean', description: 'Whether the action should be blocked (true) or allowed (false)' },
        reason: { type: 'string', description: 'Brief explanation of the classification decision' },
      },
      required: ['thinking', 'shouldBlock', 'reason'],
    },
  }],
  tool_choice: { type: 'tool', name: 'classify_result' },
  temperature: 0.2,
  thinking: { type: 'disabled' },
  stream: false,
}

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-cls-'))
fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha'), { recursive: true })

const { ProviderService } = await import('../src/server/services/providerService.js')
const { handleProxyRequest } = await import('../src/server/proxy/handler.js')

const svc = new ProviderService()
// The classifier runs on the provider's haiku model; use it as `main` to
// mirror exactly what the CLI sends in auto mode.
const provider = await svc.addProvider({
  presetId: 'custom', name: 'cls-replay', baseUrl: 'https://opencode.ai/zen/go/',
  apiKey: opencode.apiKey, apiFormat: 'openai_chat',
  models: { main: 'deepseek-v4.1-flash', haiku: 'deepseek-v4.1-flash', sonnet: 'deepseek-v4.1-flash', opus: 'deepseek-v4.1-flash' },
})

const body = { ...classifier, model: 'deepseek-v4.1-flash', stream: false }
const req = new Request(`http://localhost:3456/proxy/providers/${provider.id}/v1/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'cls-replay-1' },
  body: JSON.stringify(body),
})
const res = await handleProxyRequest(req, new URL(req.url))
const text = (await res.text()).replaceAll(String(opencode.apiKey), '«redacted»')
console.log('HTTP', res.status)
try {
  const parsed = JSON.parse(text)
  const blocks = parsed.content ?? []
  console.log('stop_reason:', parsed.stop_reason)
  console.log('blocks:', blocks.map((b: any) => b.type).join(','))
  const tool = blocks.find((b: any) => b.type === 'tool_use')
  if (tool) {
    console.log('tool_use name:', tool.name)
    console.log('tool_use input keys:', Object.keys(tool.input ?? {}).join(','))
    console.log('verdict shouldBlock:', tool.input?.shouldBlock)
  } else {
    console.log('NO TOOL USE — text was:', String(parsed.content?.[0]?.text ?? '').slice(0, 200))
  }
} catch {
  console.log(text.slice(0, 400))
}
process.exit(0)
