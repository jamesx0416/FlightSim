import type {
  CanonicalFuelEngineFeedConfig,
  CanonicalFuelTankConfig,
} from './aircraft'
import type { SimCommand } from './commands'
import {
  ElectricalStateKeys,
  readElectricalBoolean,
} from './electrical'
import type { SimStateStore } from './state'
import type {
  SimSubsystem,
  SimSubsystemContext,
  SimSubsystemTickContext,
} from './subsystem'

export const FUEL_SUBSYSTEM_ID = 'fuel'

export const FuelCommandTypes = {
  setPumpSwitch: 'fuel.pump.setSwitch',
  setPumpActive: 'fuel.pump.setActive',
  setValveSwitch: 'fuel.valve.setSwitch',
  setValveOpen: 'fuel.valve.setOpen',
  setJunctionSetting: 'fuel.junction.setSetting',
  setTankQuantity: 'fuel.tank.setQuantity',
} as const

export interface FuelPumpDefinition {
  readonly index?: number
  readonly id?: string
  readonly busConsumerId?: string
  readonly tankId?: string
  readonly defaultSwitchEnabled?: boolean
  readonly defaultActive?: boolean
}

export interface FuelValveDefinition {
  readonly index?: number
  readonly id?: string
  readonly defaultSwitchOpen?: boolean
  readonly defaultOpen?: boolean
}

export interface FuelJunctionDefinition {
  readonly index: number
  readonly defaultSetting?: number
}

export interface FuelSubsystemDefinition {
  readonly tanks?: readonly CanonicalFuelTankConfig[]
  readonly pumps?: readonly FuelPumpDefinition[]
  readonly valves?: readonly FuelValveDefinition[]
  readonly engineFeeds?: readonly CanonicalFuelEngineFeedConfig[]
  readonly junctions?: readonly FuelJunctionDefinition[]
}

interface IndexedBooleanPayload {
  readonly index: number
  readonly enabled?: boolean
  readonly active?: boolean
  readonly open?: boolean
}

interface IndexedNumberPayload {
  readonly index: number
  readonly setting?: number
  readonly value?: number
}

interface SetFuelTankQuantityPayload {
  readonly id: string
  readonly ratio?: number
  readonly value?: number
}

export const FuelStateKeys = {
  tankQuantityRatio(id: string): string {
    return `fuel.tank.${normalizeStateSegment(id)}.quantity.ratio`
  },
  pumpSwitchEnabled(indexOrId: number | string): string {
    return typeof indexOrId === 'number'
      ? `fuel.pump.${normalizePositiveIndex(indexOrId)}.switch.enabled`
      : `fuel.pump.${normalizeStateSegment(indexOrId)}.switch.enabled`
  },
  pumpActive(indexOrId: number | string): string {
    return typeof indexOrId === 'number'
      ? `fuel.pump.${normalizePositiveIndex(indexOrId)}.active`
      : `fuel.pump.${normalizeStateSegment(indexOrId)}.active`
  },
  valveSwitchOpen(indexOrId: number | string): string {
    return typeof indexOrId === 'number'
      ? `fuel.valve.${normalizePositiveIndex(indexOrId)}.switch.open`
      : `fuel.valve.${normalizeStateSegment(indexOrId)}.switch.open`
  },
  valveOpen(indexOrId: number | string): string {
    return typeof indexOrId === 'number'
      ? `fuel.valve.${normalizePositiveIndex(indexOrId)}.open`
      : `fuel.valve.${normalizeStateSegment(indexOrId)}.open`
  },
  junctionSetting(index: number): string {
    return `fuel.junction.${normalizePositiveIndex(index)}.setting`
  },
  engineAvailable(index: number): string {
    return `fuel.engine.${normalizePositiveIndex(index)}.available`
  },
}

export class FuelSubsystem implements SimSubsystem {
  readonly id = FUEL_SUBSYSTEM_ID
  readonly phase = 'systems'

  constructor(private readonly definition: FuelSubsystemDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    for (const tank of this.definition.tanks ?? []) {
      defineRatioState(
        context.state,
        FuelStateKeys.tankQuantityRatio(tank.id),
        `Fuel tank ${tank.id} quantity ratio`,
        tank.defaultQuantityRatio
      )
    }

    for (const pump of this.definition.pumps ?? []) {
      definePumpStates(context.state, pump.id, pump.index, pump.defaultSwitchEnabled, pump.defaultActive)
    }

    for (const valve of this.definition.valves ?? []) {
      defineValveStates(
        context.state,
        valve.id,
        valve.index,
        valve.defaultSwitchOpen,
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

    for (const feed of this.definition.engineFeeds ?? []) {
      defineBooleanState(
        context.state,
        FuelStateKeys.engineAvailable(feed.engineIndex),
        `Engine ${feed.engineIndex} fuel availability`,
        false
      )
    }
  }

  tick(context: SimSubsystemTickContext): void {
    for (const pump of this.definition.pumps ?? []) {
      const switchEnabled = readPumpBoolean(
        context.state,
        pump.id,
        pump.index,
        'switch'
      )
      const hasElectricalDependency = pump.busConsumerId != null
      const powered =
        !hasElectricalDependency ||
        readElectricalBoolean(
          context.state,
          ElectricalStateKeys.consumerPowered(pump.busConsumerId)
        )
      const active = switchEnabled && powered

      setDerivedPumpBoolean(context.state, pump.id, pump.index, 'active', active)
    }

    for (const valve of this.definition.valves ?? []) {
      const switchOpen = readValveBoolean(
        context.state,
        valve.id,
        valve.index,
        'switch'
      )
      setDerivedValveBoolean(context.state, valve.id, valve.index, 'open', switchOpen)
    }

    for (const feed of this.definition.engineFeeds ?? []) {
      const tankHasFuel =
        feed.tankId == null ||
        readFuelNumber(
          context.state,
          FuelStateKeys.tankQuantityRatio(feed.tankId),
          1
        ) > 0
      const valvesOpen = (feed.valveIds ?? []).every(id =>
        readFuelBoolean(context.state, FuelStateKeys.valveOpen(id))
      )
      const pumpIds = feed.pumpIds ?? []
      const pumpsSatisfied =
        pumpIds.length === 0 ||
        pumpIds.some(id =>
          readFuelBoolean(context.state, FuelStateKeys.pumpActive(id))
        )

      setDerivedBoolean(
        context.state,
        FuelStateKeys.engineAvailable(feed.engineIndex),
        tankHasFuel && valvesOpen && pumpsSatisfied
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
          payload.enabled ?? payload.active ?? false
        )
        return true
      }
      case FuelCommandTypes.setPumpActive: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          FuelStateKeys.pumpActive(payload.index),
          payload.active ?? payload.enabled ?? false
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
      case FuelCommandTypes.setTankQuantity: {
        const payload = command.payload as SetFuelTankQuantityPayload
        setNumber(
          context.state,
          FuelStateKeys.tankQuantityRatio(payload.id),
          clampRatio(payload.ratio ?? payload.value ?? 0),
          'ratio'
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

export function readFuelNumber(
  state: SimStateStore,
  key: string,
  fallback = 0
): number {
  return state.readNumber(key, { fallback }) ?? fallback
}

function definePumpStates(
  state: SimStateStore,
  id: string | undefined,
  index: number | undefined,
  defaultSwitchEnabled?: boolean,
  defaultActive?: boolean
): void {
  const ids = collectFuelKeys(id, index)
  for (const keyId of ids) {
    defineBooleanState(
      state,
      FuelStateKeys.pumpSwitchEnabled(keyId),
      `Fuel pump ${keyId} switch state`,
      defaultSwitchEnabled
    )
    defineBooleanState(
      state,
      FuelStateKeys.pumpActive(keyId),
      `Fuel pump ${keyId} active state`,
      defaultActive
    )
  }
}

function defineValveStates(
  state: SimStateStore,
  id: string | undefined,
  index: number | undefined,
  defaultSwitchOpen?: boolean,
  defaultOpen?: boolean
): void {
  const ids = collectFuelKeys(id, index)
  for (const keyId of ids) {
    defineBooleanState(
      state,
      FuelStateKeys.valveSwitchOpen(keyId),
      `Fuel valve ${keyId} switch state`,
      defaultSwitchOpen
    )
    defineBooleanState(
      state,
      FuelStateKeys.valveOpen(keyId),
      `Fuel valve ${keyId} open state`,
      defaultOpen
    )
  }
}

function readPumpBoolean(
  state: SimStateStore,
  id: string | undefined,
  index: number | undefined,
  kind: 'switch' | 'active'
): boolean {
  const key = kind === 'switch' ? FuelStateKeys.pumpSwitchEnabled : FuelStateKeys.pumpActive
  if (id != null && readFuelBoolean(state, key(id))) return true
  if (index != null && readFuelBoolean(state, key(index))) return true
  return false
}

function readValveBoolean(
  state: SimStateStore,
  id: string | undefined,
  index: number | undefined,
  kind: 'switch' | 'open'
): boolean {
  const key = kind === 'switch' ? FuelStateKeys.valveSwitchOpen : FuelStateKeys.valveOpen
  if (id != null && readFuelBoolean(state, key(id))) return true
  if (index != null && readFuelBoolean(state, key(index))) return true
  return false
}

function setDerivedPumpBoolean(
  state: SimStateStore,
  id: string | undefined,
  index: number | undefined,
  kind: 'active',
  value: boolean
): void {
  for (const keyId of collectFuelKeys(id, index)) {
    setDerivedBoolean(state, FuelStateKeys.pumpActive(keyId), value)
  }
}

function setDerivedValveBoolean(
  state: SimStateStore,
  id: string | undefined,
  index: number | undefined,
  kind: 'open',
  value: boolean
): void {
  for (const keyId of collectFuelKeys(id, index)) {
    setDerivedBoolean(state, FuelStateKeys.valveOpen(keyId), value)
  }
}

function collectFuelKeys(
  id: string | undefined,
  index: number | undefined
): Array<string | number> {
  const keys: Array<string | number> = []
  if (id != null) keys.push(id)
  if (index != null) keys.push(index)
  return keys
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
  unit: 'number' | 'ratio' = 'number'
): void {
  state.define({ key, unit, valueType: 'number', description })

  if (defaultValue != null) {
    state.set(key, Number.isFinite(defaultValue) ? defaultValue : 0, {
      source: 'default',
      unit,
    })
  }
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
  unit: 'number' | 'ratio' = 'number'
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

function normalizePositiveIndex(index: number): number {
  if (!Number.isInteger(index) || index <= 0) {
    throw new RangeError(`Fuel index must be a positive integer: ${index}`)
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

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
