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
    const value = JSON.parse(raw) as Partial<CockpitInputStoreV1>
    if (value.version !== 1 || !Array.isArray(value.profiles) || new Set(value.profiles.map(profile => profile.id)).size !== value.profiles.length) throw new Error('Invalid cockpit input store')
    return value as CockpitInputStoreV1
  } catch {
    storage.setItem(`${COCKPIT_INPUT_STORE_KEY}.recovery.${Date.now()}`, raw)
    return structuredClone(DEFAULT_COCKPIT_INPUT_STORE)
  }
}

export function saveCockpitInputStore(store: CockpitInputStoreV1, storage: Storage = localStorage): void {
  storage.setItem(COCKPIT_INPUT_STORE_KEY, JSON.stringify(store))
}

export function effectiveCockpitInputProfile(store: CockpitInputStoreV1, profileId = store.selectedGlobalProfileId): CockpitInputProfile & CockpitInputStoreV1['globalSettings'] {
  const profile = store.profiles.find(candidate => candidate.id === profileId) ?? store.profiles[0]
  if (profile == null) throw new Error('Cockpit input store has no profiles')
  return { ...store.globalSettings, ...profile }
}
