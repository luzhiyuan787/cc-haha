import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { handleProxyRequest } from '../proxy/handler.js'
import { ProviderService } from '../services/providerService.js'
import { clearTraceCaptureStateForTests, traceCaptureService } from '../services/traceCaptureService.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let tmpDir: string
let originalConfigDir: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-opencode-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetSettingsCache()
  clearTraceCaptureStateForTests()
}

async function teardown() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  resetSettingsCache()
  clearTraceCaptureStateForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
}

const SESSION_ID = 'aaaa1111-bbbb-cccc-dddd-eeee2222ffff'

async function makeProvider(
  apiFormat: 'openai_chat' | 'openai_responses',
  baseUrl: string,
  presetId = 'custom',
) {
  const svc = new ProviderService()
  return svc.addProvider({
    presetId,
    name: `opencode-${apiFormat}`,
    baseUrl,
    apiKey: 'sk-test',
    apiFormat,
    models: {
      main: 'model-main',
      haiku: 'model-main',
      sonnet: 'model-main',
      opus: 'model-main',
    },
  })
}

function mockUpstreamCaptureHeaders(body: unknown) {
  const originalFetch = globalThis.fetch
  let capturedHeaders: Record<string, string> | undefined
  let capturedBody: Record<string, unknown> | undefined
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries())
    if (typeof init?.body === 'string') {
      try { capturedBody = JSON.parse(init.body) } catch { /* non-JSON body */ }
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return {
    getCapturedHeaders: () => capturedHeaders,
    getCapturedBody: () => capturedBody,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

function chatCompletionBody() {
  return {
    id: 'chatcmpl-opencode',
    object: 'chat.completion',
    created: 0,
    model: 'model-main',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

function responsesBody() {
  return {
    id: 'resp_opencode',
    object: 'response',
    status: 'completed',
    model: 'model-main',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
    }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

async function callProxy(providerId: string, sessionIdHeader?: string, extraBody: Record<string, unknown> = {}) {
  const req = new Request(
    `http://localhost:3456/proxy/providers/${providerId}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionIdHeader ? { 'x-claude-code-session-id': sessionIdHeader } : {}),
      },
      body: JSON.stringify({
        model: 'model-main',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello' }],
        ...extraBody,
      }),
    },
  )
  return handleProxyRequest(req, new URL(req.url))
}

// Proxy trace writes are fire-and-forget; wait until the call is finalized so
// teardown (rm of the tmp config dir) cannot race the in-flight trace append.
async function waitForTraceCallDone(sessionId: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const trace = await traceCaptureService.getSessionTrace(sessionId)
    const call = trace.calls[0]
    if (call && (call.response || call.error)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('proxy opencode request adaptation', () => {
  beforeEach(setup)
  afterEach(teardown)

  // The preset's own template is what the gateway contract is written against;
  // providers.test.ts covers it end-to-end. These pin the host fallback that
  // keeps records saved before that preset from reaching the gateway anonymously
  // and being answered 400 MissingSessionID.
  test('a custom record on an opencode host still sends the gateway identity headers', async () => {
    const provider = await makeProvider('openai_chat', 'https://opencode.ai/zen/go/')
    const upstream = mockUpstreamCaptureHeaders(chatCompletionBody())
    try {
      const res = await callProxy(provider.id, SESSION_ID)
      expect(res.status).toBe(200)
      const headers = upstream.getCapturedHeaders()
      expect(headers?.['x-opencode-session']).toBe(SESSION_ID)
      expect(headers?.['user-agent']).toStartWith('cc-haha/')
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })

  test('the fallback also covers the responses lane', async () => {
    const provider = await makeProvider('openai_responses', 'https://opencode.ai/zen/go/')
    const upstream = mockUpstreamCaptureHeaders(responsesBody())
    try {
      const res = await callProxy(provider.id, SESSION_ID)
      expect(res.status).toBe(200)
      const headers = upstream.getCapturedHeaders()
      expect(headers?.['x-opencode-session']).toBe(SESSION_ID)
      expect(headers?.['user-agent']).toStartWith('cc-haha/')
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })

  test('omits opencode headers for non-opencode base urls', async () => {
    const provider = await makeProvider('openai_chat', 'https://api.example.com')
    const upstream = mockUpstreamCaptureHeaders(chatCompletionBody())
    try {
      const res = await callProxy(provider.id, SESSION_ID)
      expect(res.status).toBe(200)
      const headers = upstream.getCapturedHeaders()
      expect(headers?.['x-opencode-session']).toBeUndefined()
      expect(headers?.['user-agent']).toBeUndefined()
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })

  test('still adds identifiable user agent when no session id is present', async () => {
    const provider = await makeProvider('openai_chat', 'https://opencode.ai/zen/go/')
    const upstream = mockUpstreamCaptureHeaders(chatCompletionBody())
    try {
      const res = await callProxy(provider.id)
      expect(res.status).toBe(200)
      const headers = upstream.getCapturedHeaders()
      // An empty session id would be worse than none: the gateway binds it to a
      // conversation, so omit the field rather than invent an identity.
      expect(headers?.['x-opencode-session']).toBeUndefined()
      expect(headers?.['user-agent']).toStartWith('cc-haha/')
    } finally {
      upstream.restore()
    }
  })

  test('a preset that declares its own headers wins over the host fallback', async () => {
    const provider = await makeProvider('openai_chat', 'https://opencode.ai/zen/go/', 'opencode-go')
    const upstream = mockUpstreamCaptureHeaders(chatCompletionBody())
    try {
      const res = await callProxy(provider.id, SESSION_ID)
      expect(res.status).toBe(200)
      expect(upstream.getCapturedHeaders()?.['x-opencode-session']).toBe(SESSION_ID)
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })

  test('never forwards the non-standard thinking toggle to opencode chat (Console Go strict backends reject it)', async () => {
    const provider = await makeProvider('openai_chat', 'https://opencode.ai/zen/go/')
    const upstream = mockUpstreamCaptureHeaders(chatCompletionBody())
    try {
      const res = await callProxy(provider.id, SESSION_ID, {
        thinking: { type: 'enabled', budget_tokens: 31999 },
        tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
        stream: true,
      })
      expect(res.status).toBe(200)
      const body = upstream.getCapturedBody()
      expect(body?.thinking).toBeUndefined()
      // Reasoning intent still maps onto the standard field.
      expect(body?.reasoning_effort).toBe('high')
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })

  test('degrades a forced tool_choice to auto for opencode chat (thinking backends reject forcing)', async () => {
    const provider = await makeProvider('openai_chat', 'https://opencode.ai/zen/go/')
    const upstream = mockUpstreamCaptureHeaders(chatCompletionBody())
    try {
      const res = await callProxy(provider.id, SESSION_ID, {
        tools: [{
          name: 'classify_result',
          description: 'Report the classification',
          input_schema: { type: 'object', properties: { shouldBlock: { type: 'boolean' } } },
        }],
        tool_choice: { type: 'tool', name: 'classify_result' },
      })
      expect(res.status).toBe(200)
      expect(upstream.getCapturedBody()?.tool_choice).toBe('auto')
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })

  test('degrades a forced tool_choice to auto for opencode responses', async () => {
    const provider = await makeProvider('openai_responses', 'https://opencode.ai/zen/go/')
    const upstream = mockUpstreamCaptureHeaders(responsesBody())
    try {
      const res = await callProxy(provider.id, SESSION_ID, {
        tools: [{
          name: 'classify_result',
          description: 'Report the classification',
          input_schema: { type: 'object', properties: { shouldBlock: { type: 'boolean' } } },
        }],
        tool_choice: { type: 'tool', name: 'classify_result' },
      })
      expect(res.status).toBe(200)
      expect(upstream.getCapturedBody()?.tool_choice).toBe('auto')
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })

  test('keeps a forced tool_choice on non-opencode providers', async () => {
    const provider = await makeProvider('openai_chat', 'https://api.example.com')
    const upstream = mockUpstreamCaptureHeaders(chatCompletionBody())
    try {
      const res = await callProxy(provider.id, SESSION_ID, {
        tools: [{
          name: 'classify_result',
          description: 'Report the classification',
          input_schema: { type: 'object', properties: { shouldBlock: { type: 'boolean' } } },
        }],
        tool_choice: { type: 'tool', name: 'classify_result' },
      })
      expect(res.status).toBe(200)
      expect(upstream.getCapturedBody()?.tool_choice).toEqual({
        type: 'function',
        function: { name: 'classify_result' },
      })
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })

  test('degrades the extended reasoning efforts the MiMo backends reject', async () => {
    const provider = await makeProvider('openai_chat', 'https://opencode.ai/zen/go/')
    const upstream = mockUpstreamCaptureHeaders(chatCompletionBody())
    try {
      // Claude Code expresses the GLM/thinking profile default as output_config
      // effort; both extended spellings must reach the wire as a value the
      // backend takes (live bisect: low/high pass, max answers
      // `Streaming response failed: [400] Invalid request parameters`).
      for (const effort of ['max', 'xhigh'] as const) {
        const res = await callProxy(provider.id, SESSION_ID, { output_config: { effort } })
        expect(res.status).toBe(200)
        expect(upstream.getCapturedBody()?.reasoning_effort, effort).toBe('high')
      }
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })

  test('keeps the reasoning effort a non-opencode provider asked for', async () => {
    const provider = await makeProvider('openai_chat', 'https://api.example.com')
    const upstream = mockUpstreamCaptureHeaders(chatCompletionBody())
    try {
      const res = await callProxy(provider.id, SESSION_ID, { output_config: { effort: 'max' } })
      expect(res.status).toBe(200)
      expect(upstream.getCapturedBody()?.reasoning_effort).toBe('max')
      await waitForTraceCallDone(SESSION_ID)
    } finally {
      upstream.restore()
    }
  })
})
