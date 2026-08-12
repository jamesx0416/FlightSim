import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimSubsystem, SimSubsystemContext } from './subsystem'

export const ENVIRONMENT_SUBSYSTEM_ID = 'environment'

export const EnvironmentCommandTypes = {
  setPitotHeat: 'environment.pitotHeat.set',
  setStructuralDeice: 'environment.structuralDeice.set',
  setEngineAntiIce: 'environment.engineAntiIce.set',
  setTemperatureOffset: 'environment.atmosphere.setTemperatureOffset',
  setSeaLevelPressure: 'environment.atmosphere.setSeaLevelPressure',
  setWindNed: 'environment.wind.setNed',
} as const

export interface EnvironmentSubsystemDefinition {
  readonly pitotHeat?: readonly PitotHeatDefinition[]
  readonly engineAntiIce?: readonly EngineAntiIceDefinition[]
  readonly defaultStructuralDeiceEnabled?: boolean
  readonly defaultTemperatureOffsetCelsius?: number
  readonly defaultSeaLevelPressurePa?: number
  readonly defaultWindNedMps?: readonly [number, number, number]
}

export interface PitotHeatDefinition {
  readonly index: number
  readonly defaultEnabled?: boolean
}

export interface EngineAntiIceDefinition {
  readonly index: number
  readonly defaultEnabled?: boolean
}

interface ScalarPayload {
  readonly value: number
}

interface WindNedPayload {
  readonly northMps?: number
  readonly eastMps?: number
  readonly downMps?: number
}

interface IndexedBooleanPayload {
  readonly index?: number
  readonly enabled?: boolean
  readonly value?: boolean | number
}

export const EnvironmentStateKeys = {
  pitotHeatEnabled(index = 1): string {
    return `environment.pitotHeat.${normalizePositiveIndex(index)}.enabled`
  },
  structuralDeiceEnabled(): string {
    return 'environment.structuralDeice.enabled'
  },
  engineAntiIceEnabled(index = 1): string {
    return `environment.engineAntiIce.${normalizePositiveIndex(index)}.enabled`
  },
  temperatureOffsetCelsius(): string {
    return 'environment.atmosphere.temperature-offset.celsius'
  },
  seaLevelPressurePa(): string {
    return 'environment.atmosphere.sea-level-pressure.pascals'
  },
  windNorthMps(): string {
    return 'environment.wind.north.meters-per-second'
  },
  windEastMps(): string {
    return 'environment.wind.east.meters-per-second'
  },
  windDownMps(): string {
    return 'environment.wind.down.meters-per-second'
  },
} as const

export class EnvironmentSubsystem implements SimSubsystem {
  readonly id = ENVIRONMENT_SUBSYSTEM_ID
  readonly phase = 'systems' as const

  constructor(
    private readonly definition: EnvironmentSubsystemDefinition = {}
  ) {}

  initialize(context: SimSubsystemContext): void {
    for (const pitotHeat of this.definition.pitotHeat ?? []) {
      defineBooleanState(
        context.state,
        EnvironmentStateKeys.pitotHeatEnabled(pitotHeat.index),
        `Pitot heat ${pitotHeat.index} enabled`,
        pitotHeat.defaultEnabled
      )
    }

    defineBooleanState(
      context.state,
      EnvironmentStateKeys.structuralDeiceEnabled(),
      'Structural deice enabled',
      this.definition.defaultStructuralDeiceEnabled
    )

    for (const engineAntiIce of this.definition.engineAntiIce ?? []) {
      defineBooleanState(
        context.state,
        EnvironmentStateKeys.engineAntiIceEnabled(engineAntiIce.index),
        `Engine anti-ice ${engineAntiIce.index} enabled`,
        engineAntiIce.defaultEnabled
      )
    }

    defineNumberState(
      context.state,
      EnvironmentStateKeys.temperatureOffsetCelsius(),
      'Atmospheric temperature offset from ISA',
      this.definition.defaultTemperatureOffsetCelsius ?? 0,
      'celsius'
    )
    defineNumberState(
      context.state,
      EnvironmentStateKeys.seaLevelPressurePa(),
      'Sea level pressure',
      this.definition.defaultSeaLevelPressurePa ?? 101_325,
      'pascals'
    )
    const wind = this.definition.defaultWindNedMps ?? [0, 0, 0]
    defineNumberState(context.state, EnvironmentStateKeys.windNorthMps(), 'Wind north component', wind[0], 'metersPerSecond')
    defineNumberState(context.state, EnvironmentStateKeys.windEastMps(), 'Wind east component', wind[1], 'metersPerSecond')
    defineNumberState(context.state, EnvironmentStateKeys.windDownMps(), 'Wind down component', wind[2], 'metersPerSecond')
  }

  handleCommand(
    command: SimCommand,
    context: SimSubsystemContext
  ): boolean {
    switch (command.type) {
      case EnvironmentCommandTypes.setPitotHeat: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          EnvironmentStateKeys.pitotHeatEnabled(payload.index ?? 1),
          payload.enabled ?? payload.value ?? false
        )
        return true
      }
      case EnvironmentCommandTypes.setStructuralDeice: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          EnvironmentStateKeys.structuralDeiceEnabled(),
          payload.enabled ?? payload.value ?? false
        )
        return true
      }
      case EnvironmentCommandTypes.setEngineAntiIce: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          EnvironmentStateKeys.engineAntiIceEnabled(payload.index ?? 1),
          payload.enabled ?? payload.value ?? false
        )
        return true
      }
      case EnvironmentCommandTypes.setTemperatureOffset: {
        const payload = command.payload as ScalarPayload
        setNumber(context.state, EnvironmentStateKeys.temperatureOffsetCelsius(), payload.value, 'celsius')
        return true
      }
      case EnvironmentCommandTypes.setSeaLevelPressure: {
        const payload = command.payload as ScalarPayload
        setNumber(context.state, EnvironmentStateKeys.seaLevelPressurePa(), Math.max(1, payload.value), 'pascals')
        return true
      }
      case EnvironmentCommandTypes.setWindNed: {
        const payload = command.payload as WindNedPayload
        setNumber(context.state, EnvironmentStateKeys.windNorthMps(), payload.northMps ?? 0, 'metersPerSecond')
        setNumber(context.state, EnvironmentStateKeys.windEastMps(), payload.eastMps ?? 0, 'metersPerSecond')
        setNumber(context.state, EnvironmentStateKeys.windDownMps(), payload.downMps ?? 0, 'metersPerSecond')
        return true
      }
      default:
        return false
    }
  }
}

export function readEnvironmentBoolean(
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
    setBoolean(state, key, defaultValue, 'default')
  }
}

function defineNumberState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue: number,
  unit: 'celsius' | 'pascals' | 'metersPerSecond'
): void {
  state.define({ key, unit, valueType: 'number', description })
  state.set(key, defaultValue, { source: 'default', unit })
}

function setNumber(
  state: SimStateStore,
  key: string,
  value: number,
  unit: 'celsius' | 'pascals' | 'metersPerSecond'
): void {
  state.set(key, Number.isFinite(value) ? value : 0, { source: 'runtime', unit })
}

function setBoolean(
  state: SimStateStore,
  key: string,
  value: boolean | number,
  source: 'default' | 'runtime' = 'runtime'
): void {
  state.set(key, value === true || value === 1, {
    source,
    unit: 'boolean',
  })
}

function normalizePositiveIndex(index: number): number {
  return Number.isFinite(index) && index > 0 ? Math.trunc(index) : 1
}
