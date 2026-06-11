export interface SimCommand<TPayload = unknown> {
  readonly type: string
  readonly payload?: TPayload
  readonly source?: string
  readonly timestampSeconds?: number
}

export type SimCommandHandler = (command: SimCommand) => void
export type SimCommandConsumer = (command: SimCommand) => boolean | void
export type SimCommandSubscriptionType = string | '*'

export interface SimCommandDispatchResult {
  readonly handled: boolean
  readonly handledCount: number
  readonly calledCount: number
  readonly directHandledCount: number
  readonly wildcardHandledCount: number
}

export class SimCommandBus {
  private readonly handlers = new Map<
    SimCommandSubscriptionType,
    Set<SimCommandConsumer>
  >()

  subscribe(
    type: SimCommandSubscriptionType,
    handler: SimCommandConsumer
  ): () => void {
    const handlers = getOrCreateHandlers(this.handlers, type)
    handlers.add(handler)

    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) {
        this.handlers.delete(type)
      }
    }
  }

  dispatch(command: SimCommand): SimCommandDispatchResult {
    const directHandlerCount = this.dispatchTo(command.type, command)
    const wildcardHandlerCount = this.dispatchTo('*', command)
    const handledCount =
      directHandlerCount.handledCount + wildcardHandlerCount.handledCount
    const calledCount =
      directHandlerCount.calledCount + wildcardHandlerCount.calledCount

    return {
      handled: handledCount > 0,
      handledCount,
      calledCount,
      directHandledCount: directHandlerCount.handledCount,
      wildcardHandledCount: wildcardHandlerCount.handledCount,
    }
  }

  private dispatchTo(
    type: SimCommandSubscriptionType,
    command: SimCommand
  ): { readonly handledCount: number; readonly calledCount: number } {
    const handlers = this.handlers.get(type)

    if (handlers == null) {
      return { handledCount: 0, calledCount: 0 }
    }

    let handledCount = 0
    let calledCount = 0
    for (const handler of [...handlers]) {
      if (handler(command) === true) {
        handledCount += 1
      }
      calledCount += 1
    }
    return { handledCount, calledCount }
  }
}

function getOrCreateHandlers(
  handlersByType: Map<SimCommandSubscriptionType, Set<SimCommandConsumer>>,
  type: SimCommandSubscriptionType
): Set<SimCommandConsumer> {
  const existing = handlersByType.get(type)

  if (existing != null) {
    return existing
  }

  const created = new Set<SimCommandConsumer>()
  handlersByType.set(type, created)
  return created
}
