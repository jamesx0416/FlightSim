import { expect, test } from 'bun:test'
import { COCKPIT_INPUT_STORE_KEY, DEFAULT_COCKPIT_INPUT_STORE, effectiveCockpitInputProfile, loadCockpitInputStore } from './cockpitInputProfiles'

test('profile defaults match MSFS legacy mouse and corrupt storage is preserved', () => {
  const values = new Map<string, string>([[COCKPIT_INPUT_STORE_KEY, '{bad']])
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } as unknown as Storage
  const store = loadCockpitInputStore(storage)
  expect(effectiveCockpitInputProfile(store).interactionMode).toBe('legacy')
  expect(DEFAULT_COCKPIT_INPUT_STORE.profiles[0]?.bindings?.Mouse1).toBe('tertiary')
  expect([...values.keys()].some(key => key.includes('.recovery.'))).toBe(true)
})
