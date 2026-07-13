import { describe, expect, test } from 'bun:test'
import { CockpitInteractionDispatcher, type CanonicalCockpitAction, type CockpitInteractionTarget } from './cockpitInteraction'

describe('CockpitInteractionDispatcher', () => {
  test('captures a target and preserves primary/secondary/tertiary channels', () => {
    const actions: CanonicalCockpitAction[] = []
    const target: CockpitInteractionTarget = { id: 'control', lockable: false, operations: ['press', 'hold', 'turn', 'release'] }
    const dispatcher = new CockpitInteractionDispatcher('legacy', (_target, action) => { actions.push(action); return true })
    expect(dispatcher.pointerDown(target, 1, 'tertiary', 1)).toBe(true)
    expect(dispatcher.pointerMove(1, 'y', 0.5, 0.2, 2)).toBe(true)
    expect(dispatcher.pointerUp(1, 3)).toBe(true)
    expect(actions.map(action => [action.operation, action.channel])).toEqual([['hold', 'tertiary'], ['turn', 'tertiary'], ['release', 'tertiary']])
  })

  test('lock mode locks authored complex controls and cancels safely', () => {
    const operations: string[] = []
    const target: CockpitInteractionTarget = { id: 'knob', lockable: true, operations: ['lock', 'hold', 'unlock', 'cancel'] }
    const dispatcher = new CockpitInteractionDispatcher('lock', (_target, action) => { operations.push(action.operation); return true })
    dispatcher.pointerDown(target, 2, 'primary', 1)
    dispatcher.cancelAll()
    expect(operations).toEqual(['lock', 'hold', 'cancel', 'unlock'])
    expect(dispatcher.snapshot.captured).toBe(null)
  })
})
