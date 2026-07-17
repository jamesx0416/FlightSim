import type { CanonicalCockpitAction, CockpitInteractionMode, CockpitInteractionOperation, CockpitInteractionTarget, CockpitRelativeDirection } from '../input/cockpitInteraction'
import type { AircraftRuntime, RuntimeInteractionValueWatch } from './runtime'
import type { CompiledInteractionBinding, CompiledInteractionRoute, Instruction } from './types'

export interface MsfsInteractionTarget extends CockpitInteractionTarget {
  readonly binding: CompiledInteractionBinding
  readonly bindings: readonly CompiledInteractionBinding[]
}

export type InteractionResolution =
  | { readonly ok: true; readonly target: MsfsInteractionTarget }
  | { readonly ok: false; readonly code: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS'; readonly candidates: readonly string[] }

export interface ExactInteractionResult {
  readonly ok: boolean
  readonly code: 'OK' | 'TARGET_BUSY' | 'OPERATION_UNSUPPORTED' | 'VALUE_NOT_REACHABLE' | 'VALUE_REACHABILITY_UNKNOWN' | 'UNIT_INCOMPATIBLE' | 'NO_PROGRESS' | 'VALUE_CYCLE' | 'CANCELLED' | 'TARGET_LOST'
  readonly requested: number
  readonly previous: number | null
  readonly actual: number | null
  readonly unit: string | null
  readonly executionPath: 'direct-set' | 'increase' | 'decrease' | null
  readonly steps: number
}

export function selectDragRoutes(
  routes: readonly CompiledInteractionRoute[],
  firstSample: boolean
): readonly CompiledInteractionRoute[] {
  const drag = routes.find(route => route.phase === 'drag')
  if (drag == null) return []
  if (!firstSample) return [drag]
  const lock = routes.find(route => route.operation === 'lock')
  return lock == null ? [drag] : [lock, drag]
}

export interface MsfsDragTrajectoryPoint {
  readonly relativeX: number
  readonly relativeY: number
  readonly dragPercent: number
}

export function isSameMsfsInteractionTarget(
  left: CompiledInteractionBinding,
  right: CompiledInteractionBinding
): boolean {
  return left.target === right.target &&
    left.metadata.qualifiedId === right.metadata.qualifiedId
}

export function resolveMsfsAxisPercent(
  axis: 'x' | 'y' | 'z',
  relativeX: number,
  relativeY: number,
  relativeZ: number
): number {
  return axis === 'x' ? relativeX : axis === 'z' ? relativeZ : relativeY
}

export function resolveMsfsLockDragPercent(
  current: number,
  axis: 'x' | 'y' | 'z',
  deltaX: number,
  deltaY: number,
  scalar: number,
  inverted: boolean
): number {
  const delta = axis === 'x' ? deltaX : -deltaY
  return Math.min(1, Math.max(0, current + delta * scalar * (inverted ? -1 : 1)))
}

export function resolveMsfsDragPercent(
  trajectory: readonly MsfsDragTrajectoryPoint[],
  relativeX: number,
  relativeY: number,
  fallback: number,
  offset = 0
): number {
  let bestDistanceSquared = Number.POSITIVE_INFINITY
  let bestPercent = fallback
  for (let index = 1; index < trajectory.length; index += 1) {
    const start = trajectory[index - 1]!
    const end = trajectory[index]!
    const dx = end.relativeX - start.relativeX
    const dy = end.relativeY - start.relativeY
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared <= Number.EPSILON) continue
    const projectedRatio =
      ((relativeX - start.relativeX) * dx + (relativeY - start.relativeY) * dy) / lengthSquared
    const ratio = Math.min(
      index === trajectory.length - 1 ? Number.POSITIVE_INFINITY : 1,
      Math.max(index === 1 ? Number.NEGATIVE_INFINITY : 0, projectedRatio)
    )
    const projectedX = start.relativeX + dx * ratio
    const projectedY = start.relativeY + dy * ratio
    const distanceSquared = (relativeX - projectedX) ** 2 + (relativeY - projectedY) ** 2
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared
      bestPercent = start.dragPercent + (end.dragPercent - start.dragPercent) * ratio
    }
  }
  const result = bestPercent + offset
  if (result <= Number.EPSILON) return 0
  if (result >= 1 - Number.EPSILON) return 1
  return result
}

export class MsfsInteractionAdapter {
  private readonly cancellations = new Map<string, number>()
  private readonly cancellationWaiters = new Map<string, Set<() => void>>()
  private readonly busy = new Set<string>()
  private readonly held = new Set<string>()
  private mode: CockpitInteractionMode = 'legacy'

  constructor(
    private readonly runtimeSource: AircraftRuntime | (() => AircraftRuntime),
    private readonly settleOverride?: (seconds: number) => Promise<void>,
    private readonly traceSink?: (record: () => Readonly<Record<string, unknown>>) => void
  ) {}

  private get runtime(): AircraftRuntime { return typeof this.runtimeSource === 'function' ? this.runtimeSource() : this.runtimeSource }

  setMode(mode: CockpitInteractionMode): void { this.mode = mode }

  list(): readonly MsfsInteractionTarget[] {
    const bindings = this.runtime.getInteractionBindings()
    return bindings.filter((binding, index) =>
      bindings.findIndex(candidate => candidate.metadata.qualifiedId === binding.metadata.qualifiedId) === index
    ).map(binding => this.toTarget(binding))
  }

  resolve(id: string): InteractionResolution {
    const bindings = this.runtime.getInteractionBindings()
    const qualified = bindings.find(binding => binding.metadata.qualifiedId === id)
    if (qualified != null) return { ok: true, target: this.toTarget(qualified) }
    const authored = this.list().filter(target => target.binding.metadata.authoredId === id)
    if (authored.length === 1) return { ok: true, target: authored[0]! }
    if (authored.length > 1) return { ok: false, code: 'TARGET_AMBIGUOUS', candidates: authored.map(target => target.id) }
    return { ok: false, code: 'TARGET_NOT_FOUND', candidates: [] }
  }

  fromBinding(binding: CompiledInteractionBinding): MsfsInteractionTarget {
    return this.toTarget(binding)
  }

  execute(target: MsfsInteractionTarget, action: CanonicalCockpitAction): boolean {
    const selected = target.bindings
      .map(binding => ({ binding, route: selectRoute(binding.metadata.routes, action, this.mode, target.lockable) }))
      .find(value => value.route != null)
    if (selected?.route != null &&
        (action.operation === 'increase' || action.operation === 'decrease') &&
        selected.binding.metadata.discreteGate != null) {
      const executed = this.executeGateStep(selected.binding, action.operation)
      this.traceExecution(target, action, selected.binding, selected.route, executed, 'gate')
      return executed
    }
    if (selected?.route == null) {
      const toggle = target.bindings.find(binding => binding.metadata.wheelPrimaryToggle)
      const executed = toggle == null || (action.operation !== 'increase' && action.operation !== 'decrease')
        ? false
        : this.executePrimaryToggleDirection(toggle, action.operation)
      this.traceExecution(target, action, toggle ?? target.binding, null, executed, 'fallback')
      return executed
    }
    const actionValue = typeof action.value === 'boolean'
      ? Number(action.value)
      : typeof action.value === 'number'
        ? action.value
        : undefined
    const value = action.axisValue ?? action.delta ?? actionValue
    const executed = this.runtime.executeInteractionBindingDirect(selected.binding, {
      holdFeedback: action.phase === 'hold' || action.phase === 'drag',
      mouseEvent: selected.route.msfsEvent ?? undefined,
      inputType: selected.route.inputTypes[0],
      relativeX: action.axis === 'x' ? value : undefined,
      relativeY: action.axis === 'y' ? value : undefined,
      relativeZ: action.axis === 'z' ? value : undefined,
      dragPercent: action.dragPercent,
      parameterValues: actionValue == null ? undefined : [actionValue]
    })
    if (executed && action.operation === 'hold' && action.phase === 'hold') {
      this.held.add(target.id)
    }
    this.traceExecution(target, action, selected.binding, selected.route, executed, 'route')
    return executed
  }

  route(target: MsfsInteractionTarget, action: CanonicalCockpitAction): CompiledInteractionRoute | null {
    for (const binding of target.bindings) {
      const route = selectRoute(binding.metadata.routes, action, this.mode, target.lockable)
      if (route != null) return route
    }
    if ((action.operation === 'increase' || action.operation === 'decrease') &&
        target.bindings.some(binding => binding.metadata.wheelPrimaryToggle)) {
      return compatibleWheelRoute(action.operation)
    }
    return null
  }

  private executeGateStep(
    binding: CompiledInteractionBinding,
    operation: 'increase' | 'decrease'
  ): boolean {
    const gate = binding.metadata.discreteGate
    const current = this.runtime.readInteractionValue(binding)
    if (gate == null || current == null) return false
    const next = Math.min(gate.steps, Math.max(0, Math.round(current) + (operation === 'increase' ? 1 : -1)))
    if (next === Math.round(current)) return true
    const inputType = this.mode === 'lock' ? 1 : 0
    const common = { inputType, holdFeedback: false }
    const locked = this.runtime.executeInteractionBindingDirect(binding, {
      ...common,
      mouseEvent: 'Lock',
      relativeY: 0,
      dragPercent: current / gate.steps
    })
    const dragged = this.runtime.executeInteractionBindingDirect(binding, {
      ...common,
      mouseEvent: 'LeftDrag',
      relativeY: -(next - current) / gate.dragSpeed,
      dragPercent: next / gate.steps
    })
    this.runtime.executeInteractionBindingDirect(binding, { ...common, mouseEvent: 'Unlock' })
    return locked && dragged
  }

  private executePrimaryToggleDirection(
    binding: CompiledInteractionBinding,
    operation: 'increase' | 'decrease'
  ): boolean {
    const current = this.runtime.readInteractionValue(binding)
    if (current == null) return false
    const desired = operation === 'increase'
    if ((current !== 0) === desired) return true
    const route = binding.metadata.routes.find(candidate =>
      candidate.operation === 'press' &&
      (candidate.msfsEvent === 'LeftSingle' || candidate.interactionModel === 'default')
    )
    return route != null && this.runtime.executeInteractionBindingDirect(binding, {
      holdFeedback: false,
      mouseEvent: route.msfsEvent ?? undefined,
      inputType: route.inputTypes[0]
    })
  }

  release(target: MsfsInteractionTarget): boolean {
    this.held.delete(target.id)
    return target.bindings.map(binding => this.runtime.releaseInteractionBinding(binding)).some(Boolean)
  }

  currentValue(target: MsfsInteractionTarget): number | null {
    for (const binding of target.bindings) {
      const value = this.runtime.readInteractionValue(binding)
      if (value != null) return value
    }
    return null
  }

  resolveRelativeOperation(
    target: MsfsInteractionTarget,
    direction: CockpitRelativeDirection | undefined
  ): 'increase' | 'decrease' {
    if (direction === 'increase' || direction === 'decrease') return direction
    const positive = direction === 'right' || direction === 'up'
    const increase = target.binding.metadata.inverted ? !positive : positive
    return increase ? 'increase' : 'decrease'
  }

  active(): readonly string[] { return [...this.busy] }

  cancel(target: MsfsInteractionTarget): void {
    this.traceSink?.(() => ({ kind: 'interaction-cancel', target: target.id }))
    this.signalCancellation(target.id)
    if (!this.held.delete(target.id)) return
    const runtime = this.runtime as AircraftRuntime & {
      cancelInteractionBinding?: (binding: CompiledInteractionBinding) => boolean
    }
    if (typeof runtime.cancelInteractionBinding === 'function') {
      for (const binding of target.bindings) runtime.cancelInteractionBinding(binding)
    } else {
      this.release(target)
    }
  }

  cancelAll(): void {
    for (const target of this.list()) {
      this.signalCancellation(target.id)
    }
  }

  async adjustExact(
    target: MsfsInteractionTarget,
    delta: number,
    unit?: string,
    channel?: CanonicalCockpitAction['channel']
  ): Promise<ExactInteractionResult> {
    const current = this.authoritativeValue(target)
    if (current == null) return exactResult('VALUE_REACHABILITY_UNKNOWN', current, current, delta, target, null, 0)
    return this.setExact(target, current + delta, unit, channel, current)
  }

  async setBooleanState(
    target: MsfsInteractionTarget,
    desired: boolean,
    channel?: CanonicalCockpitAction['channel']
  ): Promise<ExactInteractionResult> {
    if (this.busy.has(target.id)) return exactResult('TARGET_BUSY', null, this.authoritativeValue(target), Number(desired), target, null, 0)
    this.busy.add(target.id)
    try {
    const valueBinding = this.valueBinding(target)
    const previous = this.authoritativeValue(target)
    const requested = Number(desired)
    const generation = this.cancellations.get(target.id) ?? 0
    if (valueBinding == null || previous == null) return exactResult('VALUE_REACHABILITY_UNKNOWN', null, null, requested, target, null, 0)
    if (Boolean(previous) === desired) return exactResult('OK', previous, previous, requested, target, 'direct-set', 0)
    const explicitOperation = desired ? 'on' : 'off'
    const explicit = selectRoute(target.binding.metadata.routes, canonical(explicitOperation, channel), this.mode, target.lockable)
    const toggle = selectRoute(target.binding.metadata.routes, canonical('toggle', channel), this.mode, target.lockable)
    const operation = explicit != null ? explicitOperation : toggle != null ? 'toggle' : null
    if (operation == null) return exactResult('OPERATION_UNSUPPORTED', previous, previous, requested, target, null, 0)
    const watch = this.beginValueWatch(valueBinding)
    if (!this.isAuthoritativeWatch(watch)) {
      watch?.dispose()
      return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
    }
    if (!this.execute(target, canonical(operation, channel))) {
      watch?.dispose()
      return exactResult('OPERATION_UNSUPPORTED', previous, previous, requested, target, null, 0)
    }
    const settled = await this.waitForSettle(target, target.binding, generation)
    const notified = watch?.didChange() ?? true
    watch?.dispose()
    if (!settled) return exactResult('CANCELLED', previous, this.authoritativeValue(target), requested, target, 'direct-set', 1)
    const actual = this.authoritativeValue(target)
    const code = !Object.is(actual, previous) && !notified
      ? 'VALUE_REACHABILITY_UNKNOWN'
      : actual != null && Boolean(actual) === desired
      ? 'OK'
      : Object.is(actual, previous)
        ? 'NO_PROGRESS'
        : 'VALUE_NOT_REACHABLE'
    return exactResult(code, previous, actual, requested, target, 'direct-set', 1)
    } finally {
      this.busy.delete(target.id)
    }
  }

  async setExact(
    target: MsfsInteractionTarget,
    requested: number,
    unit?: string,
    channel?: CanonicalCockpitAction['channel'],
    knownPrevious?: number
  ): Promise<ExactInteractionResult> {
    if (this.busy.has(target.id)) return exactResult('TARGET_BUSY', null, this.authoritativeValue(target), requested, target, null, 0)
    this.busy.add(target.id)
    try {
    const valueBinding = this.valueBinding(target)
    if (valueBinding == null) {
      return exactResult('VALUE_REACHABILITY_UNKNOWN', null, null, requested, target, null, 0)
    }
    const metadata = valueBinding.metadata.value
    if (unit != null && metadata.unit == null) {
      return exactResult('VALUE_REACHABILITY_UNKNOWN', null, null, requested, target, null, 0)
    }
    if (unit != null && unit.toLowerCase() !== metadata.unit?.toLowerCase()) {
      return exactResult('UNIT_INCOMPATIBLE', null, null, requested, target, null, 0)
    }
    const previous = knownPrevious ?? this.authoritativeValue(target)
    if (previous == null) return exactResult('VALUE_REACHABILITY_UNKNOWN', null, null, requested, target, null, 0)
    if (Object.is(previous, requested)) return exactResult('OK', previous, previous, requested, target, 'direct-set', 0)
    if ((metadata.minimum != null && requested < metadata.minimum) || (metadata.maximum != null && requested > metadata.maximum)) {
      return exactResult('VALUE_NOT_REACHABLE', previous, previous, requested, target, null, 0)
    }

    const generation = this.cancellations.get(target.id) ?? 0
    const stateBinding = target.bindings.find(binding =>
      binding.metadata.value.setStates?.some(state => Object.is(state.value, requested))
    )
    if (stateBinding != null) {
      const watch = this.beginValueWatch(valueBinding)
      if (!this.isAuthoritativeWatch(watch)) {
        watch?.dispose()
        return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
      }
      const runtime = this.runtime as AircraftRuntime & {
        executeInteractionSetState?: (binding: CompiledInteractionBinding, value: number) => boolean
      }
      const executed = runtime.executeInteractionSetState?.(stateBinding, requested) === true
      this.traceExecution(target, canonical('set', channel, requested), stateBinding, null, executed, 'static-state')
      if (!executed) {
        watch?.dispose()
        return exactResult('OPERATION_UNSUPPORTED', previous, previous, requested, target, null, 0)
      }
      const settled = await this.waitForSettle(target, stateBinding, generation)
      const notified = watch?.didChange() ?? true
      watch?.dispose()
      if (!settled) return exactResult('CANCELLED', previous, this.authoritativeValue(target), requested, target, 'direct-set', 1)
      const actual = this.authoritativeValue(target)
      const code = !Object.is(actual, previous) && !notified
        ? 'VALUE_REACHABILITY_UNKNOWN'
        : Object.is(actual, requested)
        ? 'OK'
        : Object.is(actual, previous)
          ? 'NO_PROGRESS'
          : 'VALUE_NOT_REACHABLE'
      return exactResult(code, previous, actual, requested, target, 'direct-set', 1)
    }

    if (metadata.minimum == null || metadata.maximum == null || metadata.maximum < metadata.minimum ||
        previous < metadata.minimum || previous > metadata.maximum) {
      return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
    }
    const setAction = canonical('set', channel, requested)
    const setCandidates = target.bindings
      .map(binding => ({ binding, route: selectRoute(binding.metadata.routes, setAction, this.mode, target.lockable) }))
    const setSelection = setCandidates
      .find(selection => selection.route != null && compiledInstructionsDirectlyMutateParameter(selection.binding.expression.instructions, 0))
    const hasUnprovenSetRoute = setSelection == null && setCandidates.some(selection => selection.route != null)
    if (setSelection?.route != null) {
      const watch = this.beginValueWatch(valueBinding)
      if (!this.isAuthoritativeWatch(watch)) {
        watch?.dispose()
        return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
      }
      const executed = this.runtime.executeInteractionBindingDirect(setSelection.binding, {
        holdFeedback: false,
        mouseEvent: setSelection.route.msfsEvent ?? undefined,
        inputType: setSelection.route.inputTypes[0],
        parameterValues: [requested]
      })
      this.traceExecution(target, setAction, setSelection.binding, setSelection.route, executed, 'direct-set')
      if (!executed) {
        watch?.dispose()
        return exactResult('OPERATION_UNSUPPORTED', previous, previous, requested, target, null, 0)
      }
      const settled = await this.waitForSettle(target, setSelection.binding, generation)
      const notified = watch?.didChange() ?? true
      watch?.dispose()
      if (!settled) return exactResult('CANCELLED', previous, this.authoritativeValue(target), requested, target, 'direct-set', 1)
      const actual = this.authoritativeValue(target)
      const code = !Object.is(actual, previous) && !notified
        ? 'VALUE_REACHABILITY_UNKNOWN'
        : Object.is(actual, requested)
          ? 'OK'
          : Object.is(actual, previous)
            ? 'NO_PROGRESS'
            : 'VALUE_NOT_REACHABLE'
      return exactResult(code, previous, actual, requested, target, 'direct-set', 1)
    }

    if (metadata.cyclic && metadata.cyclicUpperInclusive !== true) {
      return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
    }
    const routeSelection = (operation: 'increase' | 'decrease') => target.bindings
      .map(binding => ({
        binding,
        route: selectRoute(binding.metadata.routes, canonical(operation, channel), this.mode, target.lockable)
      }))
      .find(selection => selection.route != null) ?? null
    const increaseSelection = routeSelection('increase')
    const decreaseSelection = routeSelection('decrease')
    const requestedOperation = requested >= previous ? 'increase' : 'decrease'
    if (!metadata.cyclic && (requestedOperation === 'increase' ? increaseSelection : decreaseSelection) == null) {
      return exactResult(
        hasUnprovenSetRoute ? 'VALUE_REACHABILITY_UNKNOWN' : 'OPERATION_UNSUPPORTED',
        previous,
        previous,
        requested,
        target,
        null,
        0
      )
    }
    if (metadata.cyclic && (increaseSelection == null || decreaseSelection == null)) {
      return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
    }
    const increaseStep = increaseSelection == null
      ? null
      : increaseSelection.binding.metadata.value.increaseStep ?? increaseSelection.binding.metadata.value.step
    const decreaseStep = decreaseSelection == null
      ? null
      : decreaseSelection.binding.metadata.value.decreaseStep ?? decreaseSelection.binding.metadata.value.step
    if ((!metadata.cyclic && (requestedOperation === 'increase' ? increaseStep : decreaseStep) == null) ||
        metadata.cyclic && (increaseStep == null || decreaseStep == null)) {
      return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
    }
    const plan = planExactSteps(
      previous,
      requested,
      increaseStep,
      decreaseStep,
      metadata.minimum,
      metadata.maximum,
      metadata.cyclic
    )
    if (plan == null) return exactResult('VALUE_NOT_REACHABLE', previous, previous, requested, target, null, 0)
    const routeOperation = plan.operation
    const selectedRoute = routeOperation === 'increase' ? increaseSelection : decreaseSelection
    if (selectedRoute?.route == null) {
      return exactResult('OPERATION_UNSUPPORTED', previous, previous, requested, target, null, 0)
    }

    const visited = new Set<string>([`${routeOperation}:${previous}`])
    let actual = previous
    for (let index = 0; index < plan.steps; index += 1) {
      if ((this.cancellations.get(target.id) ?? 0) !== generation) return exactResult('CANCELLED', previous, actual, requested, target, routeOperation, index)
      const watch = this.beginValueWatch(valueBinding)
      if (!this.isAuthoritativeWatch(watch)) {
        watch?.dispose()
        return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, actual, requested, target, null, index)
      }
      const executed = selectedRoute.binding.metadata.discreteGate != null
        ? this.executeGateStep(selectedRoute.binding, routeOperation)
        : this.runtime.executeInteractionBindingDirect(selectedRoute.binding, {
            holdFeedback: false,
            mouseEvent: selectedRoute.route.msfsEvent ?? undefined,
            inputType: selectedRoute.route.inputTypes[0]
          })
      this.traceExecution(
        target,
        canonical(routeOperation, channel),
        selectedRoute.binding,
        selectedRoute.route,
        executed,
        'exact-step'
      )
      if (!executed) {
        watch?.dispose()
        return exactResult('TARGET_LOST', previous, actual, requested, target, routeOperation, index)
      }
      const settled = await this.waitForSettle(target, selectedRoute.binding, generation)
      const notified = watch?.didChange() ?? true
      watch?.dispose()
      if (!settled) return exactResult('CANCELLED', previous, this.authoritativeValue(target), requested, target, routeOperation, index + 1)
      const next = this.authoritativeValue(target)
      if (next == null) return exactResult('TARGET_LOST', previous, null, requested, target, routeOperation, index + 1)
      if (Object.is(next, actual)) return exactResult('NO_PROGRESS', previous, next, requested, target, routeOperation, index + 1)
      if (!notified) return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, next, requested, target, routeOperation, index + 1)
      actual = next
      if (Object.is(actual, requested)) return exactResult('OK', previous, actual, requested, target, routeOperation, index + 1)
      const key = `${routeOperation}:${actual}`
      if (visited.has(key)) return exactResult('VALUE_CYCLE', previous, actual, requested, target, routeOperation, index + 1)
      visited.add(key)
    }
    return exactResult(Object.is(actual, requested) ? 'OK' : 'VALUE_NOT_REACHABLE', previous, actual, requested, target, routeOperation, plan.steps)
    } finally {
      this.busy.delete(target.id)
    }
  }

  private beginValueWatch(binding: CompiledInteractionBinding): RuntimeInteractionValueWatch | null {
    const runtime = this.runtime as AircraftRuntime & {
      watchInteractionValue?: (binding: CompiledInteractionBinding) => RuntimeInteractionValueWatch
    }
    return typeof runtime.watchInteractionValue === 'function'
      ? runtime.watchInteractionValue(binding)
      : null
  }

  private traceExecution(
    target: MsfsInteractionTarget,
    action: CanonicalCockpitAction,
    binding: CompiledInteractionBinding,
    route: CompiledInteractionRoute | null,
    executed: boolean,
    path: string
  ): void {
    this.traceSink?.(() => ({
      kind: 'canonical-action',
      action,
      target: target.id,
      executed,
      path,
      route,
      provenance: {
        sourcePath: binding.sourcePath,
        sourceKind: binding.metadata.sourceKind,
        sourceTemplate: binding.metadata.sourceTemplate
      }
    }))
  }

  private valueBinding(target: MsfsInteractionTarget): CompiledInteractionBinding | null {
    return target.bindings.find(binding => binding.metadata.value.stateExpression != null) ?? null
  }

  private authoritativeValue(target: MsfsInteractionTarget): number | null {
    const binding = this.valueBinding(target)
    if (binding == null) return null
    const runtime = this.runtime as AircraftRuntime & {
      readAuthoritativeInteractionValue?: (binding: CompiledInteractionBinding) => number | null
    }
    return runtime.readAuthoritativeInteractionValue?.(binding) ?? runtime.readInteractionValue(binding)
  }

  private isAuthoritativeWatch(watch: RuntimeInteractionValueWatch | null): boolean {
    return this.settleOverride != null || watch?.authoritative === true
  }

  private async waitForSettle(
    target: MsfsInteractionTarget,
    binding: CompiledInteractionBinding,
    generation: number
  ): Promise<boolean> {
    const runtime = this.runtime as AircraftRuntime & {
      waitForInteractionSettle?: (seconds: number) => Promise<void>
    }
    const settle = this.settleOverride != null
      ? this.settleOverride(binding.metadata.value.settleTimeSeconds)
      : runtime.waitForInteractionSettle?.(binding.metadata.value.settleTimeSeconds)
    if (settle == null) return false
    let cancel = (): void => {}
    const cancelled = new Promise<false>(resolve => { cancel = () => resolve(false) })
    const waiters = this.cancellationWaiters.get(target.id) ?? new Set<() => void>()
    waiters.add(cancel)
    this.cancellationWaiters.set(target.id, waiters)
    if ((this.cancellations.get(target.id) ?? 0) !== generation) cancel()
    const completed = await Promise.race([settle.then(() => true as const), cancelled])
    waiters.delete(cancel)
    if (waiters.size === 0) this.cancellationWaiters.delete(target.id)
    return completed && (this.cancellations.get(target.id) ?? 0) === generation
  }

  private signalCancellation(targetId: string): void {
    this.cancellations.set(targetId, (this.cancellations.get(targetId) ?? 0) + 1)
    for (const cancel of this.cancellationWaiters.get(targetId) ?? []) cancel()
    this.cancellationWaiters.delete(targetId)
  }

  private toTarget(binding: CompiledInteractionBinding): MsfsInteractionTarget {
    const bindings = [binding, ...this.runtime.getInteractionBindings().filter(candidate =>
      candidate !== binding &&
      isSameMsfsInteractionTarget(candidate, binding)
    )]
    return {
      id: binding.metadata.qualifiedId,
      lockable: bindings.some(candidate => candidate.metadata.lockable),
      operations: [...new Set([
        ...bindings.flatMap(candidate => candidate.metadata.routes.map(route => route.operation)),
        ...(bindings.some(candidate => candidate.metadata.wheelPrimaryToggle)
          ? ['increase' as const, 'decrease' as const]
          : [])
      ])],
      binding,
      bindings
    }
  }
}

function canonical(
  operation: CanonicalCockpitAction['operation'],
  channel?: CanonicalCockpitAction['channel'],
  value?: number
): CanonicalCockpitAction {
  return { source: 'devapi', operation, phase: 'press', channel, value, timestampMs: performance.now() }
}

function exactResult(
  code: ExactInteractionResult['code'],
  previous: number | null,
  actual: number | null,
  requested: number,
  target: MsfsInteractionTarget,
  executionPath: ExactInteractionResult['executionPath'],
  steps: number
): ExactInteractionResult {
  const valueBinding = target.bindings.find(binding => binding.metadata.value.stateExpression != null)
  return {
    ok: code === 'OK',
    code,
    requested,
    previous,
    actual,
    unit: valueBinding?.metadata.value.unit ?? null,
    executionPath,
    steps
  }
}

function planExactSteps(
  current: number,
  requested: number,
  increaseStep: number | null,
  decreaseStep: number | null,
  minimum: number,
  maximum: number,
  cyclic: boolean
): { readonly operation: 'increase' | 'decrease'; readonly steps: number } | null {
  const simulate = (
    operation: 'increase' | 'decrease',
    step: number | null
  ): number | null => {
    if (step == null || !Number.isFinite(step) || step <= 0) return null
    const visited = new Set<number>([current])
    let value = current
    for (let steps = 1; steps <= 10_000; steps += 1) {
      let next = value + (operation === 'increase' ? step : -step)
      if (cyclic) {
        if (next > maximum) next = minimum
        if (next < minimum) next = maximum
      } else {
        next = Math.min(maximum, Math.max(minimum, next))
      }
      if (Object.is(next, requested)) return steps
      if (Object.is(next, value) || visited.has(next)) return null
      visited.add(next)
      value = next
    }
    return null
  }
  if (!cyclic) {
    const operation = requested >= current ? 'increase' : 'decrease'
    const steps = simulate(operation, operation === 'increase' ? increaseStep : decreaseStep)
    return steps == null ? null : { operation, steps }
  }
  const increase = simulate('increase', increaseStep)
  const decrease = simulate('decrease', decreaseStep)
  if (increase == null && decrease == null) return null
  if (decrease == null || increase != null && increase <= decrease) {
    return { operation: 'increase', steps: increase! }
  }
  return { operation: 'decrease', steps: decrease }
}

function compiledInstructionsDirectlyMutateParameter(
  instructions: readonly Instruction[],
  parameterIndex: number
): boolean {
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index]
    if (instruction?.op === 'pushParameter' && instruction.index === parameterIndex) {
      const mutation = instructions[index + 1]
      if (mutation?.op === 'writeVariable' ||
          mutation?.op === 'invokeHtmlEvent' ||
          mutation?.op === 'invokeKeyEvent' && mutation.argCount > 0) return true
    }
    if (instruction?.op === 'if' && (
      compiledInstructionsDirectlyMutateParameter(instruction.thenInstructions, parameterIndex) ||
      compiledInstructionsDirectlyMutateParameter(instruction.elseInstructions, parameterIndex)
    )) return true
  }
  return false
}

function selectRoute(
  routes: readonly CompiledInteractionRoute[],
  action: CanonicalCockpitAction,
  mode: CockpitInteractionMode,
  lockable: boolean
): CompiledInteractionRoute | null {
  const operation: CockpitInteractionOperation = action.operation === 'hold' && action.phase !== 'repeat'
    ? 'press'
    : action.operation
  const interactionModel = mode === 'lock' && lockable ? 'drag' : 'default'
  const isWheelOperation = operation === 'increase' || operation === 'decrease'
  const matchesAction = (route: CompiledInteractionRoute): boolean =>
    (route.operation === operation || (operation === 'turn' && route.phase === 'drag')) &&
    (action.phase === 'double'
      ? route.phase === 'double'
      : action.phase === 'repeat'
        ? route.phase === 'repeat'
        : route.phase !== 'double' && route.phase !== 'repeat') &&
    (action.channel == null || route.channel === action.channel)
  let candidates = routes.filter(route =>
    (isWheelOperation || route.interactionModel == null || route.interactionModel === interactionModel) &&
    matchesAction(route)
  )
  if (candidates.length === 0 && interactionModel === 'drag' && operation === 'press') {
    candidates = routes.filter(route =>
      (route.interactionModel == null || route.interactionModel === 'default') && matchesAction(route)
    )
  }
  const modelSpecificCandidates = candidates.filter(
    route => route.interactionModel === interactionModel
  )
  if (modelSpecificCandidates.length > 0) candidates = modelSpecificCandidates
  if (candidates.length === 1) return candidates[0] ?? null
  const authoredEvents = candidates.filter(route => route.msfsEvent != null)
  if (authoredEvents.length === 1) return authoredEvents[0] ?? null
  const semanticDefaults = candidates.filter(route => route.channel == null)
  return semanticDefaults.length === 1 ? semanticDefaults[0] ?? null : null
}

function compatibleWheelRoute(
  operation: 'increase' | 'decrease'
): CompiledInteractionRoute {
  return {
    channel: null,
    phase: null,
    operation,
    msfsEvent: operation === 'increase' ? 'WheelUp' : 'WheelDown',
    axis: null,
    inputTypes: []
  }
}
