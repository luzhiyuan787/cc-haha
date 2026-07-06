import React from 'react'
import ReactDOM from 'react-dom/client'
import './theme/globals.css'
import { initializeAppZoom } from './lib/appZoom'
import { initializeTouchH5 } from './lib/touchH5'
import { runDesktopPersistenceMigrations } from './lib/persistenceMigrations'

declare global {
  interface Window {
    __CC_HAHA_BOOTSTRAPPED__?: boolean
    __CC_HAHA_SHOW_STARTUP_ERROR__?: (reason: unknown) => void
    desktopFetchProxy?: {
      httpRequest: (payload: {
        url: string,
        method?: string,
        headers?: Record<string, string>,
        body?: string,
      }) => Promise<{
        status: number,
        statusText: string,
        headers: Record<string, string>,
        body: string,
      }>
    }
  }
}

type DesktopBootstrapModules = [
  { App: React.ComponentType },
  { ErrorBoundary: React.ComponentType<{ children: React.ReactNode }> },
  { installClientDiagnosticsCapture: () => void },
  { initializeTheme: () => void },
]

function loadDesktopBootstrapModules() {
  return Promise.all([
    import('./App'),
    import('./components/ErrorBoundary'),
    import('./lib/diagnosticsCapture'),
    import('./stores/uiStore'),
  ])
}

export async function bootstrapDesktopApp(
  root: HTMLElement | null = document.getElementById('root'),
  loadModules: () => Promise<DesktopBootstrapModules> = loadDesktopBootstrapModules,
) {
  try {
    const [{ App }, { ErrorBoundary }, { installClientDiagnosticsCapture }, { initializeTheme }] = await loadModules()
    initializeTheme()
    installClientDiagnosticsCapture()

    if (!root) {
      throw new Error('Desktop root element not found')
    }

    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    )
    window.__CC_HAHA_BOOTSTRAPPED__ = true
  } catch (error) {
    console.error('[desktop] Failed to bootstrap app', error)
    if (root) {
      if (window.__CC_HAHA_SHOW_STARTUP_ERROR__) {
        window.__CC_HAHA_SHOW_STARTUP_ERROR__(error)
      } else {
        root.textContent = error instanceof Error ? error.message : String(error)
      }
    }
  }
}

// Install a loopback fetch proxy before anything else touches `window.fetch`.
// In the Electron renderer the default `fetch` honors the app/session proxy
// configuration and on Windows machines with a system proxy set it returns
// `TypeError: Failed to fetch` even for 127.0.0.1, which broke startup for
// users on corp networks. We delegate loopback requests to the main process,
// where `http.request` bypasses proxy env vars entirely (#953 follow-up).
installLoopbackFetchProxy()

runDesktopPersistenceMigrations()
initializeTouchH5()
void initializeAppZoom()

void bootstrapDesktopApp()

function installLoopbackFetchProxy(): void {
  const proxy = window.desktopFetchProxy
  if (!proxy) return
  const nativeFetch: typeof fetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlString = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url
    let hostname = ''
    try { hostname = new URL(urlString, window.location.href).hostname } catch { hostname = '' }
    if (!isLoopbackHost(hostname)) {
      return nativeFetch(input, init)
    }
    return dispatchViaMainProcess(proxy, input, init)
  }) as typeof fetch
}

async function dispatchViaMainProcess(
  proxy: NonNullable<Window['desktopFetchProxy']>,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const request = input instanceof Request ? input : null
  const urlString = request ? request.url : String(input)
  const parsed = new URL(urlString)
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
  const headersObj: Record<string, string> = {}
  const srcHeaders = init?.headers ?? (request ? request.headers : undefined)
  if (srcHeaders) {
    if (srcHeaders instanceof Headers) {
      srcHeaders.forEach((value, key) => { headersObj[key] = value })
    } else if (Array.isArray(srcHeaders)) {
      for (const [k, v] of srcHeaders) headersObj[k] = v
    } else {
      for (const [k, v] of Object.entries(srcHeaders)) headersObj[k] = String(v)
    }
  }
  let body: string | undefined
  if (init?.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : String(init.body)
  } else if (request && request.body) {
    body = await request.text()
  }
  const response = await proxy.httpRequest({
    url: parsed.toString(),
    method,
    headers: headersObj,
    body,
  })
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function isLoopbackHost(hostname: string): boolean {
  if (!hostname) return false
  const lower = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (lower === 'localhost' || lower === '::1' || lower === '[::1]') return true
  if (lower.startsWith('127.')) {
    const parts = lower.split('.')
    if (parts.length === 4 && parts[0] === '127') {
      return parts.every(p => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
    }
  }
  return false
}
