import { expect, test } from 'bun:test'

import type { RuntimeUpdateProfile } from '../../msfs/runtime'
import type { RuntimeState } from '../../msfs/types'
import { runAircraftRuntimeBenchmark } from './aircraftRuntimeBenchmark'

function createRuntime() {
  let updateCount = 0
  let profile: RuntimeUpdateProfile | null = null
  const animationValues = new Map<string, number>()
  const state: RuntimeState = {
    irVersion: 'msfs-runtime/v1',
    animationValues,
    nodeVisibilities: new Map([['visible', true]]),
    materialValues: new Map([['light', 0.5]]),
    canonicalVisualBindings: [],
    diagnostics: []
  }

  return {
    runtime: {
      update(dtSeconds: number, options?: { readonly profile?: boolean }): RuntimeState {
        updateCount += 1
        animationValues.set('clock', updateCount * dtSeconds)
        if (options?.profile === true) {
          profile = {
            totalMs: 9,
            hostTickMs: 1,
            updateBindingsMs: 2,
            interactionFeedbackMs: 0.5,
            animationMs: 1.5,
            mixerMs: 1,
            wingFlexMs: 0.25,
            visibilityMs: 0.25,
            materialMs: 0.5,
            updateBindingCount: 10,
            animationBindingCount: 20,
            visibilityBindingCount: 30,
            materialBindingCount: 40
          }
        }
        return state
      },
      getLastUpdateProfile: () => profile
    },
    getUpdateCount: () => updateCount
  }
}

test('runs warmup and measured runtime frames without rendering concerns', () => {
  const fixture = createRuntime()
  let now = 100
  const result = runAircraftRuntimeBenchmark(
    fixture.runtime,
    { frames: 4, warmupFrames: 2, dtSeconds: 0.25 },
    { now: () => (now += 5), additionalChecksumState: () => ({ host: 1 }) }
  )

  expect(fixture.getUpdateCount()).toBe(6)
  expect(result.kind).toBe('aircraft-runtime/v1')
  expect(result.frames).toBe(4)
  expect(result.warmupFrames).toBe(2)
  expect(result.dtSeconds).toBe(0.25)
  expect(result.simulatedSeconds).toBe(1)
  expect(result.elapsedMs).toBe(5)
  expect(result.msPerFrame).toBe(1.25)
  expect(result.steadyStateMsPerFrame).toBe(1.25)
  expect(result.throughputSamples).toEqual({ min: 1.25, median: 1.25, p95: 1.25, max: 1.25, mean: 1.25 })
  expect(result.bindingCounts).toEqual({ update: 10, animation: 20, visibility: 30, material: 40 })
  expect(result.phases.updateBindingsMs).toEqual({ min: 2, median: 2, p95: 2, max: 2, mean: 2 })
  expect(result.output.checksum.startsWith('fnv1a32:')).toBe(true)
  expect(result.output.checksum.length).toBe(16)
})

test('produces deterministic checksums for identical output state', () => {
  const first = createRuntime()
  const second = createRuntime()
  const options = { frames: 3, warmupFrames: 1, dtSeconds: 1 / 60 }

  const firstResult = runAircraftRuntimeBenchmark(first.runtime, options)
  const secondResult = runAircraftRuntimeBenchmark(second.runtime, options)

  expect(firstResult.output.checksum).toBe(secondResult.output.checksum)
})

test('rejects invalid benchmark bounds', () => {
  const fixture = createRuntime()
  const fails = (options: Parameters<typeof runAircraftRuntimeBenchmark>[1]): boolean => {
    try {
      runAircraftRuntimeBenchmark(fixture.runtime, options)
      return false
    } catch {
      return true
    }
  }
  expect(fails({ frames: 0 })).toBe(true)
  expect(fails({ warmupFrames: -1 })).toBe(true)
  expect(fails({ dtSeconds: Number.NaN })).toBe(true)
})
