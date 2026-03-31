import { Vector3 } from 'three'
import { lookup1D, type LookupTable1D } from './LookupTable'

export interface ControlInputs {
  throttle01: number
  aileron: number
  elevator: number
  rudder: number
  flapTarget01: number
  gearDown: boolean
  spoilerTarget01: number
}

export interface AircraftConfigurationState {
  flaps01: number
  gear01: number
  spoiler01: number
}

export interface FlapVisualSchedule {
  detents01: readonly number[]
  trailingOutboardDeg: readonly number[]
  trailingInboardDeg: readonly number[]
  leadingDeg: readonly number[]
}

export interface FlapAutoCommandConfig {
  conf1Handle01: number
  conf1Surface01: number
  conf1FSurface01: number
  lowSpeedKts: number
  highSpeedKts: number
}

export interface AircraftAeroParams {
  // Lift / drag / sideforce
  CL0: number
  CLalphaPerRad: number
  CLmax: number
  alphaStallRad: number
  alphaStallBlendRad: number
  CD0: number
  inducedDragFactor: number
  CDbeta: number
  CDStallAdd: number
  CYbetaPerRad: number

  // Moments (right-hand about body axes x=roll, y=pitch, z=yaw; body z is down)
  ClbetaPerRad: number
  Clp: number
  Clda: number

  Cm0: number
  CmalphaPerRad: number
  Cmq: number
  Cmde: number

  Cn0: number
  CnbetaPerRad: number
  Cnr: number
  Cndr: number

  lookup?: {
    alphaCl: LookupTable1D
    alphaCd: LookupTable1D
    alphaCm: LookupTable1D
    betaCy: LookupTable1D
    betaCl: LookupTable1D
    betaCn: LookupTable1D
    controlAlphaClDeltaE: LookupTable1D
    controlAlphaCmDeltaE: LookupTable1D
    controlAlphaClDeltaA: LookupTable1D
    controlAlphaCyDeltaR: LookupTable1D
    controlAlphaCnDeltaR: LookupTable1D
  }
}

export interface AircraftParams {
  massKg: number
  inertiaKgM2: Vector3
  wingAreaM2: number
  wingSpanM: number
  meanChordM: number
  maxThrustN: number
  controlLimitsRad: {
    aileron: number
    elevator: number
    rudder: number
  }
  angularDampingPerSec: Vector3
  throttleToThrustFraction?: LookupTable1D
  configuration?: {
    flapDetents01: readonly number[]
    flapSurfaceTargets01?: readonly number[]
    defaultFlapDetentIndex?: number
    flapRatePerSec: number
    gearRatePerSec: number
    spoilerRatePerSec: number
    flapLiftClMax: number
    flapDragCdMax: number
    flapPitchCmMax: number
    gearDragCdMax: number
    spoilerDragCdMax: number
    spoilerLiftLossMax: number
    spoilerPitchCmMax: number
    flapVisualSchedule?: FlapVisualSchedule
    flapAutoCommand?: FlapAutoCommandConfig
  }
  aero: AircraftAeroParams
}

export interface AeroTelemetry {
  airspeedMps: number
  alphaRad: number
  betaRad: number
  rhoKgPerM3: number
  liftN: number
  dragN: number
  sideN: number
  thrustN: number
  flaps01: number
  gear01: number
  spoiler01: number
}

const bodyRight = /*#__PURE__*/ new Vector3(0, 1, 0)

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI
}

export function computeForcesAndTorquesBody(
  params: AircraftParams,
  controls: ControlInputs,
  configurationState: AircraftConfigurationState,
  velocityBodyMps: Vector3,
  omegaBodyRadPerSec: Vector3,
  rhoKgPerM3: number,
  outForceBodyN: Vector3,
  outTorqueBodyNm: Vector3
): AeroTelemetry {
  const u = velocityBodyMps.x
  const v = velocityBodyMps.y
  const w = velocityBodyMps.z // +down

  const v2 = u * u + v * v + w * w
  const V = Math.sqrt(v2)
  const speed = Math.max(V, 0.1)

  const alpha = Math.atan2(w, u)
  const beta = Math.asin(Math.max(-1, Math.min(1, v / speed)))
  const alphaDeg = radiansToDegrees(alpha)
  const betaDeg = radiansToDegrees(beta)
  const absAlphaDeg = Math.abs(alphaDeg)
  const flaps01 = Math.max(0, Math.min(1, configurationState.flaps01))
  const gear01 = Math.max(0, Math.min(1, configurationState.gear01))
  const spoiler01 = Math.max(0, Math.min(1, configurationState.spoiler01))

  const qbar = 0.5 * rhoKgPerM3 * v2
  const deltaA = controls.aileron * params.controlLimitsRad.aileron
  const deltaE = controls.elevator * params.controlLimitsRad.elevator
  const deltaR = controls.rudder * params.controlLimitsRad.rudder

  const { aero } = params
  const configuration = params.configuration
  let cl = 0
  let cd = 0
  let cy = 0
  let clRollBeta = 0
  let cmPitchBase = 0
  let cnYawBeta = 0

  if (aero.lookup != null) {
    const clBase = lookup1D(alphaDeg, aero.lookup.alphaCl)
    const cdBase = lookup1D(alphaDeg, aero.lookup.alphaCd)
    const cmBase = lookup1D(alphaDeg, aero.lookup.alphaCm)
    const cyBase = lookup1D(betaDeg, aero.lookup.betaCy)
    const clBeta = lookup1D(betaDeg, aero.lookup.betaCl)
    const cnBeta = lookup1D(betaDeg, aero.lookup.betaCn)

    const clDeltaE = lookup1D(absAlphaDeg, aero.lookup.controlAlphaClDeltaE) * deltaE
    const cmDeltaE = lookup1D(absAlphaDeg, aero.lookup.controlAlphaCmDeltaE) * deltaE
    const clDeltaA = lookup1D(absAlphaDeg, aero.lookup.controlAlphaClDeltaA) * deltaA
    const cyDeltaR = lookup1D(absAlphaDeg, aero.lookup.controlAlphaCyDeltaR) * deltaR
    const cnDeltaR = lookup1D(absAlphaDeg, aero.lookup.controlAlphaCnDeltaR) * deltaR

    cl = clBase + clDeltaE
    cd =
      cdBase +
      aero.inducedDragFactor * cl * cl +
      aero.CDbeta * beta * beta +
      0.012 * Math.abs(deltaA) +
      0.018 * Math.abs(deltaR)
    cy = cyBase + cyDeltaR
    clRollBeta = clBeta + clDeltaA
    cmPitchBase = cmBase + cmDeltaE
    cnYawBeta = cnBeta + cnDeltaR
  } else {
    // Smooth stall: clamp via tanh so CL remains bounded without a hard kink.
    const clLinear = aero.CL0 + aero.CLalphaPerRad * alpha
    const clClamped = aero.CLmax * Math.tanh(clLinear / Math.max(aero.CLmax, 1e-3))

    const absAlpha = Math.abs(alpha)
    const stallStart = aero.alphaStallRad
    const stallEnd = stallStart + Math.max(aero.alphaStallBlendRad, 1e-3)
    const stallT = smoothstep(stallStart, stallEnd, absAlpha)

    // Post-stall: smoothly reduce CL towards 0 at 90° AoA.
    let clStalled = 0
    if (absAlpha > stallStart) {
      const capped = Math.min(absAlpha, Math.PI / 2)
      const s = (capped - stallStart) / (Math.PI / 2 - stallStart)
      clStalled = aero.CLmax * Math.sign(alpha) * Math.cos(s * (Math.PI / 2))
    } else {
      clStalled = clClamped
    }

    cl = clClamped * (1 - stallT) + clStalled * stallT
    cd =
      aero.CD0 +
      aero.inducedDragFactor * cl * cl +
      aero.CDbeta * beta * beta +
      aero.CDStallAdd * stallT
    cy = aero.CYbetaPerRad * beta
    clRollBeta = aero.ClbetaPerRad * beta + aero.Clda * deltaA
    cmPitchBase = aero.Cm0 + aero.CmalphaPerRad * alpha + aero.Cmde * deltaE
    cnYawBeta = aero.Cn0 + aero.CnbetaPerRad * beta + aero.Cndr * deltaR
  }

  if (configuration != null) {
    const flapLiftDelta = configuration.flapLiftClMax * flaps01
    const flapDragDelta =
      configuration.flapDragCdMax * (0.35 * flaps01 + 0.65 * flaps01 * flaps01)
    const gearDragDelta =
      configuration.gearDragCdMax * (0.25 * gear01 + 0.75 * gear01 * gear01)
    const spoilerDragDelta =
      configuration.spoilerDragCdMax *
      (0.2 * spoiler01 + 0.8 * spoiler01 * spoiler01)
    const spoilerLiftFactor = Math.max(
      0.35,
      1 - configuration.spoilerLiftLossMax * spoiler01
    )

    cl = (cl + flapLiftDelta) * spoilerLiftFactor
    cd += flapDragDelta + gearDragDelta + spoilerDragDelta
    cmPitchBase +=
      configuration.flapPitchCmMax * flaps01 +
      configuration.spoilerPitchCmMax * spoiler01
  }

  const lift = qbar * params.wingAreaM2 * cl
  const drag = qbar * params.wingAreaM2 * cd
  const side = qbar * params.wingAreaM2 * cy

  // Force directions in body axes derived from current velocity direction.
  // dragDir: opposite motion; liftDir: perpendicular to velocity in body x-z plane; sideDir completes basis.
  outForceBodyN.set(0, 0, 0)
  if (V > 0.1) {
    const vHatX = u / speed
    const vHatY = v / speed
    const vHatZ = w / speed

    // liftDir = normalize( bodyRight x vHat )
    const liftDirX = bodyRight.y * vHatZ - bodyRight.z * vHatY
    const liftDirY = bodyRight.z * vHatX - bodyRight.x * vHatZ
    const liftDirZ = bodyRight.x * vHatY - bodyRight.y * vHatX
    const liftLen = Math.sqrt(
      liftDirX * liftDirX + liftDirY * liftDirY + liftDirZ * liftDirZ
    )
    const invLiftLen = liftLen > 1e-6 ? 1 / liftLen : 0

    const lX = liftDirX * invLiftLen
    const lY = liftDirY * invLiftLen
    const lZ = liftDirZ * invLiftLen

    // sideDir = normalize( vHat x liftDir )
    const sideDirX = vHatY * lZ - vHatZ * lY
    const sideDirY = vHatZ * lX - vHatX * lZ
    const sideDirZ = vHatX * lY - vHatY * lX

    outForceBodyN.x += -drag * vHatX + lift * lX + side * sideDirX
    outForceBodyN.y += -drag * vHatY + lift * lY + side * sideDirY
    outForceBodyN.z += -drag * vHatZ + lift * lZ + side * sideDirZ
  }

  const throttle01 = Math.max(0, Math.min(1, controls.throttle01))
  const thrustFraction =
    params.throttleToThrustFraction != null
      ? lookup1D(throttle01, params.throttleToThrustFraction)
      : throttle01
  const thrust = params.maxThrustN * Math.max(0, thrustFraction)
  outForceBodyN.x += thrust

  // Moments from coefficients (non-dimensional rates).
  const b = params.wingSpanM
  const c = params.meanChordM
  const pHat = (omegaBodyRadPerSec.x * b) / (2 * speed)
  const qHat = (omegaBodyRadPerSec.y * c) / (2 * speed)
  const rHat = (omegaBodyRadPerSec.z * b) / (2 * speed)

  const clRoll = clRollBeta + aero.Clp * pHat
  const cmPitch = cmPitchBase + aero.Cmq * qHat
  const cnYaw = cnYawBeta + aero.Cnr * rHat

  outTorqueBodyNm.set(
    qbar * params.wingAreaM2 * b * clRoll,
    qbar * params.wingAreaM2 * c * cmPitch,
    qbar * params.wingAreaM2 * b * cnYaw
  )

  return {
    airspeedMps: V,
    alphaRad: alpha,
    betaRad: beta,
    rhoKgPerM3,
    liftN: lift,
    dragN: drag,
    sideN: side,
    thrustN: thrust,
    flaps01,
    gear01,
    spoiler01
  }
}

const baseControlAlphaBreakpointsDeg = [0, 10, 15, 20, 30, 45, 60, 90] as const
const baseBetaBreakpointsDeg = [-30, -20, -10, -5, 0, 5, 10, 20, 30] as const

const defaultLookupTables = {
  alphaCl: {
    breakpoints: [-90, -60, -45, -30, -20, -15, -10, -5, 0, 5, 10, 12, 15, 18, 22, 30, 45, 60, 90],
    values: [-0.08, -0.18, -0.28, -0.52, -0.82, -0.72, -0.52, -0.16, 0.22, 0.72, 1.18, 1.34, 1.46, 1.36, 1.05, 0.62, 0.28, 0.1, 0]
  },
  alphaCd: {
    breakpoints: [-90, -60, -45, -30, -20, -15, -10, -5, 0, 5, 10, 12, 15, 18, 22, 30, 45, 60, 90],
    values: [1.58, 1.08, 0.78, 0.42, 0.12, 0.082, 0.05, 0.032, 0.028, 0.03, 0.035, 0.04, 0.05, 0.068, 0.1, 0.22, 0.72, 1.08, 1.55]
  },
  alphaCm: {
    breakpoints: [-90, -60, -45, -30, -20, -15, -10, -5, 0, 5, 10, 12, 15, 18, 22, 30, 45, 60, 90],
    values: [-0.04, -0.025, -0.015, -0.04, -0.08, -0.065, -0.04, -0.005, 0.02, 0.045, 0.075, 0.09, 0.12, 0.11, 0.08, 0.04, 0.015, 0, -0.02]
  },
  betaCy: {
    breakpoints: baseBetaBreakpointsDeg,
    values: [0.68, 0.45, 0.24, 0.12, 0, -0.12, -0.24, -0.45, -0.68]
  },
  betaCl: {
    breakpoints: baseBetaBreakpointsDeg,
    values: [0.062, 0.041, 0.021, 0.01, 0, -0.01, -0.021, -0.041, -0.062]
  },
  betaCn: {
    breakpoints: baseBetaBreakpointsDeg,
    values: [-0.07, -0.047, -0.024, -0.012, 0, 0.012, 0.024, 0.047, 0.07]
  },
  controlAlphaClDeltaE: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [0.14, 0.13, 0.115, 0.09, 0.055, 0.03, 0.012, 0]
  },
  controlAlphaCmDeltaE: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [-1.1, -1.05, -0.95, -0.75, -0.45, -0.22, -0.08, -0.02]
  },
  controlAlphaClDeltaA: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [0.085, 0.082, 0.075, 0.06, 0.035, 0.018, 0.008, 0.001]
  },
  controlAlphaCyDeltaR: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [0.22, 0.21, 0.19, 0.15, 0.1, 0.05, 0.02, 0]
  },
  controlAlphaCnDeltaR: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [0.095, 0.09, 0.08, 0.06, 0.04, 0.02, 0.008, 0.001]
  }
} satisfies NonNullable<AircraftAeroParams['lookup']>

const b737LookupTables = {
  alphaCl: {
    breakpoints: [-90, -60, -45, -30, -20, -15, -10, -5, 0, 4, 8, 10, 12, 14, 16, 18, 22, 30, 45, 60, 90],
    values: [-0.1, -0.22, -0.34, -0.62, -0.95, -0.82, -0.58, -0.18, 0.28, 0.62, 0.98, 1.18, 1.34, 1.48, 1.56, 1.46, 1.12, 0.72, 0.34, 0.12, 0.02]
  },
  alphaCd: {
    breakpoints: [-90, -60, -45, -30, -20, -15, -10, -5, 0, 4, 8, 10, 12, 14, 16, 18, 22, 30, 45, 60, 90],
    values: [1.82, 1.24, 0.9, 0.54, 0.15, 0.1, 0.055, 0.028, 0.018, 0.019, 0.021, 0.024, 0.028, 0.036, 0.05, 0.07, 0.13, 0.32, 0.82, 1.18, 1.8]
  },
  alphaCm: {
    breakpoints: [-90, -60, -45, -30, -20, -15, -10, -5, 0, 4, 8, 10, 12, 14, 16, 18, 22, 30, 45, 60, 90],
    values: [0.02, 0.01, 0, -0.02, -0.09, -0.07, -0.04, 0.01, 0.04, 0.055, 0.075, 0.09, 0.105, 0.125, 0.145, 0.135, 0.1, 0.06, 0.03, 0, -0.02]
  },
  betaCy: {
    breakpoints: baseBetaBreakpointsDeg,
    values: [0.58, 0.4, 0.22, 0.11, 0, -0.11, -0.22, -0.4, -0.58]
  },
  betaCl: {
    breakpoints: baseBetaBreakpointsDeg,
    values: [0.048, 0.032, 0.015, 0.007, 0, -0.007, -0.015, -0.032, -0.048]
  },
  betaCn: {
    breakpoints: baseBetaBreakpointsDeg,
    values: [-0.055, -0.038, -0.019, -0.009, 0, 0.009, 0.019, 0.038, 0.055]
  },
  controlAlphaClDeltaE: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [0.06, 0.055, 0.05, 0.04, 0.025, 0.015, 0.006, 0]
  },
  controlAlphaCmDeltaE: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [-0.85, -0.8, -0.72, -0.56, -0.34, -0.18, -0.08, -0.02]
  },
  controlAlphaClDeltaA: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [0.04, 0.038, 0.034, 0.026, 0.016, 0.009, 0.004, 0.001]
  },
  controlAlphaCyDeltaR: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [0.16, 0.155, 0.14, 0.11, 0.07, 0.035, 0.015, 0.002]
  },
  controlAlphaCnDeltaR: {
    breakpoints: baseControlAlphaBreakpointsDeg,
    values: [0.065, 0.062, 0.057, 0.045, 0.028, 0.016, 0.006, 0.001]
  }
} satisfies NonNullable<AircraftAeroParams['lookup']>

export function defaultAircraftParams(): AircraftParams {
  return {
    massKg: 1100,
    inertiaKgM2: new Vector3(950, 1350, 1900),
    wingAreaM2: 16.2,
    wingSpanM: 10.9,
    meanChordM: 1.55,
    maxThrustN: 4200,
    controlLimitsRad: {
      aileron: (20 * Math.PI) / 180,
      elevator: (25 * Math.PI) / 180,
      rudder: (25 * Math.PI) / 180
    },
    angularDampingPerSec: new Vector3(0.1, 0.12, 0.1),
    configuration: {
      flapDetents01: [0, 0.33, 0.66, 1],
      flapRatePerSec: 0.2,
      gearRatePerSec: 0.35,
      spoilerRatePerSec: 1.25,
      flapLiftClMax: 0.55,
      flapDragCdMax: 0.12,
      flapPitchCmMax: 0.08,
      gearDragCdMax: 0.035,
      spoilerDragCdMax: 0.12,
      spoilerLiftLossMax: 0.32,
      spoilerPitchCmMax: 0.02
    },
    aero: {
      CL0: 0.22,
      CLalphaPerRad: 5.4,
      CLmax: 1.45,
      alphaStallRad: (15 * Math.PI) / 180,
      alphaStallBlendRad: (10 * Math.PI) / 180,
      CD0: 0.03,
      inducedDragFactor: 0.055,
      CDbeta: 0.06,
      CDStallAdd: 0.35,
      CYbetaPerRad: -0.6,

      ClbetaPerRad: -0.12,
      Clp: -0.5,
      Clda: 0.08,

      Cm0: 0.02,
      CmalphaPerRad: 0.45,
      Cmq: -10.5,
      Cmde: -1.1,

      Cn0: 0,
      CnbetaPerRad: 0.25,
      Cnr: -0.2,
      Cndr: 0.08,
      lookup: defaultLookupTables
    }
  }
}

export function b737AircraftParams(): AircraftParams {
  return {
    massKg: 65_000,
    inertiaKgM2: new Vector3(2.9e6, 6.5e6, 8.8e6),
    wingAreaM2: 124.6,
    wingSpanM: 35.8,
    meanChordM: 3.48,
    maxThrustN: 240_000,
    controlLimitsRad: {
      aileron: (15 * Math.PI) / 180,
      elevator: (18 * Math.PI) / 180,
      rudder: (20 * Math.PI) / 180
    },
    angularDampingPerSec: new Vector3(0.2, 0.25, 0.2),
    configuration: {
      flapDetents01: [0, 0.2, 0.4, 0.65, 0.85, 1],
      flapRatePerSec: 0.12,
      gearRatePerSec: 0.28,
      spoilerRatePerSec: 1.5,
      flapLiftClMax: 0.9,
      flapDragCdMax: 0.18,
      flapPitchCmMax: 0.1,
      gearDragCdMax: 0.04,
      spoilerDragCdMax: 0.14,
      spoilerLiftLossMax: 0.36,
      spoilerPitchCmMax: 0.025
    },
    aero: {
      CL0: 0.25,
      CLalphaPerRad: 5.2,
      CLmax: 1.6,
      alphaStallRad: (16 * Math.PI) / 180,
      alphaStallBlendRad: (8 * Math.PI) / 180,
      CD0: 0.02,
      inducedDragFactor: 0.04,
      CDbeta: 0.04,
      CDStallAdd: 0.7,
      CYbetaPerRad: -0.75,

      ClbetaPerRad: -0.08,
      Clp: -0.5,
      Clda: 0.03,

      Cm0: 0.04,
      CmalphaPerRad: 0.5,
      Cmq: -8.5,
      Cmde: -0.7,

      Cn0: 0,
      CnbetaPerRad: 0.2,
      Cnr: -0.25,
      Cndr: 0.05,
      lookup: b737LookupTables
    }
  }
}
