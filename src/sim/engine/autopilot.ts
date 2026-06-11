import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimSubsystem, SimSubsystemContext } from './subsystem'

export const AUTOPILOT_SUBSYSTEM_ID = 'autopilot'

export const AutopilotCommandTypes = {
  setMaster: 'autopilot.master.set',
  setDisengaged: 'autopilot.disengaged.set',
  setModeEnabled: 'autopilot.mode.setEnabled',
  setFlightDirectorActive: 'autopilot.flightDirector.setActive',
  setSelectedHeading: 'autopilot.selectedHeading.set',
  setSelectedAltitude: 'autopilot.selectedAltitude.set',
  setSelectedVerticalSpeed: 'autopilot.selectedVerticalSpeed.set',
  setSelectedAirspeed: 'autopilot.selectedAirspeed.set',
  setSelectedMach: 'autopilot.selectedMach.set',
  setMaxBankId: 'autopilot.maxBank.setId',
} as const

export type AutopilotMode =
  | 'heading'
  | 'altitude'
  | 'vertical-speed'
  | 'airspeed'
  | 'mach'
  | 'approach'
  | 'glideslope'
  | 'nav'
  | 'flight-level-change'

export interface AutopilotSubsystemDefinition {
  readonly defaultMasterEnabled?: boolean
  readonly defaultDisengaged?: boolean
}

interface SetAutopilotBooleanPayload {
  readonly enabled?: boolean
  readonly active?: boolean
  readonly index?: number
  readonly mode?: AutopilotMode | string
}

interface SetAutopilotNumberPayload {
  readonly value?: number
  readonly degrees?: number
  readonly feet?: number
  readonly feetPerMinute?: number
  readonly knots?: number
  readonly mach?: number
  readonly id?: number
}

export const AutopilotStateKeys = {
  masterEnabled(): string {
    return 'autopilot.master.enabled'
  },
  disengaged(): string {
    return 'autopilot.disengaged'
  },
  modeEnabled(mode: AutopilotMode | string): string {
    return `autopilot.mode.${normalizeStateSegment(mode)}.enabled`
  },
  flightDirectorActive(index = 1): string {
    return `autopilot.flight-director.${normalizePositiveIndex(index)}.active`
  },
  selectedHeadingDegrees(): string {
    return 'autopilot.selected.heading.degrees'
  },
  selectedAltitudeFeet(): string {
    return 'autopilot.selected.altitude.feet'
  },
  selectedVerticalSpeedFeetPerMinute(): string {
    return 'autopilot.selected.vertical-speed.feet-per-minute'
  },
  selectedAirspeedKnots(): string {
    return 'autopilot.selected.airspeed.knots'
  },
  selectedMach(): string {
    return 'autopilot.selected.mach'
  },
  maxBankId(): string {
    return 'autopilot.max-bank.id'
  },
} as const

export class AutopilotSubsystem implements SimSubsystem {
  readonly id = AUTOPILOT_SUBSYSTEM_ID
  readonly phase = 'systems' as const

  constructor(private readonly definition: AutopilotSubsystemDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    defineBooleanState(
      context.state,
      AutopilotStateKeys.masterEnabled(),
      'Autopilot master state',
      this.definition.defaultMasterEnabled
    )
    defineBooleanState(
      context.state,
      AutopilotStateKeys.disengaged(),
      'Autopilot disengaged annunciation state',
      this.definition.defaultDisengaged
    )
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    switch (command.type) {
      case AutopilotCommandTypes.setMaster: {
        const payload = command.payload as SetAutopilotBooleanPayload
        setBoolean(context.state, AutopilotStateKeys.masterEnabled(), payload.enabled ?? false)
        return true
      }
      case AutopilotCommandTypes.setDisengaged: {
        const payload = command.payload as SetAutopilotBooleanPayload
        setBoolean(context.state, AutopilotStateKeys.disengaged(), payload.enabled ?? false)
        return true
      }
      case AutopilotCommandTypes.setModeEnabled: {
        const payload = command.payload as SetAutopilotBooleanPayload
        setBoolean(
          context.state,
          AutopilotStateKeys.modeEnabled(payload.mode ?? 'default'),
          payload.enabled ?? false
        )
        return true
      }
      case AutopilotCommandTypes.setFlightDirectorActive: {
        const payload = command.payload as SetAutopilotBooleanPayload
        setBoolean(
          context.state,
          AutopilotStateKeys.flightDirectorActive(payload.index ?? 1),
          payload.active ?? payload.enabled ?? false
        )
        return true
      }
      case AutopilotCommandTypes.setSelectedHeading: {
        const payload = command.payload as SetAutopilotNumberPayload
        setNumber(
          context.state,
          AutopilotStateKeys.selectedHeadingDegrees(),
          normalizeDegrees(payload.degrees ?? payload.value ?? 0)
        )
        return true
      }
      case AutopilotCommandTypes.setSelectedAltitude: {
        const payload = command.payload as SetAutopilotNumberPayload
        setNumber(
          context.state,
          AutopilotStateKeys.selectedAltitudeFeet(),
          Math.max(0, payload.feet ?? payload.value ?? 0)
        )
        return true
      }
      case AutopilotCommandTypes.setSelectedVerticalSpeed: {
        const payload = command.payload as SetAutopilotNumberPayload
        setNumber(
          context.state,
          AutopilotStateKeys.selectedVerticalSpeedFeetPerMinute(),
          payload.feetPerMinute ?? payload.value ?? 0
        )
        return true
      }
      case AutopilotCommandTypes.setSelectedAirspeed: {
        const payload = command.payload as SetAutopilotNumberPayload
        setNumber(
          context.state,
          AutopilotStateKeys.selectedAirspeedKnots(),
          Math.max(0, payload.knots ?? payload.value ?? 0)
        )
        return true
      }
      case AutopilotCommandTypes.setSelectedMach: {
        const payload = command.payload as SetAutopilotNumberPayload
        setNumber(
          context.state,
          AutopilotStateKeys.selectedMach(),
          Math.max(0, payload.mach ?? payload.value ?? 0)
        )
        return true
      }
      case AutopilotCommandTypes.setMaxBankId: {
        const payload = command.payload as SetAutopilotNumberPayload
        setNumber(context.state, AutopilotStateKeys.maxBankId(), Math.max(0, payload.id ?? payload.value ?? 0))
        return true
      }
      default:
        return false
    }
  }
}

export function readAutopilotBoolean(
  state: SimStateStore,
  key: string,
  fallback = false
): boolean {
  return state.readBoolean(key, { fallback }) ?? fallback
}

export function readAutopilotNumber(
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

function setBoolean(state: SimStateStore, key: string, enabled: boolean): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean' })
  state.set(key, enabled, { source: 'runtime', unit: 'boolean' })
}

function setNumber(state: SimStateStore, key: string, value: number): void {
  state.define({ key, unit: 'number', valueType: 'number' })
  state.set(key, Number.isFinite(value) ? value : 0, {
    source: 'runtime',
    unit: 'number',
  })
}

function normalizeDegrees(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return ((value % 360) + 360) % 360
}

function normalizePositiveIndex(index: number): number {
  if (!Number.isInteger(index) || index <= 0) {
    throw new RangeError(`Autopilot index must be a positive integer: ${index}`)
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
