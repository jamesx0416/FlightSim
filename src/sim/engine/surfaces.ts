import type { CanonicalSurfaceSystemConfig } from './aircraft'
import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type {
  SimSubsystem,
  SimSubsystemContext,
  SimSubsystemTickContext,
} from './subsystem'

export const SURFACE_ANIMATION_SUBSYSTEM_ID = 'surface-animation'

export const SurfaceCommandTypes = {
  setTarget: 'surfaces.setTarget',
  setPosition: 'surfaces.setPosition',
} as const

export interface SurfaceDefinition {
  readonly id: string
  readonly controlStateKey?: string
  readonly defaultTargetRatio?: number
  readonly defaultPositionRatio?: number
  readonly extensionRatePerSecond?: number
  readonly retractionRatePerSecond?: number
}

export interface SurfaceAnimationDefinition extends CanonicalSurfaceSystemConfig {
  readonly surfaces?: readonly SurfaceDefinition[]
}

export interface SetSurfaceRatioPayload {
  readonly id: string
  readonly ratio: number
}

export const SurfaceStateKeys = {
  targetRatio(id: string): string {
    return `surfaces.${normalizeStateSegment(id)}.target.ratio`
  },
  positionRatio(id: string): string {
    return `surfaces.${normalizeStateSegment(id)}.position.ratio`
  },
  moving(id: string): string {
    return `surfaces.${normalizeStateSegment(id)}.moving`
  },
}

export class SurfaceAnimationSubsystem implements SimSubsystem {
  readonly id = SURFACE_ANIMATION_SUBSYSTEM_ID
  readonly phase = 'systems'

  constructor(private readonly definition: SurfaceAnimationDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    for (const surface of this.definition.surfaces ?? []) {
      defineSurface(context.state, surface)
    }
  }

  tick(context: SimSubsystemTickContext): void {
    for (const surface of this.definition.surfaces ?? []) {
      const target =
        surface.controlStateKey == null
          ? readSurfaceRatio(context.state, SurfaceStateKeys.targetRatio(surface.id))
          : readSurfaceRatio(context.state, surface.controlStateKey)
      setDerivedSurfaceRatio(
        context.state,
        SurfaceStateKeys.targetRatio(surface.id),
        target
      )

      const current = readSurfaceRatio(
        context.state,
        SurfaceStateKeys.positionRatio(surface.id)
      )
      const delta = target - current

      if (Math.abs(delta) < 1e-6) {
        setSurfaceBoolean(context.state, SurfaceStateKeys.moving(surface.id), false)
        continue
      }

      const rate =
        delta > 0
          ? surface.extensionRatePerSecond ?? 1
          : surface.retractionRatePerSecond ?? surface.extensionRatePerSecond ?? 1
      const step = Math.max(0, rate) * context.dtSeconds
      const next =
        Math.abs(delta) <= step ? target : current + Math.sign(delta) * step

      setDerivedSurfaceRatio(
        context.state,
        SurfaceStateKeys.positionRatio(surface.id),
        next
      )
      setSurfaceBoolean(context.state, SurfaceStateKeys.moving(surface.id), next !== target)
    }
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    const payload = command.payload as SetSurfaceRatioPayload

    switch (command.type) {
      case SurfaceCommandTypes.setTarget:
        setSurfaceRatio(
          context.state,
          SurfaceStateKeys.targetRatio(payload.id),
          payload.ratio
        )
        return true
      case SurfaceCommandTypes.setPosition:
        setSurfaceRatio(
          context.state,
          SurfaceStateKeys.positionRatio(payload.id),
          payload.ratio
        )
        return true
      default:
        return false
    }
  }
}

export function readSurfaceRatio(state: SimStateStore, key: string): number {
  return clampRatio(state.readNumber(key, { unit: 'ratio', fallback: 0 }) ?? 0)
}

export function readSurfaceBoolean(
  state: SimStateStore,
  key: string,
  fallback = false
): boolean {
  return state.readBoolean(key, { fallback }) ?? fallback
}

function defineSurface(state: SimStateStore, surface: SurfaceDefinition): void {
  defineRatioState(
    state,
    SurfaceStateKeys.targetRatio(surface.id),
    `Surface ${surface.id} target ratio`,
    surface.defaultTargetRatio
  )
  defineRatioState(
    state,
    SurfaceStateKeys.positionRatio(surface.id),
    `Surface ${surface.id} position ratio`,
    surface.defaultPositionRatio
  )
  defineBooleanState(
    state,
    SurfaceStateKeys.moving(surface.id),
    `Surface ${surface.id} moving state`,
    false
  )
}

function defineRatioState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number
): void {
  state.define({ key, unit: 'ratio', valueType: 'number', description })
  if (defaultValue != null) {
    state.set(key, clampRatio(defaultValue), { source: 'default', unit: 'ratio' })
  }
}

function defineBooleanState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: boolean
): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean', description })
  if (defaultValue != null) {
    state.set(key, defaultValue, { source: 'default', unit: 'boolean' })
  }
}

function setSurfaceRatio(
  state: SimStateStore,
  key: string,
  ratio: number
): void {
  state.define({ key, unit: 'ratio', valueType: 'number' })
  state.set(key, clampRatio(ratio), { source: 'runtime', unit: 'ratio' })
}

function setDerivedSurfaceRatio(
  state: SimStateStore,
  key: string,
  ratio: number
): void {
  state.define({ key, unit: 'ratio', valueType: 'number' })
  state.set(key, clampRatio(ratio), { source: 'subsystem', unit: 'ratio' })
}

function setSurfaceBoolean(
  state: SimStateStore,
  key: string,
  enabled: boolean
): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean' })
  state.set(key, enabled, { source: 'subsystem', unit: 'boolean' })
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function normalizeStateSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'default'
  )
}
