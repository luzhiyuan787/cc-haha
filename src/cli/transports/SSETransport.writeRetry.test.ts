import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'

const globals = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
const originalMacro = globals.MACRO

/**
 * Pins the transport's resilience for a flaky model endpoint: a POST that
 * fails with a retryable status (or a network error) is retried up to ten
 * times with exponential backoff before the write gives up and continues,
 * so an unreachable upstream cannot silently drop a long-running task's
 * output. A permanent client error (4xx other than 429) is never retried.
 *
 * The real backoff spans ~50s across ten attempts, so the sleep module is
 * neutralized here — the attempt count is what this suite guards. The mock
 * is registered before SSETransport is dynamically imported for that reason.
 */
mock.module('../../utils/sleep.js', () => ({ sleep: async () => {} }))

const { SSETransport } = await import('./SSETransport.js')

const keepAlive = { type: 'keep_alive' } as const

let server: ReturnType<typeof Bun.serve>
let resetter: ReturnType<typeof Bun.listen>
let posts: Array<{ authorization: string | null; body: string }>
let connections: number
let respond: (attempt: number) => Response | Promise<Response>

beforeAll(() => {
  posts = []
  connections = 0
  // getClaudeCodeUserAgent() reads the build macro; the local-build preload
  // installs it outside tests.
  globals.MACRO = { VERSION: 'test' }

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async req => {
      posts.push({ authorization: req.headers.get('authorization'), body: await req.text() })
      return respond(posts.length)
    },
  })

  // Accepts the TCP connection and resets it without an HTTP response, which
  // is what an unreachable model endpoint looks like to the client.
  resetter = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        connections += 1
        socket.terminate()
      },
      data() {},
      error() {},
      close() {},
    },
  })
})

afterAll(() => {
  server.stop(true)
  resetter.stop(true)
  if (originalMacro === undefined) delete globals.MACRO
  else globals.MACRO = originalMacro
})

function transportFor(port: number): SSETransport {
  return new SSETransport(
    new URL(`http://127.0.0.1:${port}/v2/session/events/stream`),
    {},
    'write-retry-session',
    undefined,
    undefined,
    () => ({ Authorization: 'Bearer test-token' }),
  )
}

describe('SSETransport write retries', () => {
  it('retries a retryable upstream failure ten times before giving up', async () => {
    respond = () => Response.json({ error: 'upstream unavailable' }, { status: 500 })
    posts = []

    await transportFor(server.port).write(keepAlive)

    expect(posts).toHaveLength(10)
    expect(posts.every(post => post.authorization === 'Bearer test-token')).toBe(true)
    expect(posts.every(post => post.body.includes('keep_alive'))).toBe(true)
  })

  it('retries a connection failure the same number of times', async () => {
    connections = 0

    await transportFor(resetter.port).write(keepAlive)

    expect(connections).toBe(10)
  })

  it('stops retrying as soon as the post succeeds', async () => {
    respond = attempt => attempt < 3
      ? Response.json({ error: 'overloaded' }, { status: 429 })
      : Response.json({ ok: true }, { status: 200 })
    posts = []

    await transportFor(server.port).write(keepAlive)

    expect(posts).toHaveLength(3)
  })

  it('never retries a permanent client error', async () => {
    respond = () => Response.json({ error: 'bad request' }, { status: 400 })
    posts = []

    await transportFor(server.port).write(keepAlive)

    expect(posts).toHaveLength(1)
  })
})
