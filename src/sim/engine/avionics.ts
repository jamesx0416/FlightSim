import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimSubsystem, SimSubsystemContext } from './subsystem'

export const AVIONICS_SUBSYSTEM_ID = 'avionics'

export const AvionicsCommandTypes = {
  setRadioActiveFrequency: 'avionics.radio.setActiveFrequency',
  setRadioStandbyFrequency: 'avionics.radio.setStandbyFrequency',
  swapRadioFrequencies: 'avionics.radio.swapFrequencies',
  setAdfActiveFrequency: 'avionics.adf.setActiveFrequency',
  setAdfStandbyFrequency: 'avionics.adf.setStandbyFrequency',
  setBarometer: 'avionics.barometer.set',
  setTransponderState: 'avionics.transponder.setState',
  setTransponderIdent: 'avionics.transponder.setIdent',
} as const

export type RadioFamily = 'com' | 'nav'
export type RadioSlot = 'active' | 'standby'

export interface RadioDefinition {
  readonly family: RadioFamily
  readonly index: number
  readonly defaultActiveFrequencyMhz?: number
  readonly defaultStandbyFrequencyMhz?: number
}

export interface AvionicsSubsystemDefinition {
  readonly radios?: readonly RadioDefinition[]
  readonly adfs?: readonly AdfDefinition[]
  readonly transponders?: readonly TransponderDefinition[]
  readonly barometers?: readonly BarometerDefinition[]
}

export interface AdfDefinition {
  readonly index: number
  readonly defaultActiveFrequencyKhz?: number
  readonly defaultStandbyFrequencyKhz?: number
}

export interface TransponderDefinition {
  readonly index: number
  readonly defaultState?: number
  readonly defaultIdentActive?: boolean
}

export interface BarometerDefinition {
  readonly index: number
  readonly defaultSettingHg?: number
  readonly defaultStandardMode?: boolean
}

interface SetRadioFrequencyPayload {
  readonly family: RadioFamily | string
  readonly index: number
  readonly mhz: number
}

interface SwapRadioFrequencyPayload {
  readonly family: RadioFamily | string
  readonly index: number
}

interface SetAdfFrequencyPayload {
  readonly index?: number
  readonly khz?: number
  readonly value?: number
}

interface SetTransponderStatePayload {
  readonly index?: number
  readonly state?: number
  readonly value?: number
}

interface SetTransponderIdentPayload {
  readonly index?: number
  readonly active?: boolean
  readonly enabled?: boolean
}

interface SetBarometerPayload {
  readonly index?: number
  readonly settingHg?: number
  readonly value?: number
  readonly standardMode?: boolean
}

export const AvionicsStateKeys = {
  radioActiveFrequencyMhz(family: RadioFamily | string, index: number): string {
    return `avionics.radio.${normalizeRadioFamily(family)}.${normalizePositiveIndex(index)}.active.frequency.mhz`
  },
  radioStandbyFrequencyMhz(family: RadioFamily | string, index: number): string {
    return `avionics.radio.${normalizeRadioFamily(family)}.${normalizePositiveIndex(index)}.standby.frequency.mhz`
  },
  adfActiveFrequencyKhz(index = 1): string {
    return `avionics.adf.${normalizePositiveIndex(index)}.active.frequency.khz`
  },
  adfStandbyFrequencyKhz(index = 1): string {
    return `avionics.adf.${normalizePositiveIndex(index)}.standby.frequency.khz`
  },
  barometerSettingHg(index = 1): string {
    return `avionics.barometer.${normalizePositiveIndex(index)}.setting.hg`
  },
  barometerStandardMode(index = 1): string {
    return `avionics.barometer.${normalizePositiveIndex(index)}.standardMode`
  },
  transponderState(index = 1): string {
    return `avionics.transponder.${normalizePositiveIndex(index)}.state`
  },
  transponderIdentActive(index = 1): string {
    return `avionics.transponder.${normalizePositiveIndex(index)}.ident.active`
  },
} as const

export class AvionicsSubsystem implements SimSubsystem {
  readonly id = AVIONICS_SUBSYSTEM_ID
  readonly phase = 'systems' as const

  constructor(private readonly definition: AvionicsSubsystemDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    for (const radio of this.definition.radios ?? []) {
      defineFrequencyState(
        context.state,
        AvionicsStateKeys.radioActiveFrequencyMhz(radio.family, radio.index),
        `${radio.family.toUpperCase()} ${radio.index} active frequency`,
        radio.defaultActiveFrequencyMhz
      )
      defineFrequencyState(
        context.state,
        AvionicsStateKeys.radioStandbyFrequencyMhz(radio.family, radio.index),
        `${radio.family.toUpperCase()} ${radio.index} standby frequency`,
        radio.defaultStandbyFrequencyMhz
      )
    }

    for (const adf of this.definition.adfs ?? []) {
      defineNumberState(
        context.state,
        AvionicsStateKeys.adfActiveFrequencyKhz(adf.index),
        `ADF ${adf.index} active frequency`,
        adf.defaultActiveFrequencyKhz
      )
      defineNumberState(
        context.state,
        AvionicsStateKeys.adfStandbyFrequencyKhz(adf.index),
        `ADF ${adf.index} standby frequency`,
        adf.defaultStandbyFrequencyKhz
      )
    }

    for (const transponder of this.definition.transponders ?? []) {
      defineNumberState(
        context.state,
        AvionicsStateKeys.transponderState(transponder.index),
        `Transponder ${transponder.index} state`,
        transponder.defaultState
      )
      defineBooleanState(
        context.state,
        AvionicsStateKeys.transponderIdentActive(transponder.index),
        `Transponder ${transponder.index} ident state`,
        transponder.defaultIdentActive
      )
    }

    for (const barometer of this.definition.barometers ?? []) {
      defineNumberState(
        context.state,
        AvionicsStateKeys.barometerSettingHg(barometer.index),
        `Barometer ${barometer.index} setting`,
        barometer.defaultSettingHg
      )
      defineBooleanState(
        context.state,
        AvionicsStateKeys.barometerStandardMode(barometer.index),
        `Barometer ${barometer.index} standard mode`,
        barometer.defaultStandardMode
      )
    }
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    switch (command.type) {
      case AvionicsCommandTypes.setRadioActiveFrequency: {
        const payload = command.payload as SetRadioFrequencyPayload
        setFrequency(
          context.state,
          AvionicsStateKeys.radioActiveFrequencyMhz(payload.family, payload.index),
          payload.mhz
        )
        return true
      }
      case AvionicsCommandTypes.setRadioStandbyFrequency: {
        const payload = command.payload as SetRadioFrequencyPayload
        setFrequency(
          context.state,
          AvionicsStateKeys.radioStandbyFrequencyMhz(payload.family, payload.index),
          payload.mhz
        )
        return true
      }
      case AvionicsCommandTypes.swapRadioFrequencies: {
        const payload = command.payload as SwapRadioFrequencyPayload
        const activeKey = AvionicsStateKeys.radioActiveFrequencyMhz(
          payload.family,
          payload.index
        )
        const standbyKey = AvionicsStateKeys.radioStandbyFrequencyMhz(
          payload.family,
          payload.index
        )
        const active = readAvionicsNumber(context.state, activeKey)
        const standby = readAvionicsNumber(context.state, standbyKey)
        setFrequency(context.state, activeKey, standby)
        setFrequency(context.state, standbyKey, active)
        return true
      }
      case AvionicsCommandTypes.setAdfActiveFrequency: {
        const payload = command.payload as SetAdfFrequencyPayload
        setNumber(
          context.state,
          AvionicsStateKeys.adfActiveFrequencyKhz(payload.index ?? 1),
          normalizeInteger(payload.khz ?? payload.value ?? 0)
        )
        return true
      }
      case AvionicsCommandTypes.setAdfStandbyFrequency: {
        const payload = command.payload as SetAdfFrequencyPayload
        setNumber(
          context.state,
          AvionicsStateKeys.adfStandbyFrequencyKhz(payload.index ?? 1),
          normalizeInteger(payload.khz ?? payload.value ?? 0)
        )
        return true
      }
      case AvionicsCommandTypes.setBarometer: {
        const payload = command.payload as SetBarometerPayload
        const index = payload.index ?? 1
        if (payload.settingHg != null || payload.value != null) {
          setNumber(
            context.state,
            AvionicsStateKeys.barometerSettingHg(index),
            payload.settingHg ?? payload.value ?? 29.92
          )
        }
        if (payload.standardMode != null) {
          setBoolean(
            context.state,
            AvionicsStateKeys.barometerStandardMode(index),
            payload.standardMode
          )
        }
        return true
      }
      case AvionicsCommandTypes.setTransponderState: {
        const payload = command.payload as SetTransponderStatePayload
        setNumber(
          context.state,
          AvionicsStateKeys.transponderState(payload.index ?? 1),
          normalizeInteger(payload.state ?? payload.value ?? 0)
        )
        return true
      }
      case AvionicsCommandTypes.setTransponderIdent: {
        const payload = command.payload as SetTransponderIdentPayload
        setBoolean(
          context.state,
          AvionicsStateKeys.transponderIdentActive(payload.index ?? 1),
          payload.active ?? payload.enabled ?? false
        )
        return true
      }
      default:
        return false
    }
  }
}

export function readAvionicsNumber(
  state: SimStateStore,
  key: string,
  fallback = 0
): number {
  return state.readNumber(key, { fallback }) ?? fallback
}

function defineFrequencyState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number
): void {
  state.define({ key, unit: 'number', valueType: 'number', description })
  if (defaultValue != null) {
    setFrequency(state, key, defaultValue, 'default')
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
    setNumber(state, key, defaultValue, 'default')
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
    setBoolean(state, key, defaultValue, 'default')
  }
}

function setFrequency(
  state: SimStateStore,
  key: string,
  value: number,
  source: 'default' | 'runtime' = 'runtime'
): void {
  state.set(key, normalizeFrequencyMhz(value), { source, unit: 'number' })
}

function setNumber(
  state: SimStateStore,
  key: string,
  value: number,
  source: 'default' | 'runtime' = 'runtime'
): void {
  state.set(key, Number.isFinite(value) ? value : 0, { source, unit: 'number' })
}

function setBoolean(
  state: SimStateStore,
  key: string,
  value: boolean,
  source: 'default' | 'runtime' = 'runtime'
): void {
  state.set(key, value, { source, unit: 'boolean' })
}

function normalizeInteger(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.trunc(value))
}

function normalizeFrequencyMhz(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.round(Math.max(0, value) * 1000) / 1000
}

function normalizePositiveIndex(index: number): number {
  if (!Number.isInteger(index) || index <= 0) {
    throw new RangeError(`Radio index must be a positive integer: ${index}`)
  }

  return index
}

function normalizeRadioFamily(family: RadioFamily | string): RadioFamily {
  const normalized = family.trim().toLowerCase()
  if (normalized === 'com' || normalized === 'nav') {
    return normalized
  }

  throw new RangeError(`Unsupported radio family: ${family}`)
}
