import { describe, expect, test } from 'bun:test'
import {
  AutopilotStateKeys,
  AvionicsStateKeys,
  ControlStateKeys,
  ElectricalStateKeys,
  EnvironmentStateKeys,
  FuelStateKeys,
  LightingStateKeys,
  PropulsionStateKeys,
  SimStateStore,
  SurfaceStateKeys,
} from '../sim/engine'
import {
  mapMsfsLocalVarToCanonicalState,
  mapMsfsSimVarToCanonicalState,
  MsfsCompatibilityBridge,
  normalizeMsfsUnit,
} from './compatibilityBridge'

describe('MsfsCompatibilityBridge', () => {
  test('maps light potentiometer SimVars to canonical lighting state', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:LIGHT POTENTIOMETER:2', 25, 'percent')).toBe(
      true
    )
    expect(state.readNumber(LightingStateKeys.potentiometer(2))).toBe(0.25)
    expect(bridge.readSimVar('A:LIGHT POTENTIOMETER:2', 'percent over 100')).toBe(
      0.25
    )
    expect(bridge.readSimVar('A:LIGHT POTENTIOMETER:2', 'percent')).toBe(25)
  })

  test('uses canonical alias units when MSFS lighting units are omitted', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:LIGHT POTENTIOMETER:3', 0.4)).toBe(true)
    expect(bridge.readSimVar('A:LIGHT POTENTIOMETER:3')).toBe(0.4)
  })

test('keeps missing MSFS lighting aliases dark', () => {
  const bridge = new MsfsCompatibilityBridge(new SimStateStore())

  expect(bridge.readSimVar('A:LIGHT PANEL POWER SETTING', 'percent')).toBe(0)
})

test('maps MSFS package electrical bus LVars to canonical bus state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(bridge.readLocalVar('L:A32NX_ELEC_AC_1_BUS_IS_POWERED')).toBeUndefined()
  expect(
    bridge.writeLocalVar('L:A32NX_ELEC_AC_ESS_SHED_BUS_IS_POWERED', 1)
  ).toBe(true)
  expect(
    state.readBoolean(LightingStateKeys.electricalBusPowered('ac-ess-shed'))
  ).toBe(true)

  state.set(LightingStateKeys.electricalBusPowered('ac-1'), true, {
    source: 'runtime',
    unit: 'boolean',
  })
  expect(bridge.readLocalVar('L:A32NX_ELEC_AC_1_BUS_IS_POWERED')).toBe(1)
})

test('maps MSFS light switch channels to canonical enabled state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:LIGHT BEACON', 1, 'Bool')).toBe(true)
    expect(state.readBoolean(LightingStateKeys.channelEnabled('beacon'))).toBe(true)
    expect(bridge.readSimVar('A:LIGHT BEACON', 'Bool')).toBe(1)
  })

  test('maps indexed MSFS light power settings separately', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:LIGHT LANDING POWER SETTING:2', 40, 'percent')).toBe(true)
    expect(
      state.readNumber(LightingStateKeys.power('landing', 2), { unit: 'ratio' })
    ).toBe(0.4)
  })

  test('does not hijack generic panel power fallback as a light channel', () => {
    expect(mapMsfsSimVarToCanonicalState('A:LIGHT PANEL')).toBeUndefined()
  })

  test('maps MSFS APU SimVars to canonical propulsion state', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:APU STARTER', 1, 'Bool')).toBe(true)
    expect(state.readBoolean(PropulsionStateKeys.apuStarter())).toBe(true)

    expect(bridge.writeSimVar('A:APU PCT RPM', 65, 'percent')).toBe(true)
    expect(state.readNumber(PropulsionStateKeys.apuRpmPercent())).toBe(65)
    expect(bridge.readSimVar('A:APU PCT RPM', 'percent over 100')).toBe(0.65)
  })

  test('maps MSFS engine SimVars to indexed canonical propulsion state', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:GENERAL ENG STARTER:2', 1, 'Bool')).toBe(true)
    expect(state.readBoolean(PropulsionStateKeys.engineStarter(2))).toBe(true)

  expect(bridge.writeSimVar('A:TURB ENG N1:2', 72, 'percent')).toBe(true)
  expect(state.readNumber(PropulsionStateKeys.engineN1Percent(2))).toBe(72)
  expect(bridge.readSimVar('A:TURB ENG N1:2', 'percent')).toBe(72)

  expect(
    bridge.writeSimVar('A:GENERAL ENG THROTTLE LEVER POSITION:2', 35, 'percent')
  ).toBe(true)
  expect(
    state.readNumber(PropulsionStateKeys.engineThrottleLeverRatio(2), {
      unit: 'ratio',
    })
  ).toBe(0.35)
  expect(
    bridge.readSimVar('A:GENERAL ENG THROTTLE LEVER POSITION:2', 'percent')
  ).toBe(35)

  expect(
    bridge.writeSimVar('A:GENERAL ENG PROPELLER LEVER POSITION:2', 80, 'percent')
  ).toBe(true)
  expect(
    state.readNumber(PropulsionStateKeys.enginePropellerLeverRatio(2), {
      unit: 'ratio',
    })
  ).toBe(0.8)
  expect(
    bridge.readSimVar('A:GENERAL ENG PROPELLER LEVER POSITION:2', 'percent')
  ).toBe(80)

  expect(
    bridge.writeSimVar('A:GENERAL ENG MIXTURE LEVER POSITION:2', 60, 'percent')
  ).toBe(true)
  expect(
    state.readNumber(PropulsionStateKeys.engineMixtureLeverRatio(2), {
      unit: 'ratio',
    })
  ).toBe(0.6)
  expect(
    bridge.readSimVar('A:GENERAL ENG MIXTURE LEVER POSITION:2', 'percent')
  ).toBe(60)
})

test('maps MSFS package engine N1 local variables to canonical propulsion state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(mapMsfsLocalVarToCanonicalState('L:A32NX_ENGINE_N1:2')).toEqual({
    kind: 'propulsionNumber',
    stateKey: PropulsionStateKeys.engineN1Percent(2),
    canonicalUnit: 'percent',
  })

  expect(bridge.writeLocalVar('L:A32NX_ENGINE_N1:2', 42)).toBe(true)
  expect(state.readNumber(PropulsionStateKeys.engineN1Percent(2))).toBe(42)
  expect(bridge.readLocalVar('L:A32NX_ENGINE_N1:2')).toBe(42)
})

test('maps MSFS package spoiler handle local variable to canonical controls state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(mapMsfsLocalVarToCanonicalState('L:A32NX_SPOILERS_HANDLE_POSITION')).toEqual({
    kind: 'controlRatio',
    stateKey: ControlStateKeys.spoilersHandleRatio(),
    canonicalUnit: 'ratio',
  })

  expect(bridge.writeLocalVar('L:A32NX_SPOILERS_HANDLE_POSITION', 0.5)).toBe(true)
  expect(state.readNumber(ControlStateKeys.spoilersHandleRatio(), { unit: 'ratio' })).toBe(0.5)
  expect(bridge.readLocalVar('L:A32NX_SPOILERS_HANDLE_POSITION')).toBe(0.5)
})

test('maps MSFS control SimVars to canonical controls state', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:FLAPS HANDLE PERCENT', 50, 'percent')).toBe(true)
  expect(
    state.readNumber(ControlStateKeys.flapsHandleRatio(), { unit: 'ratio' })
  ).toBe(0.5)
  expect(bridge.readSimVar('A:FLAPS HANDLE PERCENT')).toBe(50)
  expect(bridge.readSimVar('A:FLAPS HANDLE PERCENT', 'Bool')).toBe(1)

    expect(bridge.writeSimVar('A:GEAR HANDLE POSITION', 1, 'ratio')).toBe(true)
    expect(
      state.readNumber(ControlStateKeys.gearHandleRatio(), { unit: 'ratio' })
    ).toBe(1)

  expect(bridge.writeSimVar('A:BRAKE PARKING POSITION', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(ControlStateKeys.parkingBrakeEnabled())).toBe(true)

  expect(bridge.writeSimVar('A:RUDDER TRIM PCT', -0.25, 'ratio')).toBe(true)
  expect(
    state.readNumber(ControlStateKeys.rudderTrimRatio(), { unit: 'ratio' })
  ).toBe(-0.25)
  expect(bridge.readSimVar('A:RUDDER TRIM', 'percent')).toBe(-25)

  expect(bridge.writeSimVar('A:ELEVATOR TRIM', 40, 'percent')).toBe(true)
  expect(
    state.readNumber(ControlStateKeys.elevatorTrimRatio(), { unit: 'ratio' })
  ).toBe(0.4)
  expect(bridge.readSimVar('A:ELEVATOR TRIM PCT', 'ratio')).toBe(0.4)

  expect(bridge.writeSimVar('A:AILERON TRIM DISABLED', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(ControlStateKeys.aileronTrimDisabled())).toBe(true)
})

  test('maps MSFS electrical SimVars to canonical electrical state', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:MASTER BATTERY SWITCH', 1, 'Bool')).toBe(true)
    expect(state.readBoolean(ElectricalStateKeys.batteryEnabled())).toBe(true)

    expect(bridge.writeSimVar('A:EXTERNAL POWER ON', 1, 'Bool')).toBe(true)
    expect(state.readBoolean(ElectricalStateKeys.externalPowerConnected())).toBe(true)

    expect(bridge.writeSimVar('A:ELECTRICAL MAIN BUS VOLTAGE', 28, 'number')).toBe(true)
    expect(state.readNumber(ElectricalStateKeys.busVoltage('main'))).toBe(28)
  expect(bridge.readSimVar('A:ELECTRICAL MAIN BUS VOLTAGE')).toBe(28)
})

test('maps MSFS fuel SimVars to canonical fuel state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(bridge.writeSimVar('A:FUELSYSTEM PUMP SWITCH:2', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(FuelStateKeys.pumpSwitchEnabled(2))).toBe(true)

  expect(bridge.writeSimVar('A:FUELSYSTEM PUMP ACTIVE:2', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(FuelStateKeys.pumpActive(2))).toBe(true)

  expect(bridge.writeSimVar('A:GENERAL ENG FUEL PUMP SWITCH EX1:3', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(FuelStateKeys.pumpSwitchEnabled(3))).toBe(true)

  expect(bridge.writeSimVar('A:FUELSYSTEM VALVE SWITCH:4', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(FuelStateKeys.valveSwitchOpen(4))).toBe(true)

  expect(bridge.writeSimVar('A:FUELSYSTEM VALVE OPEN:4', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(FuelStateKeys.valveOpen(4))).toBe(true)

  expect(bridge.writeSimVar('A:FUELSYSTEM JUNCTION SETTING:5', 3, 'number')).toBe(true)
  expect(state.readNumber(FuelStateKeys.junctionSetting(5))).toBe(3)
  expect(bridge.readSimVar('A:FUELSYSTEM JUNCTION SETTING:5')).toBe(3)
})

test('maps MSFS radio frequency SimVars to canonical avionics state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(bridge.writeSimVar('A:COM ACTIVE FREQUENCY:2', 118.5, 'number')).toBe(true)
  expect(
    state.readNumber(AvionicsStateKeys.radioActiveFrequencyMhz('com', 2))
  ).toBe(118.5)
  expect(bridge.readSimVar('A:COM ACTIVE FREQUENCY:2')).toBe(118.5)
  expect(bridge.readSimVar('A:COM ACTIVE FREQUENCY:2 HZ')).toBe(118_500_000)

  expect(bridge.writeSimVar('A:NAV STANDBY FREQUENCY:1 HZ', 109_900_000, 'number')).toBe(
    true
  )
  expect(
    state.readNumber(AvionicsStateKeys.radioStandbyFrequencyMhz('nav', 1))
  ).toBe(109.9)
  expect(bridge.readSimVar('A:NAV STANDBY FREQUENCY:1')).toBe(109.9)

  expect(bridge.writeSimVar('A:TRANSPONDER STATE:2', 3, 'number')).toBe(true)
  expect(state.readNumber(AvionicsStateKeys.transponderState(2))).toBe(3)
  expect(bridge.readSimVar('A:TRANSPONDER STATE:2')).toBe(3)

  expect(bridge.writeSimVar('A:TRANSPONDER IDENT:2', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(AvionicsStateKeys.transponderIdentActive(2))).toBe(true)
  expect(bridge.readSimVar('A:TRANSPONDER IDENT:2', 'Bool')).toBe(1)
})

test('maps MSFS autopilot SimVars to canonical autopilot state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(bridge.writeSimVar('A:AUTOPILOT MASTER', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(AutopilotStateKeys.masterEnabled())).toBe(true)

  expect(bridge.writeSimVar('A:AUTOPILOT HEADING LOCK', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(AutopilotStateKeys.modeEnabled('heading'))).toBe(true)

  expect(bridge.writeSimVar('A:AUTOPILOT FLIGHT DIRECTOR ACTIVE:2', 1, 'Bool')).toBe(
    true
  )
  expect(state.readBoolean(AutopilotStateKeys.flightDirectorActive(2))).toBe(true)

  expect(bridge.writeSimVar('A:AUTOPILOT HEADING LOCK DIR', 270, 'number')).toBe(true)
  expect(state.readNumber(AutopilotStateKeys.selectedHeadingDegrees())).toBe(270)
  expect(bridge.readSimVar('A:AUTOPILOT HEADING LOCK DIR')).toBe(270)

  expect(bridge.writeSimVar('A:AUTOPILOT ALTITUDE LOCK VAR', 5000, 'number')).toBe(
    true
  )
  expect(state.readNumber(AutopilotStateKeys.selectedAltitudeFeet())).toBe(5000)

  expect(bridge.writeSimVar('A:AUTOPILOT VERTICAL HOLD VAR', -700, 'number')).toBe(
    true
  )
  expect(
    state.readNumber(AutopilotStateKeys.selectedVerticalSpeedFeetPerMinute())
  ).toBe(-700)
})

test('maps MSFS animated surface position SimVars to canonical surface state', () => {
  const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:TRAILING EDGE FLAPS LEFT PERCENT', 40, 'percent')).toBe(true)
  expect(
    state.readNumber(SurfaceStateKeys.positionRatio('flaps'), { unit: 'ratio' })
  ).toBe(0.4)
  expect(bridge.readSimVar('A:TRAILING EDGE FLAPS LEFT PERCENT')).toBe(40)
  expect(bridge.readSimVar('A:TRAILING EDGE FLAPS LEFT PERCENT', 'Bool')).toBe(1)

  expect(bridge.writeSimVar('A:SPOILERS LEFT POSITION', 25, 'percent')).toBe(true)
  expect(
    state.readNumber(SurfaceStateKeys.positionRatio('spoilers'), { unit: 'ratio' })
  ).toBe(0.25)
  expect(bridge.readSimVar('A:SPOILERS LEFT POSITION', 'Bool')).toBe(1)
})

  test('leaves unknown MSFS variables unmapped', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.readSimVar('A:AIRSPEED INDICATED', 'knots')).toBeUndefined()
    expect(bridge.writeSimVar('A:AIRSPEED INDICATED', 120, 'knots')).toBe(false)
  })

  test('normalizes adapter-only MSFS unit names outside the engine', () => {
    expect(normalizeMsfsUnit('Percent Over 100')).toBe('ratio')
    expect(normalizeMsfsUnit('Bool')).toBe('boolean')
  })

  test('maps generic MSFS APU local variables to canonical propulsion state', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(
      bridge.writeLocalVar('L:A32NX_OVHD_APU_MASTER_SW_PB_IS_ON', 1)
    ).toBe(true)
    expect(state.readBoolean(PropulsionStateKeys.apuMaster())).toBe(true)
    expect(
      bridge.readLocalVar('L:A32NX_OVHD_APU_MASTER_SW_PB_IS_ON')
    ).toBe(1)

    expect(bridge.writeLocalVar('L:A32NX_OVHD_APU_START_PB_IS_ON', 1)).toBe(
      true
    )
    expect(state.readBoolean(PropulsionStateKeys.apuStarter())).toBe(true)
    expect(mapMsfsLocalVarToCanonicalState('L:A32NX_OVHD_APU_START_PB_IS_ON')).toEqual({
      kind: 'propulsionBoolean',
      stateKey: PropulsionStateKeys.apuStarter(),
      canonicalUnit: 'boolean',
    })

  expect(bridge.writeLocalVar('L:A32NX_UNKNOWN_SWITCH', 1)).toBe(false)
})

test('maps MSFS Kohlsman aliases to canonical barometer state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(bridge.writeSimVar('A:KOHLSMAN SETTING HG:2', 30.12, 'number')).toBe(
    true
  )
  expect(
    Math.abs((state.readNumber(AvionicsStateKeys.barometerSettingHg(2)) ?? 0) - 30.12) <
      1e-9
  ).toBe(true)
  expect(Math.abs((bridge.readSimVar('A:KOHLSMAN SETTING HG:2') ?? 0) - 30.12) < 1e-9).toBe(true)
  expect(
    Math.abs(
      (bridge.readSimVar('A:KOHLSMAN SETTING MB:2') ?? 0) -
        30.12 * 33.863_886_666_7
    ) < 1e-9
  ).toBe(true)

  expect(
    bridge.writeSimVar('A:KOHLSMAN SETTING MB:1', 1013.25, 'number')
  ).toBe(true)
  expect(
    Math.abs(
      (state.readNumber(AvionicsStateKeys.barometerSettingHg(1)) ?? 0) -
        1013.25 / 33.863_886_666_7
    ) < 1e-9
  ).toBe(true)
})

test('maps MSFS ADF frequency aliases to canonical avionics state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(bridge.writeSimVar('A:ADF ACTIVE FREQUENCY:1', 305, 'KHz')).toBe(true)
  expect(bridge.writeSimVar('A:ADF STANDBY FREQUENCY:2', 350, 'KHz')).toBe(true)

  expect(state.readNumber(AvionicsStateKeys.adfActiveFrequencyKhz(1))).toBe(305)
  expect(state.readNumber(AvionicsStateKeys.adfStandbyFrequencyKhz(2))).toBe(350)
  expect(bridge.readSimVar('A:ADF ACTIVE FREQUENCY:1', 'KHz')).toBe(305)
  expect(bridge.readSimVar('A:ADF STANDBY FREQUENCY:2', 'KHz')).toBe(350)
})

test('maps MSFS pitot heat aliases to canonical environment state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(bridge.writeSimVar('A:PITOT HEAT SWITCH:2', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(EnvironmentStateKeys.pitotHeatEnabled(2))).toBe(true)
  expect(bridge.readSimVar('A:PITOT HEAT SWITCH:2', 'Bool')).toBe(1)

  expect(bridge.writeSimVar('A:PITOT HEAT', 0, 'Bool')).toBe(true)
  expect(state.readBoolean(EnvironmentStateKeys.pitotHeatEnabled(1))).toBe(false)
  expect(bridge.readSimVar('A:PITOT HEAT', 'Bool')).toBe(0)
})

test('maps MSFS deice aliases to canonical environment state', () => {
  const state = new SimStateStore()
  const bridge = new MsfsCompatibilityBridge(state)

  expect(bridge.writeSimVar('A:STRUCTURAL DEICE SWITCH', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(EnvironmentStateKeys.structuralDeiceEnabled())).toBe(
    true
  )
  expect(bridge.readSimVar('A:STRUCTURAL DEICE SWITCH', 'Bool')).toBe(1)

  expect(bridge.writeSimVar('A:ENG ANTI ICE:2', 1, 'Bool')).toBe(true)
  expect(state.readBoolean(EnvironmentStateKeys.engineAntiIceEnabled(2))).toBe(
    true
  )
  expect(bridge.readSimVar('A:ENG ANTI ICE:2', 'Bool')).toBe(1)
})

  test('exposes explicit alias metadata for compatibility diagnostics', () => {
    expect(mapMsfsSimVarToCanonicalState('A:LIGHT PANEL POWER SETTING')).toEqual({
      kind: 'lightPower',
      stateKey: LightingStateKeys.power('PANEL'),
      canonicalUnit: 'ratio',
    })
  })

  test('maps generic MSFS electrical aliases to canonical sources buses and consumers', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(
      bridge.writeSimVar('A:ELECTRICAL SOURCE battery AVAILABLE', 1, 'Bool')
    ).toBe(true)
    expect(
      bridge.writeSimVar('A:ELECTRICAL SOURCE battery CONNECTED', 1, 'Bool')
    ).toBe(true)
    expect(
      bridge.writeSimVar('A:ELECTRICAL SOURCE battery VOLTAGE', 24, 'number')
    ).toBe(true)
    expect(
      bridge.writeSimVar('A:ELECTRICAL CONSUMER fuel-pump-1 SWITCH', 1, 'Bool')
    ).toBe(true)

    state.set(ElectricalStateKeys.busPowered('main'), true, {
      source: 'subsystem',
      unit: 'boolean',
    })
    state.set(ElectricalStateKeys.busVoltage('main'), 24, {
      source: 'subsystem',
      unit: 'number',
    })
    state.set(ElectricalStateKeys.consumerPowered('fuel-pump-1'), true, {
      source: 'subsystem',
      unit: 'boolean',
    })

    expect(state.readBoolean(ElectricalStateKeys.sourceAvailable('battery'))).toBe(true)
    expect(state.readBoolean(ElectricalStateKeys.sourceConnected('battery'))).toBe(true)
    expect(state.readNumber(ElectricalStateKeys.sourceVoltage('battery'))).toBe(24)
    expect(bridge.readSimVar('A:ELECTRICAL BUS main POWERED', 'Bool')).toBe(1)
    expect(bridge.readSimVar('A:ELECTRICAL BUS main VOLTAGE')).toBe(24)
    expect(bridge.readSimVar('A:ELECTRICAL CONSUMER fuel-pump-1 POWERED', 'Bool')).toBe(1)
  })

  test('maps generic MSFS fuel aliases to canonical fuel state', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    expect(bridge.writeSimVar('A:FUELSYSTEM TANK main QUANTITY PERCENT', 75, 'percent')).toBe(true)
    expect(bridge.writeSimVar('A:FUELSYSTEM PUMP pump-1 SWITCH', 1, 'Bool')).toBe(true)
    expect(bridge.writeSimVar('A:FUELSYSTEM VALVE engine-1-valve OPEN', 1, 'Bool')).toBe(true)

    state.set(FuelStateKeys.pumpActive('pump-1'), true, {
      source: 'subsystem',
      unit: 'boolean',
    })
    state.set(FuelStateKeys.engineAvailable(1), true, {
      source: 'subsystem',
      unit: 'boolean',
    })

    expect(state.readNumber(FuelStateKeys.tankQuantityRatio('main'))).toBe(0.75)
    expect(state.readBoolean(FuelStateKeys.pumpSwitchEnabled('pump-1'))).toBe(true)
    expect(state.readBoolean(FuelStateKeys.valveOpen('engine-1-valve'))).toBe(true)
    expect(bridge.readSimVar('A:FUELSYSTEM TANK main QUANTITY PERCENT', 'percent')).toBe(75)
    expect(bridge.readSimVar('A:FUELSYSTEM PUMP pump-1 ACTIVE', 'Bool')).toBe(1)
    expect(bridge.readSimVar('A:FUELSYSTEM ENGINE 1 FUEL AVAILABLE', 'Bool')).toBe(1)
  })

  test('maps generic MSFS propulsion generator availability aliases', () => {
    const state = new SimStateStore()
    const bridge = new MsfsCompatibilityBridge(state)

    state.set(PropulsionStateKeys.engineGeneratorAvailable(1), true, {
      source: 'subsystem',
      unit: 'boolean',
    })
    state.set(PropulsionStateKeys.apuGeneratorAvailable(), true, {
      source: 'subsystem',
      unit: 'boolean',
    })

    expect(bridge.readSimVar('A:GENERAL ENG GENERATOR AVAILABLE:1', 'Bool')).toBe(1)
    expect(bridge.readSimVar('A:APU GENERATOR AVAILABLE', 'Bool')).toBe(1)
  })
})
