import type {
  CanonicalAirPhysicsSystemConfig,
  CanonicalLookupTable1D,
  CanonicalLookupTable2D,
  CanonicalPropulsionEngineConfig,
} from '../sim/engine/aircraft'
import type { ImportedAircraft, ImportedCfgFile, ImportedCfgSection } from './types'

const FEET_TO_METERS = 0.3048
const SQUARE_FEET_TO_SQUARE_METERS = 0.09290304
const POUNDS_TO_KILOGRAMS = 0.45359237
const POUND_FORCE_TO_NEWTONS = 4.4482216152605
const SLUG_FOOT_SQUARED_TO_KG_M2 = 1.355817961894411
const POUNDS_PER_HOUR_TO_KG_PER_SECOND = POUNDS_TO_KILOGRAMS / 3600
const DEG_TO_RAD = Math.PI / 180

export function createMsfsAirPhysicsSystemConfig(
  aircraft: ImportedAircraft
): CanonicalAirPhysicsSystemConfig | null {
  const flightModel = aircraft.cfgFiles.find(file => file.kind === 'flight_model')
  if (flightModel == null) return null
  const weight = findSection(flightModel, 'weight_and_balance')
  const geometry = findSection(flightModel, 'airplane_geometry')
  const aero = findSection(flightModel, 'aerodynamics')
  const tuning = findSection(flightModel, 'flight_tuning')
  if (weight == null || geometry == null || aero == null) return null
  const wingAreaFt2 = readNumber(geometry, 'wing_area')
  const wingSpanFt = readNumber(geometry, 'wing_span')
  const wingRootChordFt = readNumber(geometry, 'wing_root_chord')
  const emptyWeightLb = readNumber(weight, 'empty_weight')
  const maxGrossWeightLb = readNumber(weight, 'max_gross_weight')
  const liftTable = parseLookup1D(readValue(aero, 'lift_coef_aoa_table'))
  if (
    wingAreaFt2 == null || wingSpanFt == null || wingRootChordFt == null ||
    emptyWeightLb == null || maxGrossWeightLb == null || liftTable == null
  ) {
    return null
  }

  const wingAreaM2 = wingAreaFt2 * SQUARE_FEET_TO_SQUARE_METERS
  const wingSpanM = wingSpanFt * FEET_TO_METERS
  const wingRootChordM = wingRootChordFt * FEET_TO_METERS
  const wingTipChordM = Math.max(0.01, 2 * wingAreaM2 / wingSpanM - wingRootChordM)
  const taperRatio = wingTipChordM / wingRootChordM
  const meanChordM = (2 / 3) * wingRootChordM *
    (1 + taperRatio + taperRatio * taperRatio) / (1 + taperRatio)
  const cg = parseNumberList(readValue(weight, 'empty_weight_cg_position')) ?? [0, 0, 0]
  const datum = parseNumberList(readValue(weight, 'reference_datum_position')) ?? [0, 0, 0]
  const cgLongFt = cg[0] ?? 0
  const cgLateralFt = cg[1] ?? 0
  const cgVerticalFt = cg[2] ?? 0
  const modernFlightModel = (readNumber(tuning, 'modern_fm_only') ?? 0) > 0
  const aeroCenterLongFt = readNumber(aero, 'aero_center_lift') ?? cgLongFt
  const wingVerticalFt = readNumber(geometry, 'wing_pos_apex_vert') ?? cgVerticalFt
  const htailLongFt = readNumber(geometry, 'htail_pos_lon')
  const htailVerticalFt = readNumber(geometry, 'htail_pos_vert')
  const vtailLongFt = readNumber(geometry, 'vtail_pos_lon')
  const vtailVerticalFt = readNumber(geometry, 'vtail_pos_vert')
  const fuselageCenter = parseNumberList(readValue(geometry, 'fuselage_center_pos'))
  const elevatorSign = (readNumber(aero, 'pitch_moment_delta_elevator') ?? 1) < 0 ? -1 : 1
  const flapSection = findSection(flightModel, 'flaps.0')

  return {
    emptyMassKg: emptyWeightLb * POUNDS_TO_KILOGRAMS,
    maxGrossMassKg: maxGrossWeightLb * POUNDS_TO_KILOGRAMS,
    inertiaKgM2: [
      (readNumber(weight, 'empty_weight_roll_moi') ?? 1) * SLUG_FOOT_SQUARED_TO_KG_M2,
      (readNumber(weight, 'empty_weight_pitch_moi') ?? 1) * SLUG_FOOT_SQUARED_TO_KG_M2,
      (readNumber(weight, 'empty_weight_yaw_moi') ?? 1) * SLUG_FOOT_SQUARED_TO_KG_M2,
    ],
    geometry: {
      wingAreaM2,
      wingSpanM,
      wingRootChordM,
      wingTipChordM,
      meanChordM,
      wingIncidenceRad: (readNumber(geometry, 'wing_incidence') ?? 0) * DEG_TO_RAD,
      wingDihedralRad: (readNumber(geometry, 'wing_dihedral') ?? 0) * DEG_TO_RAD,
      wingSweepRad: (readNumber(geometry, 'wing_sweep') ?? 0) * DEG_TO_RAD,
      wingTwistRad: (readNumber(geometry, 'wing_twist') ?? 0) * DEG_TO_RAD,
      aerodynamicCenterBodyM: [
        (aeroCenterLongFt - (datum[0] ?? 0) - cgLongFt) * FEET_TO_METERS,
        -cgLateralFt * FEET_TO_METERS,
        -(wingVerticalFt - cgVerticalFt) * FEET_TO_METERS,
      ],
      centerOfMassFromModelOriginBodyM: [
        ((datum[0] ?? 0) + cgLongFt) * FEET_TO_METERS,
        ((datum[1] ?? 0) + cgLateralFt) * FEET_TO_METERS,
        -((datum[2] ?? 0) + cgVerticalFt) * FEET_TO_METERS,
      ],
      oswaldEfficiency: Math.max(readNumber(geometry, 'oswald_efficiency_factor') ?? 0.8, 0.01),
      aileronAreaM2: toSquareMeters(readNumber(geometry, 'aileron_area')),
      horizontalTailAreaM2: toSquareMeters(readNumber(geometry, 'htail_area')),
      horizontalTailSpanM: toMeters(readNumber(geometry, 'htail_span')),
      horizontalTailPositionBodyM:
        htailLongFt == null || htailVerticalFt == null
          ? undefined
          : bodyPositionFromMsfs(
            htailLongFt, 0, htailVerticalFt, cgLongFt, cgLateralFt, cgVerticalFt
          ),
      horizontalTailIncidenceRad: (readNumber(geometry, 'htail_incidence') ?? 0) * DEG_TO_RAD,
      elevatorAreaM2: toSquareMeters(readNumber(geometry, 'elevator_area')),
      verticalTailAreaM2: toSquareMeters(readNumber(geometry, 'vtail_area')),
      verticalTailSpanM: toMeters(readNumber(geometry, 'vtail_span')),
      verticalTailPositionBodyM:
        vtailLongFt == null || vtailVerticalFt == null
          ? undefined
          : bodyPositionFromMsfs(
            vtailLongFt, 0, vtailVerticalFt, cgLongFt, cgLateralFt, cgVerticalFt
          ),
      rudderAreaM2: toSquareMeters(readNumber(geometry, 'rudder_area')),
      fuselageLengthM: toMeters(readNumber(geometry, 'fuselage_length')),
      fuselageDiameterM: toMeters(readNumber(geometry, 'fuselage_diameter')),
      fuselageCenterBodyM: fuselageCenter == null
        ? undefined
        : bodyPositionFromMsfs(
          fuselageCenter[0] ?? 0, fuselageCenter[1] ?? 0, fuselageCenter[2] ?? 0,
          cgLongFt, cgLateralFt, cgVerticalFt
        ),
      bladeElementCount: 24,
    },
    aerodynamics: {
      liftCoefficientByAlphaRad: liftTable,
      liftScalar: readNumber(tuning, 'cruise_lift_scalar') ?? 1,
      pitchMomentByAlphaRad: modernFlightModel
        ? undefined
        : parseLookup1D(readValue(aero, 'pitch_moment_aoa_table')) ?? undefined,
      zeroLiftDragCoefficient: readNumber(aero, 'drag_coef_zero_lift') ?? 0,
      liftCoefficientAtDragZero: readNumber(aero, 'lift_coef_at_drag_zero') ?? 0,
      parasiteDragScalar: readNumber(tuning, 'parasite_drag_scalar') ?? 1,
      inducedDragScalar: readNumber(tuning, 'induced_drag_scalar') ?? 1,
      flapInducedDragScalar: readNumber(tuning, 'flap_induced_drag_scalar') ?? 1,
      machDragCoefficientAdd:
        parseLookup1D(readValue(aero, 'drag_coef_zero_lift_mach_tab')) ?? undefined,
      liftCoefficientMultiplierByMach:
        parseLookup1D(readValue(aero, 'lift_coef_mach_table')) ?? undefined,
      groundEffectLiftMultiplierByMach:
        parseLookup1D(readValue(aero, 'lift_coef_ground_effect_mach_table')) ?? undefined,
      flapLiftCoefficient: readNumber(aero, 'lift_coef_flaps') ?? 0,
      flapDragCoefficient: readNumber(aero, 'drag_coef_flaps') ?? 0,
      gearDragCoefficient: readNumber(aero, 'drag_coef_gear') ?? 0,
      spoilerLiftCoefficient:
        readNumber(aero, 'lift_coef_air_spoilers') ??
        readNumber(aero, 'lift_coef_spoilers') ?? 0,
      spoilerDragCoefficient: readNumber(aero, 'drag_coef_spoilers') ?? 0,
      sideForceSlipAngleCoefficient: legacy(readNumber(aero, 'side_force_slip_angle'), modernFlightModel),
      sideForceRudderCoefficient: legacy(readNumber(aero, 'side_force_delta_rudder'), modernFlightModel),
      fuselageLateralDragCoefficient: modernFlightModel
        ? readNumber(aero, 'fuselage_lateral_cx') ?? 0.4
        : 0,
      pitchMomentZero: legacy(readNumber(aero, 'pitch_moment_aoa_0'), modernFlightModel),
      pitchMomentAlphaCoefficient: 0,
      pitchDampingCoefficient: legacy(readNumber(aero, 'pitch_moment_pitch_damping'), modernFlightModel),
      pitchElevatorCoefficient: legacy(readNumber(aero, 'pitch_moment_delta_elevator'), modernFlightModel),
      pitchFlapCoefficient: legacy(readNumber(aero, 'pitch_moment_flaps'), modernFlightModel),
      pitchGearCoefficient: legacy(readNumber(aero, 'pitch_moment_gear'), modernFlightModel),
      pitchSpoilerCoefficient: legacy(readNumber(aero, 'pitch_moment_spoilers'), modernFlightModel),
      rollSlipAngleCoefficient: legacy(readNumber(aero, 'roll_moment_slip_angle'), modernFlightModel),
      rollDampingCoefficient: legacy(readNumber(aero, 'roll_moment_roll_damping'), modernFlightModel),
      rollAileronCoefficient: legacy(readNumber(aero, 'roll_moment_delta_aileron'), modernFlightModel),
      yawSlipAngleCoefficient: legacy(readNumber(aero, 'yaw_moment_slip_angle'), modernFlightModel),
      yawDampingCoefficient: legacy(readNumber(aero, 'yaw_moment_yaw_damping'), modernFlightModel),
      yawRudderCoefficient: legacy(readNumber(aero, 'yaw_moment_delta_rudder'), modernFlightModel),
    },
    controls: {
      aileronLimitRad: Math.max(
        readNumber(geometry, 'aileron_up_limit') ?? 0,
        readNumber(geometry, 'aileron_down_limit') ?? 0
      ) * DEG_TO_RAD,
      elevatorLimitRad: Math.max(
        readNumber(geometry, 'elevator_up_limit') ?? 0,
        readNumber(geometry, 'elevator_down_limit') ?? 0
      ) * (readNumber(tuning, 'elevator_maxangle_scalar') ?? 1) * DEG_TO_RAD,
      rudderLimitRad:
        (readNumber(geometry, 'rudder_limit') ?? 0) *
        (readNumber(tuning, 'rudder_maxangle_scalar') ?? 1) * DEG_TO_RAD,
      aileronEffectiveness: readNumber(tuning, 'aileron_effectiveness') ?? 1,
      elevatorEffectiveness: readNumber(tuning, 'elevator_effectiveness') ?? 1,
      rudderEffectiveness: readNumber(tuning, 'rudder_effectiveness') ?? 1,
      elevatorLiftCoefficientSlopePerRad: readNumber(aero, 'elevator_lift_coef') ?? 5,
      elevatorDeflectionSign: elevatorSign,
      elevatorTrimUpLimitRad: resolveElevatorTrimLimitRad(geometry, 'up'),
      elevatorTrimDownLimitRad: resolveElevatorTrimLimitRad(geometry, 'down'),
      elevatorTrimEffectiveness: readNumber(tuning, 'elevator_trim_effectiveness') ?? 1,
      rudderLiftCoefficientSlopePerRad: readNumber(aero, 'rudder_lift_coef') ?? 5,
      rudderTrimLimitRad: (readNumber(geometry, 'rudder_trim_limit') ?? 0) * DEG_TO_RAD,
      rudderTrimEffectiveness: readNumber(tuning, 'rudder_trim_effectiveness') ?? 1,
      aileronTrimEffectiveness: readNumber(tuning, 'aileron_trim_effectiveness') ?? 1,
      flapSpanOutboardRatio: readNumber(flapSection, 'span-outboard') ?? 1,
    },
    wingFlex: {
      scalar: readNumber(tuning, 'wingflex_scalar') ?? 1,
      offset: readNumber(tuning, 'wingflex_offset') ?? 0,
      surfaceScalar: readNumber(tuning, 'wingflex_surface_scalar') ?? undefined,
    },
  }
}

export function addMsfsPropulsionPhysicsMetadata(
  engines: readonly CanonicalPropulsionEngineConfig[],
  aircraft: ImportedAircraft
): readonly CanonicalPropulsionEngineConfig[] {
  const enginesCfg = aircraft.cfgFiles.find(file => file.kind === 'engines')
  if (enginesCfg == null) return engines
  const general = findSection(enginesCfg, 'generalenginedata')
  const turbine = findSection(enginesCfg, 'turbineenginedata')
  const jet = findSection(enginesCfg, 'jet_engine')
  const flightModel = aircraft.cfgFiles.find(file => file.kind === 'flight_model')
  const weight = findSection(flightModel, 'weight_and_balance')
  const cg = parseNumberList(readValue(weight, 'empty_weight_cg_position')) ?? [0, 0, 0]
  const thrustTable = parseLookup2D(readValue(turbine, 'n1_and_mach_on_thrust_table'))
  const correctedAirflowTable = parseLookup2D(readValue(turbine, 'corrected_airflow_table'))
  const commandedNeLowMach = parseMachLookup2D(
    readValue(turbine, 'mach_0_corrected_commanded_ne_table')
  )
  const commandedNeHighMach = parseMachLookup2D(
    readValue(turbine, 'mach_hi_corrected_commanded_ne_table')
  )
  const n2ToN1Table = parseLookup2D(readValue(turbine, 'n2_to_n1_table'))
  const staticThrustLb = readNumber(turbine, 'static_thrust')
  const idleFlowLbPerHour = readNumber(turbine, 'idle_fuel_flow')
  const highFlowLbPerHour = readNumber(turbine, 'high_fuel_flow')
  return engines.map((engine, offset) => {
    const position = parseNumberList(readValue(general, `engine.${offset}`))
    const angles = parseNumberList(readValue(general, `thrustanglespitchheading.${offset}`))
    return {
      ...engine,
      highN1Percent: readNumber(turbine, 'high_n1') ?? 100,
      n1NormalIntegrationRate: readNumber(turbine, 'n1_normal_tc') ?? undefined,
      staticThrustN: staticThrustLb == null ? undefined : staticThrustLb * POUND_FORCE_TO_NEWTONS,
      thrustScalar: readNumber(jet, 'thrust_scalar') ?? 1,
      machInfluenceOnN1: readNumber(turbine, 'mach_influence_on_n1') ?? 0,
      useCommandedNeTable: (readNumber(turbine, 'use_commanded_ne_table') ?? 0) > 0,
      commandedNeLowMach: commandedNeLowMach ?? undefined,
      commandedNeHighMach: commandedNeHighMach ?? undefined,
      useN2ToN1Table: (readNumber(turbine, 'use_n2_to_n1_table') ?? 0) > 0,
      n2ToN1ByCorrectedN2AndMach: n2ToN1Table ?? undefined,
      starterN1Percent: readNumber(turbine, 'starter_n1_max_pct') ?? engine.starterN1Percent,
      starterN1RatePercentPerSecond: readNumber(turbine, 'starter_n1_rate') ?? undefined,
      minN1ForCombustionPercent: readNumber(turbine, 'min_n1_for_combustion') ?? undefined,
      thrustByCorrectedN1AndMach: thrustTable ?? undefined,
      correctedAirflowByCorrectedN1AndMach: correctedAirflowTable ?? undefined,
      inletAreaM2: toSquareMeters(readNumber(turbine, 'inlet_area')),
      supersonicRamDrag: (readNumber(turbine, 'supersonic_ram_drag') ?? 0) > 0,
      variableInlet: (readNumber(turbine, 'variable_inlet') ?? 0) > 0,
      supersonicInlet: (readNumber(turbine, 'supersonic_inlet') ?? 0) > 0,
      supersonicInletDesignMach: readNumber(turbine, 'supersonic_inlet_design_mach') ?? undefined,
      positionBodyM: position == null
        ? undefined
        : bodyPositionFromMsfs(
          position[0] ?? 0,
          position[1] ?? 0,
          position[2] ?? 0,
          cg[0] ?? 0,
          cg[1] ?? 0,
          cg[2] ?? 0
        ),
      thrustDirectionBody: thrustDirectionFromPitchHeading(
        angles?.[0] ?? 0,
        angles?.[1] ?? 0
      ),
      idleFuelFlowKgPerSecond:
        idleFlowLbPerHour == null ? undefined : idleFlowLbPerHour * POUNDS_PER_HOUR_TO_KG_PER_SECOND,
      highFuelFlowKgPerSecond:
        highFlowLbPerHour == null ? undefined : highFlowLbPerHour * POUNDS_PER_HOUR_TO_KG_PER_SECOND,
    }
  })
}
function findSection(
  file: ImportedCfgFile | undefined,
  name: string
): ImportedCfgSection | undefined {
  const normalized = name.toLowerCase()
  return file?.sections.find(section => section.name.toLowerCase() === normalized)
}

function readValue(
  section: ImportedCfgSection | undefined,
  key: string
): string | undefined {
  return section?.values.get(key.toLowerCase())
}

function readNumber(
  section: ImportedCfgSection | undefined,
  key: string
): number | null {
  const value = readValue(section, key)
  if (value == null) return null
  const match = /[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/iu.exec(value)
  if (match == null) return null
  const parsed = Number.parseFloat(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function parseNumberList(value: string | undefined): number[] | null {
  if (value == null) return null
  const values = value.split(',').map(entry => Number.parseFloat(entry.trim()))
  return values.length > 0 && values.every(Number.isFinite) ? values : null
}
export function parseMsfsLookup1D(value: string | undefined): CanonicalLookupTable1D | null {
  return parseLookup1D(value)
}

function parseLookup1D(value: string | undefined): CanonicalLookupTable1D | null {
  if (value == null) return null
  const pairs = value.split(',').map(entry => entry.trim()).filter(Boolean)
  const breakpoints: number[] = []
  const values: number[] = []
  for (const pair of pairs) {
    const [rawX, rawY] = pair.split(':')
    const x = Number.parseFloat(rawX ?? '')
    const y = Number.parseFloat(rawY ?? '')
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    breakpoints.push(x)
    values.push(y)
  }
  return breakpoints.length >= 1 ? { breakpoints, values } : null
}

function parseMachLookup2D(
  value: string | undefined
): { readonly mach: number; readonly table: CanonicalLookupTable2D } | null {
  if (value == null) return null
  const firstToken = value.split(',', 1)[0]?.split(':', 1)[0]?.trim() ?? ''
  const mach = Number.parseFloat(firstToken)
  const table = parseLookup2D(value)
  return Number.isFinite(mach) && table != null ? { mach, table } : null
}

export function parseMsfsLookup2D(value: string | undefined): CanonicalLookupTable2D | null {
  return parseLookup2D(value)
}

function parseLookup2D(value: string | undefined): CanonicalLookupTable2D | null {
  if (value == null) return null
  const rows = value.split(',').map(row =>
    row.split(':').map(entry => Number.parseFloat(entry.trim()))
  )
  if (rows.length < 2 || rows.some(row => row.some(number => !Number.isFinite(number)))) return null
  const breakpointsX = rows[0].slice(1)
  if (breakpointsX.length === 0) return null
  const breakpointsY: number[] = []
  const values: number[] = []
  for (const row of rows.slice(1)) {
    if (row.length < breakpointsX.length + 1) return null
    breakpointsY.push(row[0])
    values.push(...row.slice(1, breakpointsX.length + 1))
  }
  return breakpointsY.length > 0
    ? { breakpointsX, breakpointsY, values }
    : null
}

function resolveElevatorTrimLimitRad(
  geometry: ImportedCfgSection,
  direction: 'up' | 'down'
): number {
  const directional = readNumber(geometry, `elevator_trim_${direction}_limit`)
  const common = readNumber(geometry, 'elevator_trim_limit')
  return Math.max(0, directional ?? common ?? 0) * DEG_TO_RAD
}

function bodyPositionFromMsfs(
  longitudinalFt: number,
  lateralFt: number,
  verticalFt: number,
  cgLongitudinalFt: number,
  cgLateralFt: number,
  cgVerticalFt: number
): readonly [number, number, number] {
  return [
    (longitudinalFt - cgLongitudinalFt) * FEET_TO_METERS,
    (lateralFt - cgLateralFt) * FEET_TO_METERS,
    -(verticalFt - cgVerticalFt) * FEET_TO_METERS,
  ]
}

function thrustDirectionFromPitchHeading(
  pitchDegrees: number,
  headingDegrees: number
): readonly [number, number, number] {
  const pitch = pitchDegrees * DEG_TO_RAD
  const heading = headingDegrees * DEG_TO_RAD
  const cosPitch = Math.cos(pitch)
  return [
    cosPitch * Math.cos(heading),
    cosPitch * Math.sin(heading),
    -Math.sin(pitch),
  ]
}

function toMeters(value: number | null): number | undefined {
  return value == null ? undefined : value * FEET_TO_METERS
}

function toSquareMeters(value: number | null): number | undefined {
  return value == null ? undefined : value * SQUARE_FEET_TO_SQUARE_METERS
}

function legacy(value: number | null, modernFlightModel: boolean): number {
  return modernFlightModel ? 0 : value ?? 0
}
