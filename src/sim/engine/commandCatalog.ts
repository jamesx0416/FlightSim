import { ControlCommandTypes } from './controls'
import { AvionicsCommandTypes } from './avionics'
import { AutopilotCommandTypes } from './autopilot'
import { ElectricalCommandTypes } from './electrical'
import { EnvironmentCommandTypes } from './environment'
import { FuelCommandTypes } from './fuel'
import { LightingCommandTypes } from './lightingElectrical'
import { PropulsionCommandTypes } from './propulsion'
import { SurfaceCommandTypes } from './surfaces'

export interface SimCommandCatalogEntry {
  readonly type: string
  readonly subsystem: string
  readonly description: string
  readonly payloadExample?: unknown
}

export const SIM_COMMAND_CATALOG: readonly SimCommandCatalogEntry[] = [
  {
    type: LightingCommandTypes.setPotentiometer,
    subsystem: 'lighting',
    description: 'Set a light potentiometer ratio.',
    payloadExample: { index: 1, ratio: 0.5, kind: 'panel' },
  },
  {
    type: LightingCommandTypes.setPower,
    subsystem: 'lighting',
    description: 'Set a light power channel ratio.',
    payloadExample: { channel: 'panel', ratio: 0.5 },
  },
  {
    type: LightingCommandTypes.setChannelEnabled,
    subsystem: 'lighting',
    description: 'Enable or disable a named light channel.',
    payloadExample: { channel: 'beacon', enabled: true },
  },
  {
    type: LightingCommandTypes.setElectricalBusPowered,
    subsystem: 'lighting',
    description: 'Set lighting electrical bus availability.',
    payloadExample: { id: 'main', powered: true },
  },
  {
    type: ElectricalCommandTypes.setBattery,
    subsystem: 'electrical',
    description: 'Set battery switch state.',
    payloadExample: { enabled: true },
  },
  {
    type: ElectricalCommandTypes.setExternalPowerAvailable,
    subsystem: 'electrical',
    description: 'Set external power availability.',
    payloadExample: { enabled: true },
  },
  {
    type: ElectricalCommandTypes.setExternalPowerConnected,
    subsystem: 'electrical',
    description: 'Set external power connected state.',
    payloadExample: { enabled: true },
  },
  {
    type: ElectricalCommandTypes.setAvionicsMaster,
    subsystem: 'electrical',
    description: 'Set avionics master state.',
    payloadExample: { enabled: true },
  },
  {
    type: ElectricalCommandTypes.setBusVoltage,
    subsystem: 'electrical',
    description: 'Set named electrical bus voltage.',
    payloadExample: { id: 'main', volts: 28 },
  },
  {
    type: EnvironmentCommandTypes.setPitotHeat,
    subsystem: 'environment',
    description: 'Set indexed pitot heat switch state.',
    payloadExample: { index: 1, enabled: true },
  },
  {
    type: AvionicsCommandTypes.setRadioActiveFrequency,
    subsystem: 'avionics',
    description: 'Set indexed COM/NAV active radio frequency in MHz.',
    payloadExample: { family: 'com', index: 1, mhz: 118 },
  },
  {
    type: AvionicsCommandTypes.setRadioStandbyFrequency,
    subsystem: 'avionics',
    description: 'Set indexed COM/NAV standby radio frequency in MHz.',
    payloadExample: { family: 'com', index: 1, mhz: 121.7 },
  },
  {
    type: AvionicsCommandTypes.swapRadioFrequencies,
    subsystem: 'avionics',
    description: 'Swap indexed COM/NAV active and standby frequencies.',
    payloadExample: { family: 'com', index: 1 },
  },
  {
    type: AvionicsCommandTypes.setAdfActiveFrequency,
    subsystem: 'avionics',
    description: 'Set indexed ADF active frequency in kHz.',
    payloadExample: { index: 1, khz: 300 },
  },
  {
    type: AvionicsCommandTypes.setAdfStandbyFrequency,
    subsystem: 'avionics',
    description: 'Set indexed ADF standby frequency in kHz.',
    payloadExample: { index: 1, khz: 350 },
  },
  {
    type: AvionicsCommandTypes.setBarometer,
    subsystem: 'avionics',
    description: 'Set indexed barometer pressure setting in inches of mercury.',
    payloadExample: { index: 1, settingHg: 29.92, standardMode: false },
  },
  {
    type: AvionicsCommandTypes.setTransponderState,
    subsystem: 'avionics',
    description: 'Set indexed transponder state.',
    payloadExample: { index: 1, state: 3 },
  },
  {
    type: AvionicsCommandTypes.setTransponderIdent,
    subsystem: 'avionics',
    description: 'Set indexed transponder ident state.',
    payloadExample: { index: 1, active: true },
  },
  {
    type: AutopilotCommandTypes.setMaster,
    subsystem: 'autopilot',
    description: 'Set autopilot master state.',
    payloadExample: { enabled: true },
  },
  {
    type: AutopilotCommandTypes.setDisengaged,
    subsystem: 'autopilot',
    description: 'Set autopilot disengaged annunciation state.',
    payloadExample: { enabled: false },
  },
  {
    type: AutopilotCommandTypes.setModeEnabled,
    subsystem: 'autopilot',
    description: 'Enable or disable an autopilot mode.',
    payloadExample: { mode: 'heading', enabled: true },
  },
  {
    type: AutopilotCommandTypes.setFlightDirectorActive,
    subsystem: 'autopilot',
    description: 'Set indexed flight director active state.',
    payloadExample: { index: 1, active: true },
  },
  {
    type: AutopilotCommandTypes.setSelectedHeading,
    subsystem: 'autopilot',
    description: 'Set selected autopilot heading in degrees.',
    payloadExample: { degrees: 270 },
  },
  {
    type: AutopilotCommandTypes.setSelectedAltitude,
    subsystem: 'autopilot',
    description: 'Set selected autopilot altitude in feet.',
    payloadExample: { feet: 5000 },
  },
  {
    type: AutopilotCommandTypes.setSelectedVerticalSpeed,
    subsystem: 'autopilot',
    description: 'Set selected autopilot vertical speed in feet per minute.',
    payloadExample: { feetPerMinute: 700 },
  },
  {
    type: AutopilotCommandTypes.setSelectedAirspeed,
    subsystem: 'autopilot',
    description: 'Set selected autopilot airspeed in knots.',
    payloadExample: { knots: 220 },
  },
  {
    type: AutopilotCommandTypes.setSelectedMach,
    subsystem: 'autopilot',
    description: 'Set selected autopilot Mach target.',
    payloadExample: { mach: 0.78 },
  },
  {
    type: AutopilotCommandTypes.setMaxBankId,
    subsystem: 'autopilot',
    description: 'Set selected autopilot max-bank identifier.',
    payloadExample: { id: 1 },
  },
  {
    type: ControlCommandTypes.setGearHandle,
    subsystem: 'controls',
    description: 'Set landing gear handle ratio.',
    payloadExample: { ratio: 1 },
  },
  {
    type: ControlCommandTypes.setGearPosition,
    subsystem: 'controls',
    description: 'Set landing gear position ratio.',
    payloadExample: { ratio: 1 },
  },
  {
    type: ControlCommandTypes.setFlapsHandle,
    subsystem: 'controls',
    description: 'Set flaps handle ratio.',
    payloadExample: { ratio: 0.5 },
  },
  {
    type: ControlCommandTypes.setFlapsPosition,
    subsystem: 'controls',
    description: 'Set flaps position ratio.',
    payloadExample: { ratio: 0.5 },
  },
  {
    type: ControlCommandTypes.setSpoilersHandle,
    subsystem: 'controls',
    description: 'Set spoilers handle ratio.',
    payloadExample: { ratio: 0.5 },
  },
  {
    type: ControlCommandTypes.setSpoilersPosition,
    subsystem: 'controls',
    description: 'Set spoilers position ratio.',
    payloadExample: { ratio: 0.5 },
  },
  {
    type: ControlCommandTypes.setAileronPosition,
    subsystem: 'controls',
    description: 'Set aileron position ratio.',
    payloadExample: { ratio: 0 },
  },
  {
    type: ControlCommandTypes.setElevatorPosition,
    subsystem: 'controls',
    description: 'Set elevator position ratio.',
    payloadExample: { ratio: 0 },
  },
  {
    type: ControlCommandTypes.setRudderPosition,
    subsystem: 'controls',
    description: 'Set rudder position ratio.',
    payloadExample: { ratio: 0 },
  },
  {
    type: ControlCommandTypes.setAileronTrim,
    subsystem: 'controls',
    description: 'Set aileron trim signed ratio.',
    payloadExample: { ratio: 0 },
  },
  {
    type: ControlCommandTypes.setElevatorTrim,
    subsystem: 'controls',
    description: 'Set elevator trim signed ratio.',
    payloadExample: { ratio: 0 },
  },
  {
    type: ControlCommandTypes.setRudderTrim,
    subsystem: 'controls',
    description: 'Set rudder trim signed ratio.',
    payloadExample: { ratio: 0 },
  },
  {
    type: ControlCommandTypes.setAileronTrimDisabled,
    subsystem: 'controls',
    description: 'Enable or disable aileron trim.',
    payloadExample: { enabled: false },
  },
  {
    type: ControlCommandTypes.setElevatorTrimDisabled,
    subsystem: 'controls',
    description: 'Enable or disable elevator trim.',
    payloadExample: { enabled: false },
  },
  {
    type: ControlCommandTypes.setRudderTrimDisabled,
    subsystem: 'controls',
    description: 'Enable or disable rudder trim.',
    payloadExample: { enabled: false },
  },
  {
    type: ControlCommandTypes.setParkingBrake,
    subsystem: 'controls',
    description: 'Set parking brake state.',
    payloadExample: { enabled: true },
  },
  {
    type: PropulsionCommandTypes.setApuMaster,
    subsystem: 'propulsion',
    description: 'Set APU master state.',
    payloadExample: { enabled: true },
  },
  {
    type: PropulsionCommandTypes.setApuStarter,
    subsystem: 'propulsion',
    description: 'Set APU starter state.',
    payloadExample: { enabled: true },
  },
  {
    type: PropulsionCommandTypes.setApuRunning,
    subsystem: 'propulsion',
    description: 'Set APU running state.',
    payloadExample: { enabled: true },
  },
  {
    type: PropulsionCommandTypes.setApuRpm,
    subsystem: 'propulsion',
    description: 'Set APU RPM percentage.',
    payloadExample: { percent: 100 },
  },
  {
    type: PropulsionCommandTypes.setEngineStarter,
    subsystem: 'propulsion',
    description: 'Set indexed engine starter state.',
    payloadExample: { index: 1, enabled: true },
  },
  {
    type: PropulsionCommandTypes.setEngineRunning,
    subsystem: 'propulsion',
    description: 'Set indexed engine running state.',
    payloadExample: { index: 1, enabled: true },
  },
  {
    type: PropulsionCommandTypes.setEngineN1,
    subsystem: 'propulsion',
    description: 'Set indexed engine N1 percentage.',
    payloadExample: { index: 1, value: 20 },
  },
  {
    type: PropulsionCommandTypes.setEngineRpm,
    subsystem: 'propulsion',
    description: 'Set indexed engine RPM.',
    payloadExample: { index: 1, value: 20 },
  },
  {
    type: PropulsionCommandTypes.setEngineThrottle,
    subsystem: 'propulsion',
    description: 'Set indexed engine throttle lever ratio.',
    payloadExample: { index: 1, value: 0.5 },
  },
  {
    type: PropulsionCommandTypes.setEnginePropellerLever,
    subsystem: 'propulsion',
    description: 'Set indexed engine propeller lever ratio.',
    payloadExample: { index: 1, value: 0.5 },
  },
  {
    type: PropulsionCommandTypes.setEngineMixtureLever,
    subsystem: 'propulsion',
    description: 'Set indexed engine mixture lever ratio.',
    payloadExample: { index: 1, value: 0.5 },
  },
  {
    type: PropulsionCommandTypes.setEngineFuelValve,
    subsystem: 'propulsion',
    description: 'Set indexed engine fuel valve state.',
    payloadExample: { index: 1, enabled: true },
  },
  {
    type: PropulsionCommandTypes.setEngineAlternator,
    subsystem: 'propulsion',
    description: 'Set indexed engine alternator state.',
    payloadExample: { index: 1, enabled: true },
  },
  {
    type: FuelCommandTypes.setPumpSwitch,
    subsystem: 'fuel',
    description: 'Set indexed fuel pump switch state.',
    payloadExample: { index: 1, enabled: true },
  },
  {
    type: FuelCommandTypes.setPumpActive,
    subsystem: 'fuel',
    description: 'Set indexed fuel pump active state.',
    payloadExample: { index: 1, enabled: true },
  },
  {
    type: FuelCommandTypes.setValveSwitch,
    subsystem: 'fuel',
    description: 'Set indexed fuel valve switch state.',
    payloadExample: { index: 1, open: true },
  },
  {
    type: FuelCommandTypes.setValveOpen,
    subsystem: 'fuel',
    description: 'Set indexed fuel valve open state.',
    payloadExample: { index: 1, open: true },
  },
  {
    type: FuelCommandTypes.setJunctionSetting,
    subsystem: 'fuel',
    description: 'Set indexed fuel junction setting.',
    payloadExample: { index: 1, setting: 2 },
  },
  {
    type: SurfaceCommandTypes.setTarget,
    subsystem: 'surfaces',
    description: 'Set a moving surface target ratio.',
    payloadExample: { id: 'flaps', ratio: 0.5 },
  },
  {
    type: SurfaceCommandTypes.setPosition,
    subsystem: 'surfaces',
    description: 'Set a moving surface position ratio.',
    payloadExample: { id: 'flaps', ratio: 0.5 },
  },
] as const

export function listCanonicalEngineCommands(
  filter = '',
  limit = 500
): readonly SimCommandCatalogEntry[] {
  const needle = filter.trim().toLowerCase()
  return SIM_COMMAND_CATALOG.filter(
    command =>
      !needle ||
      command.type.toLowerCase().includes(needle) ||
      command.subsystem.toLowerCase().includes(needle) ||
      command.description.toLowerCase().includes(needle)
  ).slice(0, limit)
}
