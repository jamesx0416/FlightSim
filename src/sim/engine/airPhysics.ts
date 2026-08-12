import { Euler, Quaternion, Vector3 } from 'three'

import { standardAtmosphereAtAltitudeMeters } from '../Atmosphere'
import { AirPhysicsStateKeys } from './airState'
import { lookup1D } from '../LookupTable'
import type {
  CanonicalAirPhysicsSystemConfig,
  CanonicalPropulsionEngineConfig,
  CanonicalPropulsionSystemConfig,
} from './aircraft'
import { ControlStateKeys, readControlRatio, readControlSignedRatio } from './controls'
import { EnvironmentStateKeys } from './environment'
import { computeJetThrustN } from './jetEngine'
import { PropulsionStateKeys, readPropulsionNumber } from './propulsion'
import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimUnit } from './units'
import type {
  SimSubsystem,
  SimSubsystemContext,
  SimSubsystemTickContext,
} from './subsystem'

const G0 = 9.80665
const FIXED_STEP_SECONDS = 1 / 120
const MAX_TICK_SECONDS = 0.1
const DEFAULT_BLADE_ELEMENTS = 24

export const AIR_PHYSICS_SUBSYSTEM_ID = 'air-physics'

export const AirPhysicsCommandTypes = {
  setEnabled: 'physics.air.setEnabled',
  reset: 'physics.air.reset',
  setMass: 'physics.air.setMass',
} as const
export interface AirPhysicsResetPayload {
  readonly altitudeMeters?: number
  readonly northMeters?: number
  readonly eastMeters?: number
  readonly airspeedMps?: number
  readonly headingRad?: number
  readonly flightPathAngleRad?: number
  readonly rollRad?: number
  readonly pitchRad?: number
  readonly yawRad?: number
  readonly massKg?: number
  readonly velocityNedMps?: readonly [number, number, number]
  readonly angularVelocityBodyRadPerSec?: readonly [number, number, number]
  readonly enabled?: boolean
}

interface WingElement {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly areaM2: number
  readonly spanWidthM: number
  readonly spanStartBodyM: readonly [number, number, number]
  readonly spanEndBodyM: readonly [number, number, number]
  readonly twistRad: number
  readonly flapCoefficientScale: number
  readonly aileronAreaFraction: number
}

interface ForceTelemetry {
  airspeedMps: number
  mach: number
  alphaRad: number
  betaRad: number
  dynamicPressurePa: number
  liftN: number
  dragN: number
  sideN: number
  thrustN: number
}
export class AirPhysicsSubsystem implements SimSubsystem {
  readonly id = AIR_PHYSICS_SUBSYSTEM_ID
  readonly phase = 'physics' as const

  private readonly positionNedM = new Vector3()
  private readonly velocityNedMps = new Vector3()
  private readonly orientationBodyToNed = new Quaternion()
  private readonly omegaBodyRadPerSec = new Vector3()
  private readonly wingElements: readonly WingElement[]
  private readonly engineThrustN: number[]
  private readonly forceBodyN = new Vector3()
  private readonly torqueBodyNm = new Vector3()
  private readonly forceNedN = new Vector3()
  private readonly airVelocityNedMps = new Vector3()
  private readonly airVelocityBodyMps = new Vector3()
  private readonly wingInducedAirVelocityBodyMps = new Vector3()
  private readonly windNedMps = new Vector3()
  private readonly qNedToBody = new Quaternion()
  private readonly omegaQuaternion = new Quaternion()
  private readonly qDot = new Quaternion()
  private readonly euler = new Euler(0, 0, 0, 'ZYX')
  private accumulatorSeconds = 0
  private telemetry: ForceTelemetry = emptyTelemetry()

  constructor(
    private readonly definition: CanonicalAirPhysicsSystemConfig,
    private readonly propulsion: CanonicalPropulsionSystemConfig = {}
  ) {
    this.wingElements = buildWingElements(definition)
    this.engineThrustN = (propulsion.engines ?? []).map(() => 0)
  }
  initialize(context: SimSubsystemContext): void {
    defineNumber(context.state, AirPhysicsStateKeys.massKg(), 'kilograms', this.definition.emptyMassKg)
    defineBoolean(context.state, AirPhysicsStateKeys.enabled(), false)
    defineNumber(context.state, AirPhysicsStateKeys.resetRevision(), 'number', 0)
    for (const [key, unit] of [
      [AirPhysicsStateKeys.northMeters(), 'meters'],
      [AirPhysicsStateKeys.eastMeters(), 'meters'],
      [AirPhysicsStateKeys.altitudeMeters(), 'meters'],
      [AirPhysicsStateKeys.velocityNorthMps(), 'metersPerSecond'],
      [AirPhysicsStateKeys.velocityEastMps(), 'metersPerSecond'],
      [AirPhysicsStateKeys.velocityDownMps(), 'metersPerSecond'],
      [AirPhysicsStateKeys.rollRad(), 'radians'],
      [AirPhysicsStateKeys.pitchRad(), 'radians'],
      [AirPhysicsStateKeys.yawRad(), 'radians'],
      [AirPhysicsStateKeys.quaternionX(), 'number'],
      [AirPhysicsStateKeys.quaternionY(), 'number'],
      [AirPhysicsStateKeys.quaternionZ(), 'number'],
      [AirPhysicsStateKeys.quaternionW(), 'number'],
      [AirPhysicsStateKeys.rollRateRadPerSecond(), 'radiansPerSecond'],
      [AirPhysicsStateKeys.pitchRateRadPerSecond(), 'radiansPerSecond'],
      [AirPhysicsStateKeys.yawRateRadPerSecond(), 'radiansPerSecond'],
    ] as const) {
      defineNumber(context.state, key, unit, 0)
    }
    this.publishState(context.state)
  }

  tick(context: SimSubsystemTickContext): void {
    if (!context.state.readBoolean(AirPhysicsStateKeys.enabled(), { fallback: false })) return
    const dt = Math.min(Math.max(context.dtSeconds, 0), MAX_TICK_SECONDS)
    if (dt <= 0) return
    this.accumulatorSeconds += dt
    let steps = 0
    while (this.accumulatorSeconds >= FIXED_STEP_SECONDS && steps < 12) {
      this.integrate(FIXED_STEP_SECONDS, context.state)
      this.accumulatorSeconds -= FIXED_STEP_SECONDS
      steps += 1
    }
    if (steps === 12 && this.accumulatorSeconds >= FIXED_STEP_SECONDS) {
      this.accumulatorSeconds %= FIXED_STEP_SECONDS
    }
    this.publishState(context.state)
  }

  handleCommand(command: SimCommand, context: SimSubsystemContext): boolean {
    switch (command.type) {
      case AirPhysicsCommandTypes.setEnabled: {
        const payload = command.payload as { readonly enabled?: boolean }
        context.state.set(AirPhysicsStateKeys.enabled(), payload.enabled ?? true, {
          source: 'runtime',
          unit: 'boolean',
        })
        return true
      }
      case AirPhysicsCommandTypes.setMass: {
        const payload = command.payload as { readonly kilograms?: number; readonly value?: number }
        this.setMass(context.state, payload.kilograms ?? payload.value ?? this.definition.emptyMassKg)
        return true
      }
      case AirPhysicsCommandTypes.reset:
        this.reset(context.state, command.payload as AirPhysicsResetPayload)
        return true
      default:
        return false
    }
  }
  private reset(state: SimStateStore, payload: AirPhysicsResetPayload): void {
    const altitudeMeters = payload.altitudeMeters ?? 0
    const headingRad = payload.headingRad ?? payload.yawRad ?? 0
    const flightPathAngleRad = payload.flightPathAngleRad ?? 0
    const airspeedMps = Math.max(0, payload.airspeedMps ?? 0)
    this.positionNedM.set(
      payload.northMeters ?? 0,
      payload.eastMeters ?? 0,
      -altitudeMeters
    )
    if (payload.velocityNedMps != null) {
      this.velocityNedMps.fromArray(payload.velocityNedMps)
    } else {
      const horizontalSpeed = airspeedMps * Math.cos(flightPathAngleRad)
      this.velocityNedMps.set(
        horizontalSpeed * Math.cos(headingRad),
        horizontalSpeed * Math.sin(headingRad),
        -airspeedMps * Math.sin(flightPathAngleRad)
      )
    }
    this.euler.set(
      payload.rollRad ?? 0,
      payload.pitchRad ?? flightPathAngleRad,
      payload.yawRad ?? headingRad,
      'ZYX'
    )
    this.orientationBodyToNed.setFromEuler(this.euler).normalize()
    const omega = payload.angularVelocityBodyRadPerSec ?? [0, 0, 0]
    this.omegaBodyRadPerSec.fromArray(omega)
    this.accumulatorSeconds = 0
    if (payload.massKg != null) this.setMass(state, payload.massKg)
    if (payload.enabled != null) {
      state.set(AirPhysicsStateKeys.enabled(), payload.enabled, {
        source: 'runtime',
        unit: 'boolean',
      })
    }
    this.telemetry = emptyTelemetry()
    const resetRevision = state.readNumber(AirPhysicsStateKeys.resetRevision(), { fallback: 0 }) ?? 0
    state.set(AirPhysicsStateKeys.resetRevision(), resetRevision + 1, { source: 'subsystem', unit: 'number' })
    this.publishState(state)
  }

  private setMass(state: SimStateStore, massKg: number): void {
    const next = Math.max(1, Math.min(
      Number.isFinite(massKg) ? massKg : this.definition.emptyMassKg,
      this.definition.maxGrossMassKg
    ))
    state.set(AirPhysicsStateKeys.massKg(), next, {
      source: 'runtime',
      unit: 'kilograms',
    })
  }

  private integrate(dtSeconds: number, state: SimStateStore): void {
    const altitudeMeters = -this.positionNedM.z
    const atmosphere = standardAtmosphereAtAltitudeMeters(altitudeMeters, {
      temperatureOffsetCelsius: state.readNumber(EnvironmentStateKeys.temperatureOffsetCelsius(), { fallback: 0 }) ?? 0,
      seaLevelPressurePa: state.readNumber(EnvironmentStateKeys.seaLevelPressurePa(), { fallback: 101_325 }) ?? 101_325,
    })
    this.windNedMps.set(
      state.readNumber(EnvironmentStateKeys.windNorthMps(), { fallback: 0 }) ?? 0,
      state.readNumber(EnvironmentStateKeys.windEastMps(), { fallback: 0 }) ?? 0,
      state.readNumber(EnvironmentStateKeys.windDownMps(), { fallback: 0 }) ?? 0
    )
    this.airVelocityNedMps.copy(this.velocityNedMps).sub(this.windNedMps)
    this.qNedToBody.copy(this.orientationBodyToNed).invert()
    this.airVelocityBodyMps.copy(this.airVelocityNedMps).applyQuaternion(this.qNedToBody)

    this.telemetry = this.computeForces(state, atmosphere)
    this.forceNedN.copy(this.forceBodyN).applyQuaternion(this.orientationBodyToNed)
    const massKg = Math.max(1, state.readNumber(AirPhysicsStateKeys.massKg(), {
      unit: 'kilograms',
      fallback: this.definition.emptyMassKg,
    }) ?? this.definition.emptyMassKg)
    this.velocityNedMps.addScaledVector(this.forceNedN, dtSeconds / massKg)
    this.velocityNedMps.z += G0 * dtSeconds
    this.positionNedM.addScaledVector(this.velocityNedMps, dtSeconds)
    this.integrateRotation(dtSeconds)
    this.consumeFuelMass(state, massKg, dtSeconds)

    setSubsystemNumber(state, AirPhysicsStateKeys.temperatureK(), atmosphere.temperatureK, 'kelvin')
    setSubsystemNumber(state, AirPhysicsStateKeys.pressurePa(), atmosphere.pressurePa, 'pascals')
    setSubsystemNumber(state, AirPhysicsStateKeys.densityKgPerM3(), atmosphere.densityKgPerM3, 'kilogramsPerCubicMeter')
    setSubsystemNumber(state, AirPhysicsStateKeys.speedOfSoundMps(), atmosphere.speedOfSoundMps, 'metersPerSecond')
  }
  private consumeFuelMass(
    state: SimStateStore,
    massKg: number,
    dtSeconds: number
  ): void {
    let fuelFlowKgPerSecond = 0
    for (const engine of this.propulsion.engines ?? []) {
      fuelFlowKgPerSecond += Math.max(0, readPropulsionNumber(
        state,
        PropulsionStateKeys.engineFuelFlowKgPerSecond(engine.index)
      ))
    }
    if (fuelFlowKgPerSecond <= 0) return

    // ponytail: total mass only; tank-specific CG/inertia belongs with full fuel routing.
    this.setMass(state, Math.max(
      this.definition.emptyMassKg,
      massKg - fuelFlowKgPerSecond * dtSeconds
    ))
  }

  private computeForces(
    state: SimStateStore,
    atmosphere: {
      readonly temperatureK: number
      readonly pressurePa: number
      readonly densityKgPerM3: number
      readonly speedOfSoundMps: number
    }
  ): ForceTelemetry {
    const { densityKgPerM3, speedOfSoundMps } = atmosphere
    this.forceBodyN.set(0, 0, 0)
    this.torqueBodyNm.set(0, 0, 0)
    const velocity = this.airVelocityBodyMps
    const airspeedMps = velocity.length()
    const speed = Math.max(airspeedMps, 0.1)
    const alphaRad = Math.atan2(velocity.z, velocity.x)
    const betaRad = Math.asin(clamp(velocity.y / speed, -1, 1))
    const mach = airspeedMps / Math.max(speedOfSoundMps, 1)
    const dynamicPressurePa = 0.5 * densityKgPerM3 * airspeedMps * airspeedMps
    const flaps = readControlRatio(state, ControlStateKeys.flapsPositionRatio())
    const gear = readControlRatio(state, ControlStateKeys.gearPositionRatio())
    const spoilers = readControlRatio(state, ControlStateKeys.spoilersPositionRatio())
    const aileron = readControlSignedRatio(state, ControlStateKeys.aileronPositionRatio())
    const elevator = readControlSignedRatio(state, ControlStateKeys.elevatorPositionRatio())
    const rudder = readControlSignedRatio(state, ControlStateKeys.rudderPositionRatio())
    const elevatorTrim = state.readBoolean(ControlStateKeys.elevatorTrimDisabled(), { fallback: false })
      ? 0
      : readControlSignedRatio(state, ControlStateKeys.elevatorTrimRatio())
    const rudderTrim = state.readBoolean(ControlStateKeys.rudderTrimDisabled(), { fallback: false })
      ? 0
      : readControlSignedRatio(state, ControlStateKeys.rudderTrimRatio())

    const geometry = this.definition.geometry
    const aero = this.definition.aerodynamics
    const controls = this.definition.controls
    const baselineDownwashAngleRad = computeWingDownwashAngleRad(
      this.definition,
      alphaRad,
      flaps,
      spoilers
    )
    const horizontalTailBaseline = this.computeHorizontalTailBaseline(
      densityKgPerM3,
      alphaRad,
      baselineDownwashAngleRad
    )
    const wingLiftOffset = dynamicPressurePa > 1e-9
      ? horizontalTailBaseline.liftN / (dynamicPressurePa * Math.max(geometry.wingAreaM2, 0.01))
      : 0
    const wingDragOffset = dynamicPressurePa > 1e-9
      ? horizontalTailBaseline.dragN / (dynamicPressurePa * Math.max(geometry.wingAreaM2, 0.01))
      : 0

    let liftN = 0
    let dragN = 0
    this.wingInducedAirVelocityBodyMps.set(0, 0, 0)
    const horizontalTailPosition = geometry.horizontalTailPositionBodyM
    for (const element of this.wingElements) {
      const forces = this.computeWingElement(
        element,
        densityKgPerM3,
        mach,
        flaps,
        gear,
        spoilers,
        aileron,
        wingLiftOffset,
        wingDragOffset
      )
      liftN += forces.liftN
      dragN += forces.dragN
      if (horizontalTailPosition != null && forces.circulationM2PerSecond !== 0) {
        addHorseshoeInducedVelocity(
          this.wingInducedAirVelocityBodyMps,
          horizontalTailPosition,
          element,
          forces.circulationM2PerSecond,
          forces.wakeDirectionBody
        )
      }
    }

    const horizontalTail = this.computeHorizontalTail(
      densityKgPerM3,
      elevator,
      elevatorTrim,
      this.wingInducedAirVelocityBodyMps
    )
    liftN += horizontalTail.liftN
    dragN += horizontalTail.dragN
    const verticalTail = this.computeVerticalTail(densityKgPerM3, rudder, rudderTrim)
    dragN += verticalTail.dragN

    const span = geometry.wingSpanM
    const chord = geometry.meanChordM
    const pHat = (this.omegaBodyRadPerSec.x * span) / (2 * speed)
    const qHat = (this.omegaBodyRadPerSec.y * chord) / (2 * speed)
    const rHat = (this.omegaBodyRadPerSec.z * span) / (2 * speed)
    const deltaA = aileron * controls.aileronLimitRad * controls.aileronEffectiveness
    const deltaE = elevator * controls.elevatorLimitRad * controls.elevatorEffectiveness
    const deltaR = rudder * controls.rudderLimitRad * controls.rudderEffectiveness
    const legacySideN = dynamicPressurePa * geometry.wingAreaM2 * (
      aero.sideForceSlipAngleCoefficient * betaRad +
      aero.sideForceRudderCoefficient * deltaR
    )
    this.forceBodyN.y += legacySideN
    const fuselageSideN = this.computeFuselageSideForce(densityKgPerM3)
    const sideN = verticalTail.sideN + legacySideN + fuselageSideN

    const rollCoefficient =
      aero.rollSlipAngleCoefficient * betaRad +
      aero.rollDampingCoefficient * pHat +
      aero.rollAileronCoefficient * deltaA
    const pitchAlpha = aero.pitchMomentByAlphaRad == null
      ? aero.pitchMomentAlphaCoefficient * alphaRad
      : lookup1D(alphaRad, aero.pitchMomentByAlphaRad)
    const pitchCoefficient =
      aero.pitchMomentZero + pitchAlpha +
      aero.pitchDampingCoefficient * qHat +
      aero.pitchElevatorCoefficient * deltaE +
      aero.pitchFlapCoefficient * flaps +
      aero.pitchGearCoefficient * gear +
      aero.pitchSpoilerCoefficient * spoilers
    const yawCoefficient =
      aero.yawSlipAngleCoefficient * betaRad +
      aero.yawDampingCoefficient * rHat +
      aero.yawRudderCoefficient * deltaR
    this.torqueBodyNm.x += dynamicPressurePa * geometry.wingAreaM2 * span * rollCoefficient
    this.torqueBodyNm.y += dynamicPressurePa * geometry.wingAreaM2 * chord * pitchCoefficient
    this.torqueBodyNm.z += dynamicPressurePa * geometry.wingAreaM2 * span * yawCoefficient

    let thrustN = 0
    const engines = this.propulsion.engines ?? []
    for (let offset = 0; offset < engines.length; offset += 1) {
      const engine = engines[offset]
      const n1Percent = readPropulsionNumber(
        state,
        PropulsionStateKeys.engineN1Percent(engine.index)
      )
      const engineThrust = computeJetThrustN(engine, n1Percent, {
        temperatureK: atmosphere.temperatureK,
        pressurePa: atmosphere.pressurePa,
        mach,
        trueAirspeedMps: airspeedMps,
      })
      this.engineThrustN[offset] = engineThrust
      thrustN += engineThrust
      applyEngineThrust(this.forceBodyN, this.torqueBodyNm, engine, engineThrust)
    }

    return {
      airspeedMps,
      mach,
      alphaRad,
      betaRad,
      dynamicPressurePa,
      liftN,
      dragN,
      sideN,
      thrustN,
    }
  }
  private computeWingElement(
    element: WingElement,
    densityKgPerM3: number,
    mach: number,
    flaps: number,
    gear: number,
    spoilers: number,
    aileron: number,
    wingLiftOffset: number,
    wingDragOffset: number
  ): {
    readonly liftN: number
    readonly dragN: number
    readonly circulationM2PerSecond: number
    readonly wakeDirectionBody: readonly [number, number, number]
  } {
    const omega = this.omegaBodyRadPerSec
    const velocity = this.airVelocityBodyMps
    const u = velocity.x + omega.y * element.z - omega.z * element.y
    const v = velocity.y + omega.z * element.x - omega.x * element.z
    const w = velocity.z + omega.x * element.y - omega.y * element.x
    const speedSquared = u * u + v * v + w * w
    if (speedSquared <= 0.01) {
      return {
        liftN: 0,
        dragN: 0,
        circulationM2PerSecond: 0,
        wakeDirectionBody: [0, 0, 0],
      }
    }
    const speed = Math.sqrt(speedSquared)
    const alphaRad =
      Math.atan2(w, u) + this.definition.geometry.wingIncidenceRad + element.twistRad
    const aero = this.definition.aerodynamics
    const baseLiftCoefficient = lookup1D(alphaRad, aero.liftCoefficientByAlphaRad)
    const flapLift = aero.flapLiftCoefficient * flaps * element.flapCoefficientScale
    const aileronDeflection =
      aileron *
      this.definition.controls.aileronLimitRad *
      this.definition.controls.aileronEffectiveness
    const aileronSign = element.y < 0 ? 1 : -1
    const aileronLift =
      liftCurveSlopeAt(aero.liftCoefficientByAlphaRad, alphaRad) *
      aileronDeflection *
      element.aileronAreaFraction *
      aileronSign
    const liftCoefficient =
      baseLiftCoefficient * aero.liftScalar -
      wingLiftOffset +
      flapLift +
      aileronLift +
      aero.spoilerLiftCoefficient * spoilers
    const aspectRatio =
      (this.definition.geometry.wingSpanM * this.definition.geometry.wingSpanM) /
      Math.max(this.definition.geometry.wingAreaM2, 0.01)
    const inducedDrag =
      aero.inducedDragScalar * liftCoefficient * liftCoefficient /
      Math.max(Math.PI * aspectRatio * this.definition.geometry.oswaldEfficiency, 0.01)
    const machDrag = aero.machDragCoefficientAdd == null
      ? 0
      : lookup1D(mach, aero.machDragCoefficientAdd)
    const dragCoefficient = Math.max(
      0,
      aero.zeroLiftDragCoefficient * aero.parasiteDragScalar +
      machDrag +
      inducedDrag * (1 + (aero.flapInducedDragScalar - 1) * flaps) +
      aero.flapDragCoefficient * flaps * element.flapCoefficientScale +
      aero.gearDragCoefficient * gear +
      aero.spoilerDragCoefficient * spoilers -
      wingDragOffset
    )
    const dynamicPressure = 0.5 * densityKgPerM3 * speedSquared
    const liftN = dynamicPressure * element.areaM2 * liftCoefficient
    const dragN = dynamicPressure * element.areaM2 * dragCoefficient
    this.applyElementForce(element, u, v, w, speed, liftN, dragN)
    return {
      liftN,
      dragN,
      circulationM2PerSecond: densityKgPerM3 > 1e-9
        ? liftN / (densityKgPerM3 * speed * element.spanWidthM)
        : 0,
      wakeDirectionBody: [-u / speed, -v / speed, -w / speed],
    }
  }
  private computeHorizontalTailBaseline(
    densityKgPerM3: number,
    alphaRad: number,
    downwashAngleRad: number
  ): { readonly liftN: number; readonly dragN: number } {
    const geometry = this.definition.geometry
    const area = (geometry.horizontalTailAreaM2 ?? 0) + (geometry.elevatorAreaM2 ?? 0)
    if (area <= 0) return { liftN: 0, dragN: 0 }
    const dynamicPressure = 0.5 * densityKgPerM3 * this.airVelocityBodyMps.lengthSq()
    const coefficient = this.tailLiftCoefficient(
      alphaRad + (geometry.horizontalTailIncidenceRad ?? 0) - downwashAngleRad,
      this.definition.controls.elevatorLiftCoefficientSlopePerRad ?? 5
    )
    return {
      liftN: dynamicPressure * area * coefficient,
      dragN: dynamicPressure * area * inducedSurfaceDragCoefficient(
        coefficient,
        geometry.horizontalTailSpanM ?? 0,
        area,
        geometry.oswaldEfficiency
      ),
    }
  }

  private computeHorizontalTail(
    densityKgPerM3: number,
    elevator: number,
    elevatorTrim: number,
    inducedAirVelocityBodyMps: Vector3
  ): { readonly liftN: number; readonly dragN: number } {
    const geometry = this.definition.geometry
    const stabilizerArea = geometry.horizontalTailAreaM2 ?? 0
    const elevatorArea = geometry.elevatorAreaM2 ?? 0
    const area = stabilizerArea + elevatorArea
    const position = geometry.horizontalTailPositionBodyM
    if (area <= 0 || position == null) return { liftN: 0, dragN: 0 }

    const pointVelocity = localVelocityAtPoint(
      this.airVelocityBodyMps,
      this.omegaBodyRadPerSec,
      position
    )
    const local: readonly [number, number, number] = [
      pointVelocity[0] - inducedAirVelocityBodyMps.x,
      pointVelocity[1] - inducedAirVelocityBodyMps.y,
      pointVelocity[2] - inducedAirVelocityBodyMps.z,
    ]
    const speedSquared = local[0] * local[0] + local[1] * local[1] + local[2] * local[2]
    if (speedSquared <= 0.01) return { liftN: 0, dragN: 0 }
    const speed = Math.sqrt(speedSquared)
    const controls = this.definition.controls
    const elevatorAngle =
      elevator * controls.elevatorLimitRad * controls.elevatorEffectiveness
    const trimLimit = elevatorTrim >= 0
      ? controls.elevatorTrimUpLimitRad ?? 0
      : controls.elevatorTrimDownLimitRad ?? 0
    const trimAngle =
      elevatorTrim * trimLimit * (controls.elevatorTrimEffectiveness ?? 1)
    const controlAngle =
      (elevatorAngle + trimAngle) *
      (controls.elevatorDeflectionSign ?? 1) *
      (elevatorArea / area)
    const alpha = Math.atan2(local[2], local[0]) +
      (geometry.horizontalTailIncidenceRad ?? 0) +
      controlAngle
    const coefficient = this.tailLiftCoefficient(
      alpha,
      controls.elevatorLiftCoefficientSlopePerRad ?? 5
    )
    const dynamicPressure = 0.5 * densityKgPerM3 * speedSquared
    const liftN = dynamicPressure * area * coefficient
    const dragN = dynamicPressure * area * inducedSurfaceDragCoefficient(
      coefficient,
      geometry.horizontalTailSpanM ?? 0,
      area,
      geometry.oswaldEfficiency
    )
    this.applyHorizontalForce(position, local, speed, liftN, dragN)
    return { liftN, dragN }
  }

  private computeVerticalTail(
    densityKgPerM3: number,
    rudder: number,
    rudderTrim: number
  ): { readonly sideN: number; readonly dragN: number } {
    const geometry = this.definition.geometry
    const stabilizerArea = geometry.verticalTailAreaM2 ?? 0
    const rudderArea = geometry.rudderAreaM2 ?? 0
    const area = stabilizerArea + rudderArea
    const position = geometry.verticalTailPositionBodyM
    if (area <= 0 || position == null) return { sideN: 0, dragN: 0 }

    const local = localVelocityAtPoint(this.airVelocityBodyMps, this.omegaBodyRadPerSec, position)
    const speedSquared = local[0] * local[0] + local[1] * local[1] + local[2] * local[2]
    if (speedSquared <= 0.01) return { sideN: 0, dragN: 0 }
    const speed = Math.sqrt(speedSquared)
    const controls = this.definition.controls
    const controlAngle = (
      rudder * controls.rudderLimitRad * controls.rudderEffectiveness +
      rudderTrim * (controls.rudderTrimLimitRad ?? 0) * (controls.rudderTrimEffectiveness ?? 1)
    ) * (rudderArea / area)
    const beta = Math.atan2(local[1], local[0]) + controlAngle
    const coefficient = this.tailLiftCoefficient(
      beta,
      controls.rudderLiftCoefficientSlopePerRad ?? 5
    )
    const dynamicPressure = 0.5 * densityKgPerM3 * speedSquared
    const sideLiftN = dynamicPressure * area * coefficient
    const dragN = dynamicPressure * area * inducedSurfaceDragCoefficient(
      coefficient,
      geometry.verticalTailSpanM ?? 0,
      area,
      geometry.oswaldEfficiency
    )
    const sideN = this.applyVerticalForce(position, local, speed, sideLiftN, dragN)
    return { sideN, dragN }
  }

  private computeFuselageSideForce(densityKgPerM3: number): number {
    const geometry = this.definition.geometry
    const coefficient = Math.max(0, this.definition.aerodynamics.fuselageLateralDragCoefficient ?? 0)
    const lengthM = Math.max(0, geometry.fuselageLengthM ?? 0)
    const diameterM = Math.max(0, geometry.fuselageDiameterM ?? 0)
    const position = geometry.fuselageCenterBodyM
    if (coefficient === 0 || lengthM === 0 || diameterM === 0 || position == null) return 0

    const local = localVelocityAtPoint(this.airVelocityBodyMps, this.omegaBodyRadPerSec, position)
    const lateralMps = local[1]
    const sideN = -0.5 * densityKgPerM3 * lateralMps * Math.abs(lateralMps) *
      lengthM * diameterM * coefficient
    this.addForceAtPoint(position, 0, sideN, 0)
    return sideN
  }

  private tailLiftCoefficient(alphaRad: number, targetSlope: number): number {
    const curve = this.definition.aerodynamics.liftCoefficientByAlphaRad
    const curveSlope = liftCurveSlopeAt(curve, 0)
    if (Math.abs(curveSlope) <= 1e-6) return targetSlope * alphaRad
    return (lookup1D(alphaRad, curve) - lookup1D(0, curve)) * (targetSlope / curveSlope)
  }

  private applyHorizontalForce(
    position: readonly [number, number, number],
    velocity: readonly [number, number, number],
    speed: number,
    liftN: number,
    dragN: number
  ): void {
    const vx = velocity[0] / speed
    const vy = velocity[1] / speed
    const vz = velocity[2] / speed
    const liftLength = Math.hypot(vz, vx)
    const liftX = liftLength > 1e-9 ? vz / liftLength : 0
    const liftZ = liftLength > 1e-9 ? -vx / liftLength : 0
    this.addForceAtPoint(
      position,
      -dragN * vx + liftN * liftX,
      -dragN * vy,
      -dragN * vz + liftN * liftZ
    )
  }

  private applyVerticalForce(
    position: readonly [number, number, number],
    velocity: readonly [number, number, number],
    speed: number,
    sideLiftN: number,
    dragN: number
  ): number {
    const vx = velocity[0] / speed
    const vy = velocity[1] / speed
    const vz = velocity[2] / speed
    const lateralLength = Math.hypot(velocity[0], velocity[1])
    const sideX = lateralLength > 1e-9 ? velocity[1] / lateralLength : 0
    const sideY = lateralLength > 1e-9 ? -velocity[0] / lateralLength : -1
    const sideForceY = sideLiftN * sideY
    this.addForceAtPoint(
      position,
      -dragN * vx + sideLiftN * sideX,
      -dragN * vy + sideForceY,
      -dragN * vz
    )
    return sideForceY
  }

  private addForceAtPoint(
    position: readonly [number, number, number],
    fx: number,
    fy: number,
    fz: number
  ): void {
    this.forceBodyN.x += fx
    this.forceBodyN.y += fy
    this.forceBodyN.z += fz
    this.torqueBodyNm.x += position[1] * fz - position[2] * fy
    this.torqueBodyNm.y += position[2] * fx - position[0] * fz
    this.torqueBodyNm.z += position[0] * fy - position[1] * fx
  }

  private applyElementForce(
    element: WingElement,
    u: number,
    v: number,
    w: number,
    speed: number,
    liftN: number,
    dragN: number
  ): void {
    const vx = u / speed
    const vy = v / speed
    const vz = w / speed
    const liftLength = Math.hypot(vz, vx)
    const liftX = liftLength > 1e-9 ? vz / liftLength : 0
    const liftZ = liftLength > 1e-9 ? -vx / liftLength : 0
    const fx = -dragN * vx + liftN * liftX
    const fy = -dragN * vy
    const fz = -dragN * vz + liftN * liftZ
    this.forceBodyN.x += fx
    this.forceBodyN.y += fy
    this.forceBodyN.z += fz
    this.torqueBodyNm.x += element.y * fz - element.z * fy
    this.torqueBodyNm.y += element.z * fx - element.x * fz
    this.torqueBodyNm.z += element.x * fy - element.y * fx
  }

  private integrateRotation(dtSeconds: number): void {
    const [ix, iy, iz] = this.definition.inertiaKgM2
    const omega = this.omegaBodyRadPerSec
    const torque = this.torqueBodyNm
    const crossX = (iz - iy) * omega.y * omega.z
    const crossY = (ix - iz) * omega.z * omega.x
    const crossZ = (iy - ix) * omega.x * omega.y
    omega.x += ((torque.x - crossX) / Math.max(ix, 1)) * dtSeconds
    omega.y += ((torque.y - crossY) / Math.max(iy, 1)) * dtSeconds
    omega.z += ((torque.z - crossZ) / Math.max(iz, 1)) * dtSeconds

    this.omegaQuaternion.set(omega.x, omega.y, omega.z, 0)
    this.qDot.multiplyQuaternions(this.orientationBodyToNed, this.omegaQuaternion)
    const scale = 0.5 * dtSeconds
    this.orientationBodyToNed.set(
      this.orientationBodyToNed.x + this.qDot.x * scale,
      this.orientationBodyToNed.y + this.qDot.y * scale,
      this.orientationBodyToNed.z + this.qDot.z * scale,
      this.orientationBodyToNed.w + this.qDot.w * scale
    ).normalize()
  }

  private publishState(state: SimStateStore): void {
    this.euler.setFromQuaternion(this.orientationBodyToNed, 'ZYX')
    setSubsystemNumber(state, AirPhysicsStateKeys.northMeters(), this.positionNedM.x, 'meters')
    setSubsystemNumber(state, AirPhysicsStateKeys.eastMeters(), this.positionNedM.y, 'meters')
    setSubsystemNumber(state, AirPhysicsStateKeys.altitudeMeters(), -this.positionNedM.z, 'meters')
    setSubsystemNumber(state, AirPhysicsStateKeys.velocityNorthMps(), this.velocityNedMps.x, 'metersPerSecond')
    setSubsystemNumber(state, AirPhysicsStateKeys.velocityEastMps(), this.velocityNedMps.y, 'metersPerSecond')
    setSubsystemNumber(state, AirPhysicsStateKeys.velocityDownMps(), this.velocityNedMps.z, 'metersPerSecond')
    setSubsystemNumber(state, AirPhysicsStateKeys.rollRad(), this.euler.x, 'radians')
    setSubsystemNumber(state, AirPhysicsStateKeys.pitchRad(), this.euler.y, 'radians')
    setSubsystemNumber(state, AirPhysicsStateKeys.yawRad(), this.euler.z, 'radians')
    setSubsystemNumber(state, AirPhysicsStateKeys.quaternionX(), this.orientationBodyToNed.x, 'number')
    setSubsystemNumber(state, AirPhysicsStateKeys.quaternionY(), this.orientationBodyToNed.y, 'number')
    setSubsystemNumber(state, AirPhysicsStateKeys.quaternionZ(), this.orientationBodyToNed.z, 'number')
    setSubsystemNumber(state, AirPhysicsStateKeys.quaternionW(), this.orientationBodyToNed.w, 'number')
    setSubsystemNumber(state, AirPhysicsStateKeys.rollRateRadPerSecond(), this.omegaBodyRadPerSec.x, 'radiansPerSecond')
    setSubsystemNumber(state, AirPhysicsStateKeys.pitchRateRadPerSecond(), this.omegaBodyRadPerSec.y, 'radiansPerSecond')
    setSubsystemNumber(state, AirPhysicsStateKeys.yawRateRadPerSecond(), this.omegaBodyRadPerSec.z, 'radiansPerSecond')
    setSubsystemNumber(state, AirPhysicsStateKeys.airspeedMps(), this.telemetry.airspeedMps, 'metersPerSecond')
    setSubsystemNumber(state, AirPhysicsStateKeys.mach(), this.telemetry.mach, 'mach')
    setSubsystemNumber(state, AirPhysicsStateKeys.alphaRad(), this.telemetry.alphaRad, 'radians')
    setSubsystemNumber(state, AirPhysicsStateKeys.betaRad(), this.telemetry.betaRad, 'radians')
    setSubsystemNumber(state, AirPhysicsStateKeys.dynamicPressurePa(), this.telemetry.dynamicPressurePa, 'pascals')
    setSubsystemNumber(state, AirPhysicsStateKeys.liftN(), this.telemetry.liftN, 'newtons')
    setSubsystemNumber(state, AirPhysicsStateKeys.dragN(), this.telemetry.dragN, 'newtons')
    setSubsystemNumber(state, AirPhysicsStateKeys.sideN(), this.telemetry.sideN, 'newtons')
    setSubsystemNumber(state, AirPhysicsStateKeys.thrustN(), this.telemetry.thrustN, 'newtons')
    setSubsystemNumber(state, AirPhysicsStateKeys.forceBodyForwardN(), this.forceBodyN.x, 'newtons')
    setSubsystemNumber(state, AirPhysicsStateKeys.forceBodyRightN(), this.forceBodyN.y, 'newtons')
    setSubsystemNumber(state, AirPhysicsStateKeys.forceBodyDownN(), this.forceBodyN.z, 'newtons')
    setSubsystemNumber(state, AirPhysicsStateKeys.torqueBodyRollNm(), this.torqueBodyNm.x, 'newtonMeters')
    setSubsystemNumber(state, AirPhysicsStateKeys.torqueBodyPitchNm(), this.torqueBodyNm.y, 'newtonMeters')
    setSubsystemNumber(state, AirPhysicsStateKeys.torqueBodyYawNm(), this.torqueBodyNm.z, 'newtonMeters')
    for (let offset = 0; offset < (this.propulsion.engines?.length ?? 0); offset += 1) {
      const engine = this.propulsion.engines![offset]
      setSubsystemNumber(
        state,
        PropulsionStateKeys.engineThrustN(engine.index),
        this.engineThrustN[offset] ?? 0,
        'newtons'
      )
    }
  }
}
function buildWingElements(
  definition: CanonicalAirPhysicsSystemConfig
): readonly WingElement[] {
  const geometry = definition.geometry
  const count = Math.max(
    4,
    Math.min(64, Math.trunc(geometry.bladeElementCount ?? DEFAULT_BLADE_ELEMENTS))
  )
  const halfSpan = Math.max(geometry.wingSpanM * 0.5, 0.01)
  const elementWidth = geometry.wingSpanM / count
  const raw: Array<{
    y: number
    area: number
    sweepOffset: number
    dihedralOffset: number
    twistRad: number
    flap: boolean
    aileronAreaFraction: number
  }> = []
  const flapOutboard = clamp(definition.controls.flapSpanOutboardRatio ?? 1, 0, 1)
  for (let index = 0; index < count; index += 1) {
    const y = -halfSpan + (index + 0.5) * elementWidth
    const spanRatio = Math.abs(y) / halfSpan
    const chord = lerp(geometry.wingRootChordM, geometry.wingTipChordM, spanRatio)
    raw.push({
      y,
      area: Math.max(chord, 0.01) * elementWidth,
      sweepOffset: -Math.abs(y) * Math.tan(geometry.wingSweepRad),
      dihedralOffset: -Math.abs(y) * Math.tan(geometry.wingDihedralRad),
      twistRad: geometry.wingTwistRad * spanRatio,
      flap: spanRatio <= flapOutboard,
      aileronAreaFraction: 0,
    })
  }
  const rawArea = raw.reduce((sum, element) => sum + element.area, 0)
  const areaScale = geometry.wingAreaM2 / Math.max(rawArea, 0.01)
  const weightedSweep = raw.reduce(
    (sum, element) => sum + element.sweepOffset * element.area,
    0
  ) / Math.max(rawArea, 0.01)
  const weightedDihedral = raw.reduce(
    (sum, element) => sum + element.dihedralOffset * element.area,
    0
  ) / Math.max(rawArea, 0.01)
  const flappedArea = raw.reduce(
    (sum, element) => sum + (element.flap ? element.area * areaScale : 0),
    0
  )
  const flapCoefficientScale =
    flappedArea > 0 ? geometry.wingAreaM2 / flappedArea : 0
  const aileronAreaPerSide = Math.max(0, geometry.aileronAreaM2 ?? 0) * 0.5
  for (const side of [-1, 1] as const) {
    let remainingArea = aileronAreaPerSide
    const candidates = raw
      .filter(element => Math.sign(element.y) === side)
      .sort((left, right) => Math.abs(right.y) - Math.abs(left.y))
    for (const element of candidates) {
      if (remainingArea <= 0) break
      const elementArea = element.area * areaScale
      const usedArea = Math.min(elementArea, remainingArea)
      element.aileronAreaFraction = usedArea / Math.max(elementArea, 0.01)
      remainingArea -= usedArea
    }
  }
  const [centerX, centerY, centerZ] = geometry.aerodynamicCenterBodyM

  return raw.map(element => {
    const startY = element.y - elementWidth * 0.5
    const endY = element.y + elementWidth * 0.5
    const pointAtSpan = (y: number): readonly [number, number, number] => [
      centerX - Math.abs(y) * Math.tan(geometry.wingSweepRad) - weightedSweep,
      centerY + y,
      centerZ - Math.abs(y) * Math.tan(geometry.wingDihedralRad) - weightedDihedral,
    ]
    return {
      x: centerX + element.sweepOffset - weightedSweep,
      y: centerY + element.y,
      z: centerZ + element.dihedralOffset - weightedDihedral,
      areaM2: element.area * areaScale,
      spanWidthM: elementWidth,
      spanStartBodyM: pointAtSpan(startY),
      spanEndBodyM: pointAtSpan(endY),
      twistRad: element.twistRad,
      flapCoefficientScale: element.flap ? flapCoefficientScale : 0,
      aileronAreaFraction: element.aileronAreaFraction,
    }
  })
}

function addHorseshoeInducedVelocity(
  target: Vector3,
  point: readonly [number, number, number],
  element: WingElement,
  circulationM2PerSecond: number,
  wakeDirectionBody: readonly [number, number, number]
): void {
  addFiniteVortexSegmentInducedVelocity(
    target,
    point,
    element.spanStartBodyM,
    element.spanEndBodyM,
    circulationM2PerSecond
  )
  addSemiInfiniteVortexInducedVelocity(
    target,
    point,
    element.spanEndBodyM,
    wakeDirectionBody,
    circulationM2PerSecond
  )
  addSemiInfiniteVortexInducedVelocity(
    target,
    point,
    element.spanStartBodyM,
    wakeDirectionBody,
    -circulationM2PerSecond
  )
}

function addFiniteVortexSegmentInducedVelocity(
  target: Vector3,
  point: readonly [number, number, number],
  start: readonly [number, number, number],
  end: readonly [number, number, number],
  circulationM2PerSecond: number
): void {
  const r1x = point[0] - start[0]
  const r1y = point[1] - start[1]
  const r1z = point[2] - start[2]
  const r2x = point[0] - end[0]
  const r2y = point[1] - end[1]
  const r2z = point[2] - end[2]
  const cx = r1y * r2z - r1z * r2y
  const cy = r1z * r2x - r1x * r2z
  const cz = r1x * r2y - r1y * r2x
  const crossSquared = cx * cx + cy * cy + cz * cz
  const r1Length = Math.hypot(r1x, r1y, r1z)
  const r2Length = Math.hypot(r2x, r2y, r2z)
  if (crossSquared <= 1e-18 || r1Length <= 1e-9 || r2Length <= 1e-9) return

  const segmentX = end[0] - start[0]
  const segmentY = end[1] - start[1]
  const segmentZ = end[2] - start[2]
  const projection = segmentX * (r1x / r1Length - r2x / r2Length) +
    segmentY * (r1y / r1Length - r2y / r2Length) +
    segmentZ * (r1z / r1Length - r2z / r2Length)
  const scale = circulationM2PerSecond * projection / (4 * Math.PI * crossSquared)
  target.x += cx * scale
  target.y += cy * scale
  target.z += cz * scale
}

function addSemiInfiniteVortexInducedVelocity(
  target: Vector3,
  point: readonly [number, number, number],
  start: readonly [number, number, number],
  direction: readonly [number, number, number],
  circulationM2PerSecond: number
): void {
  const directionLength = Math.hypot(direction[0], direction[1], direction[2])
  if (directionLength <= 1e-9) return
  const dx = direction[0] / directionLength
  const dy = direction[1] / directionLength
  const dz = direction[2] / directionLength
  const rx = point[0] - start[0]
  const ry = point[1] - start[1]
  const rz = point[2] - start[2]
  const cx = dy * rz - dz * ry
  const cy = dz * rx - dx * rz
  const cz = dx * ry - dy * rx
  const crossSquared = cx * cx + cy * cy + cz * cz
  const distance = Math.hypot(rx, ry, rz)
  if (crossSquared <= 1e-18 || distance <= 1e-9) return

  const along = dx * rx + dy * ry + dz * rz
  const scale = circulationM2PerSecond * (1 + along / distance) /
    (4 * Math.PI * crossSquared)
  target.x += cx * scale
  target.y += cy * scale
  target.z += cz * scale
}

function applyEngineThrust(
  forceBodyN: Vector3,
  torqueBodyNm: Vector3,
  engine: CanonicalPropulsionEngineConfig,
  thrustN: number
): void {
  const direction = engine.thrustDirectionBody ?? [1, 0, 0]
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1
  const fx = (direction[0] / length) * thrustN
  const fy = (direction[1] / length) * thrustN
  const fz = (direction[2] / length) * thrustN
  forceBodyN.x += fx
  forceBodyN.y += fy
  forceBodyN.z += fz

  const position = engine.positionBodyM ?? [0, 0, 0]
  torqueBodyNm.x += position[1] * fz - position[2] * fy
  torqueBodyNm.y += position[2] * fx - position[0] * fz
  torqueBodyNm.z += position[0] * fy - position[1] * fx
}

function emptyTelemetry(): ForceTelemetry {
  return {
    airspeedMps: 0,
    mach: 0,
    alphaRad: 0,
    betaRad: 0,
    dynamicPressurePa: 0,
    liftN: 0,
    dragN: 0,
    sideN: 0,
    thrustN: 0,
  }
}
function defineBoolean(state: SimStateStore, key: string, defaultValue: boolean): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean' })
  state.set(key, defaultValue, { source: 'default', unit: 'boolean' })
}

function defineNumber(
  state: SimStateStore,
  key: string,
  unit: SimUnit,
  defaultValue: number
): void {
  state.define({ key, unit, valueType: 'number' })
  state.set(key, defaultValue, { source: 'default', unit })
}

function setSubsystemNumber(
  state: SimStateStore,
  key: string,
  value: number,
  unit: SimUnit
): void {
  state.define({ key, unit, valueType: 'number' })
  state.set(key, Number.isFinite(value) ? value : 0, {
    source: 'subsystem',
    unit,
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))
}

function lerp(left: number, right: number, ratio: number): number {
  return left + (right - left) * ratio
}
function localVelocityAtPoint(
  velocityBodyMps: Vector3,
  omegaBodyRadPerSec: Vector3,
  position: readonly [number, number, number]
): readonly [number, number, number] {
  return [
    velocityBodyMps.x + omegaBodyRadPerSec.y * position[2] - omegaBodyRadPerSec.z * position[1],
    velocityBodyMps.y + omegaBodyRadPerSec.z * position[0] - omegaBodyRadPerSec.x * position[2],
    velocityBodyMps.z + omegaBodyRadPerSec.x * position[1] - omegaBodyRadPerSec.y * position[0],
  ]
}

export function computeWingDownwashAngleRad(
  definition: CanonicalAirPhysicsSystemConfig,
  alphaRad: number,
  flapsRatio = 0,
  spoilersRatio = 0
): number {
  const geometry = definition.geometry
  const aero = definition.aerodynamics
  const wingAlphaRad = alphaRad + geometry.wingIncidenceRad
  const liftCoefficient =
    lookup1D(wingAlphaRad, aero.liftCoefficientByAlphaRad) * aero.liftScalar +
    aero.flapLiftCoefficient * flapsRatio +
    aero.spoilerLiftCoefficient * spoilersRatio
  if (Math.abs(liftCoefficient) <= 1e-9) return 0
  const aspectRatio = geometry.wingSpanM * geometry.wingSpanM /
    Math.max(geometry.wingAreaM2, 0.01)
  const flapInducedMultiplier = 1 +
    (aero.flapInducedDragScalar - 1) * Math.max(0, Math.min(1, flapsRatio))
  const inducedFactor =
    aero.inducedDragScalar * flapInducedMultiplier /
    Math.max(Math.PI * aspectRatio * geometry.oswaldEfficiency, 0.01)
  const inducedAngleRad = Math.atan(inducedFactor * liftCoefficient)
  return 2 * inducedAngleRad
}

function inducedSurfaceDragCoefficient(
  liftCoefficient: number,
  spanM: number,
  areaM2: number,
  oswaldEfficiency: number
): number {
  const aspectRatio = spanM * spanM / Math.max(areaM2, 0.01)
  return liftCoefficient * liftCoefficient /
    Math.max(Math.PI * aspectRatio * oswaldEfficiency, 0.01)
}

function liftCurveSlopeAt(
  table: { readonly breakpoints: readonly number[]; readonly values: readonly number[] },
  alphaRad: number
): number {
  const epsilon = 1e-3
  return (lookup1D(alphaRad + epsilon, table) - lookup1D(alphaRad - epsilon, table)) /
    (2 * epsilon)
}
