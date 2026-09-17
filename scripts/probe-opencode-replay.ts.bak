/**
 * Replay the real cc-haha proxy transform path against OpenCode Go, then
 * bisect request-shape variants to find which field triggers
 * `json: unknown field "thinking"`.
 *
 * Run: bun scripts/probe-opencode-replay.ts
 * Loads the API key from local providers.json in-process; never prints it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const realDir = path.join(os.homedir(), '.claude', 'cc-haha')
const providers = JSON.parse(fs.readFileSync(path.join(realDir, 'providers.json'), 'utf8')).providers
const opencode = providers.find((p: any) => p.name === 'opencode-glm-5.3-flash')
if (!opencode?.apiKey) throw new Error('opencode provider/key not found')

// Isolated temp config dir so we don't touch the user's real state.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-replay-'))
fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha'), { recursive: true })

const { ProviderService } = await import('../src/server/services/providerService.js')
const { handleProxyRequest } = await import('../src/server/proxy/handler.js')

const svc = new ProviderService()
const provider = await svc.addProvider({
  presetId: 'custom',
  name: 'replay-opencode',
  baseUrl: 'https://opencode.ai/zen/go/',
  apiKey: opencode.apiKey,
  apiFormat: 'openai_chat',
  models: { main: 'glm-5.3-flash', haiku: 'glm-5.3-flash', sonnet: 'glm-5.3-flash', opus: 'glm-5.3-flash' },
})

const TOOLS = [
  { name: 'Bash', description: 'Execute a shell command.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'Read', description: 'Read a file.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
]

const HISTORY = [
  { role: 'user', content: [{ type: 'text', text: 'list files then say ok' }] },
  { role: 'assistant', content: [
    { type: 'thinking', thinking: 'I should call Bash to list files.', signature: 'EqoCCnEIEBAA' },
    { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
  ] },
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_01', content: 'a.txt b.txt' },
  ] },
  { role: 'assistant', content: [
    { type: 'text', text: 'ok' },
  ] },
]

function baseReq(over: Record<string, unknown> = {}) {
  return {
    model: 'glm-5.3-flash',
    max_tokens: 32000,
    system: 'You are a coding agent.',
    messages: [...HISTORY, { role: 'user', content: [{ type: 'text', text: 'say ok' }] }],
    tools: TOOLS,
    thinking: { type: 'enabled', budget_tokens: 31999 },
    output_config: { effort: 'max' },
    stream: true,
    ...over,
  }
}

async function call(label: string, anthropicBody: Record<string, unknown>) {
  const req = new Request(`http://localhost:3456/proxy/providers/${provider.id}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'replay-' + label.replace(/\W/g, '_') },
    body: JSON.stringify(anthropicBody),
  })
  const res = await handleProxyRequest(req, new URL(req.url))
  const text = await res.text()
  const redacted = text.replaceAll(String(opencode.apiKey), '«redacted»')
  const failed = !res.ok || /unknown field|error/.test(redacted.slice(0, 200)) && res.status !== 200
  console.log(`\n### ${label} → HTTP ${res.status}`)
  console.log(redacted.slice(0, 300).replace(/\s+/g, ' '))
  return res.status
}

// Baseline: full realistic CLI-like request.
await call('A0 full realistic', baseReq())
// Bisect: remove suspects one at a time.
await call('A1 no output_config', baseReq({ output_config: undefined }))
await call('A2 no thinking', baseReq({ thinking: undefined, max_tokens: 1024 }))
await call('A3 no tools', { ...baseReq(), tools: undefined })
await call('A4 stream false', baseReq({ stream: false }))
await call('A5 thinking small budget', baseReq({ thinking: { type: 'enabled', budget_tokens: 1024 } }))
await call('A6 no history extras', baseReq({ messages: [{ role: 'user', content: [{ type: 'text', text: 'say ok' }] }] }))
process.exit(0)
