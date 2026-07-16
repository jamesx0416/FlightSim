export type SimScheduledTaskId = number
export type SimScheduleScope = string

export interface SimScheduleOptions {
  readonly scope?: SimScheduleScope
  readonly repeatSeconds?: number
}

interface SimScheduledTask {
  readonly id: SimScheduledTaskId
  readonly callback: () => void
  readonly scope: SimScheduleScope | undefined
  readonly repeatSeconds: number | undefined
  dueAtSeconds: number
}

interface SimTickWaiter {
  remaining: number
  readonly resolve: () => void
}

export class SimScheduler {
  private readonly tasks = new Map<SimScheduledTaskId, SimScheduledTask>()
  private tickWaiters: SimTickWaiter[] = []
  private nextTaskId = 1
  private elapsedSeconds = 0

  schedule(
    delaySeconds: number,
    callback: () => void,
    options: SimScheduleOptions = {}
  ): SimScheduledTaskId {
    requireNonNegativeFinite(delaySeconds, 'delaySeconds')
    if (options.repeatSeconds != null) {
      requirePositiveFinite(options.repeatSeconds, 'repeatSeconds')
    }

    const id = this.nextTaskId++
    this.tasks.set(id, {
      id,
      callback,
      scope: options.scope,
      repeatSeconds: options.repeatSeconds,
      dueAtSeconds: this.elapsedSeconds + delaySeconds,
    })
    return id
  }

  cancel(id: SimScheduledTaskId): boolean {
    return this.tasks.delete(id)
  }

  cancelScope(scope: SimScheduleScope): number {
    let cancelled = 0
    for (const [id, task] of this.tasks) {
      if (task.scope === scope && this.tasks.delete(id)) cancelled += 1
    }
    return cancelled
  }

  waitForCompletedTicks(count = 1): Promise<void> {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError('count must be a positive integer')
    }
    return new Promise(resolve => this.tickWaiters.push({ remaining: count, resolve }))
  }

  tick(dtSeconds: number): void {
    requireNonNegativeFinite(dtSeconds, 'dtSeconds')
    this.elapsedSeconds += dtSeconds

    const due = [...this.tasks.values()]
      .filter(task => task.dueAtSeconds <= this.elapsedSeconds)
      .sort((left, right) => left.dueAtSeconds - right.dueAtSeconds || left.id - right.id)

    for (const task of due) {
      while (this.tasks.get(task.id) === task && task.dueAtSeconds <= this.elapsedSeconds) {
        if (task.repeatSeconds == null) this.tasks.delete(task.id)
        else task.dueAtSeconds += task.repeatSeconds
        task.callback()
      }
    }

    const completed = this.tickWaiters.filter(waiter => --waiter.remaining === 0)
    this.tickWaiters = this.tickWaiters.filter(waiter => waiter.remaining > 0)
    for (const waiter of completed) waiter.resolve()
  }
}

function requireNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`)
  }
}

function requirePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`)
  }
}
