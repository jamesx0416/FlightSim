import { expect, test } from 'bun:test'
import { COCKPIT_INPUT_STORE_KEY, DEFAULT_COCKPIT_INPUT_STORE, effectiveCockpitInputProfile, isCockpitInputStoreV1, loadCockpitInputStore, updateCockpitInputSettings } from './cockpitInputProfiles'

test('profile defaults match MSFS legacy mouse and corrupt storage is preserved', () => {
  const values = new Map<string, string>([[COCKPIT_INPUT_STORE_KEY, '{bad']])
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } as unknown as Storage
  const store = loadCockpitInputStore(storage)
  expect(effectiveCockpitInputProfile(store).interactionMode).toBe('legacy')
  expect(DEFAULT_COCKPIT_INPUT_STORE.profiles[0]?.bindings?.Mouse1).toBe('tertiary')
  expect([...values.keys()].some(key => key.includes('.recovery.'))).toBe(true)
})

test('profiles sparsely override global settings and reject ambiguous IDs', () => {
  const store = {
    ...structuredClone(DEFAULT_COCKPIT_INPUT_STORE),
    profiles: [...DEFAULT_COCKPIT_INPUT_STORE.profiles, { id: 'testing', name: 'Testing', interactionMode: 'lock' as const }]
  }
  const effective = effectiveCockpitInputProfile(store, 'testing')
  expect([effective.interactionMode, effective.showHighlights, effective.showTooltips]).toEqual(['lock', true, true])
  expect(isCockpitInputStoreV1({ ...store, profiles: [...store.profiles, { id: 'testing', name: 'Duplicate' }] })).toBe(false)
})

test('settings apply atomically while cancel reloads and reset restores defaults', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } as unknown as Storage
  updateCockpitInputSettings({ interactionMode: 'lock', showTooltips: false }, storage)
  expect(loadCockpitInputStore(storage).globalSettings).toEqual({ interactionMode: 'lock', showHighlights: true, showTooltips: false })
  const cancelledDraft = { ...loadCockpitInputStore(storage).globalSettings, interactionMode: 'legacy' as const }
  expect([cancelledDraft.interactionMode, loadCockpitInputStore(storage).globalSettings.interactionMode]).toEqual(['legacy', 'lock'])
  updateCockpitInputSettings(DEFAULT_COCKPIT_INPUT_STORE.globalSettings, storage)
  expect(loadCockpitInputStore(storage).globalSettings).toEqual(DEFAULT_COCKPIT_INPUT_STORE.globalSettings)
})
