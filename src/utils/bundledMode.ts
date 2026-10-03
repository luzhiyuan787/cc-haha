/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * True when `moduleUrl` points into Bun's compile-time virtual filesystem
 * (`/$bunfs/...` on POSIX, `X:/~BUN/...` on Windows).
 *
 * Windows `import.meta.url` percent-encodes `~` as `%7E` (and `$` as `%24`),
 * so the raw string must be decoded before matching.
 */
export function isBunVirtualModuleUrl(moduleUrl: string): boolean {
  let modulePath: string
  try {
    modulePath = decodeURIComponent(new URL(moduleUrl).pathname)
  } catch {
    modulePath = decodeURIComponent(moduleUrl)
  }
  return modulePath.includes('/$bunfs/') || modulePath.includes('/~BUN/')
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 *
 * `Bun.embeddedFiles` is the primary signal, but Bun 1.3.x on Windows can
 * report an empty array inside a compiled binary — fall back to the virtual
 * module URL so callers still see a native build.
 */
export function isInBundledMode(): boolean {
  if (
    typeof Bun !== 'undefined' &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  ) {
    return true
  }
  return isBunVirtualModuleUrl(import.meta.url)
}
