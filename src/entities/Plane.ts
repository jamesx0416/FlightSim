import { airDensityKgPerM3AtAltitudeMeters } from '../sim/Atmosphere'
import { computeForcesAndTorquesBody, type AeroTelemetry } from '../sim/FlightModel'
import type { AircraftParams, ControlInputs } from '../sim/FlightModel'
import { NedFrame } from '../sim/NedFrame'
import {
  BoxGeometry,
  Group,
  Mesh,
  Object3D,
  Quaternion,
  Vector3
} from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'

const G0 = 9.80665

const forceBodyScratch = /*#__PURE__*/ new Vector3()
const torqueBodyScratch = /*#__PURE__*/ new Vector3()
const forceNedScratch = /*#__PURE__*/ new Vector3()
const forceEcefScratch = /*#__PURE__*/ new Vector3()
const weightEcefScratch = /*#__PURE__*/ new Vector3()
const accelEcefScratch = /*#__PURE__*/ new Vector3()
const vNedScratch = /*#__PURE__*/ new Vector3()
const vBodyScratch = /*#__PURE__*/ new Vector3()
const qBodyToNedScratch = /*#__PURE__*/ new Quaternion()
const qNedToBodyScratch = /*#__PURE__*/ new Quaternion()
const omegaQuatScratch = /*#__PURE__*/ new Quaternion()
const qDotScratch = /*#__PURE__*/ new Quaternion()
const iOmegaScratch = /*#__PURE__*/ new Vector3()
const omegaCrossIOmegaScratch = /*#__PURE__*/ new Vector3()
const upScratch = /*#__PURE__*/ new Vector3()

export interface PlaneStepResult extends AeroTelemetry {
  altitudeMeters: number
}

export class Plane {
  readonly mesh: Group

  readonly positionECEF = new Vector3()
  readonly velocityECEF = new Vector3()
  readonly orientationBodyToECEF = new Quaternion()
  readonly omegaBodyRadPerSec = new Vector3()

  private readonly frame = new NedFrame()
  private readonly controls: ControlInputs = {
    throttle01: 0,
    aileron: 0,
    elevator: 0,
    rudder: 0
  }

  constructor(readonly params: AircraftParams) {
    this.mesh = createDebugPlaneMesh()
  }

  setVisual(object: Object3D): void {
    this.mesh.clear()
    this.mesh.add(object)
  }

  setControls(next: Partial<ControlInputs>): void {
    if (next.throttle01 != null) this.controls.throttle01 = next.throttle01
    if (next.aileron != null) this.controls.aileron = next.aileron
    if (next.elevator != null) this.controls.elevator = next.elevator
    if (next.rudder != null) this.controls.rudder = next.rudder
  }

  resetTo(
    positionEcef: Vector3,
    velocityEcef: Vector3,
    orientationBodyToEcef: Quaternion
  ): void {
    this.positionECEF.copy(positionEcef)
    this.velocityECEF.copy(velocityEcef)
    this.orientationBodyToECEF.copy(orientationBodyToEcef).normalize()
    this.omegaBodyRadPerSec.set(0, 0, 0)
  }

  step(dtSeconds: number): PlaneStepResult {
    this.frame.updateFromECEF(this.positionECEF)
    const rho = airDensityKgPerM3AtAltitudeMeters(this.frame.altitudeMeters)

    vNedScratch.copy(this.velocityECEF).applyMatrix3(this.frame.ecefToNed)

    qBodyToNedScratch
      .multiplyQuaternions(this.frame.qEcefToNed, this.orientationBodyToECEF)
      .normalize()
    qNedToBodyScratch.copy(qBodyToNedScratch).invert()

    vBodyScratch.copy(vNedScratch).applyQuaternion(qNedToBodyScratch)

    const telemetry = computeForcesAndTorquesBody(
      this.params,
      this.controls,
      vBodyScratch,
      this.omegaBodyRadPerSec,
      rho,
      forceBodyScratch,
      torqueBodyScratch
    )

    // Body -> NED -> ECEF
    forceNedScratch.copy(forceBodyScratch).applyQuaternion(qBodyToNedScratch)
    forceEcefScratch.copy(forceNedScratch).applyMatrix3(this.frame.nedToEcef)

    weightEcefScratch.copy(this.frame.down).multiplyScalar(this.params.massKg * G0)
    forceEcefScratch.add(weightEcefScratch)

    accelEcefScratch.copy(forceEcefScratch).multiplyScalar(1 / this.params.massKg)
    this.velocityECEF.addScaledVector(accelEcefScratch, dtSeconds)
    this.positionECEF.addScaledVector(this.velocityECEF, dtSeconds)

    this.integrateRotation(dtSeconds, torqueBodyScratch)

    this.resolveGroundContact(2)

    this.mesh.position.copy(this.positionECEF)
    this.mesh.quaternion.copy(this.orientationBodyToECEF)

    return { ...telemetry, altitudeMeters: this.frame.altitudeMeters }
  }

  private integrateRotation(dtSeconds: number, torqueBodyNm: Vector3): void {
    const inertia = this.params.inertiaKgM2
    const damping = this.params.angularDampingPerSec

    // omegaDot = I^-1 * (tau - omega x (I * omega))
    iOmegaScratch.set(
      inertia.x * this.omegaBodyRadPerSec.x,
      inertia.y * this.omegaBodyRadPerSec.y,
      inertia.z * this.omegaBodyRadPerSec.z
    )
    omegaCrossIOmegaScratch.crossVectors(this.omegaBodyRadPerSec, iOmegaScratch)

    this.omegaBodyRadPerSec.x +=
      ((torqueBodyNm.x - omegaCrossIOmegaScratch.x) / inertia.x) * dtSeconds
    this.omegaBodyRadPerSec.y +=
      ((torqueBodyNm.y - omegaCrossIOmegaScratch.y) / inertia.y) * dtSeconds
    this.omegaBodyRadPerSec.z +=
      ((torqueBodyNm.z - omegaCrossIOmegaScratch.z) / inertia.z) * dtSeconds

    const dampFactorX = Math.max(0, 1 - damping.x * dtSeconds)
    const dampFactorY = Math.max(0, 1 - damping.y * dtSeconds)
    const dampFactorZ = Math.max(0, 1 - damping.z * dtSeconds)
    this.omegaBodyRadPerSec.x *= dampFactorX
    this.omegaBodyRadPerSec.y *= dampFactorY
    this.omegaBodyRadPerSec.z *= dampFactorZ

    // qDot = 0.5 * q * [omega, 0]   (omega in body frame)
    omegaQuatScratch.set(
      this.omegaBodyRadPerSec.x,
      this.omegaBodyRadPerSec.y,
      this.omegaBodyRadPerSec.z,
      0
    )
    qDotScratch.multiplyQuaternions(this.orientationBodyToECEF, omegaQuatScratch)

    const k = 0.5 * dtSeconds
    this.orientationBodyToECEF.x += qDotScratch.x * k
    this.orientationBodyToECEF.y += qDotScratch.y * k
    this.orientationBodyToECEF.z += qDotScratch.z * k
    this.orientationBodyToECEF.w += qDotScratch.w * k
    this.orientationBodyToECEF.normalize()
  }

  private resolveGroundContact(minAltitudeMeters: number): void {
    this.frame.updateFromECEF(this.positionECEF)
    if (this.frame.altitudeMeters >= minAltitudeMeters) return

    const penetration = minAltitudeMeters - this.frame.altitudeMeters
    upScratch.copy(this.frame.down).multiplyScalar(-1)
    this.positionECEF.addScaledVector(upScratch, penetration)

    // Remove velocity into the ground.
    const vDown = this.velocityECEF.dot(this.frame.down)
    if (vDown > 0) {
      this.velocityECEF.addScaledVector(this.frame.down, -vDown)
      this.velocityECEF.multiplyScalar(0.98)
      this.omegaBodyRadPerSec.multiplyScalar(0.9)
    }
  }
}

function createDebugPlaneMesh(): Group {
  const material = new MeshBasicNodeMaterial()

  const group = new Group()

  const fuselage = new Mesh(new BoxGeometry(8, 1.1, 1.1), material)
  fuselage.position.set(0, 0, 0)
  group.add(fuselage)

  const wing = new Mesh(new BoxGeometry(1.6, 10.5, 0.25), material)
  wing.position.set(0.2, 0, 0)
  group.add(wing)

  const tail = new Mesh(new BoxGeometry(1.2, 3.2, 0.18), material)
  tail.position.set(-3.2, 0, 0.05)
  group.add(tail)

  // Vertical stabilizer (z is down; so "up" is negative z).
  const fin = new Mesh(new BoxGeometry(0.9, 0.2, 1.2), material)
  fin.position.set(-3.4, 0, -0.6)
  group.add(fin)

  return group
}
