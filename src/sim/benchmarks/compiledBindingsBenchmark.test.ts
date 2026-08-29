import { expect, test } from 'bun:test'

import type { CompiledBehaviorSet } from '../../msfs/types'
import { runCompiledBindingsBenchmark } from './compiledBindingsBenchmark'

const compiled = {
  aircraftId: 'fixture',
  updateBindings: [
    { once: true, frequency: 0, expression: { source: '', instructions: [{ op: 'pushNumber', value: 1 }, { op: 'writeVariable', key: 'O:ONCE', unit: null }] } },
    { once: false, frequency: 30, expression: { source: '', instructions: [{ op: 'pushNumber', value: 2 }, { op: 'writeVariable', key: 'O:TICK', unit: null }] } }
  ],
  animationBindings: [],
  animationTriggerBindings: [],
  visibilityBindings: [],
  materialBindings: [],
  interactionBindings: [],
  interactionBlockers: [],
  inputEventBindings: [],
  canonicalVisualBindings: [],
  wingFlexBindings: [],
  diagnostics: []
} as unknown as CompiledBehaviorSet

test('compiled benchmark uses deterministic shared scheduling', () => {
  const result = runCompiledBindingsBenchmark(compiled, {
    frames: 60,
    warmupFrames: 0,
    dtSeconds: 1 / 60,
    samples: 2
  })
  expect(result.bindingCount).toBe(2)
  expect(result.frequencies).toEqual([30])
  expect(result.evaluations).toBe(31)
  expect(result.writes).toBe(31)
  expect(result.outputChecksum.startsWith('fnv1a32:')).toBe(true)
})
