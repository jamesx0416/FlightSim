import {
  BrowserDriver,
  BrowserDriverError,
  DEFAULT_BROWSER_TIMEOUT_MS
} from './browserDriver'

// The viewer keeps a rolling 120-frame FPS window, so this is the largest
// authoritative sample boundary status() can report.
export const DEFAULT_STABLE_SAMPLE_COUNT = 120

export const READINESS_STAGE_ALIASES = [
  'initial',
  'compiled',
  'aircraft',
  'cockpit',
  'gauges',
  'stable'
] as const

export type ReadinessStageAlias = (typeof READINESS_STAGE_ALIASES)[number]
export type ReadinessMode = 'load' | 'no-render' | 'full' | 'profile' | 'visual' | 'browser'

export type CustomReadinessStage = {
  /** A JavaScript expression evaluated in the FlightSim page by Agent Browser. */
  readonly condition: string
  /** Optional JavaScript run once after prerequisite stages are ready. */
  readonly prepare?: string
}

export type ResolvedReadinessStage = {
  readonly requested: string
  readonly resolved: string
  readonly kind: 'alias' | 'exact' | 'custom'
  readonly condition: string
  readonly prepare?: string
  readonly prerequisites: readonly ReadinessStageAlias[]
}

export type ReadinessOptions = {
  readonly stage?: string
  readonly mode?: ReadinessMode
  readonly stages?: Readonly<Record<string, CustomReadinessStage>>
  readonly timeoutMs?: number
  readonly stableSampleCount?: number
}

export type ReadinessResult = {
  readonly requestedStage: string
  readonly resolvedStage: string
  readonly kind: ResolvedReadinessStage['kind']
  readonly condition: string
  readonly timeoutMs: number
  readonly elapsedMs: number
  readonly completedStages: readonly string[]
  readonly observedStatus: unknown
}

export type ReadinessErrorCode = 'READINESS_STAGE_REQUIRED' | 'READINESS_INVALID_STAGE'

export class ReadinessError extends Error {
  readonly name = 'ReadinessError'

  constructor(
    readonly code: ReadinessErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message)
  }
}

/** Browser load measurements must name their boundary; every other mode settles at stable by default. */
export function defaultReadinessStage(mode: ReadinessMode = 'browser'): ReadinessStageAlias | undefined {
  return mode === 'load' ? undefined : 'stable'
}

/** Resolves aliases, custom configuration names, or an exact DevApi load-stage value. */
export function resolveReadinessStage(options: ReadinessOptions = {}): ResolvedReadinessStage {
  const requested = options.stage?.trim() || defaultReadinessStage(options.mode)
  if (requested == null) {
    throw new ReadinessError('READINESS_STAGE_REQUIRED', 'Browser load benchmarks require an explicit readiness stage.')
  }

  const stableSampleCount = validateStableSampleCount(options.stableSampleCount ?? DEFAULT_STABLE_SAMPLE_COUNT)
  const custom = options.stages?.[requested]
  if (custom != null) return customStage(requested, custom)

  if (isReadinessStageAlias(requested)) {
    return builtInStage(requested, stableSampleCount)
  }
  if (!requested.includes(':')) {
    throw new ReadinessError(
      'READINESS_INVALID_STAGE',
      `Unknown readiness stage "${requested}". Use a built-in alias, configured custom stage, or exact DevApi load-stage value.`,
      { stage: requested }
    )
  }
  return {
    requested,
    resolved: requested,
    kind: 'exact',
    condition: hasReachedLoadStageCondition(requested),
    prerequisites: []
  }
}

/**
 * Runs stage prerequisites and their optional preparations before waiting with
 * Agent Browser's condition wait. No fixed delay is used for readiness.
 */
export async function waitForReadiness(
  driver: BrowserDriver,
  options: ReadinessOptions = {}
): Promise<ReadinessResult> {
  const stage = resolveReadinessStage(options)
  const timeoutMs = validateTimeout(options.timeoutMs ?? driver.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS)
  const startedAt = performance.now()
  const completedStages: string[] = []
  const completed = new Set<string>()
  const stableSampleCount = validateStableSampleCount(options.stableSampleCount ?? DEFAULT_STABLE_SAMPLE_COUNT)
  const waitWithPrerequisites = async (current: ResolvedReadinessStage): Promise<void> => {
    for (const prerequisite of current.prerequisites) {
      await waitWithPrerequisites(builtInStage(prerequisite, stableSampleCount))
    }
    if (completed.has(current.resolved)) return
    await waitForStage(driver, current, remainingTimeout(startedAt, timeoutMs))
    completed.add(current.resolved)
    completedStages.push(current.resolved)
  }
  await waitWithPrerequisites(stage)
  const observedStatus = await driver.evalJson<unknown>(
    'window.__DevApi?.status?.() ?? null',
    remainingTimeout(startedAt, timeoutMs)
  )

  return {
    requestedStage: stage.requested,
    resolvedStage: stage.resolved,
    kind: stage.kind,
    condition: stage.condition,
    timeoutMs,
    elapsedMs: performance.now() - startedAt,
    completedStages,
    observedStatus
  }
}

async function waitForStage(
  driver: BrowserDriver,
  stage: ResolvedReadinessStage,
  timeoutMs: number
): Promise<void> {
  if (stage.prepare != null) await driver.eval(stage.prepare, timeoutMs)
  await driver.waitFn(stage.condition, timeoutMs)
}

function builtInStage(
  requested: ReadinessStageAlias,
  stableSampleCount: number
): ResolvedReadinessStage {
  switch (requested) {
    case 'initial':
      return aliasStage(requested, 'typeof window.__DevApi?.status === "function"')
    case 'compiled':
      return aliasStage(requested, hasReachedLoadStageCondition('gltf:loaded'))
    case 'aircraft':
      return aliasStage(requested, hasReachedLoadStageCondition('scene:ready'))
    case 'cockpit':
      return {
        ...aliasStage(requested, cockpitReadyCondition(), ['aircraft']),
        prepare: enterCockpitPreparation()
      }
    case 'gauges':
      return aliasStage(requested, gaugesReadyCondition(), ['cockpit'])
    case 'stable':
      return {
        ...aliasStage(requested, stableCondition(stableSampleCount), ['gauges']),
        prepare: settleFramesPreparation(stableSampleCount)
      }
  }
}

function aliasStage(
  requested: ReadinessStageAlias,
  condition: string,
  prerequisites: readonly ReadinessStageAlias[] = []
): ResolvedReadinessStage {
  return {
    requested,
    resolved: requested,
    kind: 'alias',
    condition,
    prerequisites
  }
}

function customStage(requested: string, custom: CustomReadinessStage): ResolvedReadinessStage {
  if (!custom.condition.trim()) {
    throw new ReadinessError('READINESS_INVALID_STAGE', `Custom readiness stage "${requested}" has an empty condition.`)
  }
  return {
    requested,
    resolved: requested,
    kind: 'custom',
    condition: custom.condition,
    ...(custom.prepare == null ? {} : { prepare: custom.prepare }),
    prerequisites: []
  }
}

function hasReachedLoadStageCondition(stage: string): string {
  const expected = JSON.stringify(stage)
  return `(() => {
    const status = window.__DevApi?.status?.()
    if (status?.ok === true && status.data?.loadStage?.stage === ${expected}) return true
    const startup = window.__DevApi?.bench?.startup?.()
    if (startup?.ok !== true) return false
    if (startup.data?.currentLoadStage?.stage === ${expected}) return true
    if (!Array.isArray(startup.data?.stages)) return false
    return startup.data.stages.some(entry => entry?.stage === ${expected})
  })()`
}

function cockpitReadyCondition(): string {
  return `(() => {
    const status = window.__DevApi?.status?.()
    return status?.ok === true &&
      status.data?.cockpit?.active === true &&
      status.data?.cockpit?.activeInteriorLodIndex != null
  })()`
}

function gaugesReadyCondition(): string {
  return `(() => {
    const status = window.__DevApi?.status?.()
    if (status?.ok !== true) return false
    const startup = window.__DevApi?.bench?.startup?.()
    const interiorReady = startup?.ok === true && (
      startup.data?.currentLoadStage?.stage === 'gltf:interior-upgrade:ready' ||
      startup.data?.stages?.some?.(entry => entry?.stage === 'gltf:interior-upgrade:ready') === true
    )
    if (!interiorReady) return false
    const counts = status.data?.counts
    const total = counts?.gauges ?? 0
    const loaded = counts?.loadedGauges ?? 0
    return loaded >= total
  })()`
}

function stableCondition(sampleCount: number): string {
  return `(() => {
    const status = window.__DevApi?.status?.()
    if (status?.ok !== true) return false
    const counts = status.data?.counts
    const total = counts?.gauges ?? 0
    const loaded = counts?.loadedGauges ?? 0
    const samples = status.data?.fps?.sampleCount ?? 0
    const errors = status.data?.diagnostics?.error ?? 0
    return loaded >= total && samples >= ${sampleCount} && errors === 0
  })()`
}

function enterCockpitPreparation(): string {
  return `(async () => {
    const response = await window.__DevApi?.camera?.enterCockpit?.()
    if (response?.ok !== true) throw new Error(response?.summary ?? 'Could not enter cockpit view.')
    return true
  })()`
}

function settleFramesPreparation(sampleCount: number): string {
  return `new Promise(resolve => {
    let remaining = ${sampleCount}
    const onFrame = () => {
      remaining -= 1
      if (remaining <= 0) resolve(true)
      else requestAnimationFrame(onFrame)
    }
    requestAnimationFrame(onFrame)
  })`
}

function isReadinessStageAlias(value: string): value is ReadinessStageAlias {
  return (READINESS_STAGE_ALIASES as readonly string[]).includes(value)
}

function validateStableSampleCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ReadinessError('READINESS_INVALID_STAGE', 'Stable readiness requires a positive frame sample count.')
  }
  return Math.floor(value)
}

function validateTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new BrowserDriverError('BROWSER_INVALID_ARGUMENT', 'Readiness timeout must be a positive number of milliseconds.')
  }
  return Math.floor(value)
}

function remainingTimeout(startedAt: number, timeoutMs: number): number {
  const remaining = timeoutMs - (performance.now() - startedAt)
  if (remaining <= 0) {
    throw new BrowserDriverError('BROWSER_COMMAND_TIMED_OUT', `Browser readiness timed out after ${timeoutMs}ms.`)
  }
  return Math.max(1, Math.floor(remaining))
}
