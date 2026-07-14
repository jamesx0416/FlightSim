import { expect, test } from 'bun:test'

import { __devApiInteractionTestHooks } from './devApi'
import type { MsfsInteractionTarget } from './msfs/interactionAdapter'

test('interaction requests return structured ambiguity and busy envelopes', () => {
  const ambiguous = __devApiInteractionTestHooks.resolveInteractionRequest(
    'SWITCH', { ok: false, code: 'TARGET_AMBIGUOUS', candidates: ['a.xml#SWITCH', 'b.xml#SWITCH'] }, new Set()
  )
  expect(ambiguous.ok ? null : ambiguous.result).toEqual({
    ok: false, code: 'TARGET_AMBIGUOUS', message: 'Interaction target "SWITCH" is ambiguous.',
    data: { target: 'SWITCH', candidates: ['a.xml#SWITCH', 'b.xml#SWITCH'] },
    suggestions: ['a.xml#SWITCH', 'b.xml#SWITCH']
  })

  const target = { id: 'a.xml#SWITCH' } as MsfsInteractionTarget
  const busy = __devApiInteractionTestHooks.resolveInteractionRequest('SWITCH', { ok: true, target }, new Set([target.id]))
  expect(busy.ok ? null : busy.result.code).toBe('TARGET_BUSY')
})
