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
    speedup: 4 / 3,
    baselineSamples: { values: [4], median: 4, mean: 4, standardDeviation: 0, coefficientOfVariationPercent: 0 },
    candidateSamples: { values: [3], median: 3, mean: 3, standardDeviation: 0, coefficientOfVariationPercent: 0 },
    pairedWins: 1,
    confirmedFaster: true
  })
})

test('rendered comparisons confirm the median across repeated samples', () => {
  const baseline = { performanceSamples: [4.2, 4, 4.1].map(median => ({ cockpitPerf: { frameMs: { median } } })) }
  const candidate = { performanceSamples: [3.9, 4.05, 3.8].map(median => ({ cockpitPerf: { frameMs: { median } } })) }
  const result = __benchmarkExecuteTestHooks.comparePrimaryMetric(baseline, candidate) as Record<string, unknown>

  expect(result.baselineMsPerFrame).toBe(4.1)
  expect(result.candidateMsPerFrame).toBe(3.9)
  expect(result.pairedWins).toBe(2)
  expect(result.confirmedFaster).toBe(true)
})

test('visual confirmation proceeds only for pixel-identical panoramas', () => {
  expect(__benchmarkExecuteTestHooks.isVisualComparisonIdentical({ identical: true })).toBe(true)
  expect(__benchmarkExecuteTestHooks.isVisualComparisonIdentical({ identical: false })).toBe(false)
  expect(__benchmarkExecuteTestHooks.isVisualComparisonIdentical({})).toBe(false)
})

test('rendered benchmarks warm fresh frames before the only collector reset', () => {
  const expression = __benchmarkExecuteTestHooks.createBrowserFullExpression(300, 30, 120_000)
  const warmup = expression.indexOf('await waitForFrames(30)')
  const reset = expression.indexOf('collector.reset(300)')
  const measurement = expression.indexOf('await waitForSamples(300)')

  expect(warmup > -1).toBe(true)
  expect(reset > warmup).toBe(true)
  expect(measurement > reset).toBe(true)
  expect(expression.match(/collector\.reset\(300\)/gu)?.length).toBe(1)
})

test('fresh browser no-render harness skips the viewer renderer', () => {
  const page = __benchmarkExecuteTestHooks.noRenderBrowserPageSource()
  expect(page.includes('bunAircraftRuntimeAdapter.ts')).toBe(true)
  expect(page.includes('__FlightSimNoRenderBenchmark')).toBe(true)
  expect(page.includes('/src/main.ts')).toBe(false)
  expect(page.includes('renderer')).toBe(false)
})


test('fresh browser benchmarks use stable managed cache origins', () => {
  expect(__benchmarkExecuteTestHooks.browserBenchmarkPort(1, undefined)).toBe(3003)
  expect(__benchmarkExecuteTestHooks.browserBenchmarkPort(2, undefined)).toBe(3004)
  expect(__benchmarkExecuteTestHooks.browserBenchmarkPort(2, '4100')).toBe(4101)

  const visual = {
    kind: 'browser-visual',
    stage: 'cockpit',
    timeoutMs: 120_000,
    reuse: false,
    noReopen: false,
    keepOpen: false,
    hooks: {},
    json: false
  } as const
  expect(__benchmarkExecuteTestHooks.usesManagedBenchmarkServer(visual, undefined)).toBe(true)
  expect(__benchmarkExecuteTestHooks.usesManagedBenchmarkServer({ ...visual, keepOpen: true }, undefined)).toBe(false)
  expect(__benchmarkExecuteTestHooks.usesManagedBenchmarkServer(visual, 'http://custom.test')).toBe(false)
})
