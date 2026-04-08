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

  constructor(private readonly diagnostics: ImportDiagnostic[]) {}

  tick(dtSeconds: number): void {
    this.elapsedSeconds += dtSeconds
    this.values.set('A:ANIMATION DELTA TIME', dtSeconds)

    const gearCycle = 0.5 + 0.5 * Math.sin(this.elapsedSeconds * 0.22)
    const flapCycle = 0.5 + 0.5 * Math.sin(this.elapsedSeconds * 0.18 + 0.4)
    const spoilerCycle = 0.5 + 0.5 * Math.sin(this.elapsedSeconds * 0.9 + 1.3)
    const engineCycle = 55 + 35 * Math.sin(this.elapsedSeconds * 0.35)
    const aileronCycle = 0.8 * Math.sin(this.elapsedSeconds * 0.7)
    const elevatorCycle = 0.6 * Math.sin(this.elapsedSeconds * 0.5 + 0.6)
    const rudderCycle = 70 * Math.sin(this.elapsedSeconds * 0.45 + 0.2)
    const reverserCycle = 0.5 + 0.5 * Math.sin(this.elapsedSeconds * 0.24 + 2.2)

    this.values.set('A:GEAR ANIMATION POSITION:0', gearCycle * 100)
    this.values.set('A:GEAR ANIMATION POSITION:1', gearCycle * 100)
    this.values.set('A:GEAR ANIMATION POSITION:2', gearCycle * 100)

    for (const [key] of this.values) {
      this.values.set(key, this.resolveHeuristicValue(key, {
        gearCycle,
        flapCycle,
        spoilerCycle,
        engineCycle,
        aileronCycle,
        elevatorCycle,
        rudderCycle,
        reverserCycle,
        dtSeconds
      }))
    }
  }

  readVariable(key: string): number {
    if (!this.values.has(key)) {
      const value = this.resolveHeuristicValue(key, {
        gearCycle: 0,
        flapCycle: 0,
        spoilerCycle: 0,
        engineCycle: 0,
        aileronCycle: 0,
        elevatorCycle: 0,
        rudderCycle: 0,
        reverserCycle: 0,
        dtSeconds: 0
      })

      this.values.set(key, value)
      if (value === 0) {
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
  ): number {
    const upperKey = key.toUpperCase()

    if (upperKey === 'A:ANIMATION DELTA TIME') return cycles.dtSeconds
    if (upperKey.includes('ENGINE_N1')) return cycles.engineCycle
    if (upperKey.includes('REVERSER')) return cycles.reverserCycle
    if (upperKey.includes('AILERON_LEFT')) return cycles.aileronCycle
    if (upperKey.includes('AILERON_RIGHT')) return -cycles.aileronCycle
    if (upperKey.includes('AILERON')) return cycles.aileronCycle
    if (upperKey.includes('ELEVATOR_LEFT')) return cycles.elevatorCycle
    if (upperKey.includes('ELEVATOR_RIGHT')) return cycles.elevatorCycle
    if (upperKey.includes('ELEVATOR')) return cycles.elevatorCycle
    if (upperKey.includes('RUDDER')) return cycles.rudderCycle
    if (upperKey.includes('SPOILER_LEFT')) return cycles.spoilerCycle
    if (upperKey.includes('SPOILER_RIGHT')) return cycles.spoilerCycle
    if (upperKey.includes('SPOILER')) return cycles.spoilerCycle
    if (upperKey.includes('SLAT')) return cycles.flapCycle * 100
    if (upperKey.includes('FLAP')) return cycles.flapCycle
    if (upperKey.includes('GEAR') && upperKey.includes('POSITION')) {
      return cycles.gearCycle * 100
    }
    if (upperKey.includes('DOOR')) return cycles.gearCycle * 100

    return this.values.get(key) ?? 0
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function positiveModulo(value: number, divisor: number): number {
  if (divisor === 0) return 0
  return ((value % divisor) + divisor) % divisor
}
