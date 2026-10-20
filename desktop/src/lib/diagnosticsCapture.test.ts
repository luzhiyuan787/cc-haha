import { describe, expect, it, vi } from 'vitest'
import { startRendererPerformanceMonitor } from './diagnosticsCapture'

describe('renderer performance diagnostics', () => {
  it('records visible event-loop stalls and ignores background timer throttling', async () => {
    let now = 0
    let sample: (() => void) | undefined
    let visible = true
    const record = vi.fn().mockResolvedValue(undefined)
    const stop = startRendererPerformanceMonitor({
      now: () => now,
      visible: () => visible,
      record,
      setInterval: ((callback: TimerHandler) => {
        sample = callback as () => void
        return 1
      }) as typeof window.setInterval,
      clearInterval: vi.fn() as unknown as typeof window.clearInterval,
    })

    now = 1_700
    sample?.()
    await Promise.resolve()
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'client_event_loop_stall',
      details: expect.objectContaining({ lagMs: 700 }),
    }))

    visible = false
    now = 15_000
    sample?.()
    expect(record).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not report time spent hidden as a stall after the window returns', () => {
    let now = 0
    let sample: (() => void) | undefined
    let visibilityHandler: (() => void) | undefined
    let visible = true
    const record = vi.fn().mockResolvedValue(undefined)
    const stop = startRendererPerformanceMonitor({
      now: () => now,
      visible: () => visible,
      record,
      subscribeVisibility: (handler) => {
        visibilityHandler = handler
        return () => {}
      },
      setInterval: ((callback: TimerHandler) => {
        sample = callback as () => void
        return 1
      }) as typeof window.setInterval,
      clearInterval: vi.fn() as unknown as typeof window.clearInterval,
    })

    // A minute hidden: throttled timers are not a renderer stall.
    visible = false
    now = 60_000
    sample?.()

    visible = true
    visibilityHandler?.()
    now = 61_200
    sample?.()
    expect(record).not.toHaveBeenCalled()
    stop()
  })
})
