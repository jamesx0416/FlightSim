import type { CanonicalCockpitAction, CockpitInteractionChannel, CockpitInteractionMode, CockpitInteractionOperation, CockpitInteractionTarget, CockpitRelativeDirection } from '../input/cockpitInteraction'
import { convertSimUnit, type SimUnit } from '../sim/engine'
import { evaluateCompiledExpression } from './rpn'
import type { AircraftRuntime, RuntimeInteractionValueWatch } from './runtime'
import type { CompiledExpression, CompiledInteractionBinding, CompiledInteractionMetadata, CompiledInteractionRoute, Instruction } from './types'

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

export interface MsfsGateDragCapture {
  readonly minimum: number
  readonly maximum: number
  readonly gate: NonNullable<CompiledInteractionMetadata['discreteGate']>
}

export function resolveMsfsGateDragRange(
  position: number,
  gate: NonNullable<CompiledInteractionMetadata['discreteGate']>
): { readonly minimum: number; readonly maximum: number } | null {
  if (!Number.isFinite(position) || position < 0 || position > gate.steps ||
      !Number.isInteger(gate.steps) || gate.steps <= 0 ||
      gate.tolerance == null || gate.tolerance < 0 || gate.direction == null) {
    return null
  }
  const nearest = Math.round(position)
  const nearGate = Math.abs(nearest - position) < gate.tolerance
  let maximum = gate.direction === -1
    ? gate.steps
    : Math.min(gate.steps, (nearGate ? nearest + 1 : Math.ceil(position)))
  let minimum = gate.direction === 1
    ? 0
    : Math.max(0, (nearGate ? nearest - 1 : Math.floor(position)))
  if (gate.ignoredGate != null) {
    if (maximum === gate.ignoredGate) maximum = Math.min(gate.steps, maximum + 1)
    if (minimum === gate.ignoredGate) minimum = Math.max(0, minimum - 1)
  }
  return minimum <= maximum ? { minimum, maximum } : null
}

export function clampMsfsGateDragPercent(
  dragPercent: number,
  previousDragPercent: number,
  capture: MsfsGateDragCapture
): { readonly dragPercent: number; readonly capture: MsfsGateDragCapture } {
  const range = resolveMsfsGateDragRange(previousDragPercent * capture.gate.steps, capture.gate)
  const nextCapture = range == null
    ? capture
    : {
        ...capture,
        minimum: Math.max(capture.minimum, range.minimum / capture.gate.steps),
        maximum: Math.min(capture.maximum, range.maximum / capture.gate.steps)
      }
  const constrained = Math.min(nextCapture.maximum, Math.max(nextCapture.minimum, dragPercent))
  return { dragPercent: constrained, capture: nextCapture }
}

export function msfsInteractionTargetKey(binding: CompiledInteractionBinding): string {
  const groupId = binding.metadata.groupId?.trim()
  return groupId
    ? `group:${binding.sourcePath}#${groupId}`
    : `binding:${binding.metadata.qualifiedId}#${binding.target}`
}

export function isSameMsfsInteractionTarget(
  left: CompiledInteractionBinding,
  right: CompiledInteractionBinding
): boolean {
  return msfsInteractionTargetKey(left) === msfsInteractionTargetKey(right)
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
  fallback: number
): number {
  const first = trajectory[0]
  const last = trajectory.at(-1)
  const useHorizontalAxis = first != null && last != null &&
    Math.abs(last.relativeX - first.relativeX) >= Math.abs(last.relativeY - first.relativeY)
  const pointerCoordinate = useHorizontalAxis ? relativeX : relativeY
  let bestDistanceSquared = Number.POSITIVE_INFINITY
  let bestPercent = fallback
  for (let index = 1; index < trajectory.length; index += 1) {
    const start = trajectory[index - 1]!
    const end = trajectory[index]!
    const startCoordinate = useHorizontalAxis ? start.relativeX : start.relativeY
    const endCoordinate = useHorizontalAxis ? end.relativeX : end.relativeY
    const delta = endCoordinate - startCoordinate
    const lengthSquared = delta * delta
    if (lengthSquared <= Number.EPSILON) continue
    const projectedRatio = (pointerCoordinate - startCoordinate) * delta / lengthSquared
    const ratio = Math.min(
      index === trajectory.length - 1 ? Number.POSITIVE_INFINITY : 1,
      Math.max(index === 1 ? Number.NEGATIVE_INFINITY : 0, projectedRatio)
    )
    const projectedCoordinate = startCoordinate + delta * ratio
    const distanceSquared = (pointerCoordinate - projectedCoordinate) ** 2
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared
      bestPercent = start.dragPercent + (end.dragPercent - start.dragPercent) * ratio
    }
  }
  if (bestPercent <= Number.EPSILON) return 0
  if (bestPercent >= 1 - Number.EPSILON) return 1
  return bestPercent
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
  private arbitrationKey(target: MsfsInteractionTarget): string { return target.arbitrationId ?? target.id }

  setMode(mode: CockpitInteractionMode): void { this.mode = mode }

  list(): readonly MsfsInteractionTarget[] {
    const bindings = this.runtime.getInteractionBindings()
    const seen = new Set<string>()
    return bindings.flatMap(binding => {
      const key = msfsInteractionTargetKey(binding)
      if (seen.has(key)) return []
      seen.add(key)
      return [this.toTarget(binding, bindings)]
    })
  }

  resolve(id: string): InteractionResolution {
    const targets = this.list()
    const qualified = targets.find(target => target.id === id)
    if (qualified != null) return { ok: true, target: qualified }
    const authored = targets.filter(target => target.bindings.some(binding => binding.metadata.authoredId === id))
    if (authored.length === 1) return { ok: true, target: authored[0]! }
    if (authored.length > 1) return { ok: false, code: 'TARGET_AMBIGUOUS', candidates: authored.map(target => target.id) }
    return { ok: false, code: 'TARGET_NOT_FOUND', candidates: [] }
  }

  fromBinding(binding: CompiledInteractionBinding): MsfsInteractionTarget {
    return this.toTarget(binding)
  }

  execute(target: MsfsInteractionTarget, action: CanonicalCockpitAction): boolean {
    const selected = target.bindings
      .map(binding => ({ binding, route: selectRoute(binding.metadata.routes, action, this.mode, target.lockable, binding.metadata.dragFlagsLockable) }))
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
      relativeX: action.relativeX ?? (action.axis === 'x' ? value : undefined),
      relativeY: action.relativeY ?? (action.axis === 'y' ? value : undefined),
      relativeZ: action.relativeZ ?? (action.axis === 'z' ? value : undefined),
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
      const route = selectRoute(binding.metadata.routes, action, this.mode, target.lockable, binding.metadata.dragFlagsLockable)
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

  stop(target: MsfsInteractionTarget): void {
    this.traceSink?.(() => ({ kind: 'interaction-stop', target: target.id }))
    this.signalCancellation(target.id)
    if (!this.held.delete(target.id)) return
    const runtime = this.runtime as AircraftRuntime & {
      stopInteractionBinding?: (binding: CompiledInteractionBinding) => boolean
    }
    if (typeof runtime.stopInteractionBinding === 'function') {
      for (const binding of target.bindings) runtime.stopInteractionBinding(binding)
    }
  }

  stopAll(): void {
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
    const converted = convertExactUnitValue(delta, unit, target.binding.metadata.value.unit)
    if (!converted.ok) return exactResult(converted.code, current, current, delta, target, null, 0)
    return this.setExact(target, current + converted.value, target.binding.metadata.value.unit ?? undefined, channel, current)
  }

  async setBooleanState(
    target: MsfsInteractionTarget,
    desired: boolean,
    channel?: CanonicalCockpitAction['channel']
  ): Promise<ExactInteractionResult> {
    if (this.busy.has(this.arbitrationKey(target))) return exactResult('TARGET_BUSY', null, this.authoritativeValue(target), Number(desired), target, null, 0)
    this.busy.add(this.arbitrationKey(target))
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
      this.busy.delete(this.arbitrationKey(target))
    }
  }

  async setExact(
    target: MsfsInteractionTarget,
    requested: number,
    unit?: string,
    channel?: CanonicalCockpitAction['channel'],
    knownPrevious?: number
  ): Promise<ExactInteractionResult> {
    if (this.busy.has(this.arbitrationKey(target))) return exactResult('TARGET_BUSY', null, this.authoritativeValue(target), requested, target, null, 0)
    this.busy.add(this.arbitrationKey(target))
    try {
    const valueBinding = this.valueBinding(target)
    if (valueBinding == null) {
      return exactResult('VALUE_REACHABILITY_UNKNOWN', null, null, requested, target, null, 0)
    }
    const metadata = valueBinding.metadata.value
    const converted = convertExactUnitValue(requested, unit, metadata.unit)
    if (!converted.ok) return exactResult(converted.code, null, null, requested, target, null, 0)
    requested = converted.value
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
    const increaseStepExpression = increaseSelection?.binding.metadata.value.increaseStepExpression ?? null
    const decreaseStepExpression = decreaseSelection?.binding.metadata.value.decreaseStepExpression ?? null
    if ((!metadata.cyclic && requestedOperation === 'increase' && increaseStep == null && increaseStepExpression == null) ||
        (!metadata.cyclic && requestedOperation === 'decrease' && decreaseStep == null && decreaseStepExpression == null) ||
        metadata.cyclic && (
          increaseStep == null && increaseStepExpression == null ||
          decreaseStep == null && decreaseStepExpression == null
        )) {
      return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
    }
    const hasMutableStepExpression = [increaseStepExpression, decreaseStepExpression]
      .some(expression => expression != null && expression.variableKeys.length > 0)
    const simulatedPlan = hasMutableStepExpression
      ? this.planMutableExactSteps(
          valueBinding,
          previous,
          requested,
          metadata.minimum,
          metadata.maximum,
          metadata.cyclic,
          increaseSelection,
          decreaseSelection
        )
      : undefined
    if (simulatedPlan?.code === 'VALUE_REACHABILITY_UNKNOWN') {
      return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
    }
    if (simulatedPlan?.code === 'VALUE_NOT_REACHABLE') {
      return exactResult('VALUE_NOT_REACHABLE', previous, previous, requested, target, null, 0)
    }
    const plan = simulatedPlan?.code === 'OK'
      ? simulatedPlan
      : planExactSteps(
          previous,
          requested,
          increaseStep,
          decreaseStep,
          increaseStepExpression,
          decreaseStepExpression,
          metadata.minimum,
          metadata.maximum,
          metadata.cyclic,
          (expression, current) => this.evaluateExactStepExpression(expression, current)
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
      this.busy.delete(this.arbitrationKey(target))
    }
  }

  private planMutableExactSteps(
    valueBinding: CompiledInteractionBinding,
    current: number,
    requested: number,
    minimum: number,
    maximum: number,
    cyclic: boolean,
    increaseSelection: { readonly binding: CompiledInteractionBinding; readonly route: CompiledInteractionRoute | null } | null,
    decreaseSelection: { readonly binding: CompiledInteractionBinding; readonly route: CompiledInteractionRoute | null } | null
  ): { readonly code: 'OK'; readonly operation: 'increase' | 'decrease'; readonly steps: number } |
     { readonly code: 'VALUE_NOT_REACHABLE' | 'VALUE_REACHABILITY_UNKNOWN' } | undefined {
    const stateExpression = valueBinding.metadata.value.stateExpression
    const runtime = this.runtime as AircraftRuntime & {
      simulateInteractionBindingDirect?: (
        binding: CompiledInteractionBinding,
        options: { readonly mouseEvent?: string; readonly inputType?: number },
        shadowVariables: Map<string, number>
      ) => boolean
      evaluateInteractionReadOnlyExpression?: (
        expression: CompiledExpression,
        parameterValues?: readonly number[],
        shadowVariables?: ReadonlyMap<string, number>
      ) => number
    }
    if (stateExpression == null ||
        typeof runtime.simulateInteractionBindingDirect !== 'function' ||
        typeof runtime.evaluateInteractionReadOnlyExpression !== 'function') {
      return undefined
    }

    type DirectionResult =
      | { readonly code: 'OK'; readonly steps: number }
      | { readonly code: 'VALUE_NOT_REACHABLE' | 'VALUE_REACHABILITY_UNKNOWN' }
    const simulate = (operation: 'increase' | 'decrease'): DirectionResult => {
      const selection = operation === 'increase' ? increaseSelection : decreaseSelection
      if (selection?.route == null || selection.binding.metadata.discreteGate != null) {
        return { code: 'VALUE_REACHABILITY_UNKNOWN' }
      }
      const shadowVariables = new Map<string, number>()
      const visited = new Set<number>([current])
      let value = current
      for (let steps = 1; steps <= 10_000; steps += 1) {
        const safe = runtime.simulateInteractionBindingDirect!(selection.binding, {
          mouseEvent: selection.route.msfsEvent ?? undefined,
          inputType: selection.route.inputTypes[0]
        }, shadowVariables)
        if (!safe) return { code: 'VALUE_REACHABILITY_UNKNOWN' }
        const next = runtime.evaluateInteractionReadOnlyExpression!(stateExpression, [], shadowVariables)
        if (!Number.isFinite(next) || next < minimum || next > maximum) {
          return { code: 'VALUE_REACHABILITY_UNKNOWN' }
        }
        if (Object.is(next, requested)) return { code: 'OK', steps }
        if (Object.is(next, value)) return { code: 'VALUE_REACHABILITY_UNKNOWN' }
        if (!cyclic) {
          if (operation === 'increase' && next < value || operation === 'decrease' && next > value) {
            return { code: 'VALUE_REACHABILITY_UNKNOWN' }
          }
          if (operation === 'increase' && next > requested || operation === 'decrease' && next < requested) {
            return { code: 'VALUE_NOT_REACHABLE' }
          }
        }
        if (visited.has(next)) return { code: 'VALUE_NOT_REACHABLE' }
        visited.add(next)
        value = next
      }
      return { code: 'VALUE_NOT_REACHABLE' }
    }

    if (!cyclic) {
      const operation = requested >= current ? 'increase' : 'decrease'
      const result = simulate(operation)
      return result.code === 'OK' ? { ...result, operation } : result
    }
    const increase = simulate('increase')
    const decrease = simulate('decrease')
    if (increase.code === 'VALUE_REACHABILITY_UNKNOWN' || decrease.code === 'VALUE_REACHABILITY_UNKNOWN') {
      return { code: 'VALUE_REACHABILITY_UNKNOWN' }
    }
    if (increase.code === 'OK' && decrease.code === 'OK') {
      return increase.steps <= decrease.steps
        ? { code: 'OK', operation: 'increase', steps: increase.steps }
        : { code: 'OK', operation: 'decrease', steps: decrease.steps }
    }
    if (increase.code === 'OK') return { code: 'OK', operation: 'increase', steps: increase.steps }
    if (decrease.code === 'OK') return { code: 'OK', operation: 'decrease', steps: decrease.steps }
    return { code: 'VALUE_NOT_REACHABLE' }
  }

  private evaluateExactStepExpression(expression: CompiledExpression, current: number): number {
    const parameterValues = [...new Array<number>(15).fill(0), current]
    const runtime = this.runtime as AircraftRuntime & {
      evaluateInteractionReadOnlyExpression?: (
        expression: CompiledExpression,
        parameterValues: readonly number[]
      ) => number
    }
    return typeof runtime.evaluateInteractionReadOnlyExpression === 'function'
      ? runtime.evaluateInteractionReadOnlyExpression(expression, parameterValues)
      : evaluateCompiledExpression(expression, { readVariable: () => Number.NaN, parameterValues })
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

  private toTarget(
    binding: CompiledInteractionBinding,
    allBindings = this.runtime.getInteractionBindings()
  ): MsfsInteractionTarget {
    const key = msfsInteractionTargetKey(binding)
    const groupedBindings = allBindings.filter(candidate => msfsInteractionTargetKey(candidate) === key)
    const bindings = groupedBindings.length > 0 ? groupedBindings : [binding]
    const representative = bindings[0]!
    const hasQualifiedIdCollision = allBindings.some(candidate =>
      candidate.metadata.qualifiedId === representative.metadata.qualifiedId &&
      msfsInteractionTargetKey(candidate) !== key
    )
    const id = hasQualifiedIdCollision
      ? `${representative.metadata.sourcePath}#${representative.target}`
      : representative.metadata.qualifiedId
    return {
      id,
      arbitrationId: representative.metadata.groupId?.trim() ? key : id,
      lockable: bindings.some(candidate => candidate.metadata.lockable),
      temporaryLockChannels: [...new Set(bindings.flatMap(candidate =>
        interactionChannelsForMouseFlags(candidate.metadata.lockFlagsTemporary, 'Single')
      ))],
      operations: [...new Set([
        ...bindings.flatMap(candidate => candidate.metadata.routes.map(route => route.operation)),
        ...(bindings.some(candidate => candidate.metadata.wheelPrimaryToggle)
          ? ['increase' as const, 'decrease' as const]
          : [])
      ])],
      binding: representative,
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
  increaseStepExpression: CompiledExpression | null,
  decreaseStepExpression: CompiledExpression | null,
  minimum: number,
  maximum: number,
  cyclic: boolean,
  evaluateStepExpression: (expression: CompiledExpression, current: number) => number
): { readonly operation: 'increase' | 'decrease'; readonly steps: number } | null {
  const simulate = (
    operation: 'increase' | 'decrease'
  ): number | null => {
    const visited = new Set<number>([current])
    let value = current
    for (let steps = 1; steps <= 10_000; steps += 1) {
      const step = resolveExactStep(
        operation === 'increase' ? increaseStep : decreaseStep,
        operation === 'increase' ? increaseStepExpression : decreaseStepExpression,
        value,
        evaluateStepExpression
      )
      if (step == null) return null
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
    const steps = simulate(operation)
    return steps == null ? null : { operation, steps }
  }
  const increase = simulate('increase')
  const decrease = simulate('decrease')
  if (increase == null && decrease == null) return null
  if (decrease == null || increase != null && increase <= decrease) {
    return { operation: 'increase', steps: increase! }
  }
  return { operation: 'decrease', steps: decrease }
}

function resolveExactStep(
  step: number | null,
  expression: CompiledExpression | null,
  current: number,
  evaluateStepExpression: (expression: CompiledExpression, current: number) => number
): number | null {
  const resolved = expression == null
    ? step
    : evaluateStepExpression(expression, current)
  return resolved != null && Number.isFinite(resolved) && resolved > 0 ? resolved : null
}

function compiledInstructionsDirectlyMutateParameter(
  instructions: readonly Instruction[],
  parameterIndex: number
): boolean {
  const visit = (
    block: readonly Instruction[],
    stack: boolean[],
    registers: Map<number, boolean>
  ): boolean => {
    for (const instruction of block) {
      switch (instruction.op) {
        case 'pushParameter': stack.push(instruction.index === parameterIndex); break
        case 'pushNumber':
        case 'pushString':
        case 'pushVariable':
        case 'pushStringVariable':
        case 'pushPi': stack.push(false); break
        case 'duplicate': stack.push(stack.at(-1) ?? false); break
        case 'popDiscard': stack.pop(); break
        case 'swap': {
          const right = stack.pop() ?? false
          const left = stack.pop() ?? false
          stack.push(right, left)
          break
        }
        case 'storeRegister': {
          const value = instruction.pop ? stack.pop() ?? false : stack.at(-1) ?? false
          registers.set(instruction.index, value)
          break
        }
        case 'loadRegister': stack.push(registers.get(instruction.index) ?? false); break
        case 'increment':
        case 'decrement':
        case 'neg':
        case 'not':
        case 'abs':
        case 'ceil':
        case 'floor':
        case 'roundNearest':
        case 'sign':
        case 'sqrt':
        case 'sin':
        case 'cos':
        case 'degreesToRadians':
        case 'radiansToDegrees':
        case 'normalizeDegrees':
        case 'normalizeRadians':
          break
        case 'add':
        case 'sub':
        case 'mul':
        case 'div':
        case 'integerDiv':
        case 'mod':
        case 'pow':
        case 'min':
        case 'max':
        case 'gt':
        case 'lt':
        case 'gte':
        case 'lte':
        case 'eq':
        case 'neq':
        case 'and':
        case 'or':
        case 'stringCompare':
        case 'stringCompareCaseInsensitive': {
          const right = stack.pop() ?? false
          const left = stack.pop() ?? false
          stack.push(left || right)
          break
        }
        case 'ternary': {
          stack.pop()
          const falseValue = stack.pop() ?? false
          const trueValue = stack.pop() ?? false
          stack.push(falseValue || trueValue)
          break
        }
        case 'if':
          stack.pop()
          if (visit(instruction.thenInstructions, [...stack], new Map(registers)) ||
              visit(instruction.elseInstructions, [...stack], new Map(registers))) return true
          stack.length = 0
          registers.clear()
          break
        case 'writeVariable':
        case 'invokeHtmlEvent':
          if (stack.pop() === true) return true
          break
        case 'invokeKeyEvent': {
          let parameterFlowsToEvent = false
          for (let index = 0; index < instruction.argCount; index += 1) {
            parameterFlowsToEvent ||= stack.pop() === true
          }
          if (parameterFlowsToEvent) return true
          break
        }
        case 'case':
        case 'gotoLabel':
        case 'label':
        case 'quit':
          stack.length = 0
          registers.clear()
          break
      }
    }
    return false
  }
  return visit(instructions, [], new Map())
}

function convertExactUnitValue(
  value: number,
  fromUnit: string | undefined,
  toUnit: string | null
): { readonly ok: true; readonly value: number } |
   { readonly ok: false; readonly code: 'VALUE_REACHABILITY_UNKNOWN' | 'UNIT_INCOMPATIBLE' } {
  if (fromUnit == null) return { ok: true, value }
  if (toUnit == null) return { ok: false, code: 'VALUE_REACHABILITY_UNKNOWN' }
  if (normalizeExactUnitName(fromUnit) === normalizeExactUnitName(toUnit)) return { ok: true, value }
  const from = parseExactSimUnit(fromUnit)
  const to = parseExactSimUnit(toUnit)
  if (from == null || to == null) return { ok: false, code: 'UNIT_INCOMPATIBLE' }
  try {
    return { ok: true, value: convertSimUnit(value, from, to) }
  } catch {
    return { ok: false, code: 'UNIT_INCOMPATIBLE' }
  }
}

function parseExactSimUnit(unit: string): SimUnit | null {
  switch (normalizeExactUnitName(unit)) {
    case 'unitless': return 'unitless'
    case 'number':
    case 'scalar': return 'number'
    case 'ratio':
    case 'percent over 100': return 'ratio'
    case 'percent':
    case 'percentage': return 'percent'
    case 'bool':
    case 'boolean': return 'boolean'
    case 'second':
    case 'seconds': return 'seconds'
    case 'meter':
    case 'meters': return 'meters'
    case 'foot':
    case 'feet': return 'feet'
    case 'meter per second':
    case 'meters per second': return 'metersPerSecond'
    case 'knot':
    case 'knots': return 'knots'
    case 'celsius': return 'celsius'
    case 'kelvin': return 'kelvin'
    default: return null
  }
}

function normalizeExactUnitName(unit: string): string {
  return unit.trim().toLowerCase().replaceAll('_', ' ').replace(/\s+/gu, ' ')
}

function mouseFlagForChannel(channel: CockpitInteractionChannel, suffix: 'Single' | 'Drag'): string {
  const prefix = channel === 'primary' ? 'Left' : channel === 'secondary' ? 'Right' : 'Middle'
  return `${prefix}${suffix}`
}

function interactionChannelsForMouseFlags(
  flags: readonly string[],
  suffix: 'Single' | 'Drag'
): CockpitInteractionChannel[] {
  return (['primary', 'secondary', 'tertiary'] as const).filter(channel =>
    flags.includes(mouseFlagForChannel(channel, suffix))
  )
}

function selectRoute(
  routes: readonly CompiledInteractionRoute[],
  action: CanonicalCockpitAction,
  mode: CockpitInteractionMode,
  lockable: boolean,
  dragFlagsLockable: readonly string[] = []
): CompiledInteractionRoute | null {
  const operation: CockpitInteractionOperation = action.operation === 'hold' && action.phase !== 'repeat'
    ? 'press'
    : action.operation
  const interactionModel = mode === 'lock' && lockable ? 'drag' : 'default'
  if (interactionModel === 'drag' && action.phase === 'drag') {
    const requiredDragFlag = mouseFlagForChannel(action.channel ?? 'primary', 'Drag')
    if (!dragFlagsLockable.includes(requiredDragFlag)) return null
  }
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
