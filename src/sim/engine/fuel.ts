import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimSubsystem, SimSubsystemContext } from './subsystem'

export const FUEL_SUBSYSTEM_ID = 'fuel'

export const FuelCommandTypes = {
  setPumpSwitch: 'fuel.pump.setSwitch',
  setPumpActive: 'fuel.pump.setActive',
  setValveSwitch: 'fuel.valve.setSwitch',
  setValveOpen: 'fuel.valve.setOpen',
  setJunctionSetting: 'fuel.junction.setSetting',
} as const

export interface FuelPumpDefinition {
  readonly index: number
  readonly defaultSwitchEnabled?: boolean
  readonly defaultActive?: boolean
}

export interface FuelValveDefinition {
  readonly index: number
  readonly defaultSwitchOpen?: boolean
  readonly defaultOpen?: boolean
}

export interface FuelJunctionDefinition {
  readonly index: number
  readonly defaultSetting?: number
}

export interface FuelSubsystemDefinition {
  readonly pumps?: readonly FuelPumpDefinition[]
  readonly valves?: readonly FuelValveDefinition[]
  readonly junctions?: readonly FuelJunctionDefinition[]
}

interface IndexedBooleanPayload {
  readonly index: number
  readonly enabled?: boolean
  readonly open?: boolean
}

interface IndexedNumberPayload {
  readonly index: number
  readonly value?: number
  readonly setting?: number
}

export const FuelStateKeys = {
  pumpSwitchEnabled(index: number): string {
    return `fuel.pump.${normalizePositiveIndex(index)}.switch.enabled`
  },
  pumpActive(index: number): string {
    return `fuel.pump.${normalizePositiveIndex(index)}.active`
  },
  valveSwitchOpen(index: number): string {
    return `fuel.valve.${normalizePositiveIndex(index)}.switch.open`
  },
  valveOpen(index: number): string {
    return `fuel.valve.${normalizePositiveIndex(index)}.open`
  },
  junctionSetting(index: number): string {
    return `fuel.junction.${normalizePositiveIndex(index)}.setting`
  },
} as const

export class FuelSubsystem implements SimSubsystem {
  readonly id = FUEL_SUBSYSTEM_ID
  readonly phase = 'systems' as const

  constructor(private readonly definition: FuelSubsystemDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    for (const pump of this.definition.pumps ?? []) {
      defineBooleanState(
        context.state,
        FuelStateKeys.pumpSwitchEnabled(pump.index),
        `Fuel pump ${pump.index} switch state`,
        pump.defaultSwitchEnabled
      )
      defineBooleanState(
        context.state,
        FuelStateKeys.pumpActive(pump.index),
        `Fuel pump ${pump.index} active state`,
        pump.defaultActive
      )
    }

    for (const valve of this.definition.valves ?? []) {
      defineBooleanState(
        context.state,
        FuelStateKeys.valveSwitchOpen(valve.index),
        `Fuel valve ${valve.index} switch state`,
        valve.defaultSwitchOpen
      )
      defineBooleanState(
        context.state,
        FuelStateKeys.valveOpen(valve.index),
        `Fuel valve ${valve.index} open state`,
        valve.defaultOpen
      )
    }

    for (const junction of this.definition.junctions ?? []) {
      defineNumberState(
        context.state,
        FuelStateKeys.junctionSetting(junction.index),
        `Fuel junction ${junction.index} setting`,
        junction.defaultSetting
      )
    }
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    switch (command.type) {
      case FuelCommandTypes.setPumpSwitch: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          FuelStateKeys.pumpSwitchEnabled(payload.index),
          payload.enabled ?? false
        )
        return true
      }
      case FuelCommandTypes.setPumpActive: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          FuelStateKeys.pumpActive(payload.index),
          payload.enabled ?? false
        )
        return true
      }
      case FuelCommandTypes.setValveSwitch: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          FuelStateKeys.valveSwitchOpen(payload.index),
          payload.open ?? payload.enabled ?? false
        )
        return true
      }
      case FuelCommandTypes.setValveOpen: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          FuelStateKeys.valveOpen(payload.index),
          payload.open ?? payload.enabled ?? false
        )
        return true
      }
      case FuelCommandTypes.setJunctionSetting: {
        const payload = command.payload as IndexedNumberPayload
        setNumber(
          context.state,
          FuelStateKeys.junctionSetting(payload.index),
          payload.setting ?? payload.value ?? 0
        )
        return true
      }
      default:
        return false
    }
  }
}

export function readFuelBoolean(
  state: SimStateStore,
  key: string,
  fallback = false
): boolean {
  return state.readBoolean(key, { fallback }) ?? fallback
}

export function readFuelNumber(state: SimStateStore, key: string, fallback = 0): number {
  return state.readNumber(key, { fallback }) ?? fallback
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

function defineNumberState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number
): void {
  state.define({ key, unit: 'number', valueType: 'number', description })
  if (defaultValue != null) {
    state.set(key, Number.isFinite(defaultValue) ? defaultValue : 0, {
      source: 'default',
      unit: 'number',
    })
  }
}

function setBoolean(state: SimStateStore, key: string, enabled: boolean): void {
  state.set(key, enabled, { source: 'runtime', unit: 'boolean' })
}

function setNumber(state: SimStateStore, key: string, value: number): void {
  state.set(key, Number.isFinite(value) ? value : 0, {
    source: 'runtime',
    unit: 'number',
  })
}

function normalizePositiveIndex(index: number): number {
  if (!Number.isInteger(index) || index <= 0) {
    throw new RangeError(`Fuel index must be a positive integer: ${index}`)
  }

  return index
}
