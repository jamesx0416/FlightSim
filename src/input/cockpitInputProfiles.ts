import type { CockpitInteractionMode } from './cockpitInteraction'

export interface CockpitInputProfile {
  readonly id: string
  readonly name: string
  readonly interactionMode?: CockpitInteractionMode
  readonly showHighlights?: boolean
  readonly showTooltips?: boolean
  readonly bindings?: Readonly<Record<string, string>>
}

export interface CockpitInputStoreV1 {
  readonly version: 1
  readonly selectedGlobalProfileId: string
  readonly aircraftProfileSelections: Readonly<Record<string, string>>
  readonly globalSettings: { readonly interactionMode: CockpitInteractionMode; readonly showHighlights: boolean; readonly showTooltips: boolean }
  readonly profiles: readonly CockpitInputProfile[]
}

export const DEFAULT_COCKPIT_INPUT_STORE: CockpitInputStoreV1 = {
  version: 1,
  selectedGlobalProfileId: 'msfs-mouse',
  aircraftProfileSelections: {},
  globalSettings: { interactionMode: 'legacy', showHighlights: true, showTooltips: true },
  profiles: [{ id: 'msfs-mouse', name: 'MSFS Mouse', bindings: { Mouse0: 'primary', Mouse2: 'secondary', Mouse1: 'tertiary', WheelUp: 'increase', WheelDown: 'decrease', Escape: 'cancel' } }]
}

export const COCKPIT_INPUT_STORE_KEY = 'flight-sim.cockpit-input.v1'

export function loadCockpitInputStore(storage: Storage = localStorage): CockpitInputStoreV1 {
  const raw = storage.getItem(COCKPIT_INPUT_STORE_KEY)
  if (raw == null) return structuredClone(DEFAULT_COCKPIT_INPUT_STORE)
  try {
    const value = JSON.parse(raw) as unknown
    if (!isCockpitInputStoreV1(value)) throw new Error('Invalid cockpit input store')
    return value
  } catch (error) {
    storage.setItem(`${COCKPIT_INPUT_STORE_KEY}.recovery.${Date.now()}`, raw)
    console.warn('Recovered invalid cockpit input storage.', error)
    return structuredClone(DEFAULT_COCKPIT_INPUT_STORE)
  }
}

export function saveCockpitInputStore(store: CockpitInputStoreV1, storage: Storage = localStorage): void {
  if (!isCockpitInputStoreV1(store)) throw new Error('Invalid cockpit input store')
  storage.setItem(COCKPIT_INPUT_STORE_KEY, JSON.stringify(store))
}

export function updateCockpitInputSettings(
  settings: Partial<CockpitInputStoreV1['globalSettings']>,
  storage: Storage = localStorage
): CockpitInputStoreV1['globalSettings'] {
  const store = loadCockpitInputStore(storage)
  const globalSettings = { ...store.globalSettings, ...settings }
  saveCockpitInputStore({ ...store, globalSettings }, storage)
  return globalSettings
}

export function effectiveCockpitInputProfile(store: CockpitInputStoreV1, profileId = store.selectedGlobalProfileId): CockpitInputProfile & CockpitInputStoreV1['globalSettings'] {
  const profile = store.profiles.find(candidate => candidate.id === profileId) ?? store.profiles[0]
  if (profile == null) throw new Error('Cockpit input store has no profiles')
  return { ...store.globalSettings, ...profile }
}

export function isCockpitInputStoreV1(value: unknown): value is CockpitInputStoreV1 {
  if (value == null || typeof value !== 'object') return false
  const store = value as Partial<CockpitInputStoreV1>
  if (store.version !== 1 || !Array.isArray(store.profiles) || store.profiles.length === 0) return false
  if (typeof store.selectedGlobalProfileId !== 'string' || store.aircraftProfileSelections == null || typeof store.aircraftProfileSelections !== 'object') return false
  if (store.globalSettings == null || (store.globalSettings.interactionMode !== 'legacy' && store.globalSettings.interactionMode !== 'lock')) return false
  if (typeof store.globalSettings.showHighlights !== 'boolean' || typeof store.globalSettings.showTooltips !== 'boolean') return false
  const ids = new Set<string>()
  for (const profile of store.profiles) {
    if (profile == null || typeof profile !== 'object' || typeof profile.id !== 'string' || !profile.id || typeof profile.name !== 'string' || ids.has(profile.id)) return false
    ids.add(profile.id)
  }
  if (!ids.has(store.selectedGlobalProfileId)) return false
  return Object.values(store.aircraftProfileSelections).every(id => typeof id === 'string' && ids.has(id))
}
