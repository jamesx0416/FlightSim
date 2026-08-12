import { expect, test } from 'bun:test'

import type {
  CanonicalAirPhysicsSystemConfig,
  CanonicalPropulsionEngineConfig,
} from './aircraft'
import {
  AirPhysicsCommandTypes,
  finiteWingCompressibilityMultiplier,
} from './airPhysics'
import { AirPhysicsStateKeys } from './airState'
import { computeJetThrustN } from './jetEngine'
import { ControlStateKeys } from './controls'
import { EnvironmentCommandTypes } from './environment'
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

function createPhysicsEngine(
  engines: readonly CanonicalPropulsionEngineConfig[] = [],
  physics: CanonicalAirPhysicsSystemConfig = basePhysics
) {
  return createSimulatorEngineForAircraft({
    identity: { id: 'physics-test' },
    systems: [
      { id: 'propulsion', kind: 'propulsion', config: { engines } },
      { id: 'air-physics', kind: 'air-physics', config: physics },
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

  reset()
  engine.tick(1 / 60)
  const neutralPitchRate = engine.state.readNumber(AirPhysicsStateKeys.pitchRateRadPerSecond()) ?? 0
  setControl(ControlStateKeys.elevatorPositionRatio(), 1)
  reset()
  engine.tick(1 / 60)
  expect((engine.state.readNumber(AirPhysicsStateKeys.pitchRateRadPerSecond()) ?? 0) < neutralPitchRate).toBe(true)

  setControl(ControlStateKeys.elevatorPositionRatio(), 0)
  reset()
  engine.tick(1 / 60)
  const neutralRollRate = engine.state.readNumber(AirPhysicsStateKeys.rollRateRadPerSecond()) ?? 0
  setControl(ControlStateKeys.aileronPositionRatio(), 1)
  reset()
  engine.tick(1 / 60)
  expect((engine.state.readNumber(AirPhysicsStateKeys.rollRateRadPerSecond()) ?? 0) > neutralRollRate).toBe(true)

  setControl(ControlStateKeys.aileronPositionRatio(), 0)
  reset()
  engine.tick(1 / 60)
  const neutralYawRate = engine.state.readNumber(AirPhysicsStateKeys.yawRateRadPerSecond()) ?? 0
  setControl(ControlStateKeys.rudderPositionRatio(), 1)
  reset()
  engine.tick(1 / 60)
  expect((engine.state.readNumber(AirPhysicsStateKeys.yawRateRadPerSecond()) ?? 0) > neutralYawRate).toBe(true)
})

test('independent wing sections can enter post-stall at different times', () => {
  const physics: CanonicalAirPhysicsSystemConfig = {
    ...basePhysics,
    geometry: {
      ...basePhysics.geometry,
      wingSweepRad: 0,
      wingDihedralRad: 0,
      wingTwistRad: 0,
      aerodynamicCenterBodyM: [0, 0, 0],
      aileronAreaM2: 0,
      horizontalTailAreaM2: 0,
      elevatorAreaM2: 0,
      verticalTailAreaM2: 0,
      rudderAreaM2: 0,
    },
    aerodynamics: {
      ...basePhysics.aerodynamics,
      liftCoefficientByAlphaRad: {
        breakpoints: [-0.5, 0, 0.12, 0.18, 0.3, 0.6],
        values: [-0.5, 0, 1.2, 1.5, 0.6, 0],
      },
      pitchMomentZero: 0,
      pitchMomentAlphaCoefficient: 0,
      pitchDampingCoefficient: 0,
      rollSlipAngleCoefficient: 0,
      rollDampingCoefficient: 0,
      rollAileronCoefficient: 0,
      yawSlipAngleCoefficient: 0,
      yawDampingCoefficient: 0,
      yawRudderCoefficient: 0,
    },
  }
  const engine = createPhysicsEngine([], physics)
  const rollTorqueAtPitch = (pitchRad: number): number => {
    engine.dispatch({
      type: AirPhysicsCommandTypes.reset,
      payload: {
        altitudeMeters: 1000,
        airspeedMps: 90,
        pitchRad,
        angularVelocityBodyRadPerSec: [1, 0, 0],
        enabled: true,
      },
    })
    engine.tick(1 / 120)
    return engine.state.readNumber(AirPhysicsStateKeys.torqueBodyRollNm()) ?? 0
  }

  expect(rollTorqueAtPitch(0.08) < 0).toBe(true)
  expect(rollTorqueAtPitch(0.2) > 0).toBe(true)
})

test('tail downwash follows local spanwise wing loading', () => {
  const physics: CanonicalAirPhysicsSystemConfig = {
    ...basePhysics,
    geometry: {
      ...basePhysics.geometry,
      wingSweepRad: 0,
      wingDihedralRad: 0,
      wingTwistRad: 0,
      aerodynamicCenterBodyM: [0, 0, 0],
      horizontalTailAreaM2: 6,
      horizontalTailSpanM: 4,
      horizontalTailPositionBodyM: [-4, 2.2, 0],
      elevatorAreaM2: 0,
      verticalTailAreaM2: 0,
      rudderAreaM2: 0,
    },
    aerodynamics: {
      ...basePhysics.aerodynamics,
      liftCoefficientByAlphaRad: {
        breakpoints: [-0.5, 0, 0.5],
        values: [-2.5, 0, 2.5],
      },
      flapLiftCoefficient: 0,
      spoilerLiftCoefficient: 0,
      pitchMomentZero: 0,
      pitchMomentAlphaCoefficient: 0,
      pitchDampingCoefficient: 0,
      pitchElevatorCoefficient: 0,
      pitchFlapCoefficient: 0,
      pitchGearCoefficient: 0,
      pitchSpoilerCoefficient: 0,
    },
  }
  const engine = createPhysicsEngine([], physics)
  const pitchTorqueForAileron = (aileron: number): number => {
    engine.state.set(ControlStateKeys.aileronPositionRatio(), aileron, {
      source: 'runtime', unit: 'ratio',
    })
    engine.dispatch({
      type: AirPhysicsCommandTypes.reset,
      payload: { altitudeMeters: 1000, airspeedMps: 90, pitchRad: 0.1, enabled: true },
    })
    engine.tick(1 / 120)
    return engine.state.readNumber(AirPhysicsStateKeys.torqueBodyPitchNm()) ?? 0
  }

  const positiveAileronTorque = pitchTorqueForAileron(1)
  const negativeAileronTorque = pitchTorqueForAileron(-1)
  expect(Math.abs(positiveAileronTorque - negativeAileronTorque) > 1).toBe(true)
})

test('fuselage crossflow opposes sideslip from local airflow', () => {
  const physics: CanonicalAirPhysicsSystemConfig = {
    ...basePhysics,
    geometry: {
      ...basePhysics.geometry,
      horizontalTailAreaM2: 0,
      elevatorAreaM2: 0,
      verticalTailAreaM2: 0,
      rudderAreaM2: 0,
      fuselageLengthM: 20,
      fuselageDiameterM: 3,
      fuselageCenterBodyM: [0, 0, 0],
    },
    aerodynamics: {
      ...basePhysics.aerodynamics,
      sideForceSlipAngleCoefficient: 0,
      sideForceRudderCoefficient: 0,
      fuselageLateralDragCoefficient: 0.5,
    },
  }
  const engine = createPhysicsEngine([], physics)
  engine.dispatch({
    type: AirPhysicsCommandTypes.reset,
    payload: {
      altitudeMeters: 1000,
      velocityNedMps: [90, 20, 0],
      enabled: true,
    },
  })
  engine.tick(1 / 120)

  const betaRad = engine.state.readNumber(AirPhysicsStateKeys.betaRad()) ?? 0
  const densityKgPerM3 = engine.state.readNumber(AirPhysicsStateKeys.densityKgPerM3()) ?? 0
  const sideN = engine.state.readNumber(AirPhysicsStateKeys.sideN()) ?? 0
  expect(betaRad > 0).toBe(true)
  expect(Math.abs(sideN - (-6000 * densityKgPerM3)) < 1e-6).toBe(true)
})


test('spanwise horizontal-tail elements respond to local turbulence independently', () => {
  const physics: CanonicalAirPhysicsSystemConfig = {
    ...basePhysics,
    geometry: {
      ...basePhysics.geometry,
      horizontalTailAreaM2: 8,
      horizontalTailSpanM: 8,
      horizontalTailPositionBodyM: [-5, 0, 0],
      elevatorAreaM2: 0,
      verticalTailAreaM2: 0,
      rudderAreaM2: 0,
    },
    aerodynamics: {
      ...basePhysics.aerodynamics,
      liftCoefficientByAlphaRad: {
        breakpoints: [-0.5, 0, 0.5],
        values: [0, 0, 0],
      },
      zeroLiftDragCoefficient: 0,
      fuselageLateralDragCoefficient: 0,
    },
  }
  const engine = createPhysicsEngine([], physics)
  engine.dispatch({
    type: EnvironmentCommandTypes.setTurbulence,
    payload: { intensityMps: 4, scaleM: 5, timeScaleSeconds: 2 },
  })
  engine.dispatch({
    type: AirPhysicsCommandTypes.reset,
    payload: { altitudeMeters: 1000, airspeedMps: 90, enabled: true },
  })
  engine.tick(1 / 120)

  expect(Math.abs(engine.state.readNumber(AirPhysicsStateKeys.torqueBodyRollNm()) ?? 0) > 1).toBe(true)
})

test('fuselage normal crossflow opposes vertical as well as lateral airflow', () => {
  const physics: CanonicalAirPhysicsSystemConfig = {
    ...basePhysics,
    geometry: {
      ...basePhysics.geometry,
      horizontalTailAreaM2: 0,
      elevatorAreaM2: 0,
      verticalTailAreaM2: 0,
      rudderAreaM2: 0,
      fuselageLengthM: 20,
      fuselageDiameterM: 3,
      fuselageCenterBodyM: [5, 0, 0],
    },
    aerodynamics: {
      ...basePhysics.aerodynamics,
      liftCoefficientByAlphaRad: {
        breakpoints: [-0.5, 0, 0.5],
        values: [0, 0, 0],
      },
      zeroLiftDragCoefficient: 0,
      fuselageLateralDragCoefficient: 0.5,
    },
  }
  const engine = createPhysicsEngine([], physics)
  engine.dispatch({
    type: AirPhysicsCommandTypes.reset,
    payload: { altitudeMeters: 1000, velocityNedMps: [90, 0, 20], enabled: true },
  })
  engine.tick(1 / 120)

  expect((engine.state.readNumber(AirPhysicsStateKeys.forceBodyDownN()) ?? 0) < 0).toBe(true)
  expect((engine.state.readNumber(AirPhysicsStateKeys.torqueBodyPitchNm()) ?? 0) > 0).toBe(true)
})

test('finite-wing compressibility raises subsonic lift slope and sweep weakens it', () => {
  const lowMach = finiteWingCompressibilityMultiplier(0.2, 0, 10, 0.8)
  const highMach = finiteWingCompressibilityMultiplier(0.8, 0, 10, 0.8)
  const sweptHighMach = finiteWingCompressibilityMultiplier(0.8, Math.PI / 6, 10, 0.8)

  expect(highMach > lowMach).toBe(true)
  expect(sweptHighMach < highMach).toBe(true)
  expect(lowMach >= 1).toBe(true)
})

test('ground proximity increases wing lift and reduces induced drag', () => {
  const physics: CanonicalAirPhysicsSystemConfig = {
    ...basePhysics,
    geometry: {
      ...basePhysics.geometry,
      horizontalTailAreaM2: 0,
      elevatorAreaM2: 0,
      verticalTailAreaM2: 0,
      rudderAreaM2: 0,
    },
    aerodynamics: {
      ...basePhysics.aerodynamics,
      zeroLiftDragCoefficient: 0,
      machDragCoefficientAdd: undefined,
      gearDragCoefficient: 0,
      flapDragCoefficient: 0,
      spoilerDragCoefficient: 0,
      groundEffectLiftMultiplierByMach: {
        breakpoints: [0, 1],
        values: [1.2, 1.2],
      },
    },
  }
  const engine = createPhysicsEngine([], physics)
  const sample = (groundElevationM: number) => {
    engine.dispatch({
      type: EnvironmentCommandTypes.setGroundElevation,
      payload: { value: groundElevationM },
    })
    engine.dispatch({
      type: AirPhysicsCommandTypes.reset,
      payload: { altitudeMeters: 1000, airspeedMps: 90, pitchRad: 0.1, enabled: true },
    })
    engine.tick(1 / 120)
    return {
      liftN: engine.state.readNumber(AirPhysicsStateKeys.liftN()) ?? 0,
      dragN: engine.state.readNumber(AirPhysicsStateKeys.dragN()) ?? 0,
    }
  }

  const outOfGroundEffect = sample(0)
  const inGroundEffect = sample(999)
  expect(inGroundEffect.liftN > outOfGroundEffect.liftN).toBe(true)
  expect(inGroundEffect.dragN < outOfGroundEffect.dragN).toBe(true)
})

test('spatial turbulence perturbs wing sections differently and changes over time', () => {
  const physics: CanonicalAirPhysicsSystemConfig = {
    ...basePhysics,
    geometry: {
      ...basePhysics.geometry,
      wingSweepRad: 0,
      wingDihedralRad: 0,
      wingTwistRad: 0,
      horizontalTailAreaM2: 0,
      elevatorAreaM2: 0,
      verticalTailAreaM2: 0,
      rudderAreaM2: 0,
    },
  }
  const engine = createPhysicsEngine([], physics)
  engine.dispatch({
    type: EnvironmentCommandTypes.setTurbulence,
    payload: { intensityMps: 5, scaleM: 8, timeScaleSeconds: 0.5 },
  })
  engine.dispatch({
    type: AirPhysicsCommandTypes.reset,
    payload: { altitudeMeters: 1000, airspeedMps: 90, enabled: true },
  })
  engine.tick(1 / 120)
  const firstRollTorque = engine.state.readNumber(AirPhysicsStateKeys.torqueBodyRollNm()) ?? 0
  for (let index = 0; index < 20; index += 1) engine.tick(1 / 120)
  const laterRollTorque = engine.state.readNumber(AirPhysicsStateKeys.torqueBodyRollNm()) ?? 0

  expect(Math.abs(firstRollTorque) > 1).toBe(true)
  expect(Math.abs(laterRollTorque - firstRollTorque) > 1).toBe(true)
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
