import type { CanonicalCockpitAction } from '../input/cockpitInteraction'
import type { SimScheduledTaskId, SimScheduler } from '../sim/engine'
import type { CompiledInteractionBinding } from './types'
import type { MsfsInteractionAdapter, MsfsInteractionTarget } from './interactionAdapter'

export interface MsfsInteractionLifecycleDiagnostic {
  readonly code: 'interaction_repeat_timing_unproven'
  readonly targetId: string
  readonly msfsEvent: string | null
}

interface ActiveInteraction {
  readonly target: MsfsInteractionTarget
  readonly scope: string
  downRepeat: SimScheduledTaskId | null
  moveRepeat: SimScheduledTaskId | null
  moveAction: CanonicalCockpitAction | null
}

let nextLifecycleScope = 1

export class MsfsInteractionLifecycle {
  private readonly active = new Map<string, ActiveInteraction>()
  private readonly scopePrefix = `msfs-lifecycle:${nextLifecycleScope++}`

  constructor(
    private readonly adapter: MsfsInteractionAdapter,
    private readonly scheduler: SimScheduler,
    private readonly diagnose: (diagnostic: MsfsInteractionLifecycleDiagnostic) => void = () => {},
    private readonly trace?: (record: () => Readonly<Record<string, unknown>>) => void
  ) {}

  execute(target: MsfsInteractionTarget, action: CanonicalCockpitAction): boolean {
    if (action.source === 'mouse' && action.pointerId != null) {
      if (action.operation === 'hold' && action.phase === 'hold') {
        return this.press(target, action, action.clickCount)
      }
      if (action.operation === 'turn' && action.phase === 'drag') {
        return this.move(target, action)
      }
      if (action.operation === 'release' && action.phase === 'release') {
        return this.release(target, action)
      }
    }
    if (action.source === 'mouse' && action.operation === 'cancel' && action.phase === 'cancel') {
      this.cancel(target)
      return true
    }
    return this.adapter.execute(target, action)
  }

  press(target: MsfsInteractionTarget, action: CanonicalCockpitAction, clickCount = 1): boolean {
    this.cancelTasks(target.id)
    const active: ActiveInteraction = {
      target,
      scope: `${this.scopePrefix}:${target.id}`,
      downRepeat: null,
      moveRepeat: null,
      moveAction: null
    }
    this.active.set(target.id, active)
    const single = { ...action, operation: 'hold', phase: 'hold' } as const
    if (!this.adapter.execute(target, single)) {
      this.active.delete(target.id)
      return false
    }
    if (clickCount === 2) {
      const double = { ...action, operation: 'press', phase: 'double' } as const
      if (this.adapter.route(target, double) != null) this.adapter.execute(target, double)
    }
    active.downRepeat = this.scheduleRepeat(target, active, {
      ...action,
      operation: 'hold',
      phase: 'repeat'
    })
    return true
  }

  move(target: MsfsInteractionTarget, action: CanonicalCockpitAction): boolean {
    const active = this.active.get(target.id)
    if (active == null) return false
    const drag = { ...action, operation: 'turn', phase: 'drag' } as const
    if (!this.adapter.execute(target, drag)) return false
    active.moveAction = { ...action, operation: 'turn', phase: 'repeat', channel: undefined }
    if (active.moveRepeat == null) {
      active.moveRepeat = this.scheduleRepeat(target, active, active.moveAction, () => active.moveAction)
    }
    return true
  }

  release(target: MsfsInteractionTarget, action: CanonicalCockpitAction): boolean {
    this.cancelTasks(target.id)
    const executed = this.adapter.execute(target, { ...action, operation: 'release', phase: 'release' })
    const released = this.adapter.release(target)
    return executed || released
  }

  cancel(target: MsfsInteractionTarget): void {
    this.cancelTasks(target.id)
    this.adapter.cancel(target)
  }

  cancelAll(): void {
    for (const { target } of [...this.active.values()]) this.cancel(target)
    this.adapter.cancelAll()
  }

  private scheduleRepeat(
    target: MsfsInteractionTarget,
    active: ActiveInteraction,
    initialAction: CanonicalCockpitAction,
    currentAction: () => CanonicalCockpitAction | null = () => initialAction
  ): SimScheduledTaskId | null {
    const route = this.adapter.route(target, initialAction)
    if (route == null) return null
    const binding = target.bindings.find(candidate => candidate.metadata.routes.includes(route))
    const frequency = binding?.repeatFrequencyHz
    if (binding == null || frequency == null) {
      this.diagnose({
        code: 'interaction_repeat_timing_unproven',
        targetId: target.id,
        msfsEvent: route.msfsEvent
      })
      return null
    }
    const intervalSeconds = 1 / frequency
    const delaySeconds = initialAction.operation === 'hold' && binding.minHeldDurationSeconds > 0
      ? binding.minHeldDurationSeconds
      : intervalSeconds
    this.trace?.(() => ({
      kind: 'scheduler',
      phase: 'repeat-scheduled',
      target: target.id,
      action: initialAction,
      delaySeconds,
      intervalSeconds,
      scope: active.scope,
      provenance: { sourcePath: binding.sourcePath, route }
    }))
    let taskId = 0
    taskId = this.scheduler.schedule(delaySeconds, () => {
      const action = currentAction()
      this.trace?.(() => ({
        kind: 'scheduler',
        phase: 'repeat-fired',
        target: target.id,
        action,
        taskId,
        scope: active.scope
      }))
      if (action == null || !this.adapter.execute(target, action)) {
        this.scheduler.cancel(taskId)
        this.trace?.(() => ({
          kind: 'scheduler',
          phase: 'repeat-cancelled',
          target: target.id,
          taskId,
          scope: active.scope
        }))
      }
    }, {
      repeatSeconds: intervalSeconds,
      scope: active.scope
    })
    return taskId
  }

  private cancelTasks(targetId: string): void {
    const active = this.active.get(targetId)
    if (active == null) return
    this.trace?.(() => ({ kind: 'scheduler', phase: 'scope-cancelled', target: targetId, scope: active.scope }))
    this.scheduler.cancelScope(active.scope)
    this.active.delete(targetId)
  }
}
