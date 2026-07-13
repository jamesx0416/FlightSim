import { expect, test } from 'bun:test'

import { resolveMsfsDragPercent, selectDragRoutes } from './interactionAdapter'
import type { CompiledInteractionRoute } from './types'

test('starts each authored drag lifecycle with its lock route', () => {
  const lock = { operation: 'lock', phase: null } as CompiledInteractionRoute
  const drag = { operation: 'turn', phase: 'drag' } as CompiledInteractionRoute

  expect(selectDragRoutes([drag, lock], true)).toEqual([lock, drag])
  expect(selectDragRoutes([drag, lock], false)).toEqual([drag])
})

test('projects pointer movement onto the authored drag trajectory', () => {
  const trajectory = [
    { relativeX: 0.2, relativeY: 0.8, dragPercent: 0 },
    { relativeX: 0.8, relativeY: 0.2, dragPercent: 1 }
  ]

  expect(resolveMsfsDragPercent(trajectory, 0.2, 0.8, 0.5)).toBe(0)
  expect(resolveMsfsDragPercent(trajectory, 0.8, 0.2, 0.5)).toBe(1)
  expect(resolveMsfsDragPercent(trajectory, 0.5, 0.5, 0, 0.25)).toBe(0.75)
  expect(resolveMsfsDragPercent([], 0.8, 0.2, 0.25)).toBe(0.25)
})
