import type { CockpitInteractionMode } from './cockpitInteraction'

export const COCKPIT_PHYSICAL_INPUTS = [
  'Mouse0',
  'Mouse1',
  'Mouse2',
  'WheelUp',
  'WheelDown'
] as const

export type CockpitPhysicalInput = (typeof COCKPIT_PHYSICAL_INPUTS)[number]
export type CockpitInputBindingContext = 'interaction' | 'emptyCockpit'
export type CockpitInteractionBindingAction =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'increase'
  | 'decrease'
export type EmptyCockpitBindingAction = 'cameraPan' | 'cameraZoomIn' | 'cameraZoomOut'
export type CockpitInputBindingAction = CockpitInteractionBindingAction | EmptyCockpitBindingAction
export type CockpitInputShortcut = 'stop'

export interface CockpitInputBindings {
  readonly interaction?: Readonly<Partial<Record<CockpitPhysicalInput, CockpitInteractionBindingAction | null>>>
  readonly emptyCockpit?: Readonly<Partial<Record<CockpitPhysicalInput, EmptyCockpitBindingAction | null>>>
  readonly shortcuts?: Readonly<Partial<Record<CockpitInputShortcut, string | null>>>
}

export interface CockpitInputProfile {
  readonly id: string
  readonly name: string
  readonly interactionMode?: CockpitInteractionMode
  readonly showHighlights?: boolean
  readonly showTooltips?: boolean
  readonly bindings?: CockpitInputBindings
}

export interface CockpitInputGlobalSettings {
  readonly interactionMode: CockpitInteractionMode
  readonly showHighlights: boolean
  readonly showTooltips: boolean
  readonly invertDefaultScrollDirection: boolean
}

export interface CockpitInputStoreV2 {
  readonly version: 2
  readonly selectedGlobalProfileId: string
  readonly aircraftProfileSelections: Readonly<Record<string, string>>
  readonly globalSettings: CockpitInputGlobalSettings
  readonly profiles: readonly CockpitInputProfile[]
}

export interface CockpitInputStoreV1 {
  readonly version: 1
  readonly selectedGlobalProfileId: string
  readonly aircraftProfileSelections: Readonly<Record<string, string>>
  readonly globalSettings: Omit<CockpitInputGlobalSettings, 'invertDefaultScrollDirection'> & {
    readonly invertDefaultScrollDirection?: boolean
  }
  readonly profiles: readonly (Omit<CockpitInputProfile, 'bindings'> & {
    readonly bindings?: Readonly<Record<string, string>>
  })[]
}

export interface EffectiveCockpitInputProfile extends CockpitInputGlobalSettings {
  readonly id: string
  readonly name: string
  readonly bindings: {
    readonly interaction: Readonly<Record<CockpitPhysicalInput, CockpitInteractionBindingAction | null>>
    readonly emptyCockpit: Readonly<Record<CockpitPhysicalInput, EmptyCockpitBindingAction | null>>
    readonly shortcuts: Readonly<Record<CockpitInputShortcut, string | null>>
  }
}

export type CockpitInputStoreDiagnosticCode =
  | 'MIGRATED_V1'
  | 'MIGRATED_LEGACY_AIRCRAFT_SELECTION'
  | 'RECOVERED_INVALID_STORE'

export interface CockpitInputStoreDiagnostic {
  readonly code: CockpitInputStoreDiagnosticCode
  readonly severity: 'info' | 'warning'
  readonly message: string
  readonly recoveryKey?: string
}

export interface CockpitInputStoreLoadResult {
  readonly store: CockpitInputStoreV2
  readonly diagnostics: readonly CockpitInputStoreDiagnostic[]
}

export const DEFAULT_COCKPIT_INPUT_PROFILE_ID = 'msfs-mouse'
export const COCKPIT_INPUT_STORE_KEY = 'flight-sim.cockpit-input.v2'
export const LEGACY_COCKPIT_INPUT_STORE_KEY = 'flight-sim.cockpit-input.v1'

export const DEFAULT_COCKPIT_INPUT_BINDINGS: EffectiveCockpitInputProfile['bindings'] = {
  interaction: {
    Mouse0: 'primary',
    Mouse1: 'tertiary',
    Mouse2: 'secondary',
    WheelUp: 'increase',
    WheelDown: 'decrease'
  },
  emptyCockpit: {
    Mouse0: 'cameraPan',
    Mouse1: 'cameraPan',
    Mouse2: 'cameraPan',
    WheelUp: 'cameraZoomIn',
    WheelDown: 'cameraZoomOut'
  },
  shortcuts: {
    stop: 'Escape'
  }
}

export const DEFAULT_COCKPIT_INPUT_STORE: CockpitInputStoreV2 = {
  version: 2,
  selectedGlobalProfileId: DEFAULT_COCKPIT_INPUT_PROFILE_ID,
  aircraftProfileSelections: {},
  globalSettings: { interactionMode: 'legacy', showHighlights: true, showTooltips: true, invertDefaultScrollDirection: false },
  profiles: [{ id: DEFAULT_COCKPIT_INPUT_PROFILE_ID, name: 'MSFS Mouse' }]
}

export function cockpitAircraftProfileKey(packageRoot: string, aircraftId: string): string {
  return `${encodeURIComponent(packageRoot)}::${encodeURIComponent(aircraftId)}`
}

function legacyAircraftProfileKey(aircraftId: string): string {
  return `legacy::${encodeURIComponent(aircraftId)}`
}

export function selectedCockpitInputProfileId(
  store: CockpitInputStoreV2,
  packageRoot: string,
  aircraftId: string
): string {
  return store.aircraftProfileSelections[cockpitAircraftProfileKey(packageRoot, aircraftId)]
    ?? store.aircraftProfileSelections[legacyAircraftProfileKey(aircraftId)]
    ?? store.selectedGlobalProfileId
}

export function loadCockpitInputStore(storage: Storage = localStorage): CockpitInputStoreV2 {
  return loadCockpitInputStoreWithDiagnostics(storage).store
}

export function loadCockpitInputStoreWithDiagnostics(
  storage: Storage = localStorage
): CockpitInputStoreLoadResult {
  const raw = storage.getItem(COCKPIT_INPUT_STORE_KEY)
  if (raw != null) {
    try {
      const value = JSON.parse(raw) as unknown
      if (!isCockpitInputStoreV2(value)) throw new Error('Invalid cockpit input store')
      return { store: value, diagnostics: [] }
    } catch (error) {
      return recoverInvalidStore(storage, COCKPIT_INPUT_STORE_KEY, raw, error)
    }
  }

  const legacyRaw = storage.getItem(LEGACY_COCKPIT_INPUT_STORE_KEY)
  if (legacyRaw == null) return { store: structuredClone(DEFAULT_COCKPIT_INPUT_STORE), diagnostics: [] }
  try {
    const value = JSON.parse(legacyRaw) as unknown
    if (!isCockpitInputStoreV1(value)) throw new Error('Invalid legacy cockpit input store')
    const result = migrateCockpitInputStoreV1(value)
    saveCockpitInputStore(result.store, storage)
    return result
  } catch (error) {
    return recoverInvalidStore(storage, LEGACY_COCKPIT_INPUT_STORE_KEY, legacyRaw, error)
  }
}

function recoverInvalidStore(
  storage: Storage,
  sourceKey: string,
  raw: string,
  error: unknown
): CockpitInputStoreLoadResult {
  const recoveryKey = `${sourceKey}.recovery.${Date.now()}`
  storage.setItem(recoveryKey, raw)
  storage.setItem(COCKPIT_INPUT_STORE_KEY, JSON.stringify(DEFAULT_COCKPIT_INPUT_STORE))
  console.warn('Recovered invalid cockpit input storage.', error)
  return {
    store: structuredClone(DEFAULT_COCKPIT_INPUT_STORE),
    diagnostics: [{
      code: 'RECOVERED_INVALID_STORE',
      severity: 'warning',
      message: 'Invalid cockpit input storage was preserved and defaults were restored.',
      recoveryKey
    }]
  }
}

function migrateCockpitInputStoreV1(store: CockpitInputStoreV1): CockpitInputStoreLoadResult {
  const diagnostics: CockpitInputStoreDiagnostic[] = [{
    code: 'MIGRATED_V1',
    severity: 'info',
    message: 'Cockpit input profiles were migrated from version 1 to version 2.'
  }]
  const profiles: CockpitInputProfile[] = store.profiles.map(profile => {
    const interaction: Partial<Record<CockpitPhysicalInput, CockpitInteractionBindingAction>> = {}
    for (const [input, action] of Object.entries(profile.bindings ?? {})) {
      if (!isCockpitPhysicalInput(input) || !isCockpitInteractionBindingAction(action)) continue
      if (DEFAULT_COCKPIT_INPUT_BINDINGS.interaction[input] !== action) interaction[input] = action
    }
    const bindings = Object.keys(interaction).length === 0 ? undefined : { interaction }
    return { ...profile, bindings }
  })
  if (!profiles.some(profile => profile.id === DEFAULT_COCKPIT_INPUT_PROFILE_ID)) {
    profiles.unshift(structuredClone(DEFAULT_COCKPIT_INPUT_STORE.profiles[0]!))
  }
  const aircraftProfileSelections = Object.fromEntries(
    Object.entries(store.aircraftProfileSelections).map(([aircraftId, profileId]) => [
      legacyAircraftProfileKey(aircraftId),
      profileId
    ])
  )
  if (Object.keys(aircraftProfileSelections).length > 0) {
    diagnostics.push({
      code: 'MIGRATED_LEGACY_AIRCRAFT_SELECTION',
      severity: 'info',
      message: 'Legacy aircraft selections remain as fallbacks until a package-scoped selection is saved.'
    })
  }
  return {
    store: {
      version: 2,
      selectedGlobalProfileId: store.selectedGlobalProfileId,
      aircraftProfileSelections,
      globalSettings: {
        ...store.globalSettings,
        invertDefaultScrollDirection: store.globalSettings.invertDefaultScrollDirection ?? false
      },
      profiles
    },
    diagnostics
  }
}

export function saveCockpitInputStore(
  store: CockpitInputStoreV2,
  storage: Storage = localStorage
): void {
  if (!isCockpitInputStoreV2(store)) throw new Error('Invalid cockpit input store')
  storage.setItem(COCKPIT_INPUT_STORE_KEY, JSON.stringify(store))
}

export function updateCockpitInputSettings(
  settings: Partial<CockpitInputGlobalSettings>,
  storage: Storage = localStorage
): CockpitInputGlobalSettings {
  const store = loadCockpitInputStore(storage)
  const globalSettings = { ...store.globalSettings, ...settings }
  saveCockpitInputStore({ ...store, globalSettings }, storage)
  return globalSettings
}

export function effectiveCockpitInputProfile(
  store: CockpitInputStoreV2,
  profileId = store.selectedGlobalProfileId
): EffectiveCockpitInputProfile {
  const profile = store.profiles.find(candidate => candidate.id === profileId)
    ?? store.profiles.find(candidate => candidate.id === DEFAULT_COCKPIT_INPUT_PROFILE_ID)
  if (profile == null) throw new Error('Cockpit input store has no default profile')
  return {
    ...store.globalSettings,
    ...profile,
    bindings: {
      interaction: { ...DEFAULT_COCKPIT_INPUT_BINDINGS.interaction, ...profile.bindings?.interaction },
      emptyCockpit: { ...DEFAULT_COCKPIT_INPUT_BINDINGS.emptyCockpit, ...profile.bindings?.emptyCockpit },
      shortcuts: { ...DEFAULT_COCKPIT_INPUT_BINDINGS.shortcuts, ...profile.bindings?.shortcuts }
    }
  }
}

export function cockpitPhysicalInputForPointerButton(button: number): CockpitPhysicalInput | null {
  return button === 0 ? 'Mouse0' : button === 1 ? 'Mouse1' : button === 2 ? 'Mouse2' : null
}

export function cockpitPhysicalInputForWheel(deltaY: number): CockpitPhysicalInput | null {
  return deltaY < 0 ? 'WheelUp' : deltaY > 0 ? 'WheelDown' : null
}

export function resolveCockpitInputBindings(
  profile: EffectiveCockpitInputProfile,
  input: CockpitPhysicalInput
): {
  readonly interaction: CockpitInteractionBindingAction | null
  readonly emptyCockpit: EmptyCockpitBindingAction | null
} {
  return {
    interaction: profile.bindings.interaction[input],
    emptyCockpit: profile.bindings.emptyCockpit[input]
  }
}

export function resolveCockpitInputShortcut(
  profile: EffectiveCockpitInputProfile,
  input: string
): CockpitInputShortcut | null {
  return profile.bindings.shortcuts.stop === input ? 'stop' : null
}

export interface CockpitInputProfileChange {
  readonly store: CockpitInputStoreV2
  readonly profile: CockpitInputProfile
}

export function createCockpitInputProfile(
  store: CockpitInputStoreV2,
  name: string
): CockpitInputProfileChange {
  const profile = { id: uniqueProfileId(store, name), name: validProfileName(name) }
  return { store: { ...store, profiles: [...store.profiles, profile] }, profile }
}

export function duplicateCockpitInputProfile(
  store: CockpitInputStoreV2,
  profileId: string,
  name = `${requireProfile(store, profileId).name} Copy`
): CockpitInputProfileChange {
  const source = requireProfile(store, profileId)
  const profile = { ...structuredClone(source), id: uniqueProfileId(store, name), name: validProfileName(name) }
  return { store: { ...store, profiles: [...store.profiles, profile] }, profile }
}

export function renameCockpitInputProfile(
  store: CockpitInputStoreV2,
  profileId: string,
  name: string
): CockpitInputStoreV2 {
  if (profileId === DEFAULT_COCKPIT_INPUT_PROFILE_ID) throw new Error('The MSFS Mouse profile cannot be renamed')
  requireProfile(store, profileId)
  return replaceProfile(store, profileId, profile => ({ ...profile, name: validProfileName(name) }))
}

export function deleteCockpitInputProfile(
  store: CockpitInputStoreV2,
  profileId: string
): CockpitInputStoreV2 {
  if (profileId === DEFAULT_COCKPIT_INPUT_PROFILE_ID) throw new Error('The MSFS Mouse profile cannot be deleted')
  requireProfile(store, profileId)
  return {
    ...store,
    selectedGlobalProfileId: store.selectedGlobalProfileId === profileId
      ? DEFAULT_COCKPIT_INPUT_PROFILE_ID
      : store.selectedGlobalProfileId,
    aircraftProfileSelections: Object.fromEntries(
      Object.entries(store.aircraftProfileSelections).filter(([, id]) => id !== profileId)
    ),
    profiles: store.profiles.filter(profile => profile.id !== profileId)
  }
}

export function resetCockpitInputProfile(
  store: CockpitInputStoreV2,
  profileId: string
): CockpitInputStoreV2 {
  requireProfile(store, profileId)
  return replaceProfile(store, profileId, profile => ({ id: profile.id, name: profile.name }))
}

export function selectGlobalCockpitInputProfile(
  store: CockpitInputStoreV2,
  profileId: string
): CockpitInputStoreV2 {
  requireProfile(store, profileId)
  return { ...store, selectedGlobalProfileId: profileId }
}

export function selectAircraftCockpitInputProfile(
  store: CockpitInputStoreV2,
  packageRoot: string,
  aircraftId: string,
  profileId: string | null
): CockpitInputStoreV2 {
  if (profileId != null) requireProfile(store, profileId)
  const selections = { ...store.aircraftProfileSelections }
  const key = cockpitAircraftProfileKey(packageRoot, aircraftId)
  if (profileId == null) delete selections[key]
  else selections[key] = profileId
  delete selections[legacyAircraftProfileKey(aircraftId)]
  return { ...store, aircraftProfileSelections: selections }
}

export interface CockpitInputBindingChange {
  readonly ok: boolean
  readonly store: CockpitInputStoreV2
  readonly conflictingAction?: CockpitInputBindingAction
}

export function setCockpitInputBinding(
  store: CockpitInputStoreV2,
  profileId: string,
  context: CockpitInputBindingContext,
  action: CockpitInputBindingAction,
  input: CockpitPhysicalInput | null
): CockpitInputBindingChange {
  const profile = requireProfile(store, profileId)
  if (!isBindingActionForContext(context, action)) throw new Error(`${action} is not valid for ${context}`)
  if (input != null && !isCompatibleBinding(context, input, action)) {
    throw new Error(`${input} cannot be assigned to ${action}`)
  }
  const effective = effectiveCockpitInputProfile(store, profileId).bindings[context] as Readonly<
    Record<CockpitPhysicalInput, CockpitInputBindingAction | null>
  >
  const conflictingAction = input == null ? null : effective[input]
  if (conflictingAction != null && conflictingAction !== action) {
    return { ok: false, store, conflictingAction }
  }

  const overrides: Partial<Record<CockpitPhysicalInput, CockpitInputBindingAction | null>> = {
    ...(profile.bindings?.[context] as Partial<Record<CockpitPhysicalInput, CockpitInputBindingAction | null>> | undefined)
  }
  for (const physicalInput of COCKPIT_PHYSICAL_INPUTS) {
    if (effective[physicalInput] === action && physicalInput !== input) overrides[physicalInput] = null
  }
  if (input != null) overrides[input] = action
  const defaults = DEFAULT_COCKPIT_INPUT_BINDINGS[context] as Readonly<
    Record<CockpitPhysicalInput, CockpitInputBindingAction | null>
  >
  for (const physicalInput of COCKPIT_PHYSICAL_INPUTS) {
    if (overrides[physicalInput] === defaults[physicalInput]) delete overrides[physicalInput]
  }
  const bindings: CockpitInputBindings = {
    ...profile.bindings,
    [context]: overrides
  }
  const nextProfile = {
    ...profile,
    bindings: Object.values(bindings).some(value => value != null && Object.keys(value).length > 0)
      ? bindings
      : undefined
  }
  return { ok: true, store: replaceProfile(store, profileId, () => nextProfile) }
}

export function setCockpitInputShortcut(
  store: CockpitInputStoreV2,
  profileId: string,
  shortcut: CockpitInputShortcut,
  input: string | null
): CockpitInputStoreV2 {
  if (input != null && !isCockpitShortcutCode(input)) throw new Error(`${input} is not a valid keyboard code`)
  const profile = requireProfile(store, profileId)
  const overrides: Partial<Record<CockpitInputShortcut, string | null>> = {
    ...profile.bindings?.shortcuts
  }
  if (input === DEFAULT_COCKPIT_INPUT_BINDINGS.shortcuts[shortcut]) delete overrides[shortcut]
  else overrides[shortcut] = input
  const bindings: CockpitInputBindings = { ...profile.bindings, shortcuts: overrides }
  const nextProfile = {
    ...profile,
    bindings: Object.values(bindings).some(value => value != null && Object.keys(value).length > 0)
      ? bindings
      : undefined
  }
  return replaceProfile(store, profileId, () => nextProfile)
}

function replaceProfile(
  store: CockpitInputStoreV2,
  profileId: string,
  update: (profile: CockpitInputProfile) => CockpitInputProfile
): CockpitInputStoreV2 {
  return {
    ...store,
    profiles: store.profiles.map(profile => profile.id === profileId ? update(profile) : profile)
  }
}

function requireProfile(store: CockpitInputStoreV2, profileId: string): CockpitInputProfile {
  const profile = store.profiles.find(candidate => candidate.id === profileId)
  if (profile == null) throw new Error(`Unknown cockpit input profile: ${profileId}`)
  return profile
}

function validProfileName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('Profile name is required')
  return trimmed
}

function uniqueProfileId(store: CockpitInputStoreV2, name: string): string {
  const base = validProfileName(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile'
  const ids = new Set(store.profiles.map(profile => profile.id))
  if (!ids.has(base)) return base
  let suffix = 2
  while (ids.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function isCompatibleBinding(
  context: CockpitInputBindingContext,
  input: CockpitPhysicalInput,
  action: CockpitInputBindingAction
): boolean {
  const wheel = input === 'WheelUp' || input === 'WheelDown'
  if (context === 'interaction') return wheel ? action === 'increase' || action === 'decrease' : action === 'primary' || action === 'secondary' || action === 'tertiary'
  return wheel ? action === 'cameraZoomIn' || action === 'cameraZoomOut' : action === 'cameraPan'
}

function isBindingActionForContext(
  context: CockpitInputBindingContext,
  action: string
): action is CockpitInputBindingAction {
  return context === 'interaction'
    ? isCockpitInteractionBindingAction(action)
    : action === 'cameraPan' || action === 'cameraZoomIn' || action === 'cameraZoomOut'
}

function isCockpitPhysicalInput(value: string): value is CockpitPhysicalInput {
  return (COCKPIT_PHYSICAL_INPUTS as readonly string[]).includes(value)
}

function isCockpitInteractionBindingAction(value: string): value is CockpitInteractionBindingAction {
  return value === 'primary' || value === 'secondary' || value === 'tertiary' || value === 'increase' || value === 'decrease'
}

export function isCockpitInputStoreV2(value: unknown): value is CockpitInputStoreV2 {
  if (value == null || typeof value !== 'object') return false
  const store = value as Partial<CockpitInputStoreV2>
  if (store.version !== 2 || !Array.isArray(store.profiles) || store.profiles.length === 0) return false
  if (typeof store.selectedGlobalProfileId !== 'string' || !isRecord(store.aircraftProfileSelections)) return false
  if (!isGlobalSettings(store.globalSettings)) return false
  const ids = new Set<string>()
  for (const profile of store.profiles) {
    if (!isProfile(profile) || ids.has(profile.id)) return false
    ids.add(profile.id)
  }
  if (!ids.has(DEFAULT_COCKPIT_INPUT_PROFILE_ID) || !ids.has(store.selectedGlobalProfileId)) return false
  return Object.values(store.aircraftProfileSelections).every(id => typeof id === 'string' && ids.has(id))
}

export function isCockpitInputStoreV1(value: unknown): value is CockpitInputStoreV1 {
  if (value == null || typeof value !== 'object') return false
  const store = value as Partial<CockpitInputStoreV1>
  if (store.version !== 1 || !Array.isArray(store.profiles) || store.profiles.length === 0) return false
  if (typeof store.selectedGlobalProfileId !== 'string' || !isRecord(store.aircraftProfileSelections)) return false
  if (!isLegacyGlobalSettings(store.globalSettings)) return false
  const ids = new Set<string>()
  for (const profile of store.profiles) {
    if (profile == null || typeof profile !== 'object' || typeof profile.id !== 'string' || profile.id === '' || typeof profile.name !== 'string' || ids.has(profile.id)) return false
    if (profile.bindings != null && !isRecord(profile.bindings)) return false
    ids.add(profile.id)
  }
  if (!ids.has(store.selectedGlobalProfileId)) return false
  return Object.values(store.aircraftProfileSelections).every(id => typeof id === 'string' && ids.has(id))
}

function isProfile(value: unknown): value is CockpitInputProfile {
  if (value == null || typeof value !== 'object') return false
  const profile = value as Partial<CockpitInputProfile>
  if (typeof profile.id !== 'string' || profile.id === '' || typeof profile.name !== 'string' || profile.name.trim() === '') return false
  if (profile.interactionMode != null && profile.interactionMode !== 'legacy' && profile.interactionMode !== 'lock') return false
  if (profile.showHighlights != null && typeof profile.showHighlights !== 'boolean') return false
  if (profile.showTooltips != null && typeof profile.showTooltips !== 'boolean') return false
  if (profile.bindings == null) return true
  if (!isRecord(profile.bindings)) return false
  return isBindingOverrides('interaction', profile.bindings.interaction)
    && isBindingOverrides('emptyCockpit', profile.bindings.emptyCockpit)
    && isShortcutOverrides(profile.bindings.shortcuts)
}

function isBindingOverrides(context: CockpitInputBindingContext, value: unknown): boolean {
  if (value == null) return true
  if (!isRecord(value)) return false
  return Object.entries(value).every(([input, action]) =>
    isCockpitPhysicalInput(input)
    && (action === null || (typeof action === 'string' && isBindingActionForContext(context, action) && isCompatibleBinding(context, input, action)))
  )
}

function isShortcutOverrides(value: unknown): boolean {
  if (value == null) return true
  if (!isRecord(value)) return false
  return Object.entries(value).every(([shortcut, input]) =>
    shortcut === 'stop' && (input === null || isCockpitShortcutCode(input))
  )
}

function isCockpitShortcutCode(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
}

function isLegacyGlobalSettings(value: unknown): value is CockpitInputStoreV1['globalSettings'] {
  if (!isRecord(value)) return false
  return (value.interactionMode === 'legacy' || value.interactionMode === 'lock')
    && typeof value.showHighlights === 'boolean'
    && typeof value.showTooltips === 'boolean'
    && (value.invertDefaultScrollDirection == null || typeof value.invertDefaultScrollDirection === 'boolean')
}

function isGlobalSettings(value: unknown): value is CockpitInputGlobalSettings {
  if (!isRecord(value)) return false
  return (value.interactionMode === 'legacy' || value.interactionMode === 'lock')
    && typeof value.showHighlights === 'boolean'
    && typeof value.showTooltips === 'boolean'
    && typeof value.invertDefaultScrollDirection === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
