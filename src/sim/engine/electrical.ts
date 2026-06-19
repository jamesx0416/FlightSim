import type {
  CanonicalElectricalBusConfig,
  CanonicalElectricalSystemConfig,
} from './aircraft'
import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type {
  SimSubsystem,
  SimSubsystemContext,
  SimSubsystemTickContext,
} from './subsystem'

export const ELECTRICAL_SUBSYSTEM_ID = 'electrical'

export const ElectricalCommandTypes = {
  setBattery: 'electrical.battery.set',
  setExternalPowerAvailable: 'electrical.externalPower.setAvailable',
  setExternalPowerConnected: 'electrical.externalPower.setConnected',
  setAvionicsMaster: 'electrical.avionics.setMaster',
  setBusVoltage: 'electrical.bus.setVoltage',
  setSourceAvailable: 'electrical.source.setAvailable',
  setSourceConnected: 'electrical.source.setConnected',
  setConsumerSwitch: 'electrical.consumer.setSwitch',
} as const

export interface BatteryDefinition {
  readonly index?: number
  readonly defaultEnabled?: boolean
}

export interface ElectricalVoltageBusDefinition extends CanonicalElectricalBusConfig {
  readonly defaultVoltage?: number
}

export interface ElectricalDefinition extends CanonicalElectricalSystemConfig {
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

export interface SetElectricalSourceAvailablePayload {
  readonly id: string
  readonly available?: boolean
  readonly enabled?: boolean
}

export interface SetElectricalSourceConnectedPayload {
  readonly id: string
  readonly connected?: boolean
  readonly enabled?: boolean
}

export interface SetElectricalConsumerSwitchPayload {
  readonly id: string
  readonly enabled: boolean
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
  sourceAvailable(id: string): string {
    return `electrical.source.${normalizeStateSegment(id)}.available`
  },
  sourceConnected(id: string): string {
    return `electrical.source.${normalizeStateSegment(id)}.connected`
  },
  sourceVoltage(id: string): string {
    return `electrical.source.${normalizeStateSegment(id)}.voltage`
  },
  busPowered(id: string): string {
    return `electrical.bus.${normalizeStateSegment(id)}.powered`
  },
  busVoltage(id: string): string {
    return `electrical.bus.${normalizeStateSegment(id)}.voltage`
  },
  consumerSwitchEnabled(id: string): string {
    return `electrical.consumer.${normalizeStateSegment(id)}.switch.enabled`
  },
  consumerPowered(id: string): string {
    return `electrical.consumer.${normalizeStateSegment(id)}.powered`
  },
}

export class ElectricalSubsystem implements SimSubsystem {
  readonly id = ELECTRICAL_SUBSYSTEM_ID
  readonly phase = 'systems'

  constructor(private readonly definition: ElectricalDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    const primaryBattery = this.definition.batteries?.find(
      battery => battery.index == null || battery.index === 1
    )

    defineBooleanState(
      context.state,
      ElectricalStateKeys.batteryEnabled(),
      'Primary battery switch state',
      primaryBattery?.defaultEnabled
    )

    for (const battery of this.definition.batteries ?? []) {
      if (battery.index == null) continue
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
      defineBooleanState(
        context.state,
        ElectricalStateKeys.busPowered(bus.id),
        `Electrical bus ${bus.id} powered state`,
        bus.defaultPowered
      )
      defineNumberState(
        context.state,
        ElectricalStateKeys.busVoltage(bus.id),
        `Electrical bus ${bus.id} voltage`,
        bus.defaultVoltage ?? bus.nominalVolts,
        'number'
      )
    }

    for (const source of this.definition.sources ?? []) {
      defineBooleanState(
        context.state,
        ElectricalStateKeys.sourceAvailable(source.id),
        `Electrical source ${source.id} availability`,
        source.defaultAvailable
      )
      defineBooleanState(
        context.state,
        ElectricalStateKeys.sourceConnected(source.id),
        `Electrical source ${source.id} connected state`,
        source.defaultConnected
      )
      defineNumberState(
        context.state,
        ElectricalStateKeys.sourceVoltage(source.id),
        `Electrical source ${source.id} voltage`,
        source.nominalVolts,
        'number'
      )
    }

    for (const consumer of this.definition.consumers ?? []) {
      defineBooleanState(
        context.state,
        ElectricalStateKeys.consumerSwitchEnabled(consumer.id),
        `Electrical consumer ${consumer.id} switch state`,
        consumer.defaultSwitchEnabled
      )
      defineBooleanState(
        context.state,
        ElectricalStateKeys.consumerPowered(consumer.id),
        `Electrical consumer ${consumer.id} powered state`,
        false
      )
    }
  }

  tick(context: SimSubsystemTickContext): void {
    for (const bus of this.definition.buses ?? []) {
      let voltage = 0

      for (const source of this.definition.sources ?? []) {
        if (source.busId !== bus.id) continue
        const available = readElectricalBoolean(
          context.state,
          ElectricalStateKeys.sourceAvailable(source.id)
        )
        const connected = readElectricalBoolean(
          context.state,
          ElectricalStateKeys.sourceConnected(source.id)
        )

        if (available && connected) {
          voltage = Math.max(
            voltage,
            readElectricalNumber(
              context.state,
              ElectricalStateKeys.sourceVoltage(source.id),
              source.nominalVolts ?? bus.nominalVolts ?? 0
            )
          )
        }
      }

      setDerivedBoolean(
        context.state,
        ElectricalStateKeys.busPowered(bus.id),
        voltage > 0
      )
      setDerivedNumber(
        context.state,
        ElectricalStateKeys.busVoltage(bus.id),
        voltage,
        'number'
      )
    }

    for (const consumer of this.definition.consumers ?? []) {
      const switchEnabled = readElectricalBoolean(
        context.state,
        ElectricalStateKeys.consumerSwitchEnabled(consumer.id)
      )
      const busPowered = readElectricalBoolean(
        context.state,
        ElectricalStateKeys.busPowered(consumer.busId)
      )
      setDerivedBoolean(
        context.state,
        ElectricalStateKeys.consumerPowered(consumer.id),
        switchEnabled && busPowered
      )
    }
  }

  handleCommand(
    command: SimCommand,
    context: SimSubsystemContext
  ): boolean {
    switch (command.type) {
      case ElectricalCommandTypes.setBattery: {
        const payload = command.payload as SetElectricalBooleanPayload
        setBoolean(
          context.state,
          ElectricalStateKeys.batteryEnabled(payload.index),
          payload.enabled
        )
        setBoolean(
          context.state,
          ElectricalStateKeys.sourceAvailable('battery'),
          payload.enabled
        )
        setBoolean(
          context.state,
          ElectricalStateKeys.sourceConnected('battery'),
          payload.enabled
        )
        return true
      }
      case ElectricalCommandTypes.setExternalPowerAvailable:
        setBoolean(
          context.state,
          ElectricalStateKeys.externalPowerAvailable(),
          (command.payload as SetElectricalBooleanPayload).enabled
        )
        setBoolean(
          context.state,
          ElectricalStateKeys.sourceAvailable('external'),
          (command.payload as SetElectricalBooleanPayload).enabled
        )
        return true
      case ElectricalCommandTypes.setExternalPowerConnected:
        setBoolean(
          context.state,
          ElectricalStateKeys.externalPowerConnected(),
          (command.payload as SetElectricalBooleanPayload).enabled
        )
        setBoolean(
          context.state,
          ElectricalStateKeys.sourceConnected('external'),
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
      case ElectricalCommandTypes.setSourceAvailable: {
        const payload = command.payload as SetElectricalSourceAvailablePayload
        setBoolean(
          context.state,
          ElectricalStateKeys.sourceAvailable(payload.id),
          payload.available ?? payload.enabled ?? false
        )
        return true
      }
      case ElectricalCommandTypes.setSourceConnected: {
        const payload = command.payload as SetElectricalSourceConnectedPayload
        setBoolean(
          context.state,
          ElectricalStateKeys.sourceConnected(payload.id),
          payload.connected ?? payload.enabled ?? false
        )
        return true
      }
      case ElectricalCommandTypes.setConsumerSwitch: {
        const payload = command.payload as SetElectricalConsumerSwitchPayload
        setBoolean(
          context.state,
          ElectricalStateKeys.consumerSwitchEnabled(payload.id),
          payload.enabled
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
    state.set(key, Number.isFinite(defaultValue) ? defaultValue : 0, {
      source: 'default',
      unit,
    })
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
  unit: 'number'
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
  unit: 'number'
): void {
  state.define({ key, unit, valueType: 'number' })
  state.set(key, Number.isFinite(value) ? value : 0, { source: 'subsystem', unit })
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
