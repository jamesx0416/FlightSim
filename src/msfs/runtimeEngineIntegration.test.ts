import { describe, expect, test } from 'bun:test'
import {
  AutopilotStateKeys,
  AvionicsStateKeys,
  ControlStateKeys,
  ElectricalCommandTypes,
  ElectricalStateKeys,
  EnvironmentStateKeys,
  FuelCommandTypes,
  FuelStateKeys,
  LightingStateKeys,
  PropulsionCommandTypes,
  PropulsionStateKeys,
  SurfaceCommandTypes,
  SurfaceStateKeys,
} from '../sim/engine'
import { SharedMsfsRuntimeHost } from './runtime'

test('mirrors barometer key events into canonical avionics state', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.invokeKeyEvent('KOHLSMAN_SET', [2, 30.12])

  expect(
    Math.abs(
      (host.simulatorEngine.state.readNumber(
        AvionicsStateKeys.barometerSettingHg(2)
      ) ?? 0) - 30.12
    ) < 1e-9
  ).toBe(true)
  expect(Math.abs(host.readVariable('A:KOHLSMAN SETTING HG:2') - 30.12) < 1e-9).toBe(true)
  expect(
    Math.abs(
      host.readVariable('A:KOHLSMAN SETTING MB:2') -
        30.12 * 33.863_886_666_7
    ) < 1e-9
  ).toBe(true)

  host.invokeKeyEvent('BAROMETRIC_STD_PRESSURE', [2])

  expect(
    Math.abs(
      (host.simulatorEngine.state.readNumber(
        AvionicsStateKeys.barometerSettingHg(2)
      ) ?? 0) - 29.92
    ) < 1e-9
  ).toBe(true)
  expect(
    host.simulatorEngine.state.readBoolean(
      AvionicsStateKeys.barometerStandardMode(2)
    )
  ).toBe(true)
})

test('mirrors ADF frequency key events into canonical avionics state', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.invokeKeyEvent('ADF_100_INC', [])
  host.invokeKeyEvent('ADF_10_INC', [])
  host.invokeKeyEvent('ADF_1_DEC', [])

  expect(
    host.simulatorEngine.state.readNumber(
      AvionicsStateKeys.adfStandbyFrequencyKhz(1)
    )
  ).toBe(409)
  expect(host.readVariable('A:ADF STANDBY FREQUENCY:1', 'KHz')).toBe(409)
})

test('mirrors pitot heat key events into canonical environment state', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.invokeKeyEvent('PITOT_HEAT_ON', [2])
  expect(
    host.simulatorEngine.state.readBoolean(
      EnvironmentStateKeys.pitotHeatEnabled(2)
    )
  ).toBe(true)
  expect(host.readVariable('A:PITOT HEAT SWITCH:2', 'Bool')).toBe(1)

  host.invokeKeyEvent('PITOT_HEAT_OFF', [2])
  expect(
    host.simulatorEngine.state.readBoolean(
      EnvironmentStateKeys.pitotHeatEnabled(2)
    )
  ).toBe(false)
  expect(host.readVariable('A:PITOT HEAT SWITCH:2', 'Bool')).toBe(0)
})

test('mirrors deice key events into canonical environment state', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.invokeKeyEvent('STRUCTURAL_DEICE_SET', [1])
  expect(
    host.simulatorEngine.state.readBoolean(
      EnvironmentStateKeys.structuralDeiceEnabled()
    )
  ).toBe(true)
  expect(host.readVariable('A:STRUCTURAL DEICE SWITCH', 'Bool')).toBe(1)

  host.invokeKeyEvent('ANTI_ICE_SET_ENG2', [1])
  expect(
    host.simulatorEngine.state.readBoolean(
      EnvironmentStateKeys.engineAntiIceEnabled(2)
    )
  ).toBe(true)
  expect(host.readVariable('A:ENG ANTI ICE:2', 'Bool')).toBe(1)
})

test('keeps missing local display brightness dark until explicitly written', () => {
  const host = new SharedMsfsRuntimeHost([])

  expect(host.readVariable('L:A32NX_MCDU_L_BRIGHTNESS')).toBe(0)
  expect(host.readVariable('L:A32NX_MCDU_R_BRIGHTNESS')).toBe(0)
  expect(host.readVariable('L:A32NX_MCDU_C_BRIGHTNESS')).toBe(0)

  host.writeVariable('L:A32NX_MCDU_L_BRIGHTNESS', 0.5)

  expect(host.readVariable('L:A32NX_MCDU_L_BRIGHTNESS')).toBe(0.5)
})

describe('SharedMsfsRuntimeHost engine integration', () => {
  test('routes mapped lighting writes through canonical engine state', () => {
    const host = new SharedMsfsRuntimeHost([])

    host.writeVariable('A:LIGHT POTENTIOMETER:4', 75, 'percent')

    expect(
      host.simulatorEngine.state.readNumber(
        LightingStateKeys.potentiometer(4),
        { unit: 'ratio' }
      )
    ).toBe(0.75)
    expect(host.readVariable('A:LIGHT POTENTIOMETER:4', 'percent over 100')).toBe(
      0.75
    )
  })

  test('mirrors seeded lighting aliases into canonical engine state', () => {
    const host = new SharedMsfsRuntimeHost([])

    expect(host.seedVariable('A:LIGHT POTENTIOMETER:7', 0.3)).toBe(true)
    expect(
      host.simulatorEngine.state.readNumber(
        LightingStateKeys.potentiometer(7),
        { unit: 'ratio' }
      )
    ).toBe(0.3)
  })

  test('keeps mapped but missing lighting power aliases dark', () => {
    const host = new SharedMsfsRuntimeHost([])

    expect(host.readVariable('A:LIGHT PANEL POWER SETTING', 'percent')).toBe(0)
  })

  test('routes light key events through canonical channel state', () => {
    const host = new SharedMsfsRuntimeHost([])

    host.invokeKeyEvent('BEACON_ON', [1])

    expect(
      host.simulatorEngine.state.readBoolean(
        LightingStateKeys.channelEnabled('beacon')
      )
    ).toBe(true)
    expect(host.readVariable('A:LIGHT BEACON', 'Bool')).toBe(1)
  })

test('preserves direct generic panel light fallback writes', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.writeVariable('A:LIGHT PANEL', 1)

  expect(host.readVariable('A:LIGHT PANEL', 'Bool')).toBe(1)
  expect(
    host.simulatorEngine.state.readBoolean(
      LightingStateKeys.channelEnabled('panel')
    )
  ).toBe(false)
})

  test('mirrors APU key events into canonical propulsion state', () => {
    const host = new SharedMsfsRuntimeHost([])

    host.invokeKeyEvent('APU_STARTER', [1])

    expect(
      host.simulatorEngine.state.readBoolean(PropulsionStateKeys.apuStarter())
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readBoolean(PropulsionStateKeys.apuRunning())
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readNumber(PropulsionStateKeys.apuRpmPercent())
    ).toBe(100)

    host.invokeKeyEvent('APU_OFF_SWITCH', [1])

    expect(
      host.simulatorEngine.state.readBoolean(PropulsionStateKeys.apuStarter())
    ).toBe(false)
    expect(
      host.simulatorEngine.state.readNumber(PropulsionStateKeys.apuRpmPercent())
    ).toBe(0)
  })

  test('routes mapped APU local variables through canonical propulsion state', () => {
    const host = new SharedMsfsRuntimeHost([])

    host.writeVariable('L:A32NX_OVHD_APU_MASTER_SW_PB_IS_ON', 1)
    host.writeVariable('L:A32NX_OVHD_APU_START_PB_IS_ON', 1)

    expect(
      host.simulatorEngine.state.readBoolean(PropulsionStateKeys.apuMaster())
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readBoolean(PropulsionStateKeys.apuStarter())
    ).toBe(true)
    expect(host.readVariable('L:A32NX_OVHD_APU_MASTER_SW_PB_IS_ON')).toBe(1)
    expect(host.readVariable('L:A32NX_OVHD_APU_START_PB_IS_ON')).toBe(1)
  })

  test('mirrors engine auto-start into indexed canonical propulsion state', () => {
    const host = new SharedMsfsRuntimeHost([])

    host.invokeKeyEvent('ENGINE_AUTO_START', [])

    expect(
      host.simulatorEngine.state.readBoolean(PropulsionStateKeys.engineRunning(1))
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readNumber(PropulsionStateKeys.engineRpm(1))
    ).toBe(20)
    expect(
      host.simulatorEngine.state.readNumber(PropulsionStateKeys.engineN1Percent(1))
    ).toBe(20)
    expect(
      host.simulatorEngine.state.readBoolean(PropulsionStateKeys.engineStarter(1))
    ).toBe(false)
    expect(
      host.simulatorEngine.state.readBoolean(PropulsionStateKeys.engineRunning(2))
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readNumber(PropulsionStateKeys.engineRpm(2))
    ).toBe(20)
    expect(
      host.simulatorEngine.state.readNumber(PropulsionStateKeys.engineN1Percent(2))
    ).toBe(20)
  expect(host.readVariable('A:TURB ENG N1:2', 'percent')).toBe(20)
})

test('mirrors generic throttle key events into canonical propulsion state', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.invokeKeyEvent('THROTTLE2_FULL', [])

  expect(
    host.simulatorEngine.state.readNumber(
      PropulsionStateKeys.engineThrottleLeverRatio(2),
      { unit: 'ratio' }
    )
  ).toBe(1)
  expect(
    host.readVariable('A:GENERAL ENG THROTTLE LEVER POSITION:2', 'percent')
  ).toBe(100)
})

test('publishes key-event control and electrical state without waiting for a tick', () => {
  const host = new SharedMsfsRuntimeHost([])

    host.invokeKeyEvent('MASTER_BATTERY_ON', [])
    host.invokeKeyEvent('EXTERNAL_POWER_ON', [])
    host.invokeKeyEvent('AVIONICS_MASTER_SET', [1])
    host.invokeKeyEvent('GEAR_DOWN', [])
    host.invokeKeyEvent('FLAPS_SET', [8192])
    host.invokeKeyEvent('SPOILERS_SET', [4096])
    host.invokeKeyEvent('PARKING_BRAKE_SET', [1])

    expect(
      host.simulatorEngine.state.readBoolean(ElectricalStateKeys.batteryEnabled())
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readBoolean(
        ElectricalStateKeys.externalPowerConnected()
      )
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readNumber(ElectricalStateKeys.busVoltage('main'))
    ).toBe(28)
    expect(
      host.simulatorEngine.state.readNumber(ControlStateKeys.gearHandleRatio(), {
        unit: 'ratio',
      })
    ).toBe(1)
    expect(
      host.simulatorEngine.state.readNumber(ControlStateKeys.flapsHandleRatio(), {
        unit: 'ratio',
      })
    ).toBe(8192 / 16_383)
    expect(
      host.simulatorEngine.state.readNumber(ControlStateKeys.spoilersHandleRatio(), {
        unit: 'ratio',
      })
    ).toBe(4096 / 16_383)
    expect(
      host.simulatorEngine.state.readBoolean(ControlStateKeys.parkingBrakeEnabled())
    ).toBe(true)
  })

  test('mirrors generic control key events into canonical controls state', () => {
    const host = new SharedMsfsRuntimeHost([])

    host.invokeKeyEvent('GEAR_DOWN', [])
    host.invokeKeyEvent('FLAPS_SET', [8192])
    host.invokeKeyEvent('SPOILERS_SET', [4096])
    host.invokeKeyEvent('PARKING_BRAKE_SET', [1])
    host.tick(1)

    expect(
      host.simulatorEngine.state.readNumber(ControlStateKeys.gearHandleRatio(), {
        unit: 'ratio',
      })
    ).toBe(1)
    expect(
      host.simulatorEngine.state.readNumber(ControlStateKeys.flapsHandleRatio(), {
        unit: 'ratio',
      })
    ).toBe(8192 / 16_383)
    expect(
      host.simulatorEngine.state.readNumber(ControlStateKeys.spoilersHandleRatio(), {
        unit: 'ratio',
      })
    ).toBe(4096 / 16_383)
    expect(
      host.simulatorEngine.state.readBoolean(ControlStateKeys.parkingBrakeEnabled())
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readNumber(SurfaceStateKeys.targetRatio('flaps'), {
        unit: 'ratio',
      })
    ).toBe(8192 / 16_383)
    expect(
      host.simulatorEngine.state.readNumber(SurfaceStateKeys.positionRatio('flaps'), {
        unit: 'ratio',
      })
    ).toBe(8192 / 16_383)
    expect(
      host.simulatorEngine.state.readNumber(SurfaceStateKeys.targetRatio('spoilers'), {
        unit: 'ratio',
      })
    ).toBe(4096 / 16_383)
  })

  test('mirrors generic trim key events into canonical controls state', () => {
    const host = new SharedMsfsRuntimeHost([])

    host.invokeKeyEvent('RUDDER_TRIM_SET_EX1', [8192])
    host.invokeKeyEvent('AILERON_TRIM_SET', [-4096])
    host.invokeKeyEvent('ELEV_TRIM_UP', [])
    host.invokeKeyEvent('AILERON_TRIM_DISABLED_SET', [1])

    expect(
      host.simulatorEngine.state.readNumber(ControlStateKeys.rudderTrimRatio(), {
        unit: 'ratio',
      })
    ).toBe(0.5)
    expect(
      host.simulatorEngine.state.readNumber(ControlStateKeys.aileronTrimRatio(), {
        unit: 'ratio',
      })
    ).toBe(-0.25)
    expect(
      host.simulatorEngine.state.readNumber(ControlStateKeys.elevatorTrimRatio(), {
        unit: 'ratio',
      })
    ).toBe(0.05)
    expect(
      host.simulatorEngine.state.readBoolean(ControlStateKeys.aileronTrimDisabled())
    ).toBe(true)
    expect(host.readVariable('A:RUDDER TRIM PCT', 'percent over 100')).toBe(0.5)
    expect(host.readVariable('A:AILERON TRIM', 'percent')).toBe(-25)
    expect(host.readVariable('A:ELEVATOR TRIM PCT', 'percent over 100')).toBe(0.05)
    expect(host.readVariable('A:AILERON TRIM DISABLED', 'Bool')).toBe(1)
  })

  test('mirrors generic electrical key events into canonical electrical state', () => {
    const host = new SharedMsfsRuntimeHost([])

    host.invokeKeyEvent('MASTER_BATTERY_ON', [])
    host.invokeKeyEvent('EXTERNAL_POWER_ON', [])
    host.invokeKeyEvent('AVIONICS_MASTER_SET', [1])
    host.tick(0)

    expect(
      host.simulatorEngine.state.readBoolean(ElectricalStateKeys.batteryEnabled())
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readBoolean(ElectricalStateKeys.externalPowerConnected())
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readBoolean(ElectricalStateKeys.avionicsMasterEnabled())
    ).toBe(true)
    expect(
      host.simulatorEngine.state.readNumber(ElectricalStateKeys.busVoltage('main'))
    ).toBe(28)
    expect(
      host.simulatorEngine.state.readNumber(
        ElectricalStateKeys.busVoltage('avionics')
      )
    ).toBe(28)
    expect(host.readVariable('A:ELECTRICAL MAIN BUS VOLTAGE')).toBe(28)
    expect(host.readVariable('A:ELECTRICAL AVIONICS BUS VOLTAGE')).toBe(28)
  })
})

test('mirrors generic fuel key events into canonical fuel state', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.invokeKeyEvent('FUELSYSTEM_PUMP_SET', [1, 2])
  host.invokeKeyEvent('FUELSYSTEM_VALVE_SET', [1, 3])
  host.invokeKeyEvent('FUELSYSTEM_JUNCTION_SET', [4, 5])

  expect(host.simulatorEngine.state.readBoolean(FuelStateKeys.pumpSwitchEnabled(2))).toBe(true)
  expect(host.simulatorEngine.state.readBoolean(FuelStateKeys.pumpActive(2))).toBe(true)
  expect(host.readVariable('A:FUELSYSTEM PUMP SWITCH:2', 'Bool')).toBe(1)
  expect(host.readVariable('A:FUELSYSTEM PUMP ACTIVE:2', 'Bool')).toBe(1)

  expect(host.simulatorEngine.state.readBoolean(FuelStateKeys.valveSwitchOpen(3))).toBe(true)
  expect(host.simulatorEngine.state.readBoolean(FuelStateKeys.valveOpen(3))).toBe(true)
  expect(host.readVariable('A:FUELSYSTEM VALVE SWITCH:3', 'Bool')).toBe(1)
  expect(host.readVariable('A:FUELSYSTEM VALVE OPEN:3', 'Bool')).toBe(1)

  expect(host.simulatorEngine.state.readNumber(FuelStateKeys.junctionSetting(5))).toBe(4)
  expect(host.readVariable('A:FUELSYSTEM JUNCTION SETTING:5')).toBe(4)
})

test('mirrors generic radio key events into canonical avionics state', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.writeVariable('A:COM ACTIVE FREQUENCY:1', 118, 'number')
  host.writeVariable('A:COM STANDBY FREQUENCY:1', 121, 'number')
  host.invokeKeyEvent('COM1_RADIO_FRACT_INC', [])
  host.invokeKeyEvent('COM1_RADIO_SWAP', [])
  host.invokeKeyEvent('COM3_RADIO_SET_HZ', [122_800_000])

  expect(
    host.simulatorEngine.state.readNumber(
      AvionicsStateKeys.radioActiveFrequencyMhz('com', 1)
    )
  ).toBe(121.025)
  expect(
    host.simulatorEngine.state.readNumber(
      AvionicsStateKeys.radioStandbyFrequencyMhz('com', 1)
    )
  ).toBe(118)
  expect(host.readVariable('A:COM ACTIVE FREQUENCY:1')).toBe(121.025)
  expect(host.readVariable('A:COM ACTIVE FREQUENCY:1 HZ')).toBe(121_025_000)

  expect(
    host.simulatorEngine.state.readNumber(
      AvionicsStateKeys.radioActiveFrequencyMhz('com', 3)
    )
  ).toBe(122.8)
  expect(host.readVariable('A:COM ACTIVE FREQUENCY:3')).toBe(122.8)
})

test('mirrors generic transponder key events into canonical avionics state', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.invokeKeyEvent('XPNDR_SET', [2, 3])
  host.invokeKeyEvent('XPNDR_IDENT_ON', [])

  expect(
    host.simulatorEngine.state.readNumber(AvionicsStateKeys.transponderState(2))
  ).toBe(3)
  expect(
    host.simulatorEngine.state.readBoolean(AvionicsStateKeys.transponderIdentActive(1))
  ).toBe(true)
  expect(host.readVariable('A:TRANSPONDER STATE:2')).toBe(3)
  expect(host.readVariable('A:TRANSPONDER IDENT:1', 'Bool')).toBe(1)
})

test('mirrors generic autopilot key events into canonical autopilot state', () => {
  const host = new SharedMsfsRuntimeHost([])

  host.invokeKeyEvent('AUTOPILOT_ON', [])
  host.invokeKeyEvent('AP_HDG_HOLD_ON', [])
  host.invokeKeyEvent('TOGGLE_FLIGHT_DIRECTOR', [2])
  host.invokeKeyEvent('HEADING_BUG_SET', [270])
  host.invokeKeyEvent('AP_ALT_VAR_SET_ENGLISH', [1, 5000])
  host.invokeKeyEvent('AP_VS_VAR_SET_ENGLISH', [1, -700])
  host.invokeKeyEvent('AP_SPD_VAR_SET', [1, 220])
  host.invokeKeyEvent('AP_MACH_VAR_SET', [1, 78])

  expect(host.simulatorEngine.state.readBoolean(AutopilotStateKeys.masterEnabled())).toBe(
    true
  )
  expect(host.simulatorEngine.state.readBoolean(AutopilotStateKeys.disengaged())).toBe(
    false
  )
  expect(
    host.simulatorEngine.state.readBoolean(AutopilotStateKeys.modeEnabled('heading'))
  ).toBe(true)
  expect(
    host.simulatorEngine.state.readBoolean(AutopilotStateKeys.flightDirectorActive(2))
  ).toBe(true)
  expect(
    host.simulatorEngine.state.readNumber(AutopilotStateKeys.selectedHeadingDegrees())
  ).toBe(270)
  expect(
    host.simulatorEngine.state.readNumber(AutopilotStateKeys.selectedAltitudeFeet())
  ).toBe(5000)
  expect(
    host.simulatorEngine.state.readNumber(
      AutopilotStateKeys.selectedVerticalSpeedFeetPerMinute()
    )
  ).toBe(-700)
  expect(
    host.simulatorEngine.state.readNumber(AutopilotStateKeys.selectedAirspeedKnots())
  ).toBe(220)
  expect(host.simulatorEngine.state.readNumber(AutopilotStateKeys.selectedMach())).toBe(
    0.78
  )
  expect(host.readVariable('A:AUTOPILOT MASTER', 'Bool')).toBe(1)
  expect(host.readVariable('A:AUTOPILOT HEADING LOCK DIR')).toBe(270)
  expect(host.readVariable('A:AUTOPILOT MACH HOLD VAR')).toBe(0.78)
})

test('publishes canonical propulsion commands through MSFS compatibility reads', () => {
  const host = new SharedMsfsRuntimeHost([])

  expect(host.readVariable('A:APU PCT RPM', 'percent')).toBe(0)

  host.simulatorEngine.commands.dispatch({
    type: PropulsionCommandTypes.setApuRpm,
    payload: { percent: 72 },
  })

  expect(
    host.simulatorEngine.state.readNumber(PropulsionStateKeys.apuRpmPercent())
  ).toBe(72)
  expect(host.readVariable('A:APU PCT RPM', 'percent')).toBe(72)
})

test('publishes canonical surface commands through MSFS compatibility reads', () => {
  const host = new SharedMsfsRuntimeHost([])

  expect(host.readVariable('A:TRAILING EDGE FLAPS LEFT PERCENT', 'percent')).toBe(
    0
  )
  expect(host.readVariable('A:SPOILERS LEFT POSITION', 'percent')).toBe(0)

  host.simulatorEngine.commands.dispatch({
    type: SurfaceCommandTypes.setPosition,
    payload: { id: 'flaps', ratio: 0.4 },
  })
  host.simulatorEngine.commands.dispatch({
    type: SurfaceCommandTypes.setPosition,
    payload: { id: 'spoilers', ratio: 0.25 },
  })

  expect(
    host.simulatorEngine.state.readNumber(SurfaceStateKeys.positionRatio('flaps'))
  ).toBe(0.4)
  expect(
    host.simulatorEngine.state.readNumber(
      SurfaceStateKeys.positionRatio('spoilers')
    )
  ).toBe(0.25)
  expect(host.readVariable('A:TRAILING EDGE FLAPS LEFT PERCENT', 'percent')).toBe(
    40
  )
  expect(host.readVariable('A:SPOILERS LEFT POSITION', 'percent')).toBe(25)
})

test('publishes direct canonical state writes through cached MSFS compatibility reads', () => {
  const host = new SharedMsfsRuntimeHost([])

  expect(host.readVariable('A:LIGHT POTENTIOMETER:8', 'percent')).toBe(0)
  expect(host.readVariable('A:TRAILING EDGE FLAPS LEFT PERCENT', 'percent')).toBe(
    0
  )

  host.simulatorEngine.state.set(LightingStateKeys.potentiometer(8), 0.55, {
    source: 'runtime',
    unit: 'ratio',
  })
  host.simulatorEngine.state.set(SurfaceStateKeys.positionRatio('flaps'), 0.33, {
    source: 'runtime',
    unit: 'ratio',
  })

  expect(
    Math.abs(host.readVariable('A:LIGHT POTENTIOMETER:8', 'percent') - 55) <
      1e-9
  ).toBe(true)
  expect(host.readVariable('A:TRAILING EDGE FLAPS LEFT PERCENT', 'percent')).toBe(
    33
  )
})

test('loads generic FLT state into canonical aircraft initial state', () => {
  const host = new SharedMsfsRuntimeHost([], {
    id: 'test-aircraft',
    title: 'Test Aircraft',
    sectionName: 'fltsim.0',
    sourcePath: '/aircraft.cfg',
    sourceUrl: '/aircraft.cfg',
    inheritedFromPaths: [],
    textureDirectories: [],
    isUserSelectable: true,
    isFlyable: true,
    model: null,
    interiorModel: null,
    cfgFiles: [],
    previewFlightState: {
      path: '/hangar.flt',
      url: '/hangar.flt',
      sourcePath: '/hangar.flt',
      sections: [
        {
          name: 'Systems.0',
          values: new Map([
            ['BatterySwitch', '1'],
            ['ExternalPowerSwitch', '1'],
            ['AvionicsSwitch', '1'],
            ['Potentiometer.4', '0.25'],
          ]),
        },
        {
          name: 'Switches.0',
          values: new Map([['Potentiometer.7', '0.4']]),
        },
            {
              name: 'Controls.0',
              values: new Map([
                ['gearshandle', '100'],
                ['flapshandle', '50'],
                ['spoilershandle', '25'],
              ]),
            },
            {
              name: 'Engine Parameters.1.0',
              values: new Map([
                ['pct engine rpm', '20'],
                ['throttleleverpct', '35'],
                ['generatorswitch', '1'],
              ]),
            },
          ],
        },
    soundDefinition: null,
  } as unknown as import('./types').ImportedAircraft)

  const initialState = host.simulatorEngine.getAircraft()?.initialState ?? []

  expect(
    initialState.some(
      seed =>
        seed.key === ElectricalStateKeys.batteryEnabled() &&
        seed.value === true &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === LightingStateKeys.potentiometer(4) &&
        seed.value === 0.25 &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === LightingStateKeys.potentiometer(7) &&
        seed.value === 0.4 &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === ControlStateKeys.gearHandleRatio() &&
        seed.value === 1 &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === ControlStateKeys.flapsHandleRatio() &&
        seed.value === 0.5 &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === SurfaceStateKeys.positionRatio('spoilers') &&
        seed.value === 0.25 &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === PropulsionStateKeys.engineRpm(1) &&
        seed.value === 20 &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === PropulsionStateKeys.engineN1Percent(1) &&
        seed.value === 20 &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === PropulsionStateKeys.engineRunning(1) &&
        seed.value === true &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === PropulsionStateKeys.engineThrottleLeverRatio(1) &&
        seed.value === 0.35 &&
        seed.source === 'loaded'
    )
  ).toBe(true)
  expect(
    initialState.some(
      seed =>
        seed.key === PropulsionStateKeys.engineAlternatorEnabled(1) &&
        seed.value === true &&
        seed.source === 'loaded'
    )
  ).toBe(true)
})

test('loads MSFS cfg files into generic canonical cold-start systems', () => {
  const host = new SharedMsfsRuntimeHost([], {
    id: 'cfg-aircraft',
    title: 'CFG Aircraft',
    sectionName: 'fltsim.0',
    sourcePath: '/aircraft.cfg',
    sourceUrl: '/aircraft.cfg',
    inheritedFromPaths: [],
    textureDirectories: [],
    baseContainer: null,
    isUserSelectable: true,
    isFlyable: true,
    model: null,
    interiorModel: null,
    soundDefinition: null,
    cfgFiles: [
      {
        kind: 'engines',
        path: '/engines.cfg',
        url: '/engines.cfg',
        sourceAircraftCfgPath: '/aircraft.cfg',
        sections: [
          {
            name: 'GENERALENGINEDATA',
            values: new Map([['number_of_engines', '2']]),
          },
          {
            name: 'TURBINEENGINEDATA',
            values: new Map([['idle_n1', '28']]),
          },
        ],
      },
      {
        kind: 'systems',
        path: '/systems.cfg',
        url: '/systems.cfg',
        sourceAircraftCfgPath: '/aircraft.cfg',
        sections: [
          {
            name: 'ELECTRICAL',
            values: new Map([['max_battery_voltage', '24']]),
          },
          {
            name: 'FUEL',
            values: new Map([
              ['leftmain_capacity', '100'],
              ['rightmain_capacity', '100'],
              ['leftmain_quantity', '50'],
              ['rightmain_quantity', '50'],
            ]),
          },
        ],
      },
    ],
    previewFlightState: null,
  } as unknown as import('./types').ImportedAircraft)

  const aircraft = host.simulatorEngine.getAircraft()
  if (aircraft == null) {
    throw new Error('Expected canonical aircraft definition')
  }

  expect(aircraft.systems?.some(system => system.kind === 'electrical')).toBe(true)
  expect(aircraft.systems?.some(system => system.kind === 'fuel')).toBe(true)
  expect(aircraft.systems?.some(system => system.kind === 'propulsion')).toBe(true)

  host.simulatorEngine.dispatch({
    type: ElectricalCommandTypes.setConsumerSwitch,
    payload: { id: 'fuel-pump-1', enabled: true },
  })
  host.simulatorEngine.dispatch({
    type: ElectricalCommandTypes.setConsumerSwitch,
    payload: { id: 'starter-1', enabled: true },
  })
  host.simulatorEngine.dispatch({
    type: ElectricalCommandTypes.setConsumerSwitch,
    payload: { id: 'ignition-1', enabled: true },
  })
  host.simulatorEngine.dispatch({
    type: FuelCommandTypes.setPumpSwitch,
    payload: { index: 1, enabled: true },
  })
  host.simulatorEngine.dispatch({
    type: FuelCommandTypes.setValveSwitch,
    payload: { index: 1, open: true },
  })
  host.simulatorEngine.dispatch({
    type: ElectricalCommandTypes.setBattery,
    payload: { enabled: true },
  })
  host.simulatorEngine.tick(1)

  expect(host.simulatorEngine.state.readBoolean(ElectricalStateKeys.busPowered('main'))).toBe(true)
  expect(host.simulatorEngine.state.readBoolean(FuelStateKeys.pumpActive('fuel-pump-1'))).toBe(true)
  expect(host.simulatorEngine.state.readBoolean(FuelStateKeys.engineAvailable(1))).toBe(true)

  host.simulatorEngine.dispatch({
    type: PropulsionCommandTypes.setEngineStarter,
    payload: { index: 1, enabled: true },
  })
  host.simulatorEngine.tick(1)
  host.simulatorEngine.tick(1)
  host.simulatorEngine.tick(1)

  expect(host.simulatorEngine.state.readBoolean(PropulsionStateKeys.engineCombustion(1))).toBe(true)
  expect(host.simulatorEngine.state.readNumber(PropulsionStateKeys.engineN1Percent(1))).toBe(28)
  expect(
    host.readVariable('A:GENERAL ENG GENERATOR AVAILABLE:1', 'Bool')
  ).toBe(1)
})

test('routes MSFS key events into canonical cold-start system commands', () => {
  const host = new SharedMsfsRuntimeHost([], {
    id: 'key-event-aircraft',
    title: 'Key Event Aircraft',
    sectionName: 'fltsim.0',
    sourcePath: '/aircraft.cfg',
    sourceUrl: '/aircraft.cfg',
    inheritedFromPaths: [],
    textureDirectories: [],
    baseContainer: null,
    isUserSelectable: true,
    isFlyable: true,
    model: null,
    interiorModel: null,
    soundDefinition: null,
    cfgFiles: [
      {
        kind: 'engines',
        path: '/engines.cfg',
        url: '/engines.cfg',
        sourceAircraftCfgPath: '/aircraft.cfg',
        sections: [
          {
            name: 'GENERALENGINEDATA',
            values: new Map([['number_of_engines', '1']]),
          },
          {
            name: 'TURBINEENGINEDATA',
            values: new Map([['idle_n1', '25']]),
          },
        ],
      },
      {
        kind: 'systems',
        path: '/systems.cfg',
        url: '/systems.cfg',
        sourceAircraftCfgPath: '/aircraft.cfg',
        sections: [
          {
            name: 'ELECTRICAL',
            values: new Map([['max_battery_voltage', '24']]),
          },
          {
            name: 'FUEL',
            values: new Map([
              ['center1_capacity', '100'],
              ['center1_quantity', '100'],
            ]),
          },
        ],
      },
    ],
    previewFlightState: null,
  } as unknown as import('./types').ImportedAircraft)

  host.invokeKeyEvent('MASTER_BATTERY_SET', [1])
  host.simulatorEngine.dispatch({
    type: ElectricalCommandTypes.setConsumerSwitch,
    payload: { id: 'fuel-pump-1', enabled: true },
  })
  host.simulatorEngine.dispatch({
    type: ElectricalCommandTypes.setConsumerSwitch,
    payload: { id: 'starter-1', enabled: true },
  })
  host.simulatorEngine.dispatch({
    type: ElectricalCommandTypes.setConsumerSwitch,
    payload: { id: 'ignition-1', enabled: true },
  })
  host.invokeKeyEvent('FUELSYSTEM_PUMP_ON', [1])
  host.invokeKeyEvent('FUELSYSTEM_VALVE_OPEN', [1])
  host.invokeKeyEvent('STARTER1_SET', [1])
  host.simulatorEngine.tick(1)
  host.simulatorEngine.tick(1)
  host.simulatorEngine.tick(1)

  expect(host.simulatorEngine.state.readBoolean(ElectricalStateKeys.batteryEnabled())).toBe(true)
  expect(host.simulatorEngine.state.readBoolean(FuelStateKeys.pumpSwitchEnabled(1))).toBe(true)
  expect(host.simulatorEngine.state.readBoolean(FuelStateKeys.valveSwitchOpen(1))).toBe(true)
  expect(host.simulatorEngine.state.readBoolean(PropulsionStateKeys.engineStarter(1))).toBe(true)
  expect(host.simulatorEngine.state.readBoolean(PropulsionStateKeys.engineCombustion(1))).toBe(true)

  host.invokeKeyEvent('ALTERNATOR_ON', [1])
  expect(host.simulatorEngine.state.readBoolean(PropulsionStateKeys.engineAlternatorEnabled(1))).toBe(true)
  expect(
    host.simulatorEngine.state.readBoolean(
      ElectricalStateKeys.sourceConnected('engine-1-generator')
    )
  ).toBe(true)
})

test('routes canonical electrical power into avionics and panel light visibility state', () => {
  const host = new SharedMsfsRuntimeHost([], {
    id: 'powered-consumers-aircraft',
    title: 'Powered Consumers Aircraft',
    sectionName: 'fltsim.0',
    sourcePath: '/aircraft.cfg',
    sourceUrl: '/aircraft.cfg',
    inheritedFromPaths: [],
    textureDirectories: [],
    baseContainer: null,
    isUserSelectable: true,
    isFlyable: true,
    model: null,
    interiorModel: null,
    soundDefinition: null,
    cfgFiles: [
      {
        kind: 'systems',
        path: '/systems.cfg',
        url: '/systems.cfg',
        sourceAircraftCfgPath: '/aircraft.cfg',
        sections: [
          {
            name: 'ELECTRICAL',
            values: new Map([['max_battery_voltage', '24']]),
          },
        ],
      },
    ],
    previewFlightState: null,
  } as unknown as import('./types').ImportedAircraft)

  host.writeVariable('A:ELECTRICAL MASTER BATTERY', 1, 'Bool')
  host.writeVariable('A:AVIONICS MASTER SWITCH', 1, 'Bool')
  host.tick(1)
  host.tick(1)

  expect(host.simulatorEngine.state.readBoolean(ElectricalStateKeys.busPowered('main'))).toBe(true)
  expect(
    host.simulatorEngine.state.readBoolean(
      ElectricalStateKeys.consumerPowered('avionics')
    )
  ).toBe(true)
  expect(
    host.simulatorEngine.state.readBoolean(
      ElectricalStateKeys.consumerPowered('lights')
    )
  ).toBe(true)
  expect(
    host.simulatorEngine.state.readBoolean(LightingStateKeys.channelEnabled('panel'))
  ).toBe(true)
  expect(host.simulatorEngine.state.readNumber(LightingStateKeys.power('panel'))).toBe(1)
  expect(host.readVariable('A:LIGHT PANEL', 'Bool')).toBe(1)
})
