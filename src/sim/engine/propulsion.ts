import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimSubsystem, SimSubsystemContext } from './subsystem'

export const PROPULSION_SUBSYSTEM_ID = 'propulsion'

export const PropulsionCommandTypes = {
  setApuMaster: 'propulsion.apu.setMaster',
  setApuStarter: 'propulsion.apu.setStarter',
  setApuRunning: 'propulsion.apu.setRunning',
  setApuRpm: 'propulsion.apu.setRpm',
  setEngineStarter: 'propulsion.engine.setStarter',
  setEngineRunning: 'propulsion.engine.setRunning',
  setEngineN1: 'propulsion.engine.setN1',
  setEngineRpm: 'propulsion.engine.setRpm',
  setEngineThrottle: 'propulsion.engine.setThrottle',
  setEnginePropellerLever: 'propulsion.engine.setPropellerLever',
  setEngineMixtureLever: 'propulsion.engine.setMixtureLever',
  setEngineFuelValve: 'propulsion.engine.setFuelValve',
  setEngineAlternator: 'propulsion.engine.setAlternator',
} as const

export interface EngineDefinition {
  readonly index: number
  readonly defaultRunning?: boolean
  readonly defaultStarter?: boolean
  readonly defaultN1Percent?: number
  readonly defaultRpm?: number
  readonly defaultThrottleLeverRatio?: number
  readonly defaultPropellerLeverRatio?: number
  readonly defaultMixtureLeverRatio?: number
  readonly defaultFuelValveOpen?: boolean
  readonly defaultAlternatorEnabled?: boolean
}

export interface ApuDefinition {
  readonly defaultMaster?: boolean
  readonly defaultStarter?: boolean
  readonly defaultRunning?: boolean
  readonly defaultRpmPercent?: number
}

export interface PropulsionDefinition {
  readonly engines?: readonly EngineDefinition[]
  readonly apu?: ApuDefinition
}

export interface SetApuBooleanPayload {
  readonly enabled: boolean
}

export interface SetApuRpmPayload {
  readonly percent: number
}

export interface SetEngineBooleanPayload {
  readonly index: number
  readonly enabled: boolean
}

export interface SetEngineNumberPayload {
  readonly index: number
  readonly value: number
}

export const PropulsionStateKeys = {
  apuMaster(): string {
    return 'propulsion.apu.master.enabled'
  },
  apuStarter(): string {
    return 'propulsion.apu.starter.enabled'
  },
  apuRunning(): string {
    return 'propulsion.apu.running'
  },
  apuRpmPercent(): string {
    return 'propulsion.apu.rpm.percent'
  },
  engineStarter(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.starter.enabled`
  },
  engineRunning(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.running`
  },
  engineN1Percent(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.n1.percent`
  },
  engineRpm(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.rpm`
  },
  engineThrottleLeverRatio(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.throttle-lever.ratio`
  },
  enginePropellerLeverRatio(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.propeller-lever.ratio`
  },
  engineMixtureLeverRatio(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.mixture-lever.ratio`
  },
  engineFuelValveOpen(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.fuel-valve.open`
  },
  engineAlternatorEnabled(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.alternator.enabled`
  },
}

export class PropulsionSubsystem implements SimSubsystem {
  readonly id = PROPULSION_SUBSYSTEM_ID
  readonly phase = 'systems'

  constructor(private readonly definition: PropulsionDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    if (this.definition.apu != null) {
      defineBooleanState(
        context.state,
        PropulsionStateKeys.apuMaster(),
        'APU master switch state',
        this.definition.apu.defaultMaster
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.apuStarter(),
        'APU starter state',
        this.definition.apu.defaultStarter
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.apuRunning(),
        'APU running state',
        this.definition.apu.defaultRunning
      )
      definePercentState(
        context.state,
        PropulsionStateKeys.apuRpmPercent(),
        'APU RPM percentage',
        this.definition.apu.defaultRpmPercent
      )
    }

    for (const engine of this.definition.engines ?? []) {
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineStarter(engine.index),
        `Engine ${engine.index} starter state`,
        engine.defaultStarter
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineRunning(engine.index),
        `Engine ${engine.index} running state`,
        engine.defaultRunning
      )
      definePercentState(
        context.state,
        PropulsionStateKeys.engineN1Percent(engine.index),
        `Engine ${engine.index} N1 percentage`,
        engine.defaultN1Percent
      )
      defineNumberState(
        context.state,
        PropulsionStateKeys.engineRpm(engine.index),
        `Engine ${engine.index} RPM`,
        engine.defaultRpm
      )
      defineRatioState(
        context.state,
        PropulsionStateKeys.engineThrottleLeverRatio(engine.index),
        `Engine ${engine.index} throttle lever ratio`,
        engine.defaultThrottleLeverRatio
      )
      defineRatioState(
        context.state,
        PropulsionStateKeys.enginePropellerLeverRatio(engine.index),
        `Engine ${engine.index} propeller lever ratio`,
        engine.defaultPropellerLeverRatio
      )
      defineRatioState(
        context.state,
        PropulsionStateKeys.engineMixtureLeverRatio(engine.index),
        `Engine ${engine.index} mixture lever ratio`,
        engine.defaultMixtureLeverRatio
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineFuelValveOpen(engine.index),
        `Engine ${engine.index} fuel valve state`,
        engine.defaultFuelValveOpen
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineAlternatorEnabled(engine.index),
        `Engine ${engine.index} alternator state`,
        engine.defaultAlternatorEnabled
      )
    }
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    switch (command.type) {
      case PropulsionCommandTypes.setApuMaster:
        setBoolean(context.state, PropulsionStateKeys.apuMaster(), command.payload as SetApuBooleanPayload)
        return true
      case PropulsionCommandTypes.setApuStarter:
        setBoolean(context.state, PropulsionStateKeys.apuStarter(), command.payload as SetApuBooleanPayload)
        return true
      case PropulsionCommandTypes.setApuRunning:
        setBoolean(context.state, PropulsionStateKeys.apuRunning(), command.payload as SetApuBooleanPayload)
        return true
      case PropulsionCommandTypes.setApuRpm:
        setPercent(context.state, PropulsionStateKeys.apuRpmPercent(), command.payload as SetApuRpmPayload)
        return true
      case PropulsionCommandTypes.setEngineStarter: {
        const payload = command.payload as SetEngineBooleanPayload
        setBoolean(context.state, PropulsionStateKeys.engineStarter(payload.index), payload)
        return true
      }
      case PropulsionCommandTypes.setEngineRunning: {
        const payload = command.payload as SetEngineBooleanPayload
        setBoolean(context.state, PropulsionStateKeys.engineRunning(payload.index), payload)
        return true
      }
      case PropulsionCommandTypes.setEngineN1: {
        const payload = command.payload as SetEngineNumberPayload
        setNumber(context.state, PropulsionStateKeys.engineN1Percent(payload.index), clampPercent(payload.value), 'percent')
        return true
      }
      case PropulsionCommandTypes.setEngineRpm: {
        const payload = command.payload as SetEngineNumberPayload
        setNumber(context.state, PropulsionStateKeys.engineRpm(payload.index), Math.max(0, payload.value), 'number')
        return true
      }
      case PropulsionCommandTypes.setEngineThrottle: {
        const payload = command.payload as SetEngineNumberPayload
        setNumber(
          context.state,
          PropulsionStateKeys.engineThrottleLeverRatio(payload.index),
          clampRatio(payload.value),
          'ratio'
        )
        return true
      }
      case PropulsionCommandTypes.setEnginePropellerLever: {
        const payload = command.payload as SetEngineNumberPayload
        setNumber(
          context.state,
          PropulsionStateKeys.enginePropellerLeverRatio(payload.index),
          clampRatio(payload.value),
          'ratio'
        )
        return true
      }
      case PropulsionCommandTypes.setEngineMixtureLever: {
        const payload = command.payload as SetEngineNumberPayload
        setNumber(
          context.state,
          PropulsionStateKeys.engineMixtureLeverRatio(payload.index),
          clampRatio(payload.value),
          'ratio'
        )
        return true
      }
      case PropulsionCommandTypes.setEngineFuelValve: {
        const payload = command.payload as SetEngineBooleanPayload
        setBoolean(context.state, PropulsionStateKeys.engineFuelValveOpen(payload.index), payload)
        return true
      }
      case PropulsionCommandTypes.setEngineAlternator: {
        const payload = command.payload as SetEngineBooleanPayload
        setBoolean(context.state, PropulsionStateKeys.engineAlternatorEnabled(payload.index), payload)
        return true
      }
      default:
        return false
    }
  }
}

export function readPropulsionNumber(
  state: SimStateStore,
  key: string,
  fallback = 0
): number {
  return state.readNumber(key, { fallback }) ?? fallback
}

export function readPropulsionBoolean(
  state: SimStateStore,
  key: string,
  fallback = false
): boolean {
  return state.readBoolean(key, { fallback }) ?? fallback
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

function definePercentState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number
): void {
  defineNumberState(state, key, description, defaultValue == null ? undefined : clampPercent(defaultValue), 'percent')
}

function defineRatioState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number
): void {
  defineNumberState(state, key, description, defaultValue == null ? undefined : clampRatio(defaultValue), 'ratio')
}

function defineNumberState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number,
  unit: 'number' | 'percent' | 'ratio' = 'number'
): void {
  state.define({ key, unit, valueType: 'number', description })

  if (defaultValue != null) {
    state.set(key, defaultValue, { source: 'default', unit })
  }
}

function setBoolean(
  state: SimStateStore,
  key: string,
  payload: SetApuBooleanPayload | SetEngineBooleanPayload
): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean' })
  state.set(key, payload.enabled, { source: 'runtime', unit: 'boolean' })
}

function setPercent(state: SimStateStore, key: string, payload: SetApuRpmPayload): void {
  setNumber(state, key, clampPercent(payload.percent), 'percent')
}

function setNumber(
  state: SimStateStore,
  key: string,
  value: number,
  unit: 'number' | 'percent' | 'ratio'
): void {
  state.define({ key, unit, valueType: 'number' })
  state.set(key, value, { source: 'runtime', unit })
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(100, value))
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(1, value))
}

function normalizePositiveIndex(index: number): number {
  if (!Number.isInteger(index) || index <= 0) {
    throw new RangeError(`Propulsion index must be a positive integer: ${index}`)
  }

  return index
}
