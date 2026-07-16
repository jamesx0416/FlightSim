import { expect, test } from 'bun:test'

import type { CompiledBehaviorSet } from '../types'
import { collectProtectedNodeNames } from './collectProtectedNodeNames'

const behaviorSet = {
  animationBindings: [],
  visibilityBindings: [],
  materialBindings: [],
  interactionBindings: [{
    target: 'CONTROL',
    feedbackTargets: ['CONTROL_FEEDBACK'],
    metadata: { highlightNodeId: 'CONTROL_HIGHLIGHT' }
  }],
  interactionBlockers: [{ target: 'COVER', feedbackTargets: ['COVER_NODE'] }]
} as unknown as CompiledBehaviorSet

test('static optimizers protect interaction targets', () => {
  const names = collectProtectedNodeNames(behaviorSet)
  expect([
    'CONTROL', 'control', 'CONTROL_FEEDBACK', 'CONTROL_HIGHLIGHT', 'COVER', 'COVER_NODE'
  ].every(name => names.has(name))).toBe(true)
})
