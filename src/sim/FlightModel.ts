import { Vector3 } from 'three'

export interface ControlInputs {
  throttle01: number
  aileron: number
  elevator: number
  rudder: number
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
}

const bodyRight = /*#__PURE__*/ new Vector3(0, 1, 0)

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export function computeForcesAndTorquesBody(
  params: AircraftParams,
  controls: ControlInputs,
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

  const qbar = 0.5 * rhoKgPerM3 * v2

  // Smooth stall: clamp via tanh so CL remains bounded without a hard kink.
  const { aero } = params
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

  const cl = clClamped * (1 - stallT) + clStalled * stallT
  const cdBase =
    aero.CD0 +
    aero.inducedDragFactor * cl * cl +
    aero.CDbeta * beta * beta
  const cd = cdBase + aero.CDStallAdd * stallT
  const cy = aero.CYbetaPerRad * beta

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

  const thrust = params.maxThrustN * Math.max(0, Math.min(1, controls.throttle01))
  outForceBodyN.x += thrust

  // Moments from coefficients (non-dimensional rates).
  const b = params.wingSpanM
  const c = params.meanChordM
  const pHat = (omegaBodyRadPerSec.x * b) / (2 * speed)
  const qHat = (omegaBodyRadPerSec.y * c) / (2 * speed)
  const rHat = (omegaBodyRadPerSec.z * b) / (2 * speed)

  const deltaA = controls.aileron * params.controlLimitsRad.aileron
  const deltaE = controls.elevator * params.controlLimitsRad.elevator
  const deltaR = controls.rudder * params.controlLimitsRad.rudder

  const clRoll =
    aero.ClbetaPerRad * beta + aero.Clp * pHat + aero.Clda * deltaA
  const cmPitch =
    aero.Cm0 +
    aero.CmalphaPerRad * alpha +
    aero.Cmq * qHat +
    aero.Cmde * deltaE
  const cnYaw =
    aero.Cn0 +
    aero.CnbetaPerRad * beta +
    aero.Cnr * rHat +
    aero.Cndr * deltaR

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
    thrustN: thrust
  }
}

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
      Cndr: 0.08
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
      Cndr: 0.05
    }
  }
}
