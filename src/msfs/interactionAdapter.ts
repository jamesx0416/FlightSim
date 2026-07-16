import type { CanonicalCockpitAction, CockpitInteractionMode, CockpitInteractionOperation, CockpitInteractionTarget, CockpitRelativeDirection } from '../input/cockpitInteraction'
import type { AircraftRuntime } from './runtime'
import type { CompiledInteractionBinding, CompiledInteractionRoute } from './types'

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
  private readonly busy = new Set<string>()
  private mode: CockpitInteractionMode = 'legacy'

  constructor(
    private readonly runtimeSource: AircraftRuntime | (() => AircraftRuntime),
    private readonly settle: (seconds: number) => Promise<void> = settleInteraction
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
      return this.executeGateStep(selected.binding, action.operation)
    }
    if (selected?.route == null) {
      const toggle = target.bindings.find(binding => binding.metadata.wheelPrimaryToggle)
      return toggle == null || (action.operation !== 'increase' && action.operation !== 'decrease')
        ? false
        : this.executePrimaryToggleDirection(toggle, action.operation)
    }
    const actionValue = typeof action.value === 'boolean'
      ? Number(action.value)
      : typeof action.value === 'number'
        ? action.value
        : undefined
    const value = action.axisValue ?? action.delta ?? actionValue
    return this.runtime.executeInteractionBindingDirect(selected.binding, {
      holdFeedback: action.phase === 'hold' || action.phase === 'drag',
      mouseEvent: selected.route.msfsEvent ?? undefined,
      inputType: selected.route.inputTypes[0],
      relativeX: action.axis === 'x' ? value : undefined,
      relativeY: action.axis === 'y' ? value : undefined,
      relativeZ: action.axis === 'z' ? value : undefined,
      dragPercent: action.dragPercent,
      parameterValues: actionValue == null ? undefined : [actionValue]
    })
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
    this.cancellations.set(target.id, (this.cancellations.get(target.id) ?? 0) + 1)
    this.release(target)
  }

  cancelAll(): void {
    for (const target of this.list()) {
      this.cancellations.set(target.id, (this.cancellations.get(target.id) ?? 0) + 1)
    }
  }

  async adjustExact(
    target: MsfsInteractionTarget,
    delta: number,
    unit?: string,
    channel?: CanonicalCockpitAction['channel']
  ): Promise<ExactInteractionResult> {
    const current = this.currentValue(target)
    if (current == null) return exactResult('VALUE_REACHABILITY_UNKNOWN', current, current, delta, target, null, 0)
    return this.setExact(target, current + delta, unit, channel, current)
  }

  async setBooleanState(
    target: MsfsInteractionTarget,
    desired: boolean,
    channel?: CanonicalCockpitAction['channel']
  ): Promise<ExactInteractionResult> {
    const previous = this.currentValue(target)
    const requested = Number(desired)
    const generation = this.cancellations.get(target.id) ?? 0
    if (previous == null) return exactResult('VALUE_REACHABILITY_UNKNOWN', null, null, requested, target, null, 0)
    if (Boolean(previous) === desired) return exactResult('OK', previous, previous, requested, target, 'direct-set', 0)
    const explicitOperation = desired ? 'on' : 'off'
    const explicit = selectRoute(target.binding.metadata.routes, canonical(explicitOperation, channel), this.mode, target.lockable)
    const toggle = selectRoute(target.binding.metadata.routes, canonical('toggle', channel), this.mode, target.lockable)
    const operation = explicit != null ? explicitOperation : toggle != null ? 'toggle' : null
    if (operation == null) return exactResult('OPERATION_UNSUPPORTED', previous, previous, requested, target, null, 0)
    if (!this.execute(target, canonical(operation, channel))) return exactResult('OPERATION_UNSUPPORTED', previous, previous, requested, target, null, 0)
    await this.settle(target.binding.metadata.value.settleTimeSeconds)
    if ((this.cancellations.get(target.id) ?? 0) !== generation) return exactResult('CANCELLED', previous, this.currentValue(target), requested, target, 'direct-set', 1)
    const actual = this.currentValue(target)
    const code = actual != null && Boolean(actual) === desired
      ? 'OK'
      : Object.is(actual, previous)
        ? 'NO_PROGRESS'
        : 'VALUE_NOT_REACHABLE'
    return exactResult(code, previous, actual, requested, target, 'direct-set', 1)
  }

  async setExact(
    target: MsfsInteractionTarget,
    requested: number,
    unit?: string,
    channel?: CanonicalCockpitAction['channel'],
    knownPrevious?: number
  ): Promise<ExactInteractionResult> {
    if (this.busy.has(target.id)) return exactResult('TARGET_BUSY', null, this.currentValue(target), requested, target, null, 0)
    this.busy.add(target.id)
    try {
    const metadata = target.binding.metadata.value
    if (unit != null && metadata.unit != null && unit.toLowerCase() !== metadata.unit.toLowerCase()) {
      return exactResult('UNIT_INCOMPATIBLE', null, null, requested, target, null, 0)
    }
    const previous = knownPrevious ?? this.currentValue(target)
    if (previous == null) return exactResult('VALUE_REACHABILITY_UNKNOWN', null, null, requested, target, null, 0)
    if (Object.is(previous, requested)) return exactResult('OK', previous, previous, requested, target, 'direct-set', 0)
    if ((metadata.minimum != null && requested < metadata.minimum) || (metadata.maximum != null && requested > metadata.maximum)) {
      return exactResult('VALUE_NOT_REACHABLE', previous, previous, requested, target, null, 0)
    }

    const generation = this.cancellations.get(target.id) ?? 0
    const setRoute = selectRoute(target.binding.metadata.routes, canonical('set', channel, requested), this.mode, target.lockable)
    if (setRoute != null) {
      if (!this.execute(target, canonical('set', channel, requested))) return exactResult('OPERATION_UNSUPPORTED', previous, previous, requested, target, null, 0)
      await this.settle(metadata.settleTimeSeconds)
      if ((this.cancellations.get(target.id) ?? 0) !== generation) return exactResult('CANCELLED', previous, this.currentValue(target), requested, target, 'direct-set', 1)
      const actual = this.currentValue(target)
      const code = Object.is(actual, requested)
        ? 'OK'
        : Object.is(actual, previous)
          ? 'NO_PROGRESS'
          : 'VALUE_NOT_REACHABLE'
      return exactResult(code, previous, actual, requested, target, 'direct-set', 1)
    }

    const step = metadata.step
    if (step == null || step <= 0) return exactResult('VALUE_REACHABILITY_UNKNOWN', previous, previous, requested, target, null, 0)
    const plan = planExactSteps(previous, requested, step, metadata.minimum, metadata.maximum, metadata.cyclic)
    if (plan == null) return exactResult('VALUE_NOT_REACHABLE', previous, previous, requested, target, null, 0)
    const routeOperation = plan.operation
    const route = selectRoute(target.binding.metadata.routes, canonical(routeOperation, channel), this.mode, target.lockable)
    if (route == null) return exactResult('OPERATION_UNSUPPORTED', previous, previous, requested, target, null, 0)

    const visited = new Set<string>([`${routeOperation}:${previous}`])
    let actual = previous
    for (let index = 0; index < plan.steps; index += 1) {
      if ((this.cancellations.get(target.id) ?? 0) !== generation) return exactResult('CANCELLED', previous, actual, requested, target, routeOperation, index)
      if (!this.execute(target, canonical(routeOperation, channel))) return exactResult('TARGET_LOST', previous, actual, requested, target, routeOperation, index)
      await this.settle(metadata.settleTimeSeconds)
      const next = this.currentValue(target)
      if (next == null) return exactResult('TARGET_LOST', previous, null, requested, target, routeOperation, index + 1)
      if (Object.is(next, actual)) return exactResult('NO_PROGRESS', previous, next, requested, target, routeOperation, index + 1)
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

  private toTarget(binding: CompiledInteractionBinding): MsfsInteractionTarget {
    const bindings = [binding, ...this.runtime.getInteractionBindings().filter(candidate =>
      candidate !== binding &&
      candidate.metadata.qualifiedId === binding.metadata.qualifiedId && candidate.target === binding.target
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
  return { ok: code === 'OK', code, requested, previous, actual, unit: target.binding.metadata.value.unit, executionPath, steps }
}

function planExactSteps(
  current: number,
  requested: number,
  step: number,
  minimum: number | null,
  maximum: number | null,
  cyclic: boolean
): { readonly operation: 'increase' | 'decrease'; readonly steps: number } | null {
  const direct = (requested - current) / step
  if (!cyclic) {
    if (!Number.isInteger(direct)) return null
    return { operation: direct >= 0 ? 'increase' : 'decrease', steps: Math.abs(direct) }
  }
  if (minimum == null || maximum == null || maximum <= minimum) return null
  const cycleSteps = (maximum - minimum) / step
  if (!Number.isInteger(cycleSteps) || !Number.isInteger(direct)) return null
  const increase = ((direct % cycleSteps) + cycleSteps) % cycleSteps
  const decrease = (cycleSteps - increase) % cycleSteps
  return increase <= decrease
    ? { operation: 'increase', steps: increase }
    : { operation: 'decrease', steps: decrease }
}

async function settleInteraction(seconds: number): Promise<void> {
  if (seconds > 0) await new Promise(resolve => setTimeout(resolve, seconds * 1000))
  if (typeof requestAnimationFrame !== 'function') {
    await Promise.resolve()
    await Promise.resolve()
    return
  }
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

function selectRoute(
  routes: readonly CompiledInteractionRoute[],
  action: CanonicalCockpitAction,
  mode: CockpitInteractionMode,
  lockable: boolean
): CompiledInteractionRoute | null {
  const operation: CockpitInteractionOperation = action.operation === 'hold' ? 'press' : action.operation
  const interactionModel = mode === 'lock' && lockable ? 'drag' : 'default'
  const isWheelOperation = operation === 'increase' || operation === 'decrease'
  let candidates = routes.filter(route =>
    (isWheelOperation || route.interactionModel == null || route.interactionModel === interactionModel) &&
    (route.operation === operation || (operation === 'turn' && route.phase === 'drag'))
  )
  if (action.channel != null) {
    candidates = candidates.filter(route => route.channel === action.channel)
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
