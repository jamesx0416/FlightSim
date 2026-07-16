import { describe, expect, test } from 'bun:test'
import { SimScheduler, SimulatorEngine } from './index'

describe('SimScheduler', () => {
  test('runs delayed and repeating work in deterministic simulator time', () => {
    const scheduler = new SimScheduler()
    const observed: string[] = []

    scheduler.schedule(1, () => observed.push('once'))
    scheduler.schedule(0.5, () => observed.push('repeat'), { repeatSeconds: 0.5 })

    scheduler.tick(0.5)
    scheduler.tick(0.5)

    expect(observed).toEqual(['repeat', 'once', 'repeat'])
  })

  test('cancels one task or a whole scope', () => {
    const scheduler = new SimScheduler()
    const observed: string[] = []
    const single = scheduler.schedule(0, () => observed.push('single'))
    scheduler.schedule(0, () => observed.push('scoped-a'), { scope: 'interaction:a' })
    scheduler.schedule(0, () => observed.push('scoped-b'), { scope: 'interaction:a' })

    expect(scheduler.cancel(single)).toBe(true)
    expect(scheduler.cancelScope('interaction:a')).toBe(2)
    scheduler.tick(1)

    expect(observed).toEqual([])
  })

  test('resolves completed-tick promises after the requested engine ticks', async () => {
    const engine = new SimulatorEngine()
    let completed = false
    const waiting = engine.scheduler.waitForCompletedTicks(2).then(() => { completed = true })

    engine.tick(0.1)
    await Promise.resolve()
    expect(completed).toBe(false)

    engine.tick(0.1)
    await waiting
    expect(completed).toBe(true)
  })

  test('rejects invalid timing instead of creating non-terminating tasks', () => {
    const scheduler = new SimScheduler()

    expectRangeError(() => scheduler.schedule(-1, () => {}))
    expectRangeError(() => scheduler.schedule(0, () => {}, { repeatSeconds: 0 }))
    expectRangeError(() => scheduler.tick(Number.NaN))
    expectRangeError(() => scheduler.waitForCompletedTicks(0))
  })
})

function expectRangeError(callback: () => unknown): void {
  let error: unknown
  try {
    callback()
  } catch (caught) {
    error = caught
  }
  expect(error instanceof RangeError).toBe(true)
}
