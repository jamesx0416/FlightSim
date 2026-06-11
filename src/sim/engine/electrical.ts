import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimSubsystem, SimSubsystemContext } from './subsystem'

export const ELECTRICAL_SUBSYSTEM_ID = 'electrical'

export const ElectricalCommandTypes = {
  setBattery: 'electrical.battery.set',
  setExternalPowerAvailable: 'electrical.externalPower.setAvailable',
  setExternalPowerConnected: 'electrical.externalPower.setConnected',
  setAvionicsMaster: 'electrical.avionics.setMaster',
  setBusVoltage: 'electrical.bus.setVoltage',
} as const

export interface BatteryDefinition {
  readonly index?: number
  readonly defaultEnabled?: boolean
}

export interface ElectricalVoltageBusDefinition {
  readonly id: string
  readonly defaultVoltage?: number
}

export interface ElectricalDefinition {
  readonly batteries?: readonly BatteryDefinition[]
  readonly buses?: readonly ElectricalVoltageBusDefinition[]
  readonly defaultExternalPowerAvailable?: boolean
  readonly defaultExternalPowerConnected?: boolean
  readonly defaultAvionicsMaster?: boolean
}

export interface SetElectricalBooleanPayload {
  readonly enabled: boolean
  readonly index?: number
}

export interface SetElectricalBusVoltagePayload {
  readonly id: string
  readonly volts: number
}

export const ElectricalStateKeys = {
  batteryEnabled(index?: number): string {
    return index == null
      ? 'electrical.battery.enabled'
      : `electrical.battery.${normalizeNonNegativeIndex(index)}.enabled`
  },
  externalPowerAvailable(): string {
    return 'electrical.external-power.available'
  },
  externalPowerConnected(): string {
    return 'electrical.external-power.connected'
  },
  avionicsMasterEnabled(): string {
    return 'electrical.avionics.master.enabled'
  },
  busVoltage(id: string): string {
    return `electrical.bus.${normalizeStateSegment(id)}.voltage`
  },
}

export class ElectricalSubsystem implements SimSubsystem {
  readonly id = ELECTRICAL_SUBSYSTEM_ID
  readonly phase = 'systems'

  constructor(private readonly definition: ElectricalDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    defineBooleanState(
      context.state,
      ElectricalStateKeys.batteryEnabled(),
      'Primary battery switch state',
      this.definition.batteries?.find(battery => battery.index == null || battery.index === 1)
        ?.defaultEnabled
    )

    for (const battery of this.definition.batteries ?? []) {
      if (battery.index == null) {
        continue
      }

      defineBooleanState(
        context.state,
        ElectricalStateKeys.batteryEnabled(battery.index),
        `Battery ${battery.index} switch state`,
        battery.defaultEnabled
      )
    }

    defineBooleanState(
      context.state,
      ElectricalStateKeys.externalPowerAvailable(),
      'External power availability',
      this.definition.defaultExternalPowerAvailable
    )
    defineBooleanState(
      context.state,
      ElectricalStateKeys.externalPowerConnected(),
      'External power connected state',
      this.definition.defaultExternalPowerConnected
    )
    defineBooleanState(
      context.state,
      ElectricalStateKeys.avionicsMasterEnabled(),
      'Avionics master switch state',
      this.definition.defaultAvionicsMaster
    )

    for (const bus of this.definition.buses ?? []) {
      defineNumberState(
        context.state,
        ElectricalStateKeys.busVoltage(bus.id),
        `Electrical bus ${bus.id} voltage`,
        bus.defaultVoltage,
        'number'
      )
    }
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    switch (command.type) {
      case ElectricalCommandTypes.setBattery: {
        const payload = command.payload as SetElectricalBooleanPayload
        setBoolean(context.state, ElectricalStateKeys.batteryEnabled(payload.index), payload.enabled)
        return true
      }
      case ElectricalCommandTypes.setExternalPowerAvailable:
        setBoolean(
          context.state,
          ElectricalStateKeys.externalPowerAvailable(),
          (command.payload as SetElectricalBooleanPayload).enabled
        )
        return true
      case ElectricalCommandTypes.setExternalPowerConnected:
        setBoolean(
          context.state,
          ElectricalStateKeys.externalPowerConnected(),
          (command.payload as SetElectricalBooleanPayload).enabled
        )
        return true
      case ElectricalCommandTypes.setAvionicsMaster:
        setBoolean(
          context.state,
          ElectricalStateKeys.avionicsMasterEnabled(),
          (command.payload as SetElectricalBooleanPayload).enabled
        )
        return true
      case ElectricalCommandTypes.setBusVoltage: {
        const payload = command.payload as SetElectricalBusVoltagePayload
        setNumber(
          context.state,
          ElectricalStateKeys.busVoltage(payload.id),
          Math.max(0, payload.volts),
          'number'
        )
        return true
      }
      default:
        return false
    }
  }
}

export function readElectricalBoolean(
  state: SimStateStore,
  key: string,
  fallback = false
): boolean {
  return state.readBoolean(key, { fallback }) ?? fallback
}

export function readElectricalNumber(
  state: SimStateStore,
  key: string,
  fallback = 0
): number {
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
  defaultValue?: number,
  unit: 'number' = 'number'
): void {
  state.define({ key, unit, valueType: 'number', description })

  if (defaultValue != null) {
    state.set(key, defaultValue, { source: 'default', unit })
  }
}

function setBoolean(state: SimStateStore, key: string, enabled: boolean): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean' })
  state.set(key, enabled, { source: 'runtime', unit: 'boolean' })
}

function setNumber(
  state: SimStateStore,
  key: string,
  value: number,
  unit: 'number'
): void {
  state.define({ key, unit, valueType: 'number' })
  state.set(key, Number.isFinite(value) ? value : 0, { source: 'runtime', unit })
}

function normalizeNonNegativeIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`Electrical index must be a non-negative integer: ${index}`)
  }

  return index
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
