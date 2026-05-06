import { AnimationMixer, type Object3D, Vector3 } from 'three'

import { evaluateCompiledExpression } from './rpn'
import type {
  CompiledBehaviorSet,
  CompiledInteractionBinding,
  CompiledUpdateBinding,
  ImportedAircraft,
  ImportedCfgFile,
  ImportedCfgSection,
  ImportedFlightState,
  ImportDiagnostic,
  ModelNodeAnimation,
  RuntimeHostServices,
  RuntimeState
} from './types'

export class AircraftRuntime {
  private readonly mixer: AnimationMixer
  private readonly actions = new Map<string, ReturnType<AnimationMixer['clipAction']>>()
  private readonly nodes = new Map<string, Object3D>()
  private readonly canonicalNodes = new Map<string, Object3D>()
  private readonly animationValues = new Map<string, number>()
  private readonly nodeVisibilities = new Map<string, boolean>()
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
    this.wingFlexBindings = buildWingFlexBindings(
      aircraft?.model?.nodeAnimations ?? [],
      aircraft,
      sceneRoot,
      this.nodes,
      this.canonicalNodes
    )
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
    this.interactionFeedbackClockSeconds += dtSeconds
    this.hostServices.tick(dtSeconds)
    this.runUpdateBindings(dtSeconds)
    this.publishDelayedInteractionReleases()
    this.publishInteractionFeedback(dtSeconds)

    for (const binding of this.compiled.animationBindings) {
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

    for (const binding of this.compiled.visibilityBindings) {
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

    return {
      irVersion: 'msfs-runtime/v1',
      animationValues: new Map(this.animationValues),
      nodeVisibilities: new Map(this.nodeVisibilities),
      diagnostics: this.compiled.diagnostics
    }
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

  executeInteraction(target: string, options: { readonly holdFeedback?: boolean } = {}): boolean {
    const binding = this.findInteractionBindingForTarget(target)
    if (binding == null) {
      return false
    }

    this.executeInteractionBinding(binding, options)
    return true
  }

  executeInteractionForObject(
    object: Object3D,
    options: { readonly holdFeedback?: boolean } = {}
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
        invokeKeyEvent: (name, args) => this.hostServices.invokeKeyEvent?.(name, args)
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
    options: { readonly holdFeedback?: boolean } = {}
  ): void {
    this.triggerInteractionFeedback(binding, options.holdFeedback === true ? 'hold' : 'pulse')
    evaluateCompiledExpression(binding.expression, {
      readVariable: (key, unit) => this.hostServices.readVariable(key, unit),
      writeVariable: (key, value, unit) => this.hostServices.writeVariable(key, value, unit),
      invokeKeyEvent: (name, args) => this.hostServices.invokeKeyEvent?.(name, args)
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
    if (binding.releaseExpression == null) {
      return
    }

    evaluateCompiledExpression(binding.releaseExpression, {
      readVariable: (key, unit) => this.hostServices.readVariable(key, unit),
      writeVariable: (key, value, unit) => this.hostServices.writeVariable(key, value, unit),
      invokeKeyEvent: (name, args) => this.hostServices.invokeKeyEvent?.(name, args)
    })
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
}

export class SharedMsfsRuntimeHost implements RuntimeHostServices {
  private elapsedSeconds = 0
  private readonly values = new Map<string, number>()
  private readonly defaultedKeys = new Set<string>()
  private readonly engineProfile: DemoEngineProfile
  private readonly wingFlexProfile: DemoWingFlexProfile
  private variableReadCount = 0
  private variableWriteCount = 0
  private keyEventCount = 0
  private bridgeCallCount = 0
  private defaultedVariableCount = 0
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
    this.seedPreviewFlightState(aircraft?.previewFlightState ?? null)
  }

  tick(dtSeconds: number): void {
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
      // Default the standalone viewer to a stable in-flight cruise pose.
      gearCycle: this.controlState.gearPosition,
      flapCycle: this.controlState.flapsPosition,
      spoilerCycle: this.controlState.spoilersPosition,
      engineCycle: this.engineProfile.cruiseN1Percent,
      aileronCycle: this.controlState.aileronPosition,
      elevatorCycle: this.controlState.elevatorPosition,
      rudderCycle: this.controlState.rudderPosition,
      reverserCycle: 0,
      dtSeconds
    }

    this.values.set(normalizeRuntimeVariableKey('A:ANIMATION DELTA TIME'), dtSeconds)
    this.publishControlVariables()
  }

  readVariable(key: string, unit?: string | null): number {
    this.variableReadCount += 1
    const normalizedKey = normalizeRuntimeVariableKey(key)
    if (!this.values.has(normalizedKey)) {
      const resolved = this.resolveHeuristicValue(normalizedKey, unit ?? null, this.cycles)

      if (!resolved.handled || isRuntimeStoredVariableKey(normalizedKey)) {
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

      return resolved.value
    }

    return this.values.get(normalizedKey) ?? 0
  }

  writeVariable(key: string, value: number, unit?: string | null): void {
    this.variableWriteCount += 1
    const normalizedKey = normalizeRuntimeVariableKey(key)
    const numericValue = Number(value)
    this.values.set(normalizedKey, Number.isFinite(numericValue) ? numericValue : 0)
    this.applyVariableSideEffects(normalizedKey, numericValue, unit ?? null)
  }

  invokeKeyEvent(name: string, args: readonly number[]): void {
    this.keyEventCount += 1
    const value = args.at(-1) ?? 1
    const normalizedEventName = normalizeKeyEventName(name)
    this.values.set(normalizeRuntimeVariableKey(`K:${normalizedEventName}`), value)
    this.applyKeyEvent(normalizedEventName, args)
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
      bridgeCallCount: this.bridgeCallCount,
      storedVariableCount: this.values.size,
      defaultedVariableCount: this.defaultedVariableCount,
      controlState: { ...this.controlState }
    }
  }

  getSnapshot(): Record<string, number> {
    return Object.fromEntries(this.values)
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
      }
    }
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
    const upperKey = normalizeRuntimeVariableKey(key)

    if (upperKey === 'A:ANIMATION DELTA TIME') return handled(convertTimeUnit(cycles.dtSeconds, unit))
    if (upperKey === 'E:SIMULATION TIME' || upperKey === 'A:E:SIMULATION TIME') {
      return handled(convertTimeUnit(this.elapsedSeconds, unit))
    }
    if (upperKey === 'E:ABSOLUTE TIME' || upperKey === 'A:E:ABSOLUTE TIME') {
      return handled(Date.now() / 1000 + 62135596800)
    }
    if (upperKey === 'A:SIM ON GROUND') return handled(0)
    if (upperKey === 'A:SURFACE RELATIVE GROUND SPEED') return handled(0)
    if (upperKey === 'A:STRUCTURAL ICE PCT') return handled(convertPercentOver100Unit(0, unit))
    if (upperKey === 'A:PITOT ICE PCT') return handled(convertPercentOver100Unit(0, unit))
    if (upperKey === 'A:WINDSHIELD DEICE SWITCH') return handled(0)
    if (upperKey === 'A:STRUCTURAL DEICE SWITCH') return handled(0)
    if (upperKey === 'A:LIGHT BEACON') return handled(1)
    if (upperKey.includes('BRIGHTNESS') || upperKey.includes('POTENTIOMETER')) {
      return handled(normalizeUnit(unit) === 'percent over 100' ? 1 : 100)
    }
    if (isRuntimeStoredVariableKey(upperKey)) {
      const storedValue = this.values.get(upperKey)
      if (storedValue != null) {
        return handled(storedValue)
      }
      const genericStoredValue = resolveGenericStoredVariableFallback(upperKey, unit)
      if (genericStoredValue != null) {
        return handled(genericStoredValue)
      }
    }
    if (upperKey.startsWith('A:CIRCUIT ON:')) return handled(1)
    if (upperKey.startsWith('A:CIRCUIT POWER SETTING:')) return handled(convertPercentUnit(100, unit))
    if (upperKey.startsWith('A:CIRCUIT CONNECTION ON:')) return handled(1)
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
    if (name === 'ELECTRICAL_BUS_TO_CIRCUIT_CONNECTION_TOGGLE') {
      const circuitIndex = Math.trunc(Number(args[0] ?? Number.NaN))
      if (Number.isFinite(circuitIndex)) {
        const circuitKey = normalizeRuntimeVariableKey(`A:CIRCUIT CONNECTION ON:${circuitIndex}`)
        const currentValue = this.values.get(circuitKey) ?? 1
        this.values.set(circuitKey, currentValue > 0 ? 0 : 1)
      }
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

function resolveGenericStoredVariableFallback(key: string, unit: string | null): number | null {
  const normalizedUnit = normalizeUnit(unit)
  if (normalizedUnit.includes('bool')) {
    if (
      key.includes('POWER') ||
      key.includes('POWERED') ||
      key.includes('ELECTRIC') ||
      key.includes('ELEC') ||
      key.includes('BUS') ||
      key.includes('CIRCUIT') ||
      key.includes('HEALTHY') ||
      key.includes('AVAILABLE') ||
      key.includes('VALID')
    ) {
      return 1
    }
    return 0
  }
  if (key.includes('BRIGHTNESS') || key.includes('POTENTIOMETER')) {
    return normalizedUnit === 'percent over 100' ? 1 : 100
  }
  if (key.includes('POWER') || key.includes('POWERED') || key.includes('ELEC') || key.includes('BUS')) {
    return 1
  }
  return null
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
