import { lookup2D } from '../LookupTable'
import type { CanonicalPropulsionEngineConfig } from './aircraft'

const SEA_LEVEL_TEMPERATURE_K = 288.15
const SEA_LEVEL_PRESSURE_PA = 101_325
const SQUARE_METERS_TO_SQUARE_FEET = 10.76391041671
const SLUG_TO_KILOGRAMS = 14.5939029372

export interface JetEngineEnvironment {
  readonly temperatureK: number
  readonly pressurePa: number
  readonly mach: number
  readonly trueAirspeedMps: number
}

export interface JetEngineCorrectedState {
  readonly inletMach: number
  readonly thetaTotal: number
  readonly deltaTotal: number
}

export function computeJetCorrectedState(
  engine: CanonicalPropulsionEngineConfig,
  environment: JetEngineEnvironment
): JetEngineCorrectedState {
  const mach = Math.max(0, environment.mach)
  const inletMach = Math.min(mach, resolveInletMachLimit(engine))
  const thetaTotal =
    Math.max(environment.temperatureK, 1) / SEA_LEVEL_TEMPERATURE_K *
    (1 + 0.2 * inletMach * inletMach)
  const pressureRatio = Math.max(environment.pressurePa, 1) / SEA_LEVEL_PRESSURE_PA
  const deltaMach = engine.supersonicInlet === true ? mach : inletMach
  const deltaTotal =
    Math.max(0.05, pressureRatio) *
    Math.pow(1 + 0.2 * deltaMach * deltaMach, 3.5) *
    computeSupersonicMachLoss(engine, mach)
  return { inletMach, thetaTotal, deltaTotal }
}

export function computeJetCommandedN1Percent(
  engine: CanonicalPropulsionEngineConfig,
  throttleRatio: number,
  environment: JetEngineEnvironment
): number {
  const throttle = Math.max(0, Math.min(1, throttleRatio))
  const idleN1 = engine.idleN1Percent ?? 25
  if (
    engine.useCommandedNeTable !== true ||
    engine.commandedNeLowMach == null ||
    engine.commandedNeHighMach == null
  ) {
    return idleN1 + (100 - idleN1) * throttle
  }

  const corrected = computeJetCorrectedState(engine, environment)
  const inverseDelta = SEA_LEVEL_PRESSURE_PA / Math.max(environment.pressurePa, 1)
  const low = lookup2D(
    clampToBreakpoints(inverseDelta, engine.commandedNeLowMach.table.breakpointsX),
    clampToBreakpoints(throttle, engine.commandedNeLowMach.table.breakpointsY),
    engine.commandedNeLowMach.table
  )
  const high = lookup2D(
    clampToBreakpoints(inverseDelta, engine.commandedNeHighMach.table.breakpointsX),
    clampToBreakpoints(throttle, engine.commandedNeHighMach.table.breakpointsY),
    engine.commandedNeHighMach.table
  )
  const machSpan = engine.commandedNeHighMach.mach - engine.commandedNeLowMach.mach
  const machRatio = Math.abs(machSpan) <= 1e-9
    ? 0
    : (corrected.inletMach - engine.commandedNeLowMach.mach) / machSpan
  const commandedNe = low + (high - low) * machRatio
  let correctedN1: number
  if (engine.useN2ToN1Table === true && engine.n2ToN1ByCorrectedN2AndMach != null) {
    correctedN1 = lookup2D(
      clampToBreakpoints(corrected.inletMach, engine.n2ToN1ByCorrectedN2AndMach.breakpointsX),
      clampToBreakpoints(commandedNe, engine.n2ToN1ByCorrectedN2AndMach.breakpointsY),
      engine.n2ToN1ByCorrectedN2AndMach
    )
  } else {
    correctedN1 = commandedNe + Math.max(0, (engine.machInfluenceOnN1 ?? 0) * corrected.inletMach)
  }
  return Math.max(0, correctedN1 * Math.sqrt(corrected.thetaTotal))
}

export function computeJetThrustN(
  engine: CanonicalPropulsionEngineConfig,
  n1Percent: number,
  environment: JetEngineEnvironment
): number {
  const staticThrustN = Math.max(0, engine.staticThrustN ?? 0)
  if (staticThrustN === 0 || n1Percent <= 0) return 0
  const corrected = computeJetCorrectedState(engine, environment)
  const correctedN1 = n1Percent / Math.sqrt(Math.max(corrected.thetaTotal, 1e-9))
  const table = engine.thrustByCorrectedN1AndMach
  const multiplier = table == null
    ? Math.max(0, correctedN1 / Math.max(engine.highN1Percent ?? 100, 1))
    : Math.max(0, lookup2D(
      clampToBreakpoints(corrected.inletMach, table.breakpointsX),
      clampToBreakpoints(correctedN1, table.breakpointsY),
      table
    ))
  const grossThrustN =
    staticThrustN *
    Math.max(0, engine.thrustScalar ?? 1) *
    multiplier *
    corrected.deltaTotal
  return Math.max(0, grossThrustN - computeJetRamDragN(
    engine,
    correctedN1,
    environment,
    corrected
  ))
}

export function computeJetRamDragN(
  engine: CanonicalPropulsionEngineConfig,
  correctedN1Percent: number,
  environment: JetEngineEnvironment,
  correctedState = computeJetCorrectedState(engine, environment)
): number {
  const table = engine.correctedAirflowByCorrectedN1AndMach
  const inletAreaM2 = Math.max(0, engine.inletAreaM2 ?? 0)
  if (table == null || inletAreaM2 === 0 || environment.trueAirspeedMps <= 0) return 0
  const airflowMach = engine.supersonicRamDrag === true
    ? Math.max(0, environment.mach)
    : correctedState.inletMach
  const normalizedAirflow = Math.max(0, lookup2D(
    clampToBreakpoints(airflowMach, table.breakpointsX),
    clampToBreakpoints(correctedN1Percent, table.breakpointsY),
    table
  ))
  if (normalizedAirflow === 0) return 0

  const correctedMassFlowKgPerSecond =
    normalizedAirflow *
    inletAreaM2 * SQUARE_METERS_TO_SQUARE_FEET *
    SLUG_TO_KILOGRAMS
  const airflowThetaTotal =
    Math.max(environment.temperatureK, 1) / SEA_LEVEL_TEMPERATURE_K *
    (1 + 0.2 * environment.mach * environment.mach)
  const massFlowKgPerSecond =
    correctedMassFlowKgPerSecond *
    correctedState.deltaTotal /
    Math.sqrt(Math.max(airflowThetaTotal, 1e-9))
  return massFlowKgPerSecond * environment.trueAirspeedMps
}
function resolveInletMachLimit(engine: CanonicalPropulsionEngineConfig): number {
  if (engine.supersonicInlet === true) {
    return Math.max(0, engine.supersonicInletDesignMach ?? 0.5)
  }
  return engine.variableInlet === true ? 0.5 : 1
}

function computeSupersonicMachLoss(
  engine: CanonicalPropulsionEngineConfig,
  mach: number
): number {
  if (engine.supersonicInlet !== true || mach < 1) return 1
  return Math.max(0, 1 - 0.075 * Math.pow(mach - 1, 1.35))
}

function clampToBreakpoints(value: number, breakpoints: readonly number[]): number {
  if (breakpoints.length === 0) return value
  return Math.max(breakpoints[0], Math.min(breakpoints.at(-1) ?? breakpoints[0], value))
}
