import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimSubsystem, SimSubsystemContext } from './subsystem'

export const CONTROLS_SUBSYSTEM_ID = 'controls'

export const ControlCommandTypes = {
  setGearHandle: 'controls.gear.setHandle',
  setGearPosition: 'controls.gear.setPosition',
  setFlapsHandle: 'controls.flaps.setHandle',
  setFlapsPosition: 'controls.flaps.setPosition',
  setSpoilersHandle: 'controls.spoilers.setHandle',
  setSpoilersPosition: 'controls.spoilers.setPosition',
  setAileronPosition: 'controls.aileron.setPosition',
  setElevatorPosition: 'controls.elevator.setPosition',
  setRudderPosition: 'controls.rudder.setPosition',
  setAileronTrim: 'controls.aileron.setTrim',
  setElevatorTrim: 'controls.elevator.setTrim',
  setRudderTrim: 'controls.rudder.setTrim',
  setAileronTrimDisabled: 'controls.aileron.setTrimDisabled',
  setElevatorTrimDisabled: 'controls.elevator.setTrimDisabled',
  setRudderTrimDisabled: 'controls.rudder.setTrimDisabled',
  setParkingBrake: 'controls.parkingBrake.set',
} as const

export interface ControlsDefinition {
  readonly defaultGearHandleRatio?: number
  readonly defaultGearPositionRatio?: number
  readonly defaultFlapsHandleRatio?: number
  readonly defaultFlapsPositionRatio?: number
  readonly defaultSpoilersHandleRatio?: number
  readonly defaultSpoilersPositionRatio?: number
  readonly defaultAileronPositionRatio?: number
  readonly defaultAileronTrimRatio?: number
  readonly defaultAileronTrimDisabled?: boolean
  readonly defaultElevatorPositionRatio?: number
  readonly defaultElevatorTrimRatio?: number
  readonly defaultElevatorTrimDisabled?: boolean
  readonly defaultRudderPositionRatio?: number
  readonly defaultRudderTrimRatio?: number
  readonly defaultRudderTrimDisabled?: boolean
  readonly defaultParkingBrakeEnabled?: boolean
}

export interface SetControlRatioPayload {
  readonly ratio: number
}

export interface SetParkingBrakePayload {
  readonly enabled: boolean
}

export interface SetControlBooleanPayload {
  readonly enabled: boolean
}

export const ControlStateKeys = {
  gearHandleRatio(): string {
    return 'controls.gear.handle.ratio'
  },
  gearPositionRatio(): string {
    return 'controls.gear.position.ratio'
  },
  flapsHandleRatio(): string {
    return 'controls.flaps.handle.ratio'
  },
  flapsPositionRatio(): string {
    return 'controls.flaps.position.ratio'
  },
  spoilersHandleRatio(): string {
    return 'controls.spoilers.handle.ratio'
  },
  spoilersPositionRatio(): string {
    return 'controls.spoilers.position.ratio'
  },
  aileronPositionRatio(): string {
    return 'controls.aileron.position.ratio'
  },
  aileronTrimRatio(): string {
    return 'controls.aileron.trim.ratio'
  },
  aileronTrimDisabled(): string {
    return 'controls.aileron.trim.disabled'
  },
  elevatorPositionRatio(): string {
    return 'controls.elevator.position.ratio'
  },
  elevatorTrimRatio(): string {
    return 'controls.elevator.trim.ratio'
  },
  elevatorTrimDisabled(): string {
    return 'controls.elevator.trim.disabled'
  },
  rudderPositionRatio(): string {
    return 'controls.rudder.position.ratio'
  },
  rudderTrimRatio(): string {
    return 'controls.rudder.trim.ratio'
  },
  rudderTrimDisabled(): string {
    return 'controls.rudder.trim.disabled'
  },
  parkingBrakeEnabled(): string {
    return 'controls.parking-brake.enabled'
  },
}

export class ControlsSubsystem implements SimSubsystem {
  readonly id = CONTROLS_SUBSYSTEM_ID
  readonly phase = 'systems'

  constructor(private readonly definition: ControlsDefinition = {}) {}

  initialize(context: SimSubsystemContext): void {
    defineRatioState(
      context.state,
      ControlStateKeys.gearHandleRatio(),
      'Landing gear handle ratio',
      this.definition.defaultGearHandleRatio
    )
    defineRatioState(
      context.state,
      ControlStateKeys.gearPositionRatio(),
      'Landing gear position ratio',
      this.definition.defaultGearPositionRatio
    )
    defineRatioState(
      context.state,
      ControlStateKeys.flapsHandleRatio(),
      'Flaps handle ratio',
      this.definition.defaultFlapsHandleRatio
    )
    defineRatioState(
      context.state,
      ControlStateKeys.flapsPositionRatio(),
      'Flaps position ratio',
      this.definition.defaultFlapsPositionRatio
    )
    defineRatioState(
      context.state,
      ControlStateKeys.spoilersHandleRatio(),
      'Spoilers handle ratio',
      this.definition.defaultSpoilersHandleRatio
    )
    defineRatioState(
      context.state,
      ControlStateKeys.spoilersPositionRatio(),
      'Spoilers position ratio',
      this.definition.defaultSpoilersPositionRatio
    )
    defineRatioState(
      context.state,
      ControlStateKeys.aileronPositionRatio(),
      'Aileron position ratio',
      this.definition.defaultAileronPositionRatio
    )
    defineSignedRatioState(
      context.state,
      ControlStateKeys.aileronTrimRatio(),
      'Aileron trim ratio',
      this.definition.defaultAileronTrimRatio
    )
    defineBooleanState(
      context.state,
      ControlStateKeys.aileronTrimDisabled(),
      'Aileron trim disabled state',
      this.definition.defaultAileronTrimDisabled
    )
    defineRatioState(
      context.state,
      ControlStateKeys.elevatorPositionRatio(),
      'Elevator position ratio',
      this.definition.defaultElevatorPositionRatio
    )
    defineSignedRatioState(
      context.state,
      ControlStateKeys.elevatorTrimRatio(),
      'Elevator trim ratio',
      this.definition.defaultElevatorTrimRatio
    )
    defineBooleanState(
      context.state,
      ControlStateKeys.elevatorTrimDisabled(),
      'Elevator trim disabled state',
      this.definition.defaultElevatorTrimDisabled
    )
    defineRatioState(
      context.state,
      ControlStateKeys.rudderPositionRatio(),
      'Rudder position ratio',
      this.definition.defaultRudderPositionRatio
    )
    defineSignedRatioState(
      context.state,
      ControlStateKeys.rudderTrimRatio(),
      'Rudder trim ratio',
      this.definition.defaultRudderTrimRatio
    )
    defineBooleanState(
      context.state,
      ControlStateKeys.rudderTrimDisabled(),
      'Rudder trim disabled state',
      this.definition.defaultRudderTrimDisabled
    )
    defineBooleanState(
      context.state,
      ControlStateKeys.parkingBrakeEnabled(),
      'Parking brake enabled state',
      this.definition.defaultParkingBrakeEnabled
    )
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    switch (command.type) {
      case ControlCommandTypes.setGearHandle:
        setRatio(context.state, ControlStateKeys.gearHandleRatio(), command.payload as SetControlRatioPayload)
        return true
      case ControlCommandTypes.setGearPosition:
        setRatio(context.state, ControlStateKeys.gearPositionRatio(), command.payload as SetControlRatioPayload)
        return true
      case ControlCommandTypes.setFlapsHandle:
        setRatio(context.state, ControlStateKeys.flapsHandleRatio(), command.payload as SetControlRatioPayload)
        return true
      case ControlCommandTypes.setFlapsPosition:
        setRatio(context.state, ControlStateKeys.flapsPositionRatio(), command.payload as SetControlRatioPayload)
        return true
      case ControlCommandTypes.setSpoilersHandle:
        setRatio(context.state, ControlStateKeys.spoilersHandleRatio(), command.payload as SetControlRatioPayload)
        return true
      case ControlCommandTypes.setSpoilersPosition:
        setRatio(context.state, ControlStateKeys.spoilersPositionRatio(), command.payload as SetControlRatioPayload)
        return true
      case ControlCommandTypes.setAileronPosition:
        setRatio(context.state, ControlStateKeys.aileronPositionRatio(), command.payload as SetControlRatioPayload)
        return true
      case ControlCommandTypes.setElevatorPosition:
        setRatio(context.state, ControlStateKeys.elevatorPositionRatio(), command.payload as SetControlRatioPayload)
        return true
    case ControlCommandTypes.setRudderPosition:
      setRatio(context.state, ControlStateKeys.rudderPositionRatio(), command.payload as SetControlRatioPayload)
      return true
    case ControlCommandTypes.setAileronTrim:
      setSignedRatio(context.state, ControlStateKeys.aileronTrimRatio(), command.payload as SetControlRatioPayload)
      return true
    case ControlCommandTypes.setElevatorTrim:
      setSignedRatio(context.state, ControlStateKeys.elevatorTrimRatio(), command.payload as SetControlRatioPayload)
      return true
    case ControlCommandTypes.setRudderTrim:
      setSignedRatio(context.state, ControlStateKeys.rudderTrimRatio(), command.payload as SetControlRatioPayload)
      return true
    case ControlCommandTypes.setAileronTrimDisabled:
      setBoolean(
        context.state,
        ControlStateKeys.aileronTrimDisabled(),
        command.payload as SetControlBooleanPayload
      )
      return true
    case ControlCommandTypes.setElevatorTrimDisabled:
      setBoolean(
        context.state,
        ControlStateKeys.elevatorTrimDisabled(),
        command.payload as SetControlBooleanPayload
      )
      return true
    case ControlCommandTypes.setRudderTrimDisabled:
      setBoolean(
        context.state,
        ControlStateKeys.rudderTrimDisabled(),
        command.payload as SetControlBooleanPayload
      )
      return true
    case ControlCommandTypes.setParkingBrake:
      setBoolean(context.state, ControlStateKeys.parkingBrakeEnabled(), command.payload as SetParkingBrakePayload)
      return true
      default:
        return false
    }
  }
}

export function readControlRatio(state: SimStateStore, key: string): number {
  return clampRatio(state.readNumber(key, { unit: 'ratio', fallback: 0 }) ?? 0)
}

export function readControlSignedRatio(state: SimStateStore, key: string): number {
  return clampSignedRatio(state.readNumber(key, { unit: 'ratio', fallback: 0 }) ?? 0)
}

export function readControlBoolean(
  state: SimStateStore,
  key: string,
  fallback = false
): boolean {
  return state.readBoolean(key, { fallback }) ?? fallback
}

function defineRatioState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number
): void {
  state.define({ key, unit: 'ratio', valueType: 'number', description })

  if (defaultValue != null) {
    state.set(key, clampRatio(defaultValue), { source: 'default', unit: 'ratio' })
  }
}

function defineSignedRatioState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: number
): void {
  state.define({
    key,
    unit: 'ratio',
    valueType: 'number',
    description,
  })
  if (defaultValue != null) {
    state.set(key, clampSignedRatio(defaultValue), { source: 'default', unit: 'ratio' })
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
    state.set(key, defaultValue, { source: 'default', unit: 'boolean' })
  }
}

function setRatio(state: SimStateStore, key: string, payload: SetControlRatioPayload): void {
  state.define({ key, unit: 'ratio', valueType: 'number' })
  state.set(key, clampRatio(payload.ratio), { source: 'runtime', unit: 'ratio' })
}

function setSignedRatio(state: SimStateStore, key: string, payload: SetControlRatioPayload): void {
  state.define({ key, unit: 'ratio', valueType: 'number' })
  state.set(key, clampSignedRatio(payload.ratio), { source: 'runtime', unit: 'ratio' })
}

function setBoolean(state: SimStateStore, key: string, payload: SetControlBooleanPayload): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean' })
  state.set(key, payload.enabled, { source: 'runtime', unit: 'boolean' })
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(1, value))
}

function clampSignedRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(-1, Math.min(1, value))
}
