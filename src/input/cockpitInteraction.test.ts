import { describe, expect, test } from 'bun:test'
import { CockpitInteractionDispatcher, type CanonicalCockpitAction, type CockpitInteractionTarget } from './cockpitInteraction'

describe('CockpitInteractionDispatcher', () => {
  test('captures a target and preserves primary/secondary/tertiary channels', () => {
    const actions: CanonicalCockpitAction[] = []
    const target: CockpitInteractionTarget = { id: 'control', lockable: false, operations: ['press', 'hold', 'turn', 'release'] }
    const dispatcher = new CockpitInteractionDispatcher('legacy', (_target, action) => { actions.push(action); return true })
    expect(dispatcher.pointerDown(target, 1, 'tertiary', 1, 2)).toBe(true)
    expect(dispatcher.pointerMove(1, 'y', 0.5, 0.2, 2)).toBe(true)
    expect(dispatcher.pointerUp(1, 3)).toBe(true)
    expect(actions.map(action => [action.operation, action.channel])).toEqual([['hold', 'tertiary'], ['turn', 'tertiary'], ['release', 'tertiary']])
    expect(actions[0]?.clickCount).toBe(2)
  })

  test('lock mode stops authored complex controls through release then unlock', () => {
    const operations: string[] = []
    const target: CockpitInteractionTarget = { id: 'knob', lockable: true, operations: ['lock', 'hold', 'release', 'unlock'] }
    const dispatcher = new CockpitInteractionDispatcher('lock', (_target, action) => { operations.push(action.operation); return true })
    dispatcher.pointerDown(target, 2, 'primary', 1)
    dispatcher.stopAll()
    expect(operations).toEqual(['lock', 'hold', 'release', 'unlock'])
    expect(dispatcher.snapshot.captured).toBe(null)
    expect(dispatcher.snapshot.state).toBe('stopped')
  })

  test('consumes busy targets and keeps capture on the initiating pointer', () => {
    const target: CockpitInteractionTarget = { id: 'control', lockable: false, operations: ['hold', 'turn', 'release'] }
    const dispatcher = new CockpitInteractionDispatcher('legacy', () => true)
    expect(dispatcher.claim(target, 'set')).toBe(true)
    expect(dispatcher.pointerDown(target, 1, 'primary', 1)).toBe(true)
    expect(dispatcher.snapshot.captured).toBe(null)

    dispatcher.finish(target.id)
    dispatcher.pointerDown(target, 1, 'primary', 2)
    expect(dispatcher.pointerMove(2, 'x', 1, 1, 3)).toBe(false)
    expect(dispatcher.pointerUp(2, 4)).toBe(false)
    expect(dispatcher.snapshot.captured).toBe(target.id)
    expect(dispatcher.pointerUp(1, 5)).toBe(true)
  })

  test('keeps cumulative miss counts and the latest structured detail', () => {
    const target: CockpitInteractionTarget = { id: 'control', lockable: false, operations: ['press'] }
    const dispatcher = new CockpitInteractionDispatcher('legacy', () => false)

    expect(dispatcher.dispatch(target, { source: 'devapi', operation: 'turn', phase: 'press', timestampMs: 1 })).toBe('unsupported')
    expect(dispatcher.dispatch(target, { source: 'devapi', operation: 'press', phase: 'press', timestampMs: 2 })).toBe('unsupported')
    dispatcher.recordMiss('raycast', { reason: 'empty' }, 3)
    dispatcher.recordMiss('raycast', { reason: 'occluded' }, 4)

    expect(dispatcher.snapshot.misses).toEqual({
      counts: {
        raycast: 2,
        unsupported: 1,
        unavailable: 1,
        busy: 0,
        blocker: 0,
        cover: 0,
        'target-loss': 0
      },
      latest: { reason: 'raycast', timestampMs: 4, detail: { reason: 'occluded' } }
    })
  })
})
