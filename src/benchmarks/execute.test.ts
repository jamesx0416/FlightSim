import { expect, test } from 'bun:test'

import { __benchmarkExecuteTestHooks } from './execute'

test('comparison semantics recognize both compiled and runtime result shapes', () => {
  const compiled = { benchmark: { outputChecksum: 'fnv1a32:a', bindingCount: 681 } }
  expect(__benchmarkExecuteTestHooks.compareSemantics(compiled, compiled)).toEqual({
    checksumsAvailable: true,
    checksumsEqual: true,
    bindingCountsAvailable: true,
    bindingCountsEqual: true,
    baselineChecksums: ['fnv1a32:a'],
    candidateChecksums: ['fnv1a32:a']
  })

  const runtime = { output: { checksum: 'fnv1a32:b' }, bindingCounts: { update: 681 } }
  expect(__benchmarkExecuteTestHooks.compareSemantics(runtime, runtime)).toEqual({
    checksumsAvailable: true,
    checksumsEqual: true,
    bindingCountsAvailable: true,
    bindingCountsEqual: true,
    baselineChecksums: ['fnv1a32:b'],
    candidateChecksums: ['fnv1a32:b']
  })
})

test('rendered comparisons use the cockpit frame-time median', () => {
  const baseline = { cockpitPerf: { frameMs: { min: 3, median: 4, p95: 6 } } }
  const candidate = { cockpitPerf: { frameMs: { min: 2, median: 3, p95: 5 } } }
  expect(__benchmarkExecuteTestHooks.comparePrimaryMetric(baseline, candidate)).toEqual({
    available: true,
    baselineMsPerFrame: 4,
    candidateMsPerFrame: 3,
    changePercent: -25,
    speedup: 4 / 3
  })
})
