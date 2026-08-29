import type { RuntimeUpdateProfile } from '../../msfs/runtime'
import type { RuntimeState } from '../../msfs/types'

export const DEFAULT_AIRCRAFT_RUNTIME_BENCHMARK_OPTIONS = {
  frames: 5_000,
  warmupFrames: 300,
  dtSeconds: 1 / 60
} as const

export type AircraftRuntimeBenchmarkOptions = {
  readonly frames?: number
  readonly warmupFrames?: number
  readonly dtSeconds?: number
}

export type NumericBenchmarkSummary = {
  readonly min: number
  readonly median: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

export type AircraftRuntimeBenchmarkResult = {
  readonly kind: 'aircraft-runtime/v1'
  readonly frames: number
  readonly warmupFrames: number
  readonly dtSeconds: number
  readonly simulatedSeconds: number
  readonly elapsedMs: number
  readonly msPerFrame: number
  readonly framesPerSecond: number
  readonly steadyStateMsPerFrame: number
  readonly steadyStateFramesPerSecond: number
  readonly throughputSamples: NumericBenchmarkSummary
  readonly phases: Record<RuntimeProfileDurationKey, NumericBenchmarkSummary>
  readonly bindingCounts: {
    readonly update: number
    readonly animation: number
    readonly visibility: number
    readonly material: number
  }
  readonly output: {
    readonly checksum: string
    readonly animationValueCount: number
    readonly visibilityValueCount: number
    readonly materialValueCount: number
  }
}

type BenchmarkRuntime = {
  update(dtSeconds: number, options?: { readonly profile?: boolean }): RuntimeState
  getLastUpdateProfile(): RuntimeUpdateProfile | null
}

type BenchmarkDependencies = {
  readonly now?: () => number
  readonly additionalChecksumState?: () => unknown
}

const PROFILE_DURATION_KEYS = [
  'totalMs',
  'hostTickMs',
  'updateBindingsMs',
  'interactionFeedbackMs',
  'animationMs',
  'mixerMs',
  'wingFlexMs',
  'visibilityMs',
  'materialMs'
] as const

type RuntimeProfileDurationKey = typeof PROFILE_DURATION_KEYS[number]

function normalizeOptions(options: AircraftRuntimeBenchmarkOptions): Required<AircraftRuntimeBenchmarkOptions> {
  const frames = options.frames ?? DEFAULT_AIRCRAFT_RUNTIME_BENCHMARK_OPTIONS.frames
  const warmupFrames = options.warmupFrames ?? DEFAULT_AIRCRAFT_RUNTIME_BENCHMARK_OPTIONS.warmupFrames
  const dtSeconds = options.dtSeconds ?? DEFAULT_AIRCRAFT_RUNTIME_BENCHMARK_OPTIONS.dtSeconds

  if (!Number.isInteger(frames) || frames < 1 || frames > 100_000) {
    throw new RangeError('frames must be an integer between 1 and 100000.')
  }
  if (!Number.isInteger(warmupFrames) || warmupFrames < 0 || warmupFrames > 100_000) {
    throw new RangeError('warmupFrames must be an integer between 0 and 100000.')
  }
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0 || dtSeconds > 1) {
    throw new RangeError('dtSeconds must be a finite number greater than 0 and no greater than 1.')
  }

  return { frames, warmupFrames, dtSeconds }
}

function summarize(values: readonly number[]): NumericBenchmarkSummary {
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length

  return {
    min: sorted[0]!,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1)!,
    mean
  }
}

function stableSerialize(value: unknown): string {
  if (value == null) return String(value)
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN'
    if (!Number.isFinite(value)) return `number:${value > 0 ? 'Infinity' : '-Infinity'}`
    return `number:${Object.is(value, -0) ? '-0' : value.toString()}`
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return `${typeof value}:${JSON.stringify(value)}`
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`
  }
  if (value instanceof Map) {
    return stableSerialize(Object.fromEntries([...value.entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right))
    )))
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`
  }
  return `${typeof value}:${String(value)}`
}

export function checksumBenchmarkValue(value: unknown): string {
  const source = stableSerialize(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Runs the runtime update path without rendering. The runtime owns its state and should be isolated from the viewer. */
export function runAircraftRuntimeBenchmark(
  runtime: BenchmarkRuntime,
  options: AircraftRuntimeBenchmarkOptions = {},
  dependencies: BenchmarkDependencies = {}
): AircraftRuntimeBenchmarkResult {
  const normalized = normalizeOptions(options)
  const now = dependencies.now ?? (() => performance.now())

  for (let frame = 0; frame < normalized.warmupFrames; frame += 1) {
    runtime.update(normalized.dtSeconds)
  }

  const phaseSamples = Object.fromEntries(
    PROFILE_DURATION_KEYS.map(key => [key, [] as number[]])
  ) as Record<RuntimeProfileDurationKey, number[]>
  let state: RuntimeState | null = null
  let latestProfile: RuntimeUpdateProfile | null = null
  const throughputSamples: number[] = []
  const throughputSampleCount = normalized.frames >= 1_000 ? 10 : 1
  const startedAt = now()
  let previousSampleAt = startedAt
  let previousSampleFrame = 0

  for (let frame = 0; frame < normalized.frames; frame += 1) {
    state = runtime.update(normalized.dtSeconds, { profile: true })
    latestProfile = runtime.getLastUpdateProfile()
    if (latestProfile == null) {
      throw new Error('Aircraft runtime did not provide an update profile.')
    }
    for (const key of PROFILE_DURATION_KEYS) {
      phaseSamples[key].push(latestProfile[key])
    }

    const completedFrames = frame + 1
    const sampleBoundary = Math.floor(completedFrames * throughputSampleCount / normalized.frames)
      !== Math.floor(frame * throughputSampleCount / normalized.frames)
    if (sampleBoundary) {
      const sampledAt = now()
      throughputSamples.push((sampledAt - previousSampleAt) / (completedFrames - previousSampleFrame))
      previousSampleAt = sampledAt
      previousSampleFrame = completedFrames
    }
  }

  const elapsedMs = previousSampleAt - startedAt
  if (state == null || latestProfile == null) {
    throw new Error('Aircraft runtime benchmark produced no measured frames.')
  }

  const throughputSummary = summarize(throughputSamples)
  return {
    kind: 'aircraft-runtime/v1',
    ...normalized,
    simulatedSeconds: normalized.frames * normalized.dtSeconds,
    elapsedMs,
    msPerFrame: elapsedMs / normalized.frames,
    framesPerSecond: elapsedMs > 0 ? normalized.frames / (elapsedMs / 1_000) : Infinity,
    steadyStateMsPerFrame: throughputSummary.median,
    steadyStateFramesPerSecond: throughputSummary.median > 0 ? 1_000 / throughputSummary.median : Infinity,
    throughputSamples: throughputSummary,
    phases: Object.fromEntries(
      PROFILE_DURATION_KEYS.map(key => [key, summarize(phaseSamples[key])])
    ) as Record<RuntimeProfileDurationKey, NumericBenchmarkSummary>,
    bindingCounts: {
      update: latestProfile.updateBindingCount,
      animation: latestProfile.animationBindingCount,
      visibility: latestProfile.visibilityBindingCount,
      material: latestProfile.materialBindingCount
    },
    output: {
      checksum: checksumBenchmarkValue({
        animationValues: state.animationValues,
        nodeVisibilities: state.nodeVisibilities,
        materialValues: state.materialValues,
        additionalState: dependencies.additionalChecksumState?.()
      }),
      animationValueCount: state.animationValues.size,
      visibilityValueCount: state.nodeVisibilities.size,
      materialValueCount: state.materialValues.size
    }
  }
}
