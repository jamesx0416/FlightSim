import { AnimationMixer, type Object3D, Vector3 } from 'three'

import { evaluateCompiledExpression } from './rpn'
import type {
  CompiledBehaviorSet,
  CompiledAnimationBinding,
  CompiledInteractionBinding,
  CompiledInteractionSoundEvent,
  CompiledUpdateBinding,
  CompiledVisibilityBinding,
  ImportedAircraft,
  ImportedCfgFile,
  ImportedCfgSection,
  ImportedFlightState,
  ImportDiagnostic,
  ModelNodeAnimation,
  RuntimeHostServices,
  RuntimeState
} from './types'

interface RuntimeInteractionOptions {
  readonly holdFeedback?: boolean
  readonly mouseEvent?: string
}

export class AircraftRuntime {
  private readonly mixer: AnimationMixer
  private readonly actions = new Map<string, ReturnType<AnimationMixer['clipAction']>>()
  private readonly nodes = new Map<string, Object3D>()
  private readonly canonicalNodes = new Map<string, Object3D>()
  private readonly animationValues = new Map<string, number>()
  private readonly nodeVisibilities = new Map<string, boolean>()
  private activeAnimationBindings: readonly CompiledAnimationBinding[] = []
  private readonly activeVisibilityBindings: readonly CompiledVisibilityBinding[]
  private readonly runtimeState: RuntimeState
  private readonly updateState = new Map<CompiledUpdateBinding, { elapsedSeconds: number; ranOnce: boolean }>()
  private readonly interactionFeedbackTimers = new Map<string, RuntimeInteractionFeedbackTimer>()
  private readonly heldInteractionFeedbackTargets = new Map<
    string,
    { count: number; startedAtSeconds: number }
  >()
  private readonly wingFlexBindings: readonly RuntimeWingFlexBinding[]
  private readonly delayedInteractionReleases: RuntimeDelayedInteractionRelease[] = []
  private interactionFeedbackClockSeconds = 0
  private interactionExecutionCount = 0

  constructor(
    private readonly compiled: CompiledBehaviorSet,
    private readonly sceneRoot: Object3D,
    private readonly hostServices: RuntimeHostServices,
    aircraft?: ImportedAircraft
  ) {
    this.mixer = new AnimationMixer(sceneRoot)
    this.runtimeState = {
      irVersion: 'msfs-runtime/v1',
      animationValues: this.animationValues,
      nodeVisibilities: this.nodeVisibilities,
      diagnostics: this.compiled.diagnostics
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
    this.activeVisibilityBindings = this.compiled.visibilityBindings.filter(binding =>
      this.nodes.has(binding.target) || this.nodes.has(binding.target.toLowerCase())
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
    const activeAnimationBindings: CompiledAnimationBinding[] = []
    for (const binding of this.compiled.animationBindings) {
      const clip = clips.find(candidate => candidate.name === binding.target)
      if (clip == null) continue
      const action = this.mixer.clipAction(clip as never)
      action.enabled = true
      action.play()
      action.paused = true
      this.actions.set(binding.target, action)
      activeAnimationBindings.push(binding)
    }
    this.activeAnimationBindings = activeAnimationBindings
  }

  update(dtSeconds: number): RuntimeState {
    this.interactionFeedbackClockSeconds += dtSeconds
    this.hostServices.tick(dtSeconds)
    this.runUpdateBindings(dtSeconds)
    this.publishDelayedInteractionReleases()
    this.publishInteractionFeedback(dtSeconds)

    for (const binding of this.activeAnimationBindings) {
      const evaluatedValue = evaluateCompiledExpression(binding.expression, {
        readVariable: (key, unit) => this.hostServices.readVariable(key, unit)
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
    this.applyWingFlexBindings()

    for (const binding of this.activeVisibilityBindings) {
      const isVisible =
        evaluateCompiledExpression(binding.expression, {
          readVariable: (key, unit) => this.hostServices.readVariable(key, unit)
        }) !== 0

      this.nodeVisibilities.set(binding.target, isVisible)
      const node =
        this.nodes.get(binding.target) ??
        this.nodes.get(binding.target.toLowerCase())
      if (node != null) {
        node.visible = isVisible
      }
    }

    return this.runtimeState
  }

  dispose(): void {
    this.mixer.stopAllAction()
    this.actions.clear()
    this.mixer.uncacheRoot(this.sceneRoot)
  }

  getInteractionBindings(): readonly CompiledInteractionBinding[] {
    return this.compiled.interactionBindings
  }

  getInteractionExecutionCount(): number {
    return this.interactionExecutionCount
  }

  executeInteraction(target: string, options: RuntimeInteractionOptions = {}): boolean {
    const binding = this.findInteractionBindingForTarget(target)
    if (binding == null) {
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
        writeVariable: (key, nextValue, unit) => this.hostServices.writeVariable(key, nextValue, unit),
        invokeKeyEvent: (name, args) => this.hostServices.invokeKeyEvent?.(name, args),
        invokeHtmlEvent: (name, args) => this.hostServices.invokeHtmlEvent?.(name, args)
      })

      state.ranOnce = true
      this.updateState.set(binding, state)
    }
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
    const exactBinding = this.compiled.interactionBindings.find(binding => binding.target.trim() === trimmedTarget)
    if (exactBinding != null) {
      return exactBinding
    }

    const caseInsensitiveBinding = this.compiled.interactionBindings.find(
      binding => binding.target.trim().toLowerCase() === lowercaseTarget
    )
    if (caseInsensitiveBinding != null) {
      return caseInsensitiveBinding
    }

    if (canonicalTarget === '') {
      return null
    }

    return (
      this.compiled.interactionBindings.find(
        binding => canonicalizeNodeAnimationName(binding.target.trim()) === canonicalTarget
      ) ?? null
    )
  }

  private executeInteractionBinding(
    binding: CompiledInteractionBinding,
    options: RuntimeInteractionOptions = {}
  ): void {
    this.triggerInteractionFeedback(binding, options.holdFeedback === true ? 'hold' : 'pulse')
    this.invokeInteractionSoundEvents(binding, 'press')
    const mouseEvent = options.mouseEvent?.trim() || 'LeftSingle'
    evaluateCompiledExpression(binding.expression, {
      readVariable: (key, unit) => this.hostServices.readVariable(key, unit),
      readStringVariable: key => readRuntimeStringVariable(key, mouseEvent),
      writeVariable: (key, value, unit) => this.hostServices.writeVariable(key, value, unit),
      invokeKeyEvent: (name, args) => this.hostServices.invokeKeyEvent?.(name, args),
      invokeHtmlEvent: (name, args) => this.hostServices.invokeHtmlEvent?.(name, args)
    })
    this.interactionExecutionCount += 1
  }

  private triggerInteractionFeedback(binding: CompiledInteractionBinding, mode: 'hold' | 'pulse'): void {
    const targets = binding.feedbackTargets.length > 0 ? binding.feedbackTargets : [binding.target]
    for (const target of targets) {
      const trimmedTarget = target.trim()
      if (!trimmedTarget) {
        continue
      }
      if (mode === 'hold') {
        const previousState = this.heldInteractionFeedbackTargets.get(trimmedTarget)
        this.heldInteractionFeedbackTargets.set(trimmedTarget, {
          count: (previousState?.count ?? 0) + 1,
          startedAtSeconds: previousState?.startedAtSeconds ?? this.interactionFeedbackClockSeconds
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
          startedAtSeconds: previousState?.startedAtSeconds ?? this.interactionFeedbackClockSeconds
        })
      } else {
        this.heldInteractionFeedbackTargets.delete(trimmedTarget)
        const elapsedSeconds =
          previousState == null
            ? 0
            : this.interactionFeedbackClockSeconds - previousState.startedAtSeconds
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
        if (!this.interactionFeedbackTimers.has(trimmedTarget) && binding.animationDurationSeconds == null) {
          this.hostServices.writeVariable(`O:${trimmedTarget}:_ButtonAnimVar`, 0)
        }
      }
    }
    if (shouldRunReleaseExpression) {
      this.executeInteractionReleaseBinding(binding)
    } else if (binding.releaseExpression != null) {
      this.delayedInteractionReleases.push({
        binding,
        releaseAtSeconds: this.interactionFeedbackClockSeconds + maxRemainingMinimumHoldSeconds
      })
    }
  }

  private executeInteractionReleaseBinding(binding: CompiledInteractionBinding): void {
    this.invokeInteractionSoundEvents(binding, 'release')
    if (binding.releaseExpression == null) {
      return
    }

    evaluateCompiledExpression(binding.releaseExpression, {
      readVariable: (key, unit) => this.hostServices.readVariable(key, unit),
      writeVariable: (key, value, unit) => this.hostServices.writeVariable(key, value, unit),
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

  private publishDelayedInteractionReleases(): void {
    for (let index = this.delayedInteractionReleases.length - 1; index >= 0; index -= 1) {
      const delayedRelease = this.delayedInteractionReleases[index]
      if (delayedRelease == null || delayedRelease.releaseAtSeconds > this.interactionFeedbackClockSeconds) {
        continue
      }
      this.executeInteractionReleaseBinding(delayedRelease.binding)
      this.delayedInteractionReleases.splice(index, 1)
    }
  }

  private setInteractionFeedbackTimer(
    target: string,
    remainingSeconds: number,
    resetOnExpire: boolean
  ): void {
    const previousTimer = this.interactionFeedbackTimers.get(target)
    this.interactionFeedbackTimers.set(target, {
      remainingSeconds: Math.max(previousTimer?.remainingSeconds ?? 0, remainingSeconds),
      resetOnExpire: (previousTimer?.resetOnExpire ?? false) || resetOnExpire
    })
  }

  private publishInteractionFeedback(dtSeconds: number): void {
    for (const target of this.heldInteractionFeedbackTargets.keys()) {
      this.hostServices.writeVariable(`O:${target}:_ButtonAnimVar`, 1)
    }

    for (const [target, timer] of [...this.interactionFeedbackTimers.entries()]) {
      if (timer.remainingSeconds > 0) {
        this.hostServices.writeVariable(`O:${target}:_ButtonAnimVar`, 1)
      }

      const nextSecondsRemaining = timer.remainingSeconds - dtSeconds
      if (nextSecondsRemaining > 0) {
        this.interactionFeedbackTimers.set(target, {
          ...timer,
          remainingSeconds: nextSecondsRemaining
        })
      } else {
        this.interactionFeedbackTimers.delete(target)
        if (!this.heldInteractionFeedbackTargets.has(target) && timer.resetOnExpire) {
          this.hostServices.writeVariable(`O:${target}:_ButtonAnimVar`, 0)
        }
      }
    }
  }
}

export type RuntimeVariableNamespace = 'A' | 'L' | 'O' | 'K' | 'H' | 'B' | 'E'

export interface SharedRuntimeHostStats {
  readonly variableReadCount: number
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
  readonly phase: 'press' | 'release'
  readonly target: string
  readonly normalizedTime: number | null
  readonly sourcePath: string
  readonly sourceParameter: string
  readonly sequence: number
}

export interface RuntimeHtmlEvent {
  readonly name: string
  readonly args: readonly (number | string)[]
  readonly sequence: number
}

export type RuntimeHtmlEventListener = (event: RuntimeHtmlEvent) => void

export class SharedMsfsRuntimeHost implements RuntimeHostServices {
  private elapsedSeconds = 0
  private readonly values = new Map<string, number>()
  private readonly readCache = new Map<string, number>()
  private readonly defaultedKeys = new Set<string>()
  private readonly wingFlexProfile: DemoWingFlexProfile
  private engineCycleTarget = 0
  private throttleLeverPosition = 0
  private variableReadCount = 0
  private variableWriteCount = 0
  private keyEventCount = 0
  private htmlEventCount = 0
  private soundEventCount = 0
  private bridgeCallCount = 0
  private defaultedVariableCount = 0
  private readonly recentHtmlEvents: RuntimeHtmlEvent[] = []
  private readonly htmlEventListeners = new Set<RuntimeHtmlEventListener>()
  private readonly recentSoundEvents: RuntimeSoundEvent[] = []
  private controlState = {
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
  private electricalState = {
    batterySwitch: 0,
    externalPowerSwitch: 0,
    externalPowerAvailable: 1,
    avionicsSwitch: 0
  }
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
    engineCycle: 0,
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
    this.wingFlexProfile = createDemoWingFlexProfile(aircraft)
    this.seedColdAndDarkState()
    this.seedPreviewFlightState(aircraft?.previewFlightState ?? null)
  }

  tick(dtSeconds: number): void {
    this.readCache.clear()
    this.elapsedSeconds += dtSeconds
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
  }

  readVariable(key: string, unit?: string | null): number {
    this.variableReadCount += 1
    const cacheKey = `${key}\u0000${unit ?? ''}`
    const cachedValue = this.readCache.get(cacheKey)
    if (cachedValue != null) {
      return cachedValue
    }

    const normalizedKey = normalizeRuntimeVariableKey(key)
    let value: number
    if (!this.values.has(normalizedKey)) {
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

      value = resolved.value
    } else {
      value = this.values.get(normalizedKey) ?? 0
    }
    this.readCache.set(cacheKey, value)
    return value
  }

  writeVariable(key: string, value: number, unit?: string | null): void {
    this.variableWriteCount += 1
    this.readCache.clear()
    const normalizedKey = normalizeRuntimeVariableKey(key)
    const numericValue = Number(value)
    this.values.set(normalizedKey, Number.isFinite(numericValue) ? numericValue : 0)
    if (normalizedKey.startsWith('H:')) {
      this.invokeHtmlEvent(normalizedKey.slice(2), [normalizedKey.slice(2), Number.isFinite(numericValue) ? numericValue : 0])
    }
    this.applyElectricalVariableSideEffects(normalizedKey, numericValue, unit ?? null)
    this.applyVariableSideEffects(normalizedKey, numericValue, unit ?? null)
  }

  invokeKeyEvent(name: string, args: readonly number[]): void {
    this.keyEventCount += 1
    this.readCache.clear()
    const value = args.at(-1) ?? 1
    const normalizedEventName = normalizeKeyEventName(name)
    this.values.set(normalizeRuntimeVariableKey(`K:${normalizedEventName}`), value)
    this.applyKeyEvent(normalizedEventName, args)
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
    this.values.set(normalizeRuntimeVariableKey(`H:${eventName}`), event.sequence)
    this.recentHtmlEvents.push(event)
    if (this.recentHtmlEvents.length > 100) {
      this.recentHtmlEvents.splice(0, this.recentHtmlEvents.length - 100)
    }
    for (const listener of this.htmlEventListeners) {
      listener(event)
    }
  }

  addHtmlEventListener(listener: RuntimeHtmlEventListener): () => void {
    this.htmlEventListeners.add(listener)
    return () => {
      this.htmlEventListeners.delete(listener)
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
    if (this.recentSoundEvents.length > 100) {
      this.recentSoundEvents.splice(0, this.recentSoundEvents.length - 100)
    }
  }

  invokeBridgeCall(name: string): void {
    this.bridgeCallCount += 1
    this.values.set(normalizeRuntimeVariableKey(`B:${name}`), this.bridgeCallCount)
  }

  getStats(): SharedRuntimeHostStats {
    return {
      variableReadCount: this.variableReadCount,
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

  getHtmlEvents(): readonly RuntimeHtmlEvent[] {
    return this.recentHtmlEvents.map(event => ({ ...event, args: [...event.args] }))
  }

  private publishControlVariables(): void {
    const gearPct = this.controlState.gearPosition * 100
    const flapsPct = this.controlState.flapsPosition * 100
    const spoilersPct = this.controlState.spoilersPosition * 100
    this.values.set(normalizeRuntimeVariableKey('A:GEAR ANIMATION POSITION'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR ANIMATION POSITION:0'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR ANIMATION POSITION:1'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR ANIMATION POSITION:2'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR HANDLE POSITION'), this.controlState.gearTarget)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR CENTER POSITION'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR LEFT POSITION'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:GEAR RIGHT POSITION'), gearPct)
    this.values.set(normalizeRuntimeVariableKey('A:FLAPS HANDLE PERCENT'), flapsPct)
    this.values.set(normalizeRuntimeVariableKey('A:TRAILING EDGE FLAPS LEFT PERCENT'), flapsPct)
    this.values.set(normalizeRuntimeVariableKey('A:TRAILING EDGE FLAPS RIGHT PERCENT'), flapsPct)
    this.values.set(normalizeRuntimeVariableKey('A:LEADING EDGE FLAPS LEFT PERCENT'), flapsPct)
    this.values.set(normalizeRuntimeVariableKey('A:LEADING EDGE FLAPS RIGHT PERCENT'), flapsPct)
    this.values.set(normalizeRuntimeVariableKey('A:SPOILERS HANDLE POSITION'), spoilersPct)
    this.values.set(normalizeRuntimeVariableKey('A:SPOILERS LEFT POSITION'), spoilersPct)
    this.values.set(normalizeRuntimeVariableKey('A:SPOILERS RIGHT POSITION'), spoilersPct)
    this.values.set(normalizeRuntimeVariableKey('A:AILERON POSITION'), this.controlState.aileronPosition)
    this.values.set(normalizeRuntimeVariableKey('A:ELEVATOR POSITION'), this.controlState.elevatorPosition)
    this.values.set(normalizeRuntimeVariableKey('A:RUDDER POSITION'), this.controlState.rudderPosition)
    this.values.set(normalizeRuntimeVariableKey('A:BRAKE PARKING POSITION'), this.controlState.parkingBrake)
  }

  private publishElectricalVariables(): void {
    const powered = this.hasElectricalPower() ? 1 : 0
    this.values.set(normalizeRuntimeVariableKey('A:ELECTRICAL MASTER BATTERY'), this.electricalState.batterySwitch)
    this.values.set(normalizeRuntimeVariableKey('A:MASTER BATTERY SWITCH'), this.electricalState.batterySwitch)
    this.values.set(normalizeRuntimeVariableKey('A:BATTERY SWITCH'), this.electricalState.batterySwitch)
    this.values.set(normalizeRuntimeVariableKey('A:EXTERNAL POWER AVAILABLE'), this.electricalState.externalPowerAvailable)
    this.values.set(normalizeRuntimeVariableKey('A:EXTERNAL POWER ON'), this.electricalState.externalPowerSwitch)
    this.values.set(normalizeRuntimeVariableKey('A:AVIONICS MASTER SWITCH'), this.electricalState.avionicsSwitch)
    this.values.set(normalizeRuntimeVariableKey('A:ELECTRICAL MAIN BUS VOLTAGE'), powered > 0 ? 28 : 0)
    this.values.set(normalizeRuntimeVariableKey('A:ELECTRICAL AVIONICS BUS VOLTAGE'), powered > 0 ? 28 : 0)
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
      const potentiometerMatch = /^potentiometer\.(\d+)$/iu.exec(key)
      if (potentiometerMatch != null) {
        this.values.set(normalizeRuntimeVariableKey(`A:LIGHT POTENTIOMETER:${potentiometerMatch[1]}`), parsedValue)
      }
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
        this.values.set(normalizeRuntimeVariableKey(simVarKey), parsedValue > 0 ? 1 : 0)
      }
    }
  }

  private setBatterySwitch(value: number): void {
    const switchValue = value > 0 ? 1 : 0
    this.electricalState.batterySwitch = switchValue
    this.values.set(normalizeRuntimeVariableKey('A:ELECTRICAL MASTER BATTERY'), switchValue)
    this.values.set(normalizeRuntimeVariableKey('A:MASTER BATTERY SWITCH'), switchValue)
    this.values.set(normalizeRuntimeVariableKey('A:BATTERY SWITCH'), switchValue)
  }

  private setExternalPowerSwitch(value: number): void {
    const switchValue = value > 0 ? 1 : 0
    this.electricalState.externalPowerSwitch = switchValue
    this.values.set(normalizeRuntimeVariableKey('A:EXTERNAL POWER ON'), switchValue)
  }

  private applyElectricalVariableSideEffects(key: string, value: number, unit: string | null): void {
    const normalizedValue = Number.isFinite(value) && value > 0 ? 1 : 0
    if (isBatteryControlKey(key)) {
      this.electricalState.batterySwitch = this.hasStoredBatteryControlPower() ? 1 : normalizedValue
      return
    }
    if (isExternalPowerControlKey(key)) {
      this.electricalState.externalPowerSwitch = this.hasStoredExternalPower() ? 1 : normalizedValue
      return
    }
    if (key === 'A:EXTERNAL POWER AVAILABLE' || key.includes('EXT_PWR_AVAIL')) {
      this.electricalState.externalPowerAvailable = normalizedValue
      return
    }
    if (key === 'A:AVIONICS MASTER SWITCH') {
      this.electricalState.avionicsSwitch = normalizedValue
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
    if (upperKey.includes('BRIGHTNESS') || upperKey.includes('POTENTIOMETER')) {
      const poweredValue = this.hasElectricalPower() ? 100 : 0
      return handled(normalizeUnit(unit) === 'percent over 100' ? poweredValue / 100 : poweredValue)
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
    if (isPoweredBusConnectionKey(upperKey)) return handled(1)
    if (isElectricalVoltageKey(upperKey)) return handled(this.hasElectricalPower() ? 28 : 0)
    if (isElectricalPowerKey(upperKey)) return handled(this.hasElectricalPower() ? 1 : 0)
    if (upperKey.startsWith('A:INTERACTIVE POINT OPEN:')) return handled(convertPercentUnit(0, unit))
    if (upperKey.startsWith('A:ENG ANTI ICE:')) return handled(0)
    if (upperKey.startsWith('A:PROP DEICE SWITCH:')) return handled(0)
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
      return handled(convertPercentUnit(this.throttleLeverPosition, unit))
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
    if (key === 'A:GEAR HANDLE POSITION' || key === 'A:GEAR HANDLE') {
      this.controlState.gearTarget = normalizedValue > 0 ? 1 : 0
      return
    }
    if (key.includes('FLAPS HANDLE') || key.includes('FLAP') || key.includes('SLAT')) {
      this.controlState.flapsTarget = clamp01(toPercentOver100(normalizedValue, unit))
      return
    }
    if (key.includes('SPOILER')) {
      this.controlState.spoilersTarget = clamp01(toPercentOver100(normalizedValue, unit))
      return
    }
    if (key.includes('AILERON')) {
      this.controlState.aileronTarget = clamp(normalizedValue, -1, 1)
      return
    }
    if (key.includes('ELEVATOR')) {
      this.controlState.elevatorTarget = clamp(normalizedValue, -1, 1)
      return
    }
    if (key.includes('RUDDER')) {
      this.controlState.rudderTarget = clamp(normalizedValue, -1, 1)
      return
    }
    if (key.includes('PARKING') || key.includes('PARK BRAKE')) {
      this.controlState.parkingBrake = normalizedValue > 0 ? 1 : 0
    }
  }

  private applyKeyEvent(name: string, args: readonly number[]): void {
    const value = Number(args.at(-1) ?? 0)
    if (this.applyLightKeyEvent(name, args)) {
      return
    }
    if (this.applyFuelSystemKeyEvent(name, args)) {
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
        const busKey = normalizeRuntimeVariableKey(`A:${sourceBusIndex}:BUS CONNECTION ON:${targetBusIndex}`)
        const currentValue = this.values.get(busKey) ?? 1
        this.values.set(busKey, currentValue > 0 ? 0 : 1)
      }
      return
    }
    if (name === 'APU_GENERATOR_SWITCH_TOGGLE') {
      const generatorIndex = Math.trunc(Number(args[0] ?? 1))
      const generatorKey = normalizeRuntimeVariableKey(`A:APU GENERATOR SWITCH:${generatorIndex}`)
      const currentValue = this.values.get(generatorKey) ?? 0
      this.values.set(generatorKey, currentValue > 0 ? 0 : 1)
      return
    }
    if (this.applyApuKeyEvent(name, args)) {
      return
    }
    if (this.applyCabinKeyEvent(name)) {
      return
    }
    if (this.applyRadioKeyEvent(name, args)) {
      return
    }
    if (this.applyPitotHeatKeyEvent(name, args)) {
      return
    }
    if (this.applyRadioAudioKeyEvent(name, args)) {
      return
    }
    if (this.applyTrimAndBrakeKeyEvent(name, args)) {
      return
    }
    if (this.applyDeiceAndIgnitionKeyEvent(name, args)) {
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
      this.controlState.spoilersTarget = value > 0 ? this.controlState.spoilersTarget : 0
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

  private applyLightKeyEvent(name: string, args: readonly number[]): boolean {
    const indexedPotentiometerSet = /^LIGHT_POTENTIOMETER_(\d+)_SET$/u.exec(name)
    if (indexedPotentiometerSet != null) {
      this.setLightPotentiometer(Number(indexedPotentiometerSet[1]), Number(args[0] ?? 0))
      return true
    }

    if (name === 'LIGHT_POTENTIOMETER_SET') {
      this.setLightPotentiometer(Number(args[1] ?? Number.NaN), Number(args[0] ?? 0))
      return true
    }

    const lightSetMatch = /^(.+)_LIGHTS_SET$/u.exec(name)
    if (lightSetMatch != null) {
      this.setLightSwitch(lightSetMatch[1], Number(args.at(-1) ?? 0) > 0 ? 1 : 0)
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

    const lightToggleMatch = /^(.+)_LIGHTS_TOGGLE$/u.exec(name)
    if (lightToggleMatch != null) {
      const variableKey = getLightSwitchVariableKey(lightToggleMatch[1])
      const currentValue = this.values.get(variableKey) ?? 0
      this.values.set(variableKey, currentValue > 0 ? 0 : 1)
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
      this.values.set(normalizeRuntimeVariableKey('L:A32NX_OVHD_APU_START_PB_IS_ON'), 1)
      this.values.set(normalizeRuntimeVariableKey('L:A32NX_OVHD_APU_START_PB_IS_AVAILABLE'), 1)
      return true
    }
    if (name === 'APU_OFF_SWITCH') {
      this.values.set(normalizeRuntimeVariableKey('A:APU SWITCH'), 0)
      this.values.set(normalizeRuntimeVariableKey('A:APU PCT RPM'), 0)
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

  private applyRadioKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'COM_RECEIVE_ALL_SET') {
      const value = Number(args.at(-1) ?? 0) > 0 ? 1 : 0
      for (let index = 1; index <= 3; index += 1) {
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
    const pitotMatch = /^PITOT_HEAT_(ON|OFF|TOGGLE)$/u.exec(name)
    if (pitotMatch == null) {
      return false
    }
    const index = Math.trunc(Number(args[0] ?? 1))
    const key = normalizeRuntimeVariableKey(Number.isFinite(index) ? `A:PITOT HEAT SWITCH:${index}` : 'A:PITOT HEAT')
    const nextValue =
      pitotMatch[1] === 'TOGGLE'
        ? (this.values.get(key) ?? 0) > 0 ? 0 : 1
        : pitotMatch[1] === 'ON' ? 1 : 0
    this.values.set(key, nextValue)
    this.values.set(normalizeRuntimeVariableKey('A:PITOT HEAT'), nextValue)
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
      this.values.set(normalizeRuntimeVariableKey('A:COM ACTIVE FREQUENCY:3'), value)
      this.values.set(normalizeRuntimeVariableKey('A:COM ACTIVE FREQUENCY:3 HZ'), value)
      return true
    }

    const identMatch = /^RADIO_(ADF2?|DME(\d+)|VOR(\d+))_IDENT_(ENABLE|DISABLE|TOGGLE)$/u.exec(name)
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
      const nextValue = action === 'TOGGLE' ? currentValue > 0 ? 0 : 1 : action === 'ENABLE' ? 1 : 0
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

  private applyTrimAndBrakeKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'AXIS_ELEV_TRIM_SET') {
      const trim = clamp(Number(args.at(-1) ?? 0) / 16_383, -1, 1)
      this.values.set(normalizeRuntimeVariableKey('A:ELEVATOR TRIM POSITION'), trim)
      this.values.set(normalizeRuntimeVariableKey('A:ELEVATOR TRIM INDICATOR'), trim * 100)
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

    if (name === 'RUDDER_TRIM_SET' || name === 'RUDDER_TRIM_SET_EX1') {
      this.setRudderTrim(Number(args.at(-1) ?? 0) / 16_384)
      return true
    }

    if (name === 'ANTISKID_BRAKES_TOGGLE') {
      this.toggleNamedBoolVariables('A:ANTISKID BRAKES ACTIVE', 'A:ANTISKID BRAKES SWITCH')
      return true
    }

    return false
  }

  private applyDeiceAndIgnitionKeyEvent(name: string, args: readonly number[]): boolean {
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

    const mixtureRichMatch = /^MIXTURE(\d+)_RICH$/u.exec(name)
    if (mixtureRichMatch != null) {
      const index = Number.parseInt(mixtureRichMatch[1], 10)
      this.values.set(normalizeRuntimeVariableKey(`A:GENERAL ENG MIXTURE LEVER POSITION:${index}`), 100)
      return true
    }

    return false
  }

  private applyAutopilotAndTransponderKeyEvent(name: string, args: readonly number[]): boolean {
    if (name === 'AUTOPILOT_OFF') {
      this.values.set(normalizeRuntimeVariableKey('A:AUTOPILOT MASTER'), 0)
      return true
    }

    if (name === 'XPNDR_IDENT_ON') {
      this.values.set(normalizeRuntimeVariableKey('A:TRANSPONDER IDENT'), 1)
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
      this.values.set(key, nextValue)
      this.values.set(normalizeRuntimeVariableKey('A:KOHLSMAN SETTING HG'), nextValue)
      this.values.set(normalizeRuntimeVariableKey(`A:KOHLSMAN SETTING MB:${index}`), nextValue * 33.863_886_666_7)
      return true
    }

    return false
  }

  private setRudderTrim(value: number): void {
    const trim = clamp(value, -1, 1)
    this.values.set(normalizeRuntimeVariableKey('A:RUDDER TRIM PCT'), trim)
    this.values.set(normalizeRuntimeVariableKey('A:RUDDER TRIM'), trim * 100)
  }

  private toggleNamedBoolVariables(...keys: readonly string[]): void {
    const normalizedKeys = keys.map(key => normalizeRuntimeVariableKey(key))
    const nextValue = (this.values.get(normalizedKeys[0] ?? '') ?? 0) > 0 ? 0 : 1
    for (const key of normalizedKeys) {
      this.values.set(key, nextValue)
    }
  }

  private setLightPotentiometer(index: number, value: number): void {
    if (!Number.isFinite(index)) {
      return
    }
    const clampedValue = clamp(value, 0, 100)
    this.values.set(normalizeRuntimeVariableKey(`A:LIGHT POTENTIOMETER:${Math.trunc(index)}`), clampedValue)
  }

  private setLightSwitch(type: string, value: number): void {
    this.values.set(getLightSwitchVariableKey(type), value > 0 ? 1 : 0)
  }

  private applyFuelSystemKeyEvent(name: string, args: readonly number[]): boolean {
    const pumpMatch = /^FUELSYSTEM_PUMP_(TOGGLE|ON|OFF)$/u.exec(name)
    if (pumpMatch != null) {
      const pumpIndex = Math.trunc(Number(args[0] ?? Number.NaN))
      if (Number.isFinite(pumpIndex)) {
        const pumpKey = normalizeRuntimeVariableKey(`A:FUELSYSTEM PUMP SWITCH:${pumpIndex}`)
        const nextValue =
          pumpMatch[1] === 'TOGGLE'
            ? (this.values.get(pumpKey) ?? 0) > 0 ? 0 : 1
            : pumpMatch[1] === 'ON' ? 1 : 0
        this.values.set(pumpKey, nextValue)
        this.values.set(normalizeRuntimeVariableKey(`A:FUELSYSTEM PUMP ACTIVE:${pumpIndex}`), nextValue)
      }
      return true
    }

    const valveMatch = /^FUELSYSTEM_VALVE_(TOGGLE|OPEN|CLOSE)$/u.exec(name)
    if (valveMatch != null) {
      const valveIndex = Math.trunc(Number(args[0] ?? Number.NaN))
      if (Number.isFinite(valveIndex)) {
        const valveKey = normalizeRuntimeVariableKey(`A:FUELSYSTEM VALVE OPEN:${valveIndex}`)
        const nextValue =
          valveMatch[1] === 'TOGGLE'
            ? (this.values.get(valveKey) ?? 0) > 0 ? 0 : 1
            : valveMatch[1] === 'OPEN' ? 1 : 0
        this.values.set(valveKey, nextValue)
        this.values.set(normalizeRuntimeVariableKey(`A:FUELSYSTEM VALVE SWITCH:${valveIndex}`), nextValue)
      }
      return true
    }

    if (name === 'FUELSYSTEM_JUNCTION_SET') {
      const setting = Number(args[0] ?? Number.NaN)
      const junctionIndex = Math.trunc(Number(args[1] ?? Number.NaN))
      if (Number.isFinite(setting) && Number.isFinite(junctionIndex)) {
        this.values.set(normalizeRuntimeVariableKey(`A:FUELSYSTEM JUNCTION SETTING:${junctionIndex}`), setting)
      }
      return true
    }

    return false
  }

  private toggleCircuitSwitch(circuitIndex: number): void {
    const switchKey = normalizeRuntimeVariableKey(`A:CIRCUIT SWITCH ON:${circuitIndex}`)
    const nextValue = (this.values.get(switchKey) ?? 0) > 0 ? 0 : 1
    this.values.set(switchKey, nextValue)
    this.values.set(normalizeRuntimeVariableKey(`A:CIRCUIT ON:${circuitIndex}`), nextValue)
  }

  private applyGenericControlEventName(name: string, value: number): boolean {
    const normalizedName = normalizeKeyEventName(name)
    if (normalizedName.includes('GEAR')) {
      if (normalizedName.includes('UP') || normalizedName.includes('RETRACT')) {
        this.controlState.gearTarget = 0
        return true
      }
      if (normalizedName.includes('DOWN') || normalizedName.includes('EXTEND')) {
        this.controlState.gearTarget = 1
        return true
      }
      if (normalizedName.includes('TOGGLE')) {
        this.controlState.gearTarget = this.controlState.gearTarget > 0.5 ? 0 : 1
        return true
      }
      if (normalizedName.includes('SET') || normalizedName.includes('HANDLE')) {
        this.controlState.gearTarget = value > 0 ? 1 : 0
        return true
      }
    }

    if (normalizedName.includes('FLAP') || normalizedName.includes('SLAT')) {
      if (normalizedName.includes('INCR') || normalizedName.includes('INC') || normalizedName.includes('DOWN')) {
        this.controlState.flapsTarget = clamp01(this.controlState.flapsTarget + 0.25)
        return true
      }
      if (normalizedName.includes('DECR') || normalizedName.includes('DEC') || normalizedName.includes('UP')) {
        this.controlState.flapsTarget = clamp01(this.controlState.flapsTarget - 0.25)
        return true
      }
      if (normalizedName.includes('SET') || normalizedName.includes('AXIS') || normalizedName.includes('HANDLE')) {
        this.controlState.flapsTarget = clamp01(toPercentOver100(value, null))
        return true
      }
    }

    if (normalizedName.includes('SPOILER')) {
      if (normalizedName.includes('SET') || normalizedName.includes('AXIS') || normalizedName.includes('HANDLE')) {
        this.controlState.spoilersTarget = clamp01(toPercentOver100(value, null))
        return true
      }
      if (normalizedName.includes('ARM') && value <= 0) {
        this.controlState.spoilersTarget = 0
        return true
      }
    }

    if (normalizedName.includes('PARKING') || normalizedName.includes('PARK_BRAKE')) {
      if (normalizedName.includes('TOGGLE')) {
        this.controlState.parkingBrake = this.controlState.parkingBrake > 0.5 ? 0 : 1
      } else {
        this.controlState.parkingBrake = value > 0 ? 1 : 0
      }
      return true
    }

    return false
  }
}

export class DemoRuntimeHost extends SharedMsfsRuntimeHost {}

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
    const poweredValue = electricalPower ? 100 : 0
    return normalizedUnit === 'percent over 100' ? poweredValue / 100 : poweredValue
  }
  if (key.includes('POWER') || key.includes('POWERED') || key.includes('ELEC') || key.includes('BUS')) {
    return electricalPower ? 1 : 0
  }
  return null
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

function isDynamicRuntimeFallbackKey(key: string): boolean {
  return (
    isElectricalPowerKey(key) ||
    isElectricalVoltageKey(key) ||
    isCircuitPowerStateKey(key) ||
    key.startsWith('A:CIRCUIT POWER SETTING:') ||
    key.includes('BRIGHTNESS') ||
    key.includes('POTENTIOMETER') ||
    key.includes('POWERED') ||
    key.includes('IS_POWERED')
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

function normalizeUnit(unit: string | null): string {
  return unit?.trim().toLowerCase() ?? ''
}

function normalizeRuntimeVariableKey(key: string): string {
  const trimmed = key.trim()
  if (/^[ALOKHBE]:/iu.test(trimmed)) {
    return trimmed.toUpperCase()
  }
  return `A:${trimmed}`.toUpperCase()
}

function isRuntimeStoredVariableKey(key: string): boolean {
  return /^[LOKHB]:/u.test(key)
}

function normalizeKeyEventName(name: string): string {
  return name.trim().replace(/^\s*K:/iu, '').replace(/\s+/gu, '_').toUpperCase()
}

function getLightSwitchVariableKey(type: string): string {
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
  return normalizeRuntimeVariableKey(`A:LIGHT ${simvarType}`)
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
  readonly remainingSeconds: number
  readonly resetOnExpire: boolean
}

interface RuntimeDelayedInteractionRelease {
  readonly binding: CompiledInteractionBinding
  readonly releaseAtSeconds: number
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
