import { describe, expect, test } from 'bun:test'
import {
  AutopilotCommandTypes,
  AutopilotStateKeys,
  AutopilotSubsystem,
  AvionicsCommandTypes,
  AvionicsStateKeys,
  AvionicsSubsystem,
  ControlCommandTypes,
  ControlStateKeys,
  ControlsSubsystem,
  ElectricalCommandTypes,
  ElectricalStateKeys,
  ElectricalSubsystem,
  EnvironmentCommandTypes,
  EnvironmentStateKeys,
  EnvironmentSubsystem,
  FuelCommandTypes,
  FuelStateKeys,
  FuelSubsystem,
  LightingCommandTypes,
  LightingElectricalSubsystem,
  LightingStateKeys,
  PropulsionCommandTypes,
  PropulsionStateKeys,
  PropulsionSubsystem,
  SurfaceAnimationSubsystem,
  SurfaceCommandTypes,
  SurfaceStateKeys,
  createSimulatorEngineForAircraft,
  listCanonicalEngineCommands,
  readAutopilotBoolean,
  readAutopilotNumber,
  readControlBoolean,
  readControlRatio,
  readControlSignedRatio,
  readAvionicsNumber,
  readElectricalBoolean,
  readElectricalNumber,
  readFuelBoolean,
  readFuelNumber,
  readLightingEnabled,
  readLightingRatio,
  readPropulsionBoolean,
  readPropulsionNumber,
  readSurfaceBoolean,
  readSurfaceRatio,
  SimCommandBus,
  SimStateStore,
  SimulatorEngine,
} from './index'

describe('command catalog', () => {
  test('lists generic engine command types with payload examples', () => {
    const apuCommands = listCanonicalEngineCommands('apu')

    expect(apuCommands.some(command => command.type === PropulsionCommandTypes.setApuStarter)).toBe(true)
    expect(
      listCanonicalEngineCommands('surfaces').some(
        command => command.type === SurfaceCommandTypes.setTarget
      )
    ).toBe(true)
  })
})

test('reports command dispatch metadata separately from observers', () => {
  const commands = new SimCommandBus()
  const observed: string[] = []

  commands.subscribe('known.command', (command) => {
    observed.push(`direct:${command.type}`)
    return true
  })
  commands.subscribe('*', (command) => {
    observed.push(`observer:${command.type}`)
  })

  expect(commands.dispatch({ type: 'known.command' })).toEqual({
    handled: true,
    handledCount: 1,
    calledCount: 2,
    directHandledCount: 1,
    wildcardHandledCount: 0,
  })
  expect(commands.dispatch({ type: 'unknown.command' })).toEqual({
    handled: false,
    handledCount: 0,
    calledCount: 1,
    directHandledCount: 0,
    wildcardHandledCount: 0,
  })
  expect(observed).toEqual([
    'direct:known.command',
    'observer:known.command',
    'observer:unknown.command',
  ])
})

describe('SimStateStore', () => {
  test('uses explicit source precedence for canonical state', () => {
    const state = new SimStateStore()
    const key = LightingStateKeys.potentiometer(1)

    state.define({
      key,
      unit: 'ratio',
      valueType: 'number',
      defaultValue: 0,
    })
    state.set(key, 50, { source: 'subsystem', unit: 'percent' })
    state.set(key, 0.75, { source: 'loaded', unit: 'ratio' })
    state.set(key, 0.1, { source: 'subsystem', unit: 'ratio' })

    expect(state.readNumber(key, { unit: 'ratio' })).toBe(0.75)

    state.set(key, 25, { source: 'runtime', unit: 'percent' })

    expect(state.readNumber(key, { unit: 'ratio' })).toBe(0.25)
    expect(state.readNumber(key, { unit: 'percent' })).toBe(25)
  })

  test('does not force missing lighting values bright', () => {
    const state = new SimStateStore()

    expect(readLightingRatio(state, LightingStateKeys.potentiometer(2))).toBe(0)
  })
})

describe('SimulatorEngine', () => {
  test('dispatches domain commands through registered subsystems', () => {
    const engine = new SimulatorEngine()
    engine.registerSubsystem(
      new LightingElectricalSubsystem({
        potentiometers: [{ index: 1, kind: 'panel' }],
      })
    )

    engine.dispatch({
      type: LightingCommandTypes.setPotentiometer,
      payload: { index: 1, ratio: 0.8, kind: 'panel' },
    })

    expect(
      engine.state.readNumber(LightingStateKeys.potentiometer(1), {
        unit: 'percent',
      })
    ).toBe(80)
  })

  test('loads canonical aircraft initial state as loaded state', () => {
    const key = LightingStateKeys.power('panel')
    const engine = new SimulatorEngine({
      identity: { id: 'fixture-aircraft', displayName: 'Fixture Aircraft' },
      initialState: [
        {
          key,
          value: 0.35,
          unit: 'ratio',
          valueType: 'number',
        },
      ],
    })

    engine.state.set(key, 0.1, { source: 'subsystem', unit: 'ratio' })

    expect(engine.state.readNumber(key, { unit: 'percent' })).toBe(35)
  })

  test('dispatches generic light channel enabled commands', () => {
    const engine = new SimulatorEngine()
    engine.registerSubsystem(new LightingElectricalSubsystem())

    engine.dispatch({
      type: LightingCommandTypes.setChannelEnabled,
      payload: { channel: 'beacon', enabled: true },
    })

    expect(readLightingEnabled(
      engine.state,
      LightingStateKeys.channelEnabled('beacon')
    )).toBe(true)
  })

  test('dispatches generic propulsion and APU commands', () => {
    const engine = new SimulatorEngine()
    engine.registerSubsystem(new PropulsionSubsystem())

    engine.dispatch({
      type: PropulsionCommandTypes.setApuStarter,
      payload: { enabled: true },
    })
    engine.dispatch({
      type: PropulsionCommandTypes.setApuRpm,
      payload: { percent: 88 },
    })
    engine.dispatch({
      type: PropulsionCommandTypes.setEngineRunning,
      payload: { index: 2, enabled: true },
    })
  engine.dispatch({
    type: PropulsionCommandTypes.setEngineN1,
    payload: { index: 2, value: 64 },
  })
  engine.dispatch({
    type: PropulsionCommandTypes.setEngineThrottle,
    payload: { index: 2, value: 0.42 },
  })
  engine.dispatch({
    type: PropulsionCommandTypes.setEnginePropellerLever,
    payload: { index: 2, value: 0.7 },
  })
  engine.dispatch({
    type: PropulsionCommandTypes.setEngineMixtureLever,
    payload: { index: 2, value: 0.9 },
  })

    expect(readPropulsionBoolean(engine.state, PropulsionStateKeys.apuStarter())).toBe(true)
    expect(readPropulsionNumber(engine.state, PropulsionStateKeys.apuRpmPercent())).toBe(88)
    expect(readPropulsionBoolean(engine.state, PropulsionStateKeys.engineRunning(2))).toBe(true)
  expect(readPropulsionNumber(engine.state, PropulsionStateKeys.engineN1Percent(2))).toBe(64)
  expect(
    readPropulsionNumber(
      engine.state,
      PropulsionStateKeys.engineThrottleLeverRatio(2)
    )
  ).toBe(0.42)
  expect(
    readPropulsionNumber(
      engine.state,
      PropulsionStateKeys.enginePropellerLeverRatio(2)
    )
  ).toBe(0.7)
  expect(
    readPropulsionNumber(
      engine.state,
      PropulsionStateKeys.engineMixtureLeverRatio(2)
    )
  ).toBe(0.9)
})

  test('dispatches generic control commands', () => {
    const engine = new SimulatorEngine()
    engine.registerSubsystem(new ControlsSubsystem())

    engine.dispatch({
      type: ControlCommandTypes.setGearHandle,
      payload: { ratio: 1 },
    })
  engine.dispatch({
    type: ControlCommandTypes.setFlapsPosition,
    payload: { ratio: 0.5 },
  })
  engine.dispatch({
    type: ControlCommandTypes.setRudderTrim,
    payload: { ratio: -0.25 },
  })
  engine.dispatch({
    type: ControlCommandTypes.setElevatorTrim,
    payload: { ratio: 0.4 },
  })
  engine.dispatch({
    type: ControlCommandTypes.setAileronTrimDisabled,
    payload: { enabled: true },
  })
  engine.dispatch({
    type: ControlCommandTypes.setParkingBrake,
    payload: { enabled: true },
  })

  expect(readControlRatio(engine.state, ControlStateKeys.gearHandleRatio())).toBe(1)
  expect(readControlRatio(engine.state, ControlStateKeys.flapsPositionRatio())).toBe(0.5)
  expect(readControlSignedRatio(engine.state, ControlStateKeys.rudderTrimRatio())).toBe(
    -0.25
  )
  expect(readControlSignedRatio(engine.state, ControlStateKeys.elevatorTrimRatio())).toBe(
    0.4
  )
  expect(readControlBoolean(engine.state, ControlStateKeys.aileronTrimDisabled())).toBe(
    true
  )
  expect(readControlBoolean(engine.state, ControlStateKeys.parkingBrakeEnabled())).toBe(true)
})

test('dispatches generic electrical commands', () => {
  const engine = new SimulatorEngine()
  engine.registerSubsystem(new ElectricalSubsystem())

    engine.dispatch({
      type: ElectricalCommandTypes.setBattery,
      payload: { enabled: true },
    })
    engine.dispatch({
      type: ElectricalCommandTypes.setExternalPowerConnected,
      payload: { enabled: true },
    })
    engine.dispatch({
      type: ElectricalCommandTypes.setBusVoltage,
      payload: { id: 'main', volts: 28 },
    })

    expect(readElectricalBoolean(engine.state, ElectricalStateKeys.batteryEnabled())).toBe(true)
    expect(readElectricalBoolean(engine.state, ElectricalStateKeys.externalPowerConnected())).toBe(true)
  expect(readElectricalNumber(engine.state, ElectricalStateKeys.busVoltage('main'))).toBe(28)
})

test('dispatches generic avionics radio commands', () => {
  const engine = new SimulatorEngine()
  engine.registerSubsystem(new AvionicsSubsystem())

  engine.dispatch({
    type: AvionicsCommandTypes.setRadioActiveFrequency,
    payload: { family: 'com', index: 1, mhz: 118.5 },
  })
  engine.dispatch({
    type: AvionicsCommandTypes.setRadioStandbyFrequency,
    payload: { family: 'com', index: 1, mhz: 121.7 },
  })

  expect(
    readAvionicsNumber(engine.state, AvionicsStateKeys.radioActiveFrequencyMhz('com', 1))
  ).toBe(118.5)
  expect(
    readAvionicsNumber(engine.state, AvionicsStateKeys.radioStandbyFrequencyMhz('com', 1))
  ).toBe(121.7)

  engine.dispatch({
    type: AvionicsCommandTypes.swapRadioFrequencies,
    payload: { family: 'com', index: 1 },
  })
  engine.dispatch({
    type: AvionicsCommandTypes.setTransponderState,
    payload: { index: 2, state: 3 },
  })
  engine.dispatch({
    type: AvionicsCommandTypes.setTransponderIdent,
    payload: { index: 2, active: true },
  })

  expect(
    readAvionicsNumber(engine.state, AvionicsStateKeys.radioActiveFrequencyMhz('com', 1))
  ).toBe(121.7)
  expect(
    readAvionicsNumber(engine.state, AvionicsStateKeys.radioStandbyFrequencyMhz('com', 1))
  ).toBe(118.5)
  expect(readAvionicsNumber(engine.state, AvionicsStateKeys.transponderState(2))).toBe(3)
  expect(engine.state.readBoolean(AvionicsStateKeys.transponderIdentActive(2))).toBe(true)
})

test('dispatches generic autopilot commands', () => {
  const engine = new SimulatorEngine()
  engine.registerSubsystem(new AutopilotSubsystem())

  engine.dispatch({
    type: AutopilotCommandTypes.setMaster,
    payload: { enabled: true },
  })
  engine.dispatch({
    type: AutopilotCommandTypes.setModeEnabled,
    payload: { mode: 'heading', enabled: true },
  })
  engine.dispatch({
    type: AutopilotCommandTypes.setFlightDirectorActive,
    payload: { index: 2, active: true },
  })
  engine.dispatch({
    type: AutopilotCommandTypes.setSelectedHeading,
    payload: { degrees: 370 },
  })
  engine.dispatch({
    type: AutopilotCommandTypes.setSelectedAltitude,
    payload: { feet: 5000 },
  })
  engine.dispatch({
    type: AutopilotCommandTypes.setSelectedVerticalSpeed,
    payload: { feetPerMinute: -700 },
  })

  expect(readAutopilotBoolean(engine.state, AutopilotStateKeys.masterEnabled())).toBe(true)
  expect(
    readAutopilotBoolean(engine.state, AutopilotStateKeys.modeEnabled('heading'))
  ).toBe(true)
  expect(
    readAutopilotBoolean(engine.state, AutopilotStateKeys.flightDirectorActive(2))
  ).toBe(true)
  expect(
    readAutopilotNumber(engine.state, AutopilotStateKeys.selectedHeadingDegrees())
  ).toBe(10)
  expect(
    readAutopilotNumber(engine.state, AutopilotStateKeys.selectedAltitudeFeet())
  ).toBe(5000)
  expect(
    readAutopilotNumber(
      engine.state,
      AutopilotStateKeys.selectedVerticalSpeedFeetPerMinute()
    )
  ).toBe(-700)
})

test('dispatches generic fuel-system commands', () => {
  const engine = new SimulatorEngine()
  engine.registerSubsystem(new FuelSubsystem())

  engine.dispatch({
    type: FuelCommandTypes.setPumpSwitch,
    payload: { index: 1, enabled: true },
  })
  engine.dispatch({
    type: FuelCommandTypes.setPumpActive,
    payload: { index: 1, enabled: true },
  })
  engine.dispatch({
    type: FuelCommandTypes.setValveSwitch,
    payload: { index: 2, open: true },
  })
  engine.dispatch({
    type: FuelCommandTypes.setValveOpen,
    payload: { index: 2, open: true },
  })
  engine.dispatch({
    type: FuelCommandTypes.setJunctionSetting,
    payload: { index: 3, setting: 4 },
  })

  expect(readFuelBoolean(engine.state, FuelStateKeys.pumpSwitchEnabled(1))).toBe(true)
  expect(readFuelBoolean(engine.state, FuelStateKeys.pumpActive(1))).toBe(true)
  expect(readFuelBoolean(engine.state, FuelStateKeys.valveSwitchOpen(2))).toBe(true)
  expect(readFuelBoolean(engine.state, FuelStateKeys.valveOpen(2))).toBe(true)
  expect(readFuelNumber(engine.state, FuelStateKeys.junctionSetting(3))).toBe(4)
})

test('animates generic moving surfaces toward target state', () => {
  const engine = new SimulatorEngine()
    engine.registerSubsystem(
      new SurfaceAnimationSubsystem({
        surfaces: [{ id: 'flaps', extensionRatePerSecond: 0.5 }],
      })
    )

    engine.dispatch({
      type: SurfaceCommandTypes.setTarget,
      payload: { id: 'flaps', ratio: 1 },
    })
    engine.tick(1)

    expect(readSurfaceRatio(engine.state, SurfaceStateKeys.positionRatio('flaps'))).toBe(0.5)
    expect(readSurfaceBoolean(engine.state, SurfaceStateKeys.moving('flaps'))).toBe(true)

    engine.tick(1)

    expect(readSurfaceRatio(engine.state, SurfaceStateKeys.positionRatio('flaps'))).toBe(1)
    expect(readSurfaceBoolean(engine.state, SurfaceStateKeys.moving('flaps'))).toBe(false)
  })

  test('dispatches indexed barometer commands through avionics state', () => {
    const engine = new SimulatorEngine()
    engine.registerSubsystem(new AvionicsSubsystem())

    engine.dispatch({
      type: AvionicsCommandTypes.setBarometer,
      payload: { index: 2, settingHg: 30.12, standardMode: true },
    })

    expect(
      readAvionicsNumber(engine.state, AvionicsStateKeys.barometerSettingHg(2))
    ).toBe(30.12)
    expect(
      engine.state.readBoolean(AvionicsStateKeys.barometerStandardMode(2))
    ).toBe(true)
  })

  test('dispatches indexed ADF frequency commands through avionics state', () => {
    const engine = new SimulatorEngine()
    engine.registerSubsystem(new AvionicsSubsystem())

    engine.dispatch({
      type: AvionicsCommandTypes.setAdfActiveFrequency,
      payload: { index: 1, khz: 305 },
    })
    engine.dispatch({
      type: AvionicsCommandTypes.setAdfStandbyFrequency,
      payload: { index: 2, khz: 350 },
    })

    expect(
      readAvionicsNumber(engine.state, AvionicsStateKeys.adfActiveFrequencyKhz(1))
    ).toBe(305)
    expect(
      readAvionicsNumber(engine.state, AvionicsStateKeys.adfStandbyFrequencyKhz(2))
    ).toBe(350)
  })

  test('dispatches indexed pitot heat commands through environment state', () => {
    const engine = new SimulatorEngine()
    engine.registerSubsystem(new EnvironmentSubsystem())

    engine.dispatch({
      type: EnvironmentCommandTypes.setPitotHeat,
      payload: { index: 2, enabled: true },
    })

    expect(
      engine.state.readBoolean(EnvironmentStateKeys.pitotHeatEnabled(2))
    ).toBe(true)
  })

  test('dispatches deice commands through environment state', () => {
    const engine = new SimulatorEngine()
    engine.registerSubsystem(new EnvironmentSubsystem())

    engine.dispatch({
      type: EnvironmentCommandTypes.setStructuralDeice,
      payload: { enabled: true },
    })
    engine.dispatch({
      type: EnvironmentCommandTypes.setEngineAntiIce,
      payload: { index: 2, enabled: true },
    })

    expect(
      engine.state.readBoolean(EnvironmentStateKeys.structuralDeiceEnabled())
    ).toBe(true)
    expect(
      engine.state.readBoolean(EnvironmentStateKeys.engineAntiIceEnabled(2))
    ).toBe(true)
  })

  test('runs generic cold-start electrical fuel and propulsion flow', () => {
    const engine = createSimulatorEngineForAircraft({
      identity: { id: 'cold-start-fixture' },
      systems: [
        {
          id: 'electrical',
          kind: 'electrical',
          config: {
            buses: [{ id: 'main', nominalVolts: 28 }],
            sources: [
              {
                id: 'battery',
                kind: 'battery',
                busId: 'main',
                nominalVolts: 24,
                defaultAvailable: false,
                defaultConnected: false,
              },
              {
                id: 'engine-1-generator',
                kind: 'engineGenerator',
                busId: 'main',
                engineIndex: 1,
                nominalVolts: 28,
                defaultAvailable: false,
                defaultConnected: true,
              },
            ],
            consumers: [
              { id: 'fuel-pump-1', busId: 'main' },
              { id: 'starter-1', busId: 'main' },
              { id: 'ignition-1', busId: 'main' },
            ],
          },
        },
        {
          id: 'fuel',
          kind: 'fuel',
          config: {
            tanks: [{ id: 'main', defaultQuantityRatio: 1 }],
            pumps: [
              {
                id: 'pump-1',
                index: 1,
                busConsumerId: 'fuel-pump-1',
                tankId: 'main',
              },
            ],
            valves: [{ id: 'engine-1-valve', index: 1 }],
            engineFeeds: [
              {
                engineIndex: 1,
                tankId: 'main',
                pumpIds: ['pump-1'],
                valveIds: ['engine-1-valve'],
              },
            ],
          },
        },
        {
          id: 'propulsion',
          kind: 'propulsion',
          config: {
            engines: [
              {
                index: 1,
                starterConsumerId: 'starter-1',
                ignitionConsumerId: 'ignition-1',
                fuelFeedIndex: 1,
                generatorSourceId: 'engine-1-generator',
                starterN1Percent: 10,
                idleN1Percent: 25,
                spoolUpPercentPerSecond: 25,
                spoolDownPercentPerSecond: 25,
              },
            ],
          },
        },
      ],
    })

    engine.dispatch({
      type: ElectricalCommandTypes.setConsumerSwitch,
      payload: { id: 'fuel-pump-1', enabled: true },
    })
    engine.dispatch({
      type: ElectricalCommandTypes.setConsumerSwitch,
      payload: { id: 'starter-1', enabled: true },
    })
    engine.dispatch({
      type: ElectricalCommandTypes.setConsumerSwitch,
      payload: { id: 'ignition-1', enabled: true },
    })
    engine.dispatch({
      type: FuelCommandTypes.setPumpSwitch,
      payload: { index: 1, enabled: true },
    })
    engine.dispatch({
      type: FuelCommandTypes.setValveSwitch,
      payload: { index: 1, open: true },
    })
    engine.tick(1)

    expect(readElectricalBoolean(engine.state, ElectricalStateKeys.busPowered('main'))).toBe(false)
    expect(readFuelBoolean(engine.state, FuelStateKeys.pumpActive('pump-1'))).toBe(false)

    engine.dispatch({
      type: ElectricalCommandTypes.setBattery,
      payload: { enabled: true },
    })
    engine.tick(1)

    expect(readElectricalBoolean(engine.state, ElectricalStateKeys.busPowered('main'))).toBe(true)
    expect(readElectricalNumber(engine.state, ElectricalStateKeys.busVoltage('main'))).toBe(24)
    expect(readElectricalBoolean(engine.state, ElectricalStateKeys.consumerPowered('fuel-pump-1'))).toBe(true)
    expect(readFuelBoolean(engine.state, FuelStateKeys.pumpActive('pump-1'))).toBe(true)
    expect(readFuelBoolean(engine.state, FuelStateKeys.engineAvailable(1))).toBe(true)

    engine.dispatch({
      type: PropulsionCommandTypes.setEngineStarter,
      payload: { index: 1, enabled: true },
    })
    engine.tick(1)
    engine.tick(1)

    expect(readPropulsionBoolean(engine.state, PropulsionStateKeys.engineCombustion(1))).toBe(true)
    expect(readPropulsionNumber(engine.state, PropulsionStateKeys.engineN1Percent(1))).toBe(25)
    expect(readPropulsionNumber(engine.state, PropulsionStateKeys.engineRpm(1))).toBe(2500)
    expect(readPropulsionBoolean(engine.state, PropulsionStateKeys.engineGeneratorAvailable(1))).toBe(true)

    engine.dispatch({
      type: ElectricalCommandTypes.setBattery,
      payload: { enabled: false },
    })
    engine.tick(1)
    engine.tick(1)

    expect(readElectricalBoolean(engine.state, ElectricalStateKeys.busPowered('main'))).toBe(true)
    expect(readElectricalNumber(engine.state, ElectricalStateKeys.busVoltage('main'))).toBe(28)
  })

  test('surface animation follows canonical control handle state', () => {
    const engine = createSimulatorEngineForAircraft({
      identity: { id: 'surface-fixture' },
    })

    engine.dispatch({
      type: ControlCommandTypes.setFlapsHandle,
      payload: { ratio: 0.5 },
    })
    engine.tick(0.5)

    expect(readSurfaceRatio(engine.state, SurfaceStateKeys.targetRatio('flaps'))).toBe(0.5)
    expect(readSurfaceRatio(engine.state, SurfaceStateKeys.positionRatio('flaps'))).toBe(0.425)
    expect(readSurfaceBoolean(engine.state, SurfaceStateKeys.moving('flaps'))).toBe(true)

    engine.tick(1)

    expect(readSurfaceRatio(engine.state, SurfaceStateKeys.positionRatio('flaps'))).toBe(0.5)
    expect(readSurfaceBoolean(engine.state, SurfaceStateKeys.moving('flaps'))).toBe(false)
  })
})
