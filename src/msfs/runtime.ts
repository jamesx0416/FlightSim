import { AnimationMixer, type Object3D } from 'three'

import { evaluateCompiledExpression } from './rpn'
import type {
  CompiledBehaviorSet,
  CompiledUpdateBinding,
  ImportedAircraft,
  ImportedCfgFile,
  ImportedCfgSection,
  ImportDiagnostic,
  RuntimeHostServices,
  RuntimeState
} from './types'

export class AircraftRuntime {
  private readonly mixer: AnimationMixer
  private readonly actions = new Map<string, ReturnType<AnimationMixer['clipAction']>>()
  private readonly nodes = new Map<string, Object3D>()
  private readonly animationValues = new Map<string, number>()
  private readonly nodeVisibilities = new Map<string, boolean>()
  private readonly updateState = new Map<CompiledUpdateBinding, { elapsedSeconds: number; ranOnce: boolean }>()

  constructor(
    private readonly compiled: CompiledBehaviorSet,
    private readonly sceneRoot: Object3D,
    private readonly hostServices: RuntimeHostServices
  ) {
    this.mixer = new AnimationMixer(sceneRoot)

    sceneRoot.traverse(node => {
      if (node.name) {
        this.nodes.set(node.name, node)
        this.nodes.set(node.name.toLowerCase(), node)
      }
    })
  }

  bindAnimations(clips: readonly { readonly name: string }[]): void {
    for (const binding of this.compiled.animationBindings) {
      const clip = clips.find(candidate => candidate.name === binding.target)
      if (clip == null) continue
      const action = this.mixer.clipAction(clip as never)
      action.enabled = true
      action.play()
      action.paused = true
      this.actions.set(binding.target, action)
    }
  }

  update(dtSeconds: number): RuntimeState {
    this.hostServices.tick(dtSeconds)
    this.runUpdateBindings(dtSeconds)

    for (const binding of this.compiled.animationBindings) {
      const evaluatedValue = evaluateCompiledExpression(binding.expression, {
        readVariable: (key, unit) => this.hostServices.readVariable(key, unit),
        writeVariable: (key, nextValue, unit) => this.hostServices.writeVariable(key, nextValue, unit)
      })
      const previousValue = this.animationValues.get(binding.target) ?? 0
      const rawValue = binding.delta ? previousValue + evaluatedValue : evaluatedValue
      const value =
        binding.lagFramesPerSecond > 0
          ? moveTowards(previousValue, rawValue, binding.lagFramesPerSecond * dtSeconds)
          : rawValue
      this.animationValues.set(binding.target, value)

      const action = this.actions.get(binding.target)
      if (action != null) {
        const duration = action.getClip().duration || 1
        const normalizedValue = binding.wrap
          ? positiveModulo(value, binding.length) / binding.length
          : clamp(value / binding.length, 0, 1)
        action.time = normalizedValue * duration
      }
    }

    this.mixer.update(0)

    for (const binding of this.compiled.visibilityBindings) {
      const isVisible =
        evaluateCompiledExpression(binding.expression, {
          readVariable: (key, unit) => this.hostServices.readVariable(key, unit),
          writeVariable: (key, nextValue, unit) => this.hostServices.writeVariable(key, nextValue, unit)
        }) !== 0

      this.nodeVisibilities.set(binding.target, isVisible)
      const node =
        this.nodes.get(binding.target) ??
        this.nodes.get(binding.target.toLowerCase())
      if (node != null) {
        node.visible = isVisible
      }
    }

    return {
      irVersion: 'msfs-runtime/v1',
      animationValues: new Map(this.animationValues),
      nodeVisibilities: new Map(this.nodeVisibilities),
      diagnostics: this.compiled.diagnostics
    }
  }

  private runUpdateBindings(dtSeconds: number): void {
    for (const binding of this.compiled.updateBindings) {
      const state = this.updateState.get(binding) ?? { elapsedSeconds: 0, ranOnce: false }
      if (binding.once && state.ranOnce) {
        continue
      }

      state.elapsedSeconds += dtSeconds
      const updateInterval = binding.frequency > 0 ? 1 / binding.frequency : 0
      if (!binding.once && updateInterval > 0 && state.elapsedSeconds + 1e-9 < updateInterval) {
        this.updateState.set(binding, state)
        continue
      }

      if (!binding.once && updateInterval > 0) {
        state.elapsedSeconds %= updateInterval
      } else {
        state.elapsedSeconds = 0
      }

      evaluateCompiledExpression(binding.expression, {
        readVariable: (key, unit) => this.hostServices.readVariable(key, unit),
        writeVariable: (key, nextValue, unit) => this.hostServices.writeVariable(key, nextValue, unit)
      })

      state.ranOnce = true
      this.updateState.set(binding, state)
    }
  }
}

export class DemoRuntimeHost implements RuntimeHostServices {
  private elapsedSeconds = 0
  private readonly values = new Map<string, number>()
  private readonly engineProfile: DemoEngineProfile
  private readonly wingFlexProfile: DemoWingFlexProfile
  private cycles: {
    readonly gearCycle: number
    readonly flapCycle: number
    readonly spoilerCycle: number
    readonly engineCycle: number
    readonly aileronCycle: number
    readonly elevatorCycle: number
    readonly rudderCycle: number
    readonly reverserCycle: number
    readonly dtSeconds: number
  } = {
    gearCycle: 0,
    flapCycle: 0,
    spoilerCycle: 0,
    engineCycle: 55,
    aileronCycle: 0,
    elevatorCycle: 0,
    rudderCycle: 0,
    reverserCycle: 0,
    dtSeconds: 0
  }

  constructor(
    private readonly diagnostics: ImportDiagnostic[],
    aircraft?: ImportedAircraft
  ) {
    this.engineProfile = createDemoEngineProfile(aircraft)
    this.wingFlexProfile = createDemoWingFlexProfile(aircraft)
  }

  tick(dtSeconds: number): void {
    this.elapsedSeconds += dtSeconds
    this.cycles = {
      // Default the standalone viewer to a stable in-flight cruise pose.
      gearCycle: 0,
      flapCycle: 0,
      spoilerCycle: 0,
      engineCycle: this.engineProfile.cruiseN1Percent,
      aileronCycle: 0,
      elevatorCycle: 0,
      rudderCycle: 0,
      reverserCycle: 0,
      dtSeconds
    }

    this.values.set('A:ANIMATION DELTA TIME', dtSeconds)
    this.values.set('A:GEAR ANIMATION POSITION:0', this.cycles.gearCycle * 100)
    this.values.set('A:GEAR ANIMATION POSITION:1', this.cycles.gearCycle * 100)
    this.values.set('A:GEAR ANIMATION POSITION:2', this.cycles.gearCycle * 100)

    for (const [key] of this.values) {
      this.values.set(key, this.resolveHeuristicValue(key, null, this.cycles).value)
    }
  }

  readVariable(key: string, unit?: string | null): number {
    if (!this.values.has(key)) {
      const resolved = this.resolveHeuristicValue(key, unit ?? null, this.cycles)

      this.values.set(key, resolved.value)
      if (!resolved.handled) {
        this.diagnostics.push({
          code: 'runtime_variable_defaulted',
          message: `Variable ${key} is not provided by the demo host and defaulted to 0.`,
          severity: 'info'
        })
      }
    }

    return this.values.get(key) ?? 0
  }

  writeVariable(key: string, value: number, _unit?: string | null): void {
    this.values.set(key, value)
  }

  invokeKeyEvent(name: string, args: readonly number[]): void {
    this.values.set(`K:${name}`, args.at(-1) ?? 0)
  }

  private resolveHeuristicValue(
    key: string,
    unit: string | null,
    cycles: {
      readonly gearCycle: number
      readonly flapCycle: number
      readonly spoilerCycle: number
      readonly engineCycle: number
      readonly aileronCycle: number
      readonly elevatorCycle: number
      readonly rudderCycle: number
      readonly reverserCycle: number
      readonly dtSeconds: number
    }
  ): { readonly handled: boolean; readonly value: number } {
    const upperKey = key.toUpperCase()

    if (upperKey === 'A:ANIMATION DELTA TIME') return handled(convertTimeUnit(cycles.dtSeconds, unit))
    if (upperKey === 'A:SIM ON GROUND') return handled(0)
    if (upperKey === 'A:SURFACE RELATIVE GROUND SPEED') return handled(0)
    if (upperKey === 'A:LIGHT BEACON') return handled(1)
    if (upperKey.startsWith('O:')) return handled(this.values.get(key) ?? 0)
    if (upperKey.startsWith('A:CIRCUIT ON:')) return handled(1)
    if (upperKey.startsWith('A:CIRCUIT POWER SETTING:')) return handled(convertPercentUnit(100, unit))
    if (upperKey.startsWith('A:CIRCUIT CONNECTION ON:')) return handled(1)
    if (upperKey.startsWith('A:INTERACTIVE POINT OPEN:')) return handled(convertPercentUnit(0, unit))
    if (upperKey === 'A:WING FLEX PCT') {
      return handled(convertPercentOver100Unit(this.wingFlexProfile.baseFlexPct, unit))
    }
    if (upperKey.startsWith('A:WING FLEX PCT:')) {
      const sideIndex = Number.parseInt(upperKey.split(':').at(-1) ?? '0', 10)
      const flexPct =
        sideIndex === 1 ? this.wingFlexProfile.leftFlexPct
        : sideIndex === 2 ? this.wingFlexProfile.rightFlexPct
        : this.wingFlexProfile.baseFlexPct
      return handled(convertPercentOver100Unit(flexPct, unit))
    }
    if (upperKey.startsWith('A:GEAR STEER ANGLE:')) return handled(0)
    if (upperKey.startsWith('A:GENERAL ENG RPM:')) {
      return handled(convertRpmUnit(cycles.engineCycle, unit))
    }
    if (upperKey.startsWith('A:PROP RPM:')) {
      return handled(convertRpmUnit(cycles.engineCycle, unit))
    }
    if (upperKey.startsWith('A:GENERAL ENG THROTTLE LEVER POSITION:')) {
      return handled(convertPercentUnit(this.engineProfile.cruisePowerPercent, unit))
    }
    if (upperKey.startsWith('A:GENERAL ENG REVERSE THRUST ENGAGED:')) return handled(0)
    if (upperKey.includes('ENGINE_N1')) return handled(convertPercentUnit(cycles.engineCycle, unit))
    if (upperKey.includes('REVERSER')) return handled(convertPercentUnit(cycles.reverserCycle * 100, unit))
    if (upperKey.includes('AILERON_LEFT')) return handled(toRequestedControlUnit(cycles.aileronCycle, unit))
    if (upperKey.includes('AILERON_RIGHT')) return handled(toRequestedControlUnit(-cycles.aileronCycle, unit))
    if (upperKey.includes('AILERON')) return handled(toRequestedControlUnit(cycles.aileronCycle, unit))
    if (upperKey.includes('ELEVATOR_LEFT')) return handled(toRequestedControlUnit(cycles.elevatorCycle, unit))
    if (upperKey.includes('ELEVATOR_RIGHT')) return handled(toRequestedControlUnit(cycles.elevatorCycle, unit))
    if (upperKey.includes('ELEVATOR')) return handled(toRequestedControlUnit(cycles.elevatorCycle, unit))
    if (upperKey.includes('HYD_AILERON_LEFT_DEFLECTION')) return handled(convertPercentUnit(cycles.aileronCycle * 100, unit))
    if (upperKey.includes('HYD_AILERON_RIGHT_DEFLECTION')) return handled(convertPercentUnit(-cycles.aileronCycle * 100, unit))
    if (upperKey.includes('RUDDER')) return handled(cycles.rudderCycle)
    if (upperKey.includes('SPOILER_LEFT')) return handled(convertPercentUnit(cycles.spoilerCycle * 100, unit))
    if (upperKey.includes('SPOILER_RIGHT')) return handled(convertPercentUnit(cycles.spoilerCycle * 100, unit))
    if (upperKey.includes('SPOILER')) return handled(convertPercentUnit(cycles.spoilerCycle * 100, unit))
    if (upperKey.includes('SLAT')) return handled(convertPercentUnit(cycles.flapCycle * 100, unit))
    if (upperKey.includes('FLAP')) return handled(convertPercentUnit(cycles.flapCycle * 100, unit))
    if (/^L:LANDING_\d+_RETRACTED$/u.test(upperKey)) return handled(1)
    if (upperKey.endsWith('_NOSE_WHEEL_POSITION')) return handled(0)
    if (upperKey.endsWith('_MODEL_CONES_ENABLED')) return handled(0)
    if (upperKey.endsWith('_IS_STATIONARY')) return handled(0)
    if (upperKey.endsWith('_SATCOM_ENABLED')) return handled(0)
    if (upperKey.endsWith('_PARK_BRAKE_LEVER_POS')) return handled(0)
    if (upperKey.endsWith('_GND_FLT_SVC_BUS_IS_POWERED')) return handled(1)
    if (upperKey.includes('GSX') && upperKey.endsWith('DEPARTURE_STATE')) return handled(0)
    if (upperKey.includes('WHEELCHOCK')) return handled(0)
    if (/^A:(CENTER|LEFT|RIGHT) WHEEL RPM$/u.test(upperKey)) return handled(0)
    if (/^A:(CENTER|LEFT|RIGHT) WHEEL ROTATION ANGLE$/u.test(upperKey)) return handled(0)
    if (upperKey.includes('GEAR') && upperKey.includes('POSITION')) {
      return handled(convertPercentUnit(cycles.gearCycle * 100, unit))
    }
    if (upperKey.includes('DOOR')) return handled(convertPercentUnit(cycles.gearCycle * 100, unit))

    return {
      handled: false,
      value: this.values.get(key) ?? 0
    }
  }
}

function toRequestedControlUnit(value: number, unit: string | null): number {
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit === 'percent' || normalizedUnit === 'pct') {
    return value * 100
  }
  if (normalizedUnit === 'percent over 100') {
    return value
  }
  return value
}

function convertPercentUnit(value: number, unit: string | null): number {
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit === 'percent over 100') {
    return value / 100
  }
  return value
}

function convertPercentOver100Unit(value: number, unit: string | null): number {
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit === 'percent' || normalizedUnit === 'pct') {
    return value * 100
  }
  return value
}

function convertRpmUnit(valueRpm: number, unit: string | null): number {
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit === 'degrees per second') {
    return valueRpm * 6
  }
  return valueRpm
}

function convertTimeUnit(valueSeconds: number, unit: string | null): number {
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit === 'seconds' || normalizedUnit === '') {
    return valueSeconds
  }
  return valueSeconds
}

function normalizeUnit(unit: string | null): string {
  return unit?.trim().toLowerCase() ?? ''
}

function handled(value: number): { readonly handled: true; readonly value: number } {
  return {
    handled: true,
    value
  }
}

interface DemoEngineProfile {
  readonly cruiseN1Percent: number
  readonly cruisePowerPercent: number
}

interface DemoWingFlexProfile {
  readonly baseFlexPct: number
  readonly leftFlexPct: number
  readonly rightFlexPct: number
}

function createDemoEngineProfile(aircraft?: ImportedAircraft): DemoEngineProfile {
  const enginesCfg = aircraft?.cfgFiles.find(file => file.kind === 'engines')
  const targetPerformanceCfg = aircraft?.cfgFiles.find(file => file.kind === 'target_performance')
  const generalEngineData = findCfgSection(enginesCfg, 'GENERALENGINEDATA')
  const turbineEngineData = findCfgSection(enginesCfg, 'TURBINEENGINEDATA')

  const lowIdleN1 = parseCfgNumber(turbineEngineData, 'low_idle_n1', 19.6)
  const highN1 = parseCfgNumber(turbineEngineData, 'high_n1', 101)
  const hasCruiseReference =
    findCfgValue(targetPerformanceCfg, 'TARGET_PERFORMANCE', 'cruise_speed_level_flight_75pctpower') != null
  const cruisePowerPercent = hasCruiseReference ? 75 : 60
  const cruisePowerFraction = cruisePowerPercent / 100

  const configuredEngineCount = countCfgKeys(generalEngineData, /^engine\.\d+$/iu)
  const normalizedLowIdleN1 = clamp(lowIdleN1, 0, highN1)
  const normalizedHighN1 = Math.max(normalizedLowIdleN1, highN1)
  const cruiseN1Percent = clamp(
    normalizedLowIdleN1 + (normalizedHighN1 - normalizedLowIdleN1) * cruisePowerFraction,
    normalizedLowIdleN1,
    normalizedHighN1
  )

  return {
    cruiseN1Percent: configuredEngineCount > 0 ? cruiseN1Percent : 55,
    cruisePowerPercent
  }
}

function createDemoWingFlexProfile(aircraft?: ImportedAircraft): DemoWingFlexProfile {
  const flightModel = aircraft?.cfgFiles.find(file => file.kind === 'flight_model')
  const flightDynamics = flightModel == null
    ? undefined
    : findCfgSection(flightModel, 'flight_tuning') ?? findCfgSection(flightModel, 'flight_tuning.0')
  const aerodynamics = flightModel == null
    ? undefined
    : findCfgSection(flightModel, 'aerodynamics') ?? findCfgSection(flightModel, 'aerodynamics.0')

  const scalar = parseCfgNumber(
    aerodynamics ?? flightDynamics,
    'wingflex_scalar',
    1
  )
  const offset = parseCfgNumber(
    aerodynamics ?? flightDynamics,
    'wingflex_offset',
    0
  )

  // Without a real flight-model backend, keep the synthetic viewer at the documented
  // neutral baseline and apply only the aircraft-authored simvar scaling/offset.
  const baseFlexPct = offset + scalar * 0

  return {
    baseFlexPct,
    leftFlexPct: baseFlexPct,
    rightFlexPct: baseFlexPct
  }
}

function findCfgSection(
  file: ImportedCfgFile | undefined,
  sectionName: string
): ImportedCfgSection | undefined {
  if (file == null) return undefined
  const normalizedSectionName = sectionName.toUpperCase()
  return file.sections.find(section => section.name.toUpperCase() === normalizedSectionName)
}

function findCfgValue(
  file: ImportedCfgFile | undefined,
  sectionName: string,
  keyName: string
): string | undefined {
  const section = findCfgSection(file, sectionName)
  if (section == null) return undefined
  const normalizedKeyName = keyName.toLowerCase()
  for (const [key, value] of section.values.entries()) {
    if (key.toLowerCase() === normalizedKeyName) {
      return value
    }
  }
  return undefined
}

function parseCfgNumber(
  section: ImportedCfgSection | undefined,
  keyName: string,
  fallbackValue: number
): number {
  if (section == null) return fallbackValue
  const normalizedKeyName = keyName.toLowerCase()
  for (const [key, value] of section.values.entries()) {
    if (key.toLowerCase() !== normalizedKeyName) continue
    const numericPart = value.split(',')[0]?.trim() ?? ''
    const parsedValue = Number.parseFloat(numericPart)
    return Number.isFinite(parsedValue) ? parsedValue : fallbackValue
  }
  return fallbackValue
}

function countCfgKeys(section: ImportedCfgSection | undefined, pattern: RegExp): number {
  if (section == null) return 0
  let count = 0
  for (const key of section.values.keys()) {
    if (pattern.test(key)) {
      count += 1
    }
  }
  return count
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function moveTowards(current: number, target: number, maxDelta: number): number {
  if (maxDelta <= 0) {
    return current
  }

  const delta = target - current
  if (Math.abs(delta) <= maxDelta) {
    return target
  }

  return current + Math.sign(delta) * maxDelta
}

function positiveModulo(value: number, divisor: number): number {
  if (divisor === 0) return 0
  return ((value % divisor) + divisor) % divisor
}
