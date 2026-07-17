export type CockpitInteractionChannel = 'primary' | 'secondary' | 'tertiary'
export type CockpitInteractionPhase = 'press' | 'double' | 'hold' | 'drag' | 'repeat' | 'release' | 'cancel'
export type CockpitInteractionMode = 'legacy' | 'lock'
export type CockpitRelativeDirection = 'increase' | 'decrease' | 'left' | 'right' | 'up' | 'down'
export type CockpitInteractionSource = 'mouse' | 'keyboard' | 'gamepad' | 'touch' | 'vr' | 'hid' | 'devapi'
export type CockpitInteractionOperation =
  | 'press' | 'hold' | 'release' | 'turn' | 'increase' | 'decrease' | 'adjust' | 'set'
  | 'on' | 'off' | 'toggle' | 'hover' | 'leave' | 'lock' | 'unlock' | 'cancel'

export interface CockpitInteractionInput {
  readonly source: CockpitInteractionSource
  readonly channel?: CockpitInteractionChannel
  readonly phase: CockpitInteractionPhase
  readonly pointerId?: number
  readonly clickCount?: number
  readonly axis?: 'x' | 'y' | 'z'
  readonly axisValue?: number
  readonly delta?: number
  readonly dragPercent?: number
  readonly timestampMs: number
}

export interface CanonicalCockpitAction extends CockpitInteractionInput {
  readonly operation: CockpitInteractionOperation
  readonly steps?: number
  readonly value?: number | boolean | string
  readonly unit?: string
  readonly direction?: CockpitRelativeDirection
}

export interface CockpitInteractionTarget {
  readonly id: string
  readonly lockable: boolean
  readonly operations: readonly CockpitInteractionOperation[]
}

export type CockpitInteractionMissReason =
  | 'raycast'
  | 'unsupported'
  | 'unavailable'
  | 'busy'
  | 'blocker'
  | 'cover'
  | 'target-loss'

export interface CockpitInteractionMiss {
  readonly reason: CockpitInteractionMissReason
  readonly timestampMs: number
  readonly detail?: Readonly<Record<string, unknown>>
}

export type CockpitInteractionState = 'idle' | 'hovered' | 'pressed' | 'captured' | 'dragging' | 'held' | 'repeating' | 'released' | 'locked' | 'cancelled'

export class CockpitInteractionDispatcher<T extends CockpitInteractionTarget> {
  private hovered: T | null = null
  private captured: { target: T; pointerId: number; channel: CockpitInteractionChannel; locked: boolean } | null = null
  private readonly busy = new Map<string, CockpitInteractionOperation>()
  private readonly missCounts: Record<CockpitInteractionMissReason, number> = {
    raycast: 0,
    unsupported: 0,
    unavailable: 0,
    busy: 0,
    blocker: 0,
    cover: 0,
    'target-loss': 0
  }
  private latestMiss: CockpitInteractionMiss | null = null
  private state: CockpitInteractionState = 'idle'

  constructor(
    private mode: CockpitInteractionMode,
    private readonly execute: (target: T, action: CanonicalCockpitAction) => boolean
  ) {}

  get snapshot(): Readonly<{
    state: CockpitInteractionState
    hovered: string | null
    captured: string | null
    busy: readonly string[]
    misses: { readonly counts: Readonly<Record<CockpitInteractionMissReason, number>>; readonly latest: CockpitInteractionMiss | null }
  }> {
    return {
      state: this.state,
      hovered: this.hovered?.id ?? null,
      captured: this.captured?.target.id ?? null,
      busy: [...this.busy.keys()],
      misses: { counts: { ...this.missCounts }, latest: this.latestMiss }
    }
  }

  recordMiss(
    reason: CockpitInteractionMissReason,
    detail?: Readonly<Record<string, unknown>>,
    timestampMs = performance.now()
  ): void {
    this.missCounts[reason] += 1
    this.latestMiss = { reason, timestampMs, detail }
  }

  setMode(mode: CockpitInteractionMode): void { this.cancelAll(); this.mode = mode }

  claim(target: T, operation: CockpitInteractionOperation): boolean {
    if (this.busy.has(target.id)) {
      this.recordMiss('busy', { target: target.id, operation })
      return false
    }
    this.busy.set(target.id, operation)
    return true
  }

  finish(targetId: string): void { this.busy.delete(targetId) }

  hover(target: T | null, timestampMs = performance.now()): void {
    if (this.captured != null) return
    if (this.hovered === target) return
    if (this.hovered != null && this.hovered !== target) this.execute(this.hovered, event('leave', 'cancel', timestampMs))
    this.hovered = target
    this.state = target == null ? 'idle' : 'hovered'
    if (target != null) this.execute(target, event('hover', 'press', timestampMs))
  }

  pointerDown(
    target: T | null,
    pointerId: number,
    channel: CockpitInteractionChannel,
    timestampMs: number,
    clickCount = 1
  ): boolean {
    if (target == null) return false
    if (this.busy.has(target.id)) {
      this.recordMiss('busy', { target: target.id, operation: 'hold' }, timestampMs)
      return true
    }
    const locked = this.mode === 'lock' && target.lockable && channel === 'primary'
    this.captured = { target, pointerId, channel, locked }
    this.state = locked ? 'locked' : 'pressed'
    this.busy.set(target.id, 'hold')
    if (locked) this.execute(target, { ...event('lock', 'hold', timestampMs), channel, pointerId })
    this.execute(target, { ...event('hold', 'hold', timestampMs), channel, pointerId, clickCount })
    return true
  }

  pointerMove(pointerId: number, axis: 'x' | 'y' | 'z', axisValue: number, dragPercent: number, timestampMs: number): boolean {
    if (this.captured?.pointerId !== pointerId) return false
    this.state = 'dragging'
    const executed = this.execute(this.captured.target, { ...event('turn', 'drag', timestampMs), channel: this.captured.channel, pointerId, axis, axisValue, dragPercent })
    if (!executed) this.recordMiss('unavailable', { target: this.captured.target.id, operation: 'turn' }, timestampMs)
    return executed
  }

  pointerUp(pointerId: number, timestampMs: number): boolean {
    if (this.captured?.pointerId !== pointerId) return false
    const capture = this.captured
    this.execute(capture.target, { ...event('release', 'release', timestampMs), channel: capture.channel, pointerId })
    if (capture.locked) this.execute(capture.target, { ...event('unlock', 'release', timestampMs), channel: capture.channel, pointerId })
    this.busy.delete(capture.target.id)
    this.captured = null
    this.state = this.hovered == null ? 'idle' : 'hovered'
    return true
  }

  dispatch(target: T, action: CanonicalCockpitAction): 'executed' | 'unsupported' | 'busy' {
    const supported = target.operations.includes(action.operation) ||
      (action.operation === 'hold' && target.operations.includes('press'))
    if (!supported) {
      this.recordMiss('unsupported', { target: target.id, operation: action.operation }, action.timestampMs)
      return 'unsupported'
    }
    if (this.busy.has(target.id) && action.operation !== 'release' && action.operation !== 'cancel') {
      this.recordMiss('busy', { target: target.id, operation: action.operation }, action.timestampMs)
      return 'busy'
    }
    if (!this.execute(target, action)) {
      this.recordMiss('unavailable', { target: target.id, operation: action.operation }, action.timestampMs)
      return 'unsupported'
    }
    if (action.operation === 'hold') this.busy.set(target.id, 'hold')
    if (action.operation === 'release' || action.operation === 'cancel') this.busy.delete(target.id)
    return 'executed'
  }

  dispatchCaptured(action: CanonicalCockpitAction): boolean {
    if (this.captured == null) return false
    const executed = this.execute(this.captured.target, action)
    if (!executed) this.recordMiss('unavailable', { target: this.captured.target.id, operation: action.operation }, action.timestampMs)
    return executed
  }

  cancel(targetId?: string, timestampMs = performance.now()): boolean {
    if (targetId != null && this.captured?.target.id !== targetId && !this.busy.has(targetId)) return false
    if (this.captured != null && (targetId == null || this.captured.target.id === targetId)) {
      this.execute(this.captured.target, event('cancel', 'cancel', timestampMs))
      this.execute(this.captured.target, event('unlock', 'cancel', timestampMs))
      this.busy.delete(this.captured.target.id)
      this.captured = null
    }
    if (targetId == null) this.busy.clear(); else this.busy.delete(targetId)
    this.state = 'cancelled'
    return true
  }

  cancelAll(): void { this.cancel() }
}

function event(operation: CockpitInteractionOperation, phase: CockpitInteractionPhase, timestampMs: number): CanonicalCockpitAction {
  return { source: 'mouse', operation, phase, timestampMs }
}
