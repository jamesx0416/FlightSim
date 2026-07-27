import { expect, test } from 'bun:test'

import {
  resolveCockpitInputDecision,
  type CockpitInputConsumeReason,
  type CockpitInputHit
} from './cockpitInputArbitration'

test('claimed cockpit input always wins over an empty-cockpit camera mapping', () => {
  const active: CockpitInputHit<string> = { kind: 'active', binding: 'CONTROL' }
  expect(resolveCockpitInputDecision(active, true)).toEqual({ kind: 'interaction', binding: 'CONTROL' })
  expect(resolveCockpitInputDecision(active, false)).toEqual({ kind: 'interaction', binding: 'CONTROL' })

  const reasons: readonly CockpitInputConsumeReason[] = [
    'interaction',
    'input-unbound',
    'operation-unsupported',
    'target-busy',
    'interaction-unavailable',
    'blocker',
    'cover'
  ]
  for (const reason of reasons) {
    expect(resolveCockpitInputDecision({ kind: 'consumed', reason }, true)).toEqual({
      kind: 'consumed',
      reason
    })
  }
})

test('only a true miss can use a mapped empty-cockpit camera action', () => {
  expect(resolveCockpitInputDecision({ kind: 'miss' }, true)).toEqual({ kind: 'camera' })
  expect(resolveCockpitInputDecision({ kind: 'miss' }, false)).toEqual({
    kind: 'consumed',
    reason: 'input-unbound'
  })
})
