import { contextBridge, ipcRenderer } from 'electron'
import { createElectronHost } from '../src/lib/desktopHost/electronHost'
import type { DesktopHostUnlisten } from '../src/lib/desktopHost/types'
import type { ElectronEventChannel, ElectronIpcChannel } from './ipc/channels'

const electronHost = createElectronHost({
  invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T> {
    return ipcRenderer.invoke(channel, payload) as Promise<T>
  },
  subscribe<T>(
    channel: ElectronEventChannel,
    handler: (payload: T) => void,
  ): Promise<DesktopHostUnlisten> {
    const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload)
    ipcRenderer.on(channel, listener)
    return Promise.resolve(() => {
      ipcRenderer.removeListener(channel, listener)
    })
  },
})

contextBridge.exposeInMainWorld('desktopHost', electronHost)

type HttpRequestPayload = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

type HttpRequestResponse = {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

// Expose a thin IPC wrapper used by the renderer's loopback-fetch proxy.
// Routing loopback HTTP through the main process sidesteps the Electron
// session proxy configuration that on Windows-with-system-proxy returns
// `TypeError: Failed to fetch` even for 127.0.0.1 (#953 follow-up).
contextBridge.exposeInMainWorld('desktopFetchProxy', {
  httpRequest: (payload: HttpRequestPayload): Promise<HttpRequestResponse> =>
    ipcRenderer.invoke('desktop:runtime:http-request', payload) as Promise<HttpRequestResponse>,
})

declare global {
  interface Window {
    desktopFetchProxy?: {
      httpRequest: (payload: HttpRequestPayload) => Promise<HttpRequestResponse>
    }
  }
}
