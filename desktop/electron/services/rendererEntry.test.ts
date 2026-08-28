import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { isAllowedDevRendererUrl, resolveRendererEntry } from './rendererEntry'

describe('Electron renderer entry resolution', () => {
  it('allows only local http renderer URLs in development', () => {
    expect(isAllowedDevRendererUrl('http://127.0.0.1:1420')).toBe(true)
    expect(isAllowedDevRendererUrl('http://localhost:1420')).toBe(true)
    expect(isAllowedDevRendererUrl('http://[::1]:1420')).toBe(true)
    expect(isAllowedDevRendererUrl('https://127.0.0.1:1420')).toBe(false)
    expect(isAllowedDevRendererUrl('http://example.com')).toBe(false)
    expect(isAllowedDevRendererUrl('file:///tmp/index.html')).toBe(false)
  })

  it('ignores ELECTRON_RENDERER_URL once the app is packaged', () => {
    expect(resolveRendererEntry({
      isPackaged: true,
      appRoot: '/Applications/Test.app/Contents/Resources/app.asar',
      unpackedRoot: '/Applications/Test.app/Contents/Resources/app.asar.unpacked',
      env: { ELECTRON_RENDERER_URL: 'http://127.0.0.1:1420' },
    })).toBe(path.join('/Applications/Test.app/Contents/Resources/app.asar.unpacked', 'dist', 'index.html'))
  })

  it('loads the renderer from the unpacked dist copy it ships via asarUnpack', () => {
    // dist/** is asarUnpacked, and Electron's asar→unpacked remap breaks on
    // Windows non-ASCII install paths (中文 安装目录 ERR_FILE_NOT_FOUND), so
    // packaged builds must resolve dist/index.html under app.asar.unpacked.
    const entry = resolveRendererEntry({
      isPackaged: true,
      appRoot: 'C:\\Program Files\\中文 安装目录\\Claude Code Haha\\resources\\app.asar',
      unpackedRoot: 'C:\\Program Files\\中文 安装目录\\Claude Code Haha\\resources\\app.asar.unpacked',
      env: {},
    })
    expect(entry).toContain('app.asar.unpacked')
    expect(entry).not.toContain(`app.asar${path.sep}`)
  })

  it('rejects non-local development renderer URLs', () => {
    expect(() => resolveRendererEntry({
      isPackaged: false,
      appRoot: '/repo/desktop',
      env: { ELECTRON_RENDERER_URL: 'http://example.com' },
    })).toThrow('Refusing non-local Electron renderer URL')
  })
})
