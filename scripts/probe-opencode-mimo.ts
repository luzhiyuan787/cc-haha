/**
 * Bisect which request parameter the OpenCode Zen Go backend rejects for the
 * MiMo models.
 *
 * The gateway answers `Streaming response failed: [400] Invalid request
 * parameters` as an SSE frame and documents no per-model restrictions, so the
 * offending field has to be found by sending the shapes the proxy builds one at
 * a time. Prints HTTP status and a body snippet only; the credential is read
 * from the local provider store and never printed.
 *
 * Run: bun scripts/probe-opencode-mimo.ts [model]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions'
const MODEL = process.argv[2] ?? 'mimo-v2.6-pro'
const CONTROL_MODEL = 'mimo-v2.5'

const realDir = path.join(os.homedir(), '.claude', 'cc-haha')
const providers = JSON.parse(fs.readFileSync(path.join(realDir, 'providers.json'), 'utf8')).providers
const opencode = providers.find((p: any) => /opencode\.ai/i.test(p.baseUrl ?? ''))
if (!opencode) throw new Error('no opencode.ai provider in the local store')
const apiKey: string = opencode.apiKey
if (!apiKey) throw new Error(`provider ${opencode.name} has no apiKey`)

const redact = (text: string) => text.split(apiKey).join('«redacted»').slice(0, 260)

const tool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}

const history = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello', reasoning_content: 'The user greeted me.' },
  { role: 'user', content: 'again' },
]

const variants: { label: string; body: Record<string, unknown> }[] = [
  { label: 'minimal non-stream', body: {} },
  { label: 'minimal stream', body: { stream: true } },
  { label: 'stream + stream_options.include_usage', body: { stream: true, stream_options: { include_usage: true } } },
  { label: 'max_tokens', body: { stream: true, max_tokens: 32000 } },
  { label: 'max_completion_tokens', body: { stream: true, max_completion_tokens: 32000 } },
  { label: 'tools', body: { stream: true, tools: [tool] } },
  { label: 'tools + tool_choice auto', body: { stream: true, tools: [tool], tool_choice: 'auto' } },
  { label: 'tools + forced tool_choice', body: { stream: true, tools: [tool], tool_choice: { type: 'function', function: { name: 'get_weather' } } } },
  { label: 'tools + parallel_tool_calls', body: { stream: true, tools: [tool], parallel_tool_calls: false } },
  { label: 'reasoning_effort high', body: { stream: true, reasoning_effort: 'high' } },
  { label: 'reasoning_effort max', body: { stream: true, reasoning_effort: 'max' } },
  { label: 'thinking toggle', body: { stream: true, thinking: { type: 'disabled' } } },
  { label: 'temperature', body: { stream: true, temperature: 0.2 } },
  { label: 'reasoning_content history', body: { stream: true, messages: history } },
  { label: 'everything (production shape)', body: {
    stream: true,
    stream_options: { include_usage: true },
    tools: [tool],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning_effort: 'high',
    messages: history,
  } },
]

async function send(model: string, label: string, body: Record<string, unknown>) {
  const payload = { model, messages: [{ role: 'user', content: 'Say ok.' }], ...body }
  const started = Date.now()
  let status = 'ERR'
  let snippet = ''
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'cc-haha/probe',
        'x-opencode-session': `cc-haha-probe-${crypto.randomUUID()}`,
      },
      body: JSON.stringify(payload),
    })
    status = String(res.status)
    snippet = redact((await res.text()).replace(/\s+/g, ' '))
  } catch (err) {
    snippet = redact(String(err))
  }
  console.log(`${model.padEnd(16)} ${label.padEnd(36)} HTTP ${status} ${Date.now() - started}ms  ${snippet}`)
  return status
}

console.log(`endpoint ${ENDPOINT}`)
console.log(`credential from ${opencode.name} (not printed)\n`)
console.log('--- control: a model that is known to work ---')
await send(CONTROL_MODEL, 'minimal stream', { stream: true })
await send(CONTROL_MODEL, 'everything (production shape)', variants.at(-1)!.body)

console.log(`\n--- bisect: ${MODEL} ---`)
for (const { label, body } of variants) {
  await send(MODEL, label, body)
}
process.exit(0)
