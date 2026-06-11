import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimSubsystem, SimSubsystemContext } from './subsystem'

export const LIGHTING_ELECTRICAL_SUBSYSTEM_ID = 'lighting-electrical'

export const LightingCommandTypes = {
  setPotentiometer: 'lighting.setPotentiometer',
  setPower: 'lighting.setPower',
  setChannelEnabled: 'lighting.setChannelEnabled',
  setElectricalBusPowered: 'electrical.setBusPowered',
} as const

export type LightPotentiometerKind = 'panel' | 'instrument' | 'cabin' | 'generic'

export interface LightPotentiometerDefinition {
  readonly index: number
  readonly kind?: LightPotentiometerKind
  readonly defaultRatio?: number
}

export interface LightPowerDefinition {
  readonly channel: string
  readonly defaultRatio?: number
}

export interface LightChannelDefinition {
  readonly channel: string
  readonly defaultEnabled?: boolean
}

export interface ElectricalBusDefinition {
  readonly id: string
  readonly defaultPowered?: boolean
}

export interface LightingElectricalDefinition {
  readonly potentiometers?: readonly LightPotentiometerDefinition[]
  readonly powerChannels?: readonly LightPowerDefinition[]
  readonly lightChannels?: readonly LightChannelDefinition[]
  readonly electricalBuses?: readonly ElectricalBusDefinition[]
}

export interface SetLightPotentiometerPayload {
  readonly index: number
  readonly ratio: number
  readonly kind?: LightPotentiometerKind
}

export interface SetLightPowerPayload {
  readonly channel: string
  readonly ratio: number
}

export interface SetLightChannelEnabledPayload {
  readonly channel: string
  readonly enabled: boolean
  readonly index?: number
}

export interface SetElectricalBusPoweredPayload {
  readonly id: string
  readonly powered: boolean
}

export const LightingStateKeys = {
  potentiometer(index: number): string {
    return `lighting.potentiometer.${normalizePositiveIndex(index)}.ratio`
  },
  panelBrightness(index: number): string {
    return `lighting.panel.${normalizePositiveIndex(index)}.brightness.ratio`
  },
  instrumentBrightness(index: number): string {
    return `lighting.instrument.${normalizePositiveIndex(index)}.brightness.ratio`
  },
  power(channel: string, index?: number): string {
    const normalizedChannel = normalizeStateSegment(channel)
    return index == null
      ? `lighting.power.${normalizedChannel}.ratio`
      : `lighting.power.${normalizedChannel}.${normalizePositiveIndex(index)}.ratio`
  },
  channelEnabled(channel: string, index?: number): string {
    const normalizedChannel = normalizeStateSegment(channel)
    return index == null
      ? `lighting.channel.${normalizedChannel}.enabled`
      : `lighting.channel.${normalizedChannel}.${normalizePositiveIndex(index)}.enabled`
  },
  electricalBusPowered(id: string): string {
    return `electrical.bus.${normalizeStateSegment(id)}.powered`
  },
}

export class LightingElectricalSubsystem implements SimSubsystem {
  readonly id = LIGHTING_ELECTRICAL_SUBSYSTEM_ID
  readonly phase = 'systems'

  constructor(private readonly definition: LightingElectricalDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    for (const potentiometer of this.definition.potentiometers ?? []) {
      const key = LightingStateKeys.potentiometer(potentiometer.index)
      context.state.define({
        key,
        unit: 'ratio',
        valueType: 'number',
        description: `Lighting potentiometer ${potentiometer.index}`,
      })

      if (potentiometer.defaultRatio != null) {
        context.state.set(key, clampRatio(potentiometer.defaultRatio), {
          source: 'default',
          unit: 'ratio',
        })
      }
    }

    for (const channel of this.definition.powerChannels ?? []) {
      const key = LightingStateKeys.power(channel.channel)
      context.state.define({
        key,
        unit: 'ratio',
        valueType: 'number',
        description: `Light power channel ${channel.channel}`,
      })

      if (channel.defaultRatio != null) {
        context.state.set(key, clampRatio(channel.defaultRatio), {
          source: 'default',
          unit: 'ratio',
        })
      }
    }

    for (const channel of this.definition.lightChannels ?? []) {
      const key = LightingStateKeys.channelEnabled(channel.channel)
      context.state.define({
        key,
        unit: 'boolean',
        valueType: 'boolean',
        description: `Light channel ${channel.channel} enabled state`,
      })

      if (channel.defaultEnabled != null) {
        context.state.set(key, channel.defaultEnabled, {
          source: 'default',
          unit: 'boolean',
        })
      }
    }

    for (const bus of this.definition.electricalBuses ?? []) {
      const key = LightingStateKeys.electricalBusPowered(bus.id)
      context.state.define({
        key,
        unit: 'boolean',
        valueType: 'boolean',
        description: `Electrical bus ${bus.id} powered state`,
      })

      if (bus.defaultPowered != null) {
        context.state.set(key, bus.defaultPowered, {
          source: 'default',
          unit: 'boolean',
        })
      }
    }
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    switch (command.type) {
      case LightingCommandTypes.setPotentiometer:
        this.setPotentiometer(
          command.payload as SetLightPotentiometerPayload,
          context.state
        )
        return true
      case LightingCommandTypes.setPower:
        this.setPower(command.payload as SetLightPowerPayload, context.state)
        return true
      case LightingCommandTypes.setChannelEnabled:
        this.setChannelEnabled(
          command.payload as SetLightChannelEnabledPayload,
          context.state
        )
        return true
      case LightingCommandTypes.setElectricalBusPowered:
        this.setElectricalBusPowered(
          command.payload as SetElectricalBusPoweredPayload,
          context.state
        )
        return true
      default:
        return false
    }
  }

  private setPotentiometer(
    payload: SetLightPotentiometerPayload,
    state: SimStateStore
  ): void {
    const key = LightingStateKeys.potentiometer(payload.index)
    state.define({ key, unit: 'ratio', valueType: 'number' })
    state.set(key, clampRatio(payload.ratio), {
      source: 'runtime',
      unit: 'ratio',
      metadata: { kind: payload.kind },
    })
  }

  private setPower(payload: SetLightPowerPayload, state: SimStateStore): void {
    const key = LightingStateKeys.power(payload.channel)
    state.define({ key, unit: 'ratio', valueType: 'number' })
    state.set(key, clampRatio(payload.ratio), {
      source: 'runtime',
      unit: 'ratio',
    })
  }

  private setChannelEnabled(
    payload: SetLightChannelEnabledPayload,
    state: SimStateStore
  ): void {
    const unindexedKey = LightingStateKeys.channelEnabled(payload.channel)
    state.define({ key: unindexedKey, unit: 'boolean', valueType: 'boolean' })
    state.set(unindexedKey, payload.enabled, {
      source: 'runtime',
      unit: 'boolean',
    })

    if (payload.index != null && Number.isFinite(payload.index)) {
      const indexedKey = LightingStateKeys.channelEnabled(
        payload.channel,
        Math.trunc(payload.index)
      )
      state.define({ key: indexedKey, unit: 'boolean', valueType: 'boolean' })
      state.set(indexedKey, payload.enabled, {
        source: 'runtime',
        unit: 'boolean',
      })
    }
  }

  private setElectricalBusPowered(
    payload: SetElectricalBusPoweredPayload,
    state: SimStateStore
  ): void {
    const key = LightingStateKeys.electricalBusPowered(payload.id)
    state.define({ key, unit: 'boolean', valueType: 'boolean' })
    state.set(key, payload.powered, {
      source: 'runtime',
      unit: 'boolean',
    })
  }
}

export function readLightingRatio(
  state: SimStateStore,
  key: string
): number {
  return clampRatio(state.readNumber(key, { unit: 'ratio', fallback: 0 }) ?? 0)
}

export function readLightingEnabled(
  state: SimStateStore,
  key: string
): boolean {
  return state.readBoolean(key, { fallback: false }) ?? false
}

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(1, value))
}

function normalizePositiveIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`State index must be a non-negative integer: ${index}`)
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
