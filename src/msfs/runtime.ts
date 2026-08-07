import {
  type AnimationClip,
  AnimationMixer,
  Box3,
  type Material,
  type Object3D,
  PropertyBinding,
  Vector3,
} from 'three'

import {
  AvionicsCommandTypes,
  ControlCommandTypes,
  ControlStateKeys,
  ElectricalCommandTypes,
  ElectricalStateKeys,
  FuelCommandTypes,
  LightingStateKeys,
  PropulsionCommandTypes,
  PropulsionStateKeys,
  SurfaceStateKeys,
  SimScheduler,
  createSimulatorEngineForAircraft,
  type CanonicalAircraftDefinition,
  type CanonicalElectricalSystemConfig,
  type CanonicalFuelSystemConfig,
  type CanonicalPropulsionSystemConfig,
  type CanonicalStateSeed,
  type CanonicalSystemDefinition,
  type CanonicalVisualDefinition,
  type SimStateSource,
  type SimScheduledTaskId,
  type SimulatorEngine,
} from '../sim/engine'
import { evaluateCompiledExpression, evaluateCompiledExpressionValue } from './rpn'
import { MsfsCompatibilityBridge } from './compatibilityBridge'
import type {
  CompiledAnimationBinding,
  CompiledAnimationTriggerBinding,
  CompiledBehaviorSet,
  CompiledExpression,
  CompiledInputEventBinding,
  CompiledInteractionBinding,
  CompiledInteractionBlocker,
  CompiledInteractionSoundEvent,
  CompiledMaterialBinding,
  CompiledUpdateBinding,
  CompiledVisibilityBinding,
  ImportedAircraft,
  ImportedCfgFile,
  ImportedCfgSection,
  ImportedFlightState,
  ImportedSimVarSound,
  ImportedSoundRange,
  ImportedSoundVariable,
  Instruction,
  ImportDiagnostic,
  ModelNodeAnimation,
  RuntimeCanonicalVisualBindingState,
  RuntimeHostServices,
  RuntimeVariableChangeListener,
  RuntimeState
} from './types'

interface RuntimeInteractionOptions {
  readonly holdFeedback?: boolean
  readonly mouseEvent?: string
  readonly inputType?: number
  readonly relativeX?: number
  readonly relativeY?: number
  readonly relativeZ?: number
  readonly dragPercent?: number
  readonly parameterValues?: readonly number[]
}

interface RuntimeMaterialBinding {
  readonly binding: CompiledMaterialBinding
  readonly materials: readonly RuntimeBoundMaterial[]
  readonly dependencies: readonly RuntimeExpressionDependency[] | null
  lastAppliedValue: number | null
  lastDependencyValues: readonly number[] | null
}

interface RuntimeCanonicalVisualBinding {
  readonly visual: CanonicalVisualDefinition
  readonly channel: NonNullable<CanonicalVisualDefinition['channel']>
  readonly target: string
  readonly node: Object3D | null
  readonly materials: readonly RuntimeBoundMaterial[]
}

interface RuntimeAnimationBinding {
  readonly binding: CompiledAnimationBinding
  readonly dependencies: readonly RuntimeExpressionDependency[] | null
  lastEvaluatedValue: number | null
  lastDependencyValues: readonly number[] | null
}

interface RuntimeVisibilityBinding {
  readonly binding: CompiledVisibilityBinding
  readonly node: Object3D
  readonly dependencies: readonly RuntimeExpressionDependency[] | null
  lastEvaluatedVisible: boolean | null
  lastDependencyValues: readonly number[] | null
}

interface RuntimeBoundMaterial {
  readonly material: RuntimeMaterial
  readonly baseEmissiveIntensity: number
  readonly baseEmissiveColor: readonly [number, number, number] | null
}

interface RuntimeExpressionDependency {
  readonly key: string
  readonly unit: string | null
}

export interface RuntimeInteractionValueWatch {
  readonly authoritative: boolean
  didChange(): boolean
  dispose(): void
}

let nextInteractionSchedulerScope = 1

type RuntimeMaterial = Material & {
  emissive?: {
    r: number
    g: number
    b: number
    setRGB: (r: number, g: number, b: number) => unknown
  }
  emissiveIntensity?: number
  needsUpdate: boolean
}

type MaterialObject = Object3D & {
  material?: Material | Material[]
}

export type RuntimeUpdateProfile = {
  readonly totalMs: number
  readonly hostTickMs: number
  readonly updateBindingsMs: number
  readonly interactionFeedbackMs: number
  readonly animationMs: number
  readonly mixerMs: number
  readonly wingFlexMs: number
  readonly visibilityMs: number
  readonly materialMs: number
  readonly animationBindingCount: number
  readonly visibilityBindingCount: number
  readonly materialBindingCount: number
  readonly updateBindingCount: number
}

interface RuntimeControlState {
  gearTarget: number
  gearPosition: number
  flapsTarget: number
  flapsPosition: number
  spoilersTarget: number
  spoilersPosition: number
  aileronTarget: number
  aileronPosition: number
  elevatorTarget: number
  elevatorPosition: number
  rudderTarget: number
  rudderPosition: number
  parkingBrake: number
}

interface RuntimeElectricalState {
  batterySwitch: number
  externalPowerSwitch: number
  externalPowerAvailable: number
  avionicsSwitch: number
}

interface RuntimeCycles {
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

function createInitialRuntimeControlState(): RuntimeControlState {
  return {
    gearTarget: 0,
    gearPosition: 0,
    flapsTarget: 0,
    flapsPosition: 0,
    spoilersTarget: 0,
    spoilersPosition: 0,
    aileronTarget: 0,
    aileronPosition: 0,
    elevatorTarget: 0,
    elevatorPosition: 0,
    rudderTarget: 0,
    rudderPosition: 0,
    parkingBrake: 0
  }
}

function createInitialRuntimeElectricalState(): RuntimeElectricalState {
  return {
    batterySwitch: 0,
    externalPowerSwitch: 0,
    externalPowerAvailable: 1,
    avionicsSwitch: 0
  }
}

function createInitialRuntimeCycles(): RuntimeCycles {
  return {
    gearCycle: 0,
    flapCycle: 0,
    spoilerCycle: 0,
    engineCycle: 0,
    aileronCycle: 0,
    elevatorCycle: 0,
    rudderCycle: 0,
    reverserCycle: 0,
    dtSeconds: 0
  }
}

export class AircraftRuntime {
  private readonly mixer: AnimationMixer
  private readonly actions = new Map<string, ReturnType<AnimationMixer['clipAction']>>()
  private readonly nodes = new Map<string, Object3D>()
  private readonly canonicalNodes = new Map<string, Object3D>()
  private readonly animationValues = new Map<string, number>()
  private readonly animationTriggerValues = new Map<string, number>()
  private readonly nodeVisibilities = new Map<string, boolean>()
  private readonly materialValues = new Map<string, number>()
  private readonly canonicalVisualBindingStates: RuntimeCanonicalVisualBindingState[] = []
  private activeAnimationBindings: readonly RuntimeAnimationBinding[] = []
  private activeAnimationTriggerBindings: readonly CompiledAnimationTriggerBinding[] = []
  private readonly activeAnimationTriggerBindingsByAnimation = new Map<string, readonly CompiledAnimationTriggerBinding[]>()
  private readonly activeVisibilityBindings: readonly RuntimeVisibilityBinding[]
  private readonly activeMaterialBindings: readonly RuntimeMaterialBinding[]
  private readonly canonicalVisualBindings: readonly RuntimeCanonicalVisualBinding[]
  private readonly readOnlyExpressionServices: Parameters<typeof evaluateCompiledExpression>[1]
  private readonly updateExpressionServices: Parameters<typeof evaluateCompiledExpression>[1]
  private readonly runtimeState: RuntimeState
  private readonly updateState = new Map<CompiledUpdateBinding, { elapsedSeconds: number; ranOnce: boolean }>()
  private readonly frameVariableValues = new Map<string, number>()
  private readonly interactionFeedbackTimers = new Map<string, RuntimeInteractionFeedbackTimer>()
  private readonly heldInteractionFeedbackTargets = new Map<
    string,
    { count: number; startedAtSeconds: number }
  >()
  private readonly wingFlexBindings: readonly RuntimeWingFlexBinding[]
  private readonly delayedInteractionReleases = new Map<CompiledInteractionBinding, SimScheduledTaskId>()
  private readonly interactionScheduler: SimScheduler
  private readonly interactionSchedulerScope = `msfs-interactions:${nextInteractionSchedulerScope++}`
  private interactionExecutionCount = 0
  private modelRevision = 0
  private lastUpdateProfile: RuntimeUpdateProfile | null = null

  constructor(
    private readonly compiled: CompiledBehaviorSet,
    private readonly sceneRoot: Object3D,
    private readonly hostServices: RuntimeHostServices,
    aircraft?: ImportedAircraft,
    canonicalAircraft?: CanonicalAircraftDefinition,
    private readonly simulatorEngine?: SimulatorEngine
  ) {
    this.interactionScheduler = simulatorEngine?.scheduler ?? new SimScheduler()
    this.mixer = new AnimationMixer(sceneRoot)
    this.runtimeState = {
      irVersion: 'msfs-runtime/v1',
      animationValues: this.animationValues,
      nodeVisibilities: this.nodeVisibilities,
      materialValues: this.materialValues,
      canonicalVisualBindings: this.canonicalVisualBindingStates,
      diagnostics: this.compiled.diagnostics
    }
    this.hostServices.setInputEventBindings?.(this.compiled.inputEventBindings)
    this.readOnlyExpressionServices = {
      readVariable: (key, unit) => this.readFrameVariable(key, unit)
    }
    this.updateExpressionServices = {
      readVariable: (key, unit) => this.readFrameVariable(key, unit),
      writeVariable: (key, nextValue, unit) => this.writeFrameVariable(key, nextValue, unit),
      invokeKeyEvent: (name, args) => this.hostServices.invokeKeyEvent?.(name, args),
      invokeHtmlEvent: (name, args) => this.hostServices.invokeHtmlEvent?.(name, args)
    }

    sceneRoot.traverse(node => {
      if (node.name) {
        this.nodes.set(node.name, node)
        this.nodes.set(node.name.toLowerCase(), node)
        const canonicalName = canonicalizeNodeAnimationName(node.name)
        if (canonicalName) {
          this.canonicalNodes.set(canonicalName, node)
        }
      }
    })

    sceneRoot.updateWorldMatrix(true, true)
    this.activeVisibilityBindings = buildRuntimeVisibilityBindings(
      this.compiled.visibilityBindings,
      this.nodes
    )
    this.activeMaterialBindings = buildRuntimeMaterialBindings(
      this.compiled.materialBindings,
      this.nodes
    )
    this.canonicalVisualBindings = buildRuntimeCanonicalVisualBindings(
      canonicalAircraft?.visuals ?? [],
      this.nodes
    )
    this.canonicalVisualBindingStates.push(
      ...this.canonicalVisualBindings.map(binding => ({
        id: binding.visual.id,
        kind: binding.visual.kind,
        channel: binding.channel,
        target: binding.target,
        stateKey: binding.visual.stateKey ?? '',
      }))
    )
    this.wingFlexBindings = buildWingFlexBindings(
      aircraft?.model?.nodeAnimations ?? [],
      aircraft,
      sceneRoot,
      this.nodes,
      this.canonicalNodes
    )
  }

  bindAnimations(clips: readonly { readonly name: string }[]): void {
    const activeAnimationBindings: RuntimeAnimationBinding[] = []
    const activeAnimationNames = new Set<string>()
    for (const binding of this.compiled.animationBindings) {
      const clip = findAnimationClip(clips, binding.target)
      if (clip == null) continue
      const action = this.mixer.clipAction(clip as never)
      action.enabled = true
      action.play()
      action.paused = true
      this.actions.set(binding.target, action)
      activeAnimationBindings.push({
        binding,
        dependencies: getRuntimeExpressionDependencies(binding.expression),
        lastEvaluatedValue: null,
        lastDependencyValues: null
      })
      activeAnimationNames.add(binding.target)
    }
    for (const binding of this.canonicalVisualBindings) {
      if (binding.channel !== 'animation' || this.actions.has(binding.target)) {
        continue
      }
      const clip = findAnimationClip(clips, binding.target)
      if (clip == null) continue
      const action = this.mixer.clipAction(clip as never)
      action.enabled = true
      action.play()
      action.paused = true
      this.actions.set(binding.target, action)
    }
    this.activeAnimationBindings = activeAnimationBindings
    this.activeAnimationTriggerBindings = this.compiled.animationTriggerBindings.filter(binding =>
      activeAnimationNames.has(binding.animation)
    )
    this.activeAnimationTriggerBindingsByAnimation.clear()
    for (const binding of this.activeAnimationTriggerBindings) {
      const bindings = this.activeAnimationTriggerBindingsByAnimation.get(binding.animation) ?? []
      this.activeAnimationTriggerBindingsByAnimation.set(binding.animation, [...bindings, binding])
    }
  }

  private applyCanonicalVisualBindings(): boolean {
    if (this.simulatorEngine == null || this.canonicalVisualBindings.length === 0) {
      return false
    }

    let modelChanged = false

    for (const binding of this.canonicalVisualBindings) {
      if (binding.visual.stateKey == null) continue
      const value = readCanonicalVisualRatio(
        this.simulatorEngine,
        binding.visual.stateKey
      )

      if (binding.channel === 'animation') {
        const previousValue = this.animationValues.get(binding.target)
        this.animationValues.set(binding.target, value)
        if (previousValue == null || Math.abs(previousValue - value) > 1e-6) {
          modelChanged = true
        }

        const action = this.actions.get(binding.target)
        if (action != null) {
          action.time = animationTimeAtNormalizedValue(action.getClip(), value)
        }
        continue
      }

      if (binding.channel === 'visibility') {
        const visible = value > 0
        const previousValue = this.nodeVisibilities.get(binding.target)
        this.nodeVisibilities.set(binding.target, visible)
        if (binding.node != null) {
          binding.node.visible = visible
        }
        if (previousValue == null || previousValue !== visible) {
          modelChanged = true
        }
        continue
      }

      const previousValue = this.materialValues.get(binding.target)
      this.materialValues.set(binding.target, value)
      if (previousValue == null || Math.abs(previousValue - value) > 1e-6) {
        modelChanged = true
      }
      for (const materialState of binding.materials) {
        applyCanonicalVisualMaterialBinding(materialState, value)
      }
    }

    return modelChanged
  }

  update(
    dtSeconds: number,
    options: { readonly profile?: boolean } = {}
  ): RuntimeState {
    const profile = options.profile === true
    const updateStartMs = profile ? performance.now() : 0
    let phaseStartMs = updateStartMs
    let hostTickMs = 0
    let updateBindingsMs = 0
    let interactionFeedbackMs = 0
    let animationMs = 0
    let mixerMs = 0
    let wingFlexMs = 0
    let visibilityMs = 0
    let materialMs = 0
    const finishPhase = (): number => {
      if (!profile) {
        return 0
      }
      const nowMs = performance.now()
      const durationMs = nowMs - phaseStartMs
      phaseStartMs = nowMs
      return durationMs
    }
    const readFrameVariable: RuntimeHostServices['readVariable'] = (key, unit) =>
      this.readFrameVariable(key, unit)

    this.hostServices.tick(dtSeconds)
    if (this.simulatorEngine == null) this.interactionScheduler.tick(dtSeconds)
    this.frameVariableValues.clear()
    hostTickMs = finishPhase()
    this.runUpdateBindings(dtSeconds)
    updateBindingsMs = finishPhase()
    this.publishInteractionFeedback()
    interactionFeedbackMs = finishPhase()
    let modelChanged = false

    for (const runtimeBinding of this.activeAnimationBindings) {
      const { binding } = runtimeBinding
      if (
        runtimeBinding.lastEvaluatedValue != null &&
        runtimeBinding.dependencies != null &&
        runtimeBinding.dependencies.length === 0 &&
        !binding.delta &&
        binding.lagFramesPerSecond <= 0
      ) {
        continue
      }
      const dependencyValues =
        runtimeBinding.lastEvaluatedValue == null || runtimeBinding.dependencies == null
          ? null
          : readRuntimeExpressionDependencyValues(
            runtimeBinding.dependencies,
            readFrameVariable
          )
      const canReuseEvaluatedValue =
        runtimeBinding.lastEvaluatedValue != null &&
        dependencyValues != null &&
        runtimeDependencyValuesEqual(runtimeBinding.lastDependencyValues, dependencyValues)
      const evaluatedValue = canReuseEvaluatedValue
        ? runtimeBinding.lastEvaluatedValue!
        : evaluateCompiledExpression(binding.expression, this.readOnlyExpressionServices)
      if (!canReuseEvaluatedValue) {
        runtimeBinding.lastEvaluatedValue = evaluatedValue
        runtimeBinding.lastDependencyValues =
          runtimeBinding.dependencies == null
            ? null
            : dependencyValues ??
              readRuntimeExpressionDependencyValues(
                runtimeBinding.dependencies,
                readFrameVariable
              )
      }
      const hadPreviousValue = this.animationValues.has(binding.target)
      const previousValue = this.animationValues.get(binding.target) ?? 0
      const rawValue = binding.delta ? previousValue + evaluatedValue : evaluatedValue
      const value =
        hadPreviousValue && binding.lagFramesPerSecond > 0
          ? moveTowards(previousValue, rawValue, binding.lagFramesPerSecond * dtSeconds)
          : rawValue
      if (hadPreviousValue && Math.abs(value - previousValue) <= 1e-6) {
        continue
      }
      this.animationValues.set(binding.target, value)
      if (Math.abs(value - previousValue) > 1e-6) {
        modelChanged = true
      }

      const action = this.actions.get(binding.target)
      if (action != null) {
        const normalizedValue = binding.wrap
          ? positiveModulo(value, binding.length) / binding.length
          : clamp(value / binding.length, 0, 1)
        this.invokeAnimationTriggerBindings(binding.target, normalizedValue)
        action.time = animationTimeAtNormalizedValue(
          action.getClip(),
          normalizedValue
        )
      }
    }
    animationMs = finishPhase()

    this.mixer.update(0)
    mixerMs = finishPhase()
    this.applyWingFlexBindings()
    wingFlexMs = finishPhase()

    for (const runtimeBinding of this.activeVisibilityBindings) {
      if (
        runtimeBinding.lastEvaluatedVisible != null &&
        runtimeBinding.dependencies != null &&
        runtimeBinding.dependencies.length === 0
      ) {
        continue
      }
      const { binding, node } = runtimeBinding
      const dependencyValues =
        runtimeBinding.lastEvaluatedVisible == null || runtimeBinding.dependencies == null
          ? null
          : readRuntimeExpressionDependencyValues(
            runtimeBinding.dependencies,
            readFrameVariable
          )
      const canReuseVisible =
        runtimeBinding.lastEvaluatedVisible != null &&
        dependencyValues != null &&
        runtimeDependencyValuesEqual(runtimeBinding.lastDependencyValues, dependencyValues)
      if (canReuseVisible) {
        continue
      }
      const isVisible =
        evaluateCompiledExpression(binding.expression, this.readOnlyExpressionServices) !== 0

      const previousVisibility = runtimeBinding.lastEvaluatedVisible
      runtimeBinding.lastEvaluatedVisible = isVisible
      runtimeBinding.lastDependencyValues =
        runtimeBinding.dependencies == null
          ? null
          : dependencyValues ??
            readRuntimeExpressionDependencyValues(
              runtimeBinding.dependencies,
              readFrameVariable
            )
      this.nodeVisibilities.set(binding.target, isVisible)
      if (previousVisibility !== isVisible) {
        modelChanged = true
      }
      if (node.visible !== isVisible) {
        node.visible = isVisible
        modelChanged = true
      }
    }
    visibilityMs = finishPhase()

    for (const runtimeBinding of this.activeMaterialBindings) {
      if (
        runtimeBinding.lastAppliedValue != null &&
        runtimeBinding.dependencies != null &&
        runtimeBinding.dependencies.length === 0
      ) {
        continue
      }
      const dependencyValues =
        runtimeBinding.lastAppliedValue == null || runtimeBinding.dependencies == null
          ? null
          : readRuntimeExpressionDependencyValues(
            runtimeBinding.dependencies,
            readFrameVariable
          )
      const canReuseValue =
        runtimeBinding.lastAppliedValue != null &&
        dependencyValues != null &&
        runtimeDependencyValuesEqual(runtimeBinding.lastDependencyValues, dependencyValues)
      const value = canReuseValue
        ? runtimeBinding.lastAppliedValue!
        : evaluateCompiledExpression(
          runtimeBinding.binding.expression,
          this.readOnlyExpressionServices
        )
      if (canReuseValue) {
        continue
      }
      const previousAppliedValue = runtimeBinding.lastAppliedValue
      runtimeBinding.lastAppliedValue = value
      runtimeBinding.lastDependencyValues =
        runtimeBinding.dependencies == null
          ? null
          : dependencyValues ??
            readRuntimeExpressionDependencyValues(
              runtimeBinding.dependencies,
              readFrameVariable
            )
      this.materialValues.set(runtimeBinding.binding.target, value)
      if (
        previousAppliedValue != null &&
        Math.abs(previousAppliedValue - value) <= 1e-6
      ) {
        continue
      }
      for (const materialState of runtimeBinding.materials) {
        applyRuntimeMaterialBinding(materialState, value, runtimeBinding.binding)
      }
    }
    materialMs = finishPhase()
    modelChanged = this.applyCanonicalVisualBindings() || modelChanged
    if (modelChanged) {
      this.modelRevision += 1
    }

    if (profile) {
      this.lastUpdateProfile = {
        totalMs: performance.now() - updateStartMs,
        hostTickMs,
        updateBindingsMs,
        interactionFeedbackMs,
        animationMs,
        mixerMs,
        wingFlexMs,
        visibilityMs,
        materialMs,
        animationBindingCount: this.activeAnimationBindings.length,
        visibilityBindingCount: this.activeVisibilityBindings.length,
        materialBindingCount: this.activeMaterialBindings.length,
        updateBindingCount: this.compiled.updateBindings.length
      }
    }

    return this.runtimeState
  }

  getLastUpdateProfile(): RuntimeUpdateProfile | null {
    return this.lastUpdateProfile
  }

  getModelRevision(): number {
    return this.modelRevision
  }

  dispose(): void {
    this.interactionScheduler.cancelScope(this.interactionSchedulerScope)
    this.interactionFeedbackTimers.clear()
    this.delayedInteractionReleases.clear()
    this.heldInteractionFeedbackTargets.clear()
    this.mixer.stopAllAction()
    this.actions.clear()
    this.mixer.uncacheRoot(this.sceneRoot)
  }

  getInteractionBindings(): readonly CompiledInteractionBinding[] {
    return this.compiled.interactionBindings
  }

  getInteractionBlockers(): readonly CompiledInteractionBlocker[] {
    return this.compiled.interactionBlockers
  }

  getInteractionExecutionCount(): number {
    return this.interactionExecutionCount
  }

  evaluateInteractionReadOnlyExpression(
    expression: CompiledExpression,
    parameterValues: readonly number[] = []
  ): number {
    return evaluateCompiledExpression(expression, {
      ...this.readOnlyExpressionServices,
      parameterValues
    })
  }

  evaluateInteractionFormattedValue(binding: CompiledInteractionBinding): string | null {
    const expression = binding.metadata.tooltipFormattedValueExpression
    if (expression == null) return null
    const value = evaluateCompiledExpressionValue(expression, this.readOnlyExpressionServices)
    return typeof value === 'string' ? value : Number.isFinite(value) ? String(value) : null
  }

  getAnimationNormalizedValue(target: string): number | null {
    const binding = this.compiled.animationBindings.find(candidate => candidate.target === target)
    const value = binding == null ? undefined : this.animationValues.get(binding.target)
    if (binding == null || value == null || binding.length <= 0) return null
    return binding.wrap
      ? positiveModulo(value, binding.length) / binding.length
      : clamp(value / binding.length, 0, 1)
  }

  sampleAnimationObjectTrajectory(
    target: string,
    object?: Object3D,
    localAnchor?: Vector3
  ): readonly { readonly dragPercent: number; readonly position: Vector3 }[] {
    const action = this.actions.get(target)
    if (action == null) return []
    const clip = action.getClip()
    const objects = object == null
      ? [...new Set(clip.tracks.flatMap(track => {
          const nodeName = PropertyBinding.parseTrackName(track.name).nodeName
          const node = this.nodes.get(nodeName) ?? this.nodes.get(nodeName.toLowerCase())
          return node == null ? [] : [node]
        }))]
      : [object]
    if (objects.length === 0) return []
    const times = [...new Set(clip.tracks.flatMap(track => [...track.times]))].sort((left, right) => left - right)
    const firstTime = times[0]
    const lastTime = times.at(-1)
    if (firstTime == null || lastTime == null || lastTime <= firstTime) return []
    const previousTime = action.time
    try {
      return times.map(time => {
        action.time = time
        this.mixer.update(0)
        this.sceneRoot.updateWorldMatrix(true, true)
        const position = localAnchor == null
          ? (() => {
              const bounds = new Box3()
              for (const trajectoryObject of objects) bounds.expandByObject(trajectoryObject)
              return bounds.isEmpty()
                ? objects[0]!.getWorldPosition(new Vector3())
                : bounds.getCenter(new Vector3())
            })()
          : objects[0]!.localToWorld(localAnchor.clone())
        return { dragPercent: (time - firstTime) / (lastTime - firstTime), position }
      })
    } finally {
      action.time = previousTime
      this.mixer.update(0)
      this.sceneRoot.updateWorldMatrix(true, true)
    }
  }

  executeInteraction(target: string, options: RuntimeInteractionOptions = {}): boolean {
    const binding = this.findInteractionBindingForTarget(target)
    if (binding == null) {
      return false
    }

    this.executeInteractionBinding(binding, options)
    return true
  }

  executeInteractionBindingDirect(
    binding: CompiledInteractionBinding,
    options: RuntimeInteractionOptions = {}
  ): boolean {
    if (!this.compiled.interactionBindings.includes(binding) || binding.metadata.disabled) {
      return false
    }
    this.executeInteractionBinding(binding, options)
    return true
  }

  readInteractionValue(binding: CompiledInteractionBinding): number | null {
    const expression = binding.metadata.value.stateExpression ?? binding.metadata.tooltipValueExpression
    if (!this.compiled.interactionBindings.includes(binding) || expression == null) return null
    const value = evaluateCompiledExpression(expression, {
      readVariable: (key, unit) => this.hostServices.readVariable(key, unit)
    })
    return Number.isFinite(value) ? value : null
  }

  readAuthoritativeInteractionValue(binding: CompiledInteractionBinding): number | null {
    const expression = binding.metadata.value.stateExpression
    if (!this.compiled.interactionBindings.includes(binding) || expression == null) return null
    const value = evaluateCompiledExpression(expression, {
      readVariable: (key, unit) => this.hostServices.readVariable(key, unit)
    })
    return Number.isFinite(value) ? value : null
  }

  executeInteractionSetState(binding: CompiledInteractionBinding, value: number): boolean {
    if (!this.compiled.interactionBindings.includes(binding) || binding.metadata.disabled) return false
    const state = binding.metadata.value.setStates?.find(candidate => Object.is(candidate.value, value))
    if (state == null) return false
    this.triggerInteractionFeedback(binding, 'pulse')
    this.invokeInteractionSoundEvents(binding, 'press')
    this.hostServices.trace?.(() => ({
      kind: 'interaction-rpn',
      phase: 'static-set',
      target: binding.metadata.qualifiedId,
      sourcePath: binding.sourcePath,
      expression: state.expression.source,
      value
    }))
    evaluateCompiledExpression(state.expression, {
      readVariable: (key, unit) => this.hostServices.readVariable(key, unit),
      writeVariable: (key, next, unit) => this.hostServices.writeVariable(key, next, unit, { source: 'interaction' }),
      invokeKeyEvent: (name, args) => this.hostServices.invokeKeyEvent?.(name, args),
      invokeHtmlEvent: (name, args) => this.hostServices.invokeHtmlEvent?.(name, args)
    })
    this.interactionExecutionCount += 1
    return true
  }

  watchInteractionValue(binding: CompiledInteractionBinding): RuntimeInteractionValueWatch {
    const expression = binding.metadata.value.stateExpression
    let value = this.readAuthoritativeInteractionValue(binding)
    let changed = false
    const check = (): void => {
      const next = this.readAuthoritativeInteractionValue(binding)
      if (!Object.is(value, next)) changed = true
      value = next
    }
    const unsubscribers: (() => void)[] = []
    if (this.hostServices.subscribeVariable != null) {
      unsubscribers.push(this.hostServices.subscribeVariable(check))
    }
    if (this.simulatorEngine != null) {
      unsubscribers.push(this.simulatorEngine.state.subscribe(check))
    }
    return {
      authoritative: value != null && expression != null && expression.variableKeys.length > 0 && unsubscribers.length > 0,
      didChange: () => changed,
      dispose: () => { for (const unsubscribe of unsubscribers) unsubscribe() }
    }
  }

  async waitForInteractionSettle(seconds: number): Promise<void> {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new RangeError('seconds must be a non-negative finite number')
    }
    if (seconds > 0) {
      await new Promise<void>(resolve => {
        this.interactionScheduler.schedule(seconds, resolve, {
          scope: this.interactionSchedulerScope
        })
      })
    }
    await this.interactionScheduler.waitForCompletedTicks(2)
  }

  executeInteractionCallbackEvent(target: string, options: RuntimeInteractionOptions = {}): boolean {
    const binding = this.findInteractionBindingForTarget(target)
    if (binding == null || binding.metadata.sourceKind === 'eventId') {
      return false
    }
    const mouseEvent = options.mouseEvent?.trim() || 'LeftSingle'
    if (
      isRuntimeInteractionReleaseMouseEvent(mouseEvent) &&
      !doesRuntimeInteractionExpressionHandleMouseEvent(binding.expression)
    ) {
      return false
    }

    this.executeInteractionBinding(binding, options)
    return true
  }

  executeInteractionCallbackEventForBinding(
    binding: CompiledInteractionBinding,
    options: RuntimeInteractionOptions = {}
  ): boolean {
    if (!this.compiled.interactionBindings.includes(binding) || binding.metadata.sourceKind === 'eventId') {
      return false
    }
    const mouseEvent = options.mouseEvent?.trim() || 'LeftSingle'
    if (
      isRuntimeInteractionReleaseMouseEvent(mouseEvent) &&
      !doesRuntimeInteractionExpressionHandleMouseEvent(binding.expression)
    ) {
      return false
    }

    this.executeInteractionBinding(binding, options)
    return true
  }

  executeInteractionForObject(
    object: Object3D,
    options: RuntimeInteractionOptions = {}
  ): string | null {
    let current: Object3D | null = object
    while (current != null) {
      const binding = this.findInteractionBindingForTarget(current.name)
      if (binding != null) {
        this.executeInteractionBinding(binding, options)
        return binding.target
      }
      if (current === this.sceneRoot) {
        break
      }
      current = current.parent
    }

    return null
  }

  releaseInteraction(target: string): boolean {
    const binding = this.findInteractionBindingForTarget(target)
    if (binding == null) {
      return false
    }

    this.releaseInteractionFeedback(binding)
    return true
  }

  releaseInteractionBinding(binding: CompiledInteractionBinding): boolean {
    if (!this.compiled.interactionBindings.includes(binding)) {
      return false
    }

    this.releaseInteractionFeedback(binding)
    return true
  }

  stopInteractionBinding(binding: CompiledInteractionBinding): boolean {
    if (!this.compiled.interactionBindings.includes(binding)) return false
    const delayedRelease = this.delayedInteractionReleases.get(binding)
    if (delayedRelease != null) this.interactionScheduler.cancel(delayedRelease)
    this.delayedInteractionReleases.delete(binding)
    for (const target of binding.feedbackTargets.length > 0 ? binding.feedbackTargets : [binding.target]) {
      const trimmedTarget = target.trim()
      if (!trimmedTarget) continue
      this.heldInteractionFeedbackTargets.delete(trimmedTarget)
      const timer = this.interactionFeedbackTimers.get(trimmedTarget)
      if (timer != null) this.interactionScheduler.cancel(timer.taskId)
      this.interactionFeedbackTimers.delete(trimmedTarget)
      this.hostServices.writeVariable(`O:${trimmedTarget}:_ButtonAnimVar`, 0)
    }
    for (const variableKey of binding.feedbackVariableKeys) {
      this.hostServices.writeVariable(variableKey, 0)
    }
    return true
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

      evaluateCompiledExpression(binding.expression, this.updateExpressionServices)

      state.ranOnce = true
      this.updateState.set(binding, state)
    }
  }

  private readFrameVariable(key: string, unit: string | null | undefined): number {
    const cacheKey = getRuntimeVariableDependencyCacheKey(key, unit)
    const cachedValue = this.frameVariableValues.get(cacheKey)
    if (cachedValue != null) {
      return cachedValue
    }

    const value = this.hostServices.readVariable(key, unit)
    this.frameVariableValues.set(cacheKey, value)
    return value
  }

  private writeFrameVariable(key: string, value: number, unit: string | null | undefined): void {
    this.frameVariableValues.delete(getRuntimeVariableDependencyCacheKey(key, unit))
    this.hostServices.writeVariable(key, value, unit, { source: 'update' })
  }

  private applyWingFlexBindings(): void {
    for (const binding of this.wingFlexBindings) {
      const leftFlex = this.hostServices.readVariable('A:WING FLEX PCT:1', 'percent over 100')
      const rightFlex = this.hostServices.readVariable('A:WING FLEX PCT:2', 'percent over 100')

      applyWingFlexChain(binding.leftWing, leftFlex, binding)
      applyWingFlexChain(binding.rightWing, rightFlex, binding)
      applyWingFlexEnginePivots(binding.leftEnginePivots, binding.leftWing, leftFlex, binding)
      applyWingFlexEnginePivots(binding.rightEnginePivots, binding.rightWing, rightFlex, binding)
    }
  }

  private findInteractionBindingForTarget(target: string): CompiledInteractionBinding | null {
    const trimmedTarget = target.trim()
    if (!trimmedTarget) {
      return null
    }

    const lowercaseTarget = trimmedTarget.toLowerCase()
    const canonicalTarget = canonicalizeNodeAnimationName(trimmedTarget)
    const exactBinding = selectBestInteractionBinding(
      this.compiled.interactionBindings.filter(binding => binding.target.trim() === trimmedTarget)
    )
    if (exactBinding != null) {
      return exactBinding
    }

    const caseInsensitiveBinding = selectBestInteractionBinding(
      this.compiled.interactionBindings.filter(
        binding => binding.target.trim().toLowerCase() === lowercaseTarget
      )
    )
    if (caseInsensitiveBinding != null) {
      return caseInsensitiveBinding
    }

    if (canonicalTarget === '') {
      return null
    }

    return selectBestInteractionBinding(
      this.compiled.interactionBindings.filter(
        binding => canonicalizeNodeAnimationName(binding.target.trim()) === canonicalTarget
      )
    )
  }

  private executeInteractionBinding(
    binding: CompiledInteractionBinding,
    options: RuntimeInteractionOptions = {}
  ): void {
    const mouseEvent = options.mouseEvent?.trim() || 'LeftSingle'
    const isReleaseEvent = isRuntimeInteractionReleaseMouseEvent(mouseEvent)
    if (!isReleaseEvent) {
      this.triggerInteractionFeedback(binding, options.holdFeedback === true ? 'hold' : 'pulse')
      this.invokeInteractionSoundEvents(binding, 'press')
    }
    this.hostServices.trace?.(() => ({
      kind: 'interaction-rpn',
      phase: isReleaseEvent ? 'release-event' : 'execute',
      target: binding.metadata.qualifiedId,
      sourcePath: binding.sourcePath,
      expression: binding.expression.source,
      mouseEvent,
      parameterValues: options.parameterValues ?? []
    }))
    evaluateCompiledExpression(binding.expression, {
      readVariable: (key, unit) => readRuntimeMouseVariable(key, options) ?? this.hostServices.readVariable(key, unit),
      readStringVariable: key => readRuntimeStringVariable(key, mouseEvent),
      writeVariable: (key, value, unit) => this.hostServices.writeVariable(key, value, unit, { source: 'interaction' }),
      invokeKeyEvent: (name, args) => this.hostServices.invokeKeyEvent?.(name, args),
      invokeHtmlEvent: (name, args) => this.hostServices.invokeHtmlEvent?.(name, args),
      parameterValues: options.parameterValues
    })
    if (isReleaseEvent) {
      this.invokeInteractionSoundEvents(binding, 'release')
    }
    this.interactionExecutionCount += 1
  }

  private triggerInteractionFeedback(binding: CompiledInteractionBinding, mode: 'hold' | 'pulse'): void {
    this.hostServices.trace?.(() => ({
      kind: 'interaction-feedback',
      phase: 'trigger',
      target: binding.metadata.qualifiedId,
      mode,
      feedbackTargets: binding.feedbackTargets,
      variableKeys: binding.feedbackVariableKeys
    }))
    const delayedRelease = this.delayedInteractionReleases.get(binding)
    if (delayedRelease != null) this.interactionScheduler.cancel(delayedRelease)
    this.delayedInteractionReleases.delete(binding)
    const targets = binding.feedbackTargets.length > 0 ? binding.feedbackTargets : [binding.target]
    for (const variableKey of binding.feedbackVariableKeys) {
      this.hostServices.writeVariable(variableKey, 1)
    }
    for (const target of targets) {
      const trimmedTarget = target.trim()
      if (!trimmedTarget) {
        continue
      }
      if (mode === 'hold') {
        const previousState = this.heldInteractionFeedbackTargets.get(trimmedTarget)
        this.heldInteractionFeedbackTargets.set(trimmedTarget, {
          count: (previousState?.count ?? 0) + 1,
          startedAtSeconds: previousState?.startedAtSeconds ?? this.interactionScheduler.nowSeconds
        })
        this.hostServices.writeVariable(`O:${trimmedTarget}:_ButtonAnimVar`, 1)
      } else if (binding.minHeldDurationSeconds > 0) {
        this.setInteractionFeedbackTimer(
          trimmedTarget,
          binding.minHeldDurationSeconds,
          binding.animationDurationSeconds == null
        )
        this.hostServices.writeVariable(`O:${trimmedTarget}:_ButtonAnimVar`, 1)
      }
    }
  }

  private releaseInteractionFeedback(binding: CompiledInteractionBinding): void {
    const targets = binding.feedbackTargets.length > 0 ? binding.feedbackTargets : [binding.target]
    let shouldRunReleaseExpression = true
    let maxRemainingMinimumHoldSeconds = 0
    const resetFeedbackVariables = (): void => {
      for (const variableKey of binding.feedbackVariableKeys) {
        this.hostServices.writeVariable(variableKey, 0)
      }
    }
    for (const target of targets) {
      const trimmedTarget = target.trim()
      if (!trimmedTarget) {
        continue
      }

      const previousState = this.heldInteractionFeedbackTargets.get(trimmedTarget)
      const nextHoldCount = (previousState?.count ?? 0) - 1
      if (nextHoldCount > 0) {
        this.heldInteractionFeedbackTargets.set(trimmedTarget, {
          count: nextHoldCount,
          startedAtSeconds: previousState?.startedAtSeconds ?? this.interactionScheduler.nowSeconds
        })
      } else {
        this.heldInteractionFeedbackTargets.delete(trimmedTarget)
        const elapsedSeconds =
          previousState == null
            ? 0
            : this.interactionScheduler.nowSeconds - previousState.startedAtSeconds
        const remainingMinimumHoldSeconds = Math.max(binding.minHeldDurationSeconds - elapsedSeconds, 0)
        if (remainingMinimumHoldSeconds > 0) {
          maxRemainingMinimumHoldSeconds = Math.max(maxRemainingMinimumHoldSeconds, remainingMinimumHoldSeconds)
          this.setInteractionFeedbackTimer(
            trimmedTarget,
            remainingMinimumHoldSeconds,
            binding.animationDurationSeconds == null
          )
          this.hostServices.writeVariable(`O:${trimmedTarget}:_ButtonAnimVar`, 1)
          shouldRunReleaseExpression = false
          continue
        }
        if (previousState != null) {
          this.hostServices.writeVariable(`O:${trimmedTarget}:_ButtonAnimVar`, 0)
        }
        if (!this.interactionFeedbackTimers.has(trimmedTarget) && binding.animationDurationSeconds == null) {
          this.hostServices.writeVariable(`O:${trimmedTarget}:_ButtonAnimVar`, 0)
          resetFeedbackVariables()
        }
      }
    }
    if (binding.feedbackVariableKeys.length > 0) {
      for (const target of targets) {
        const trimmedTarget = target.trim()
        if (trimmedTarget) {
          this.hostServices.writeVariable(`O:${trimmedTarget}:_ButtonAnimVar`, 0)
        }
      }
    }
    if (targets.length === 0 || binding.animationDurationSeconds == null) {
      resetFeedbackVariables()
    }
    if (shouldRunReleaseExpression) {
      this.executeInteractionReleaseBinding(binding)
    } else if (binding.releaseExpression != null) {
      const taskId = this.interactionScheduler.schedule(maxRemainingMinimumHoldSeconds, () => {
        if (this.delayedInteractionReleases.get(binding) !== taskId) return
        this.delayedInteractionReleases.delete(binding)
        this.executeInteractionReleaseBinding(binding)
      }, {
        scope: this.interactionSchedulerScope
      })
      this.delayedInteractionReleases.set(binding, taskId)
    }
  }

  private executeInteractionReleaseBinding(binding: CompiledInteractionBinding): void {
    this.invokeInteractionSoundEvents(binding, 'release')
    if (binding.releaseExpression == null) {
      return
    }

    this.hostServices.trace?.(() => ({
      kind: 'interaction-rpn',
      phase: 'release-expression',
      target: binding.metadata.qualifiedId,
      sourcePath: binding.sourcePath,
      expression: binding.releaseExpression?.source ?? ''
    }))
    evaluateCompiledExpression(binding.releaseExpression, {
      readVariable: (key, unit) => this.hostServices.readVariable(key, unit),
      writeVariable: (key, value, unit) => this.hostServices.writeVariable(key, value, unit, { source: 'interaction' }),
      invokeKeyEvent: (name, args) => this.hostServices.invokeKeyEvent?.(name, args),
      invokeHtmlEvent: (name, args) => this.hostServices.invokeHtmlEvent?.(name, args)
    })
  }

  private invokeInteractionSoundEvents(
    binding: CompiledInteractionBinding,
    phase: CompiledInteractionSoundEvent['phase']
  ): void {
    for (const soundEvent of binding.soundEvents) {
      if (soundEvent.phase !== phase) {
        continue
      }
      this.hostServices.invokeSoundEvent?.(soundEvent.name, {
        phase,
        target: binding.target,
        normalizedTime: soundEvent.normalizedTime,
        sourcePath: binding.sourcePath,
        sourceParameter: soundEvent.sourceParameter
      })
    }
  }

  private invokeAnimationTriggerBindings(animation: string, normalizedValue: number): void {
    const previousValue = this.animationTriggerValues.get(animation)
    this.animationTriggerValues.set(animation, normalizedValue)
    if (previousValue == null || Math.abs(normalizedValue - previousValue) <= 1e-6) {
      return
    }

    const direction = normalizedValue > previousValue ? 'forward' : 'backward'
    for (const binding of this.activeAnimationTriggerBindingsByAnimation.get(animation) ?? []) {
      if (
        binding.direction !== 'both' && binding.direction !== direction
      ) {
        continue
      }

      const crossedTrigger =
        binding.normalizedTime == null
          ? true
          : direction === 'forward'
            ? previousValue < binding.normalizedTime && normalizedValue >= binding.normalizedTime
            : previousValue > binding.normalizedTime && normalizedValue <= binding.normalizedTime
      if (!crossedTrigger) {
        continue
      }

      if (binding.eventKind === 'sound') {
        this.hostServices.invokeSoundEvent?.(binding.eventName, {
          phase: direction === 'forward' ? 'press' : 'release',
          target: binding.animation,
          normalizedTime: binding.normalizedTime,
          sourcePath: binding.sourcePath,
          sourceParameter: `AnimationTriggers:${binding.action}`
        })
      } else {
        this.hostServices.invokeEffectEvent?.(binding.eventName, {
          action: binding.action,
          direction,
          target: binding.animation,
          normalizedTime: binding.normalizedTime,
          sourcePath: binding.sourcePath
        })
      }
    }
  }

  private setInteractionFeedbackTimer(
    target: string,
    remainingSeconds: number,
    resetOnExpire: boolean
  ): void {
    const previousTimer = this.interactionFeedbackTimers.get(target)
    const dueAtSeconds = Math.max(
      previousTimer?.dueAtSeconds ?? 0,
      this.interactionScheduler.nowSeconds + remainingSeconds
    )
    const nextResetOnExpire = (previousTimer?.resetOnExpire ?? false) || resetOnExpire
    if (previousTimer != null && previousTimer.dueAtSeconds === dueAtSeconds &&
        previousTimer.resetOnExpire === nextResetOnExpire) return
    if (previousTimer != null) this.interactionScheduler.cancel(previousTimer.taskId)
    const timer: RuntimeInteractionFeedbackTimer = {
      taskId: 0,
      dueAtSeconds,
      resetOnExpire: nextResetOnExpire
    }
    timer.taskId = this.interactionScheduler.schedule(
      Math.max(dueAtSeconds - this.interactionScheduler.nowSeconds, 0),
      () => {
        if (this.interactionFeedbackTimers.get(target) !== timer) return
        this.interactionFeedbackTimers.delete(target)
        if (!this.heldInteractionFeedbackTargets.has(target) && timer.resetOnExpire) {
          this.hostServices.writeVariable(`O:${target}:_ButtonAnimVar`, 0)
        }
      },
      { scope: this.interactionSchedulerScope }
    )
    this.interactionFeedbackTimers.set(target, timer)
  }

  private publishInteractionFeedback(): void {
    for (const target of this.heldInteractionFeedbackTargets.keys()) {
      this.hostServices.writeVariable(`O:${target}:_ButtonAnimVar`, 1)
    }
  }
}

function buildRuntimeMaterialBindings(
  bindings: readonly CompiledMaterialBinding[],
  nodes: ReadonlyMap<string, Object3D>
): readonly RuntimeMaterialBinding[] {
  const clonedObjects = new WeakSet<Object3D>()
  const runtimeBindings: RuntimeMaterialBinding[] = []

  for (const binding of bindings) {
    const object = nodes.get(binding.target) ?? nodes.get(binding.target.toLowerCase())
    if (object == null || !hasMaterial(object)) {
      continue
    }

    const materials = ensureRuntimeMaterials(object, clonedObjects)
    if (materials.length === 0) {
      continue
    }

    runtimeBindings.push({
      binding,
      dependencies: getRuntimeExpressionDependencies(binding.expression),
      lastAppliedValue: null,
      lastDependencyValues: null,
      materials: materials.map(material => ({
        material,
        baseEmissiveIntensity: getMaterialEmissiveIntensity(material),
        baseEmissiveColor: getMaterialEmissiveColor(material)
      }))
    })
  }

  return runtimeBindings
}

function buildRuntimeCanonicalVisualBindings(
  visuals: readonly CanonicalVisualDefinition[],
  nodes: ReadonlyMap<string, Object3D>
): readonly RuntimeCanonicalVisualBinding[] {
  const clonedObjects = new WeakSet<Object3D>()
  const runtimeBindings: RuntimeCanonicalVisualBinding[] = []

  for (const visual of visuals) {
    if (visual.stateKey == null || visual.target == null) continue
    const channel = visual.channel ?? 'animation'
    const object =
      nodes.get(visual.target) ?? nodes.get(visual.target.toLowerCase())
    const materials =
      channel === 'material' && object != null
        ? ensureRuntimeMaterials(object, clonedObjects).map(material => ({
            material,
            baseEmissiveIntensity: getMaterialEmissiveIntensity(material),
            baseEmissiveColor: getMaterialEmissiveColor(material),
          }))
        : []

    if (channel !== 'animation' && object == null) continue
    if (channel === 'material' && materials.length === 0) continue

    runtimeBindings.push({
      visual,
      channel,
      target: visual.target,
      node: object ?? null,
      materials,
    })
  }

  return runtimeBindings
}

function buildRuntimeVisibilityBindings(
  bindings: readonly CompiledVisibilityBinding[],
  nodes: ReadonlyMap<string, Object3D>
): readonly RuntimeVisibilityBinding[] {
  const runtimeBindings: RuntimeVisibilityBinding[] = []
  for (const binding of bindings) {
    const node = nodes.get(binding.target) ?? nodes.get(binding.target.toLowerCase())
    if (node == null) {
      continue
    }
    runtimeBindings.push({
      binding,
      node,
      dependencies: getRuntimeExpressionDependencies(binding.expression),
      lastEvaluatedVisible: null,
      lastDependencyValues: null
    })
  }
  return runtimeBindings
}

function getRuntimeExpressionDependencies(
  expression: CompiledExpression
): readonly RuntimeExpressionDependency[] | null {
  const dependencies = new Map<string, RuntimeExpressionDependency>()
  if (!collectRuntimeExpressionDependencies(expression.instructions, dependencies)) {
    return null
  }
  return [...dependencies.values()]
}

function collectRuntimeExpressionDependencies(
  instructions: readonly Instruction[],
  dependencies: Map<string, RuntimeExpressionDependency>
): boolean {
  for (const instruction of instructions) {
    switch (instruction.op) {
      case 'pushVariable': {
        const cacheKey = getRuntimeVariableDependencyCacheKey(
          instruction.key,
          instruction.unit
        )
        dependencies.set(cacheKey, {
          key: instruction.key,
          unit: instruction.unit
        })
        break
      }
      case 'pushStringVariable':
      case 'pushParameter':
      case 'writeVariable':
      case 'invokeKeyEvent':
      case 'invokeHtmlEvent':
        return false
      case 'if':
        if (
          !collectRuntimeExpressionDependencies(instruction.thenInstructions, dependencies) ||
          !collectRuntimeExpressionDependencies(instruction.elseInstructions, dependencies)
        ) {
          return false
        }
        break
    }
  }
  return true
}

function getRuntimeVariableDependencyCacheKey(
  key: string,
  unit: string | null | undefined
): string {
  return `${key}\u0000${unit ?? ''}`
}

function readRuntimeExpressionDependencyValues(
  dependencies: readonly RuntimeExpressionDependency[],
  readVariable: RuntimeHostServices['readVariable']
): readonly number[] {
  return dependencies.map(dependency => readVariable(dependency.key, dependency.unit))
}

function runtimeDependencyValuesEqual(
  left: readonly number[] | null,
  right: readonly number[]
): boolean {
  if (left == null || left.length !== right.length) {
    return false
  }
  for (let index = 0; index < right.length; index += 1) {
    if (Math.abs(left[index]! - right[index]!) >= 1e-6) {
      return false
    }
  }
  return true
}

function hasMaterial(object: Object3D): object is MaterialObject {
  return 'material' in object && (object as MaterialObject).material != null
}

function ensureRuntimeMaterials(
  object: MaterialObject,
  clonedObjects: WeakSet<Object3D>
): readonly RuntimeMaterial[] {
  if (!clonedObjects.has(object)) {
    const material = object.material
    if (Array.isArray(material)) {
      object.material = material.map(candidate => candidate.clone())
    } else if (material != null) {
      object.material = material.clone()
    }
    clonedObjects.add(object)
  }

  const material = object.material
  if (Array.isArray(material)) {
    return material.filter((candidate): candidate is RuntimeMaterial => candidate != null)
  }
  return material == null ? [] : [material as RuntimeMaterial]
}

function readCanonicalVisualRatio(
  simulatorEngine: SimulatorEngine,
  stateKey: string
): number {
  const rawValue =
    simulatorEngine.state.readNumber(stateKey, { unit: 'ratio', fallback: 0 }) ??
    0
  if (!Number.isFinite(rawValue)) return 0
  return clamp(rawValue, 0, 1)
}

function applyCanonicalVisualMaterialBinding(
  state: RuntimeBoundMaterial,
  value: number
): void {
  const nextIntensity = Math.max(0, value) * state.baseEmissiveIntensity
  const previousIntensity = getMaterialEmissiveIntensity(state.material)
  if (Math.abs(previousIntensity - nextIntensity) < 1e-6) return

  if (state.baseEmissiveColor != null && state.material.emissive != null) {
    state.material.emissive.setRGB(
      state.baseEmissiveColor[0],
      state.baseEmissiveColor[1],
      state.baseEmissiveColor[2]
    )
  }
  state.material.emissiveIntensity = nextIntensity
  state.material.needsUpdate = true
}

function applyRuntimeMaterialBinding(
  state: RuntimeBoundMaterial,
  value: number,
  binding: CompiledMaterialBinding
): void {
  if (binding.property !== 'emissive') {
    return
  }

  const nextIntensity = binding.overrideBaseEmissive
    ? Math.max(0, value) * state.baseEmissiveIntensity
    : state.baseEmissiveIntensity + Math.max(0, value)
  const previousIntensity = getMaterialEmissiveIntensity(state.material)
  const nextColor = resolveRuntimeEmissiveColor(state, nextIntensity, binding)
  const previousColor = getMaterialEmissiveColor(state.material)
  if (
    Math.abs(previousIntensity - nextIntensity) < 1e-6 &&
    emissiveColorsEqual(previousColor, nextColor)
  ) {
    return
  }

  if (nextColor != null && state.material.emissive != null) {
    state.material.emissive.setRGB(nextColor[0], nextColor[1], nextColor[2])
  }
  state.material.emissiveIntensity = nextIntensity
  state.material.needsUpdate = true
}

function getMaterialEmissiveIntensity(material: RuntimeMaterial): number {
  return typeof material.emissiveIntensity === 'number' ? material.emissiveIntensity : 1
}

function getMaterialEmissiveColor(material: RuntimeMaterial): readonly [number, number, number] | null {
  return material.emissive == null
    ? null
    : [material.emissive.r, material.emissive.g, material.emissive.b]
}

function resolveRuntimeEmissiveColor(
  state: RuntimeBoundMaterial,
  nextIntensity: number,
  binding: CompiledMaterialBinding
): readonly [number, number, number] | null {
  const baseColor = state.baseEmissiveColor
  if (baseColor == null) {
    return null
  }
  if (!binding.overrideBaseEmissive) {
    return baseColor
  }
  if (nextIntensity <= 0) {
    return baseColor
  }
  return isBlackEmissiveColor(baseColor) ? [1, 1, 1] : baseColor
}

function isBlackEmissiveColor(color: readonly [number, number, number]): boolean {
  return color[0] <= 1e-6 && color[1] <= 1e-6 && color[2] <= 1e-6
}

function emissiveColorsEqual(
  left: readonly [number, number, number] | null,
  right: readonly [number, number, number] | null
): boolean {
  if (left == null || right == null) {
    return left == null && right == null
  }
  return (
    Math.abs(left[0] - right[0]) < 1e-6 &&
    Math.abs(left[1] - right[1]) < 1e-6 &&
    Math.abs(left[2] - right[2]) < 1e-6
  )
}

function selectBestInteractionBinding(
  bindings: readonly CompiledInteractionBinding[]
): CompiledInteractionBinding | null {
  if (bindings.length === 0) {
    return null
  }
  return [...bindings].sort((left, right) =>
    scoreInteractionBinding(right) - scoreInteractionBinding(left)
  )[0] ?? null
}

function scoreInteractionBinding(binding: CompiledInteractionBinding): number {
  const source = binding.expression.source
  const sideEffectScore =
    countSubstring(source, '(>K:') * 20 +
    countSubstring(source, '(>H:') * 20 +
    countSubstring(source, '(>B:') * 20 +
    countSubstring(source, '(>L:') * 6 +
    countSubstring(source, '(>A:') * 6 +
    countSubstring(source, '(>O:') * 4
  return sideEffectScore + source.length / 1000
}

function countSubstring(value: string, needle: string): number {
  if (!needle) {
    return 0
  }
  let count = 0
  let offset = 0
  while (true) {
    const index = value.indexOf(needle, offset)
    if (index < 0) {
      return count
    }
    count += 1
    offset = index + needle.length
  }
}

export type RuntimeVariableNamespace = 'A' | 'L' | 'O' | 'K' | 'H' | 'B' | 'E' | 'I'

export interface SharedRuntimeHostStats {
  readonly variableReadCount: number
  readonly variableReadCacheHitCount: number
  readonly variableReadCacheMissCount: number
  readonly variableWriteCount: number
  readonly keyEventCount: number
  readonly htmlEventCount: number
  readonly soundEventCount: number
  readonly bridgeCallCount: number
  readonly storedVariableCount: number
  readonly defaultedVariableCount: number
  readonly controlState: {
    readonly gearTarget: number
    readonly gearPosition: number
    readonly flapsTarget: number
    readonly flapsPosition: number
    readonly spoilersTarget: number
    readonly spoilersPosition: number
    readonly aileronTarget: number
    readonly aileronPosition: number
    readonly elevatorTarget: number
    readonly elevatorPosition: number
    readonly rudderTarget: number
    readonly rudderPosition: number
    readonly parkingBrake: number
  }
  readonly electricalState: {
    readonly batterySwitch: number
    readonly externalPowerSwitch: number
    readonly externalPowerAvailable: number
    readonly avionicsSwitch: number
  }
}

export interface RuntimeSoundEvent {
  readonly name: string
  readonly phase: 'press' | 'release' | 'start' | 'stop'
  readonly target: string
  readonly normalizedTime: number | null
  readonly sourcePath: string
  readonly sourceParameter: string
  readonly sequence: number
}

export interface RuntimeEffectEvent {
  readonly name: string
  readonly action: string
  readonly direction: 'forward' | 'backward'
  readonly target: string
  readonly normalizedTime: number | null
  readonly sourcePath: string
  readonly sequence: number
}

export interface RuntimeHtmlEvent {
  readonly name: string
  readonly args: readonly (number | string)[]
  readonly sequence: number
}

export interface RuntimeKeyEvent {
  readonly name: string
  readonly args: readonly number[]
  readonly sequence: number
}

export interface RuntimeBridgeEvent {
  readonly name: string
  readonly value: number
  readonly args: readonly number[]
  readonly handledByBinding: boolean
  readonly sequence: number
}

export type RuntimeHtmlEventListener = (event: RuntimeHtmlEvent) => void
export type RuntimeKeyEventListener = (event: RuntimeKeyEvent) => void

export class SharedMsfsRuntimeHost implements RuntimeHostServices {
  private elapsedSeconds = 0
  private readonly values = new Map<string, number>()
  private readonly readCache = new Map<string, number>()
  private readonly defaultedKeys = new Set<string>()
  readonly simulatorEngine: SimulatorEngine
  private readonly msfsCompatibilityBridge: MsfsCompatibilityBridge
  private readonly wingFlexProfile: DemoWingFlexProfile
  private engineCycleTarget = 0
  private throttleLeverPosition = 0
  private variableReadCount = 0
  private variableReadCacheHitCount = 0
  private variableReadCacheMissCount = 0
  private variableWriteCount = 0
  private keyEventCount = 0
  private htmlEventCount = 0
  private soundEventCount = 0
  private effectEventCount = 0
  private bridgeCallCount = 0
  private defaultedVariableCount = 0
  private readonly inputEventBindings = new Map<string, CompiledExpression>()
  private readonly activeInputEventBindings = new Set<string>()
  private readonly recentHtmlEvents: RuntimeHtmlEvent[] = []
  private readonly htmlEventListeners = new Set<RuntimeHtmlEventListener>()
  private readonly recentKeyEvents: RuntimeKeyEvent[] = []
  private readonly keyEventListeners = new Set<RuntimeKeyEventListener>()
  private readonly variableChangeListeners = new Set<RuntimeVariableChangeListener>()
  private readonly recentSoundEvents: RuntimeSoundEvent[] = []
  private readonly recentEffectEvents: RuntimeEffectEvent[] = []
  private readonly recentBridgeEvents: RuntimeBridgeEvent[] = []
  private readonly soundStates = new Map<string, boolean>()
  private readonly simVarSounds: readonly ImportedSimVarSound[]
  private readonly initialDiagnosticCount: number
  private controlState = createInitialRuntimeControlState()
  private electricalState = createInitialRuntimeElectricalState()
  private cycles = createInitialRuntimeCycles()
  private traceSink?: (record: () => Readonly<Record<string, unknown>>) => void

  constructor(
    private readonly diagnostics: ImportDiagnostic[],
    private readonly aircraft?: ImportedAircraft
  ) {
    this.initialDiagnosticCount = diagnostics.length
    this.simulatorEngine = createSimulatorEngineForAircraft(
      createCanonicalAircraftDefinition(aircraft) ?? {
        identity: { id: 'runtime-aircraft' },
      }
    )
    this.msfsCompatibilityBridge = new MsfsCompatibilityBridge(
      this.simulatorEngine.state
    )
    this.simulatorEngine.state.subscribe(() => {
      this.readCache.clear()
    })
    this.simulatorEngine.commands.subscribe('*', () => {
      this.readCache.clear()
    })
    this.wingFlexProfile = createDemoWingFlexProfile(aircraft)
    this.simVarSounds = aircraft?.soundDefinition?.simVarSounds ?? []
    this.seedColdAndDarkState()
    this.seedPreviewFlightState(aircraft?.previewFlightState ?? null)
  }

  setTraceSink(sink?: (record: () => Readonly<Record<string, unknown>>) => void): void {
    this.traceSink = sink
  }

  trace(record: () => Readonly<Record<string, unknown>>): void {
    this.traceSink?.(record)
  }

  resetRuntimeState(options: { readonly coldAndDark?: boolean } = {}): void {
    this.elapsedSeconds = 0
    this.values.clear()
    this.readCache.clear()
    this.defaultedKeys.clear()
    this.simulatorEngine.state.clearSourceValues('runtime')
    this.simulatorEngine.state.clearSourceValues('loaded')
    this.engineCycleTarget = 0
    this.throttleLeverPosition = 0
    this.variableReadCount = 0
    this.variableReadCacheHitCount = 0
    this.variableReadCacheMissCount = 0
    this.variableWriteCount = 0
    this.keyEventCount = 0
    this.htmlEventCount = 0
    this.soundEventCount = 0
    this.effectEventCount = 0
    this.bridgeCallCount = 0
    this.defaultedVariableCount = 0
    this.activeInputEventBindings.clear()
    this.recentHtmlEvents.length = 0
    this.recentKeyEvents.length = 0
    this.recentSoundEvents.length = 0
    this.recentEffectEvents.length = 0
    this.recentBridgeEvents.length = 0
    this.soundStates.clear()
    this.controlState = createInitialRuntimeControlState()
    this.electricalState = createInitialRuntimeElectricalState()
    this.cycles = createInitialRuntimeCycles()
    this.diagnostics.splice(this.initialDiagnosticCount)
    this.seedColdAndDarkState()
    if (options.coldAndDark !== true) {
      this.seedPreviewFlightState(this.aircraft?.previewFlightState ?? null)
    }
  }

  seedVariable(key: string, value: number): boolean {
    const normalizedKey = normalizeRuntimeVariableKey(key)
    if (this.values.has(normalizedKey)) {
      return false
    }
    this.readCache.clear()
    this.values.set(normalizedKey, value)
    this.writeEngineCompatibilityVariable(normalizedKey, value, null, 'loaded')
    this.emitVariableChange(normalizedKey)
    return true
  }

  tick(dtSeconds: number): void {
    this.readCache.clear()
    this.elapsedSeconds += dtSeconds
    this.simulatorEngine.tick(dtSeconds)
    this.publishPropulsionVariables()
    this.controlState.gearPosition = moveTowards(
      this.controlState.gearPosition,
      this.controlState.gearTarget,
      dtSeconds * 1.75
    )
    this.controlState.flapsPosition = moveTowards(
      this.controlState.flapsPosition,
      this.controlState.flapsTarget,
      dtSeconds * 0.85
    )
    this.controlState.spoilersPosition = moveTowards(
      this.controlState.spoilersPosition,
      this.controlState.spoilersTarget,
      dtSeconds * 2.5
    )
    this.controlState.aileronPosition = moveTowards(
      this.controlState.aileronPosition,
      this.controlState.aileronTarget,
      dtSeconds * 4
    )
    this.controlState.elevatorPosition = moveTowards(
      this.controlState.elevatorPosition,
      this.controlState.elevatorTarget,
      dtSeconds * 4
    )
    this.controlState.rudderPosition = moveTowards(
      this.controlState.rudderPosition,
      this.controlState.rudderTarget,
      dtSeconds * 4
    )
    this.cycles = {
      gearCycle: this.controlState.gearPosition,
      flapCycle: this.controlState.flapsPosition,
      spoilerCycle: this.controlState.spoilersPosition,
      engineCycle: this.engineCycleTarget,
      aileronCycle: this.controlState.aileronPosition,
      elevatorCycle: this.controlState.elevatorPosition,
      rudderCycle: this.controlState.rudderPosition,
      reverserCycle: 0,
      dtSeconds
    }

    this.values.set(normalizeRuntimeVariableKey('A:ANIMATION DELTA TIME'), dtSeconds)
    this.publishControlVariables()
    this.publishElectricalVariables()
    this.updateSimVarSounds()
  }

  readVariable(key: string, unit?: string | null): number {
    this.variableReadCount += 1
    const normalizedKey = normalizeRuntimeVariableKey(key)
    const normalizedUnit = normalizeUnit(unit ?? null)
    const cacheKey = `${normalizedKey}\u0000${normalizedUnit}`
    const cachedValue = this.readCache.get(cacheKey)
    if (cachedValue != null) {
      this.variableReadCacheHitCount += 1
      return this.finishVariableRead(normalizedKey, normalizedUnit, cachedValue, 'cache')
    }
    this.variableReadCacheMissCount += 1

    const engineValue = this.msfsCompatibilityBridge.readSimVar(
      normalizedKey,
      unit
    )
    if (engineValue != null) {
      this.readCache.set(cacheKey, engineValue)
      return this.finishVariableRead(normalizedKey, normalizedUnit, engineValue, 'canonical-simvar')
    }

    const localEngineValue =
      this.msfsCompatibilityBridge.readLocalVar(normalizedKey, unit)
    if (localEngineValue != null) {
      this.readCache.set(cacheKey, localEngineValue)
      return this.finishVariableRead(normalizedKey, normalizedUnit, localEngineValue, 'canonical-localvar')
    }

    if (normalizedKey === 'A:TURBINE IGNITION SWITCH') {
      const indexedValue = this.resolveIndexedTurbineIgnitionSwitch()
      if (indexedValue != null) {
        this.readCache.set(cacheKey, indexedValue)
        return this.finishVariableRead(normalizedKey, normalizedUnit, indexedValue, 'indexed-fallback')
      }
    }
    if (this.values.has(normalizedKey)) {
      const value = resolveStoredRuntimeValue(
        normalizedKey,
        this.values.get(normalizedKey) ?? 0,
        unit ?? null
      )
      this.readCache.set(cacheKey, value)
      return this.finishVariableRead(normalizedKey, normalizedUnit, value, 'runtime')
    }
    const dynamicControlValue = this.resolveDynamicControlFallbackValue(normalizedKey, unit ?? null)
    if (dynamicControlValue != null) {
      this.readCache.set(cacheKey, dynamicControlValue)
      return this.finishVariableRead(normalizedKey, normalizedUnit, dynamicControlValue, 'dynamic-control')
    }
    const resolved = this.resolveHeuristicValue(normalizedKey, unit ?? null, this.cycles)

    if (
      !resolved.handled ||
      (isRuntimeStoredVariableKey(normalizedKey) && !isDynamicRuntimeFallbackKey(normalizedKey))
    ) {
      this.values.set(normalizedKey, resolved.value)
    }
    if (!resolved.handled && !this.defaultedKeys.has(normalizedKey)) {
      this.defaultedKeys.add(normalizedKey)
      this.defaultedVariableCount += 1
      this.diagnostics.push({
        code: 'runtime_variable_defaulted',
        message: `Variable ${normalizedKey} is not provided by the demo host and defaulted to 0.`,
        severity: 'info'
      })
    }

    this.readCache.set(cacheKey, resolved.value)
    return this.finishVariableRead(normalizedKey, normalizedUnit, resolved.value, 'runtime')
  }

  private finishVariableRead(
    key: string,
    unit: string,
    value: number,
    source: string
  ): number {
    this.trace(() => ({ kind: 'variable-read', key, unit, value, source }))
    return value
  }

  writeVariable(
    key: string,
    value: number,
    unit?: string | null,
    options?: { readonly source?: 'update' | 'interaction' | 'input-event' }
  ): void {
    this.variableWriteCount += 1
    this.readCache.clear()
    const normalizedKey = normalizeRuntimeVariableKey(key)
    const numericValue = Number(value)
    this.trace(() => ({
      kind: 'variable-write',
      key: normalizedKey,
      unit: normalizeUnit(unit ?? null),
      value: Number.isFinite(numericValue) ? numericValue : 0
    }))
    this.writeEngineCompatibilityVariable(normalizedKey, numericValue, unit)
    if (normalizedKey.startsWith('B:')) {
      const handledByBinding = this.invokeInputEventBinding(
        normalizedKey.slice(2),
        Number.isFinite(numericValue) ? numericValue : 0
      )
      if (!handledByBinding) {
        const inputEventName = normalizedKey.slice(2)
        const inputEventValue = Number.isFinite(numericValue) ? numericValue : 0
        this.applyGenericControlEventName(inputEventName, inputEventValue)
        this.applyGenericInputEventStateName(inputEventName, inputEventValue)
      }
      this.emitVariableChange(normalizedKey)
      return
    }
    if (normalizedKey.startsWith('K:')) {
      this.invokeKeyEvent(normalizedKey.slice(2), [Number.isFinite(numericValue) ? numericValue : 0])
      return
    }
    this.values.set(normalizedKey, Number.isFinite(numericValue) ? numericValue : 0)
    if (normalizedKey.startsWith('H:')) {
      this.invokeHtmlEvent(normalizedKey.slice(2), [normalizedKey.slice(2), Number.isFinite(numericValue) ? numericValue : 0])
    }
    if (!(options?.source === 'update' && normalizedKey.startsWith('O:'))) {
      this.applyLocalVariableSideEffects(normalizedKey, numericValue)
      this.applyElectricalVariableSideEffects(normalizedKey, numericValue, unit ?? null)
      this.applyVariableSideEffects(normalizedKey, numericValue, unit ?? null)
    }
    this.emitVariableChange(normalizedKey)
  }

  invokeKeyEvent(name: string, args: readonly number[]): void {
    this.keyEventCount += 1
    this.readCache.clear()
    const value = args.at(-1) ?? 1
    const normalizedEventName = normalizeKeyEventName(name)
    this.values.set(normalizeRuntimeVariableKey(`K:${normalizedEventName}`), value)
    this.applyKeyEvent(normalizedEventName, args)
    this.publishControlVariables()
    this.publishElectricalVariables()
    const event: RuntimeKeyEvent = {
      name: normalizedEventName,
      args: [...args],
      sequence: this.keyEventCount
    }
    this.trace(() => ({ kind: 'key-event', ...event }))
    this.recentKeyEvents.push(event)
    if (this.recentKeyEvents.length > 100) {
      this.recentKeyEvents.splice(0, this.recentKeyEvents.length - 100)
    }
    for (const listener of this.keyEventListeners) {
      try {
        listener(event)
      } catch (error) {
        console.warn('MSFS runtime key-event listener failed.', error)
      }
    }
    this.emitVariableChange(normalizeRuntimeVariableKey(`K:${normalizedEventName}`))
  }

  invokeHtmlEvent(name: string, args: readonly (number | string)[]): void {
    const eventName = name.trim()
    if (!eventName) {
      return
    }
    this.htmlEventCount += 1
    this.readCache.clear()
    const event: RuntimeHtmlEvent = {
      name: eventName,
      args: args.length > 0 ? [...args] : [eventName],
      sequence: this.htmlEventCount
    }
    this.trace(() => ({ kind: 'html-event', ...event }))
    this.values.set(normalizeRuntimeVariableKey(`H:${eventName}`), event.sequence)
    this.applyHtmlEventSideEffects(eventName, event.args)
    this.recentHtmlEvents.push(event)
    if (this.recentHtmlEvents.length > 100) {
      this.recentHtmlEvents.splice(0, this.recentHtmlEvents.length - 100)
    }
    for (const listener of this.htmlEventListeners) {
      try {
        listener(event)
      } catch (error) {
        console.warn('MSFS runtime HTML-event listener failed.', error)
      }
    }
    this.emitVariableChange(normalizeRuntimeVariableKey(`H:${eventName}`))
  }

  addHtmlEventListener(listener: RuntimeHtmlEventListener): () => void {
    this.htmlEventListeners.add(listener)
    return () => {
      this.htmlEventListeners.delete(listener)
    }
  }

  addKeyEventListener(listener: RuntimeKeyEventListener): () => void {
    this.keyEventListeners.add(listener)
    return () => {
      this.keyEventListeners.delete(listener)
    }
  }

  subscribeVariable(listener: RuntimeVariableChangeListener): () => void {
    this.variableChangeListeners.add(listener)
    return () => {
      this.variableChangeListeners.delete(listener)
    }
  }

  private emitVariableChange(key: string): void {
    for (const listener of this.variableChangeListeners) {
      try {
        listener({ key })
      } catch (error) {
        console.warn('MSFS runtime variable listener failed.', error)
      }
    }
  }

  invokeSoundEvent(
    name: string,
    event: {
      readonly phase: 'press' | 'release'
      readonly target: string
      readonly normalizedTime: number | null
      readonly sourcePath: string
      readonly sourceParameter: string
    }
  ): void {
    this.recordSoundEvent(name, event)
  }

  invokeEffectEvent(
    name: string,
    event: {
      readonly action: string
      readonly direction: 'forward' | 'backward'
      readonly target: string
      readonly normalizedTime: number | null
      readonly sourcePath: string
    }
  ): void {
    const effectName = name.trim()
    if (!effectName) {
      return
    }
    this.effectEventCount += 1
    this.recentEffectEvents.push({
      name: effectName,
      action: event.action,
      direction: event.direction,
      target: event.target,
      normalizedTime: event.normalizedTime,
      sourcePath: event.sourcePath,
      sequence: this.effectEventCount
    })
    this.trace(() => ({ kind: 'effect-event', name: effectName, ...event }))
    if (this.recentEffectEvents.length > 100) {
      this.recentEffectEvents.splice(0, this.recentEffectEvents.length - 100)
    }
  }

  setInputEventBindings(bindings: readonly CompiledInputEventBinding[]): void {
    this.inputEventBindings.clear()
    for (const binding of bindings) {
      this.inputEventBindings.set(normalizeRuntimeInputEventName(binding.name), binding.expression)
    }
  }

  getInputEventBindingNames(): readonly string[] {
    return [...this.inputEventBindings.keys()].sort()
  }

  private invokeInputEventBinding(name: string, values: number | readonly number[]): boolean {
    this.bridgeCallCount += 1
    const normalizedName = normalizeRuntimeInputEventName(name)
    const parameterValues = normalizeRuntimeBridgeArgs(values)
    const value = parameterValues[0] ?? 0
    this.values.set(normalizeRuntimeVariableKey(`B:${normalizedName}`), value)
    const binding = this.inputEventBindings.get(normalizedName)
    if (binding == null || this.activeInputEventBindings.has(normalizedName)) {
      this.recordBridgeEvent(normalizedName, parameterValues, false)
      return false
    }

    if (shouldPublishGenericHandledInputEventState(normalizedName)) {
      this.applyGenericInputEventStateName(normalizedName, value)
    }
    this.activeInputEventBindings.add(normalizedName)
    let handledByBinding = false
    try {
      this.trace(() => ({
        kind: 'input-event-rpn',
        phase: 'execute',
        name: normalizedName,
        source: binding.source,
        parameterValues,
        variableKeys: binding.variableKeys
      }))
      evaluateCompiledExpression(binding, {
        readVariable: (key, unit) => this.readVariable(key, unit),
        writeVariable: (key, nextValue, unit) => this.writeVariable(key, nextValue, unit, { source: 'input-event' }),
        invokeKeyEvent: (eventName, args) => this.invokeKeyEvent(eventName, args),
        invokeHtmlEvent: (eventName, args) => this.invokeHtmlEvent(eventName, args),
        parameterValues
      })
      handledByBinding = true
      return true
    } finally {
      this.activeInputEventBindings.delete(normalizedName)
      this.recordBridgeEvent(normalizedName, parameterValues, handledByBinding)
    }
  }

  private recordBridgeEvent(
    name: string,
    args: readonly number[],
    handledByBinding: boolean
  ): void {
    const event = {
      name,
      value: args[0] ?? 0,
      args: [...args],
      handledByBinding,
      sequence: this.bridgeCallCount
    }
    this.recentBridgeEvents.push(event)
    this.trace(() => ({ kind: 'bridge-event', ...event }))
    if (this.recentBridgeEvents.length > 100) {
      this.recentBridgeEvents.splice(0, this.recentBridgeEvents.length - 100)
    }
  }

  private recordSoundEvent(
    name: string,
    event: {
      readonly phase: RuntimeSoundEvent['phase']
      readonly target: string
      readonly normalizedTime: number | null
      readonly sourcePath: string
      readonly sourceParameter: string
    }
  ): void {
    const soundName = name.trim()
    if (!soundName) {
      return
    }
    this.soundEventCount += 1
    this.recentSoundEvents.push({
      name: soundName,
      phase: event.phase,
      target: event.target,
      normalizedTime: event.normalizedTime,
      sourcePath: event.sourcePath,
      sourceParameter: event.sourceParameter,
      sequence: this.soundEventCount
    })
    this.trace(() => ({ kind: 'sound-event', name: soundName, ...event }))
    if (this.recentSoundEvents.length > 100) {
      this.recentSoundEvents.splice(0, this.recentSoundEvents.length - 100)
    }
  }

  invokeBridgeCall(name: string, args: readonly number[] = [1]): void {
    this.readCache.clear()
    const values = normalizeRuntimeBridgeArgs(args.length > 0 ? args : [1])
    const handledByBinding = this.invokeInputEventBinding(name, values)
    const value = values[0] ?? 0
    if (!handledByBinding) {
      this.applyGenericControlEventName(name, value)
      this.applyGenericInputEventStateName(name, value)
    }
  }

  private applyHtmlEventSideEffects(name: string, _args: readonly (number | string)[]): void {
    const normalizedName = name.trim().toUpperCase()
    this.applyFmcBrightnessHtmlEventSideEffects(normalizedName)
    if (normalizedName === 'GENERIC_GEAR_ADVISORY_PUSH') {
      this.values.set(normalizeRuntimeVariableKey('L:Generic_Gear_Advisory_Active'), 0)
      this.values.set(normalizeRuntimeVariableKey('L:Generic_Gear_Advisory_Acknowledged'), 1)
    }
  }

  private applyFmcBrightnessHtmlEventSideEffects(normalizedName: string): void {
    const match = /(?:^|_)CDU_([1-9]\d*)_BTN_(BRT|DIM)$/u.exec(normalizedName)
    if (match == null) {
      return
    }

    const [, id, direction] = match
    const brightnessKey = normalizeRuntimeVariableKey(`I:XMLVAR_MCDU_${id}_Brightness`)
    const current = this.readVariable(brightnessKey)
    const delta = direction === 'BRT' ? 0.03 : -0.03
    this.values.set(brightnessKey, clamp(current + delta, 0.05, 1))
    this.readCache.clear()
  }

  private applyLocalVariableSideEffects(key: string, value: number): void {
 if (!key.startsWith('L:')) {
 return
 }
 this.msfsCompatibilityBridge.writeLocalVar(key, value)
 const normalizedValue = Number.isFinite(value) && value > 0 ? 1 : 0
    if (isApuMasterLocalSwitchKey(key)) {
      this.values.set(normalizeRuntimeVariableKey('A:APU MASTER SWITCH'), normalizedValue)
      this.values.set(normalizeRuntimeVariableKey('A:APU SWITCH'), normalizedValue)
      this.msfsCompatibilityBridge.writeSimVar('A:APU MASTER SWITCH', normalizedValue, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar('A:APU SWITCH', normalizedValue, 'Bool')
      if (normalizedValue > 0) {
        this.values.set(normalizeRuntimeVariableKey('A:APU GENERATOR ACTIVE:1'), 1)
        this.values.set(normalizeRuntimeVariableKey('A:APU PCT RPM'), Math.max(this.values.get(normalizeRuntimeVariableKey('A:APU PCT RPM')) ?? 0, 5))
        this.msfsCompatibilityBridge.writeSimVar(
          'A:APU PCT RPM',
          Math.max(this.values.get(normalizeRuntimeVariableKey('A:APU PCT RPM')) ?? 0, 5),
          'percent'
        )
      } else {
        this.values.set(normalizeRuntimeVariableKey('A:APU PCT RPM'), 0)
        this.msfsCompatibilityBridge.writeSimVar('A:APU PCT RPM', 0, 'percent')
      }
      return
    }
    if (isApuStartLocalSwitchKey(key)) {
      this.values.set(normalizeRuntimeVariableKey('A:APU STARTER'), normalizedValue)
      this.values.set(normalizeRuntimeVariableKey('A:APU SWITCH'), normalizedValue)
      this.values.set(normalizeRuntimeVariableKey('A:APU PCT RPM'), normalizedValue > 0 ? 100 : 0)
      this.msfsCompatibilityBridge.writeSimVar('A:APU STARTER', normalizedValue, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar('A:APU SWITCH', normalizedValue, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar(
        'A:APU PCT RPM',
        normalizedValue > 0 ? 100 : 0,
        'percent'
      )
      if (normalizedValue > 0) {
        this.values.set(normalizeRuntimeVariableKey('A:APU GENERATOR ACTIVE:1'), 1)
      }
      return
    }
    if (isApuBleedLocalSwitchKey(key)) {
      this.values.set(normalizeRuntimeVariableKey('A:BLEED AIR APU'), normalizedValue)
      this.values.set(normalizeRuntimeVariableKey('A:BLEED AIR SOURCE CONTROL'), normalizedValue)
    }
  }

  getStats(): SharedRuntimeHostStats {
    return {
      variableReadCount: this.variableReadCount,
      variableReadCacheHitCount: this.variableReadCacheHitCount,
      variableReadCacheMissCount: this.variableReadCacheMissCount,
      variableWriteCount: this.variableWriteCount,
      keyEventCount: this.keyEventCount,
      htmlEventCount: this.htmlEventCount,
      soundEventCount: this.soundEventCount,
      bridgeCallCount: this.bridgeCallCount,
      storedVariableCount: this.values.size,
      defaultedVariableCount: this.defaultedVariableCount,
      controlState: { ...this.controlState },
      electricalState: { ...this.electricalState }
    }
  }

  getSnapshot(): Record<string, number> {
    return Object.fromEntries(this.values)
  }

  getSoundEvents(): readonly RuntimeSoundEvent[] {
    return this.recentSoundEvents.map(event => ({ ...event }))
  }

  getEffectEvents(): readonly RuntimeEffectEvent[] {
    return this.recentEffectEvents.map(event => ({ ...event }))
  }

  getKeyEvents(): readonly RuntimeKeyEvent[] {
    return this.recentKeyEvents.map(event => ({ ...event, args: [...event.args] }))
  }

  getHtmlEvents(): readonly RuntimeHtmlEvent[] {
    return this.recentHtmlEvents.map(event => ({ ...event, args: [...event.args] }))
  }

  getBridgeEvents(): readonly RuntimeBridgeEvent[] {
    return this.recentBridgeEvents.map(event => ({ ...event }))
  }

  private publishControlVariables(): void {
    const gearPct = this.controlState.gearPosition * 100
    const flapsPct = this.controlState.flapsPosition * 100
    const flapsTargetPct = this.controlState.flapsTarget * 100
    const spoilersPct = this.controlState.spoilersPosition * 100
    const spoilersTargetPct = this.controlState.spoilersTarget * 100

    this.simulatorEngine.state.set(
      ControlStateKeys.gearHandleRatio(),
      this.controlState.gearTarget,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      ControlStateKeys.gearPositionRatio(),
      this.controlState.gearPosition,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      ControlStateKeys.flapsHandleRatio(),
      this.controlState.flapsTarget,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      ControlStateKeys.flapsPositionRatio(),
      this.controlState.flapsPosition,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      ControlStateKeys.spoilersHandleRatio(),
      this.controlState.spoilersTarget,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      ControlStateKeys.spoilersPositionRatio(),
      this.controlState.spoilersPosition,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      ControlStateKeys.aileronPositionRatio(),
      this.controlState.aileronPosition,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      ControlStateKeys.elevatorPositionRatio(),
      this.controlState.elevatorPosition,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      ControlStateKeys.rudderPositionRatio(),
      this.controlState.rudderPosition,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      ControlStateKeys.parkingBrakeEnabled(),
      this.controlState.parkingBrake > 0,
      { source: 'runtime', unit: 'boolean' }
    )
    this.values.set(normalizeRuntimeVariableKey('A:GEAR ANIMATION POSITION'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR ANIMATION POSITION:0'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR ANIMATION POSITION:1'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR ANIMATION POSITION:2'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR HANDLE POSITION'), this.controlState.gearTarget)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR CENTER POSITION'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR LEFT POSITION'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR RIGHT POSITION'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:FLAPS HANDLE PERCENT'), flapsTargetPct)
    this.values.set(normalizeRuntimeVariableKey('A:TRAILING EDGE FLAPS LEFT PERCENT'), flapsPct)
    this.values.set(normalizeRuntimeVariableKey('A:TRAILING EDGE FLAPS RIGHT PERCENT'), flapsPct)
    this.values.set(normalizeRuntimeVariableKey('A:LEADING EDGE FLAPS LEFT PERCENT'), flapsPct)
    this.values.set(normalizeRuntimeVariableKey('A:LEADING EDGE FLAPS RIGHT PERCENT'), flapsPct)
    this.values.set(normalizeRuntimeVariableKey('A:SPOILERS HANDLE POSITION'), spoilersTargetPct)
    this.values.set(normalizeRuntimeVariableKey('A:SPOILERS LEFT POSITION'), spoilersPct)
    this.values.set(normalizeRuntimeVariableKey('A:SPOILERS RIGHT POSITION'), spoilersPct)
    this.values.set(
      normalizeRuntimeVariableKey('A:SPOILERS ARMED'),
      this.simulatorEngine.state.readBoolean(ControlStateKeys.spoilersArmed()) ? 1 : 0
    )
    this.values.set(normalizeRuntimeVariableKey('A:AILERON POSITION'), this.controlState.aileronPosition)
    this.values.set(normalizeRuntimeVariableKey('A:ELEVATOR POSITION'), this.controlState.elevatorPosition)
    this.values.set(normalizeRuntimeVariableKey('A:RUDDER POSITION'), this.controlState.rudderPosition)
    this.values.set(normalizeRuntimeVariableKey('A:BRAKE PARKING POSITION'), this.controlState.parkingBrake)
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:GEAR ANIMATION POSITION'),
      gearPct,
      'percent'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:GEAR HANDLE POSITION'),
      this.controlState.gearTarget,
      'ratio'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:FLAPS HANDLE PERCENT'),
      flapsTargetPct,
      'percent'
    )
    this.simulatorEngine.state.set(
      SurfaceStateKeys.targetRatio('flaps'),
      this.controlState.flapsTarget,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      SurfaceStateKeys.positionRatio('flaps'),
      this.controlState.flapsPosition,
      { source: 'runtime', unit: 'ratio' }
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:TRAILING EDGE FLAPS LEFT PERCENT'),
      flapsPct,
      'percent'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:SPOILERS HANDLE POSITION'),
      spoilersTargetPct,
      'percent'
    )
    this.simulatorEngine.state.set(
      SurfaceStateKeys.targetRatio('spoilers'),
      this.controlState.spoilersTarget,
      { source: 'runtime', unit: 'ratio' }
    )
    this.simulatorEngine.state.set(
      SurfaceStateKeys.positionRatio('spoilers'),
      this.controlState.spoilersPosition,
      { source: 'runtime', unit: 'ratio' }
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:SPOILERS LEFT POSITION'),
      spoilersPct,
      'percent'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:AILERON POSITION'),
      this.controlState.aileronPosition,
      'ratio'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:ELEVATOR POSITION'),
      this.controlState.elevatorPosition,
      'ratio'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:RUDDER POSITION'),
      this.controlState.rudderPosition,
      'ratio'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:BRAKE PARKING POSITION'),
      this.controlState.parkingBrake,
      'Bool'
    )
  }

  private publishElectricalVariables(): void {
    const powered = this.hasElectricalPower() ? 1 : 0
    const busVoltage = powered > 0 ? 28 : 0

    this.simulatorEngine.state.set(
      ElectricalStateKeys.batteryEnabled(),
      this.electricalState.batterySwitch > 0,
      { source: 'runtime', unit: 'boolean' }
    )
    this.simulatorEngine.state.set(
      ElectricalStateKeys.externalPowerAvailable(),
      this.electricalState.externalPowerAvailable > 0,
      { source: 'runtime', unit: 'boolean' }
    )
    this.simulatorEngine.state.set(
      ElectricalStateKeys.externalPowerConnected(),
      this.electricalState.externalPowerSwitch > 0,
      { source: 'runtime', unit: 'boolean' }
    )
    this.simulatorEngine.state.set(
      ElectricalStateKeys.avionicsMasterEnabled(),
      this.electricalState.avionicsSwitch > 0,
      { source: 'runtime', unit: 'boolean' }
    )
    this.simulatorEngine.state.set(
      ElectricalStateKeys.consumerSwitchEnabled('avionics'),
      this.electricalState.avionicsSwitch > 0,
      { source: 'runtime', unit: 'boolean' }
    )
    this.simulatorEngine.state.set(
      ElectricalStateKeys.consumerSwitchEnabled('lights'),
      true,
      { source: 'runtime', unit: 'boolean' }
    )
    this.simulatorEngine.state.set(
      ElectricalStateKeys.busVoltage('main'),
      busVoltage,
      { source: 'runtime', unit: 'number' }
    )
    this.simulatorEngine.state.set(
      ElectricalStateKeys.busVoltage('avionics'),
      busVoltage,
      { source: 'runtime', unit: 'number' }
    )

    this.values.set(normalizeRuntimeVariableKey('A:ELECTRICAL MASTER BATTERY'), this.electricalState.batterySwitch)
    this.values.set(normalizeRuntimeVariableKey('A:MASTER BATTERY SWITCH'), this.electricalState.batterySwitch)
    this.values.set(normalizeRuntimeVariableKey('A:BATTERY SWITCH'), this.electricalState.batterySwitch)
    this.values.set(normalizeRuntimeVariableKey('A:EXTERNAL POWER AVAILABLE'), this.electricalState.externalPowerAvailable)
    this.values.set(normalizeRuntimeVariableKey('A:EXTERNAL POWER ON'), this.electricalState.externalPowerSwitch)
    this.values.set(normalizeRuntimeVariableKey('A:AVIONICS MASTER SWITCH'), this.electricalState.avionicsSwitch)
    this.values.set(normalizeRuntimeVariableKey('A:ELECTRICAL MAIN BUS VOLTAGE'), busVoltage)
    this.values.set(normalizeRuntimeVariableKey('A:ELECTRICAL AVIONICS BUS VOLTAGE'), busVoltage)
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:ELECTRICAL MASTER BATTERY'),
      this.electricalState.batterySwitch,
      'Bool'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:MASTER BATTERY SWITCH'),
      this.electricalState.batterySwitch,
      'Bool'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:BATTERY SWITCH'),
      this.electricalState.batterySwitch,
      'Bool'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:EXTERNAL POWER AVAILABLE'),
      this.electricalState.externalPowerAvailable,
      'Bool'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:EXTERNAL POWER ON'),
      this.electricalState.externalPowerSwitch,
      'Bool'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:AVIONICS MASTER SWITCH'),
      this.electricalState.avionicsSwitch,
      'Bool'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:ELECTRICAL MAIN BUS VOLTAGE'),
      powered > 0 ? 28 : 0,
      'number'
    )
    this.writeEngineCompatibilityVariable(
      normalizeRuntimeVariableKey('A:ELECTRICAL AVIONICS BUS VOLTAGE'),
      powered > 0 ? 28 : 0,
      'number'
    )
    this.publishGenericPanelPowerVariables(powered)
  }

  private publishPropulsionVariables(): void {
    let engineCycleTarget = 0

    for (let engineIndex = 1; engineIndex <= 4; engineIndex += 1) {
      const n1Percent =
        this.simulatorEngine.state.readNumber(
          PropulsionStateKeys.engineN1Percent(engineIndex),
          { fallback: 0 }
        ) ?? 0
      const rpm =
        this.simulatorEngine.state.readNumber(
          PropulsionStateKeys.engineRpm(engineIndex),
          { fallback: n1Percent * 100 }
        ) ??
        n1Percent * 100
      const combustion = this.simulatorEngine.state.readBoolean(
        PropulsionStateKeys.engineCombustion(engineIndex),
        { fallback: false }
      )
      const starter = this.simulatorEngine.state.readBoolean(
        PropulsionStateKeys.engineStarter(engineIndex),
        { fallback: false }
      )
      const combustionValue = combustion ? 1 : 0
      const starterValue = starter ? 1 : 0

      this.values.set(
        normalizeRuntimeVariableKey(`A:GENERAL ENG RPM:${engineIndex}`),
        rpm
      )
      this.values.set(
        normalizeRuntimeVariableKey(`A:TURB ENG N1:${engineIndex}`),
        n1Percent
      )
      this.values.set(
        normalizeRuntimeVariableKey(`A:TURB ENG CORRECTED N1:${engineIndex}`),
        n1Percent
      )
      this.values.set(
        normalizeRuntimeVariableKey(`A:TURB ENG N2:${engineIndex}`),
        n1Percent
      )
      this.values.set(
        normalizeRuntimeVariableKey(`A:GENERAL ENG COMBUSTION:${engineIndex}`),
        combustionValue
      )
      this.values.set(
        normalizeRuntimeVariableKey(`A:GENERAL ENG STARTER:${engineIndex}`),
        starterValue
      )

      if (engineIndex === 1) {
        this.values.set(normalizeRuntimeVariableKey('A:GENERAL ENG RPM'), rpm)
        this.values.set(normalizeRuntimeVariableKey('A:TURB ENG N1'), n1Percent)
        this.values.set(
          normalizeRuntimeVariableKey('A:TURB ENG CORRECTED N1'),
          n1Percent
        )
        this.values.set(normalizeRuntimeVariableKey('A:TURB ENG N2'), n1Percent)
        this.values.set(
          normalizeRuntimeVariableKey('A:GENERAL ENG COMBUSTION'),
          combustionValue
        )
        this.values.set(
          normalizeRuntimeVariableKey('A:GENERAL ENG STARTER'),
          starterValue
        )
      }

      engineCycleTarget = Math.max(engineCycleTarget, n1Percent)
    }

    this.engineCycleTarget = engineCycleTarget
  }

  private publishGenericPanelPowerVariables(powered: number): void {
    this.simulatorEngine.state.set(
      LightingStateKeys.channelEnabled('panel'),
      powered > 0,
      { source: 'runtime', unit: 'boolean' }
    )
    this.simulatorEngine.state.set(
      LightingStateKeys.power('panel'),
      powered > 0 ? 1 : 0,
      { source: 'runtime', unit: 'ratio' }
    )
    this.values.set(normalizeRuntimeVariableKey('A:CIRCUIT GENERAL PANEL ON'), powered)
    this.values.set(normalizeRuntimeVariableKey('A:CIRCUIT SWITCH ON:20'), powered)
    this.values.set(normalizeRuntimeVariableKey('A:LIGHT PANEL'), powered)

    for (const bus of [
      'L:A32NX_ELEC_AC_1_BUS_IS_POWERED',
      'L:A32NX_ELEC_AC_2_BUS_IS_POWERED',
      'L:A32NX_ELEC_AC_ESS_BUS_IS_POWERED',
      'L:A32NX_ELEC_AC_ESS_SHED_BUS_IS_POWERED',
      'L:A32NX_ELEC_AC_STAT_INV_BUS_IS_POWERED',
      'L:A32NX_ELEC_DC_1_BUS_IS_POWERED',
      'L:A32NX_ELEC_DC_2_BUS_IS_POWERED',
      'L:A32NX_ELEC_DC_ESS_BUS_IS_POWERED',
      'L:A32NX_ELEC_DC_ESS_SHED_BUS_IS_POWERED',
      'L:A32NX_ELEC_DC_BAT_BUS_IS_POWERED',
      'L:A32NX_ELEC_HOT_1_BUS_IS_POWERED',
      'L:A32NX_ELEC_HOT_2_BUS_IS_POWERED'
    ]) {
      this.values.set(normalizeRuntimeVariableKey(bus), powered)
    }
  }

  private seedColdAndDarkState(): void {
    this.values.set(normalizeRuntimeVariableKey('A:SIM ON GROUND'), 1)
    this.values.set(normalizeRuntimeVariableKey('A:LIGHT BEACON'), 0)
    this.values.set(normalizeRuntimeVariableKey('A:LIGHT PANEL'), 0)
    this.values.set(normalizeRuntimeVariableKey('A:LIGHT CABIN'), 0)
    this.values.set(normalizeRuntimeVariableKey('A:LIGHT GLARESHIELD'), 0)
    this.publishElectricalVariables()
  }

  private seedPreviewFlightState(flightState: ImportedFlightState | null): void {
    if (flightState == null) {
      return
    }

    for (const section of flightState.sections) {
      const normalizedSectionName = section.name.toLowerCase()
      if (normalizedSectionName === 'localvars.0') {
        for (const [key, rawValue] of section.values) {
          const parsedValue = parseFlightStateScalar(rawValue)
          if (parsedValue == null) {
            continue
          }

          this.values.set(normalizeRuntimeVariableKey(`L:${key}`), parsedValue)
        }
        continue
      }

      if (normalizedSectionName === 'simvars.0') {
        const simOnGroundValue = section.values.get('simonground')
        const parsedValue = simOnGroundValue == null ? null : parseFlightStateScalar(simOnGroundValue)
        if (parsedValue != null) {
          this.values.set(normalizeRuntimeVariableKey('A:SIM ON GROUND'), parsedValue)
        }
        continue
      }

      if (normalizedSectionName === 'systems.0') {
        this.seedSystemsFlightState(section)
        continue
      }

      if (normalizedSectionName.startsWith('engine parameters.')) {
        this.seedEngineFlightState(section)
        continue
      }

      if (normalizedSectionName === 'controls.0') {
        this.seedControlsFlightState(section)
        continue
      }

      if (normalizedSectionName === 'switches.0') {
        this.seedSwitchesFlightState(section)
        this.seedLightPotentiometerFlightState(section)
      }
    }
  }

  private seedSystemsFlightState(section: ImportedCfgSection): void {
    for (const [key, rawValue] of section.values) {
      const parsedValue = parseFlightStateScalar(rawValue)
      if (parsedValue == null) {
        continue
      }
      const normalizedKey = key.toLowerCase()
      if (normalizedKey === 'batteryswitch') {
        this.setBatterySwitch(parsedValue)
        continue
      }
      if (normalizedKey === 'externalpowerswitch') {
        this.setExternalPowerSwitch(parsedValue)
        continue
      }
      if (normalizedKey === 'avionicsswitch') {
        this.electricalState.avionicsSwitch = parsedValue > 0 ? 1 : 0
        continue
      }
      this.seedLightPotentiometerFlightStateEntry(key, parsedValue)
    }
  }

  private seedLightPotentiometerFlightState(section: ImportedCfgSection): void {
    for (const [key, rawValue] of section.values) {
      const parsedValue = parseFlightStateScalar(rawValue)
      if (parsedValue == null) {
        continue
      }

      this.seedLightPotentiometerFlightStateEntry(key, parsedValue)
    }
  }

  private writeEngineCompatibilityVariable(
    normalizedKey: string,
    value: number,
    unit: string | null | undefined,
    source: SimStateSource = 'runtime'
  ): void {
    if (!Number.isFinite(value)) {
      return
    }

    this.msfsCompatibilityBridge.writeSimVar(normalizedKey, value, unit, source)
  }

  private seedEngineLightPotentiometer(index: number, value: number): void {
    if (!Number.isFinite(value)) {
      return
    }

    const key = LightingStateKeys.potentiometer(index)
    this.simulatorEngine.state.define({
      key,
      unit: 'ratio',
      valueType: 'number',
    })
    this.simulatorEngine.state.set(key, value, {
      source: 'loaded',
      unit: 'ratio',
    })
  }

  private seedLightPotentiometerFlightStateEntry(key: string, value: number): void {
    const potentiometerMatch = /^potentiometer\.(\d+)$/iu.exec(key)
    if (potentiometerMatch != null) {
      this.values.set(normalizeRuntimeVariableKey(`A:LIGHT POTENTIOMETER:${potentiometerMatch[1]}`), value)
      this.seedEngineLightPotentiometer(Number(potentiometerMatch[1]), value)
    }
  }

  private seedEngineFlightState(section: ImportedCfgSection): void {
    const engineIndex = parseEngineFlightStateIndex(section.name)
    const engineSuffix = engineIndex == null ? '' : `:${engineIndex}`
    const rpmValue = section.values.get('pct engine rpm')
    const parsedRpm = rpmValue == null ? null : parseFlightStateScalar(rpmValue)
    if (parsedRpm != null) {
      const rpmPercent = toFlightStatePercent(parsedRpm)
      this.engineCycleTarget = Math.max(this.engineCycleTarget, rpmPercent)
      this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG RPM${engineSuffix}`), rpmPercent)
      this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG N1${engineSuffix}`), rpmPercent)
      this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG CORRECTED N1${engineSuffix}`), rpmPercent)
      this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG COMBUSTION${engineSuffix}`), rpmPercent > 0 ? 1 : 0)
    }

    const throttleValue = section.values.get('throttleleverpct')
    const parsedThrottle = throttleValue == null ? null : parseFlightStateScalar(throttleValue)
    if (parsedThrottle != null) {
      const throttlePercent = toFlightStatePercent(parsedThrottle)
      this.throttleLeverPosition = Math.max(this.throttleLeverPosition, throttlePercent)
      this.values.set(
        normalizeRuntimeVariableKey(`A:GENERAL ENG THROTTLE LEVER POSITION${engineSuffix}`),
        throttlePercent
      )
    }

    const generatorSwitchValue = section.values.get('generatorswitch')
    const parsedGeneratorSwitch =
      generatorSwitchValue == null ? null : parseFlightStateScalar(generatorSwitchValue)
    if (parsedGeneratorSwitch != null) {
      this.values.set(
        normalizeRuntimeVariableKey(`A:GENERAL ENG MASTER ALTERNATOR${engineSuffix}`),
        parsedGeneratorSwitch > 0 ? 1 : 0
      )
    }
  }

  private seedControlsFlightState(section: ImportedCfgSection): void {
    const gearHandle = parseFlightStateScalar(section.values.get('gearshandle') ?? '')
    if (gearHandle != null) {
      this.controlState.gearTarget = clamp01(toPercentOver100(gearHandle, 'percent'))
      this.controlState.gearPosition = this.controlState.gearTarget
    }
    const flapsHandle = parseFlightStateScalar(section.values.get('flapshandle') ?? '')
    if (flapsHandle != null) {
      this.controlState.flapsTarget = clamp01(toPercentOver100(flapsHandle, 'percent'))
      this.controlState.flapsPosition = this.controlState.flapsTarget
    }
    const spoilersHandle = parseFlightStateScalar(section.values.get('spoilershandle') ?? '')
    if (spoilersHandle != null) {
      this.controlState.spoilersTarget = clamp01(toPercentOver100(spoilersHandle, 'percent'))
      this.controlState.spoilersPosition = this.controlState.spoilersTarget
    }
  }

  private seedSwitchesFlightState(section: ImportedCfgSection): void {
    const lightMappings: ReadonlyArray<readonly [string, string]> = [
      ['BeaconLights', 'A:LIGHT BEACON'],
      ['LandingLights', 'A:LIGHT LANDING'],
      ['LogoLights', 'A:LIGHT LOGO'],
      ['NavLights', 'A:LIGHT NAV'],
      ['PanelLights', 'A:LIGHT PANEL'],
      ['RecognitionLights', 'A:LIGHT RECOGNITION'],
      ['StrobeLights', 'A:LIGHT STROBE'],
      ['TaxiLights', 'A:LIGHT TAXI'],
      ['WingLights', 'A:LIGHT WING'],
      ['CabinLights', 'A:LIGHT CABIN'],
      ['GlareshieldLights', 'A:LIGHT GLARESHIELD']
    ]
    for (const [flightStateKey, simVarKey] of lightMappings) {
      const rawValue = section.values.get(flightStateKey.toLowerCase())
      const parsedValue = rawValue == null ? null : parseFlightStateScalar(rawValue)
      if (parsedValue != null) {
        const normalizedSimVarKey = normalizeRuntimeVariableKey(simVarKey)
        const switchValue = parsedValue > 0 ? 1 : 0
        this.values.set(normalizedSimVarKey, switchValue)
        this.writeEngineCompatibilityVariable(
          normalizedSimVarKey,
          switchValue,
          null,
          'loaded'
        )
      }
    }
  }

  private setBatterySwitch(value: number): void {
    const switchValue = value > 0 ? 1 : 0
    this.electricalState.batterySwitch = switchValue
    this.values.set(normalizeRuntimeVariableKey('A:ELECTRICAL MASTER BATTERY'), switchValue)
    this.values.set(normalizeRuntimeVariableKey('A:MASTER BATTERY SWITCH'), switchValue)
    this.values.set(normalizeRuntimeVariableKey('A:BATTERY SWITCH'), switchValue)
    this.simulatorEngine.dispatch({
      type: ElectricalCommandTypes.setBattery,
      payload: { enabled: switchValue > 0 },
      source: 'msfs-key-event',
    })
  }

  private setExternalPowerSwitch(value: number): void {
    const switchValue = value > 0 ? 1 : 0
    this.electricalState.externalPowerSwitch = switchValue
    this.values.set(normalizeRuntimeVariableKey('A:EXTERNAL POWER ON'), switchValue)
    this.simulatorEngine.dispatch({
      type: ElectricalCommandTypes.setExternalPowerConnected,
      payload: { enabled: switchValue > 0 },
      source: 'msfs-key-event',
    })
    this.simulatorEngine.dispatch({
      type: ElectricalCommandTypes.setSourceConnected,
      payload: { id: 'external', connected: switchValue > 0 },
      source: 'msfs-key-event',
    })
  }

  private setSpoilersArmed(value: number): void {
    const switchValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey('A:SPOILERS ARMED'), switchValue)
    this.msfsCompatibilityBridge.writeLocalVar(
      'L:A32NX_SPOILERS_ARMED',
      switchValue,
      'runtime'
    )
    this.simulatorEngine.dispatch({
      type: ControlCommandTypes.setSpoilersArmed,
      payload: { enabled: switchValue > 0 },
      source: 'msfs-key-event',
    })
  }

  private applyElectricalVariableSideEffects(key: string, value: number, unit: string | null): void {
    const normalizedValue = Number.isFinite(value) && value > 0 ? 1 : 0
    if (isBatteryControlKey(key)) {
      this.electricalState.batterySwitch = this.hasStoredBatteryControlPower() ? 1 : normalizedValue
      this.simulatorEngine.dispatch({
        type: ElectricalCommandTypes.setBattery,
        payload: { enabled: this.electricalState.batterySwitch > 0 },
        source: 'msfs-variable-write',
      })
      return
    }
    if (isExternalPowerControlKey(key)) {
      this.electricalState.externalPowerSwitch = this.hasStoredExternalPower() ? 1 : normalizedValue
      this.simulatorEngine.dispatch({
        type: ElectricalCommandTypes.setExternalPowerConnected,
        payload: { enabled: this.electricalState.externalPowerSwitch > 0 },
        source: 'msfs-variable-write',
      })
      this.simulatorEngine.dispatch({
        type: ElectricalCommandTypes.setSourceConnected,
        payload: {
          id: 'external',
          connected: this.electricalState.externalPowerSwitch > 0,
        },
        source: 'msfs-variable-write',
      })
      return
    }
    if (isExternalPowerAvailableKey(key)) {
      this.electricalState.externalPowerAvailable = normalizedValue
      this.simulatorEngine.dispatch({
        type: ElectricalCommandTypes.setExternalPowerAvailable,
        payload: { enabled: normalizedValue > 0 },
        source: 'msfs-variable-write',
      })
      this.simulatorEngine.dispatch({
        type: ElectricalCommandTypes.setSourceAvailable,
        payload: { id: 'external', available: normalizedValue > 0 },
        source: 'msfs-variable-write',
      })
      return
    }
    if (key === 'A:AVIONICS MASTER SWITCH') {
      this.electricalState.avionicsSwitch = normalizedValue
      this.simulatorEngine.dispatch({
        type: ElectricalCommandTypes.setAvionicsMaster,
        payload: { enabled: normalizedValue > 0 },
        source: 'msfs-variable-write',
      })
      this.simulatorEngine.dispatch({
        type: ElectricalCommandTypes.setConsumerSwitch,
        payload: { id: 'avionics', enabled: normalizedValue > 0 },
        source: 'msfs-variable-write',
      })
      return
    }
    if (isAvionicsControlKey(key)) {
      this.electricalState.avionicsSwitch = normalizedValue
      this.simulatorEngine.dispatch({
        type: ElectricalCommandTypes.setConsumerSwitch,
        payload: { id: 'avionics', enabled: normalizedValue > 0 },
        source: 'msfs-variable-write',
      })
      return
    }
    if (key.includes('THROTTLE LEVER POSITION')) {
      this.throttleLeverPosition = toPercentOver100(value, unit) * 100
      return
    }
    if (key.includes('GENERAL ENG RPM') || key.includes('TURB ENG N1')) {
      this.engineCycleTarget = Math.max(0, toFlightStatePercent(value))
    }
  }

  private hasElectricalPower(): boolean {
    if (
      this.simulatorEngine.state.readBoolean(ElectricalStateKeys.busPowered('main'), {
        fallback: false,
      }) ||
      this.simulatorEngine.state.readBoolean(ElectricalStateKeys.consumerPowered('avionics'), {
        fallback: false,
      }) ||
      this.simulatorEngine.state.readBoolean(ElectricalStateKeys.consumerPowered('lights'), {
        fallback: false,
      })
    ) {
      return true
    }

    return (
      this.electricalState.batterySwitch > 0 ||
      this.electricalState.externalPowerSwitch > 0 ||
      this.hasStoredBatteryControlPower() ||
      this.hasStoredExternalPower() ||
      (this.engineCycleTarget > 0 && this.hasStoredGeneratorPower())
    )
  }

  private hasStoredBatteryControlPower(): boolean {
    for (const [key, value] of this.values) {
      if (value > 0 && isBatteryControlKey(key)) {
        return true
      }
    }
    return false
  }

  private hasStoredExternalPower(): boolean {
    for (const [key, value] of this.values) {
      if (value > 0 && isExternalPowerControlKey(key)) {
        return true
      }
    }
    return false
  }

  private hasStoredGeneratorPower(): boolean {
    for (const [key, value] of this.values) {
      if (value > 0 && isGeneratorControlKey(key)) {
        return true
      }
    }
    return false
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
    const upperKey = key

    if (upperKey === 'A:ANIMATION DELTA TIME') return handled(convertTimeUnit(cycles.dtSeconds, unit))
    if (upperKey === 'E:SIMULATION TIME' || upperKey === 'A:E:SIMULATION TIME') {
      return handled(convertTimeUnit(this.elapsedSeconds, unit))
    }
    if (upperKey === 'E:ABSOLUTE TIME' || upperKey === 'A:E:ABSOLUTE TIME') {
      return handled(Date.now() / 1000 + 62135596800)
    }
    if (upperKey === 'A:SIM ON GROUND') return handled(1)
    if (upperKey === 'A:SURFACE RELATIVE GROUND SPEED') return handled(0)
    if (upperKey === 'A:STRUCTURAL ICE PCT') return handled(convertPercentOver100Unit(0, unit))
    if (upperKey === 'A:PITOT ICE PCT') return handled(convertPercentOver100Unit(0, unit))
    if (upperKey === 'A:WINDSHIELD DEICE SWITCH') return handled(0)
    if (upperKey === 'A:STRUCTURAL DEICE SWITCH') return handled(0)
    if (upperKey === 'A:LIGHT BEACON') return handled(0)
    if (isExternalPowerAvailableKey(upperKey)) {
      return handled(this.electricalState.externalPowerAvailable)
    }
    if (upperKey.startsWith('A:GENERAL ENG RPM:')) {
      return handled(convertRpmUnit(cycles.engineCycle, unit))
    }
    if (
      upperKey.startsWith('A:TURB ENG N1:') ||
      upperKey.startsWith('A:TURB ENG CORRECTED N1:')
    ) {
      return handled(convertPercentUnit(cycles.engineCycle, unit))
    }
    if (upperKey.includes('BRIGHTNESS') || upperKey.includes('POTENTIOMETER')) {
      return handled(resolveBrightnessOrPotentiometerFallback(
        upperKey,
        unit,
        this.hasElectricalPower()
      ))
    }
    if (isRuntimeStoredVariableKey(upperKey)) {
      const storedValue = this.values.get(upperKey)
      if (storedValue != null) {
        return handled(storedValue)
      }
      const genericStoredValue = resolveGenericStoredVariableFallback(
        upperKey,
        unit,
        this.hasElectricalPower()
      )
      if (genericStoredValue != null) {
        return handled(genericStoredValue)
      }
    }
    if (isCircuitConnectionStateKey(upperKey)) return handled(1)
    if (isCircuitPowerStateKey(upperKey)) return handled(this.hasElectricalPower() ? 1 : 0)
    if (upperKey.startsWith('A:CIRCUIT POWER SETTING:')) {
      return handled(convertPercentUnit(this.hasElectricalPower() ? 100 : 0, unit))
    }
    if (isLightPercentVariableKey(upperKey)) {
      return handled(convertPercentUnit(this.hasElectricalPower() ? 100 : 0, unit))
    }
    if (isPoweredBusConnectionKey(upperKey)) return handled(1)
    if (isElectricalVoltageKey(upperKey)) return handled(this.hasElectricalPower() ? 28 : 0)
    if (isElectricalPowerKey(upperKey)) return handled(this.hasElectricalPower() ? 1 : 0)
    if (upperKey.startsWith('A:INTERACTIVE POINT OPEN:')) return handled(convertPercentUnit(0, unit))
    if (upperKey.startsWith('A:ENG ANTI ICE:')) return handled(0)
    if (isEngineAntiIcePositionKey(upperKey)) return handled(convertPercentToEngineAntiIcePositionUnit(0, unit))
    if (upperKey.startsWith('A:PROP DEICE SWITCH:')) return handled(0)
    if (upperKey.startsWith('A:RECIP ENG PRIMER:')) return handled(convertPercentToPrimerUnit(0, unit))
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
    const dynamicControlValue = this.resolveDynamicControlFallbackValue(upperKey, unit)
    if (dynamicControlValue != null) {
      return handled(dynamicControlValue)
    }
    if (upperKey.startsWith('A:GEAR STEER ANGLE:')) return handled(0)
    if (upperKey.startsWith('A:GENERAL ENG RPM:')) {
      return handled(convertRpmUnit(cycles.engineCycle, unit))
    }
    if (upperKey.startsWith('A:PROP RPM:')) {
      return handled(convertRpmUnit(cycles.engineCycle, unit))
    }
    if (upperKey.startsWith('A:GENERAL ENG THROTTLE LEVER POSITION:')) {
      return handled(convertPercentUnit(this.throttleLeverPosition, unit))
    }
    if (isEngineControlPercentPositionKey(upperKey)) {
      return handled(convertPercentToPosition16kUnit(0, unit))
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
    if (upperKey.includes('SPOILER') && upperKey.includes('ARMED')) {
      return handled(
        this.simulatorEngine.state.readBoolean(ControlStateKeys.spoilersArmed()) ? 1 : 0
      )
    }
    if (upperKey.includes('SPOILER_LEFT')) return handled(convertPercentUnit(cycles.spoilerCycle * 100, unit))
    if (upperKey.includes('SPOILER_RIGHT')) return handled(convertPercentUnit(cycles.spoilerCycle * 100, unit))
    if (upperKey.includes('SPOILER')) return handled(convertPercentUnit(cycles.spoilerCycle * 100, unit))
    if (upperKey.includes('SLAT')) return handled(toRequestedControlUnit(cycles.flapCycle, unit))
    if (upperKey.includes('FLAP')) return handled(toRequestedControlUnit(cycles.flapCycle, unit))
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
      value: this.values.get(upperKey) ?? 0
    }
  }

  private applyVariableSideEffects(key: string, value: number, unit: string | null): void {
    const normalizedValue = Number.isFinite(value) ? value : 0
    if (/^[BHK]:/u.test(key) && this.applyGenericControlEventName(key.slice(2), normalizedValue)) {
      return
    }
    if (!key.startsWith('A:')) {
      return
    }
    const controlKey = key.replace(/:\d+$/u, '')
    const ratio = controlEventPositionToRatio(normalizedValue)
    switch (controlKey) {
      case 'A:GEAR HANDLE POSITION':
      case 'A:GEAR HANDLE':
        this.controlState.gearTarget = ratio
        return
      case 'A:GEAR ANIMATION POSITION':
      case 'A:GEAR CENTER POSITION':
      case 'A:GEAR LEFT POSITION':
      case 'A:GEAR RIGHT POSITION':
        this.controlState.gearPosition = ratio
        return
      case 'A:FLAPS HANDLE PERCENT':
        this.controlState.flapsTarget = ratio
        return
      case 'A:TRAILING EDGE FLAPS LEFT PERCENT':
      case 'A:TRAILING EDGE FLAPS RIGHT PERCENT':
      case 'A:LEADING EDGE FLAPS LEFT PERCENT':
      case 'A:LEADING EDGE FLAPS RIGHT PERCENT':
        this.controlState.flapsPosition = ratio
        return
      case 'A:SPOILERS HANDLE POSITION':
        this.controlState.spoilersTarget = ratio
        return
      case 'A:SPOILERS LEFT POSITION':
      case 'A:SPOILERS RIGHT POSITION':
        this.controlState.spoilersPosition = ratio
        return
      case 'A:AILERON POSITION':
        this.controlState.aileronTarget = clamp(normalizedValue, -1, 1)
        return
      case 'A:ELEVATOR POSITION':
        this.controlState.elevatorTarget = clamp(normalizedValue, -1, 1)
        return
      case 'A:RUDDER POSITION':
        this.controlState.rudderTarget = clamp(normalizedValue, -1, 1)
        return
      case 'A:BRAKE PARKING POSITION':
        this.controlState.parkingBrake = normalizedValue > 0 ? 1 : 0
    }
  }

  private resolveDynamicControlFallbackValue(key: string, unit: string | null): number | null {
    if (key.includes('GEAR') && key.includes('HANDLE') && key.includes('POSITION')) {
      return this.controlState.gearTarget
    }
    if (key.includes('GEAR') && key.includes('POSITION')) {
      return convertPercentUnit(this.controlState.gearPosition * 100, unit)
    }
    if ((key.includes('FLAP') || key.includes('SLAT')) && key.includes('INDEX')) {
      const ratio = key.includes('HANDLE')
        ? this.controlState.flapsTarget
        : this.controlState.flapsPosition
      return Math.round(ratio * 4)
    }
    if ((key.includes('FLAP') || key.includes('SLAT')) && key.includes('POSITION')) {
      const ratio = key.includes('HANDLE')
        ? this.controlState.flapsTarget
        : this.controlState.flapsPosition
      return toRequestedControlUnit(ratio, unit)
    }
    if ((key.includes('FLAP') || key.includes('SLAT')) && key.includes('PERCENT')) {
      const ratio = key.includes('HANDLE')
        ? this.controlState.flapsTarget
        : this.controlState.flapsPosition
      return toRequestedControlUnit(ratio, unit)
    }
    if (key.includes('SPOILER') && (key.includes('POSITION') || key.includes('DEFLECTION'))) {
      return convertPercentUnit(this.controlState.spoilersPosition * 100, unit)
    }
    if (key.includes('PARKING') || key.includes('PARK_BRAKE')) {
      if (key.includes('POSITION') || key.includes('LEVER') || key.endsWith('_POS')) {
        return this.controlState.parkingBrake
      }
    }
    return null
  }

  private applyKeyEvent(name: string, args: readonly number[]): void {
    const value = Number(args.at(-1) ?? 0)
    if (this.applyLightKeyEvent(name, args)) {
      return
    }
    if (this.applyFuelSystemKeyEvent(name, args)) {
      return
    }
    if (this.applyElectricalInputKeyEvent(name, args)) {
      return
    }
    if (this.applyProcedureKeyEvent(name)) {
      return
    }
    if (name.endsWith('ELECTRICAL_BUS_TO_CIRCUIT_CONNECTION_TOGGLE')) {
      const circuitIndex = Math.trunc(Number(args[0] ?? Number.NaN))
      if (Number.isFinite(circuitIndex)) {
        const circuitKey = normalizeRuntimeVariableKey(`A:CIRCUIT CONNECTION ON:${circuitIndex}`)
        const currentValue = this.values.get(circuitKey) ?? 1
        this.values.set(circuitKey, currentValue > 0 ? 0 : 1)
      }
      return
    }
    if (name === 'ELECTRICAL_CIRCUIT_TOGGLE') {
      const circuitIndex = Math.trunc(Number(args[0] ?? Number.NaN))
      if (Number.isFinite(circuitIndex)) {
        this.toggleCircuitSwitch(circuitIndex)
      }
      return
    }
    if (name === 'ELECTRICAL_CIRCUIT_POWER_SETTING_SET') {
      const powerSetting = Number(args[0] ?? Number.NaN)
      const circuitIndex = Math.trunc(Number(args[1] ?? Number.NaN))
      if (Number.isFinite(powerSetting) && Number.isFinite(circuitIndex)) {
        this.values.set(normalizeRuntimeVariableKey(`A:CIRCUIT POWER SETTING:${circuitIndex}`), powerSetting)
        this.values.set(normalizeRuntimeVariableKey(`A:CIRCUIT SWITCH ON:${circuitIndex}`), powerSetting > 0 ? 1 : 0)
        this.values.set(normalizeRuntimeVariableKey(`A:CIRCUIT ON:${circuitIndex}`), powerSetting > 0 ? 1 : 0)
      }
      return
    }
    if (name.endsWith('ELECTRICAL_BUS_TO_BUS_CONNECTION_TOGGLE')) {
      const sourceBusIndex = Math.trunc(Number(args[0] ?? Number.NaN))
      const targetBusIndex = Math.trunc(Number(args[1] ?? Number.NaN))
      if (Number.isFinite(sourceBusIndex) && Number.isFinite(targetBusIndex)) {
        this.toggleBusConnection(sourceBusIndex, targetBusIndex)
      }
      return
    }
    if (this.applyApuKeyEvent(name, args)) {
      return
    }
    if (this.applyCabinKeyEvent(name)) {
      return
    }
    if (this.applyPressurizationKeyEvent(name, args)) {
      return
    }
    if (this.applySafetyKeyEvent(name)) {
      return
    }
    if (this.applyRadioKeyEvent(name, args)) {
      return
    }
    if (this.applyPitotHeatKeyEvent(name, args)) {
      return
    }
    if (this.applyNavComKeyEvent(name, args)) {
      return
    }
    if (this.applyRadioAudioKeyEvent(name, args)) {
      return
    }
    if (this.applyInstrumentKeyEvent(name, args)) {
      return
    }
    if (this.applyTrimAndBrakeKeyEvent(name, args)) {
      return
    }
    if (this.applyHandlingAndGearKeyEvent(name, args)) {
      return
    }
    if (this.applyDeiceAndIgnitionKeyEvent(name, args)) {
      return
    }
    if (this.applyEngineControlKeyEvent(name, args)) {
      return
    }
    if (this.applyEngineSwitchKeyEvent(name, args)) {
      return
    }
    if (this.applyAutopilotAndTransponderKeyEvent(name, args)) {
      return
    }
    const alternatorToggleMatch = /^TOGGLE_ALTERNATOR(\d+)$/u.exec(name)
    if (alternatorToggleMatch != null) {
      const alternatorKey = normalizeRuntimeVariableKey(`A:GENERAL ENG MASTER ALTERNATOR:${alternatorToggleMatch[1]}`)
      const currentValue = this.values.get(alternatorKey) ?? 0
      this.values.set(alternatorKey, currentValue > 0 ? 0 : 1)
      return
    }
    if (name === 'TOGGLE_ALTERNATOR') {
      const alternatorKey = normalizeRuntimeVariableKey('A:GENERAL ENG MASTER ALTERNATOR:1')
      const currentValue = this.values.get(alternatorKey) ?? 0
      this.values.set(alternatorKey, currentValue > 0 ? 0 : 1)
      return
    }
    if (name === 'TOGGLE_MASTER_BATTERY' || name === 'MASTER_BATTERY_TOGGLE') {
      this.setBatterySwitch(this.electricalState.batterySwitch > 0 ? 0 : 1)
      return
    }
    if (name === 'MASTER_BATTERY_ON') {
      this.setBatterySwitch(1)
      return
    }
    if (name === 'MASTER_BATTERY_OFF') {
      this.setBatterySwitch(0)
      return
    }
    if (name === 'EXTERNAL_POWER_TOGGLE') {
      this.setExternalPowerSwitch(this.electricalState.externalPowerSwitch > 0 ? 0 : 1)
      return
    }
    if (name === 'EXTERNAL_POWER_ON') {
      this.setExternalPowerSwitch(1)
      return
    }
    if (name === 'EXTERNAL_POWER_OFF') {
      this.setExternalPowerSwitch(0)
      return
    }
    if (name === 'AVIONICS_MASTER_SET') {
      this.electricalState.avionicsSwitch = value > 0 ? 1 : 0
      return
    }
    if (name === 'AVIONICS_MASTER_TOGGLE') {
      this.electricalState.avionicsSwitch = this.electricalState.avionicsSwitch > 0 ? 0 : 1
      return
    }
    if (name === 'GEAR_UP') {
      this.controlState.gearTarget = 0
      return
    }
    if (name === 'GEAR_DOWN') {
      this.controlState.gearTarget = 1
      return
    }
    if (name === 'GEAR_TOGGLE') {
      this.controlState.gearTarget = this.controlState.gearTarget > 0.5 ? 0 : 1
      return
    }
    if (name === 'GEAR_SET') {
      this.controlState.gearTarget = value > 0 ? 1 : 0
      return
    }
    if (name === 'FLAPS_INCR') {
      this.controlState.flapsTarget = clamp01(this.controlState.flapsTarget + 0.25)
      return
    }
    if (name === 'FLAPS_DECR') {
      this.controlState.flapsTarget = clamp01(this.controlState.flapsTarget - 0.25)
      return
    }
    if (name === 'FLAPS_SET') {
      this.controlState.flapsTarget = clamp01(value / 16_383)
      return
    }
    if (name === 'AXIS_FLAPS_SET') {
      this.controlState.flapsTarget = clamp01(Math.abs(value) / 16_383)
      return
    }
    if (name === 'SPOILERS_SET' || name === 'AXIS_SPOILER_SET') {
      this.controlState.spoilersTarget = clamp01(Math.abs(value) / 16_383)
      return
    }
    if (name === 'SPOILERS_ARM_SET') {
      this.setSpoilersArmed(value)
      return
    }
    if (name === 'PARKING_BRAKES' || name === 'PARKING_BRAKE_TOGGLE') {
      this.controlState.parkingBrake = this.controlState.parkingBrake > 0.5 ? 0 : 1
      return
    }
    if (name === 'PARKING_BRAKE_SET') {
      this.controlState.parkingBrake = value > 0 ? 1 : 0
      return
    }
    this.applyGenericControlEventName(name, value)
  }

  private resolveIndexedTurbineIgnitionSwitch(): number | null {
    const values = [1, 2, 3, 4]
      .map(index => this.values.get(normalizeRuntimeVariableKey(`A:TURBINE IGNITION SWITCH:${index}`)))
      .filter((value): value is number => value != null)
    if (values.length === 0) {
      return null
    }
    return Math.max(...values)
  }

  private applyLightKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'ALL_LIGHTS_TOGGLE') {
      this.toggleAllLights()
      return true
    }

    const indexedPotentiometerSet = /^LIGHT_POTENTIOMETER_(\d+)_SET$/u.exec(name)
    if (indexedPotentiometerSet != null) {
      this.setLightPotentiometer(Number(indexedPotentiometerSet[1]), Number(args[0] ?? 0))
      return true
    }

    if (name === 'LIGHT_POTENTIOMETER_SET') {
      this.setLightPotentiometer(Number(args[1] ?? Number.NaN), Number(args[0] ?? 0))
      return true
    }

    if (name === 'LIGHT_POTENTIOMETER_INC' || name === 'LIGHT_POTENTIOMETER_DEC') {
      const index = Number(args.at(-1) ?? Number.NaN)
      const direction = name.endsWith('_INC') ? 1 : -1
      this.stepLightPotentiometer(index, direction * 5)
      return true
    }

    const lightPowerSettingMatch = /^(.+)_LIGHTS_POWER_SETTING_SET$/u.exec(name)
    if (lightPowerSettingMatch != null) {
      this.setLightPowerSetting(
        lightPowerSettingMatch[1],
        Number(args[1] ?? Number.NaN),
        Number(args[0] ?? 0)
      )
      return true
    }

    const lightSetMatch = /^(.+)_LIGHTS_SET$/u.exec(name)
    if (lightSetMatch != null) {
      const { index, value } = getFlexibleIndexedSetEventArgs(args, 1)
      this.setLightSwitch(lightSetMatch[1], value > 0 ? 1 : 0, index)
      return true
    }

    const lightOnOffMatch = /^(.+)_LIGHTS_(ON|OFF)$/u.exec(name)
    if (lightOnOffMatch != null) {
      this.setLightSwitch(lightOnOffMatch[1], lightOnOffMatch[2] === 'ON' ? 1 : 0)
      return true
    }

    const directLightOnOffMatch = /^(STROBES|BEACON|NAV|LOGO|LANDING|TAXI|WING|CABIN|PANEL)_(ON|OFF)$/u.exec(name)
    if (directLightOnOffMatch != null) {
      this.setLightSwitch(directLightOnOffMatch[1], directLightOnOffMatch[2] === 'ON' ? 1 : 0)
      return true
    }

    const directLightSetMatch = /^(STROBES|BEACON|NAV|LOGO|LANDING|TAXI|WING|CABIN|PANEL|RECOGNITION)_SET$/u.exec(name)
    if (directLightSetMatch != null) {
      this.setLightSwitch(directLightSetMatch[1], Number(args.at(-1) ?? 0) > 0 ? 1 : 0)
      return true
    }

    const lightToggleMatch = /^(.+)_LIGHTS_TOGGLE$/u.exec(name)
    if (lightToggleMatch != null) {
      this.toggleLightSwitch(lightToggleMatch[1], Number(args[0] ?? Number.NaN))
      return true
    }

    const prefixedLightToggleMatch = /^TOGGLE_(.+)_LIGHTS$/u.exec(name)
    if (prefixedLightToggleMatch != null) {
      this.toggleLightSwitch(prefixedLightToggleMatch[1], Number(args[0] ?? Number.NaN))
      return true
    }

    const directLightToggleMatch = /^(STROBES|BEACON|NAV|LOGO|LANDING|TAXI|WING|CABIN|PANEL|RECOGNITION)_TOGGLE$/u.exec(name)
    if (directLightToggleMatch != null) {
      this.toggleLightSwitch(directLightToggleMatch[1], Number(args[0] ?? Number.NaN))
      return true
    }

    return false
  }

  private applyApuKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'APU_BLEED_AIR_SOURCE_SET') {
      const value = Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      this.values.set(normalizeRuntimeVariableKey('A:BLEED AIR APU'), value)
      this.values.set(normalizeRuntimeVariableKey('L:A32NX_OVHD_PNEU_APU_BLEED_PB_IS_ON'), value)
      return true
    }
    if (name === 'APU_BLEED_AIR_SOURCE_TOGGLE') {
      const key = normalizeRuntimeVariableKey('A:BLEED AIR APU')
      const value = (this.values.get(key) ?? 0) > 0 ? 0 : 1
      this.values.set(key, value)
      this.values.set(normalizeRuntimeVariableKey('L:A32NX_OVHD_PNEU_APU_BLEED_PB_IS_ON'), value)
      return true
    }
    if (name === 'APU_STARTER') {
      this.values.set(normalizeRuntimeVariableKey('A:APU SWITCH'), 1)
      this.values.set(normalizeRuntimeVariableKey('A:APU PCT RPM'), 100)
      this.values.set(normalizeRuntimeVariableKey('A:APU GENERATOR ACTIVE:1'), 1)
      this.msfsCompatibilityBridge.writeSimVar('A:APU SWITCH', 1, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar('A:APU STARTER', 1, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar('A:APU ACTIVE:1', 1, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar('A:APU PCT RPM', 100, 'percent')
      this.values.set(normalizeRuntimeVariableKey('L:A32NX_OVHD_APU_START_PB_IS_ON'), 1)
      this.values.set(normalizeRuntimeVariableKey('L:A32NX_OVHD_APU_START_PB_IS_AVAILABLE'), 1)
      return true
    }
    if (name === 'APU_OFF_SWITCH') {
      this.values.set(normalizeRuntimeVariableKey('A:APU SWITCH'), 0)
      this.values.set(normalizeRuntimeVariableKey('A:APU PCT RPM'), 0)
      this.values.set(normalizeRuntimeVariableKey('A:APU GENERATOR ACTIVE:1'), 0)
      this.values.set(normalizeRuntimeVariableKey('A:APU GENERATOR SWITCH:1'), 0)
      this.msfsCompatibilityBridge.writeSimVar('A:APU SWITCH', 0, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar('A:APU STARTER', 0, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar('A:APU ACTIVE:1', 0, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar('A:APU PCT RPM', 0, 'percent')
      this.values.set(normalizeRuntimeVariableKey('L:A32NX_OVHD_APU_START_PB_IS_ON'), 0)
      this.values.set(normalizeRuntimeVariableKey('L:A32NX_OVHD_APU_START_PB_IS_AVAILABLE'), 0)
      return true
    }
    return false
  }

  private applyCabinKeyEvent(name: string): boolean {
    if (name === 'CABIN_SEATBELTS_ALERT_SWITCH_TOGGLE') {
      this.toggleNamedBoolVariables('A:CABIN SEATBELTS ALERT SWITCH', 'A:CABIN SEATBELTS ALERT SWITCH:1')
      return true
    }
    if (name === 'CABIN_NO_SMOKING_ALERT_SWITCH_TOGGLE') {
      this.toggleNamedBoolVariables('A:CABIN NO SMOKING ALERT SWITCH', 'A:CABIN NO SMOKING ALERT SWITCH:1')
      return true
    }
    return false
  }

  private applyPressurizationKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'BLEED_AIR_SOURCE_CONTROL_SET') {
      const value = Math.trunc(Number(args.at(-1) ?? 0))
      this.values.set(normalizeRuntimeVariableKey('A:BLEED AIR SOURCE CONTROL'), value)
      return true
    }

    if (name === 'ENGINE_BLEED_AIR_SOURCE_SET') {
      const value = Number(args[0] ?? 0) > 0 ? 1 : 0
      const engineIndex = Math.trunc(Number(args[1] ?? 1))
      if (Number.isFinite(engineIndex) && engineIndex > 0) {
        this.values.set(normalizeRuntimeVariableKey(`A:BLEED AIR ENGINE:${engineIndex}`), value)
        return true
      }
    }

    if (name === 'PRESSURIZATION_PRESSURE_DUMP_SWITCH') {
      const key = normalizeRuntimeVariableKey('A:PRESSURIZATION DUMP SWITCH')
      const explicitValue = Number(args.at(-1) ?? Number.NaN)
      const nextValue = Number.isFinite(explicitValue)
        ? explicitValue > 0 ? 1 : 0
        : (this.values.get(key) ?? 0) > 0 ? 0 : 1
      this.values.set(key, nextValue)
      return true
    }

    if (name === 'PRESSURIZATION_PRESSURE_ALT_INC' || name === 'PRESSURIZATION_PRESSURE_ALT_DEC') {
      const key = normalizeRuntimeVariableKey('A:PRESSURIZATION CABIN ALTITUDE GOAL')
      const currentValue = this.values.get(key) ?? 0
      const rawStep = Math.abs(Number(args.at(-1) ?? Number.NaN))
      const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 500
      const direction = name.endsWith('_INC') ? 1 : -1
      this.values.set(key, clamp(currentValue + direction * step, 0, 50_000))
      return true
    }

    return false
  }

  private applySafetyKeyEvent(name: string): boolean {
    if (name === 'MASTER_WARNING_ACKNOWLEDGE') {
      this.values.set(normalizeRuntimeVariableKey('A:MASTER WARNING ACKNOWLEDGED'), 1)
      this.values.set(normalizeRuntimeVariableKey('A:MASTER WARNING ACTIVE'), 0)
      return true
    }

    if (name === 'MASTER_CAUTION_ACKNOWLEDGE') {
      this.values.set(normalizeRuntimeVariableKey('A:MASTER CAUTION ACKNOWLEDGED'), 1)
      this.values.set(normalizeRuntimeVariableKey('A:MASTER CAUTION ACTIVE'), 0)
      return true
    }

    if (name === 'ANNUNCIATOR_SWITCH_ON' || name === 'ANNUNCIATOR_SWITCH_OFF') {
      this.values.set(normalizeRuntimeVariableKey('A:ANNUNCIATOR SWITCH'), name.endsWith('_ON') ? 1 : 0)
      return true
    }

    if (name === 'TOGGLE_ALTERNATE_STATIC') {
      const key = normalizeRuntimeVariableKey('A:ALTERNATE STATIC SOURCE OPEN')
      const currentValue = this.values.get(key) ?? 0
      this.values.set(key, currentValue > 0 ? 0 : 1)
      return true
    }

    if (name === 'ELT_ON' || name === 'ELT_OFF') {
      this.values.set(normalizeRuntimeVariableKey('A:ELT ACTIVATED'), name.endsWith('_ON') ? 1 : 0)
      return true
    }

    return false
  }

  private applyRadioKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'COM_RECEIVE_ALL_SET') {
      const value = Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      for (let index = 1; index <= 4; index += 1) {
        this.values.set(normalizeRuntimeVariableKey(`A:COM RECEIVE:${index}`), value)
      }
      return true
    }

    const comReceiveMatch = /^COM(\d*)_RECEIVE_SELECT$/u.exec(name)
    if (comReceiveMatch != null) {
      const index = comReceiveMatch[1] === '' ? 1 : Number.parseInt(comReceiveMatch[1], 10)
      const key = normalizeRuntimeVariableKey(`A:COM RECEIVE:${index}`)
      const rawValue = Number(args.at(-1) ?? Number.NaN)
      const nextValue = Number.isFinite(rawValue) ? (rawValue > 0 ? 1 : 0) : (this.values.get(key) ?? 0) > 0 ? 0 : 1
      this.values.set(key, nextValue)
      return true
    }

    return false
  }

  private applyPitotHeatKeyEvent(name: string, args: readonly number[]): boolean {
    const pitotMatch = /^PITOT_HEAT_(ON|OFF|TOGGLE|SET)$/u.exec(name)
    if (pitotMatch == null) {
      return false
    }
    const index = Math.trunc(Number(args[0] ?? 1))
    const key = normalizeRuntimeVariableKey(Number.isFinite(index) ? `A:PITOT HEAT SWITCH:${index}` : 'A:PITOT HEAT')
    const nextValue =
      pitotMatch[1] === 'TOGGLE'
        ? (this.values.get(key) ?? 0) > 0 ? 0 : 1
        : pitotMatch[1] === 'SET' ? Number(args.at(-1) ?? 0) > 0 ? 1 : 0
          : pitotMatch[1] === 'ON' ? 1 : 0
    this.values.set(key, nextValue)
    this.values.set(normalizeRuntimeVariableKey('A:PITOT HEAT'), nextValue)
    this.msfsCompatibilityBridge.writeSimVar(
      Number.isFinite(index) ? `A:PITOT HEAT SWITCH:${index}` : 'A:PITOT HEAT',
      nextValue,
      'Bool'
    )
    return true
  }

  private applyRadioAudioKeyEvent(name: string, args: readonly number[]): boolean {
    const volumeMatch = /^(ADF2?|NAV(\d+)|COM(\d+))_VOLUME_(SET|INC|DEC)$/u.exec(name)
    if (volumeMatch != null) {
      const family = volumeMatch[1].startsWith('ADF') ? 'ADF'
        : volumeMatch[1].startsWith('NAV') ? 'NAV'
          : 'COM'
      const index = family === 'ADF'
        ? volumeMatch[1] === 'ADF2' ? 2 : 1
        : Number.parseInt(volumeMatch[2] ?? volumeMatch[3] ?? '1', 10)
      const key = normalizeRuntimeVariableKey(`A:${family} VOLUME:${index}`)
      const action = volumeMatch[4]
      const currentValue = this.values.get(key) ?? 0
      const nextValue =
        action === 'SET'
          ? clamp(Number(args.at(-1) ?? 0), 0, 100)
          : clamp(currentValue + (action === 'INC' ? 5 : -5), 0, 100)
      this.values.set(key, nextValue)
      if (family === 'NAV') {
        this.values.set(normalizeRuntimeVariableKey(`A:NAV SOUND:${index}`), nextValue > 0 ? 1 : 0)
      } else if (family === 'COM') {
        this.values.set(normalizeRuntimeVariableKey(`A:COM RADIO VOLUME:${index}`), nextValue)
      }
      return true
    }

    if (name === 'COM3_RADIO_SET_HZ') {
      const value = Number(args.at(-1) ?? 0)
      this.setRadioFrequency('COM', 3, 'ACTIVE', value / 1_000_000)
      return true
    }

    const identMatch = /^RADIO_(ADF2?|DME(\d+)|VOR(\d+))_IDENT_(ENABLE|DISABLE|TOGGLE|SET)$/u.exec(name)
    if (identMatch != null) {
      const family = identMatch[1].startsWith('ADF') ? 'ADF'
        : identMatch[1].startsWith('DME') ? 'DME'
          : 'NAV'
      const index = family === 'ADF'
        ? identMatch[1] === 'ADF2' ? 2 : 1
        : Number.parseInt(identMatch[2] ?? identMatch[3] ?? '1', 10)
      const keys = [
        normalizeRuntimeVariableKey(`A:${family} IDENT:${index}`),
        normalizeRuntimeVariableKey(`${family === 'NAV' ? 'A:NAV SOUND' : `A:${family} SOUND`}:${index}`)
      ]
      const action = identMatch[4]
      const currentValue = this.values.get(keys[0] ?? '') ?? 0
      const nextValue =
        action === 'TOGGLE'
          ? currentValue > 0 ? 0 : 1
          : action === 'SET' ? Number(args.at(-1) ?? 0) > 0 ? 1 : 0
            : action === 'ENABLE' ? 1 : 0
      for (const key of keys) {
        this.values.set(key, nextValue)
      }
      return true
    }

    if (name === 'MARKER_SOUND_TOGGLE') {
      this.toggleNamedBoolVariables('A:MARKER SOUND')
      return true
    }

    const transmitterMatch = /^(PILOT|COPILOT)_TRANSMITTER_SET$/u.exec(name)
    if (transmitterMatch != null) {
      this.values.set(normalizeRuntimeVariableKey(`A:${transmitterMatch[1]} TRANSMITTER TYPE`), Number(args.at(-1) ?? 0))
      return true
    }

    return false
  }

  private applyNavComKeyEvent(name: string, args: readonly number[]): boolean {
    const radioFrequencyMatch = /^(COM|NAV)(\d+)_RADIO_(WHOLE|FRACT)_(INC|DEC)$/u.exec(name)
    if (radioFrequencyMatch != null) {
      const family = radioFrequencyMatch[1]
      const index = Number.parseInt(radioFrequencyMatch[2], 10)
      const step = radioFrequencyMatch[3] === 'WHOLE'
        ? 1
        : family === 'COM' ? 0.025 : 0.05
      this.adjustRadioStandbyFrequency(family, index, radioFrequencyMatch[4] === 'INC' ? step : -step)
      return true
    }

    const radioSwapMatch = /^(COM|NAV)(\d+)_RADIO_SWAP$/u.exec(name)
    if (radioSwapMatch != null) {
      this.swapRadioFrequencies(radioSwapMatch[1], Number.parseInt(radioSwapMatch[2], 10))
      return true
    }

    const receiveSelectMatch = /^(COM|NAV)(\d+)_RECEIVE_SELECT$/u.exec(name)
    if (receiveSelectMatch != null) {
      const family = receiveSelectMatch[1]
      const index = Number.parseInt(receiveSelectMatch[2], 10)
      const key = normalizeRuntimeVariableKey(`A:${family} RECEIVE:${index}`)
      const nextValue = (this.values.get(key) ?? 0) > 0 ? 0 : 1
      this.values.set(key, nextValue)
      if (family === 'NAV') {
        this.values.set(normalizeRuntimeVariableKey(`A:NAV SOUND:${index}`), nextValue)
      }
      return true
    }

    if (name === 'COM_RECEIVE_ALL_SET') {
      const value = Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      for (let index = 1; index <= 4; index += 1) {
        this.values.set(normalizeRuntimeVariableKey(`A:COM RECEIVE:${index}`), value)
      }
      return true
    }

    const adfFrequencyMatch = /^ADF_(100|10|1)_(INC|DEC)$/u.exec(name)
    if (adfFrequencyMatch != null) {
      const step = Number.parseInt(adfFrequencyMatch[1], 10)
      this.adjustAdfStandbyFrequency(adfFrequencyMatch[2] === 'INC' ? step : -step)
      return true
    }

    if (name === 'ADF_VOLUME_INC' || name === 'ADF_VOLUME_DEC') {
      const key = normalizeRuntimeVariableKey('A:ADF VOLUME:1')
      const currentValue = this.values.get(key) ?? 0
      this.values.set(key, clamp(currentValue + (name === 'ADF_VOLUME_INC' ? 5 : -5), 0, 100))
      return true
    }

    const booleanToggles: Partial<Record<string, string>> = {
      TOGGLE_GPS_DRIVES_NAV1: 'A:GPS DRIVES NAV1',
      TOGGLE_ICS: 'A:INTERCOM SYSTEM ACTIVE',
      TOGGLE_SPEAKER: 'A:SPEAKER ACTIVE',
      MARKER_BEACON_TEST_MUTE: 'A:MARKER BEACON TEST MUTE',
      MARKER_BEACON_SENSITIVITY_HIGH: 'A:MARKER BEACON SENSITIVITY HIGH'
    }
    const booleanToggle = booleanToggles[name]
    if (booleanToggle != null) {
      this.toggleNamedBoolVariables(booleanToggle)
      return true
    }

    if (name === 'INTERCOM_MODE_SET') {
      this.values.set(normalizeRuntimeVariableKey('A:INTERCOM MODE'), Math.max(0, Math.trunc(Number(args.at(-1) ?? 0))))
      return true
    }

    if (name === 'AUDIO_PANEL_VOLUME_INC' || name === 'AUDIO_PANEL_VOLUME_DEC') {
      const key = normalizeRuntimeVariableKey('A:AUDIO PANEL VOLUME')
      const currentValue = this.values.get(key) ?? 0
      this.values.set(key, clamp(currentValue + (name === 'AUDIO_PANEL_VOLUME_INC' ? 5 : -5), 0, 100))
      return true
    }

    if (name === 'INCREASE_DECISION_HEIGHT' || name === 'DECREASE_DECISION_HEIGHT') {
      const key = normalizeRuntimeVariableKey('A:DECISION HEIGHT')
      const currentValue = this.values.get(key) ?? 0
      this.values.set(key, Math.max(0, currentValue + (name === 'INCREASE_DECISION_HEIGHT' ? 10 : -10)))
      return true
    }

    if (name === 'XPNDR_SET') {
      const index = Math.trunc(Number(args.length >= 2 ? args[0] : 1))
      const value = Number(args.at(-1) ?? 0)
      this.setTransponderState(index, value)
      return true
    }

    return false
  }

  private applyInstrumentKeyEvent(name: string, args: readonly number[]): boolean {
    const vorCourseMatch = /^(?:KEY_)?VOR(\d+)_(INC|DEC|SET)$/u.exec(name)
    if (vorCourseMatch != null) {
      const index = Number.parseInt(vorCourseMatch[1], 10)
      const key = normalizeRuntimeVariableKey(`A:NAV OBS:${index}`)
      const currentValue = this.values.get(key) ?? 0
      const step = Math.abs(Number(args.at(-1) ?? 1)) || 1
      const nextValue = vorCourseMatch[2] === 'SET'
        ? Number(args.at(-1) ?? currentValue)
        : currentValue + (vorCourseMatch[2] === 'INC' ? step : -step)
      this.setCourseDegrees(`A:NAV OBS:${index}`, nextValue)
      return true
    }

    if (name === 'ADF_CARD_INC' || name === 'ADF_CARD_DEC' || name === 'ADF_CARD_SET') {
      const key = normalizeRuntimeVariableKey('A:ADF RADIAL')
      const currentValue = this.values.get(key) ?? 0
      const step = Math.abs(Number(args.at(-1) ?? 1)) || 1
      const nextValue = name === 'ADF_CARD_SET'
        ? Number(args.at(-1) ?? currentValue)
        : currentValue + (name === 'ADF_CARD_INC' ? step : -step)
      this.setCourseDegrees('A:ADF RADIAL', nextValue)
      this.setCourseDegrees('A:ADF CARD', nextValue)
      return true
    }

    return false
  }

  private applyTrimAndBrakeKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'AXIS_ELEV_TRIM_SET' || name === 'ELEVATOR_TRIM_SET') {
      const trim = clamp(Number(args.at(-1) ?? 0) / 16_383, -1, 1)
      this.values.set(normalizeRuntimeVariableKey('A:ELEVATOR TRIM POSITION'), trim)
      this.values.set(normalizeRuntimeVariableKey('A:ELEVATOR TRIM INDICATOR'), trim * 100)
      return true
    }

    if (name === 'ELEV_TRIM_UP' || name === 'ELEV_TRIM_DN') {
      const key = normalizeRuntimeVariableKey('A:ELEVATOR TRIM POSITION')
      const currentValue = this.values.get(key) ?? 0
      const direction = name === 'ELEV_TRIM_UP' ? 1 : -1
      this.setElevatorTrim(currentValue + direction * 0.05)
      return true
    }

    if (name === 'AILERON_TRIM_LEFT' || name === 'AILERON_TRIM_RIGHT') {
      const key = normalizeRuntimeVariableKey('A:AILERON TRIM PCT')
      const currentValue = this.values.get(key) ?? 0
      const direction = name === 'AILERON_TRIM_RIGHT' ? 1 : -1
      this.setAileronTrim(currentValue + direction * 0.05)
      return true
    }

    if (name === 'AILERON_TRIM_SET' || name === 'AILERON_TRIM_SET_EX1') {
      this.setAileronTrim(Number(args.at(-1) ?? 0) / 16_384)
      return true
    }

    if (name === 'RUDDER_TRIM_RESET') {
      this.setRudderTrim(0)
      return true
    }

    if (name === 'RUDDER_TRIM_LEFT' || name === 'RUDDER_TRIM_RIGHT') {
      const key = normalizeRuntimeVariableKey('A:RUDDER TRIM PCT')
      const currentValue = this.values.get(key) ?? 0
      const direction = name === 'RUDDER_TRIM_RIGHT' ? 1 : -1
      this.setRudderTrim(currentValue + direction * 0.05)
      return true
    }

    if (name === 'RUDDER_TRIM_SET') {
      this.setRudderTrim(trimSetEventValueToFraction(Number(args.at(-1) ?? 0)))
      return true
    }

    if (name === 'RUDDER_TRIM_SET_EX1') {
      this.setRudderTrim(Number(args.at(-1) ?? 0) / 16_384)
      return true
    }

    if (name === 'ANTISKID_BRAKES_TOGGLE') {
      this.toggleNamedBoolVariables('A:ANTISKID BRAKES ACTIVE', 'A:ANTISKID BRAKES SWITCH')
      return true
    }

    return false
  }

  private applyHandlingAndGearKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'TOGGLE_AIRCRAFT_EXIT_FAST') {
      const rawIndex = Math.trunc(Number(args.at(-1) ?? 0))
      const index = Number.isFinite(rawIndex) && rawIndex >= 0 ? rawIndex : 0
      const key = normalizeRuntimeVariableKey(`A:INTERACTIVE POINT GOAL:${index}`)
      const currentValue = this.values.get(key) ?? 0
      const nextValue = currentValue > 0 ? 0 : 100
      this.values.set(key, nextValue)
      this.values.set(normalizeRuntimeVariableKey(`A:INTERACTIVE POINT OPEN:${index}`), nextValue)
      return true
    }

    if (name === 'AXIS_LEFT_BRAKE_SET' || name === 'AXIS_RIGHT_BRAKE_SET') {
      const side = name === 'AXIS_LEFT_BRAKE_SET' ? 'LEFT' : 'RIGHT'
      this.setBrakePosition(side, position16kToPercent(Number(args.at(-1) ?? 0), false))
      return true
    }

    if (name === 'GEAR_EMERGENCY_HANDLE_TOGGLE') {
      const key = normalizeRuntimeVariableKey('A:GEAR EMERGENCY HANDLE POSITION')
      this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
      return true
    }

    if (name === 'RETRACT_FLOAT_SWITCH_INC' || name === 'RETRACT_FLOAT_SWITCH_DEC') {
      const key = normalizeRuntimeVariableKey('A:FLOAT SWITCH RETRACTED')
      this.values.set(key, name === 'RETRACT_FLOAT_SWITCH_INC' ? 1 : 0)
      return true
    }

    if (name === 'TOGGLE_WATER_RUDDER') {
      const key = normalizeRuntimeVariableKey('A:WATER RUDDER HANDLE POSITION')
      this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 100)
      return true
    }

    if (name === 'SPOILERS_ARM_ON' || name === 'SPOILERS_ARM_OFF' || name === 'SPOILERS_ARM_TOGGLE') {
      const key = normalizeRuntimeVariableKey('A:SPOILERS ARMED')
      this.setSpoilersArmed(
        name === 'SPOILERS_ARM_ON'
          ? 1
          : name === 'SPOILERS_ARM_OFF'
            ? 0
            : (this.values.get(key) ?? 0) > 0 ? 0 : 1
      )
      return true
    }

    if (name === 'SET_WING_FOLD' || name === 'TOGGLE_WING_FOLD') {
      const key = normalizeRuntimeVariableKey('A:FOLDING WING HANDLE POSITION')
      const value = name === 'TOGGLE_WING_FOLD'
        ? (this.values.get(key) ?? 0) > 0 ? 0 : 1
        : Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      this.values.set(key, value)
      this.values.set(normalizeRuntimeVariableKey('A:FOLDING WING LEFT PERCENT'), value * 100)
      this.values.set(normalizeRuntimeVariableKey('A:FOLDING WING RIGHT PERCENT'), value * 100)
      return true
    }

    if (name === 'SET_LAUNCH_BAR_SWITCH' || name === 'TOGGLE_LAUNCH_BAR_SWITCH') {
      const key = normalizeRuntimeVariableKey('A:LAUNCHBAR SWITCH')
      const value = name === 'TOGGLE_LAUNCH_BAR_SWITCH'
        ? (this.values.get(key) ?? 0) > 0 ? 0 : 1
        : Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      this.values.set(key, value)
      this.values.set(normalizeRuntimeVariableKey('A:LAUNCHBAR POSITION'), value * 100)
      return true
    }

    if (name === 'SET_TAIL_HOOK_HANDLE' || name === 'TOGGLE_TAIL_HOOK_HANDLE') {
      const key = normalizeRuntimeVariableKey('A:TAILHOOK HANDLE')
      const value = name === 'TOGGLE_TAIL_HOOK_HANDLE'
        ? (this.values.get(key) ?? 0) > 0 ? 0 : 1
        : Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      this.values.set(key, value)
      this.values.set(normalizeRuntimeVariableKey('A:TAILHOOK POSITION'), value * 100)
      return true
    }

    if (name === 'TOGGLE_TAILWHEEL_LOCK') {
      const key = normalizeRuntimeVariableKey('A:TAILWHEEL LOCK ON')
      this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
      return true
    }

    if (name === 'TOGGLE_WATER_BALLAST_VALVE') {
      const maybeIndex = Math.trunc(Number(args.at(-1) ?? 1))
      const index = Number.isFinite(maybeIndex) && maybeIndex > 0 ? maybeIndex : 1
      const key = normalizeRuntimeVariableKey(`A:WATER BALLAST VALVE:${index}`)
      this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
      return true
    }

    if (name === 'TOW_PLANE_RELEASE') {
      this.values.set(normalizeRuntimeVariableKey('A:TOW RELEASE HANDLE'), 100)
      this.values.set(normalizeRuntimeVariableKey('A:TOW CONNECTION'), 0)
      return true
    }

    if (name === 'AUTOPILOT_DISENGAGE_SET') {
      const nextValue = Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      this.values.set(normalizeRuntimeVariableKey('A:AUTOPILOT DISENGAGED'), nextValue)
      this.msfsCompatibilityBridge.writeSimVar('A:AUTOPILOT DISENGAGED', nextValue, 'Bool')
      return true
    }

    if (name === 'NOSE_WHEEL_STEERING_LIMIT_SET') {
      this.values.set(normalizeRuntimeVariableKey('A:NOSE WHEEL STEERING LIMIT'), Number(args.at(-1) ?? 0))
      return true
    }

    if (name === 'G_LIMITER_SET') {
      this.values.set(normalizeRuntimeVariableKey('A:G LIMITER SETTING'), Number(args.at(-1) ?? 0))
      return true
    }

    if (name === 'SET_AUTOBRAKE_CONTROL') {
      this.values.set(normalizeRuntimeVariableKey('A:AUTOBRAKES ACTIVE'), Number(args.at(-1) ?? 0))
      return true
    }

    const trimDisabledMatch = /^(RUDDER|AILERON|ELEVATOR)_TRIM_DISABLED_SET$/u.exec(name)
    if (trimDisabledMatch != null) {
      const nextValue = Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      const key = `A:${trimDisabledMatch[1]} TRIM DISABLED`
      this.values.set(normalizeRuntimeVariableKey(key), nextValue)
      this.msfsCompatibilityBridge.writeSimVar(key, nextValue, 'Bool')
      return true
    }

    return false
  }

  private applyDeiceAndIgnitionKeyEvent(name: string, args: readonly number[]): boolean {
    const engineAntiIceSetMatch = /^ANTI_ICE_SET_ENG(\d+)$/u.exec(name)
    if (engineAntiIceSetMatch != null) {
      this.setEngineAntiIcePosition(Number.parseInt(engineAntiIceSetMatch[1], 10), Number(args.at(-1) ?? 0) > 0 ? 100 : 0)
      return true
    }

    const engineAntiIceToggleMatch = /^ANTI_ICE_TOGGLE_ENG(\d+)$/u.exec(name)
    if (engineAntiIceToggleMatch != null) {
      const index = Number.parseInt(engineAntiIceToggleMatch[1], 10)
      const key = normalizeRuntimeVariableKey(`A:ENG ANTI ICE:${index}`)
      this.setEngineAntiIcePosition(index, (this.values.get(key) ?? 0) > 0 ? 0 : 100)
      return true
    }

    const engineAntiIceGradualSetMatch = /^ANTI_ICE_GRADUAL_SET_ENG(\d+)$/u.exec(name)
    if (engineAntiIceGradualSetMatch != null) {
      const position16k = clamp(Number(args.at(-1) ?? 0), 0, 16_384)
      this.setEngineAntiIcePosition(
        Number.parseInt(engineAntiIceGradualSetMatch[1], 10),
        (position16k / 16_384) * 100
      )
      return true
    }

    if (name === 'TOGGLE_STRUCTURAL_DEICE') {
      const key = normalizeRuntimeVariableKey('A:STRUCTURAL DEICE SWITCH')
      const nextValue = (this.values.get(key) ?? 0) > 0 ? 0 : 1
      this.values.set(key, nextValue)
      this.msfsCompatibilityBridge.writeSimVar(
        'A:STRUCTURAL DEICE SWITCH',
        nextValue,
        'Bool'
      )
      return true
    }

    if (name === 'STRUCTURAL_DEICE_SET') {
      const nextValue = Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      this.values.set(normalizeRuntimeVariableKey('A:STRUCTURAL DEICE SWITCH'), nextValue)
      this.msfsCompatibilityBridge.writeSimVar(
        'A:STRUCTURAL DEICE SWITCH',
        nextValue,
        'Bool'
      )
      return true
    }

    const propellerDeiceMatch = /^(?:TOGGLE_PROPELLER_DEICE|ANTI_ICE_(ON|OFF|TOGGLE|SET)|PROP_DEICE_(ON|OFF|TOGGLE|SET))$/u.exec(name)
    if (propellerDeiceMatch != null) {
      const action = propellerDeiceMatch[1] ?? 'TOGGLE'
      const maybeIndexedArg = Math.trunc(Number(args[0] ?? Number.NaN))
      const hasExplicitSetValue = action === 'SET' && args.length > 1
      const index = Number.isFinite(maybeIndexedArg) && hasExplicitSetValue ? maybeIndexedArg : 1
      const key = normalizeRuntimeVariableKey(`A:PROP DEICE SWITCH:${index}`)
      const nextValue =
        action === 'TOGGLE'
          ? (this.values.get(key) ?? 0) > 0 ? 0 : 1
          : action === 'SET' ? Number(args.at(-1) ?? 0) > 0 ? 1 : 0
            : action === 'ON' ? 1 : 0
      this.values.set(key, nextValue)
      this.values.set(normalizeRuntimeVariableKey('A:PROP DEICE SWITCH'), nextValue)
      return true
    }

    const windshieldDeiceMatch = /^WINDSHIELD_DEICE_(ON|OFF|TOGGLE|SET)$/u.exec(name)
    if (windshieldDeiceMatch != null) {
      const key = normalizeRuntimeVariableKey('A:WINDSHIELD DEICE SWITCH')
      const nextValue =
        windshieldDeiceMatch[1] === 'TOGGLE'
          ? (this.values.get(key) ?? 0) > 0 ? 0 : 1
          : windshieldDeiceMatch[1] === 'SET' ? Number(args.at(-1) ?? 0) : windshieldDeiceMatch[1] === 'ON' ? 1 : 0
      this.values.set(key, nextValue)
      return true
    }

    const ignitionMatch = /^TURBINE_IGNITION_SWITCH_(SET|TOGGLE)(\d*)$/u.exec(name)
    if (ignitionMatch != null) {
      const explicitIndex = ignitionMatch[2] === '' ? Number.NaN : Number.parseInt(ignitionMatch[2], 10)
      const index = Number.isFinite(explicitIndex) ? explicitIndex : Math.trunc(Number(args[1] ?? 1))
      if (Number.isFinite(index)) {
        const key = normalizeRuntimeVariableKey(`A:TURB ENG IGNITION SWITCH EX1:${index}`)
        const nextValue = ignitionMatch[1] === 'TOGGLE' ? (this.values.get(key) ?? 0) > 0 ? 0 : 1 : Number(args[0] ?? 0)
        this.values.set(key, nextValue)
        this.values.set(normalizeRuntimeVariableKey(`A:TURBINE IGNITION SWITCH:${index}`), nextValue)
      }
      return true
    }

    const mixtureRichLeanMatch = /^MIXTURE(\d+)_(RICH|LEAN)$/u.exec(name)
    if (mixtureRichLeanMatch != null) {
      const index = Number.parseInt(mixtureRichLeanMatch[1], 10)
      this.values.set(
        normalizeRuntimeVariableKey(`A:GENERAL ENG MIXTURE LEVER POSITION:${index}`),
        mixtureRichLeanMatch[2] === 'RICH' ? 100 : 0
      )
      return true
    }

    return false
  }

  private applyEngineControlKeyEvent(name: string, args: readonly number[]): boolean {
    const throttleSetMatch = /^(?:AXIS_)?THROTTLE(\d*)(?:_AXIS)?_SET(?:_EX1)?$/u.exec(name)
    if (throttleSetMatch != null) {
      this.setIndexedEnginePercentPosition(
        'GENERAL ENG THROTTLE LEVER POSITION',
        throttleSetMatch[1],
        position16kToPercent(Number(args.at(-1) ?? 0), true)
      )
      return true
    }

    const throttleFullCutMatch = /^THROTTLE(\d*)_(FULL|CUT)$/u.exec(name)
    if (throttleFullCutMatch != null) {
      this.setIndexedEnginePercentPosition(
        'GENERAL ENG THROTTLE LEVER POSITION',
        throttleFullCutMatch[1],
        throttleFullCutMatch[2] === 'FULL' ? 100 : 0
      )
      return true
    }

    const propPitchSetMatch = /^PROP_PITCH(\d*)_SET$/u.exec(name)
    if (propPitchSetMatch != null) {
      this.setIndexedEnginePercentPosition(
        'GENERAL ENG PROPELLER LEVER POSITION',
        propPitchSetMatch[1],
        position16kToPercent(Number(args.at(-1) ?? 0), true)
      )
      return true
    }

    const mixtureSetMatch = /^(?:AXIS_)?MIXTURE(\d*)_SET$/u.exec(name)
    if (mixtureSetMatch != null) {
      this.setIndexedEnginePercentPosition(
        'GENERAL ENG MIXTURE LEVER POSITION',
        mixtureSetMatch[1],
        position16kToPercent(Number(args.at(-1) ?? 0), false)
      )
      return true
    }

    const cowlFlapSetMatch = /^COWLFLAP(\d*)_SET$/u.exec(name)
    if (cowlFlapSetMatch != null) {
      this.setIndexedEnginePercentPosition(
        'RECIP ENG COWL FLAP POSITION',
        cowlFlapSetMatch[1],
        position16kToPercent(Number(args.at(-1) ?? 0), false)
      )
      return true
    }

    const coolingFlapsSetMatch = /^([A-Z0-9_]+)_COOLING_FLAPS_SET$/u.exec(name)
    if (coolingFlapsSetMatch != null) {
      this.values.set(
        normalizeRuntimeVariableKey(`A:${coolingFlapsSetMatch[1].replace(/_/gu, ' ')} COOLING FLAPS POSITION`),
        position16kToPercent(Number(args.at(-1) ?? 0), false)
      )
      return true
    }

    if (name === 'PROP_FORCE_BETA_ON' || name === 'PROP_FORCE_BETA_OFF') {
      const index = Math.trunc(Number(args.at(-1) ?? 1))
      if (Number.isFinite(index)) {
        this.values.set(
          normalizeRuntimeVariableKey(`A:PROP BETA FORCED ACTIVE:${index}`),
          name === 'PROP_FORCE_BETA_ON' ? 1 : 0
        )
      }
      return true
    }

    if (name === 'PROP_FORCE_BETA_VALUE_SET') {
      const index = Math.trunc(Number(args.at(-1) ?? 1))
      const value = Number(args.at(-2) ?? 0)
      if (Number.isFinite(index)) {
        this.values.set(
          normalizeRuntimeVariableKey(`A:PROP BETA FORCED POSITION:${index}`),
          position16kToPercent(value, false)
        )
      }
      return true
    }

    return false
  }

  private setIndexedEnginePercentPosition(simvarName: string, rawIndex: string, percent: number): void {
    const indexes = rawIndex === '' ? [1, 2, 3, 4] : [Number.parseInt(rawIndex, 10)]
    for (const index of indexes) {
      if (!Number.isFinite(index)) {
        continue
      }
      const variableKey = normalizeRuntimeVariableKey(`A:${simvarName}:${Math.trunc(index)}`)
      this.values.set(variableKey, percent)
      this.writeEngineCompatibilityVariable(variableKey, percent, 'percent')
    }
    if (simvarName === 'GENERAL ENG THROTTLE LEVER POSITION') {
      this.throttleLeverPosition = percent
    }
  }

  private applyEngineSwitchKeyEvent(name: string, args: readonly number[]): boolean {
    const starterHeldMatch = /^SET_STARTER(\d+)_HELD$/u.exec(name)
    if (starterHeldMatch != null) {
      this.setEngineStarter(Number.parseInt(starterHeldMatch[1], 10), Number(args.at(-1) ?? 0) > 0 ? 1 : 0)
      return true
    }

    const starterSetMatch = /^STARTER(\d+)_SET$/u.exec(name)
    if (starterSetMatch != null) {
      this.setEngineStarter(Number.parseInt(starterSetMatch[1], 10), Number(args.at(-1) ?? 0) > 0 ? 1 : 0)
      return true
    }

    const starterToggleMatch = /^TOGGLE_STARTER(\d+)$/u.exec(name)
    if (starterToggleMatch != null) {
      const index = Number.parseInt(starterToggleMatch[1], 10)
      const key = normalizeRuntimeVariableKey(`A:GENERAL ENG STARTER:${index}`)
      this.setEngineStarter(index, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
      return true
    }

    const engineMasterToggleMatch = /^ENGINE_MASTER_(\d+)_TOGGLE$/u.exec(name)
    if (engineMasterToggleMatch != null) {
      const index = Number.parseInt(engineMasterToggleMatch[1], 10)
      const key = normalizeRuntimeVariableKey(`A:RECIP ENG ENGINE MASTER SWITCH:${index}`)
      this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
      return true
    }

    const magnetoSetMatch = /^MAGNETO(\d+)_SET$/u.exec(name)
    if (magnetoSetMatch != null) {
      this.setMagnetoState(Number.parseInt(magnetoSetMatch[1], 10), Math.trunc(Number(args.at(-1) ?? 0)))
      return true
    }

    const magnetoSideMatch = /^MAGNETO(\d+)_(LEFT|RIGHT|BOTH|OFF|START)$/u.exec(name)
    if (magnetoSideMatch != null) {
      const index = Number.parseInt(magnetoSideMatch[1], 10)
      const side = magnetoSideMatch[2]
      const state = side === 'OFF' ? 0 : side === 'LEFT' ? 1 : side === 'RIGHT' ? 2 : side === 'BOTH' ? 3 : 4
      this.setMagnetoState(index, state)
      if (side === 'START') {
        this.setEngineStarter(index, 1)
      }
      return true
    }

    const primerToggleMatch = /^TOGGLE_PRIMER(\d+)$/u.exec(name)
    if (primerToggleMatch != null) {
      const index = Number.parseInt(primerToggleMatch[1], 10)
      const key = normalizeRuntimeVariableKey(`A:RECIP ENG PRIMER:${index}`)
      this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 100)
      return true
    }

    if (name === 'HYDRAULIC_SWITCH_TOGGLE') {
      const index = Math.trunc(Number(args.at(-1) ?? 1))
      if (Number.isFinite(index)) {
        const switchKey = normalizeRuntimeVariableKey(`A:HYDRAULIC SWITCH:${index}`)
        const nextValue = (this.values.get(switchKey) ?? 0) > 0 ? 0 : 1
        this.values.set(switchKey, nextValue)
        this.values.set(normalizeRuntimeVariableKey(`A:HYDRAULIC RESERVOIR PERCENT:${index}`), nextValue > 0 ? 100 : 0)
        // Placeholder pressure keeps stock hydraulic warning expressions deterministic until a hydraulic model exists.
        this.values.set(normalizeRuntimeVariableKey(`A:HYDRAULIC PRESSURE:${index}`), nextValue > 0 ? 3000 : 0)
      }
      return true
    }

    if (name === 'ANTIDETONATION_TANK_VALVE_TOGGLE') {
      const index = Math.trunc(Number(args.at(-1) ?? 1))
      if (Number.isFinite(index)) {
        const key = normalizeRuntimeVariableKey(`A:RECIP ENG ANTIDETONATION TANK VALVE:${index}`)
        this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
      }
      return true
    }

    if (name === 'WAR_EMERGENCY_POWER') {
      const key = normalizeRuntimeVariableKey('A:RECIP ENG EMERGENCY BOOST ACTIVE:1')
      this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
      return true
    }

    const engineModeMatch = /^ENGINE_MODE_(CRANK|NORM|IGN)_SET$/u.exec(name)
    if (engineModeMatch != null) {
      const modeValue = engineModeMatch[1] === 'CRANK' ? 0 : engineModeMatch[1] === 'NORM' ? 1 : 2
      this.setTurbineIgnitionMode(null, modeValue)
      return true
    }

    const turbineIgnitionSetMatch = /^TURBINE_IGNITION_SWITCH_SET(\d*)$/u.exec(name)
    if (turbineIgnitionSetMatch != null) {
      const rawIndex = turbineIgnitionSetMatch[1] ?? ''
      const engineIndex = rawIndex ? Number.parseInt(rawIndex, 10) : null
      this.setTurbineIgnitionMode(engineIndex, Math.trunc(Number(args.at(-1) ?? 0)))
      return true
    }

    const plasmaSetMatch = /^PLASMA_(ON|OFF|SET)$/u.exec(name)
    if (plasmaSetMatch != null) {
      const value = plasmaSetMatch[1] === 'SET' ? Number(args.at(-1) ?? 0) > 0 ? 1 : 0 : plasmaSetMatch[1] === 'ON' ? 1 : 0
      this.values.set(normalizeRuntimeVariableKey('A:PLASMA ON:1'), value)
      this.values.set(normalizeRuntimeVariableKey('A:PLASMA ON'), value)
      return true
    }

    if (name === 'ROTOR_CLUTCH_SWITCH_SET') {
      const value = Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      this.values.set(normalizeRuntimeVariableKey('A:ROTOR CLUTCH SWITCH POS'), value)
      return true
    }

    if (name === 'AXIS_ROTOR_BRAKE_SET') {
      this.values.set(
        normalizeRuntimeVariableKey('A:ROTOR BRAKE HANDLE POS'),
        position16kToPercent(Number(args.at(-1) ?? 0), false)
      )
      return true
    }

    return false
  }

  private setTurbineIgnitionMode(engineIndex: number | null, value: number): void {
    const modeValue = clamp(Math.trunc(Number.isFinite(value) ? value : 0), 0, 2)
    if (engineIndex == null) {
      this.values.set(normalizeRuntimeVariableKey('A:TURBINE IGNITION SWITCH'), modeValue)
      for (let index = 1; index <= 4; index += 1) {
        this.setTurbineIgnitionMode(index, modeValue)
      }
      return
    }
    if (!Number.isFinite(engineIndex)) {
      return
    }
    const index = Math.trunc(engineIndex)
    this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG IGNITION SWITCH EX1:${index}`), modeValue)
    this.values.set(normalizeRuntimeVariableKey(`A:TURBINE IGNITION SWITCH:${index}`), modeValue)
    this.values.set(normalizeRuntimeVariableKey('A:TURBINE IGNITION SWITCH'), modeValue)
    const allKnownModes = [1, 2, 3, 4]
      .map(candidate => this.values.get(normalizeRuntimeVariableKey(`A:TURBINE IGNITION SWITCH:${candidate}`)))
      .filter((candidate): candidate is number => candidate != null)
    if (allKnownModes.length > 0 && allKnownModes.every(candidate => candidate === modeValue)) {
      this.values.set(normalizeRuntimeVariableKey('A:TURBINE IGNITION SWITCH'), modeValue)
    }
    const fuelValveValue = this.values.get(normalizeRuntimeVariableKey(`A:FUELSYSTEM VALVE SWITCH:${index}`)) ?? 0
    if (fuelValveValue > 0) {
      this.applyTurbineFuelValveSideEffects(index, fuelValveValue)
    }
  }

  private setEngineStarter(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const engineIndex = Math.trunc(index)
    const starterValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG STARTER:${engineIndex}`), starterValue)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:GENERAL ENG STARTER:${engineIndex}`,
      starterValue,
      'Bool'
    )
    this.simulatorEngine.dispatch({
      type: PropulsionCommandTypes.setEngineStarter,
      payload: { index: engineIndex, enabled: starterValue > 0 },
      source: 'msfs-key-event',
    })
  }

  private setMagnetoState(index: number, state: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const engineIndex = Math.trunc(index)
    const magnetoState = clamp(Math.trunc(Number.isFinite(state) ? state : 0), 0, 4)
    const leftOn = magnetoState === 1 || magnetoState === 3 || magnetoState === 4 ? 1 : 0
    const rightOn = magnetoState === 2 || magnetoState === 3 || magnetoState === 4 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:RECIP ENG LEFT MAGNETO:${engineIndex}`), leftOn)
    this.values.set(normalizeRuntimeVariableKey(`A:RECIP ENG RIGHT MAGNETO:${engineIndex}`), rightOn)
    this.values.set(normalizeRuntimeVariableKey(`A:RECIP ENG MAGNETO:${engineIndex}`), magnetoState)
  }

  private applyAutopilotAndTransponderKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'AP_MASTER') {
      this.toggleAutopilotSimVar('AUTOPILOT MASTER')
      if ((this.values.get(normalizeRuntimeVariableKey('A:AUTOPILOT MASTER')) ?? 0) > 0) {
        this.values.set(normalizeRuntimeVariableKey('A:AUTOPILOT DISENGAGED'), 0)
        this.msfsCompatibilityBridge.writeSimVar('A:AUTOPILOT DISENGAGED', 0, 'Bool')
      }
      return true
    }

    if (name === 'AUTOPILOT_ON') {
      this.setAutopilotSimVar('AUTOPILOT MASTER', 1)
      this.values.set(normalizeRuntimeVariableKey('A:AUTOPILOT DISENGAGED'), 0)
      this.msfsCompatibilityBridge.writeSimVar('A:AUTOPILOT DISENGAGED', 0, 'Bool')
      return true
    }

    if (name === 'AUTOPILOT_OFF') {
      this.setAutopilotSimVar('AUTOPILOT MASTER', 0)
      return true
    }

    if (name === 'AP_HDG_HOLD_ON') {
      this.setAutopilotSimVar('AUTOPILOT HEADING LOCK', 1)
      return true
    }

    const toggledAutopilotModes: Partial<Record<string, string>> = {
      AP_HDG_HOLD: 'AUTOPILOT HEADING LOCK',
      AP_PANEL_HEADING_HOLD: 'AUTOPILOT HEADING LOCK',
      AP_ALT_HOLD: 'AUTOPILOT ALTITUDE LOCK',
      FLIGHT_LEVEL_CHANGE: 'AUTOPILOT FLIGHT LEVEL CHANGE',
      AP_FLIGHT_LEVEL_CHANGE: 'AUTOPILOT FLIGHT LEVEL CHANGE',
      AP_PANEL_VS_HOLD: 'AUTOPILOT VERTICAL HOLD',
      AP_NAV1_HOLD: 'AUTOPILOT NAV1 LOCK',
      AP_BC_HOLD: 'AUTOPILOT BACKCOURSE HOLD',
      YAW_DAMPER_TOGGLE: 'AUTOPILOT YAW DAMPER',
      AP_WING_LEVELER: 'AUTOPILOT WING LEVELER',
      AP_PITCH_LEVELER: 'AUTOPILOT PITCH HOLD',
      AP_AIRSPEED_HOLD: 'AUTOPILOT AIRSPEED HOLD',
      AP_PANEL_SPEED_HOLD: 'AUTOPILOT AIRSPEED HOLD',
      AP_PANEL_SPEED_HOLD_TOGGLE: 'AUTOPILOT AIRSPEED HOLD',
      AP_PANEL_MACH_HOLD: 'AUTOPILOT MACH HOLD',
      AP_MANAGED_SPEED_IN_MACH_TOGGLE: 'AUTOPILOT MANAGED SPEED IN MACH',
      AUTO_THROTTLE_ARM: 'AUTOPILOT THROTTLE ARM'
    }
    const toggledMode = toggledAutopilotModes[name]
    if (toggledMode != null) {
      this.toggleAutopilotSimVar(toggledMode)
      return true
    }

    const onOffAutopilotModes: Partial<Record<string, readonly [string, number]>> = {
      AP_WING_LEVELER_ON: ['AUTOPILOT WING LEVELER', 1],
      AP_WING_LEVELER_OFF: ['AUTOPILOT WING LEVELER', 0],
      AP_PITCH_LEVELER_ON: ['AUTOPILOT PITCH HOLD', 1],
      AP_PITCH_LEVELER_OFF: ['AUTOPILOT PITCH HOLD', 0],
      AP_AIRSPEED_ON: ['AUTOPILOT AIRSPEED HOLD', 1],
      AP_AIRSPEED_OFF: ['AUTOPILOT AIRSPEED HOLD', 0],
      AP_MACH_ON: ['AUTOPILOT MACH HOLD', 1],
      AP_MACH_OFF: ['AUTOPILOT MACH HOLD', 0],
      AP_N1_HOLD: ['AUTOPILOT RPM HOLD', 1]
    }
    const onOffMode = onOffAutopilotModes[name]
    if (onOffMode != null) {
      this.setAutopilotSimVar(onOffMode[0], onOffMode[1])
      return true
    }

    if (name === 'AP_LOC_HOLD') {
      this.toggleAutopilotSimVar('AUTOPILOT APPROACH HOLD')
      this.setAutopilotSimVar('AUTOPILOT GLIDESLOPE HOLD', 0)
      return true
    }

    if (name === 'AP_APR_HOLD') {
      const active = (
        (this.values.get(normalizeRuntimeVariableKey('A:AUTOPILOT APPROACH HOLD')) ?? 0) > 0 &&
        (this.values.get(normalizeRuntimeVariableKey('A:AUTOPILOT GLIDESLOPE HOLD')) ?? 0) > 0
      )
      this.setAutopilotSimVar('AUTOPILOT APPROACH HOLD', active ? 0 : 1)
      this.setAutopilotSimVar('AUTOPILOT GLIDESLOPE HOLD', active ? 0 : 1)
      return true
    }

    if (name === 'TOGGLE_FLIGHT_DIRECTOR') {
      const maybeIndex = Math.trunc(Number(args.at(-1) ?? 1))
      const index = Number.isFinite(maybeIndex) && maybeIndex > 0 ? maybeIndex : 1
      this.toggleAutopilotSimVar('AUTOPILOT FLIGHT DIRECTOR ACTIVE', index)
      return true
    }

    if (name === 'HEADING_BUG_SET') {
      const value = normalizeDegrees(Number(args.at(-1) ?? 0))
      const maybeIndex = Math.trunc(Number(args.length > 1 ? args[0] : 1))
      const index = Number.isFinite(maybeIndex) && maybeIndex >= 0 ? maybeIndex : 1
      this.setAutopilotSimVar('AUTOPILOT HEADING LOCK DIR', value, index)
      return true
    }

    if (name === 'AP_ALT_VAR_SET_ENGLISH') {
      const value = Math.max(0, Number(args.at(-1) ?? 0))
      const maybeIndex = Math.trunc(Number(args.length > 1 ? args[0] : 1))
      const index = Number.isFinite(maybeIndex) && maybeIndex >= 0 ? maybeIndex : 1
      this.setAutopilotSimVar('AUTOPILOT ALTITUDE LOCK VAR', value, index)
      return true
    }

    if (name === 'AP_ALT_VAR_INC' || name === 'AP_ALT_VAR_DEC') {
      const maybeIndex = Math.trunc(Number(args.length > 1 ? args[0] : 1))
      const index = Number.isFinite(maybeIndex) && maybeIndex >= 0 ? maybeIndex : 1
      const key = normalizeRuntimeVariableKey(`A:AUTOPILOT ALTITUDE LOCK VAR:${index}`)
      const baseKey = normalizeRuntimeVariableKey('A:AUTOPILOT ALTITUDE LOCK VAR')
      const currentValue = this.values.get(key) ?? this.values.get(baseKey) ?? 0
      const nextValue = Math.max(0, currentValue + (name === 'AP_ALT_VAR_INC' ? 100 : -100))
      this.setAutopilotSimVar('AUTOPILOT ALTITUDE LOCK VAR', nextValue, index)
      return true
    }

    if (name === 'AP_MAX_BANK_SET') {
      const value = Math.max(0, Math.trunc(Number(args.at(-1) ?? 0)))
      this.setAutopilotSimVar('AUTOPILOT MAX BANK ID', value)
      return true
    }

    if (name === 'AP_SPD_VAR_SET') {
      const value = Math.max(0, Number(args.at(-1) ?? 0))
      const maybeIndex = Math.trunc(Number(args.length > 1 ? args[0] : 1))
      const index = Number.isFinite(maybeIndex) && maybeIndex >= 0 ? maybeIndex : 1
      this.setAutopilotSimVar('AUTOPILOT AIRSPEED HOLD VAR', value, index)
      this.setAutopilotSimVar('AUTOPILOT AIRSPEED HOLD', 1)
      return true
    }

    if (name === 'AP_MACH_VAR_SET') {
      const rawValue = Math.max(0, Number(args.at(-1) ?? 0))
      const value = rawValue > 2 ? rawValue / 100 : rawValue
      const maybeIndex = Math.trunc(Number(args.length > 1 ? args[0] : 1))
      const index = Number.isFinite(maybeIndex) && maybeIndex >= 0 ? maybeIndex : 1
      this.setAutopilotSimVar('AUTOPILOT MACH HOLD VAR', value, index)
      this.setAutopilotSimVar('AUTOPILOT MACH HOLD', 1)
      return true
    }

    if (name === 'AP_SPD_VAR_INC' || name === 'AP_SPD_VAR_DEC') {
      const key = normalizeRuntimeVariableKey('A:AUTOPILOT AIRSPEED HOLD VAR')
      const currentValue = this.values.get(key) ?? 0
      const nextValue = Math.max(0, currentValue + (name === 'AP_SPD_VAR_INC' ? 1 : -1))
      this.setAutopilotSimVar('AUTOPILOT AIRSPEED HOLD VAR', nextValue)
      this.setAutopilotSimVar('AUTOPILOT AIRSPEED HOLD', 1)
      return true
    }

    if (name === 'AP_VS_VAR_SET_ENGLISH') {
      const value = Number(args.at(-1) ?? 0)
      const maybeIndex = Math.trunc(Number(args.length > 1 ? args[0] : 1))
      const index = Number.isFinite(maybeIndex) && maybeIndex > 0 ? maybeIndex : 1
      this.setAutopilotSimVar('AUTOPILOT VERTICAL HOLD VAR', value, index)
      this.setAutopilotSimVar('AUTOPILOT VERTICAL HOLD', 1, index)
      return true
    }

    if (name === 'AP_VS_VAR_INC' || name === 'AP_VS_VAR_DEC') {
      const index = 1
      const key = normalizeRuntimeVariableKey(`A:AUTOPILOT VERTICAL HOLD VAR:${index}`)
      const baseKey = normalizeRuntimeVariableKey('A:AUTOPILOT VERTICAL HOLD VAR')
      const currentValue = this.values.get(key) ?? this.values.get(baseKey) ?? 0
      const nextValue = currentValue + (name === 'AP_VS_VAR_INC' ? 100 : -100)
      this.setAutopilotSimVar('AUTOPILOT VERTICAL HOLD VAR', nextValue, index)
      this.setAutopilotSimVar('AUTOPILOT VERTICAL HOLD', 1)
      return true
    }

    if (name === 'AP_PITCH_REF_SET') {
      const rawValue = Number(args.at(-1) ?? 0)
      const value = clamp(rawValue / 16_384, -1, 1) * 15
      this.setAutopilotSimVar('AUTOPILOT PITCH HOLD REF', value)
      this.setAutopilotSimVar('AUTOPILOT PITCH HOLD', 1)
      return true
    }

    if (name === 'AP_PITCH_REF_INC_UP' || name === 'AP_PITCH_REF_INC_DN') {
      const key = normalizeRuntimeVariableKey('A:AUTOPILOT PITCH HOLD REF')
      const currentValue = this.values.get(key) ?? 0
      const nextValue = clamp(currentValue + (name === 'AP_PITCH_REF_INC_UP' ? 1 : -1), -15, 15)
      this.setAutopilotSimVar('AUTOPILOT PITCH HOLD REF', nextValue)
      this.setAutopilotSimVar('AUTOPILOT PITCH HOLD', 1)
      return true
    }

    if (name === 'XPNDR_IDENT_ON') {
      this.values.set(normalizeRuntimeVariableKey('A:TRANSPONDER IDENT'), 1)
      this.values.set(normalizeRuntimeVariableKey('A:TRANSPONDER IDENT:1'), 1)
      this.msfsCompatibilityBridge.writeSimVar('A:TRANSPONDER IDENT', 1, 'Bool')
      this.msfsCompatibilityBridge.writeSimVar('A:TRANSPONDER IDENT:1', 1, 'Bool')
      return true
    }

    if (name === 'BAROMETRIC' || name === 'BAROMETRIC_STD_PRESSURE') {
      const maybeIndex = Math.trunc(Number(args[0] ?? 1))
      const index = Number.isFinite(maybeIndex) && maybeIndex > 0 ? maybeIndex : 1
      this.setKohlsmanHg(index, 29.92)
      this.simulatorEngine.dispatch({
        type: AvionicsCommandTypes.setBarometer,
        payload: {
          index,
          settingHg: 29.92,
          standardMode: name === 'BAROMETRIC_STD_PRESSURE',
        },
      })
      this.values.set(normalizeRuntimeVariableKey(`L:XMLVAR_Baro${index}_Mode`), name === 'BAROMETRIC_STD_PRESSURE' ? 1 : 0)
      return true
    }

    const kohlsmanMatch = /^KOHLSMAN_(INC|DEC|SET)$/u.exec(name)
    if (kohlsmanMatch != null) {
      const maybeIndex = Math.trunc(Number(args[0] ?? Number.NaN))
      const index = Number.isFinite(maybeIndex) && args.length > 1 ? maybeIndex : 1
      const key = normalizeRuntimeVariableKey(`A:KOHLSMAN SETTING HG:${index}`)
      const currentValue = this.values.get(key) ?? this.values.get(normalizeRuntimeVariableKey('A:KOHLSMAN SETTING HG')) ?? 29.92
      const rawSetValue = Number(args.at(-1) ?? Number.NaN)
      const nextValue = kohlsmanMatch[1] === 'SET'
        ? normalizeKohlsmanHg(rawSetValue)
        : currentValue + (kohlsmanMatch[1] === 'INC' ? 0.01 : -0.01)
      this.setKohlsmanHg(index, nextValue)
      return true
    }

    return false
  }

  private setKohlsmanHg(index: number, value: number): void {
    const normalizedValue = normalizeKohlsmanHg(value)
    const kohlsmanIndex = Math.max(1, Math.trunc(index))
    this.simulatorEngine.dispatch({
      type: AvionicsCommandTypes.setBarometer,
      payload: {
        index: kohlsmanIndex,
        settingHg: normalizedValue,
      },
    })
    this.values.set(normalizeRuntimeVariableKey(`A:KOHLSMAN SETTING HG:${kohlsmanIndex}`), normalizedValue)
    this.values.set(normalizeRuntimeVariableKey('A:KOHLSMAN SETTING HG'), normalizedValue)
    this.values.set(normalizeRuntimeVariableKey(`A:KOHLSMAN SETTING MB:${kohlsmanIndex}`), normalizedValue * 33.863_886_666_7)
    this.values.set(normalizeRuntimeVariableKey('A:KOHLSMAN SETTING MB'), normalizedValue * 33.863_886_666_7)
  }

  private adjustRadioStandbyFrequency(family: string, index: number, deltaMhz: number): void {
    const radioIndex = Math.max(1, Math.trunc(index))
    const normalizedFamily = family === 'NAV' ? 'NAV' : 'COM'
    const key = normalizeRuntimeVariableKey(`A:${normalizedFamily} STANDBY FREQUENCY:${radioIndex}`)
    const defaultValue = normalizedFamily === 'NAV' ? 108 : 118
    const currentValue = this.values.get(key) ?? defaultValue
    const minValue = normalizedFamily === 'NAV' ? 108 : 118
    const maxValue = normalizedFamily === 'NAV' ? 117.95 : 136.975
    this.setRadioFrequency(normalizedFamily, radioIndex, 'STANDBY', clamp(currentValue + deltaMhz, minValue, maxValue))
  }

  private swapRadioFrequencies(family: string, index: number): void {
    const radioIndex = Math.max(1, Math.trunc(index))
    const normalizedFamily = family === 'NAV' ? 'NAV' : 'COM'
    const activeKey = normalizeRuntimeVariableKey(`A:${normalizedFamily} ACTIVE FREQUENCY:${radioIndex}`)
    const standbyKey = normalizeRuntimeVariableKey(`A:${normalizedFamily} STANDBY FREQUENCY:${radioIndex}`)
    const defaultActive = normalizedFamily === 'NAV' ? 108 : 118
    const defaultStandby = normalizedFamily === 'NAV' ? 110 : 120
    const activeValue = this.values.get(activeKey) ?? defaultActive
    const standbyValue = this.values.get(standbyKey) ?? defaultStandby
    this.setRadioFrequency(normalizedFamily, radioIndex, 'ACTIVE', standbyValue)
    this.setRadioFrequency(normalizedFamily, radioIndex, 'STANDBY', activeValue)
  }

  private setRadioFrequency(family: string, index: number, slot: 'ACTIVE' | 'STANDBY', valueMhz: number): void {
    const radioIndex = Math.max(1, Math.trunc(index))
    const normalizedFamily = family === 'NAV' ? 'NAV' : 'COM'
    const normalizedValue = Math.round(valueMhz * 1000) / 1000
    this.values.set(normalizeRuntimeVariableKey(`A:${normalizedFamily} ${slot} FREQUENCY:${radioIndex}`), normalizedValue)
    this.values.set(normalizeRuntimeVariableKey(`A:${normalizedFamily} ${slot} FREQUENCY:${radioIndex} HZ`), normalizedValue * 1_000_000)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:${normalizedFamily} ${slot} FREQUENCY:${radioIndex}`,
      normalizedValue,
      'number'
    )
    this.msfsCompatibilityBridge.writeSimVar(
      `A:${normalizedFamily} ${slot} FREQUENCY:${radioIndex} HZ`,
      normalizedValue * 1_000_000,
      'number'
    )
  }

  private adjustAdfStandbyFrequency(deltaKhz: number): void {
    const key = normalizeRuntimeVariableKey('A:ADF STANDBY FREQUENCY:1')
    const currentValue = this.values.get(key) ?? 300
    const nextValue = clamp(currentValue + deltaKhz, 100, 1_799)
    this.values.set(key, nextValue)
    this.values.set(normalizeRuntimeVariableKey('A:ADF STANDBY FREQUENCY'), nextValue)
    this.msfsCompatibilityBridge.writeSimVar(
      'A:ADF STANDBY FREQUENCY:1',
      nextValue,
      'number'
    )
  }

  private setTransponderState(index: number, value: number): void {
    const transponderIndex = Math.max(1, Math.trunc(index))
    const normalizedValue = Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0))
    this.values.set(normalizeRuntimeVariableKey(`A:TRANSPONDER STATE:${transponderIndex}`), normalizedValue)
    this.values.set(normalizeRuntimeVariableKey('A:TRANSPONDER STATE'), normalizedValue)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:TRANSPONDER STATE:${transponderIndex}`,
      normalizedValue,
      'number'
    )
    this.msfsCompatibilityBridge.writeSimVar('A:TRANSPONDER STATE', normalizedValue, 'number')
  }

  private setAutopilotSimVar(simVarName: string, value: number, index?: number): void {
    const normalizedValue = Number.isFinite(value) ? value : 0
    const baseKey = normalizeRuntimeVariableKey(`A:${simVarName}`)
    this.values.set(baseKey, normalizedValue)
    this.msfsCompatibilityBridge.writeSimVar(baseKey, normalizedValue, null)
    if (index != null && Number.isFinite(index)) {
      const indexedKey = normalizeRuntimeVariableKey(`A:${simVarName}:${Math.trunc(index)}`)
      this.values.set(indexedKey, normalizedValue)
      this.msfsCompatibilityBridge.writeSimVar(indexedKey, normalizedValue, null)
    }
  }

  private toggleAutopilotSimVar(simVarName: string, index?: number): void {
    const key = normalizeRuntimeVariableKey(index != null && Number.isFinite(index)
      ? `A:${simVarName}:${Math.trunc(index)}`
      : `A:${simVarName}`)
    const currentValue = this.values.get(key) ?? this.values.get(normalizeRuntimeVariableKey(`A:${simVarName}`)) ?? 0
    this.setAutopilotSimVar(simVarName, currentValue > 0 ? 0 : 1, index)
  }

  private setEngineAntiIcePosition(index: number, percent: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const engineIndex = Math.trunc(index)
    const clampedPercent = clamp(percent, 0, 100)
    const enabled = clampedPercent > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:ENG ANTI ICE:${engineIndex}`), enabled)
    this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG ANTI ICE POSITION:${engineIndex}`), clampedPercent)
    this.values.set(normalizeRuntimeVariableKey(`A:RECIP ENG ALTERNATE AIR POSITION:${engineIndex}`), clampedPercent)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:ENG ANTI ICE:${engineIndex}`,
      enabled,
      'Bool'
    )
  }

  private setRudderTrim(value: number): void {
    const trim = clamp(value, -1, 1)
    this.values.set(normalizeRuntimeVariableKey('A:RUDDER TRIM PCT'), trim)
    this.values.set(normalizeRuntimeVariableKey('A:RUDDER TRIM'), trim * 100)
    this.msfsCompatibilityBridge.writeSimVar('A:RUDDER TRIM PCT', trim, 'ratio')
    this.msfsCompatibilityBridge.writeSimVar('A:RUDDER TRIM', trim * 100, 'percent')
  }

  private setAileronTrim(value: number): void {
    const trim = clamp(value, -1, 1)
    this.values.set(normalizeRuntimeVariableKey('A:AILERON TRIM PCT'), trim)
    this.values.set(normalizeRuntimeVariableKey('A:AILERON TRIM'), trim * 100)
    this.msfsCompatibilityBridge.writeSimVar('A:AILERON TRIM PCT', trim, 'ratio')
    this.msfsCompatibilityBridge.writeSimVar('A:AILERON TRIM', trim * 100, 'percent')
  }

  private setElevatorTrim(value: number): void {
    const trim = clamp(value, -1, 1)
    this.values.set(normalizeRuntimeVariableKey('A:ELEVATOR TRIM PCT'), trim)
    this.values.set(normalizeRuntimeVariableKey('A:ELEVATOR TRIM POSITION'), trim)
    this.values.set(normalizeRuntimeVariableKey('A:ELEVATOR TRIM INDICATOR'), trim * 100)
    this.msfsCompatibilityBridge.writeSimVar('A:ELEVATOR TRIM PCT', trim, 'ratio')
    this.msfsCompatibilityBridge.writeSimVar('A:ELEVATOR TRIM', trim * 100, 'percent')
  }

  private setBrakePosition(side: 'LEFT' | 'RIGHT', percent: number): void {
    const clampedPercent = clamp(percent, 0, 100)
    this.values.set(normalizeRuntimeVariableKey(`A:BRAKE ${side} POSITION`), clampedPercent)
  }

  private setCourseDegrees(key: string, value: number): void {
    const normalizedValue = normalizeDegrees(Number.isFinite(value) ? value : 0)
    this.values.set(normalizeRuntimeVariableKey(key), normalizedValue)
  }

  private updateSimVarSounds(): void {
    for (const sound of this.simVarSounds) {
      const active =
        isSoundVariableInRanges(sound.variable, sound.ranges, this.values) &&
        sound.requires.every(requirement =>
          isSoundVariableInRanges(requirement.variable, requirement.ranges, this.values)
        )
      const wasActive = this.soundStates.get(sound.id) ?? false
      if (active === wasActive) {
        continue
      }

      this.soundStates.set(sound.id, active)
      if (active) {
        this.recordSoundEvent(sound.eventName, {
          phase: 'start',
          target: sound.nodeName ?? sound.variable.name,
          normalizedTime: null,
          sourcePath: sound.sourcePath,
          sourceParameter: formatSoundVariableKey(sound.variable)
        })
      } else if (sound.continuous) {
        this.recordSoundEvent(sound.eventName, {
          phase: 'stop',
          target: sound.nodeName ?? sound.variable.name,
          normalizedTime: null,
          sourcePath: sound.sourcePath,
          sourceParameter: formatSoundVariableKey(sound.variable)
        })
      }
    }
  }

  private toggleNamedBoolVariables(...keys: readonly string[]): void {
    const normalizedKeys = keys.map(key => normalizeRuntimeVariableKey(key))
    const nextValue = (this.values.get(normalizedKeys[0] ?? '') ?? 0) > 0 ? 0 : 1
    for (const key of normalizedKeys) {
      this.values.set(key, nextValue)
      this.writeEngineCompatibilityVariable(key, nextValue, null)
    }
  }

  private toggleAllLights(): void {
    this.toggleNamedBoolVariables(
      'A:LIGHT BEACON',
      'A:LIGHT CABIN',
      'A:LIGHT GLARESHIELD',
      'A:LIGHT LANDING',
      'A:LIGHT LOGO',
      'A:LIGHT NAV',
      'A:LIGHT PANEL',
      'A:LIGHT RECOGNITION',
      'A:LIGHT STROBE',
      'A:LIGHT TAXI',
      'A:LIGHT WING'
    )
  }

  private setLightPotentiometer(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const clampedValue = clamp(value, 0, 100)
    const key = normalizeRuntimeVariableKey(`A:LIGHT POTENTIOMETER:${Math.trunc(index)}`)
    this.values.set(key, clampedValue)
    this.writeEngineCompatibilityVariable(key, clampedValue, 'percent')
  }

  private stepLightPotentiometer(index: number, delta: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const key = normalizeRuntimeVariableKey(`A:LIGHT POTENTIOMETER:${Math.trunc(index)}`)
    const currentValue = this.values.get(key) ?? 0
    this.setLightPotentiometer(index, currentValue + delta)
  }

  private setLightPowerSetting(type: string, index: number, value: number): void {
    const clampedValue = clamp(value, 0, 100)
    const powerSettingType = getLightPowerSettingType(type)
    const unindexedKey = normalizeRuntimeVariableKey(`A:LIGHT ${powerSettingType} POWER SETTING`)
    this.values.set(unindexedKey, clampedValue)
    this.writeEngineCompatibilityVariable(unindexedKey, clampedValue, 'percent')
    if (Number.isFinite(index)) {
      const indexedKey = normalizeRuntimeVariableKey(`A:LIGHT ${powerSettingType} POWER SETTING:${Math.trunc(index)}`)
      this.values.set(indexedKey, clampedValue)
      this.writeEngineCompatibilityVariable(indexedKey, clampedValue, 'percent')
    }
  }

  private setLightSwitch(type: string, value: number, index?: number): void {
    const normalizedValue = value > 0 ? 1 : 0
    const unindexedKey = getLightSwitchVariableKey(type)
    this.values.set(unindexedKey, normalizedValue)
    this.writeEngineCompatibilityVariable(unindexedKey, normalizedValue, null)
    if (index != null && Number.isFinite(index)) {
      const indexedKey = getLightSwitchVariableKey(type, Math.trunc(index))
      this.values.set(indexedKey, normalizedValue)
      this.writeEngineCompatibilityVariable(indexedKey, normalizedValue, null)
    }
  }

  private toggleLightSwitch(type: string, index?: number): void {
    const unindexedKey = getLightSwitchVariableKey(type)
    const indexedKey = index != null && Number.isFinite(index)
      ? getLightSwitchVariableKey(type, Math.trunc(index))
      : null
    const currentValue = indexedKey == null
      ? this.values.get(unindexedKey) ?? 0
      : this.values.get(indexedKey) ?? this.values.get(unindexedKey) ?? 0
    this.setLightSwitch(type, currentValue > 0 ? 0 : 1, index)
  }

  private applyFuelSystemKeyEvent(name: string, args: readonly number[]): boolean {
    const pumpMatch = /^FUELSYSTEM_PUMP_(TOGGLE|ON|OFF|SET)$/u.exec(name)
    if (pumpMatch != null) {
      const { index: pumpIndex, value: pumpValue } = pumpMatch[1] === 'SET'
        ? getFlexibleIndexedSetEventArgs(args, 1)
        : { index: Math.trunc(Number(args[0] ?? 1)), value: Number(args[0] ?? 0) }
      if (Number.isFinite(pumpIndex)) {
        const pumpKey = normalizeRuntimeVariableKey(`A:FUELSYSTEM PUMP SWITCH:${pumpIndex}`)
        const nextValue = pumpMatch[1] === 'TOGGLE'
          ? (this.values.get(pumpKey) ?? 0) > 0 ? 0 : 1
          : pumpMatch[1] === 'SET'
            ? pumpValue > 0 ? 1 : 0
            : pumpMatch[1] === 'ON' ? 1 : 0
        this.setFuelPumpState(pumpIndex, nextValue)
      }
      return true
    }

    const legacyPumpToggleMatch = /^TOGGLE_ELECT_FUEL_PUMP(\d*)$/u.exec(name)
    if (legacyPumpToggleMatch != null) {
      const explicitIndex = legacyPumpToggleMatch[1] === '' ? Number.NaN : Number.parseInt(legacyPumpToggleMatch[1], 10)
      const pumpIndex = Number.isFinite(explicitIndex) ? explicitIndex : Math.trunc(Number(args[0] ?? 1))
      if (Number.isFinite(pumpIndex)) {
        const pumpKey = normalizeRuntimeVariableKey(`A:GENERAL ENG FUEL PUMP SWITCH EX1:${pumpIndex}`)
        const nextValue = (this.values.get(pumpKey) ?? 0) > 0 ? 0 : 1
        this.setLegacyFuelPumpState(pumpIndex, nextValue)
      }
      return true
    }

    const legacyPumpSetMatch = /^ELECT_FUEL_PUMP(\d+)_SET$/u.exec(name)
    if (legacyPumpSetMatch != null) {
      const pumpIndex = Number.parseInt(legacyPumpSetMatch[1], 10)
      this.setLegacyFuelPumpState(pumpIndex, Number(args.at(-1) ?? 0) > 0 ? 1 : 0)
      return true
    }

    const engineFuelValveSetMatch = /^SET_FUEL_VALVE_ENG(\d+)$/u.exec(name)
    if (engineFuelValveSetMatch != null) {
      const engineIndex = Number.parseInt(engineFuelValveSetMatch[1], 10)
      this.setEngineFuelValveState(engineIndex, Number(args.at(-1) ?? 0))
      return true
    }

    const engineFuelValveToggleMatch = /^TOGGLE_FUEL_VALVE_ENG(\d+)$/u.exec(name)
    if (engineFuelValveToggleMatch != null) {
      const engineIndex = Number.parseInt(engineFuelValveToggleMatch[1], 10)
      const valveKey = normalizeRuntimeVariableKey(`A:GENERAL ENG FUEL VALVE:${engineIndex}`)
      this.setEngineFuelValveState(engineIndex, (this.values.get(valveKey) ?? 0) > 0 ? 0 : 1)
      return true
    }

    const valveMatch = /^FUELSYSTEM_VALVE_(TOGGLE|OPEN|CLOSE|SET)$/u.exec(name)
    if (valveMatch != null) {
      const { index: valveIndex, value: valveValue } = valveMatch[1] === 'SET'
        ? getFlexibleIndexedSetEventArgs(args, 1)
        : { index: Math.trunc(Number(args[0] ?? 1)), value: Number(args[0] ?? 0) }
      if (Number.isFinite(valveIndex)) {
        const valveKey = normalizeRuntimeVariableKey(`A:FUELSYSTEM VALVE OPEN:${valveIndex}`)
        const nextValue =
          valveMatch[1] === 'TOGGLE'
            ? (this.values.get(valveKey) ?? 0) > 0 ? 0 : 1
            : valveMatch[1] === 'SET'
              ? valveValue > 0 ? 1 : 0
              : valveMatch[1] === 'OPEN' ? 1 : 0
        this.setFuelValveState(valveIndex, nextValue)
      }
      return true
    }

    if (name === 'FUELSYSTEM_JUNCTION_SET') {
      const setting = Number(args[0] ?? Number.NaN)
    const junctionIndex = Math.trunc(Number(args[1] ?? Number.NaN))
    if (Number.isFinite(setting) && Number.isFinite(junctionIndex)) {
      this.values.set(normalizeRuntimeVariableKey(`A:FUELSYSTEM JUNCTION SETTING:${junctionIndex}`), setting)
      this.msfsCompatibilityBridge.writeSimVar(
        `A:FUELSYSTEM JUNCTION SETTING:${junctionIndex}`,
        setting,
        'number'
      )
    }
      return true
    }

    if (name === 'SET_FUEL_TRANSFER_CUSTOM') {
      this.values.set(normalizeRuntimeVariableKey('A:FUEL SELECTED TRANSFER MODE'), 5)
      return true
    }

    if (name === 'FUEL_TRANSFER_CUSTOM_INDEX_TOGGLE') {
      const transferIndex = Math.trunc(Number(args[0] ?? 1))
      if (Number.isFinite(transferIndex)) {
        const key = normalizeRuntimeVariableKey(`A:FUEL TRANSFER PUMP ON:${transferIndex}`)
        const nextValue = (this.values.get(key) ?? 0) > 0 ? 0 : 1
        this.values.set(key, nextValue)
        this.values.set(normalizeRuntimeVariableKey(`A:FUEL TRANSFER PUMP SWITCH:${transferIndex}`), nextValue)
      }
      return true
    }

    if (name === 'FUELSYSTEM_TRIGGER_TOGGLE') {
      const triggerIndex = Math.trunc(Number(args[0] ?? 1))
      if (Number.isFinite(triggerIndex)) {
        const key = normalizeRuntimeVariableKey(`A:FUELSYSTEM TRIGGER STATUS:${triggerIndex}`)
        this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
      }
      return true
    }

    const selectorSetMatch = /^FUEL_SELECTOR(?:_(\d+))?_SET$/u.exec(name)
    if (selectorSetMatch != null) {
      const selectorIndex = selectorSetMatch[1] == null ? 1 : Number.parseInt(selectorSetMatch[1], 10)
      const setting = Number(args.at(-1) ?? Number.NaN)
      if (Number.isFinite(selectorIndex) && Number.isFinite(setting)) {
        this.values.set(normalizeRuntimeVariableKey(`A:FUEL TANK SELECTOR:${selectorIndex}`), setting)
      }
      return true
    }

    return false
  }

  private applyElectricalInputKeyEvent(name: string, args: readonly number[]): boolean {
    const batterySetMatch = /^BATTERY(\d+)_SET$/u.exec(name)
    if (batterySetMatch != null) {
      this.setIndexedBatterySwitch(Number.parseInt(batterySetMatch[1], 10), Number(args.at(-1) ?? 0))
      return true
    }

    if (name === 'MASTER_BATTERY_SET') {
      const { index, value } = getFlexibleIndexedSetEventArgs(args, 0)
      if (index === 0) {
        this.setBatterySwitch(value)
      } else {
        this.setIndexedBatterySwitch(index, value)
      }
      return true
    }

    if (name === 'SET_EXTERNAL_POWER') {
      const { index, value } = getFlexibleIndexedSetEventArgs(args, 0)
      this.setIndexedExternalPowerSwitch(index, value)
      return true
    }

    if (name === 'TOGGLE_EXTERNAL_POWER') {
      const index = Math.trunc(Number(args[0] ?? 0))
      this.toggleIndexedExternalPowerSwitch(index)
      return true
    }

    if (name === 'APU_GENERATOR_SWITCH_SET') {
      const index = Math.trunc(Number(args[0] ?? 1))
      const value = Number(args[1] ?? args[0] ?? 0)
      this.setApuGeneratorSwitch(index, value)
      return true
    }

    if (name === 'KEY_APU_GENERATOR_SWITCH_TOGGLE' || name === 'APU_GENERATOR_SWITCH_TOGGLE') {
      const index = Math.trunc(Number(args[0] ?? 1))
      if (Number.isFinite(index)) {
        const key = normalizeRuntimeVariableKey(`A:APU GENERATOR SWITCH:${index}`)
        this.setApuGeneratorSwitch(index, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
      }
      return true
    }

    if (name === 'STARTER_SET' || name === 'SET_STARTER_ALL_HELD') {
      const value = Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      for (let index = 1; index <= 4; index += 1) {
        this.setEngineStarter(index, value)
      }
      return true
    }

    if (name === 'TOGGLE_ALL_STARTERS') {
      const anyActive = [1, 2, 3, 4].some(index =>
        (this.values.get(normalizeRuntimeVariableKey(`A:GENERAL ENG STARTER:${index}`)) ?? 0) > 0
      )
      for (let index = 1; index <= 4; index += 1) {
        this.setEngineStarter(index, anyActive ? 0 : 1)
      }
      return true
    }

    if (name === 'ALTERNATOR_SET') {
      const { index, value } = getFlexibleIndexedSetEventArgs(args, 1)
      this.setAlternatorSwitch(index, value)
      return true
    }

    const alternatorOnOffMatch = /^(?:MASTER_)?ALTERNATOR_(ON|OFF)$/u.exec(name)
    if (alternatorOnOffMatch != null) {
      const index = Math.trunc(Number(args[0] ?? 1))
      this.setAlternatorSwitch(index, alternatorOnOffMatch[1] === 'ON' ? 1 : 0)
      return true
    }

    if (name === 'TOGGLE_MASTER_ALTERNATOR' || name === 'TOGGLE_ALTERNATOR') {
      const index = Math.trunc(Number(args[0] ?? 1))
      this.toggleAlternatorSwitch(index)
      return true
    }

    const indexedAlternatorToggleMatch = /^TOGGLE_ALTERNATOR(\d+)$/u.exec(name)
    if (indexedAlternatorToggleMatch != null) {
      this.toggleAlternatorSwitch(Number.parseInt(indexedAlternatorToggleMatch[1], 10))
      return true
    }

    if (name === 'ELECTRICAL_CIRCUIT_BREAKER_TOGGLE') {
      const circuitIndex = Math.trunc(Number(args[0] ?? Number.NaN))
      const busIndex = Math.trunc(Number(args[1] ?? Number.NaN))
      this.toggleCircuitBreaker(circuitIndex, busIndex)
      return true
    }

    const namedBreakerToggleMatch = /^BREAKER_(.+)_TOGGLE$/u.exec(name)
    if (namedBreakerToggleMatch != null) {
      this.toggleNamedBreaker(namedBreakerToggleMatch[1])
      return true
    }

    if (name === 'ELECTRICAL_EXECUTE_PROCEDURE') {
      const procedureState = Number(args[0] ?? 0)
      const procedureIndex = Math.trunc(Number(args[1] ?? Number.NaN))
      if (Number.isFinite(procedureIndex)) {
        this.values.set(
          normalizeRuntimeVariableKey(`A:ELECTRICAL PROCEDURE ACTIVE:${procedureIndex}`),
          procedureState > 0 ? 1 : 0
        )
      }
      return true
    }

    return false
  }

  private applyProcedureKeyEvent(name: string): boolean {
    if (name === 'ENGINE_AUTO_START' || name === 'ENGINE_AUTO_SHUTDOWN') {
      const running = name === 'ENGINE_AUTO_START'
      for (let index = 1; index <= 4; index += 1) {
        this.setEngineRunning(index, running)
      }
      return true
    }

    if (name === 'ALL_LIGHTS_TOGGLE') {
      this.toggleAllLights()
      return true
    }

    return false
  }

  private setEngineRunning(index: number, running: boolean): void {
    if (!Number.isFinite(index)) {
      return
    }
    const engineIndex = Math.trunc(index)
    const combustionValue = running ? 1 : 0
    const rpmValue = running ? 20 : 0
    this.engineCycleTarget = running ? Math.max(this.engineCycleTarget, rpmValue) : 0
    this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG COMBUSTION:${engineIndex}`), combustionValue)
    this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG RPM:${engineIndex}`), rpmValue)
    this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG N1:${engineIndex}`), rpmValue)
    this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG CORRECTED N1:${engineIndex}`), rpmValue)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:GENERAL ENG COMBUSTION:${engineIndex}`,
      combustionValue,
      'Bool'
    )
    this.msfsCompatibilityBridge.writeSimVar(
      `A:GENERAL ENG RPM:${engineIndex}`,
      rpmValue,
      'number'
    )
    this.msfsCompatibilityBridge.writeSimVar(
      `A:TURB ENG N1:${engineIndex}`,
      rpmValue,
      'percent'
    )
    this.simulatorEngine.dispatch({
      type: PropulsionCommandTypes.setEngineRunning,
      payload: { index: engineIndex, enabled: running },
      source: 'msfs-key-event',
    })
    this.simulatorEngine.dispatch({
      type: PropulsionCommandTypes.setEngineN1,
      payload: { index: engineIndex, value: rpmValue },
      source: 'msfs-key-event',
    })
    this.simulatorEngine.dispatch({
      type: PropulsionCommandTypes.setEngineRpm,
      payload: { index: engineIndex, value: rpmValue },
      source: 'msfs-key-event',
    })
    this.setEngineStarter(engineIndex, 0)
  }

  private setIndexedBatterySwitch(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const batteryIndex = Math.trunc(index)
    const switchValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:ELECTRICAL MASTER BATTERY:${batteryIndex}`), switchValue)
    this.values.set(normalizeRuntimeVariableKey(`A:MASTER BATTERY SWITCH:${batteryIndex}`), switchValue)
    this.values.set(normalizeRuntimeVariableKey(`A:BATTERY SWITCH:${batteryIndex}`), switchValue)
    this.simulatorEngine.dispatch({
      type: ElectricalCommandTypes.setBattery,
      payload: { index: batteryIndex, enabled: switchValue > 0 },
      source: 'msfs-key-event',
    })
    if (batteryIndex === 0 || batteryIndex === 1) {
      this.setBatterySwitch(switchValue)
    }
  }

  private setIndexedExternalPowerSwitch(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const externalPowerIndex = Math.trunc(index)
    const switchValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:EXTERNAL POWER ON:${externalPowerIndex}`), switchValue)
    this.simulatorEngine.dispatch({
      type: ElectricalCommandTypes.setSourceConnected,
      payload: { id: 'external', connected: switchValue > 0 },
      source: 'msfs-key-event',
    })
    if (externalPowerIndex === 0 || externalPowerIndex === 1) {
      this.setExternalPowerSwitch(switchValue)
    }
  }

  private toggleIndexedExternalPowerSwitch(index: number): void {
    const externalPowerIndex = Number.isFinite(index) ? Math.trunc(index) : 0
    const key = normalizeRuntimeVariableKey(`A:EXTERNAL POWER ON:${externalPowerIndex}`)
    const currentValue = this.values.get(key) ?? this.electricalState.externalPowerSwitch
    this.setIndexedExternalPowerSwitch(externalPowerIndex, currentValue > 0 ? 0 : 1)
  }

  private setApuGeneratorSwitch(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const generatorIndex = Math.trunc(index)
    const switchValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:APU GENERATOR SWITCH:${generatorIndex}`), switchValue)
    this.simulatorEngine.dispatch({
      type: ElectricalCommandTypes.setSourceConnected,
      payload: { id: 'external', connected: switchValue > 0 },
      source: 'msfs-key-event',
    })
  }

  private setAlternatorSwitch(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const alternatorIndex = Math.trunc(index)
    const switchValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG MASTER ALTERNATOR:${alternatorIndex}`), switchValue)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:GENERAL ENG MASTER ALTERNATOR:${alternatorIndex}`,
      switchValue,
      'Bool'
    )
    this.simulatorEngine.dispatch({
      type: PropulsionCommandTypes.setEngineAlternator,
      payload: { index: alternatorIndex, enabled: switchValue > 0 },
      source: 'msfs-key-event',
    })
    this.simulatorEngine.dispatch({
      type: ElectricalCommandTypes.setSourceConnected,
      payload: {
        id: `engine-${alternatorIndex}-generator`,
        connected: switchValue > 0,
      },
      source: 'msfs-key-event',
    })
    if (alternatorIndex === 1) {
      this.values.set(normalizeRuntimeVariableKey('A:GENERAL ENG MASTER ALTERNATOR'), switchValue)
    }
  }

  private toggleAlternatorSwitch(index: number): void {
    const alternatorIndex = Number.isFinite(index) ? Math.trunc(index) : 1
    const alternatorKey = normalizeRuntimeVariableKey(`A:GENERAL ENG MASTER ALTERNATOR:${alternatorIndex}`)
    this.setAlternatorSwitch(alternatorIndex, (this.values.get(alternatorKey) ?? 0) > 0 ? 0 : 1)
  }

  private setFuelPumpState(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const pumpIndex = Math.trunc(index)
    const nextValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:FUELSYSTEM PUMP SWITCH:${pumpIndex}`), nextValue)
    this.values.set(normalizeRuntimeVariableKey(`A:FUELSYSTEM PUMP ACTIVE:${pumpIndex}`), nextValue)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:FUELSYSTEM PUMP SWITCH:${pumpIndex}`,
      nextValue,
      'Bool'
    )
    this.msfsCompatibilityBridge.writeSimVar(
      `A:FUELSYSTEM PUMP ACTIVE:${pumpIndex}`,
      nextValue,
      'Bool'
    )
    this.simulatorEngine.dispatch({
      type: FuelCommandTypes.setPumpSwitch,
      payload: { index: pumpIndex, enabled: nextValue > 0 },
      source: 'msfs-key-event',
    })
  }

  private setLegacyFuelPumpState(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const pumpIndex = Math.trunc(index)
    const nextValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG FUEL PUMP SWITCH EX1:${pumpIndex}`), nextValue)
    this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG FUEL PUMP ACTIVE:${pumpIndex}`), nextValue)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:GENERAL ENG FUEL PUMP SWITCH EX1:${pumpIndex}`,
      nextValue,
      'Bool'
    )
    this.msfsCompatibilityBridge.writeSimVar(
      `A:GENERAL ENG FUEL PUMP ACTIVE:${pumpIndex}`,
      nextValue,
      'Bool'
    )
    this.simulatorEngine.dispatch({
      type: FuelCommandTypes.setPumpSwitch,
      payload: { index: pumpIndex, enabled: nextValue > 0 },
      source: 'msfs-key-event',
    })
  }

  private setEngineFuelValveState(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const engineIndex = Math.trunc(index)
    const nextValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG FUEL VALVE:${engineIndex}`), nextValue)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:GENERAL ENG FUEL VALVE:${engineIndex}`,
      nextValue,
      'Bool'
    )
    this.simulatorEngine.dispatch({
      type: PropulsionCommandTypes.setEngineFuelValve,
      payload: { index: engineIndex, enabled: nextValue > 0 },
      source: 'msfs-key-event',
    })
    this.values.set(normalizeRuntimeVariableKey(`L:ENG FUEL VALVE:${engineIndex}`), nextValue)
  }

  private setFuelValveState(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const valveIndex = Math.trunc(index)
    const nextValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:FUELSYSTEM VALVE OPEN:${valveIndex}`), nextValue)
    this.values.set(normalizeRuntimeVariableKey(`A:FUELSYSTEM VALVE SWITCH:${valveIndex}`), nextValue)
    this.msfsCompatibilityBridge.writeSimVar(
      `A:FUELSYSTEM VALVE OPEN:${valveIndex}`,
      nextValue,
      'Bool'
    )
    this.msfsCompatibilityBridge.writeSimVar(
      `A:FUELSYSTEM VALVE SWITCH:${valveIndex}`,
      nextValue,
      'Bool'
    )
    this.simulatorEngine.dispatch({
      type: FuelCommandTypes.setValveSwitch,
      payload: { index: valveIndex, open: nextValue > 0 },
      source: 'msfs-key-event',
    })
    this.applyTurbineFuelValveSideEffects(valveIndex, nextValue)
  }

  private applyTurbineFuelValveSideEffects(engineIndex: number, value: number): void {
    if (!Number.isFinite(engineIndex)) {
      return
    }
    const index = Math.trunc(engineIndex)
    const nextValue = value > 0 ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG FUEL VALVE:${index}`), nextValue)
    this.values.set(normalizeRuntimeVariableKey(`L:ENG FUEL VALVE:${index}`), nextValue)
    if (nextValue <= 0) {
      this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG STARTER:${index}`), 0)
      this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG COMBUSTION:${index}`), 0)
      this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG RPM:${index}`), 0)
      this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG N1:${index}`), 0)
      this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG CORRECTED N1:${index}`), 0)
      this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG N2:${index}`), 0)
      return
    }
    const ignitionMode =
      this.values.get(normalizeRuntimeVariableKey(`A:TURB ENG IGNITION SWITCH EX1:${index}`)) ??
      this.values.get(normalizeRuntimeVariableKey(`A:TURBINE IGNITION SWITCH:${index}`)) ??
      this.values.get(normalizeRuntimeVariableKey('A:TURBINE IGNITION SWITCH')) ??
      0
    if (ignitionMode > 1) {
      this.engineCycleTarget = Math.max(this.engineCycleTarget, 55)
      this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG STARTER:${index}`), 1)
      this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG COMBUSTION:${index}`), 1)
      this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG RPM:${index}`), 55)
      this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG N1:${index}`), 55)
      this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG CORRECTED N1:${index}`), 55)
      this.values.set(normalizeRuntimeVariableKey(`A:TURB ENG N2:${index}`), 55)
    }
  }

  private toggleCircuitSwitch(circuitIndex: number): void {
    const switchKey = normalizeRuntimeVariableKey(`A:CIRCUIT SWITCH ON:${circuitIndex}`)
    const nextValue = (this.values.get(switchKey) ?? 0) > 0 ? 0 : 1
    this.values.set(switchKey, nextValue)
    this.values.set(normalizeRuntimeVariableKey(`A:CIRCUIT ON:${circuitIndex}`), nextValue)
  }

  private toggleCircuitBreaker(circuitIndex: number, busIndex: number): void {
    if (!Number.isFinite(circuitIndex)) {
      return
    }
    const circuit = Math.trunc(circuitIndex)
    if (Number.isFinite(busIndex)) {
      this.values.set(normalizeRuntimeVariableKey('A:BUS LOOKUP INDEX'), Math.trunc(busIndex))
    }
    const circuitOnKey = normalizeRuntimeVariableKey(`A:CIRCUIT ON:${circuit}`)
    const switchOnKey = normalizeRuntimeVariableKey(`A:CIRCUIT SWITCH ON:${circuit}`)
    const currentOn = this.values.get(circuitOnKey) ?? this.values.get(switchOnKey) ?? 1
    const nextOn = currentOn > 0 ? 0 : 1
    this.values.set(circuitOnKey, nextOn)
    this.values.set(switchOnKey, nextOn)
    this.values.set(normalizeRuntimeVariableKey(`A:CIRCUIT BREAKER PULLED:${circuit}`), nextOn > 0 ? 0 : 1)
  }

  private toggleNamedBreaker(name: string): void {
    const breakerName = name.trim().replace(/_/gu, ' ')
    if (!breakerName) {
      return
    }
    const key = normalizeRuntimeVariableKey(`A:BREAKER ${breakerName}`)
    this.values.set(key, (this.values.get(key) ?? 0) > 0 ? 0 : 1)
  }

  private toggleBusConnection(sourceBusIndex: number, targetBusIndex: number): void {
    const connectionKeys = getBusConnectionStateKeys(sourceBusIndex, targetBusIndex)
    const currentValue = connectionKeys
      .map(key => this.values.get(key))
      .find(value => value != null) ?? 1
    const nextValue = currentValue > 0 ? 0 : 1
    for (const key of connectionKeys) {
      this.values.set(key, nextValue)
    }
  }

  private applyGenericControlEventName(name: string, value: number): boolean {
    const normalizedName = normalizeKeyEventName(name)
    const trimMatch = /^HANDLING_(RUDDER|ELEVATOR|AILERONS?)TRIM(?:_[A-Z0-9]+)?(?:_(INC|DEC|SET|RESET))?$/u.exec(normalizedName)
    if (trimMatch != null) {
      this.applyHandlingTrimInputEvent(trimMatch[1], trimMatch[2] ?? 'SET', value)
      return true
    }

    if (normalizedName === 'LANDING_GEAR_GEAR_SET') {
      this.controlState.gearTarget = value > 0 ? 1 : 0
      return true
    }
    if (normalizedName === 'HANDLING_FLAPS_SET' || normalizedName === 'HANDLING_SLATS_SET') {
      this.controlState.flapsTarget = controlEventPositionToRatio(value)
      return true
    }
    if (normalizedName === 'HANDLING_FLAPS_INC' || normalizedName === 'HANDLING_FLAPS_INCR') {
      this.controlState.flapsTarget = clamp01(this.controlState.flapsTarget + 0.25)
      return true
    }
    if (normalizedName === 'HANDLING_FLAPS_DEC' || normalizedName === 'HANDLING_FLAPS_DECR') {
      this.controlState.flapsTarget = clamp01(this.controlState.flapsTarget - 0.25)
      return true
    }
    if (normalizedName === 'HANDLING_SPOILERS_SET') {
      this.controlState.spoilersTarget = controlEventPositionToRatio(value)
      return true
    }
    if (normalizedName === 'HANDLING_PARKING_BRAKE_SET') {
      this.controlState.parkingBrake = value > 0 ? 1 : 0
      return true
    }

    return false
  }

  private applyHandlingTrimInputEvent(type: string, action: string, value: number): void {
    const normalizedType = type === 'AILERONS' ? 'AILERON' : type
    const currentValue = this.values.get(normalizeRuntimeVariableKey(`A:${normalizedType} TRIM PCT`)) ?? 0
    const step = Math.abs(Number.isFinite(value) && value !== 0 ? value : 5) / 100
    const nextValue =
      action === 'RESET'
        ? 0
        : action === 'INC'
          ? currentValue + step
          : action === 'DEC'
            ? currentValue - step
            : trimSetEventValueToFraction(value)

    if (normalizedType === 'RUDDER') {
      this.setRudderTrim(nextValue)
      return
    }
    if (normalizedType === 'AILERON') {
      this.setAileronTrim(nextValue)
      return
    }

    this.setElevatorTrim(nextValue)
  }

  private applyGenericInputEventStateName(name: string, value: number): boolean {
    const normalizedName = normalizeRuntimeInputEventName(name)
    if (!normalizedName) {
      return false
    }

    const state = getGenericInputEventStateUpdate(normalizedName, value, this.values)
    this.values.set(normalizeRuntimeVariableKey(`B:${normalizedName}`), state.eventValue)
    if (state.baseName != null) {
      this.values.set(normalizeRuntimeVariableKey(`B:${state.baseName}`), state.baseValue)
    }
    return true
  }
}

export class DemoRuntimeHost extends SharedMsfsRuntimeHost {}

function createCanonicalAircraftDefinition(
  aircraft: ImportedAircraft | undefined
): CanonicalAircraftDefinition | undefined {
  if (aircraft == null) {
    return undefined
  }

  return {
    identity: {
      id: aircraft.id,
      displayName: aircraft.title,
      variant: aircraft.variationName ?? aircraft.uiType,
    },
    initialState: createCanonicalInitialStateSeeds(aircraft.previewFlightState),
    systems: createCanonicalSystemDefinitions(aircraft),
    adapterMetadata: {
      adapter: 'msfs',
      sourcePath: aircraft.sourcePath,
      sourceUrl: aircraft.sourceUrl,
      sectionName: aircraft.sectionName,
    },
  }
}

function createCanonicalSystemDefinitions(
  aircraft: ImportedAircraft
): readonly CanonicalSystemDefinition[] {
  const engineCount = resolveCanonicalEngineCount(aircraft)
  const electrical = createCanonicalElectricalSystemConfig(engineCount, aircraft.cfgFiles)
  const fuel = createCanonicalFuelSystemConfig(engineCount, aircraft.cfgFiles)
  const propulsion = createCanonicalPropulsionSystemConfig(engineCount, aircraft.cfgFiles)

  return [
    { id: 'electrical', kind: 'electrical', config: electrical },
    { id: 'fuel', kind: 'fuel', config: fuel },
    { id: 'propulsion', kind: 'propulsion', config: propulsion },
  ]
}

function createCanonicalElectricalSystemConfig(
  engineCount: number,
  cfgFiles: readonly ImportedCfgFile[]
): CanonicalElectricalSystemConfig {
  const nominalVolts = resolveNominalElectricalVolts(cfgFiles)
  return {
    buses: [{ id: 'main', nominalVolts }],
    sources: [
      {
        id: 'battery',
        kind: 'battery',
        busId: 'main',
        nominalVolts,
        defaultAvailable: false,
        defaultConnected: false,
      },
      {
        id: 'external',
        kind: 'external',
        busId: 'main',
        nominalVolts,
        defaultAvailable: false,
        defaultConnected: false,
      },
      ...rangeOneBased(engineCount).map(index => ({
        id: `engine-${index}-generator`,
        kind: 'engineGenerator' as const,
        busId: 'main',
        engineIndex: index,
        nominalVolts,
        defaultAvailable: false,
        defaultConnected: true,
      })),
    ],
    consumers: [
      ...rangeOneBased(engineCount).flatMap(index => [
        { id: `fuel-pump-${index}`, busId: 'main' },
        { id: `starter-${index}`, busId: 'main' },
        { id: `ignition-${index}`, busId: 'main' },
      ]),
      { id: 'avionics', busId: 'main' },
      { id: 'lights', busId: 'main' },
    ],
  }
}

function createCanonicalFuelSystemConfig(
  engineCount: number,
  cfgFiles: readonly ImportedCfgFile[]
): CanonicalFuelSystemConfig {
  const defaultQuantityRatio = resolveDefaultFuelQuantityRatio(cfgFiles)
  return {
    tanks: [{ id: 'main', defaultQuantityRatio }],
    pumps: rangeOneBased(engineCount).map(index => ({
      id: `fuel-pump-${index}`,
      index,
      busConsumerId: `fuel-pump-${index}`,
      tankId: 'main',
      defaultSwitchEnabled: false,
    })),
    valves: rangeOneBased(engineCount).map(index => ({
      id: `engine-${index}-valve`,
      index,
      defaultSwitchOpen: false,
    })),
    engineFeeds: rangeOneBased(engineCount).map(index => ({
      engineIndex: index,
      tankId: 'main',
      pumpIds: [`fuel-pump-${index}`],
      valveIds: [`engine-${index}-valve`],
    })),
  }
}

function createCanonicalPropulsionSystemConfig(
  engineCount: number,
  cfgFiles: readonly ImportedCfgFile[]
): CanonicalPropulsionSystemConfig {
  const idleN1Percent = resolveEngineIdleN1Percent(cfgFiles)
  return {
    engines: rangeOneBased(engineCount).map(index => ({
      index,
      starterConsumerId: `starter-${index}`,
      ignitionConsumerId: `ignition-${index}`,
      fuelFeedIndex: index,
      generatorSourceId: `engine-${index}-generator`,
      idleN1Percent,
      starterN1Percent: Math.min(20, idleN1Percent),
      spoolUpPercentPerSecond: 12,
      spoolDownPercentPerSecond: 18,
    })),
    apu: {
      starterConsumerId: 'starter-1',
      generatorSourceId: 'external',
      runningRpmPercent: 100,
      spoolUpPercentPerSecond: 30,
      spoolDownPercentPerSecond: 45,
    },
  }
}

function resolveCanonicalEngineCount(aircraft: ImportedAircraft): number {
  const cfgEngineCount = readFirstCfgNumber(
    aircraft.cfgFiles,
    ['GENERALENGINEDATA', 'generalenginedata'],
    ['number_of_engines', 'engine.0']
  )
  if (cfgEngineCount != null && cfgEngineCount > 0) {
    return Math.max(1, Math.min(16, Math.trunc(cfgEngineCount)))
  }

  const previewEngineCount = aircraft.previewFlightState?.sections
    .map(section => parseEngineFlightStateIndex(section.name))
    .filter((index): index is number => index != null)
    .reduce((max, index) => Math.max(max, index), 0)

  return Math.max(1, previewEngineCount ?? 0)
}

function resolveNominalElectricalVolts(cfgFiles: readonly ImportedCfgFile[]): number {
  return (
    readFirstCfgNumber(
      cfgFiles,
      ['ELECTRICAL', 'electrical'],
      ['max_battery_voltage', 'battery_voltage', 'bus_voltage']
    ) ?? 28
  )
}

function resolveDefaultFuelQuantityRatio(cfgFiles: readonly ImportedCfgFile[]): number {
  const totalCapacity = sumCfgNumberKeys(
    cfgFiles,
    ['FUEL', 'fuel'],
    key => key.endsWith('_capacity') || key.includes('fuel_total_capacity')
  )
  const defaultQuantity = sumCfgNumberKeys(
    cfgFiles,
    ['FUEL', 'fuel'],
    key => key.endsWith('_quantity') || key.includes('fuel_total_quantity')
  )

  if (totalCapacity > 0 && defaultQuantity > 0) {
    return clamp01(defaultQuantity / totalCapacity)
  }

  return 1
}

function resolveEngineIdleN1Percent(cfgFiles: readonly ImportedCfgFile[]): number {
  return (
    readFirstCfgNumber(
      cfgFiles,
      ['TURBINEENGINEDATA', 'turbineenginedata'],
      ['idle_n1', 'low_idle_n1']
    ) ?? 25
  )
}

function readFirstCfgNumber(
  cfgFiles: readonly ImportedCfgFile[],
  sectionNames: readonly string[],
  keys: readonly string[]
): number | null {
  for (const section of findCfgSections(cfgFiles, sectionNames)) {
    for (const key of keys) {
      const value = parseCfgScalarNumber(section.values.get(key.toLowerCase()))
      if (value != null) return value
    }
  }

  return null
}

function sumCfgNumberKeys(
  cfgFiles: readonly ImportedCfgFile[],
  sectionNames: readonly string[],
  predicate: (key: string) => boolean
): number {
  let sum = 0
  for (const section of findCfgSections(cfgFiles, sectionNames)) {
    for (const [key, rawValue] of section.values) {
      if (!predicate(key)) continue
      sum += parseCfgScalarNumber(rawValue) ?? 0
    }
  }
  return sum
}

function findCfgSections(
  cfgFiles: readonly ImportedCfgFile[],
  sectionNames: readonly string[]
): ImportedCfgSection[] {
  const wanted = new Set(sectionNames.map(name => name.toLowerCase()))
  return cfgFiles.flatMap(file =>
    file.sections.filter(section => wanted.has(section.name.toLowerCase()))
  )
}

function parseCfgScalarNumber(value: string | undefined): number | null {
  if (value == null) return null
  const match = /-?\d+(?:\.\d+)?/u.exec(value)
  if (match == null) return null
  const parsed = Number.parseFloat(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

function rangeOneBased(count: number): number[] {
  return Array.from({ length: Math.max(0, Math.trunc(count)) }, (_, index) => index + 1)
}

function createCanonicalInitialStateSeeds(
  flightState: ImportedFlightState | null
): readonly CanonicalStateSeed[] | undefined {
  if (flightState == null) {
    return undefined
  }

  const seeds = new Map<string, CanonicalStateSeed>()
  const setSeed = (seed: CanonicalStateSeed): void => {
    seeds.set(seed.key, seed)
  }

  for (const section of flightState.sections) {
    const normalizedSectionName = section.name.toLowerCase()
    if (normalizedSectionName === 'systems.0') {
      collectCanonicalElectricalSeeds(section, setSeed)
      collectCanonicalLightPotentiometerSeeds(section, setSeed)
    }
    if (normalizedSectionName === 'controls.0') {
      collectCanonicalControlSeeds(section, setSeed)
    }
    if (normalizedSectionName === 'switches.0') {
      collectCanonicalLightPotentiometerSeeds(section, setSeed)
    }

    if (parseEngineFlightStateIndex(section.name) != null) {
      collectCanonicalEngineSeeds(section, setSeed)
    }
  }

  return seeds.size > 0 ? [...seeds.values()] : undefined
}

function collectCanonicalElectricalSeeds(
  section: ImportedCfgSection,
  setSeed: (seed: CanonicalStateSeed) => void
): void {
  for (const [key, rawValue] of section.values) {
    const parsedValue = parseFlightStateScalar(rawValue)
    if (parsedValue == null) {
      continue
    }

    const normalizedKey = key.toLowerCase()
    if (normalizedKey === 'batteryswitch') {
      setSeed({
        key: ElectricalStateKeys.batteryEnabled(),
        value: parsedValue > 0,
        unit: 'boolean',
        valueType: 'boolean',
        source: 'loaded',
      })
    } else if (normalizedKey === 'externalpowerswitch') {
      setSeed({
        key: ElectricalStateKeys.externalPowerConnected(),
        value: parsedValue > 0,
        unit: 'boolean',
        valueType: 'boolean',
        source: 'loaded',
      })
    } else if (normalizedKey === 'avionicsswitch') {
      setSeed({
        key: ElectricalStateKeys.avionicsMasterEnabled(),
        value: parsedValue > 0,
        unit: 'boolean',
        valueType: 'boolean',
        source: 'loaded',
      })
    }
  }
}

function collectCanonicalEngineSeeds(
  section: ImportedCfgSection,
  setSeed: (seed: CanonicalStateSeed) => void
): void {
  const engineIndex = parseEngineFlightStateIndex(section.name)
  if (engineIndex == null) {
    return
  }

  const rpmValue = section.values.get('pct engine rpm')
  const parsedRpm = rpmValue == null ? null : parseFlightStateScalar(rpmValue)
  if (parsedRpm != null) {
    const rpmPercent = toFlightStatePercent(parsedRpm)
    setSeed({
      key: PropulsionStateKeys.engineRpm(engineIndex),
      value: rpmPercent,
      unit: 'number',
      valueType: 'number',
      source: 'loaded',
    })
    setSeed({
      key: PropulsionStateKeys.engineN1Percent(engineIndex),
      value: rpmPercent,
      unit: 'percent',
      valueType: 'number',
      source: 'loaded',
    })
    setSeed({
      key: PropulsionStateKeys.engineRunning(engineIndex),
      value: rpmPercent > 0,
      unit: 'boolean',
      valueType: 'boolean',
      source: 'loaded',
    })
  }

  const throttleValue = section.values.get('throttleleverpct')
  const parsedThrottle = throttleValue == null ? null : parseFlightStateScalar(throttleValue)
  if (parsedThrottle != null) {
    setSeed({
      key: PropulsionStateKeys.engineThrottleLeverRatio(engineIndex),
      value: clamp01(toPercentOver100(parsedThrottle, 'percent')),
      unit: 'ratio',
      valueType: 'number',
      source: 'loaded',
    })
  }

  const generatorSwitchValue = section.values.get('generatorswitch')
  const parsedGeneratorSwitch =
    generatorSwitchValue == null ? null : parseFlightStateScalar(generatorSwitchValue)
  if (parsedGeneratorSwitch != null) {
    setSeed({
      key: PropulsionStateKeys.engineAlternatorEnabled(engineIndex),
      value: parsedGeneratorSwitch > 0,
      unit: 'boolean',
      valueType: 'boolean',
      source: 'loaded',
    })
  }
}

function collectCanonicalLightPotentiometerSeeds(
  section: ImportedCfgSection,
  setSeed: (seed: CanonicalStateSeed) => void
): void {
  for (const [key, rawValue] of section.values) {
    const parsedValue = parseFlightStateScalar(rawValue)
    if (parsedValue == null) {
      continue
    }

    const potentiometerMatch = /^potentiometer\.(\d+)$/iu.exec(key)
    if (potentiometerMatch == null) {
      continue
    }

    setSeed({
      key: LightingStateKeys.potentiometer(Number(potentiometerMatch[1])),
      value: parsedValue,
      unit: 'ratio',
      valueType: 'number',
      source: 'loaded',
    })
  }
}

function collectCanonicalControlSeeds(
  section: ImportedCfgSection,
  setSeed: (seed: CanonicalStateSeed) => void
): void {
  const gearHandle = parseFlightStateScalar(section.values.get('gearshandle') ?? '')
  if (gearHandle != null) {
    const ratio = clamp01(toPercentOver100(gearHandle, 'percent'))
    setRatioLoadedSeed(ControlStateKeys.gearHandleRatio(), ratio, setSeed)
    setRatioLoadedSeed(ControlStateKeys.gearPositionRatio(), ratio, setSeed)
  }

  const flapsHandle = parseFlightStateScalar(
    section.values.get('flapshandle') ?? ''
  )
  if (flapsHandle != null) {
    const ratio = clamp01(toPercentOver100(flapsHandle, 'percent'))
    setRatioLoadedSeed(ControlStateKeys.flapsHandleRatio(), ratio, setSeed)
    setRatioLoadedSeed(ControlStateKeys.flapsPositionRatio(), ratio, setSeed)
    setRatioLoadedSeed(SurfaceStateKeys.targetRatio('flaps'), ratio, setSeed)
    setRatioLoadedSeed(SurfaceStateKeys.positionRatio('flaps'), ratio, setSeed)
  }

  const spoilersHandle = parseFlightStateScalar(
    section.values.get('spoilershandle') ?? ''
  )
  if (spoilersHandle != null) {
    const ratio = clamp01(toPercentOver100(spoilersHandle, 'percent'))
    setRatioLoadedSeed(ControlStateKeys.spoilersHandleRatio(), ratio, setSeed)
    setRatioLoadedSeed(ControlStateKeys.spoilersPositionRatio(), ratio, setSeed)
    setRatioLoadedSeed(SurfaceStateKeys.targetRatio('spoilers'), ratio, setSeed)
    setRatioLoadedSeed(SurfaceStateKeys.positionRatio('spoilers'), ratio, setSeed)
  }
}

function setRatioLoadedSeed(
  key: string,
  value: number,
  setSeed: (seed: CanonicalStateSeed) => void
): void {
  setSeed({
    key,
    value,
    unit: 'ratio',
    valueType: 'number',
    source: 'loaded',
  })
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

function convertFractionalBrightnessUnit(value: number, unit: string | null): number {
  const normalizedUnit = normalizeUnit(unit)
  const clampedValue = clamp01(value)
  if (normalizedUnit === 'percent' || normalizedUnit === 'pct') {
    return clampedValue * 100
  }
  return clampedValue
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

function resolveGenericStoredVariableFallback(
  key: string,
  unit: string | null,
  electricalPower: boolean
): number | null {
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit.includes('bool')) {
    if (key.includes('HEALTHY') || key.includes('AVAILABLE') || key.includes('VALID')) {
      return 1
    }
    if (isElectricalPowerKey(key) || key.includes('POWERED') || key.includes('BUS') || key.includes('CIRCUIT')) {
      return electricalPower ? 1 : 0
    }
    return 0
  }
  if (key.includes('BRIGHTNESS') || key.includes('POTENTIOMETER')) {
    return resolveBrightnessOrPotentiometerFallback(key, unit, electricalPower)
  }
  if (key.includes('POWER') || key.includes('POWERED') || key.includes('ELEC') || key.includes('BUS')) {
    return electricalPower ? 1 : 0
  }
  return null
}

function resolveBrightnessOrPotentiometerFallback(
  key: string,
  unit: string | null,
  electricalPower: boolean
): number {
  if (key.includes('POTENTIOMETER')) {
    return 0
  }
  if (isFractionalBrightnessVariableKey(key)) {
    return convertFractionalBrightnessUnit(0, unit)
  }
  const poweredValue = electricalPower ? 100 : 0
  return normalizeUnit(unit) === 'percent over 100' ? poweredValue / 100 : poweredValue
}

function resolveStoredRuntimeValue(key: string, value: number, unit: string | null): number {
  if (isFractionalBrightnessVariableKey(key)) {
    return convertFractionalBrightnessUnit(value, unit)
  }
  if (isEngineAntiIcePositionKey(key)) {
    return convertPercentToEngineAntiIcePositionUnit(value, unit)
  }
  if (isEngineControlPercentPositionKey(key)) {
    return convertPercentToPosition16kUnit(value, unit)
  }
  if (key.startsWith('A:RECIP ENG PRIMER:')) {
    return convertPercentToPrimerUnit(value, unit)
  }
  if (key.startsWith('A:HYDRAULIC RESERVOIR PERCENT:')) {
    return convertPercentUnit(value, unit)
  }
  if (isLightPercentVariableKey(key)) {
    return convertPercentUnit(value, unit)
  }
  if (isControlPercentVariableKey(key)) {
    return convertPercentToPosition16kUnit(value, unit)
  }
  if (isFractionalTrimPercentKey(key)) {
    return convertPercentOver100Unit(value, unit)
  }
  if (isHandlingPercentPositionKey(key)) {
    return convertPercentToPosition16kUnit(value, unit)
  }
  return value
}

function isEngineAntiIcePositionKey(key: string): boolean {
  return (
    key.startsWith('A:GENERAL ENG ANTI ICE POSITION:') ||
    key.startsWith('A:RECIP ENG ALTERNATE AIR POSITION:')
  )
}

function convertPercentToEngineAntiIcePositionUnit(value: number, unit: string | null): number {
  const clampedPercent = clamp(value, 0, 100)
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit === 'position 16k') {
    return (clampedPercent / 100) * 16_384
  }
  if (normalizedUnit === 'percent over 100') {
    return clampedPercent / 100
  }
  return clampedPercent
}

function isEngineControlPercentPositionKey(key: string): boolean {
  return (
    key.startsWith('A:GENERAL ENG THROTTLE LEVER POSITION:') ||
    key.startsWith('A:GENERAL ENG PROPELLER LEVER POSITION:') ||
    key.startsWith('A:GENERAL ENG MIXTURE LEVER POSITION:') ||
    key.startsWith('A:RECIP ENG COWL FLAP POSITION:') ||
    key.endsWith(' COOLING FLAPS POSITION') ||
    key.startsWith('A:PROP BETA FORCED POSITION:') ||
    key === 'A:ROTOR BRAKE HANDLE POS'
  )
}

function convertPercentToPosition16kUnit(value: number, unit: string | null): number {
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit === 'position 16k') {
    return (value / 100) * 16_384
  }
  if (normalizedUnit === 'percent over 100') {
    return value / 100
  }
  return value
}

function position16kToPercent(value: number, allowNegative: boolean): number {
  const clampedValue = clamp(value, allowNegative ? -16_384 : 0, 16_384)
  return (clampedValue / 16_384) * 100
}

function trimSetEventValueToFraction(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  if (Math.abs(value) <= 100) {
    return value / 100
  }
  return value / 16_384
}

function getFlexibleIndexedSetEventArgs(args: readonly number[], defaultIndex: number): { index: number; value: number } {
  if (args.length >= 2) {
    const first = Number(args[0] ?? Number.NaN)
    const second = Number(args[1] ?? Number.NaN)
    if (Math.abs(first) <= 1 && Math.abs(second) > 1) {
      return {
        index: Math.trunc(second),
        value: first
      }
    }
    return {
      index: Math.trunc(first),
      value: second
    }
  }
  return {
    index: Math.trunc(Number(args[0] ?? defaultIndex)),
    value: Number(args[0] ?? 0)
  }
}

function isHandlingPercentPositionKey(key: string): boolean {
  return (
    key === 'A:BRAKE LEFT POSITION' ||
    key === 'A:BRAKE RIGHT POSITION' ||
    key === 'A:WATER RUDDER HANDLE POSITION'
  )
}

function isFractionalTrimPercentKey(key: string): boolean {
  return (
    key === 'A:AILERON TRIM PCT' ||
    key === 'A:ELEVATOR TRIM PCT' ||
    key === 'A:RUDDER TRIM PCT'
  )
}

function isLightPercentVariableKey(key: string): boolean {
  return (
    key.startsWith('A:LIGHT POTENTIOMETER:') ||
    /^A:LIGHT [A-Z0-9_ ]+ POWER SETTING(?::|$)/u.test(key)
  )
}

function isControlPercentVariableKey(key: string): boolean {
  return (
    key === 'A:GEAR ANIMATION POSITION' ||
    key === 'A:GEAR CENTER POSITION' ||
    key === 'A:GEAR LEFT POSITION' ||
    key === 'A:GEAR RIGHT POSITION' ||
    key === 'A:FLAPS HANDLE PERCENT' ||
    key === 'A:TRAILING EDGE FLAPS LEFT PERCENT' ||
    key === 'A:TRAILING EDGE FLAPS RIGHT PERCENT' ||
    key === 'A:LEADING EDGE FLAPS LEFT PERCENT' ||
    key === 'A:LEADING EDGE FLAPS RIGHT PERCENT' ||
    key === 'A:SPOILERS HANDLE POSITION' ||
    key === 'A:SPOILERS LEFT POSITION' ||
    key === 'A:SPOILERS RIGHT POSITION'
  )
}

function convertPercentToPrimerUnit(value: number, unit: string | null): number {
  const clampedPercent = clamp(value, 0, 100)
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit === 'position' || normalizedUnit === 'percent over 100') {
    return clampedPercent / 100
  }
  return clampedPercent
}

function isCircuitPowerStateKey(key: string): boolean {
  return (
    /^A:CIRCUIT(?: [A-Z0-9_ ]+)? ON(?::|$)/u.test(key) ||
    /^A:CIRCUIT SWITCH ON(?::|$)/u.test(key)
  )
}

function isCircuitConnectionStateKey(key: string): boolean {
  return /^A:CIRCUIT CONNECTION ON(?::|$)/u.test(key)
}

function isPoweredBusConnectionKey(key: string): boolean {
  return /^A:(?:\d+:)?BUS CONNECTION ON(?::|$)/u.test(key)
}

function getBusConnectionStateKeys(sourceBusIndex: number, targetBusIndex: number): string[] {
  return Array.from(new Set([
    `A:${sourceBusIndex}:BUS CONNECTION ON:${targetBusIndex}`,
    `A:${targetBusIndex}:BUS CONNECTION ON:${sourceBusIndex}`,
    `A:BUS CONNECTION ON:${sourceBusIndex}`,
    `A:BUS CONNECTION ON:${targetBusIndex}`
  ].map(key => normalizeRuntimeVariableKey(key))))
}

function isElectricalVoltageKey(key: string): boolean {
  return key.startsWith('A:ELECTRICAL') && (key.includes('VOLTAGE') || key.includes('VOLTS'))
}

function isElectricalPowerKey(key: string): boolean {
  return (
    key === 'A:ELECTRICAL MASTER BATTERY' ||
    key === 'A:MASTER BATTERY SWITCH' ||
    key === 'A:BATTERY SWITCH' ||
    key === 'A:EXTERNAL POWER ON' ||
    key === 'A:AVIONICS MASTER SWITCH' ||
    key.includes('_BUS_IS_POWERED') ||
    key.includes('IS_POWERED') ||
    (key.includes('ELECTRICAL') && (key.includes('POWER') || key.includes('SWITCH'))) ||
    (key.includes('ELEC') && (key.includes('POWER') || key.includes('POWERED')))
  )
}

function isFractionalBrightnessVariableKey(key: string): boolean {
  return (
    (key.startsWith('I:') || key.startsWith('L:')) &&
    key.includes('BRIGHTNESS') &&
    !key.includes('POTENTIOMETER')
  )
}

function isDynamicRuntimeFallbackKey(key: string): boolean {
  return (
    isElectricalPowerKey(key) ||
    isElectricalVoltageKey(key) ||
    isExternalPowerAvailableKey(key) ||
    isCircuitPowerStateKey(key) ||
    key.startsWith('A:CIRCUIT POWER SETTING:') ||
    key.includes('BRIGHTNESS') ||
    key.includes('POTENTIOMETER') ||
    key.includes('POWERED') ||
    key.includes('IS_POWERED') ||
    isDynamicControlFallbackKey(key)
  )
}

function isDynamicControlFallbackKey(key: string): boolean {
  return (
    (key.includes('GEAR') && key.includes('POSITION')) ||
    ((key.includes('FLAP') || key.includes('SLAT')) &&
      (key.includes('POSITION') || key.includes('PERCENT') || key.includes('INDEX'))) ||
    (key.includes('SPOILER') && (key.includes('POSITION') || key.includes('DEFLECTION'))) ||
    ((key.includes('PARKING') || key.includes('PARK_BRAKE')) &&
      (key.includes('POSITION') || key.includes('LEVER') || key.endsWith('_POS')))
  )
}

function isBatteryControlKey(key: string): boolean {
  if (key.includes('BUS') || key.includes('POWERED') || key.includes('VOLT') || key.includes('LOAD')) {
    return false
  }
  if (key.includes('FAULT') || key.includes('LIGHT') || key.includes('POTENTIOMETER')) {
    return false
  }
  return (
    key === 'A:ELECTRICAL MASTER BATTERY' ||
    key === 'A:MASTER BATTERY SWITCH' ||
    key === 'A:BATTERY SWITCH' ||
    ((key.includes('BATTERY') || /(?:^|_)BAT(?:_|TERY|\d)/u.test(key)) &&
      (key.includes('SWITCH') ||
        key.includes('MASTER') ||
        key.includes('PB_IS_AUTO') ||
        key.includes('PB_IS_ON') ||
        key.endsWith('_IS_ON') ||
        key.endsWith('_ON')))
  )
}

function isExternalPowerControlKey(key: string): boolean {
  if (key.includes('AVAILABLE') || key.includes('AVAIL') || key.includes('FAULT')) {
    return false
  }
  return (
    key === 'A:EXTERNAL POWER ON' ||
    ((key.includes('EXTERNAL POWER') || key.includes('EXT_PWR')) &&
      (key.includes('SWITCH') || key.includes('PB_IS_ON') || key.endsWith('_IS_ON') || key.endsWith('_ON')))
  )
}

function isExternalPowerAvailableKey(key: string): boolean {
  return (
    key === 'A:EXTERNAL POWER AVAILABLE' ||
    key.includes('EXTERNAL POWER AVAILABLE') ||
    key.includes('EXT_PWR_AVAIL') ||
    key.includes('EXTERNAL_POWER_AVAILABLE')
  )
}

function isAvionicsControlKey(key: string): boolean {
  if (key.includes('FAULT') || key.includes('LIGHT') || key.includes('DISPLAY')) {
    return false
  }
  return (
    key === 'A:AVIONICS MASTER SWITCH' ||
    (key.includes('AVIONICS') &&
      (key.includes('SWITCH') ||
        key.includes('PB_IS_ON') ||
        key.endsWith('_IS_ON') ||
        key.endsWith('_ON')))
  )
}

function isGeneratorControlKey(key: string): boolean {
  if (key.includes('FAULT') || key.includes('LOAD') || key.includes('VOLT')) {
    return false
  }
  return (
    key.startsWith('A:APU GENERATOR SWITCH:') ||
    key.startsWith('A:GENERAL ENG MASTER ALTERNATOR:') ||
    (key.includes('GENERATOR') && (key.includes('SWITCH') || key.endsWith('_IS_ON') || key.endsWith('_ON')))
  )
}

function isApuMasterLocalSwitchKey(key: string): boolean {
  return key.includes('APU') &&
    key.includes('MASTER') &&
    (key.endsWith('_IS_ON') || key.endsWith('_PB_IS_ON') || key.includes('SW_PB_IS_ON'))
}

function isApuStartLocalSwitchKey(key: string): boolean {
  return key.includes('APU') &&
    (key.includes('START') || key.includes('STARTER')) &&
    (key.endsWith('_IS_ON') || key.endsWith('_PB_IS_ON'))
}

function isApuBleedLocalSwitchKey(key: string): boolean {
  return key.includes('APU') &&
    key.includes('BLEED') &&
    (key.endsWith('_IS_ON') || key.endsWith('_PB_IS_ON') || key.endsWith('_ON'))
}

function normalizeUnit(unit: string | null): string {
  return unit?.trim().toLowerCase() ?? ''
}

function normalizeRuntimeVariableKey(key: string): string {
  const trimmed = key.trim()
  if (/^[ALOKHBEI]:/iu.test(trimmed)) {
    return trimmed.toUpperCase()
  }
  return `A:${trimmed}`.toUpperCase()
}

function normalizeRuntimeInputEventName(name: string): string {
  return name.trim().replace(/^\s*B:/iu, '').toUpperCase()
}

function normalizeRuntimeBridgeArgs(values: number | readonly number[]): readonly number[] {
  const args = Array.isArray(values) ? values : [values]
  if (args.length === 0) {
    return [0]
  }
  return args.map(value => {
    const numericValue = Number(value)
    return Number.isFinite(numericValue) ? numericValue : 0
  })
}

function isRuntimeStoredVariableKey(key: string): boolean {
  return /^[LOKHBI]:/u.test(key)
}

function normalizeKeyEventName(name: string): string {
  return name.trim().replace(/^\s*K:/iu, '').replace(/\s+/gu, '_').toUpperCase()
}

function getLightSwitchVariableKey(type: string, index?: number): string {
  const normalizedType = type.replace(/_/gu, ' ').trim().toUpperCase()
  const simvarType =
    normalizedType === 'STROBES' ? 'STROBE'
      : normalizedType === 'NAV' ? 'NAV'
        : normalizedType === 'LOGO' ? 'LOGO'
          : normalizedType === 'LANDING' ? 'LANDING'
            : normalizedType === 'TAXI' ? 'TAXI'
              : normalizedType === 'CABIN' ? 'CABIN'
                : normalizedType === 'PANEL' ? 'PANEL'
                  : normalizedType === 'BEACON' ? 'BEACON'
                    : normalizedType === 'WING' ? 'WING'
                      : normalizedType === 'RECOGNITION' ? 'RECOGNITION'
                  : normalizedType.endsWith('S') ? normalizedType.slice(0, -1) : normalizedType
  const suffix = index == null ? '' : `:${index}`
  return normalizeRuntimeVariableKey(`A:LIGHT ${simvarType}${suffix}`)
}

function getLightPowerSettingType(type: string): string {
  const normalizedType = type.replace(/_/gu, ' ').trim().toUpperCase()
  return normalizedType === 'PEDESTRAL' ? 'PEDESTAL'
    : normalizedType === 'STROBES' ? 'STROBE'
      : normalizedType === 'NAV' ? 'NAV'
        : normalizedType.endsWith('S') ? normalizedType.slice(0, -1)
          : normalizedType
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function toPercentOver100(value: number, unit: string | null): number {
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit === 'percent' || normalizedUnit === 'pct') {
    return value / 100
  }
  if (Math.abs(value) > 1 && Math.abs(value) <= 100) {
    return value / 100
  }
  return value
}

function controlEventPositionToRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  if (Math.abs(value) > 100) {
    return clamp01(Math.abs(value) / 16_384)
  }
  return clamp01(toPercentOver100(value, null))
}

function getGenericInputEventStateUpdate(
  name: string,
  value: number,
  values: ReadonlyMap<string, number>
): {
  readonly eventValue: number
  readonly baseName: string | null
  readonly baseValue: number
} {
  const normalizedValue = Number.isFinite(value) ? value : 0
  const namedStateMatch = /^(.*)_SET_(ON|OFF|OPEN|CLOSED|LOCKED|UNLOCKED|UP|DOWN|EXTENDED|RETRACTED)$/u.exec(name)
  if (namedStateMatch != null) {
    const stateValue = getGenericBooleanStateNameValue(namedStateMatch[2] ?? '')
    if (stateValue != null) {
      return {
        eventValue: stateValue,
        baseName: namedStateMatch[1] ?? null,
        baseValue: stateValue
      }
    }
  }

  const suffixMatch = /_(PUSH|RELEASE|ON|OFF|TOGGLE|SET|INC|DEC)$/u.exec(name)
  if (suffixMatch == null) {
    return {
      eventValue: normalizedValue,
      baseName: null,
      baseValue: normalizedValue
    }
  }

  const suffix = suffixMatch[1]
  const baseName = name.slice(0, -suffixMatch[0].length)
  const baseKey = normalizeRuntimeVariableKey(`B:${baseName}`)
  const currentBaseValue = values.get(baseKey) ?? 0
  const step = Math.abs(normalizedValue) > 0 ? Math.abs(normalizedValue) : 1
  const baseValue =
    suffix === 'PUSH' || suffix === 'ON'
      ? 1
      : suffix === 'RELEASE' || suffix === 'OFF'
        ? 0
        : suffix === 'TOGGLE'
          ? currentBaseValue > 0 ? 0 : 1
          : suffix === 'SET'
            ? normalizedValue
            : suffix === 'INC'
              ? currentBaseValue + step
              : currentBaseValue - step
  return {
    eventValue: suffix === 'RELEASE' || suffix === 'OFF' ? 0 : normalizedValue || 1,
    baseName,
    baseValue
  }
}

function shouldPublishGenericHandledInputEventState(name: string): boolean {
  return /_(PUSH|RELEASE|ON|OFF)$/u.test(name)
}

function getGenericBooleanStateNameValue(stateName: string): number | null {
  if (stateName === 'ON' || stateName === 'OPEN' || stateName === 'LOCKED' || stateName === 'DOWN' || stateName === 'EXTENDED') {
    return 1
  }
  if (stateName === 'OFF' || stateName === 'CLOSED' || stateName === 'UNLOCKED' || stateName === 'UP' || stateName === 'RETRACTED') {
    return 0
  }
  return null
}

function normalizeKohlsmanHg(value: number): number {
  if (!Number.isFinite(value)) {
    return 29.92
  }
  if (value > 8_000) {
    return value / 16 / 33.863_886_666_7
  }
  if (value > 100) {
    return value / 33.863_886_666_7
  }
  return value
}

function normalizeDegrees(value: number): number {
  return positiveModulo(value, 360)
}

function isSoundVariableInRanges(
  variable: ImportedSoundVariable,
  ranges: readonly ImportedSoundRange[],
  values: ReadonlyMap<string, number>
): boolean {
  const value = readStoredSoundVariable(variable, values)
  return ranges.some(range => {
    if (range.lowerBound != null && value < range.lowerBound) {
      return false
    }
    if (range.upperBound != null && value > range.upperBound) {
      return false
    }
    return true
  })
}

function readStoredSoundVariable(
  variable: ImportedSoundVariable,
  values: ReadonlyMap<string, number>
): number {
  for (const key of getSoundVariableKeyCandidates(variable)) {
    const value = values.get(key)
    if (value != null) {
      return value
    }
  }
  return 0
}

function getSoundVariableKeyCandidates(variable: ImportedSoundVariable): readonly string[] {
  const cachedCandidates = soundVariableKeyCandidatesCache.get(variable)
  if (cachedCandidates != null) {
    return cachedCandidates
  }

  const prefix = variable.kind === 'localvar' ? 'L' : 'A'
  const baseKey = normalizeRuntimeVariableKey(`${prefix}:${variable.name}`)
  if (variable.index == null || variable.index === 0) {
    const candidates = [baseKey]
    soundVariableKeyCandidatesCache.set(variable, candidates)
    return candidates
  }
  const candidates = [
    normalizeRuntimeVariableKey(`${prefix}:${variable.name}:${Math.trunc(variable.index)}`),
    baseKey
  ]
  soundVariableKeyCandidatesCache.set(variable, candidates)
  return candidates
}

const soundVariableKeyCandidatesCache = new WeakMap<
  ImportedSoundVariable,
  readonly string[]
>()

function formatSoundVariableKey(variable: ImportedSoundVariable): string {
  const prefix = variable.kind === 'localvar' ? 'L' : 'A'
  const suffix = variable.index == null ? '' : `:${Math.trunc(variable.index)}`
  return normalizeRuntimeVariableKey(`${prefix}:${variable.name}${suffix}`)
}

function parseFlightStateScalar(rawValue: string): number | null {
  const normalizedValue = rawValue.trim()
  if (normalizedValue === '') {
    return null
  }
  if (/^true$/iu.test(normalizedValue)) {
    return 1
  }
  if (/^false$/iu.test(normalizedValue)) {
    return 0
  }

  const parsedValue = Number(normalizedValue)
  return Number.isFinite(parsedValue) ? parsedValue : null
}

function parseEngineFlightStateIndex(sectionName: string): number | null {
  const match = /^engine parameters\.(\d+)\./iu.exec(sectionName)
  if (match == null) {
    return null
  }
  const parsedValue = Number.parseInt(match[1], 10)
  return Number.isFinite(parsedValue) ? parsedValue : null
}

function toFlightStatePercent(value: number): number {
  if (Math.abs(value) <= 1) {
    return value * 100
  }
  return value
}

function handled(value: number): { readonly handled: true; readonly value: number } {
  return {
    handled: true,
    value
  }
}

interface DemoWingFlexProfile {
  readonly baseFlexPct: number
  readonly leftFlexPct: number
  readonly rightFlexPct: number
}

interface RuntimeWingFlexNode {
  readonly node: Object3D
  readonly order: number
  readonly localFlexDirection: Vector3
  cumulativeSpan: number
  readonly appliedOffset: Vector3
}

interface RuntimeInteractionFeedbackTimer {
  taskId: SimScheduledTaskId
  readonly dueAtSeconds: number
  readonly resetOnExpire: boolean
}

interface RuntimeWingFlexBinding {
  readonly leftWing: readonly RuntimeWingFlexNode[]
  readonly rightWing: readonly RuntimeWingFlexNode[]
  readonly leftEnginePivots: readonly RuntimeWingFlexNode[]
  readonly rightEnginePivots: readonly RuntimeWingFlexNode[]
  readonly maxAngleRadians: number
  readonly surfaceScalar: number
}

function createDemoWingFlexProfile(aircraft?: ImportedAircraft): DemoWingFlexProfile {
  const flightModel = aircraft?.cfgFiles.find(file => file.kind === 'flight_model')
  const flightDynamics = flightModel == null
    ? undefined
    : findCfgSection(flightModel, 'flight_tuning') ?? findCfgSection(flightModel, 'flight_tuning.0')
  const aerodynamics = flightModel == null
    ? undefined
    : findCfgSection(flightModel, 'aerodynamics') ?? findCfgSection(flightModel, 'aerodynamics.0')
  const wingFlexSection = selectCfgSectionWithKeys(
    [flightDynamics, aerodynamics],
    ['wingflex_scalar', 'wingflex_offset']
  )

  const scalar = parseCfgNumber(
    wingFlexSection,
    'wingflex_scalar',
    1
  )
  const offset = parseCfgNumber(
    wingFlexSection,
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

function buildWingFlexBindings(
  nodeAnimations: readonly ModelNodeAnimation[],
  aircraft: ImportedAircraft | undefined,
  sceneRoot: Object3D,
  nodes: ReadonlyMap<string, Object3D>,
  canonicalNodes: ReadonlyMap<string, Object3D>
): readonly RuntimeWingFlexBinding[] {
  void nodeAnimations
  void aircraft
  void sceneRoot
  void nodes
  void canonicalNodes

  // The official docs enumerate WingFlex nodes and inputs, but they do not
  // publish the actual node deformation math. The previous translation-based
  // runtime visibly broke the live A320/A330 fixtures, so keep the parser
  // support but do not invent unsupported bone transforms here.
  return []
}

function applyWingFlexChain(
  nodes: readonly RuntimeWingFlexNode[],
  flexAmount: number,
  binding: RuntimeWingFlexBinding
): void {
  const normalizedFlex = clamp(flexAmount, -1, 1)
  if (nodes.length === 0) return

  const tangent = Math.tan(binding.maxAngleRadians * binding.surfaceScalar)
  for (const node of nodes) {
    const targetOffsetY = node.cumulativeSpan * tangent * normalizedFlex
    applyWingFlexOffset(node, targetOffsetY)
  }
}

function applyWingFlexEnginePivots(
  pivots: readonly RuntimeWingFlexNode[],
  _wingBones: readonly RuntimeWingFlexNode[],
  flexAmount: number,
  binding: RuntimeWingFlexBinding
): void {
  const normalizedFlex = clamp(flexAmount, -1, 1)
  if (pivots.length === 0) return
  const tangent = Math.tan(binding.maxAngleRadians * binding.surfaceScalar)

  for (const pivot of pivots) {
    const targetOffsetAmount = pivot.cumulativeSpan * tangent * normalizedFlex
    applyWingFlexOffset(pivot, targetOffsetAmount)
  }
}

function applyWingFlexOffset(
  node: RuntimeWingFlexNode,
  offsetAmount: number
): void {
  const targetOffset = node.localFlexDirection.clone().multiplyScalar(offsetAmount)
  node.node.position.add(targetOffset.sub(node.appliedOffset))
  node.appliedOffset.copy(targetOffset)
}

function finalizeWingFlexChain(nodes: RuntimeWingFlexNode[]): void {
  nodes.sort((left, right) => left.order - right.order)
  if (nodes.length === 0) return

  let cumulativeSpan = 0
  nodes[0].cumulativeSpan = 0
  for (let index = 1; index < nodes.length; index += 1) {
    cumulativeSpan += nodes[index].node.position.distanceTo(nodes[index - 1].node.position)
    nodes[index].cumulativeSpan = cumulativeSpan
  }
}

function finalizeWingFlexEnginePivots(
  pivots: RuntimeWingFlexNode[],
  wingBones: readonly RuntimeWingFlexNode[]
): void {
  pivots.sort((left, right) => left.order - right.order)
  const maxSpan = wingBones.at(-1)?.cumulativeSpan ?? 0
  if (pivots.length === 0) return

  if (pivots.length === 1) {
    pivots[0].cumulativeSpan = maxSpan * 0.55
    return
  }

  for (let index = 0; index < pivots.length; index += 1) {
    const t = pivots.length === 1 ? 0.55 : 0.45 + (0.35 * index) / (pivots.length - 1)
    pivots[index].cumulativeSpan = maxSpan * t
  }
}

function getAircraftWingFlexSurfaceScalar(aircraft: ImportedAircraft | undefined): number {
  const flightModel = aircraft?.cfgFiles.find(file => file.kind === 'flight_model')
  const flightDynamics = flightModel == null
    ? undefined
    : findCfgSection(flightModel, 'flight_tuning') ?? findCfgSection(flightModel, 'flight_tuning.0')
  const aerodynamics = flightModel == null
    ? undefined
    : findCfgSection(flightModel, 'aerodynamics') ?? findCfgSection(flightModel, 'aerodynamics.0')
  const wingFlexSection = selectCfgSectionWithKeys(
    [flightDynamics, aerodynamics],
    ['wingflex_surface_scalar', 'wingflex_scalar']
  )

  return parseCfgNumber(wingFlexSection, 'wingflex_surface_scalar', 1)
}

function resolveWingFlexDirectionInParentSpace(
  node: Object3D,
  sceneRoot: Object3D
): Vector3 {
  const parent = node.parent
  if (parent == null) {
    return new Vector3(0, 1, 0)
  }

  const worldOrigin = sceneRoot.getWorldPosition(new Vector3())
  const worldUpPoint = sceneRoot.localToWorld(new Vector3(0, 1, 0))
  const localOrigin = parent.worldToLocal(worldOrigin.clone())
  const localUpPoint = parent.worldToLocal(worldUpPoint)
  const localDirection = localUpPoint.sub(localOrigin)

  if (localDirection.lengthSq() <= 1e-12) {
    return new Vector3(0, 1, 0)
  }

  return localDirection.normalize()
}

function resolveNodeAnimationNode(
  nodeName: string,
  nodes: ReadonlyMap<string, Object3D>,
  canonicalNodes: ReadonlyMap<string, Object3D>
): Object3D | null {
  const exactNode =
    nodes.get(nodeName) ??
    nodes.get(nodeName.toLowerCase())
  if (exactNode != null) return exactNode

  const canonicalName = canonicalizeNodeAnimationName(nodeName)
  if (!canonicalName) return null
  return canonicalNodes.get(canonicalName) ?? null
}

function canonicalizeNodeAnimationName(name: string): string | null {
  const descriptor = describeNodeAnimationNode(name)
  if (descriptor == null) return null
  return `${descriptor.kind}:${descriptor.side}:${descriptor.index}`
}

function describeNodeAnimationNode(
  name: string
): { readonly kind: 'wingBone' | 'enginePivot'; readonly side: 'left' | 'right'; readonly index: number } | null {
  const normalizedName = name.trim().toUpperCase()
  if (!normalizedName) return null

  if (normalizedName.includes('WING') && normalizedName.includes('BONE')) {
    const side = normalizedName.includes('LEFT') ? 'left'
      : normalizedName.includes('RIGHT') ? 'right'
      : null
    if (side == null) return null
    const indexMatch =
      normalizedName.match(/WING[_ ]*BONE(?:[_ ]*(?:LEFT|RIGHT))?[_ ]*0*([0-9]+)/u) ??
      normalizedName.match(/WING[_ ]*BONE[_ ]*0*([0-9]+)(?:[_ ]*(?:LEFT|RIGHT))?/u)
    const index = Number.parseInt(indexMatch?.[1] ?? '', 10)
    return {
      kind: 'wingBone',
      side,
      index: Number.isFinite(index) && index > 0 ? index : 1
    }
  }

  if (normalizedName.includes('ENGINE') && normalizedName.includes('PIVOT')) {
    const side = normalizedName.includes('LEFT') ? 'left'
      : normalizedName.includes('RIGHT') ? 'right'
      : null
    if (side == null) return null
    const allNumbers = [...normalizedName.matchAll(/([0-9]+)/gu)].map(match => Number.parseInt(match[1] ?? '', 10))
    const index = allNumbers.at(-1) ?? 1
    return {
      kind: 'enginePivot',
      side,
      index: Number.isFinite(index) && index > 0 ? index : 1
    }
  }

  return null
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

function selectCfgSectionWithKeys(
  sections: readonly (ImportedCfgSection | undefined)[],
  keyNames: readonly string[]
): ImportedCfgSection | undefined {
  const normalizedKeys = keyNames.map(key => key.toLowerCase())
  for (const section of sections) {
    if (section == null) continue
    const sectionKeys = new Set(Array.from(section.values.keys(), key => key.toLowerCase()))
    if (normalizedKeys.some(key => sectionKeys.has(key))) {
      return section
    }
  }

  return sections.find(section => section != null)
}

function readRuntimeStringVariable(key: string, mouseEvent: string): string {
  return key.toUpperCase() === 'M:EVENT' ? mouseEvent : ''
}

function isRuntimeInteractionReleaseMouseEvent(mouseEvent: string): boolean {
  const normalized = mouseEvent.trim().toUpperCase()
  return normalized === 'LEFTRELEASE' || normalized === 'LEFTLEAVE' || normalized === 'UNLOCK'
}

function doesRuntimeInteractionExpressionHandleMouseEvent(expression: CompiledExpression): boolean {
  return /\(\s*M\s*:\s*Event\b/iu.test(expression.source)
}

function readRuntimeMouseVariable(key: string, options: RuntimeInteractionOptions): number | null {
  switch (key.toUpperCase()) {
    case 'M:INPUTTYPE':
      return options.inputType ?? 0
    case 'M:RELATIVEX':
      return options.relativeX ?? 0
    case 'M:RELATIVEY':
      return options.relativeY ?? 0
    case 'M:RELATIVEZ':
      return options.relativeZ ?? 0
    case 'M:DRAGPERCENT':
      return options.dragPercent ?? 0
    default:
      return null
  }
}

function animationTimeAtNormalizedValue(
  clip: AnimationClip,
  normalizedValue: number
): number {
  let firstKeyTime = Number.POSITIVE_INFINITY
  let lastKeyTime = Number.NEGATIVE_INFINITY
  for (const track of clip.tracks) {
    if (track.times.length === 0) continue
    firstKeyTime = Math.min(firstKeyTime, track.times[0]!)
    lastKeyTime = Math.max(lastKeyTime, track.times[track.times.length - 1]!)
  }

  const value = clamp(normalizedValue, 0, 1)
  return Number.isFinite(firstKeyTime) && Number.isFinite(lastKeyTime)
    ? firstKeyTime + value * (lastKeyTime - firstKeyTime)
    : value * (clip.duration || 1)
}

function findAnimationClip<T extends { readonly name: string }>(
  clips: readonly T[],
  target: string
): T | undefined {
  const exact = clips.find(clip => clip.name === target)
  if (exact != null) return exact

  const canonicalTarget = target.toLocaleLowerCase()
  const matches = clips.filter(clip => clip.name.toLocaleLowerCase() === canonicalTarget)
  return matches.length === 1 ? matches[0] : undefined
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
