import { Vector3 } from 'three'

import type {
  AircraftAeroParams,
  AircraftParams,
  FlapVisualSchedule
} from './FlightModel'
import { buildEvenDetents01, parseMsfsFlapSections } from './MsfsFlapConfig'
import type {
  CompatibilityAircraftPhysicsDescriptor,
  CompatibilityLookupTableDescriptor,
  CompatibilityVector3Descriptor
} from '../msfs/runtime/descriptor.ts'

const FEET_TO_METERS = 0.3048
const LBS_TO_KG = 0.45359237
const LBF_TO_NEWTON = 4.4482216152605
const SLUG_FT2_TO_KG_M2 = 1.3558179483314004
const RAD_TO_DEG = 180 / Math.PI

const DEFAULT_THROTTLE_TO_THRUST: CompatibilityLookupTableDescriptor = {
  breakpoints: [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.85, 1],
  values: [0, 0.002, 0.005, 0.02, 0.08, 0.18, 0.4, 0.68, 1]
}

const DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS: CompatibilityAircraftPhysicsDescriptor = {
  massKg: 78_000,
  inertiaKgM2: { x: 1_600_000, y: 4_100_000, z: 4_700_000 },
  wingAreaM2: 140,
  wingSpanM: 36,
  meanChordM: 140 / 36,
  maxThrustN: 260_000,
  controlLimitsRad: {
    aileron: (25 * Math.PI) / 180,
    elevator: (25 * Math.PI) / 180,
    rudder: (25 * Math.PI) / 180
  },
  angularDampingPerSec: { x: 0.22, y: 0.3, z: 0.22 },
  throttleToThrustFraction: DEFAULT_THROTTLE_TO_THRUST,
  configuration: {
    flapDetents01: [0, 0.25, 0.5, 0.75, 1],
    defaultFlapDetentIndex: 0,
    flapRatePerSec: 0.1,
    gearRatePerSec: 0.22,
    spoilerRatePerSec: 1.8,
    flapLiftClMax: 0.8,
    flapDragCdMax: 0.14,
    flapPitchCmMax: 0.1,
    gearDragCdMax: 0.03,
    spoilerDragCdMax: 0.08,
    spoilerLiftLossMax: 0.35,
    spoilerPitchCmMax: 0.03
  },
  aero: {
    CL0: 0.12,
    CLalphaPerRad: 5.3,
    CLmax: 1.65,
    alphaStallRad: (15 * Math.PI) / 180,
    alphaStallBlendRad: (4 * Math.PI) / 180,
    CD0: 0.02,
    inducedDragFactor: 0.045,
    CDbeta: 0.04,
    CDStallAdd: 0.5,
    CYbetaPerRad: -0.5,
    ClbetaPerRad: -0.06,
    Clp: -0.62,
    Clda: 0.03,
    Cm0: 0.02,
    CmalphaPerRad: 0.4,
    Cmq: -8,
    Cmde: -0.45,
    Cn0: 0,
    CnbetaPerRad: 0.14,
    Cnr: -0.22,
    Cndr: 0.04
  },
  visualOffsetBodyMeters: { x: 0, y: 0, z: 0 }
}

interface ParsedIni {
  sections: Map<string, Map<string, string>>
}

export function buildCompatibilityAircraftPhysicsDescriptor(
  flightModelCfgSource: string,
  enginesCfgSource?: string
): CompatibilityAircraftPhysicsDescriptor {
  const flightModel = parseIni(flightModelCfgSource)
  const engines = enginesCfgSource ? parseIni(enginesCfgSource) : undefined

  const wingAreaM2 =
    readSectionNumber(flightModel, 'airplane_geometry', 'wing_area') * FEET_TO_METERS * FEET_TO_METERS ||
    DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.wingAreaM2
  const wingSpanM =
    readSectionNumber(flightModel, 'airplane_geometry', 'wing_span') * FEET_TO_METERS ||
    DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.wingSpanM
  const meanChordM =
    wingAreaM2 > 0 && wingSpanM > 0
      ? wingAreaM2 / wingSpanM
      : DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.meanChordM

  const emptyWeightKg =
    readSectionNumber(flightModel, 'weight_and_balance', 'empty_weight') * LBS_TO_KG
  const maxGrossWeightKg =
    readSectionNumber(flightModel, 'weight_and_balance', 'max_gross_weight') * LBS_TO_KG
  const massKg = deriveOperatingMassKg(emptyWeightKg, maxGrossWeightKg)

  const inertiaKgM2 = deriveInertiaDescriptor(flightModel, massKg, wingSpanM, meanChordM)
  const maxThrustN = deriveMaxThrustNewtons(engines)
  const controlLimitsRad = deriveControlLimits(flightModel)
  const angularDampingPerSec = deriveAngularDamping(wingSpanM)

  const alphaCl = deriveAlphaClTable(flightModel)
  const alphaStallDeg = derivePositivePeakBreakpoint(alphaCl) ?? 15
  const alphaStallBlendDeg = derivePositiveBlendDegrees(alphaCl, alphaStallDeg)
  const inducedDragFactor = deriveInducedDragFactor(flightModel, wingAreaM2, wingSpanM)
  const cd0 = deriveCd0(flightModel)
  const alphaCd = deriveAlphaCdTable(alphaCl, cd0, inducedDragFactor, alphaStallDeg)
  const alphaCm = deriveAlphaCmTable(flightModel, alphaCl.breakpoints)

  const cyBetaBase = clamp(
    readSectionNumber(flightModel, 'aerodynamics', 'side_force_slip_angle') * 0.1907,
    -1.2,
    -0.2
  )
  const clBetaBase = clamp(
    readSectionNumber(flightModel, 'aerodynamics', 'roll_moment_slip_angle') * -0.1444,
    -0.2,
    -0.02
  )
  const cnBetaBase = clamp(
    readSectionNumber(flightModel, 'aerodynamics', 'yaw_moment_slip_angle') * 0.1389,
    0.05,
    0.35
  )

  const liftDeltaElevatorBase = clamp(
    Math.abs(readSectionNumber(flightModel, 'aerodynamics', 'lift_coef_delta_elevator')) * 0.023,
    0.015,
    0.05
  )
  const pitchDeltaElevatorBase = clamp(
    readSectionNumber(flightModel, 'aerodynamics', 'pitch_moment_delta_elevator') * 0.0526,
    -1,
    -0.1
  )
  const rollDeltaAileronBase = clamp(
    readSectionNumber(flightModel, 'aerodynamics', 'roll_moment_delta_aileron') * -0.117,
    0.01,
    0.08
  )
  const sideDeltaRudderBase = clamp(
    readSectionNumber(flightModel, 'aerodynamics', 'side_force_delta_rudder') * -0.0501,
    0.08,
    0.2
  )
  const yawDeltaRudderBase = clamp(
    readSectionNumber(flightModel, 'aerodynamics', 'yaw_moment_delta_rudder') * 0.0394,
    0.01,
    0.08
  )

  const flapConfig = deriveConfigurationDescriptor(flightModelCfgSource, flightModel, alphaCl.values)
  const visualOffsetBodyMeters = deriveVisualOffset(flightModel)

  return {
    massKg,
    inertiaKgM2,
    wingAreaM2,
    wingSpanM,
    meanChordM,
    maxThrustN,
    controlLimitsRad,
    angularDampingPerSec,
    throttleToThrustFraction: DEFAULT_THROTTLE_TO_THRUST,
    configuration: flapConfig,
    aero: {
      CL0: lookupAtZero(alphaCl),
      CLalphaPerRad: deriveSlopePerRad(alphaCl),
      CLmax: Math.max(...alphaCl.values.map((value) => Math.abs(value)), DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.aero.CLmax),
      alphaStallRad: (alphaStallDeg * Math.PI) / 180,
      alphaStallBlendRad: (alphaStallBlendDeg * Math.PI) / 180,
      CD0: cd0,
      inducedDragFactor,
      CDbeta: 0.04,
      CDStallAdd: 0.5,
      CYbetaPerRad: cyBetaBase,
      ClbetaPerRad: clBetaBase,
      Clp: clamp(
        readSectionNumber(flightModel, 'aerodynamics', 'roll_moment_roll_damping') * 0.2984,
        -1.5,
        -0.3
      ),
      Clda: rollDeltaAileronBase,
      Cm0: lookupAtZero(alphaCm),
      CmalphaPerRad: deriveSlopePerRad(alphaCm),
      Cmq: clamp(
        readSectionNumber(flightModel, 'aerodynamics', 'pitch_moment_pitch_damping') * 0.00923,
        -12,
        -3
      ),
      Cmde: pitchDeltaElevatorBase,
      Cn0: 0,
      CnbetaPerRad: cnBetaBase,
      Cnr: clamp(
        readSectionNumber(flightModel, 'aerodynamics', 'yaw_moment_yaw_damping') * 0.00475,
        -0.7,
        -0.05
      ),
      Cndr: yawDeltaRudderBase,
      lookup: {
        alphaCl,
        alphaCd,
        alphaCm,
        betaCy: buildSymmetricSlopeTable(cyBetaBase),
        betaCl: buildSymmetricSlopeTable(clBetaBase),
        betaCn: buildSymmetricSlopeTable(cnBetaBase),
        controlAlphaClDeltaE: buildControlEffectivenessTable(liftDeltaElevatorBase),
        controlAlphaCmDeltaE: buildControlEffectivenessTable(pitchDeltaElevatorBase),
        controlAlphaClDeltaA: buildControlEffectivenessTable(rollDeltaAileronBase),
        controlAlphaCyDeltaR: buildControlEffectivenessTable(sideDeltaRudderBase),
        controlAlphaCnDeltaR: buildControlEffectivenessTable(yawDeltaRudderBase)
      }
    },
    visualOffsetBodyMeters
  }
}

export function createDefaultCompatibilityAircraftPhysicsDescriptor(): CompatibilityAircraftPhysicsDescriptor {
  return structuredClone(DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS)
}

export function hydrateCompatibilityAircraftParams(
  descriptor: CompatibilityAircraftPhysicsDescriptor | undefined
): { aircraftParams: AircraftParams; visualOffsetBodyMeters: Vector3 } {
  const source = descriptor ?? DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS
  return {
    aircraftParams: {
      massKg: source.massKg,
      inertiaKgM2: toVector3(source.inertiaKgM2),
      wingAreaM2: source.wingAreaM2,
      wingSpanM: source.wingSpanM,
      meanChordM: source.meanChordM,
      maxThrustN: source.maxThrustN,
      controlLimitsRad: source.controlLimitsRad,
      angularDampingPerSec: toVector3(source.angularDampingPerSec),
      throttleToThrustFraction: source.throttleToThrustFraction,
      configuration: source.configuration,
      aero: source.aero as AircraftAeroParams
    },
    visualOffsetBodyMeters: toVector3(
      source.visualOffsetBodyMeters ?? DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.visualOffsetBodyMeters
    )
  }
}

function parseIni(source: string): ParsedIni {
  const sections = new Map<string, Map<string, string>>()
  let currentSection: Map<string, string> | undefined

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (line.length === 0) continue

    const sectionMatch = line.match(/^\[(.+?)\]$/)
    if (sectionMatch) {
      const name = sectionMatch[1].trim().toLowerCase()
      currentSection = new Map()
      sections.set(name, currentSection)
      continue
    }

    if (!currentSection) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) continue

    const key = line.slice(0, separatorIndex).trim().toLowerCase()
    const value = line.slice(separatorIndex + 1).trim()
    currentSection.set(key, value)
  }

  return { sections }
}

function stripComment(line: string): string {
  const commentIndex = line.indexOf(';')
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line
}

function readSectionNumber(parsed: ParsedIni, sectionName: string, key: string): number {
  const rawValue = parsed.sections.get(sectionName.toLowerCase())?.get(key.toLowerCase())
  if (!rawValue) return 0
  const match = rawValue.match(/-?\d+(?:\.\d+)?/)
  return match ? Number.parseFloat(match[0]) : 0
}

function readSectionTuple(parsed: ParsedIni, sectionName: string, key: string): number[] {
  const rawValue = parsed.sections.get(sectionName.toLowerCase())?.get(key.toLowerCase())
  if (!rawValue) return []
  return rawValue
    .split(',')
    .map((value) => Number.parseFloat(value.trim()))
    .filter((value) => Number.isFinite(value))
}

function deriveOperatingMassKg(emptyWeightKg: number, maxGrossWeightKg: number): number {
  if (emptyWeightKg > 0 && maxGrossWeightKg > emptyWeightKg) {
    return emptyWeightKg + (maxGrossWeightKg - emptyWeightKg) * 0.65
  }
  if (maxGrossWeightKg > 0) return maxGrossWeightKg * 0.85
  if (emptyWeightKg > 0) return emptyWeightKg * 1.25
  return DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.massKg
}

function deriveInertiaDescriptor(
  parsed: ParsedIni,
  massKg: number,
  wingSpanM: number,
  meanChordM: number
): CompatibilityVector3Descriptor {
  const roll = readSectionNumber(parsed, 'weight_and_balance', 'empty_weight_roll_moi') * SLUG_FT2_TO_KG_M2
  const pitch = readSectionNumber(parsed, 'weight_and_balance', 'empty_weight_pitch_moi') * SLUG_FT2_TO_KG_M2
  const yaw = readSectionNumber(parsed, 'weight_and_balance', 'empty_weight_yaw_moi') * SLUG_FT2_TO_KG_M2
  const emptyWeightKg = readSectionNumber(parsed, 'weight_and_balance', 'empty_weight') * LBS_TO_KG
  const massScale = emptyWeightKg > 0 ? massKg / emptyWeightKg : 1

  if (roll > 0 && pitch > 0 && yaw > 0) {
    return {
      x: roll * massScale,
      y: pitch * massScale,
      z: yaw * massScale
    }
  }

  const spanSq = wingSpanM * wingSpanM
  const chordSq = meanChordM * meanChordM
  return {
    x: massKg * spanSq * 0.1,
    y: massKg * chordSq * 0.45,
    z: massKg * spanSq * 0.18
  }
}

function deriveMaxThrustNewtons(engines: ParsedIni | undefined): number {
  if (!engines) return DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.maxThrustN

  const staticThrustLbf = readSectionNumber(engines, 'turbineenginedata', 'static_thrust')
  const generalEngineSection = engines.sections.get('generalenginedata')
  const engineCount = generalEngineSection
    ? [...generalEngineSection.keys()].filter((key) => /^engine\.\d+$/i.test(key)).length
    : 0
  if (staticThrustLbf > 0 && engineCount > 0) {
    return staticThrustLbf * LBF_TO_NEWTON * engineCount
  }

  return DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.maxThrustN
}

function deriveControlLimits(parsed: ParsedIni): CompatibilityAircraftPhysicsDescriptor['controlLimitsRad'] {
  const elevatorUp = readSectionNumber(parsed, 'airplane_geometry', 'elevator_up_limit')
  const elevatorDown = readSectionNumber(parsed, 'airplane_geometry', 'elevator_down_limit')
  const elevatorScalar = readSectionNumber(parsed, 'flight_tuning', 'elevator_maxangle_scalar') || 1

  const aileronUp = readSectionNumber(parsed, 'airplane_geometry', 'aileron_up_limit')
  const aileronDown = readSectionNumber(parsed, 'airplane_geometry', 'aileron_down_limit')
  const aileronScalar = readSectionNumber(parsed, 'flight_tuning', 'aileron_maxangle_scalar') || 1

  const rudderLimit = readSectionNumber(parsed, 'airplane_geometry', 'rudder_limit')
  const rudderScalar = readSectionNumber(parsed, 'flight_tuning', 'rudder_maxangle_scalar') || 1

  return {
    elevator: (Math.max(elevatorUp, elevatorDown, 20) * elevatorScalar * Math.PI) / 180,
    aileron: (Math.max(aileronUp, aileronDown, 20) * aileronScalar * Math.PI) / 180,
    rudder: (Math.max(rudderLimit, 20) * rudderScalar * Math.PI) / 180
  }
}

function deriveAngularDamping(wingSpanM: number): CompatibilityVector3Descriptor {
  const scale = Math.sqrt(
    DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.wingSpanM / Math.max(wingSpanM, 1)
  )
  return {
    x: clamp(0.22 * scale, 0.12, 0.28),
    y: clamp(0.3 * scale, 0.18, 0.38),
    z: clamp(0.22 * scale, 0.12, 0.28)
  }
}

function deriveAlphaClTable(parsed: ParsedIni): CompatibilityLookupTableDescriptor {
  const raw = parsed.sections.get('aerodynamics')?.get('lift_coef_aoa_table')
  const table = raw ? parseLookupTable(raw) : undefined
  if (!table || table.breakpoints.length < 2) {
    return structuredClone(DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.aero.lookup!.alphaCl)
  }

  return {
    breakpoints: table.breakpoints.map((value) => value * RAD_TO_DEG),
    values: table.values
  }
}

function deriveAlphaCmTable(
  parsed: ParsedIni,
  referenceBreakpoints: readonly number[]
): CompatibilityLookupTableDescriptor {
  const raw = parsed.sections.get('aerodynamics')?.get('pitch_moment_aoa_table')
  const table = raw ? parseLookupTable(raw) : undefined
  if (!table || table.breakpoints.length < 2) {
    return {
      breakpoints: [...referenceBreakpoints],
      values: referenceBreakpoints.map(() => 0)
    }
  }

  return {
    breakpoints: table.breakpoints.map((value) => value * RAD_TO_DEG),
    values: table.values
  }
}

function deriveAlphaCdTable(
  alphaCl: CompatibilityLookupTableDescriptor,
  cd0: number,
  inducedDragFactor: number,
  alphaStallDeg: number
): CompatibilityLookupTableDescriptor {
  return {
    breakpoints: [...alphaCl.breakpoints],
    values: alphaCl.breakpoints.map((breakpoint, index) => {
      const cl = alphaCl.values[index] ?? 0
      const absAlpha = Math.abs(breakpoint)
      const stallT = clamp((absAlpha - alphaStallDeg) / Math.max(1, 90 - alphaStallDeg), 0, 1)
      return cd0 + inducedDragFactor * cl * cl + 0.5 * stallT * stallT
    })
  }
}

function deriveInducedDragFactor(
  parsed: ParsedIni,
  wingAreaM2: number,
  wingSpanM: number
): number {
  const oswald = readSectionNumber(parsed, 'airplane_geometry', 'oswald_efficiency_factor') || 0.75
  if (wingAreaM2 <= 0 || wingSpanM <= 0) {
    return DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.aero.inducedDragFactor
  }

  const aspectRatio = (wingSpanM * wingSpanM) / wingAreaM2
  return clamp(1 / (Math.PI * Math.max(aspectRatio, 1) * Math.max(oswald, 0.1)), 0.025, 0.09)
}

function deriveCd0(parsed: ParsedIni): number {
  const cd0 = readSectionNumber(parsed, 'aerodynamics', 'drag_coef_zero_lift')
  const scalar = readSectionNumber(parsed, 'aerodynamics', 'parasite_drag_scalar') || 1
  if (cd0 > 0) {
    return cd0 * scalar
  }
  return DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.aero.CD0
}

function deriveConfigurationDescriptor(
  flightModelCfgSource: string,
  parsed: ParsedIni,
  alphaClValues: readonly number[]
): CompatibilityAircraftPhysicsDescriptor['configuration'] {
  const flapSections = parseMsfsFlapSections(flightModelCfgSource)
  const detentCount = Math.max(
    ...flapSections.map((section) => section.positions.length),
    DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.configuration?.flapDetents01.length ?? 0
  )
  const flapDetents01 =
    detentCount > 1
      ? buildEvenDetents01(detentCount)
      : DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.configuration?.flapDetents01 ?? [0, 1]

  const flapVisualSchedule = buildFlapVisualSchedule(flapSections, flapDetents01)
  const clMax = Math.max(...alphaClValues.map((value) => Math.abs(value)), 1.4)
  const liftCoefFlaps = readSectionNumber(parsed, 'aerodynamics', 'lift_coef_flaps')
  const dragCoefFlaps = readSectionNumber(parsed, 'aerodynamics', 'drag_coef_flaps')
  const dragCoefGear = readSectionNumber(parsed, 'aerodynamics', 'drag_coef_gear')
  const dragCoefSpoilers = readSectionNumber(parsed, 'aerodynamics', 'drag_coef_spoilers')
  const liftCoefSpoilers = readSectionNumber(parsed, 'aerodynamics', 'lift_coef_spoilers')
  const pitchMomentFlaps = readSectionNumber(parsed, 'aerodynamics', 'pitch_moment_flaps')
  const pitchMomentSpoilers = readSectionNumber(parsed, 'aerodynamics', 'pitch_moment_spoilers')

  return {
    flapDetents01,
    defaultFlapDetentIndex: 0,
    flapRatePerSec: 0.1,
    gearRatePerSec: 0.22,
    spoilerRatePerSec: 1.8,
    flapLiftClMax: clamp(liftCoefFlaps > 0 ? liftCoefFlaps * 0.6 : clMax * 0.4, 0.3, 1.5),
    flapDragCdMax: dragCoefFlaps > 0 ? dragCoefFlaps : 0.14,
    flapPitchCmMax: clamp(Math.abs(pitchMomentFlaps), 0.03, 0.5),
    gearDragCdMax: dragCoefGear > 0 ? dragCoefGear : 0.03,
    spoilerDragCdMax: dragCoefSpoilers > 0 ? dragCoefSpoilers : 0.08,
    spoilerLiftLossMax: clamp(Math.abs(liftCoefSpoilers), 0.15, 0.75),
    spoilerPitchCmMax: clamp(Math.abs(pitchMomentSpoilers), 0.01, 0.12),
    flapVisualSchedule
  }
}

function buildFlapVisualSchedule(
  sections: ReturnType<typeof parseMsfsFlapSections>,
  detents01: readonly number[]
): FlapVisualSchedule | undefined {
  if (sections.length < 3) return undefined
  const [trailingOutboard, trailingInboard, leading] = sections
  if (
    trailingOutboard.positions.length !== detents01.length ||
    trailingInboard.positions.length !== detents01.length ||
    leading.positions.length !== detents01.length
  ) {
    return undefined
  }

  return {
    detents01,
    trailingOutboardDeg: trailingOutboard.positions.map((position) => position.angleDeg),
    trailingInboardDeg: trailingInboard.positions.map((position) => position.angleDeg),
    leadingDeg: leading.positions.map((position) => position.angleDeg)
  }
}

function deriveVisualOffset(parsed: ParsedIni): CompatibilityVector3Descriptor {
  const cgPosition = readSectionTuple(parsed, 'weight_and_balance', 'empty_weight_cg_position')
  if (cgPosition.length < 3) {
    return { x: 0, y: 0, z: 0 }
  }

  return {
    x: -cgPosition[0] * FEET_TO_METERS,
    y: -cgPosition[1] * FEET_TO_METERS,
    z: cgPosition[2] * FEET_TO_METERS
  }
}

function parseLookupTable(rawValue: string): CompatibilityLookupTableDescriptor | undefined {
  const entries = rawValue
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(':').map((part) => Number.parseFloat(part.trim())))
    .filter((parts) => parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]))

  if (entries.length < 2) return undefined
  entries.sort((left, right) => left[0] - right[0])
  return {
    breakpoints: entries.map((entry) => entry[0]),
    values: entries.map((entry) => entry[1])
  }
}

function derivePositivePeakBreakpoint(table: CompatibilityLookupTableDescriptor): number | undefined {
  let maxValue = -Infinity
  let breakpoint: number | undefined
  for (let index = 0; index < table.breakpoints.length; index += 1) {
    const candidateBreakpoint = table.breakpoints[index]
    const candidateValue = table.values[index]
    if (candidateBreakpoint < 0) continue
    if (candidateValue > maxValue) {
      maxValue = candidateValue
      breakpoint = candidateBreakpoint
    }
  }

  return breakpoint
}

function derivePositiveBlendDegrees(
  table: CompatibilityLookupTableDescriptor,
  alphaStallDeg: number
): number {
  const positiveBreakpoints = table.breakpoints.filter((breakpoint) => breakpoint > alphaStallDeg)
  if (positiveBreakpoints.length === 0) return 4
  return clamp(positiveBreakpoints[0] - alphaStallDeg, 3, 10)
}

function lookupAtZero(table: CompatibilityLookupTableDescriptor): number {
  const zeroIndex = table.breakpoints.findIndex((breakpoint) => breakpoint === 0)
  if (zeroIndex >= 0) return table.values[zeroIndex] ?? 0

  for (let index = 0; index < table.breakpoints.length - 1; index += 1) {
    const left = table.breakpoints[index]
    const right = table.breakpoints[index + 1]
    if (left > 0 || right < 0) continue

    const fraction = (0 - left) / (right - left)
    return table.values[index] + (table.values[index + 1] - table.values[index]) * fraction
  }

  return table.values[0] ?? 0
}

function deriveSlopePerRad(table: CompatibilityLookupTableDescriptor): number {
  let leftIndex = 0
  let rightIndex = table.breakpoints.length - 1

  for (let index = 0; index < table.breakpoints.length; index += 1) {
    if (table.breakpoints[index] <= 0) {
      leftIndex = index
    }
    if (table.breakpoints[index] >= 0) {
      rightIndex = index
      break
    }
  }

  const leftBreakpoint = table.breakpoints[leftIndex] ?? -5
  const rightBreakpoint = table.breakpoints[rightIndex] ?? 5
  const leftValue = table.values[leftIndex] ?? 0
  const rightValue = table.values[rightIndex] ?? 0
  const deltaDegrees = rightBreakpoint - leftBreakpoint
  if (Math.abs(deltaDegrees) < 1e-6) {
    return DEFAULT_COMPATIBILITY_AIRCRAFT_PHYSICS.aero.CLalphaPerRad
  }

  return ((rightValue - leftValue) / deltaDegrees) * RAD_TO_DEG
}

function buildSymmetricSlopeTable(slopePerRad: number): CompatibilityLookupTableDescriptor {
  const breakpoints = [-30, -20, -10, -5, 0, 5, 10, 20, 30]
  return {
    breakpoints,
    values: breakpoints.map((breakpoint) => slopePerRad * ((breakpoint * Math.PI) / 180))
  }
}

function buildControlEffectivenessTable(baseValue: number): CompatibilityLookupTableDescriptor {
  const breakpoints = [0, 5, 10, 20, 30, 45, 60, 90]
  const falloff = [1, 0.97, 0.9, 0.75, 0.6, 0.42, 0.28, 0.18]
  return {
    breakpoints,
    values: falloff.map((factor) => baseValue * factor)
  }
}

function toVector3(value: CompatibilityVector3Descriptor): Vector3 {
  return new Vector3(value.x, value.y, value.z)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
