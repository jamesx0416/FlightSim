import { expect, test } from 'bun:test'

import { __devApiInteractionTestHooks } from './devApi'
import { DEFAULT_COCKPIT_INPUT_PROFILE_ID, DEFAULT_COCKPIT_INPUT_STORE } from './input/cockpitInputProfiles'
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

test('input profile API manages v2 profiles and package-scoped selections without implicit selection', () => {
  let store = structuredClone(DEFAULT_COCKPIT_INPUT_STORE)
  let commitCount = 0
  const profiles = __devApiInteractionTestHooks.createCockpitInputProfilesApi({
    getStore: () => store,
    commit: next => {
      store = next
      commitCount += 1
    },
    packageRoot: '/current-package',
    aircraftId: 'current-aircraft'
  })

  const created = profiles.create('Captain')
  expect(created.ok).toBe(true)
  expect(created.data).toEqual({ id: 'captain', name: 'Captain' })
  expect(store.selectedGlobalProfileId).toBe(DEFAULT_COCKPIT_INPUT_PROFILE_ID)

  const duplicated = profiles.duplicate('captain')
  expect(duplicated.data).toEqual({ id: 'captain-copy', name: 'Captain Copy' })
  expect(store.selectedGlobalProfileId).toBe(DEFAULT_COCKPIT_INPUT_PROFILE_ID)
  expect(profiles.rename('captain', 'Pilot').ok).toBe(true)
  expect(profiles.selectGlobal('captain').ok).toBe(true)
  expect(profiles.selectAircraft('/package-a', 'shared', 'captain').ok).toBe(true)
  expect(profiles.selectAircraft('/package-b', 'shared', 'captain-copy').ok).toBe(true)

  expect(profiles.effective(undefined, '/package-a', 'shared').data).toEqual({
    id: 'captain',
    name: 'Pilot',
    interactionMode: 'legacy',
    showHighlights: true,
    showTooltips: true,
    bindings: {
      interaction: { Mouse0: 'primary', Mouse1: 'tertiary', Mouse2: 'secondary', WheelUp: 'increase', WheelDown: 'decrease' },
      emptyCockpit: { Mouse0: 'cameraPan', Mouse1: 'cameraPan', Mouse2: 'cameraPan', WheelUp: 'cameraZoomIn', WheelDown: 'cameraZoomOut' }
    }
  })
  expect((profiles.effective(undefined, '/package-b', 'shared').data as { id: string }).id).toBe('captain-copy')
  expect((profiles.effective().data as { id: string }).id).toBe('captain')

  expect(profiles.reset('captain').ok).toBe(true)
  expect(profiles.delete('captain-copy').ok).toBe(true)
  expect((profiles.effective(undefined, '/package-b', 'shared').data as { id: string }).id).toBe('captain')
  expect(profiles.selectAircraft('/package-a', 'shared', null).ok).toBe(true)
  expect((profiles.effective(undefined, '/package-a', 'shared').data as { id: string }).id).toBe('captain')

  const missing = profiles.get('missing')
  expect([missing.ok, missing.code, missing.suggestions]).toEqual([
    false,
    'PROFILE_NOT_FOUND',
    [DEFAULT_COCKPIT_INPUT_PROFILE_ID, 'captain']
  ])
  expect(profiles.delete(DEFAULT_COCKPIT_INPUT_PROFILE_ID).code).toBe('PROFILE_PROTECTED')
  expect(profiles.effective(undefined, '/package-only').code).toBe('INVALID_ARGUMENT')
  expect(profiles.import({ version: 1 }).code).toBe('INVALID_STORE')

  const exported = profiles.export().data
  expect(profiles.import(exported).ok).toBe(true)
  expect(profiles.list().data).toEqual(store.profiles)
  expect(commitCount).toBe(10)
})
