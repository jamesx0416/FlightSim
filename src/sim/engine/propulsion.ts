import type { CanonicalPropulsionSystemConfig } from './aircraft'
import { AirPhysicsStateKeys } from './airState'
import type { SimCommand } from './commands'
import {
  ElectricalStateKeys,
  readElectricalBoolean,
} from './electrical'
import {
  FuelStateKeys,
  readFuelBoolean,
} from './fuel'
import { computeJetCommandedN1Percent, type JetEngineEnvironment } from './jetEngine'
import type { SimStateStore } from './state'
import type { SimUnit } from './units'
import type {
  SimSubsystem,
  SimSubsystemContext,
  SimSubsystemTickContext,
} from './subsystem'

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
  readonly starterConsumerId?: string
  readonly ignitionConsumerId?: string
  readonly fuelFeedIndex?: number
  readonly generatorSourceId?: string
  readonly idleN1Percent?: number
  readonly starterN1Percent?: number
  readonly spoolUpPercentPerSecond?: number
  readonly spoolDownPercentPerSecond?: number
  readonly highN1Percent?: number
  readonly n1NormalIntegrationRate?: number
  readonly staticThrustN?: number
  readonly thrustScalar?: number
  readonly machInfluenceOnN1?: number
  readonly useCommandedNeTable?: boolean
  readonly commandedNeLowMach?: import('./aircraft').CanonicalMachLookupTable2D
  readonly commandedNeHighMach?: import('./aircraft').CanonicalMachLookupTable2D
  readonly useN2ToN1Table?: boolean
  readonly n2ToN1ByCorrectedN2AndMach?: import('./aircraft').CanonicalLookupTable2D
  readonly starterN1RatePercentPerSecond?: number
  readonly minN1ForCombustionPercent?: number
  readonly thrustByCorrectedN1AndMach?: import('./aircraft').CanonicalLookupTable2D
  readonly correctedAirflowByCorrectedN1AndMach?: import('./aircraft').CanonicalLookupTable2D
  readonly inletAreaM2?: number
  readonly supersonicRamDrag?: boolean
  readonly variableInlet?: boolean
  readonly supersonicInlet?: boolean
  readonly supersonicInletDesignMach?: number
  readonly positionBodyM?: readonly [number, number, number]
  readonly thrustDirectionBody?: readonly [number, number, number]
  readonly idleFuelFlowKgPerSecond?: number
  readonly highFuelFlowKgPerSecond?: number
}

export interface ApuDefinition {
  readonly defaultMaster?: boolean
  readonly defaultStarter?: boolean
  readonly defaultRunning?: boolean
  readonly defaultRpmPercent?: number
  readonly starterConsumerId?: string
  readonly generatorSourceId?: string
  readonly runningRpmPercent?: number
  readonly spoolUpPercentPerSecond?: number
  readonly spoolDownPercentPerSecond?: number
}

export interface PropulsionDefinition extends CanonicalPropulsionSystemConfig {
  readonly engines?: readonly EngineDefinition[]
  readonly apu?: ApuDefinition
}

interface SetApuBooleanPayload {
  readonly enabled: boolean
}

interface SetApuNumberPayload {
  readonly percent?: number
  readonly value?: number
}

interface SetEngineBooleanPayload {
  readonly index: number
  readonly enabled: boolean
}

interface SetEngineNumberPayload {
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
  apuGeneratorAvailable(): string {
    return 'propulsion.apu.generator.available'
  },
  engineStarter(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.starter.enabled`
  },
  engineIgnitionPowered(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.ignition.powered`
  },
  engineFuelAvailable(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.fuel.available`
  },
  engineRunning(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.running`
  },
  engineCombustion(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.combustion`
  },
  engineN1Percent(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.n1.percent`
  },
  engineCommandedN1Percent(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.commanded-n1.percent`
  },
  engineRpm(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.rpm`
  },
  engineGeneratorAvailable(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.generator.available`
  },
  engineThrustN(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.thrust.newtons`
  },
  engineFuelFlowKgPerSecond(index: number): string {
    return `propulsion.engine.${normalizePositiveIndex(index)}.fuel-flow.kilograms-per-second`
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
    defineBooleanState(
      context.state,
      PropulsionStateKeys.apuMaster(),
      'APU master switch state',
      this.definition.apu?.defaultMaster
    )
    defineBooleanState(
      context.state,
      PropulsionStateKeys.apuStarter(),
      'APU starter state',
      this.definition.apu?.defaultStarter
    )
    defineBooleanState(
      context.state,
      PropulsionStateKeys.apuRunning(),
      'APU running state',
      this.definition.apu?.defaultRunning
    )
    definePercentState(
      context.state,
      PropulsionStateKeys.apuRpmPercent(),
      'APU RPM percentage',
      this.definition.apu?.defaultRpmPercent
    )
    defineBooleanState(
      context.state,
      PropulsionStateKeys.apuGeneratorAvailable(),
      'APU generator availability',
      false
    )

    for (const engine of this.definition.engines ?? []) {
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineStarter(engine.index),
        `Engine ${engine.index} starter state`,
        engine.defaultStarter
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineIgnitionPowered(engine.index),
        `Engine ${engine.index} ignition powered state`,
        false
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineFuelAvailable(engine.index),
        `Engine ${engine.index} fuel availability`,
        false
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineRunning(engine.index),
        `Engine ${engine.index} running state`,
        engine.defaultRunning
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineCombustion(engine.index),
        `Engine ${engine.index} combustion state`,
        engine.defaultRunning
      )
      definePercentState(
        context.state,
        PropulsionStateKeys.engineN1Percent(engine.index),
        `Engine ${engine.index} N1 percent`,
        engine.defaultN1Percent
      )
      definePercentState(
        context.state,
        PropulsionStateKeys.engineCommandedN1Percent(engine.index),
        `Engine ${engine.index} commanded N1 percent`,
        engine.defaultN1Percent
      )
      defineNumberState(
        context.state,
        PropulsionStateKeys.engineRpm(engine.index),
        `Engine ${engine.index} RPM`,
        engine.defaultRpm
      )
      defineBooleanState(
        context.state,
        PropulsionStateKeys.engineGeneratorAvailable(engine.index),
        `Engine ${engine.index} generator availability`,
        false
      )
      defineNumberState(
        context.state,
        PropulsionStateKeys.engineThrustN(engine.index),
        `Engine ${engine.index} thrust`,
        0,
        'newtons'
      )
      defineNumberState(
        context.state,
        PropulsionStateKeys.engineFuelFlowKgPerSecond(engine.index),
        `Engine ${engine.index} fuel flow`,
        0,
        'kilogramsPerSecond'
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

  tick(context: SimSubsystemTickContext): void {
    this.tickApu(context)

    for (const engine of this.definition.engines ?? []) {
      this.tickEngine(engine, context)
    }
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    switch (command.type) {
      case PropulsionCommandTypes.setApuMaster:
        setBoolean(
          context.state,
          PropulsionStateKeys.apuMaster(),
          (command.payload as SetApuBooleanPayload).enabled
        )
        return true
      case PropulsionCommandTypes.setApuStarter:
        setBoolean(
          context.state,
          PropulsionStateKeys.apuStarter(),
          (command.payload as SetApuBooleanPayload).enabled
        )
        return true
      case PropulsionCommandTypes.setApuRunning:
        setBoolean(
          context.state,
          PropulsionStateKeys.apuRunning(),
          (command.payload as SetApuBooleanPayload).enabled
        )
        setBoolean(
          context.state,
          PropulsionStateKeys.apuGeneratorAvailable(),
          (command.payload as SetApuBooleanPayload).enabled
        )
        return true
      case PropulsionCommandTypes.setApuRpm:
        setNumber(
          context.state,
          PropulsionStateKeys.apuRpmPercent(),
          clampPercent(
            (command.payload as SetApuNumberPayload).percent ??
              (command.payload as SetApuNumberPayload).value ??
              0
          ),
          'percent'
        )
        return true
      case PropulsionCommandTypes.setEngineStarter: {
        const payload = command.payload as SetEngineBooleanPayload
        setBoolean(
          context.state,
          PropulsionStateKeys.engineStarter(payload.index),
          payload.enabled
        )
        return true
      }
      case PropulsionCommandTypes.setEngineRunning: {
        const payload = command.payload as SetEngineBooleanPayload
        setBoolean(
          context.state,
          PropulsionStateKeys.engineRunning(payload.index),
          payload.enabled
        )
        setBoolean(
          context.state,
          PropulsionStateKeys.engineCombustion(payload.index),
          payload.enabled
        )
        return true
      }
      case PropulsionCommandTypes.setEngineN1: {
        const payload = command.payload as SetEngineNumberPayload
        setNumber(
          context.state,
          PropulsionStateKeys.engineN1Percent(payload.index),
          clampPercent(payload.value),
          'percent'
        )
        return true
      }
      case PropulsionCommandTypes.setEngineRpm: {
        const payload = command.payload as SetEngineNumberPayload
        setNumber(
          context.state,
          PropulsionStateKeys.engineRpm(payload.index),
          Math.max(0, payload.value),
          'number'
        )
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
        setBoolean(
          context.state,
          PropulsionStateKeys.engineFuelValveOpen(payload.index),
          payload.enabled
        )
        return true
      }
      case PropulsionCommandTypes.setEngineAlternator: {
        const payload = command.payload as SetEngineBooleanPayload
        setBoolean(
          context.state,
          PropulsionStateKeys.engineAlternatorEnabled(payload.index),
          payload.enabled
        )
        return true
      }
      default:
        return false
    }
  }

  private tickEngine(
    engine: EngineDefinition,
    context: SimSubsystemTickContext
  ): void {
    const starterIntent = readPropulsionBoolean(
      context.state,
      PropulsionStateKeys.engineStarter(engine.index)
    )
    const starterPowered =
      engine.starterConsumerId == null ||
      readElectricalBoolean(
        context.state,
        ElectricalStateKeys.consumerPowered(engine.starterConsumerId)
      )
    const ignitionPowered =
      engine.ignitionConsumerId == null ||
      readElectricalBoolean(
        context.state,
        ElectricalStateKeys.consumerPowered(engine.ignitionConsumerId)
      )
    const fuelAvailable =
      engine.fuelFeedIndex == null
        ? true
        : readFuelBoolean(
            context.state,
            FuelStateKeys.engineAvailable(engine.fuelFeedIndex)
          )

    if (starterIntent && starterPowered) {
      clearLoadedEngineOutputs(context.state, engine.index)
    }

    const currentN1 = readPropulsionNumber(
      context.state,
      PropulsionStateKeys.engineN1Percent(engine.index)
    )
    const starterThreshold = engine.starterN1Percent ?? 20
    const combustionThreshold = engine.minN1ForCombustionPercent ?? starterThreshold
    const idleN1 = engine.idleN1Percent ?? 25
    const throttleRatio = readPropulsionNumber(
      context.state,
      PropulsionStateKeys.engineThrottleLeverRatio(engine.index)
    )
    const combustion =
      (readPropulsionBoolean(
        context.state,
        PropulsionStateKeys.engineCombustion(engine.index)
      ) ||
        (starterIntent &&
          starterPowered &&
          ignitionPowered &&
          fuelAvailable &&
          currentN1 >= combustionThreshold)) &&
      fuelAvailable &&
      ignitionPowered
    const environment = readJetEnvironment(context.state)
    const commandedN1 = combustion
      ? computeJetCommandedN1Percent(engine, throttleRatio, environment)
      : 0
    const starterSpoolTarget = starterIntent && starterPowered ? starterThreshold : 0
    const targetN1 = combustion ? Math.max(idleN1, commandedN1) : starterSpoolTarget
    const nextN1 = integrateEngineN1(
      currentN1,
      targetN1,
      combustion,
      starterIntent && starterPowered,
      engine,
      context.dtSeconds
    )
    const generatorAvailable = combustion && nextN1 >= idleN1
    const fuelFlowKgPerSecond = combustion
      ? computeEngineFuelFlowKgPerSecond(engine, nextN1)
      : 0

    setDerivedBoolean(
      context.state,
      PropulsionStateKeys.engineIgnitionPowered(engine.index),
      ignitionPowered
    )
    setDerivedBoolean(
      context.state,
      PropulsionStateKeys.engineFuelAvailable(engine.index),
      fuelAvailable
    )
    setDerivedBoolean(
      context.state,
      PropulsionStateKeys.engineCombustion(engine.index),
      combustion
    )
    setDerivedBoolean(
      context.state,
      PropulsionStateKeys.engineRunning(engine.index),
      combustion
    )
    setDerivedNumber(
      context.state,
      PropulsionStateKeys.engineN1Percent(engine.index),
      nextN1,
      'percent'
    )
    setDerivedNumber(
      context.state,
      PropulsionStateKeys.engineCommandedN1Percent(engine.index),
      commandedN1,
      'percent'
    )
    setDerivedNumber(
      context.state,
      PropulsionStateKeys.engineFuelFlowKgPerSecond(engine.index),
      fuelFlowKgPerSecond,
      'kilogramsPerSecond'
    )
    setDerivedNumber(
      context.state,
      PropulsionStateKeys.engineRpm(engine.index),
      nextN1 * 100,
      'number'
    )
    setDerivedBoolean(
      context.state,
      PropulsionStateKeys.engineGeneratorAvailable(engine.index),
      generatorAvailable
    )

    if (engine.generatorSourceId != null) {
      setDerivedBoolean(
        context.state,
        ElectricalStateKeys.sourceAvailable(engine.generatorSourceId),
        generatorAvailable
      )
    }
  }

  private tickApu(context: SimSubsystemTickContext): void {
    const apu = this.definition.apu
    if (apu == null) return

    const master = readPropulsionBoolean(context.state, PropulsionStateKeys.apuMaster())
    const starter = readPropulsionBoolean(context.state, PropulsionStateKeys.apuStarter())
    const starterPowered =
      apu.starterConsumerId == null ||
      readElectricalBoolean(
        context.state,
        ElectricalStateKeys.consumerPowered(apu.starterConsumerId)
      )
    const currentRpm = readPropulsionNumber(
      context.state,
      PropulsionStateKeys.apuRpmPercent()
    )
    const runningRpm = apu.runningRpmPercent ?? 100
    const targetRpm = master && starter && starterPowered ? runningRpm : 0
    const rate =
      targetRpm > currentRpm
        ? apu.spoolUpPercentPerSecond ?? 30
        : apu.spoolDownPercentPerSecond ?? 45
    const nextRpm = moveTowards(currentRpm, targetRpm, rate * context.dtSeconds)
    const running = nextRpm >= runningRpm

    setDerivedNumber(
      context.state,
      PropulsionStateKeys.apuRpmPercent(),
      nextRpm,
      'percent'
    )
    setDerivedBoolean(context.state, PropulsionStateKeys.apuRunning(), running)
    setDerivedBoolean(
      context.state,
      PropulsionStateKeys.apuGeneratorAvailable(),
      running
    )

    if (apu.generatorSourceId != null) {
      setDerivedBoolean(
        context.state,
        ElectricalStateKeys.sourceAvailable(apu.generatorSourceId),
        running
      )
    }
  }
}

export function readPropulsionBoolean(
  state: SimStateStore,
  key: string,
  fallback = false
): boolean {
  return state.readBoolean(key, { fallback }) ?? fallback
}

export function readPropulsionNumber(
  state: SimStateStore,
  key: string,
  fallback = 0
): number {
  return state.readNumber(key, { fallback }) ?? fallback
}

function readJetEnvironment(state: SimStateStore): JetEngineEnvironment {
  return {
    temperatureK: state.readNumber(AirPhysicsStateKeys.temperatureK(), { fallback: 288.15 }) ?? 288.15,
    pressurePa: state.readNumber(AirPhysicsStateKeys.pressurePa(), { fallback: 101_325 }) ?? 101_325,
    mach: state.readNumber(AirPhysicsStateKeys.mach(), { fallback: 0 }) ?? 0,
    trueAirspeedMps: state.readNumber(AirPhysicsStateKeys.airspeedMps(), { fallback: 0 }) ?? 0,
  }
}

function integrateEngineN1(
  currentN1: number,
  targetN1: number,
  combustion: boolean,
  starterPowered: boolean,
  engine: EngineDefinition,
  dtSeconds: number
): number {
  if (!combustion && starterPowered) {
    return moveTowards(
      currentN1,
      targetN1,
      (engine.starterN1RatePercentPerSecond ?? engine.spoolUpPercentPerSecond ?? 12) * dtSeconds
    )
  }
  if (combustion && engine.n1NormalIntegrationRate != null) {
    const fraction = Math.min(1, Math.max(0, dtSeconds * engine.n1NormalIntegrationRate))
    return currentN1 + (targetN1 - currentN1) * fraction
  }
  const rate = targetN1 > currentN1
    ? engine.spoolUpPercentPerSecond ?? 12
    : engine.spoolDownPercentPerSecond ?? 18
  return moveTowards(currentN1, targetN1, rate * dtSeconds)
}

function computeEngineFuelFlowKgPerSecond(
  engine: EngineDefinition,
  n1Percent: number
): number {
  const idleFlow = Math.max(0, engine.idleFuelFlowKgPerSecond ?? 0)
  const highFlow = Math.max(idleFlow, engine.highFuelFlowKgPerSecond ?? idleFlow)
  if (highFlow === 0) return 0
  const idleN1 = engine.idleN1Percent ?? 25
  const highN1 = Math.max(idleN1 + 1e-6, engine.highN1Percent ?? 100)
  const ratio = clampRatio((n1Percent - idleN1) / (highN1 - idleN1))
  return idleFlow + (highFlow - idleFlow) * ratio
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
  defineNumberState(
    state,
    key,
    description,
    defaultValue == null ? undefined : clampPercent(defaultValue),
    'percent'
  )
}

function defineRatioState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number
): void {
  defineNumberState(
    state,
    key,
    description,
    defaultValue == null ? undefined : clampRatio(defaultValue),
    'ratio'
  )
}

function defineNumberState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number,
  unit: SimUnit = 'number'
): void {
  state.define({ key, unit, valueType: 'number', description })

  if (defaultValue != null) {
    state.set(key, defaultValue, { source: 'default', unit })
  }
}

function setBoolean(
  state: SimStateStore,
  key: string,
  enabled: boolean
): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean' })
  state.set(key, enabled, { source: 'runtime', unit: 'boolean' })
}

function setNumber(
  state: SimStateStore,
  key: string,
  value: number,
  unit: SimUnit
): void {
  state.define({ key, unit, valueType: 'number' })
  state.set(key, Number.isFinite(value) ? value : 0, { source: 'runtime', unit })
}

function setDerivedBoolean(
  state: SimStateStore,
  key: string,
  enabled: boolean
): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean' })
  state.set(key, enabled, { source: 'subsystem', unit: 'boolean' })
}

function setDerivedNumber(
  state: SimStateStore,
  key: string,
  value: number,
  unit: SimUnit
): void {
  state.define({ key, unit, valueType: 'number' })
  state.set(key, Number.isFinite(value) ? value : 0, { source: 'subsystem', unit })
}

function clearLoadedEngineOutputs(state: SimStateStore, index: number): void {
  state.clearSource(PropulsionStateKeys.engineCombustion(index), 'loaded')
  state.clearSource(PropulsionStateKeys.engineN1Percent(index), 'loaded')
  state.clearSource(PropulsionStateKeys.engineRpm(index), 'loaded')
  state.clearSource(PropulsionStateKeys.engineGeneratorAvailable(index), 'loaded')
}

function moveTowards(current: number, target: number, step: number): number {
  if (Math.abs(target - current) <= step) return target
  return current + Math.sign(target - current) * step
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function normalizePositiveIndex(index: number): number {
  if (!Number.isInteger(index) || index <= 0) {
    throw new RangeError(`Engine index must be a positive integer: ${index}`)
  }

  return index
}
