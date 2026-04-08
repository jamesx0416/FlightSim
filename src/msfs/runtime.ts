import { AnimationMixer, type Object3D } from 'three'

import { evaluateCompiledExpression } from './rpn'
import type {
  CompiledBehaviorSet,
  CompiledUpdateBinding,
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
        readVariable: key => this.hostServices.readVariable(key),
        writeVariable: (key, nextValue) => this.hostServices.writeVariable(key, nextValue)
      })
      const previousValue = this.animationValues.get(binding.target) ?? 0
      const value = binding.delta ? previousValue + evaluatedValue : evaluatedValue
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
          readVariable: key => this.hostServices.readVariable(key),
          writeVariable: (key, nextValue) => this.hostServices.writeVariable(key, nextValue)
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
        readVariable: key => this.hostServices.readVariable(key),
        writeVariable: (key, nextValue) => this.hostServices.writeVariable(key, nextValue)
      })

      state.ranOnce = true
      this.updateState.set(binding, state)
    }
  }
}

export class DemoRuntimeHost implements RuntimeHostServices {
  private elapsedSeconds = 0
  private readonly values = new Map<string, number>()
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
    gearCycle: 0.5,
    flapCycle: 0.5,
    spoilerCycle: 0.5,
    engineCycle: 55,
    aileronCycle: 0,
    elevatorCycle: 0,
    rudderCycle: 0,
    reverserCycle: 0,
    dtSeconds: 0
  }

  constructor(private readonly diagnostics: ImportDiagnostic[]) {}

  tick(dtSeconds: number): void {
    this.elapsedSeconds += dtSeconds
    this.cycles = {
      gearCycle: 0.5 + 0.5 * Math.sin(this.elapsedSeconds * 0.22),
      flapCycle: 0.5 + 0.5 * Math.sin(this.elapsedSeconds * 0.18 + 0.4),
      spoilerCycle: 0.5 + 0.5 * Math.sin(this.elapsedSeconds * 0.9 + 1.3),
      engineCycle: 55 + 35 * Math.sin(this.elapsedSeconds * 0.35),
      aileronCycle: 0.8 * Math.sin(this.elapsedSeconds * 0.7),
      elevatorCycle: 0.6 * Math.sin(this.elapsedSeconds * 0.5 + 0.6),
      rudderCycle: 70 * Math.sin(this.elapsedSeconds * 0.45 + 0.2),
      reverserCycle: 0.5 + 0.5 * Math.sin(this.elapsedSeconds * 0.24 + 2.2),
      dtSeconds
    }

    this.values.set('A:ANIMATION DELTA TIME', dtSeconds)
    this.values.set('A:GEAR ANIMATION POSITION:0', this.cycles.gearCycle * 100)
    this.values.set('A:GEAR ANIMATION POSITION:1', this.cycles.gearCycle * 100)
    this.values.set('A:GEAR ANIMATION POSITION:2', this.cycles.gearCycle * 100)

    for (const [key] of this.values) {
      this.values.set(key, this.resolveHeuristicValue(key, this.cycles).value)
    }
  }

  readVariable(key: string): number {
    if (!this.values.has(key)) {
      const resolved = this.resolveHeuristicValue(key, this.cycles)

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

  writeVariable(key: string, value: number): void {
    this.values.set(key, value)
  }

  invokeKeyEvent(name: string, args: readonly number[]): void {
    this.values.set(`K:${name}`, args.at(-1) ?? 0)
  }

  private resolveHeuristicValue(
    key: string,
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

    if (upperKey === 'A:ANIMATION DELTA TIME') return handled(cycles.dtSeconds)
    if (upperKey === 'A:SIM ON GROUND') return handled(0)
    if (upperKey === 'A:SURFACE RELATIVE GROUND SPEED') return handled(0)
    if (upperKey === 'A:LIGHT BEACON') return handled(1)
    if (upperKey.startsWith('O:')) return handled(this.values.get(key) ?? 0)
    if (upperKey.startsWith('A:CIRCUIT ON:')) return handled(1)
    if (upperKey.startsWith('A:CIRCUIT POWER SETTING:')) return handled(1)
    if (upperKey.startsWith('A:CIRCUIT CONNECTION ON:')) return handled(1)
    if (upperKey.startsWith('A:INTERACTIVE POINT OPEN:')) return handled(0)
    if (upperKey.startsWith('A:GEAR STEER ANGLE:')) return handled(0)
    if (upperKey.includes('ENGINE_N1')) return handled(cycles.engineCycle)
    if (upperKey.includes('REVERSER')) return handled(cycles.reverserCycle)
    if (upperKey.includes('AILERON_LEFT')) return handled(toPercentIfRequested(upperKey, cycles.aileronCycle))
    if (upperKey.includes('AILERON_RIGHT')) return handled(toPercentIfRequested(upperKey, -cycles.aileronCycle))
    if (upperKey.includes('AILERON')) return handled(toPercentIfRequested(upperKey, cycles.aileronCycle))
    if (upperKey.includes('ELEVATOR_LEFT')) return handled(toPercentIfRequested(upperKey, cycles.elevatorCycle))
    if (upperKey.includes('ELEVATOR_RIGHT')) return handled(toPercentIfRequested(upperKey, cycles.elevatorCycle))
    if (upperKey.includes('ELEVATOR')) return handled(toPercentIfRequested(upperKey, cycles.elevatorCycle))
    if (upperKey.includes('HYD_AILERON_LEFT_DEFLECTION')) return handled(cycles.aileronCycle * 100)
    if (upperKey.includes('HYD_AILERON_RIGHT_DEFLECTION')) return handled(-cycles.aileronCycle * 100)
    if (upperKey.includes('RUDDER')) return handled(cycles.rudderCycle)
    if (upperKey.includes('SPOILER_LEFT')) return handled(cycles.spoilerCycle)
    if (upperKey.includes('SPOILER_RIGHT')) return handled(cycles.spoilerCycle)
    if (upperKey.includes('SPOILER')) return handled(cycles.spoilerCycle)
    if (upperKey.includes('SLAT')) return handled(cycles.flapCycle * 100)
    if (upperKey.includes('FLAP')) return handled(cycles.flapCycle)
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
      return handled(cycles.gearCycle * 100)
    }
    if (upperKey.includes('DOOR')) return handled(cycles.gearCycle * 100)

    return {
      handled: false,
      value: this.values.get(key) ?? 0
    }
  }
}

function toPercentIfRequested(key: string, value: number): number {
  return key.includes('PCT') || key.includes('PERCENT') ? value * 100 : value
}

function handled(value: number): { readonly handled: true; readonly value: number } {
  return {
    handled: true,
    value
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function positiveModulo(value: number, divisor: number): number {
  if (divisor === 0) return 0
  return ((value % divisor) + divisor) % divisor
}
