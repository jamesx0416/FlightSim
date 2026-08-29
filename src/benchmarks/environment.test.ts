import { expect, test } from 'bun:test'

import { summarizeEnvironment, type EnvironmentObservation } from './environment'

const observation = (overrides: Partial<EnvironmentObservation> = {}): EnvironmentObservation => ({
  timestamp: '2026-08-29T00:00:00.000Z',
  loadAverage: [1, 2, 3],
  totalMemoryBytes: 1_000,
  freeMemoryBytes: 500,
  processResidentBytes: 100,
  chromeProcessCount: 2,
  chromeCpuPercent: 20,
  chromeResidentBytes: 200,
  chromeRendererCpuPercent: 15,
  chromeRendererResidentBytes: 150,
  chromeGpuProcessCpuPercent: 5,
  chromeGpuProcessResidentBytes: 50,
  gpuUtilizationPercent: null,
  ...overrides
})

test('environment summary reports peaks without inventing a noise verdict', () => {
  expect(summarizeEnvironment([
    observation(),
    observation({ loadAverage: [4, 2, 3], freeMemoryBytes: 300, chromeCpuPercent: 80 })
  ])).toEqual({
    sampleCount: 2,
    peakLoadAverage1m: 4,
    minimumFreeMemoryBytes: 300,
    peakChromeCpuPercent: 80,
    peakChromeResidentBytes: 200,
    peakChromeRendererCpuPercent: 15,
    peakChromeGpuProcessCpuPercent: 5,
    gpuUtilizationAvailable: false,
    noiseClassification: 'unassessed',
    noiseReason: 'No repository noise threshold is configured.'
  })
})
