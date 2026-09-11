/**
 * Capture the EXACT upstream body cc-haha's proxy sends for an opencode
 * openai_chat request, so we can diff it against the endpoint's accepted
 * shapes. Run: bun scripts/probe-opencode-capture.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const realDir = path.join(os.homedir(), '.claude', 'cc-haha')
const providers = JSON.parse(fs.readFileSync(path.join(realDir, 'providers.json'), 'utf8')).providers
const opencode = providers.find((p: any) => p.name === 'opencode-glm-5.3-flash')

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-capture-'))
fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'cc-haha'), { recursive: true })

// Patch fetch BEFORE importing handler: capture body, short-circuit the request.
let captured: string | undefined
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).includes('opencode.ai')) {
    captured = typeof init?.body === 'string' ? init.body : undefined
    return new Response(JSON.stringify({ id: 'cap', object: 'chat.completion', created: 0, model: 'glm-5.3-flash', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return realFetch(url, init)
}) as typeof fetch

const { ProviderService } = await import('../src/server/services/providerService.js')
const { handleProxyRequest } = await import('../src/server/proxy/handler.js')

const svc = new ProviderService()
const provider = await svc.addProvider({
  presetId: 'custom', name: 'capture-opencode', baseUrl: 'https://opencode.ai/zen/go/',
  apiKey: opencode.apiKey, apiFormat: 'openai_chat',
  models: { main: 'glm-5.3-flash', haiku: 'glm-5.3-flash', sonnet: 'glm-5.3-flash', opus: 'glm-5.3-flash' },
})

const anthropicBody = {
  model: 'glm-5.3-flash',
  max_tokens: 32000,
  system: 'You are a coding agent.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'say ok' }] }],
  tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
  thinking: { type: 'enabled', budget_tokens: 31999 },
  output_config: { effort: 'max' },
  stream: true,
}

const req = new Request(`http://localhost:3456/proxy/providers/${provider.id}/v1/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-claude-code-session-id': 'cap-1' },
  body: JSON.stringify(anthropicBody),
})
await handleProxyRequest(req, new URL(req.url))

if (!captured) { console.log('NO CAPTURE'); process.exit(1) }
fs.writeFileSync(path.join(os.tmpdir(), 'cc-haha-captured-upstream.json'), JSON.stringify(JSON.parse(captured), null, 2))
const obj = JSON.parse(captured)
console.log('TOP-LEVEL KEYS:', Object.keys(obj).join(', '))
console.log('thinking:', JSON.stringify(obj.thinking))
console.log('reasoning_effort:', JSON.stringify(obj.reasoning_effort))
console.log('stream:', obj.stream, '| stream_options:', JSON.stringify(obj.stream_options))
console.log('messages roles:', obj.messages.map((m: any) => m.role).join(','))
console.log('assistant/user msg extra keys:', JSON.stringify(obj.messages.map((m: any) => Object.keys(m))))
console.log('tools keys:', JSON.stringify(obj.tools?.map((t: any) => Object.keys(t))))
console.log('\nFULL (truncated 2500):\n', captured.slice(0, 2500))
process.exit(0)
