import { expect, test } from 'bun:test'

import type {
  CanonicalAirPhysicsSystemConfig,
  CanonicalPropulsionEngineConfig,
} from './aircraft'
import {
  AirPhysicsCommandTypes,
} from './airPhysics'
import { AirPhysicsStateKeys } from './airState'
import { computeJetThrustN } from './jetEngine'
import { ControlStateKeys } from './controls'
import { createSimulatorEngineForAircraft } from './factory'
import { PropulsionStateKeys } from './propulsion'

const basePhysics: CanonicalAirPhysicsSystemConfig = {
  emptyMassKg: 10_000,
  maxGrossMassKg: 20_000,
  inertiaKgM2: [100_000, 120_000, 150_000],
  geometry: {
    wingAreaM2: 30,
    wingSpanM: 10,
    wingRootChordM: 4,
    wingTipChordM: 2,
    meanChordM: 3,
    wingIncidenceRad: 0,
    wingDihedralRad: 0.08,
    wingSweepRad: 0.25,
    wingTwistRad: -0.03,
    aerodynamicCenterBodyM: [0, 0, 0],
    oswaldEfficiency: 0.8,
    aileronAreaM2: 2,
    horizontalTailAreaM2: 6,
    horizontalTailSpanM: 4,
    horizontalTailPositionBodyM: [-4, 0, -0.5],
    horizontalTailIncidenceRad: 0,
    elevatorAreaM2: 1.5,
    verticalTailAreaM2: 4,
    verticalTailSpanM: 2.5,
    verticalTailPositionBodyM: [-4, 0, -1.5],
    rudderAreaM2: 1,
    bladeElementCount: 16,
  },
  aerodynamics: {
    liftCoefficientByAlphaRad: {
      breakpoints: [-3.14, -0.2, 0, 0.2, 3.14],
      values: [0, -0.8, 0.2, 1.2, 0],
    },
    liftScalar: 1,
    zeroLiftDragCoefficient: 0.02,
    liftCoefficientAtDragZero: 0.1,
    parasiteDragScalar: 1,
    inducedDragScalar: 1,
    flapInducedDragScalar: 1,
    flapLiftCoefficient: 0.8,
    flapDragCoefficient: 0.05,
    gearDragCoefficient: 0.03,
    spoilerLiftCoefficient: -0.2,
    spoilerDragCoefficient: 0.04,
    sideForceSlipAngleCoefficient: 0,
    sideForceRudderCoefficient: 0,
    pitchMomentZero: 0,
    pitchMomentAlphaCoefficient: 0,
    pitchDampingCoefficient: 0,
    pitchElevatorCoefficient: 0,
    pitchFlapCoefficient: 0,
    pitchGearCoefficient: 0,
    pitchSpoilerCoefficient: 0,
    rollSlipAngleCoefficient: 0,
    rollDampingCoefficient: 0,
    rollAileronCoefficient: 0,
    yawSlipAngleCoefficient: 0,
    yawDampingCoefficient: 0,
    yawRudderCoefficient: 0,
  },
  controls: {
    aileronLimitRad: 0.4,
    elevatorLimitRad: 0.35,
    rudderLimitRad: 0.4,
    aileronEffectiveness: 1,
    elevatorEffectiveness: 1,
    rudderEffectiveness: 1,
    elevatorLiftCoefficientSlopePerRad: 5,
    rudderLiftCoefficientSlopePerRad: 5,
    flapSpanOutboardRatio: 0.8,
  },
}
const jet: CanonicalPropulsionEngineConfig = {
  index: 1,
  highN1Percent: 100,
  staticThrustN: 100_000,
  thrustScalar: 1,
  thrustByCorrectedN1AndMach: {
    breakpointsX: [0, 0.8],
    breakpointsY: [20, 100],
    values: [0.08, 0.05, 1.3, 0.8],
  },
}

test('applies the configured gross thrust multiplier and pressure correction', () => {
  const seaLevel = computeJetThrustN(jet, 100, {
    temperatureK: 288.15, pressurePa: 101325, mach: 0, trueAirspeedMps: 0,
  })
  const halfPressure = computeJetThrustN(jet, 100, {
    temperatureK: 288.15, pressurePa: 50662.5, mach: 0, trueAirspeedMps: 0,
  })
  expect(Math.abs(seaLevel - 130_000) < 1e-6).toBe(true)
  expect(Math.abs(halfPressure - 65_000) < 1e-6).toBe(true)
  expect(computeJetThrustN(jet, 20, {
    temperatureK: 288.15, pressurePa: 101325, mach: 0, trueAirspeedMps: 0,
  }) > 0).toBe(true)
})

function createPhysicsEngine(engines: readonly CanonicalPropulsionEngineConfig[] = []) {
  return createSimulatorEngineForAircraft({
    identity: { id: 'physics-test' },
    systems: [
      { id: 'propulsion', kind: 'propulsion', config: { engines } },
      { id: 'air-physics', kind: 'air-physics', config: basePhysics },
    ],
  })
}
test('air density and lift decrease with altitude at the same airspeed', () => {
  const engine = createPhysicsEngine()
  engine.dispatch({
    type: AirPhysicsCommandTypes.reset,
    payload: { altitudeMeters: 0, airspeedMps: 100, enabled: true },
  })
  engine.tick(1 / 60)
  const seaDensity = engine.state.readNumber(AirPhysicsStateKeys.densityKgPerM3()) ?? 0
  const seaLift = engine.state.readNumber(AirPhysicsStateKeys.liftN()) ?? 0

  engine.dispatch({
    type: AirPhysicsCommandTypes.reset,
    payload: { altitudeMeters: 10_000, airspeedMps: 100, enabled: true },
  })
  engine.tick(1 / 60)
  const highDensity = engine.state.readNumber(AirPhysicsStateKeys.densityKgPerM3()) ?? 0
  const highLift = engine.state.readNumber(AirPhysicsStateKeys.liftN()) ?? 0

  expect(seaDensity > highDensity).toBe(true)
  expect(seaLift > highLift).toBe(true)
  expect(highLift > 0).toBe(true)
})
test('off-center engine thrust creates asymmetric yaw', () => {
  const engines: CanonicalPropulsionEngineConfig[] = [
    { ...jet, index: 1, positionBodyM: [0, -2, 0] },
    { ...jet, index: 2, positionBodyM: [0, 2, 0] },
  ]
  const engine = createPhysicsEngine(engines)
  engine.state.set(PropulsionStateKeys.engineN1Percent(1), 100, {
    source: 'runtime', unit: 'percent',
  })
  engine.state.set(PropulsionStateKeys.engineN1Percent(2), 100, {
    source: 'runtime', unit: 'percent',
  })
  engine.dispatch({
    type: AirPhysicsCommandTypes.reset,
    payload: { altitudeMeters: 1000, airspeedMps: 0, enabled: true },
  })
  engine.tick(1 / 60)
  const symmetricYawRate = engine.state.readNumber(AirPhysicsStateKeys.yawRateRadPerSecond()) ?? 0
  expect(Math.abs(symmetricYawRate) < 1e-9).toBe(true)

  engine.state.set(PropulsionStateKeys.engineN1Percent(2), 0, {
    source: 'runtime', unit: 'percent',
  })
  engine.dispatch({
    type: AirPhysicsCommandTypes.reset,
    payload: { altitudeMeters: 1000, airspeedMps: 0, enabled: true },
  })
  engine.tick(1 / 60)
  const asymmetricYawRate = engine.state.readNumber(AirPhysicsStateKeys.yawRateRadPerSecond()) ?? 0
  expect(asymmetricYawRate > 0).toBe(true)
})
test('geometric control surfaces produce body moments', () => {
  const engine = createPhysicsEngine()
  const reset = () => {
    engine.dispatch({
      type: AirPhysicsCommandTypes.reset,
      payload: { altitudeMeters: 1000, airspeedMps: 90, enabled: true },
    })
  }
  const setControl = (key: string, value: number) => {
    engine.state.set(key, value, { source: 'runtime', unit: 'ratio' })
  }

  setControl(ControlStateKeys.elevatorPositionRatio(), 1)
  reset()
  engine.tick(1 / 60)
  expect((engine.state.readNumber(AirPhysicsStateKeys.pitchRateRadPerSecond()) ?? 0) < 0).toBe(true)

  setControl(ControlStateKeys.elevatorPositionRatio(), 0)
  setControl(ControlStateKeys.aileronPositionRatio(), 1)
  reset()
  engine.tick(1 / 60)
  expect((engine.state.readNumber(AirPhysicsStateKeys.rollRateRadPerSecond()) ?? 0) > 0).toBe(true)

  setControl(ControlStateKeys.aileronPositionRatio(), 0)
  setControl(ControlStateKeys.rudderPositionRatio(), 1)
  reset()
  engine.tick(1 / 60)
  expect((engine.state.readNumber(AirPhysicsStateKeys.yawRateRadPerSecond()) ?? 0) > 0).toBe(true)
})


test('fuel flow reduces airborne aircraft mass', () => {
  const engine = createPhysicsEngine([{ ...jet, index: 1 }])
  engine.state.set(PropulsionStateKeys.engineFuelFlowKgPerSecond(1), 2, {
    source: 'runtime', unit: 'kilogramsPerSecond',
  })
  engine.dispatch({
    type: AirPhysicsCommandTypes.reset,
    payload: { altitudeMeters: 1000, massKg: 15_000, enabled: true },
  })

  for (let frame = 0; frame < 60; frame += 1) engine.tick(1 / 60)
  const massKg = engine.state.readNumber(AirPhysicsStateKeys.massKg(), {
    unit: 'kilograms', fallback: 0,
  }) ?? 0
  expect(Math.abs(massKg - 14_998) < 0.02).toBe(true)
})
