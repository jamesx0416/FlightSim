import type { CompiledBehaviorSet } from '../../msfs/types'
import { UpdateBindingScheduler } from '../../msfs/updateBindingScheduler'
import { checksumBenchmarkValue, type NumericBenchmarkSummary } from './aircraftRuntimeBenchmark'

export type CompiledBindingsBenchmarkOptions = {
  readonly frames?: number
  readonly warmupFrames?: number
  readonly dtSeconds?: number
  readonly samples?: number
}

export type CompiledBindingsBenchmarkResult = {
  readonly kind: 'compiled-update-bindings/v1'
  readonly frames: number
  readonly warmupFrames: number
  readonly dtSeconds: number
  readonly samples: number
  readonly bindingCount: number
  readonly frequencies: readonly number[]
  readonly evaluations: number
  readonly writes: number
  readonly events: number
  readonly elapsedMs: NumericBenchmarkSummary
  readonly msPerFrame: NumericBenchmarkSummary
  readonly framesPerSecond: number
  readonly outputChecksum: string
}

const DEFAULTS = {
  frames: 20_000,
  warmupFrames: 1_000,
  dtSeconds: 1 / 60,
  samples: 5
} as const

function normalize(options: CompiledBindingsBenchmarkOptions): Required<CompiledBindingsBenchmarkOptions> {
  const result = { ...DEFAULTS, ...options }
  if (!Number.isInteger(result.frames) || result.frames < 1 || result.frames > 1_000_000) {
    throw new RangeError('frames must be an integer between 1 and 1000000.')
  }
  if (!Number.isInteger(result.warmupFrames) || result.warmupFrames < 0 || result.warmupFrames > 100_000) {
    throw new RangeError('warmupFrames must be an integer between 0 and 100000.')
  }
  if (!Number.isFinite(result.dtSeconds) || result.dtSeconds <= 0 || result.dtSeconds > 1) {
    throw new RangeError('dtSeconds must be greater than 0 and no greater than 1.')
  }
  if (!Number.isInteger(result.samples) || result.samples < 1 || result.samples > 30) {
    throw new RangeError('samples must be an integer between 1 and 30.')
  }
  return result
}

function summarize(values: readonly number[]): NumericBenchmarkSummary {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)]!
  return {
    min: sorted[0]!,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1)!,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length
  }
}

function createSample(compiled: CompiledBehaviorSet) {
  const state = new Map<string, number>()
  const counters = { evaluations: 0, writes: 0, events: 0 }
  const scheduler = new UpdateBindingScheduler(compiled.updateBindings, {
    readVariable: key => state.get(key) ?? 0,
    writeVariable: (key, value) => {
      state.set(key, value)
      counters.writes += 1
    },
    invokeKeyEvent: () => { counters.events += 1 },
    invokeHtmlEvent: () => { counters.events += 1 }
  })
  return { state, counters, scheduler }
}

/** Measures the same shared update-binding scheduler used by AircraftRuntime without constructing a host or scene. */
export function runCompiledBindingsBenchmark(
  compiled: CompiledBehaviorSet,
  options: CompiledBindingsBenchmarkOptions = {}
): CompiledBindingsBenchmarkResult {
  const normalized = normalize(options)
  const elapsedSamples: number[] = []
  let expected: { evaluations: number; writes: number; events: number; checksum: string } | null = null

  for (let sampleIndex = 0; sampleIndex < normalized.samples; sampleIndex += 1) {
    const sample = createSample(compiled)
    for (let frame = 0; frame < normalized.warmupFrames; frame += 1) {
      sample.scheduler.update(normalized.dtSeconds)
    }
    sample.counters.evaluations = 0
    sample.counters.writes = 0
    sample.counters.events = 0
    const startedAt = performance.now()
    for (let frame = 0; frame < normalized.frames; frame += 1) {
      sample.counters.evaluations += sample.scheduler.update(normalized.dtSeconds)
    }
    elapsedSamples.push(performance.now() - startedAt)
    const observed = {
      ...sample.counters,
      checksum: checksumBenchmarkValue(Object.fromEntries([...sample.state].sort(([left], [right]) => left.localeCompare(right))))
    }
    if (expected != null && (
      expected.evaluations !== observed.evaluations ||
      expected.writes !== observed.writes ||
      expected.events !== observed.events ||
      expected.checksum !== observed.checksum
    )) {
      throw new Error(`Compiled benchmark sample ${sampleIndex + 1} produced a semantic mismatch.`)
    }
    expected = observed
  }

  const elapsedMs = summarize(elapsedSamples)
  const msPerFrame = summarize(elapsedSamples.map(value => value / normalized.frames))
  return {
    kind: 'compiled-update-bindings/v1',
    ...normalized,
    bindingCount: compiled.updateBindings.length,
    frequencies: [...new Set(compiled.updateBindings.filter(binding => !binding.once && binding.frequency > 0).map(binding => binding.frequency))].sort((left, right) => left - right),
    evaluations: expected!.evaluations,
    writes: expected!.writes,
    events: expected!.events,
    elapsedMs,
    msPerFrame,
    framesPerSecond: msPerFrame.median > 0 ? 1_000 / msPerFrame.median : Infinity,
    outputChecksum: expected!.checksum
  }
}
