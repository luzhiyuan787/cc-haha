import path from 'node:path'

export type RendererEntryOptions = {
  isPackaged: boolean
  appRoot: string
  /**
   * `app.asar.unpacked` root for packaged builds. The renderer ships via
   * `asarUnpack: ["dist/**"]` (the sidecar server reads it from disk for the
   * h5 route), so loading it through the asar placeholder relies on Electron's
   * asar→unpacked remap — which fails to resolve on Windows installs with
   * non-ASCII paths. Pointing file:// directly at the unpacked copy skips
   * that remap entirely.
   */
  unpackedRoot?: string
  env?: NodeJS.ProcessEnv
}

export function isAllowedDevRendererUrl(input: string): boolean {
  try {
    const parsed = new URL(input)
    if (parsed.protocol !== 'http:') return false
    return parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]'
  } catch {
    return false
  }
}

export function resolveRendererEntry(options: RendererEntryOptions): string {
  const devUrl = options.env?.ELECTRON_RENDERER_URL?.trim()
  if (!options.isPackaged && devUrl) {
    if (!isAllowedDevRendererUrl(devUrl)) {
      throw new Error(`Refusing non-local Electron renderer URL: ${devUrl}`)
    }
    return devUrl
  }
  return path.join(
    options.unpackedRoot ?? options.appRoot,
    'dist',
    'index.html',
  )
}
