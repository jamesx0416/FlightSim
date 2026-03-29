import { Vector3 } from 'three'
import type { AircraftParams } from './FlightModel'
import type { LookupTable1D } from './LookupTable'

// Derived from:
// - third_party/flybywire-aircraft/fbw-a32nx/.../flight_model.cfg
// - third_party/flybywire-aircraft/fbw-a32nx/.../engines.cfg
// - third_party/flybywire-aircraft/fbw-a32nx/.../target_performance.cfg
//
// The current sim uses a simpler rigid-body solver than MSFS, so the AoA/drag
// curves and geometry are sourced from FlyByWire while some moment/control
// coefficients remain normalized to fit this solver's conventions.

const A320_WING_AREA_M2 = 122.39696810880001
const A320_WING_SPAN_M = 35.7999792
const A320_MEAN_CHORD_M = A320_WING_AREA_M2 / A320_WING_SPAN_M
const A320_EMPTY_WEIGHT_KG = 42_500
const A320_TYPICAL_FLIGHT_WEIGHT_KG = 67_400
const A320_MAX_THRUST_N = 241_271.5404117295
const A320_EMPTY_WEIGHT_INERTIA_KGM2 = new Vector3(
  1_340_910.73163975,
  3_326_789.4853663,
  4_292_706.7325771
)

function scaleInertiaForMass(massKg: number): Vector3 {
  return A320_EMPTY_WEIGHT_INERTIA_KGM2
    .clone()
    .multiplyScalar(massKg / A320_EMPTY_WEIGHT_KG)
}

const a320ThrottleToThrustFraction: LookupTable1D = {
  // Pragmatic jet throttle shaping for this simplified solver:
  // low keyboard throttle should be near-idle, not 10% of max rated thrust.
  breakpoints: [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.85, 1],
  values: [0, 0.002, 0.005, 0.02, 0.08, 0.18, 0.4, 0.68, 1]
}

const a320AlphaCl: LookupTable1D = {
  // Clean-wing lift shape based on FlyByWire's lift_coef_aoa_table and
  // target_performance stall/zero-lift entries.
  breakpoints: [-90, -45, -28.648, -18.335, -14.897, -11.459, -7.964, -3.6, 0, 7.964, 11.459, 14.897, 16.616, 18.335, 28.648, 45, 90],
  values: [0, -0.35, -0.95, -1.6, -1.74, -1.48, -1.08, 0, 0.138, 1.32, 1.48, 1.7417, 1.75, 1.6, 1.5, 0.4, 0]
}

const a320AlphaCd: LookupTable1D = {
  // Drag anchors are based on target_performance no-flap drag points with
  // additional separated-flow drag past the clean stall.
  breakpoints: a320AlphaCl.breakpoints,
  values: [1.55, 0.82, 0.42, 0.22, 0.125, 0.075, 0.052, 0.024, 0.0331, 0.052, 0.075, 0.125, 0.17, 0.22, 0.42, 0.82, 1.55]
}

const a320AlphaCm: LookupTable1D = {
  // Hybrid pitch-moment curve: anchored by the A320 clean alpha region, but
  // softened toward the prior custom tuning because the current solver does
  // not model the full MSFS tail/FBW law stack.
  breakpoints: [-90, -45, -28.648, -18.335, -14.897, -11.459, -7.964, -3.6, 0, 7.964, 11.459, 14.897, 16.616, 18.335, 28.648, 45, 90],
  values: [-0.01, -0.02, -0.03, -0.06, -0.075, -0.06, -0.03, 0, 0.03, 0.072, 0.09, 0.11, 0.12, 0.11, 0.07, 0.02, -0.015]
}

const a320BetaCy: LookupTable1D = {
  breakpoints: [-30, -20, -10, -5, 0, 5, 10, 20, 30],
  values: [0.58, 0.4, 0.22, 0.11, 0, -0.11, -0.22, -0.4, -0.58]
}

const a320BetaCl: LookupTable1D = {
  breakpoints: [-30, -20, -10, -5, 0, 5, 10, 20, 30],
  values: [0.04, 0.027, 0.013, 0.006, 0, -0.006, -0.013, -0.027, -0.04]
}

const a320BetaCn: LookupTable1D = {
  breakpoints: [-30, -20, -10, -5, 0, 5, 10, 20, 30],
  values: [-0.05, -0.034, -0.017, -0.008, 0, 0.008, 0.017, 0.034, 0.05]
}

const a320ControlAlphaClDeltaE: LookupTable1D = {
  // Elevator lift contribution should decay at high AoA, but not invert.
  breakpoints: [0, 5, 10, 20, 30, 45, 60, 90],
  values: [0.038, 0.037, 0.034, 0.028, 0.023, 0.018, 0.014, 0.012]
}

const a320ControlAlphaCmDeltaE: LookupTable1D = {
  // The old model used a constant negative Cmde. Keep that sign, but taper
  // effectiveness with AoA so the elevator never reverses direction.
  breakpoints: [0, 5, 10, 20, 30, 45, 60, 90],
  values: [-0.62, -0.6, -0.56, -0.48, -0.4, -0.32, -0.26, -0.22]
}

const a320ControlAlphaClDeltaA: LookupTable1D = {
  breakpoints: [0, 10, 15, 20, 30, 45, 60, 90],
  values: [0.034, 0.032, 0.029, 0.023, 0.015, 0.008, 0.003, 0.001]
}

const a320ControlAlphaCyDeltaR: LookupTable1D = {
  breakpoints: [0, 10, 15, 20, 30, 45, 60, 90],
  values: [0.14, 0.135, 0.12, 0.095, 0.06, 0.028, 0.01, 0]
}

const a320ControlAlphaCnDeltaR: LookupTable1D = {
  breakpoints: [0, 10, 15, 20, 30, 45, 60, 90],
  values: [0.052, 0.05, 0.045, 0.035, 0.022, 0.01, 0.003, 0]
}

export function flyByWireA320AircraftParams(): AircraftParams {
  return {
    massKg: A320_TYPICAL_FLIGHT_WEIGHT_KG,
    inertiaKgM2: scaleInertiaForMass(A320_TYPICAL_FLIGHT_WEIGHT_KG),
    wingAreaM2: A320_WING_AREA_M2,
    wingSpanM: A320_WING_SPAN_M,
    meanChordM: A320_MEAN_CHORD_M,
    maxThrustN: A320_MAX_THRUST_N,
    throttleToThrustFraction: a320ThrottleToThrustFraction,
    controlLimitsRad: {
      aileron: (25 * Math.PI) / 180,
      elevator: (25 * Math.PI) / 180,
      rudder: (25 * Math.PI) / 180
    },
    angularDampingPerSec: new Vector3(0.26, 0.36, 0.26),
    configuration: {
      flapDetents01: [0, 0.2, 0.45, 0.7, 1],
      flapRatePerSec: 0.1,
      gearRatePerSec: 0.22,
      spoilerRatePerSec: 1.8,
      flapLiftClMax: 1.0,
      flapDragCdMax: 0.2,
      flapPitchCmMax: 0.12,
      gearDragCdMax: 0.045,
      spoilerDragCdMax: 0.16,
      spoilerLiftLossMax: 0.42,
      spoilerPitchCmMax: 0.03
    },
    aero: {
      CL0: 0.138,
      CLalphaPerRad: 5.5,
      CLmax: 1.7417,
      alphaStallRad: (15 * Math.PI) / 180,
      alphaStallBlendRad: (4 * Math.PI) / 180,
      CD0: 0.0216,
      inducedDragFactor: 0.0404,
      CDbeta: 0.04,
      CDStallAdd: 0.5,
      CYbetaPerRad: -0.62,

      ClbetaPerRad: -0.08,
      Clp: -0.62,
      Clda: 0.034,

      Cm0: 0.03,
      CmalphaPerRad: 0.45,
      Cmq: -11.5,
      Cmde: -0.62,

      Cn0: 0,
      CnbetaPerRad: 0.18,
      Cnr: -0.32,
      Cndr: 0.052,
      lookup: {
        alphaCl: a320AlphaCl,
        alphaCd: a320AlphaCd,
        alphaCm: a320AlphaCm,
        betaCy: a320BetaCy,
        betaCl: a320BetaCl,
        betaCn: a320BetaCn,
        controlAlphaClDeltaE: a320ControlAlphaClDeltaE,
        controlAlphaCmDeltaE: a320ControlAlphaCmDeltaE,
        controlAlphaClDeltaA: a320ControlAlphaClDeltaA,
        controlAlphaCyDeltaR: a320ControlAlphaCyDeltaR,
        controlAlphaCnDeltaR: a320ControlAlphaCnDeltaR
      }
    }
  }
}
