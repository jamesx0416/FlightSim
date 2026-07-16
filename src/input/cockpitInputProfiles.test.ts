import { expect, test } from 'bun:test'
import {
  COCKPIT_INPUT_STORE_KEY,
  DEFAULT_COCKPIT_INPUT_PROFILE_ID,
  DEFAULT_COCKPIT_INPUT_STORE,
  LEGACY_COCKPIT_INPUT_STORE_KEY,
  cockpitAircraftProfileKey,
  createCockpitInputProfile,
  deleteCockpitInputProfile,
  duplicateCockpitInputProfile,
  effectiveCockpitInputProfile,
  isCockpitInputStoreV2,
  loadCockpitInputStore,
  loadCockpitInputStoreWithDiagnostics,
  renameCockpitInputProfile,
  resetCockpitInputProfile,
  selectAircraftCockpitInputProfile,
  selectGlobalCockpitInputProfile,
  selectedCockpitInputProfileId,
  setCockpitInputBinding,
  updateCockpitInputSettings,
  type CockpitInputStoreV1
} from './cockpitInputProfiles'

function memoryStorage(entries: readonly (readonly [string, string])[] = []): {
  readonly storage: Storage
  readonly values: Map<string, string>
} {
  const values = new Map(entries)
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  } as unknown as Storage
  return { storage, values }
}

function errorMessage(run: () => void): string {
  try {
    run()
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

test('version 2 defaults resolve MSFS interaction and empty-cockpit mouse behavior', () => {
  const effective = effectiveCockpitInputProfile(structuredClone(DEFAULT_COCKPIT_INPUT_STORE))
  expect(effective.interactionMode).toBe('legacy')
  expect(effective.bindings.interaction).toEqual({
    Mouse0: 'primary',
    Mouse1: 'tertiary',
    Mouse2: 'secondary',
    WheelUp: 'increase',
    WheelDown: 'decrease'
  })
  expect(effective.bindings.emptyCockpit).toEqual({
    Mouse0: 'cameraPan',
    Mouse1: 'cameraPan',
    Mouse2: 'cameraPan',
    WheelUp: 'cameraZoomIn',
    WheelDown: 'cameraZoomOut'
  })
})

test('version 1 storage migrates once and preserves legacy aircraft selections as fallbacks', () => {
  const legacy: CockpitInputStoreV1 = {
    version: 1,
    selectedGlobalProfileId: DEFAULT_COCKPIT_INPUT_PROFILE_ID,
    aircraftProfileSelections: { shared: 'testing' },
    globalSettings: { interactionMode: 'legacy', showHighlights: true, showTooltips: true },
    profiles: [
      {
        id: DEFAULT_COCKPIT_INPUT_PROFILE_ID,
        name: 'MSFS Mouse',
        bindings: {
          Mouse0: 'primary',
          Mouse2: 'secondary',
          Mouse1: 'tertiary',
          WheelUp: 'increase',
          WheelDown: 'decrease',
          Escape: 'cancel'
        }
      },
      { id: 'testing', name: 'Testing', interactionMode: 'lock' }
    ]
  }
  const { storage, values } = memoryStorage([
    [LEGACY_COCKPIT_INPUT_STORE_KEY, JSON.stringify(legacy)]
  ])
  const result = loadCockpitInputStoreWithDiagnostics(storage)
  expect(result.store.version).toBe(2)
  expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
    'MIGRATED_V1',
    'MIGRATED_LEGACY_AIRCRAFT_SELECTION'
  ])
  expect(result.store.profiles[0]?.bindings).toBeUndefined()
  expect(selectedCockpitInputProfileId(result.store, '/package-a', 'shared')).toBe('testing')
  expect(values.has(COCKPIT_INPUT_STORE_KEY)).toBe(true)
  expect(loadCockpitInputStoreWithDiagnostics(storage).diagnostics).toEqual([])
})

test('corrupt current storage is preserved and returns a structured recovery diagnostic', () => {
  const { storage, values } = memoryStorage([[COCKPIT_INPUT_STORE_KEY, '{bad']])
  const result = loadCockpitInputStoreWithDiagnostics(storage)
  expect(result.store).toEqual(DEFAULT_COCKPIT_INPUT_STORE)
  expect(result.diagnostics.length).toBe(1)
  expect([result.diagnostics[0]?.code, result.diagnostics[0]?.severity]).toEqual([
    'RECOVERED_INVALID_STORE',
    'warning'
  ])
  expect(result.diagnostics[0]?.recoveryKey?.includes(`${COCKPIT_INPUT_STORE_KEY}.recovery.`)).toBe(true)
  expect(values.get(result.diagnostics[0]!.recoveryKey!)).toBe('{bad')
})

test('sparse profile overrides inherit defaults and explicit null unbinds them', () => {
  const store = {
    ...structuredClone(DEFAULT_COCKPIT_INPUT_STORE),
    profiles: [
      ...DEFAULT_COCKPIT_INPUT_STORE.profiles,
      {
        id: 'left-handed',
        name: 'Left handed',
        interactionMode: 'lock' as const,
        bindings: {
          interaction: { Mouse0: null, Mouse2: 'primary' as const },
          emptyCockpit: { Mouse2: null }
        }
      }
    ]
  }
  const effective = effectiveCockpitInputProfile(store, 'left-handed')
  expect(effective.interactionMode).toBe('lock')
  expect(effective.showHighlights).toBe(true)
  expect(effective.bindings.interaction.Mouse0).toBe(null)
  expect(effective.bindings.interaction.Mouse2).toBe('primary')
  expect(effective.bindings.emptyCockpit.Mouse2).toBe(null)
})

test('binding capture blocks a same-context claim but permits the same input across contexts', () => {
  const created = createCockpitInputProfile(structuredClone(DEFAULT_COCKPIT_INPUT_STORE), 'Custom')
  const conflict = setCockpitInputBinding(
    created.store,
    created.profile.id,
    'interaction',
    'secondary',
    'Mouse0'
  )
  expect([conflict.ok, conflict.conflictingAction]).toEqual([false, 'primary'])

  const cleared = setCockpitInputBinding(
    created.store,
    created.profile.id,
    'interaction',
    'tertiary',
    null
  )
  const rebound = setCockpitInputBinding(
    cleared.store,
    created.profile.id,
    'interaction',
    'primary',
    'Mouse1'
  )
  expect(rebound.ok).toBe(true)
  const interaction = effectiveCockpitInputProfile(rebound.store, created.profile.id).bindings.interaction
  expect([interaction.Mouse0, interaction.Mouse1]).toEqual([null, 'primary'])
  expect(effectiveCockpitInputProfile(rebound.store, created.profile.id).bindings.emptyCockpit.Mouse1).toBe('cameraPan')
})

test('profile CRUD protects the default and repairs selections when deleting a user profile', () => {
  const created = createCockpitInputProfile(structuredClone(DEFAULT_COCKPIT_INPUT_STORE), 'Captain')
  const duplicated = duplicateCockpitInputProfile(created.store, created.profile.id)
  expect([duplicated.profile.id, duplicated.profile.name]).toEqual(['captain-copy', 'Captain Copy'])

  let store = renameCockpitInputProfile(duplicated.store, duplicated.profile.id, 'First Officer')
  store = selectGlobalCockpitInputProfile(store, duplicated.profile.id)
  store = selectAircraftCockpitInputProfile(store, '/package-a', 'shared', duplicated.profile.id)
  store = selectAircraftCockpitInputProfile(store, '/package-b', 'shared', created.profile.id)
  expect(store.aircraftProfileSelections).toEqual({
    [cockpitAircraftProfileKey('/package-a', 'shared')]: duplicated.profile.id,
    [cockpitAircraftProfileKey('/package-b', 'shared')]: created.profile.id
  })

  store = resetCockpitInputProfile(store, duplicated.profile.id)
  expect(store.profiles.find(profile => profile.id === duplicated.profile.id)).toEqual({
    id: duplicated.profile.id,
    name: 'First Officer'
  })
  store = deleteCockpitInputProfile(store, duplicated.profile.id)
  expect(store.selectedGlobalProfileId).toBe(DEFAULT_COCKPIT_INPUT_PROFILE_ID)
  expect(store.aircraftProfileSelections).toEqual({
    [cockpitAircraftProfileKey('/package-b', 'shared')]: created.profile.id
  })
  expect(errorMessage(() => deleteCockpitInputProfile(store, DEFAULT_COCKPIT_INPUT_PROFILE_ID))).toBe('The MSFS Mouse profile cannot be deleted')
  expect(errorMessage(() => renameCockpitInputProfile(store, DEFAULT_COCKPIT_INPUT_PROFILE_ID, 'Other'))).toBe('The MSFS Mouse profile cannot be renamed')
})

test('store validation rejects duplicate IDs and incompatible physical bindings', () => {
  const store = structuredClone(DEFAULT_COCKPIT_INPUT_STORE)
  expect(isCockpitInputStoreV2({
    ...store,
    profiles: [...store.profiles, { id: DEFAULT_COCKPIT_INPUT_PROFILE_ID, name: 'Duplicate' }]
  })).toBe(false)
  expect(isCockpitInputStoreV2({
    ...store,
    profiles: [{
      ...store.profiles[0],
      bindings: { interaction: { WheelUp: 'primary' } }
    }]
  })).toBe(false)
})

test('settings updates save atomically while an unsaved draft does not change storage', () => {
  const { storage } = memoryStorage()
  updateCockpitInputSettings({ interactionMode: 'lock', showTooltips: false }, storage)
  expect(loadCockpitInputStore(storage).globalSettings).toEqual({
    interactionMode: 'lock',
    showHighlights: true,
    showTooltips: false
  })
  const stored = loadCockpitInputStore(storage)
  const draft = { ...stored, globalSettings: { ...stored.globalSettings, interactionMode: 'legacy' as const } }
  expect(draft.globalSettings.interactionMode).toBe('legacy')
  expect(loadCockpitInputStore(storage).globalSettings.interactionMode).toBe('lock')
  updateCockpitInputSettings(DEFAULT_COCKPIT_INPUT_STORE.globalSettings, storage)
  expect(loadCockpitInputStore(storage).globalSettings).toEqual(DEFAULT_COCKPIT_INPUT_STORE.globalSettings)
})
