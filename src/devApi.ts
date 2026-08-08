import {
  Box3,
  Box3Helper,
  Group,
  type Material,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3
} from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import {
  clearAircraftRangeCache,
  getAircraftAssetCacheSnapshot
} from './aircraftAssets/rangeCache'
import {
  clearMsfsBehaviorDocumentCache,
  getMsfsBehaviorAssetSnapshot
} from './msfs/behavior'
import {
  AircraftRuntime,
  SharedMsfsRuntimeHost,
  type RuntimeBridgeEvent,
  type RuntimeEffectEvent,
  type RuntimeHtmlEvent,
  type RuntimeKeyEvent,
  type RuntimeSoundEvent
} from './msfs/runtime'
import {
  mapMsfsLocalVarToCanonicalState,
  mapMsfsSimVarToCanonicalState,
} from './msfs/compatibilityBridge'
import type {
  CompiledBehaviorSet,
  CompiledExpression,
  CompiledInteractionBlocker,
  CompiledInteractionRoute,
  ImportedAircraft,
  ImportDiagnostic,
  RuntimeState
} from './msfs/types'
import { resolveMsfsInteractionPresentation, type MsfsLocalization } from './msfs/localization'
import {
  getMsfsPackageSourceCacheSnapshot,
  refreshMsfsPackageSourceVersions
} from './msfs/packageAssets'
import type { RendererInfo } from './rendering/createAppRenderer'
import { MsfsInteractionAdapter, type InteractionResolution, type MsfsInteractionTarget } from './msfs/interactionAdapter'
import type { MsfsInteractionLifecycle } from './msfs/interactionLifecycle'
import { CockpitInteractionDispatcher, type CanonicalCockpitAction, type CockpitInteractionChannel, type CockpitInteractionOperation, type CockpitRelativeDirection } from './input/cockpitInteraction'
import type { CockpitInteractionHistory, CockpitInteractionTrace } from './input/cockpitInteractionHistory'
import {
  DEFAULT_COCKPIT_INPUT_PROFILE_ID,
  DEFAULT_COCKPIT_INPUT_STORE,
  createCockpitInputProfile,
  deleteCockpitInputProfile,
  duplicateCockpitInputProfile,
  effectiveCockpitInputProfile,
  isCockpitInputStoreV2,
  loadCockpitInputStore,
  renameCockpitInputProfile,
  resetCockpitInputProfile,
  saveCockpitInputStore,
  selectAircraftCockpitInputProfile,
  selectGlobalCockpitInputProfile,
  selectedCockpitInputProfileId,
  updateCockpitInputSettings,
  type CockpitInputStoreV2
} from './input/cockpitInputProfiles'
import { listCanonicalEngineCommands, type SimCommand, type SimUnit } from './sim/engine'
import type {
  CockpitCameraController,
  CockpitInteractionPickRegistry,
  CockpitPerfDiagnostics,
  FpsCounterSnapshot,
  LoadedAircraftModel,
  VCockpitHtmlGaugeRuntime,
  ViewerConfigProfile
} from './main'

declare global {
  interface Window {
    __DevApi?: ViewerDevApi
  }
}

type DevApiResponse<T = unknown, TFailure = unknown> =
  | {
      readonly ok: true
      readonly summary: string
      readonly data: T
      readonly warnings?: readonly string[]
    }
  | {
      readonly ok: false
      readonly summary: string
      readonly data: TFailure
      readonly warnings?: readonly string[]
    }

type DevApiStatusData = Readonly<Record<string, unknown>> & {
  readonly loadStage: Readonly<Record<string, unknown>> | null
  readonly counts?: Readonly<Record<string, number>> & {
    readonly gauges?: number
    readonly loadedGauges?: number
    readonly capturedGauges?: number
  }
  readonly diagnostics?: Readonly<Record<string, number>> & {
    readonly error?: number
  }
}

type DevApiGaugeSummary = Readonly<Record<string, unknown>> & {
  readonly key: string
  readonly textureName: string
  readonly captured: boolean
  readonly hasCaptureImage: boolean
}

type DevApiGaugeCheckData = {
  readonly gauge: DevApiGaugeSummary
  readonly screenshot: string | null
}

type DevApiGaugeCheckFailure = {
  readonly key: string | undefined
  readonly gauges: readonly DevApiGaugeSummary[]
}

function getDevApiLoadStage(): Readonly<Record<string, unknown>> | null {
  const value = (globalThis as Record<string, unknown>).__msfsLoadStage
  if (typeof value !== 'object' || value == null) {
    return null
  }
  return value as Record<string, unknown>
}

type DevApiInteractionResult<T = unknown> = {
  readonly ok: boolean
  readonly code: string
  readonly message: string
  readonly data: T
  readonly suggestions: readonly string[]
}

const interactionResult = <T>(ok: boolean, code: string, message: string, data: T, suggestions: readonly string[] = []): DevApiInteractionResult<T> =>
  ({ ok, code, message, data, suggestions })

const interactionResolutionFailure = (target: string, result: Extract<InteractionResolution, { ok: false }>) =>
  interactionResult(false, result.code, result.code === 'TARGET_AMBIGUOUS' ? `Interaction target "${target}" is ambiguous.` : `Interaction target "${target}" was not found.`, { target, candidates: result.candidates }, result.candidates)

function resolveInteractionRequest(
  targetName: string,
  resolution: InteractionResolution,
  busyTargetIds: ReadonlySet<string>,
  rejectBusy = true
): { readonly ok: true; readonly target: MsfsInteractionTarget } | { readonly ok: false; readonly result: DevApiInteractionResult } {
  if (!resolution.ok) return { ok: false, result: interactionResolutionFailure(targetName, resolution) }
  if (rejectBusy && busyTargetIds.has(resolution.target.id)) {
    return { ok: false, result: interactionResult(false, 'TARGET_BUSY', `${targetName} is busy.`, { target: resolution.target.id }) }
  }
  return resolution
}

type InteractionSelector = { readonly interaction?: CockpitInteractionChannel; readonly variant?: string }
type InteractionActionOptions = InteractionSelector & { readonly steps?: number }

type DevApiInteractions = {
  readonly list: (options?: { readonly filter?: string; readonly limit?: number }) => DevApiInteractionResult
  readonly describe: (target: string) => DevApiInteractionResult
  readonly active: () => DevApiInteractionResult
  readonly history: (options?: { readonly limit?: number }) => DevApiInteractionResult
  readonly trace: {
    readonly snapshot: () => DevApiInteractionResult
    readonly enable: (enabled?: boolean) => DevApiInteractionResult
    readonly export: () => DevApiInteractionResult
  }
  readonly profiles: {
    readonly list: () => DevApiInteractionResult
    readonly get: (profileId: string) => DevApiInteractionResult
    readonly effective: (profileId?: string, packageRoot?: string, aircraftId?: string) => DevApiInteractionResult
    readonly create: (name: string) => DevApiInteractionResult
    readonly duplicate: (profileId: string, name?: string) => DevApiInteractionResult
    readonly rename: (profileId: string, name: string) => DevApiInteractionResult
    readonly delete: (profileId: string) => DevApiInteractionResult
    readonly reset: (profileId: string) => DevApiInteractionResult
    readonly selectGlobal: (profileId: string) => DevApiInteractionResult
    readonly selectAircraft: (packageRoot: string, aircraftId: string, profileId: string | null) => DevApiInteractionResult
    readonly export: () => DevApiInteractionResult
    readonly import: (store: unknown) => DevApiInteractionResult
  }
  readonly settings: { readonly get: () => DevApiInteractionResult; readonly set: (settings: Partial<CockpitInputStoreV2['globalSettings']>) => DevApiInteractionResult }
  readonly press: (target: string, options?: InteractionSelector) => Promise<DevApiInteractionResult>
  readonly hold: (target: string, options?: InteractionSelector) => Promise<DevApiInteractionResult>
  readonly release: (target: string, options?: InteractionSelector) => Promise<DevApiInteractionResult>
  readonly turn: (target: string, options: InteractionActionOptions & { readonly direction: CockpitRelativeDirection }) => Promise<DevApiInteractionResult>
  readonly increase: (target: string, options?: InteractionActionOptions) => Promise<DevApiInteractionResult>
  readonly decrease: (target: string, options?: InteractionActionOptions) => Promise<DevApiInteractionResult>
  readonly adjust: (target: string, options: InteractionSelector & { readonly delta: number; readonly unit?: string }) => Promise<DevApiInteractionResult>
  readonly set: (target: string, options: InteractionSelector & { readonly value: number | boolean | string; readonly unit?: string }) => Promise<DevApiInteractionResult>
  readonly on: (target: string, options?: InteractionSelector) => Promise<DevApiInteractionResult>
  readonly off: (target: string, options?: InteractionSelector) => Promise<DevApiInteractionResult>
  readonly toggle: (target: string, options?: InteractionSelector) => Promise<DevApiInteractionResult>
  readonly stop: (target: string) => DevApiInteractionResult
  readonly stopAll: () => DevApiInteractionResult
  readonly dispatch: (target: string, action: CanonicalCockpitAction) => Promise<DevApiInteractionResult>
}

type CockpitInputProfilesApiContext = {
  readonly getStore: () => CockpitInputStoreV2
  readonly commit: (store: CockpitInputStoreV2) => void
  readonly packageRoot: string
  readonly aircraftId: string
}

function createCockpitInputProfilesApi(
  context: CockpitInputProfilesApiContext
): DevApiInteractions['profiles'] {
  const profileIds = (): readonly string[] => context.getStore().profiles.map(profile => profile.id)
  const missing = (profileId: string): DevApiInteractionResult => interactionResult(
    false,
    'PROFILE_NOT_FOUND',
    `Input profile "${profileId}" was not found.`,
    { profileId },
    profileIds()
  )
  const invalidName = (): DevApiInteractionResult => interactionResult(
    false,
    'INVALID_ARGUMENT',
    'Profile name is required.',
    null
  )
  const protectedProfile = (profileId: string): DevApiInteractionResult => interactionResult(
    false,
    'PROFILE_PROTECTED',
    `Input profile "${profileId}" is protected.`,
    { profileId }
  )
  const findProfile = (profileId: string) =>
    context.getStore().profiles.find(profile => profile.id === profileId) ?? null
  const apply = <T>(store: CockpitInputStoreV2, message: string, data: T): DevApiInteractionResult<T> => {
    context.commit(store)
    return interactionResult(true, 'OK', message, data)
  }
  const attempt = (run: () => DevApiInteractionResult): DevApiInteractionResult => {
    try {
      return run()
    } catch (error) {
      return interactionResult(
        false,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : String(error),
        null
      )
    }
  }
  return {
    list: () => interactionResult(true, 'OK', 'Listed input profiles.', context.getStore().profiles),
    get: profileId => {
      const profile = findProfile(profileId)
      return profile == null
        ? missing(profileId)
        : interactionResult(true, 'OK', `Loaded input profile "${profileId}".`, profile)
    },
    effective: (profileId, packageRoot, aircraftId) => {
      const store = context.getStore()
      if (profileId != null && findProfile(profileId) == null) return missing(profileId)
      if ((packageRoot == null) !== (aircraftId == null)) {
        return interactionResult(
          false,
          'INVALID_ARGUMENT',
          'packageRoot and aircraftId must be supplied together.',
          { packageRoot: packageRoot ?? null, aircraftId: aircraftId ?? null }
        )
      }
      const scopedPackageRoot = packageRoot ?? context.packageRoot
      const scopedAircraftId = aircraftId ?? context.aircraftId
      if (scopedPackageRoot.trim() === '' || scopedAircraftId.trim() === '') {
        return interactionResult(false, 'INVALID_ARGUMENT', 'packageRoot and aircraftId are required.', null)
      }
      const effectiveProfileId = profileId
        ?? selectedCockpitInputProfileId(store, scopedPackageRoot, scopedAircraftId)
      return interactionResult(
        true,
        'OK',
        'Resolved effective input profile.',
        effectiveCockpitInputProfile(store, effectiveProfileId)
      )
    },
    create: name => {
      if (typeof name !== 'string' || name.trim() === '') return invalidName()
      return attempt(() => {
        const change = createCockpitInputProfile(context.getStore(), name)
        return apply(change.store, `Created input profile "${change.profile.name}".`, change.profile)
      })
    },
    duplicate: (profileId, name) => {
      if (findProfile(profileId) == null) return missing(profileId)
      if (name != null && (typeof name !== 'string' || name.trim() === '')) return invalidName()
      return attempt(() => {
        const change = duplicateCockpitInputProfile(context.getStore(), profileId, name)
        return apply(change.store, `Duplicated input profile "${profileId}".`, change.profile)
      })
    },
    rename: (profileId, name) => {
      if (findProfile(profileId) == null) return missing(profileId)
      if (profileId === DEFAULT_COCKPIT_INPUT_PROFILE_ID) return protectedProfile(profileId)
      if (typeof name !== 'string' || name.trim() === '') return invalidName()
      return attempt(() => {
        const store = renameCockpitInputProfile(context.getStore(), profileId, name)
        return apply(
          store,
          `Renamed input profile "${profileId}".`,
          store.profiles.find(profile => profile.id === profileId)!
        )
      })
    },
    delete: profileId => {
      if (findProfile(profileId) == null) return missing(profileId)
      if (profileId === DEFAULT_COCKPIT_INPUT_PROFILE_ID) return protectedProfile(profileId)
      return attempt(() => apply(
        deleteCockpitInputProfile(context.getStore(), profileId),
        `Deleted input profile "${profileId}".`,
        { profileId }
      ))
    },
    reset: profileId => {
      if (findProfile(profileId) == null) return missing(profileId)
      return attempt(() => {
        const store = resetCockpitInputProfile(context.getStore(), profileId)
        return apply(
          store,
          `Reset input profile "${profileId}".`,
          store.profiles.find(profile => profile.id === profileId)!
        )
      })
    },
    selectGlobal: profileId => {
      if (findProfile(profileId) == null) return missing(profileId)
      return attempt(() => apply(
        selectGlobalCockpitInputProfile(context.getStore(), profileId),
        `Selected global input profile "${profileId}".`,
        { profileId }
      ))
    },
    selectAircraft: (packageRoot, aircraftId, profileId) => {
      if (typeof packageRoot !== 'string' || packageRoot.trim() === '' || typeof aircraftId !== 'string' || aircraftId.trim() === '') {
        return interactionResult(false, 'INVALID_ARGUMENT', 'packageRoot and aircraftId are required.', null)
      }
      if (profileId != null && findProfile(profileId) == null) return missing(profileId)
      return attempt(() => apply(
        selectAircraftCockpitInputProfile(context.getStore(), packageRoot, aircraftId, profileId),
        profileId == null
          ? `Selected the global input profile for "${aircraftId}".`
          : `Selected input profile "${profileId}" for "${aircraftId}".`,
        { packageRoot, aircraftId, profileId }
      ))
    },
    export: () => interactionResult(
      true,
      'OK',
      'Exported input profiles.',
      structuredClone(context.getStore())
    ),
    import: value => {
      if (!isCockpitInputStoreV2(value)) {
        return interactionResult(false, 'INVALID_STORE', 'Input profile store is not a valid version 2 payload.', null)
      }
      return attempt(() => {
        const store = structuredClone(value)
        return apply(store, 'Imported input profiles.', store)
      })
    }
  }
}

const unprovenInteractionDiagnostic = (code: string, message: string): ImportDiagnostic => ({
  code,
  message,
  severity: 'warning'
})

const CONTROL_KIND_UNPROVEN = unprovenInteractionDiagnostic(
  'interaction_control_kind_unproven',
  'The compiler did not prove an authoritative control kind.'
)

function summarizeInteractionTarget(
  target: MsfsInteractionTarget,
  authoredCount: number,
  value: number | null,
  formattedValue: string | null,
  localization: MsfsLocalization,
  localizationAvailable = true
): Record<string, unknown> {
  const presentation = resolveMsfsInteractionPresentation({
    ...target.binding.metadata,
    routes: target.bindings.flatMap(binding => binding.metadata.routes)
  }, localization, { value, authoredValue: formattedValue })
  return {
    authoredId: target.binding.metadata.authoredId,
    qualifiedId: target.id,
    controlKind: 'unknown',
    operations: target.operations,
    channels: [...new Set(target.bindings.flatMap(binding =>
      binding.metadata.routes.map(route => route.channel).filter(channel => channel != null)
    ))],
    available: target.bindings.some(binding => !binding.metadata.disabled),
    title: presentation.title,
    value,
    formattedValue: presentation.value,
    unit: target.binding.metadata.value.unit,
    ambiguous: target.binding.metadata.authoredId == null || authoredCount > 1,
    diagnostics: [
      CONTROL_KIND_UNPROVEN,
      ...(localizationAvailable ? [] : [unprovenInteractionDiagnostic(
        'interaction_localization_catalog_unavailable',
        'The package localization catalog is not available to DevApi.'
      )])
    ]
  }
}

function describeInteractionTarget(
  target: MsfsInteractionTarget,
  options: {
    readonly packageId: string
    readonly packageVersion: string | null
    readonly currentValue: number | null
    readonly formattedValue: string | null
    readonly localization: MsfsLocalization
    readonly localizationAvailable: boolean
    readonly blockers: readonly CompiledInteractionBlocker[]
    readonly diagnostics: readonly ImportDiagnostic[]
  }
): Record<string, unknown> {
  const sourcePaths = new Set(target.bindings.map(binding => binding.metadata.sourcePath))
  const diagnostics = [
    { ...CONTROL_KIND_UNPROVEN, scope: 'contract' },
    { ...unprovenInteractionDiagnostic(
      'interaction_declaration_occurrence_unproven',
      'The compiler did not preserve a declaration occurrence.'
    ), scope: 'contract' },
    { ...unprovenInteractionDiagnostic(
      'interaction_typed_parameters_unproven',
      'The compiler did not preserve an authoritative typed parameter schema.'
    ), scope: 'contract' },
    { ...unprovenInteractionDiagnostic(
      'interaction_variants_unproven',
      'The compiler did not preserve authored semantic variant identifiers.'
    ), scope: 'contract' },
    ...(options.localizationAvailable ? [] : [{
      ...unprovenInteractionDiagnostic(
        'interaction_localization_catalog_unavailable',
        'The package localization catalog is not available to DevApi.'
      ),
      scope: 'contract'
    }]),
    ...options.diagnostics.filter(diagnostic =>
      diagnostic.sourcePath != null && sourcePaths.has(diagnostic.sourcePath)
    ).map(diagnostic => ({ ...diagnostic, scope: 'source' }))
  ]
  return {
    packageId: options.packageId,
    packageVersion: options.packageVersion,
    ...target.binding.metadata,
    dragMode: target.bindings.some(binding => binding.metadata.dragMode === 'trajectory')
      ? 'trajectory'
      : 'default',
    dragAnimationSynced: target.bindings.every(binding => binding.metadata.dragAnimationSynced),
    bindingVariants: target.bindings.map(binding => ({
      sourceKind: binding.metadata.sourceKind,
      sourceTemplate: binding.metadata.sourceTemplate,
      dragMode: binding.metadata.dragMode,
      dragAnimationSynced: binding.metadata.dragAnimationSynced,
      dragNodeId: binding.metadata.dragNodeId,
      dragAnimationName: binding.metadata.dragAnimationName,
      routes: binding.metadata.routes
    })),
    expression: target.binding.expression,
    releaseExpression: target.binding.releaseExpression,
    authoredId: target.binding.metadata.authoredId,
    qualifiedId: target.id,
    controlKind: 'unknown',
    operations: target.operations,
    currentValue: options.currentValue,
    valueMetadata: target.binding.metadata.value,
    provenance: target.bindings.map(binding => ({
      sourceKind: binding.metadata.sourceKind,
      sourcePath: binding.metadata.sourcePath,
      sourceTemplate: binding.metadata.sourceTemplate,
      templateRevision: binding.metadata.templateRevision
    })),
    declarationOccurrence: null,
    typedParameters: [],
    variants: [],
    covers: [...new Set(target.bindings.flatMap(binding => binding.metadata.covers ?? []))],
    blockers: options.blockers.filter(blocker => blocker.target === target.binding.target),
    diagnostics,
    localizationCatalogAvailable: options.localizationAvailable,
    localization: resolveMsfsInteractionPresentation(
      {
        ...target.binding.metadata,
        routes: target.bindings.flatMap(binding => binding.metadata.routes)
      },
      options.localization,
      { value: options.currentValue, authoredValue: options.formattedValue }
    ),
    timing: target.bindings.map(binding => ({
      sourcePath: binding.metadata.sourcePath,
      minHeldDurationSeconds: binding.minHeldDurationSeconds,
      animationDurationSeconds: binding.animationDurationSeconds,
      repeatFrequencyHz: binding.repeatFrequencyHz,
      settleTimeSeconds: binding.metadata.value.settleTimeSeconds
    })),
    routes: target.bindings.flatMap(binding => binding.metadata.routes)
  }
}

function rejectUnauthoredVariant(
  targetName: string,
  variant: string | undefined
): DevApiInteractionResult | null {
  if (variant == null) return null
  if (variant.trim() === '') {
    return interactionResult(false, 'INVALID_ARGUMENT', 'variant must not be empty.', {
      target: targetName,
      requestedVariant: variant,
      variants: []
    })
  }
  return interactionResult(
    false,
    'VARIANT_NOT_AUTHORED',
    `No authored semantic variant identifiers are available for "${targetName}".`,
    { target: targetName, requestedVariant: variant, variants: [] }
  )
}

type CanonicalDispatchDependencies = {
  readonly resolve: (targetName: string) => InteractionResolution
  readonly busyTargetIds: () => ReadonlySet<string>
  readonly route: (target: MsfsInteractionTarget, action: CanonicalCockpitAction) => CompiledInteractionRoute | null
  readonly dispatch: (
    target: MsfsInteractionTarget,
    action: CanonicalCockpitAction
  ) => 'executed' | 'unsupported' | 'busy'
  readonly onExecuted?: (
    target: MsfsInteractionTarget,
    action: CanonicalCockpitAction,
    route: CompiledInteractionRoute
  ) => void
}

function startCanonicalInteractionDispatch(
  targetName: string,
  action: CanonicalCockpitAction,
  dependencies: CanonicalDispatchDependencies
): Promise<DevApiInteractionResult> {
  if (action == null || typeof action !== 'object'
    || typeof action.source !== 'string'
    || typeof action.operation !== 'string'
    || typeof action.phase !== 'string'
    || !Number.isFinite(action.timestampMs)) {
    return Promise.resolve(interactionResult(false, 'INVALID_ACTION', 'A canonical action is required.', null))
  }
  try {
    const request = resolveInteractionRequest(
      targetName,
      dependencies.resolve(targetName),
      dependencies.busyTargetIds(),
      action.operation !== 'release'
    )
    if (!request.ok) return Promise.resolve(request.result)
    const route = dependencies.route(request.target, action)
    if (route == null) {
      return Promise.resolve(interactionResult(
        false,
        'OPERATION_UNSUPPORTED',
        `${action.operation} is not authored for ${targetName}.`,
        { target: request.target.id, action }
      ))
    }
    const dispatched = dependencies.dispatch(request.target, action)
    if (dispatched !== 'executed') {
      return Promise.resolve(interactionResult(
        false,
        dispatched === 'busy' ? 'TARGET_BUSY' : 'INTERACTION_UNAVAILABLE',
        dispatched === 'busy' ? `${targetName} is busy.` : `${action.operation} could not execute.`,
        { target: request.target.id, action }
      ))
    }
    dependencies.onExecuted?.(request.target, action, route)
    return Promise.resolve(interactionResult(
      true,
      'OK',
      `Dispatched ${action.operation} on ${targetName}.`,
      { target: request.target.id, action, route }
    ))
  } catch (error) {
    return Promise.resolve(interactionResult(
      false,
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
      { target: targetName, action }
    ))
  }
}

type ActiveDevApiInteraction = {
  readonly target: MsfsInteractionTarget
  readonly operation: CockpitInteractionOperation
  readonly source: CanonicalCockpitAction['source']
  readonly lifecycle: 'running' | 'held'
  readonly startedAtMs: number
  readonly stopStatus: 'active'
}

function resolveInteractionWithHeldFallback(
  targetName: string,
  operation: CockpitInteractionOperation,
  resolution: InteractionResolution,
  active: ReadonlyMap<string, ActiveDevApiInteraction>
): InteractionResolution {
  if (resolution.ok || operation !== 'release') return resolution
  const held = [...active.values()].filter(state =>
    state.lifecycle === 'held' &&
    (state.target.id === targetName || state.target.binding.metadata.authoredId === targetName)
  )
  return held.length === 1 ? { ok: true, target: held[0]!.target } : resolution
}

function listActiveInteractionStates(
  active: ReadonlyMap<string, ActiveDevApiInteraction>,
  adapterTargetIds: readonly string[],
  dispatcherTargetIds: readonly string[]
): readonly Record<string, unknown>[] {
  const rows: Array<Record<string, unknown>> = [...active.values()].map(state => ({
    target: state.target.id,
    operation: state.operation,
    source: state.source,
    lifecycle: state.lifecycle,
    startedAtMs: state.startedAtMs,
    stopStatus: state.stopStatus
  }))
  const known = new Set(rows.map(row => row.target))
  for (const target of adapterTargetIds) {
    if (known.has(target)) continue
    known.add(target)
    rows.push({ target, operation: 'unknown', source: 'unknown', lifecycle: 'adapter-active', startedAtMs: null, stopStatus: 'active' })
  }
  for (const target of dispatcherTargetIds) {
    if (known.has(target)) continue
    known.add(target)
    rows.push({ target, operation: 'unknown', source: 'unknown', lifecycle: 'dispatcher-active', startedAtMs: null, stopStatus: 'active' })
  }
  return rows
}

export const __devApiInteractionTestHooks = {
  resolveInteractionRequest,
  createCockpitInputProfilesApi,
  summarizeInteractionTarget,
  describeInteractionTarget,
  rejectUnauthoredVariant,
  startCanonicalInteractionDispatch,
  resolveInteractionWithHeldFallback,
  listActiveInteractionStates
}

type DevApiStateValue = number | string | boolean
type DevApiCommandPayload = SimCommand['payload']

const DEV_API_STATE_UNITS = new Set<SimUnit>([
  'unitless',
  'number',
  'ratio',
  'percent',
  'boolean',
  'seconds',
  'meters',
  'feet',
  'metersPerSecond',
  'knots',
  'celsius',
  'kelvin',
])

function parseDevApiStateUnit(unit: string | null | undefined): SimUnit | undefined {
  if (unit == null || unit.trim() === '') {
    return undefined
  }

  const normalized = unit.trim()
  return DEV_API_STATE_UNITS.has(normalized as SimUnit) ? (normalized as SimUnit) : undefined
}

type DevApiWasmModuleImport = {
  readonly module: string
  readonly name: string
  readonly kind: string
}

type DevApiWasmModuleExport = {
  readonly name: string
  readonly kind: string
}

type DevApiWasmModuleInfo = {
  readonly url: string
  readonly status: 'resolved-url-only' | 'compiled' | 'fetch-error' | 'too-large' | 'inspect-error'
  readonly byteLength: number
  readonly imports: readonly DevApiWasmModuleImport[]
  readonly exports: readonly DevApiWasmModuleExport[]
  readonly error: string | null
  readonly inspectedAt: string | null
}

type DevApiListKind =
  | 'nodes'
  | 'nodeAnimations'
  | 'components'
  | 'interactions'
  | 'gauges'
  | 'animations'
  | 'animationTriggers'
  | 'canonicalVisuals'
  | 'materials'
  | 'inputEvents'
  | 'variables'
  | 'state'
  | 'commands'
  | 'diagnostics'
  | 'events'
  | 'settings'
  | 'camera'

type DevApiDiagnosticsOptions = {
  readonly severity?: string
  readonly filter?: string
  readonly limit?: number
  readonly includeGauges?: boolean
}

type DevApiBenchOptions = {
  readonly includeEvents?: boolean
}

type StoredBenchRun = {
  readonly id: string
  readonly kind: string
  readonly createdAt: string
  readonly localDate: string
  readonly localTime: string
  readonly commit: unknown
  readonly ok: boolean
  readonly summary: string
  readonly data: unknown
}

type DevApiEventWaitKind = 'key' | 'html' | 'sound' | 'effect' | 'bridge'

type DevApiWaitCondition =
  | string
  | {
      readonly kind?: string
      readonly target?: string
      readonly var?: string
      readonly unit?: string | null
      readonly equals?: number
      readonly above?: number
      readonly below?: number
      readonly minimum?: number
      readonly captured?: boolean
      readonly eventKind?: DevApiEventWaitKind
      readonly name?: string
      readonly phase?: string
      readonly action?: string
      readonly direction?: string
      readonly handledByBinding?: boolean
      readonly sequenceAbove?: number
      readonly from?: number
      readonly epsilon?: number
    }

type DevApiWaitEvaluationState = {
  varChangedBaseline?: number
  interactionExecutionBaseline?: number
}

type DevApiRuntimeEvent =
  | RuntimeKeyEvent
  | RuntimeHtmlEvent
  | RuntimeSoundEvent
  | RuntimeEffectEvent
  | RuntimeBridgeEvent

type DevApiList = {
  (options: {
    readonly kind: 'gauges'
    readonly filter?: string
    readonly limit?: number
  }): DevApiResponse<readonly DevApiGaugeSummary[]>
  (options?: {
    readonly kind?: DevApiListKind
    readonly filter?: string
    readonly limit?: number
  }): DevApiResponse
}

type ViewerDevApi = {
  readonly ready: () => Promise<DevApiResponse>
  readonly status: () => DevApiResponse<DevApiStatusData>
  readonly help: () => DevApiResponse
  readonly schema: () => DevApiResponse
  readonly report: () => DevApiResponse
  readonly reset: (options?: { readonly runtime?: boolean; readonly coldAndDark?: boolean }) => DevApiResponse
  readonly find: (query: string, options?: { readonly limit?: number }) => DevApiResponse
  readonly list: DevApiList
  readonly interactions: DevApiInteractions
  readonly checkComponent: (target: string) => DevApiResponse
  readonly checkMaterial: (target: string, options?: { readonly descendants?: boolean }) => DevApiResponse
  readonly checkGauge: (
    key?: string,
    options?: { readonly screenshot?: boolean; readonly surface?: string; readonly source?: string }
  ) => DevApiResponse<DevApiGaugeCheckData, DevApiGaugeCheckFailure>
  readonly inspectWasm: (
    key?: string,
    options?: { readonly maxBytes?: number; readonly surface?: string; readonly source?: string }
  ) => Promise<DevApiResponse>
  readonly checkParam: (names: string | readonly string[]) => DevApiResponse
  readonly setParam: (name: string, value: number, unit?: string | null) => DevApiResponse
  readonly diagnostics: (options?: DevApiDiagnosticsOptions) => DevApiResponse
  readonly readVar: (name: string, unit?: string | null) => DevApiResponse
  readonly writeVar: (name: string, value: number, unit?: string | null) => DevApiResponse
  readonly readState: (key: string) => DevApiResponse
  readonly writeState: (key: string, value: DevApiStateValue, unit?: string | null) => DevApiResponse
  readonly dispatchCommand: (type: string, payload?: DevApiCommandPayload) => DevApiResponse
  readonly keyEvent: (name: string, args?: readonly number[]) => DevApiResponse
  readonly bridgeCall: (name: string, args?: readonly number[]) => DevApiResponse
  readonly events: (options?: { readonly kind?: 'key' | 'html' | 'sound' | 'effect' | 'bridge' | 'interaction'; readonly limit?: number }) => DevApiResponse
  readonly watch: (
    targets: string | readonly string[],
    options?: { readonly durationMs?: number; readonly intervalMs?: number; readonly unit?: string | null }
  ) => Promise<DevApiResponse>
  readonly waitFor: (condition: DevApiWaitCondition, timeoutMs?: number) => Promise<DevApiResponse>
  readonly perf: () => DevApiResponse
  readonly assetCache: {
    readonly snapshot: () => DevApiResponse
    readonly refreshPackageVersions: () => Promise<DevApiResponse>
    readonly clearDdsRanges: () => Promise<DevApiResponse>
  }
  readonly bench: {
    readonly startup: () => DevApiResponse
    readonly cockpitLod0: (options?: DevApiBenchOptions) => Promise<DevApiResponse>
    readonly all: (options?: DevApiBenchOptions) => Promise<DevApiResponse>
    readonly history: (options?: { readonly limit?: number }) => DevApiResponse
    readonly clearHistory: () => DevApiResponse
  }
  readonly screenshot: (options?: { readonly target?: 'viewport' | 'gauge'; readonly key?: string }) => DevApiResponse
  readonly visualCheck: (target?: string) => DevApiResponse
  readonly highlight: (target: string, options?: { readonly durationMs?: number }) => DevApiResponse
  readonly camera: {
    readonly enterCockpit: () => Promise<DevApiResponse>
    readonly exitCockpit: () => DevApiResponse
    readonly getPose: () => DevApiResponse
    readonly setPose: (pose: {
      readonly position?: readonly number[]
      readonly target?: readonly number[]
    }) => DevApiResponse
    readonly frame: (target: string) => DevApiResponse
  }
  readonly settings: {
    readonly get: () => DevApiResponse
    readonly set: (settings: Partial<ViewerConfigProfile>) => Promise<DevApiResponse>
  }
}

type ViewerDevApiContext = {
  readonly packageRoot: string
  readonly packageData: {
    readonly packageName: string
    readonly manifest?: { readonly packageVersion?: string } | null
    readonly diagnostics: readonly ImportDiagnostic[]
  }
  readonly aircraft: ImportedAircraft
  readonly scene: Scene
  readonly renderer: RendererInfo['renderer']
  readonly camera: PerspectiveCamera
  readonly controls: OrbitControls
  readonly rendererInfo: RendererInfo
  readonly getEffectiveSearchParams: () => URLSearchParams
  readonly getCompiledBehaviors: () => CompiledBehaviorSet
  readonly getLoadedModel: () => LoadedAircraftModel
  readonly getRuntime: () => AircraftRuntime
  readonly getRuntimeHost: () => SharedMsfsRuntimeHost
  readonly getRuntimeState: () => RuntimeState
  readonly getFpsSnapshot: () => FpsCounterSnapshot
  readonly getSettingsSnapshot: () => Record<string, unknown>
  readonly getCockpitPerfDiagnostics: () => CockpitPerfDiagnostics
  readonly cockpitInteractionStats: Record<string, unknown>
  readonly cockpitInteractionHistory: CockpitInteractionHistory
  readonly cockpitInteractionTrace: CockpitInteractionTrace
  readonly getCockpitInteractionPickRegistry: () => CockpitInteractionPickRegistry
  readonly getCockpitInteractionAdapter: () => MsfsInteractionAdapter
  readonly getCockpitInteractionLifecycle: () => MsfsInteractionLifecycle
  readonly getCockpitInteractionDispatcher: () => CockpitInteractionDispatcher<MsfsInteractionTarget>
  readonly getCockpitLocalization: () => MsfsLocalization
  readonly getCockpitCameraController: () => CockpitCameraController
  readonly getCockpitBenchmarkState: () => Record<string, unknown>
  readonly runCockpitBenchmark: (options?: {
    readonly targetInteriorLodIndex?: number
    readonly forceCold?: boolean
  }) => Promise<unknown>
  readonly applySettings: (settings: Partial<ViewerConfigProfile>) => Promise<string | null>
}

export const VIEWER_INTERACTION_STOP_EVENT = 'flight-sim:interaction-stop'

export interface ViewerInteractionStopDetail {
  readonly reason: string
  readonly targets: readonly string[]
}

function getLoadStageHistory(): readonly Record<string, unknown>[] {
  const value = (globalThis as Record<string, unknown>).__msfsLoadStageHistory
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => (
      entry != null && typeof entry === 'object'
    ))
    : []
}

function getStartupBenchmarkData(): Record<string, unknown> {
  const loadStageHistory = getLoadStageHistory()
  const sceneReadyIndex = loadStageHistory.findIndex(entry => entry.stage === 'scene:ready')
  const history = sceneReadyIndex >= 0
    ? loadStageHistory.slice(0, sceneReadyIndex + 1)
    : loadStageHistory
  const first = history[0] ?? null
  const latest = history.at(-1) ?? null
  const currentLoadStage = loadStageHistory.at(-1) ?? null
  const firstNowMs = typeof first?.nowMs === 'number' ? first.nowMs : null
  const latestNowMs = typeof latest?.nowMs === 'number' ? latest.nowMs : null
  const previousByStage = new Map<string, Record<string, unknown>>()
  const firstByStage = new Map<string, Record<string, unknown>>()
  const lastByStage = new Map<string, Record<string, unknown>>()
  const stages = history.map((entry, index) => {
    const stage = typeof entry.stage === 'string' ? entry.stage : null
    const nowMs = typeof entry.nowMs === 'number' ? entry.nowMs : null
    const previous = stage != null ? previousByStage.get(stage) ?? null : null
    if (stage != null) {
      if (!firstByStage.has(stage)) {
        firstByStage.set(stage, entry)
      }
      previousByStage.set(stage, entry)
      lastByStage.set(stage, entry)
    }
    const previousNowMs = typeof previous?.nowMs === 'number' ? previous.nowMs : null

    return {
      index,
      stage,
      aircraftId: typeof entry.aircraftId === 'string' ? entry.aircraftId : null,
      packageRoot: typeof entry.packageRoot === 'string' ? entry.packageRoot : null,
      timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : null,
      elapsedFromFirstMs:
        firstNowMs != null && nowMs != null ? Number((nowMs - firstNowMs).toFixed(1)) : null,
      elapsedSincePreviousSameStageMs:
        previousNowMs != null && nowMs != null ? Number((nowMs - previousNowMs).toFixed(1)) : null
    }
  })
  const elapsedFromFirst = (entry: Record<string, unknown> | null): number | null => {
    const nowMs = typeof entry?.nowMs === 'number' ? entry.nowMs : null
    return firstNowMs != null && nowMs != null ? Number((nowMs - firstNowMs).toFixed(1)) : null
  }
  const elapsedBetween = (
    start: Record<string, unknown> | null,
    end: Record<string, unknown> | null
  ): number | null => {
    const startMs = typeof start?.nowMs === 'number' ? start.nowMs : null
    const endMs = typeof end?.nowMs === 'number' ? end.nowMs : null
    return startMs != null && endMs != null ? Number((endMs - startMs).toFixed(1)) : null
  }
  const firstStage = (stage: string): Record<string, unknown> | null => firstByStage.get(stage) ?? null
  const lastStage = (stage: string): Record<string, unknown> | null => lastByStage.get(stage) ?? null
  const milestoneNames = [
    'init:start',
    'import:package',
    'compile:behaviors',
    'renderer:create',
    'gltf:load',
    'gltf:lod:fetch',
    'gltf:lod:json:loaded',
    'gltf:lod:parse:start',
    'gltf:lod:parse:done',
    'gltf:lod:ready',
    'gltf:loaded',
    'scene:ready'
  ]
  const milestones = milestoneNames.flatMap(stage => {
    const entry = firstStage(stage)
    return entry == null
      ? []
      : [{
          stage,
          elapsedFromFirstMs: elapsedFromFirst(entry),
          timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : null
        }]
  })

  return {
    ready: typeof latest?.stage === 'string' && latest.stage !== 'init:error',
    totalElapsedMs:
      firstNowMs != null && latestNowMs != null ? Number((latestNowMs - firstNowMs).toFixed(1)) : null,
    currentElapsedMs:
      firstNowMs != null ? Number((performance.now() - firstNowMs).toFixed(1)) : null,
    currentStage: latest,
    currentLoadStage,
    stageCount: history.length,
    totalLoadStageCount: loadStageHistory.length,
    milestones,
    phases: {
      importPackageMs: elapsedBetween(firstStage('init:start'), firstStage('import:package')),
      behaviorCompileToRendererCreateMs: elapsedBetween(
        firstStage('compile:behaviors'),
        firstStage('renderer:create')
      ),
      rendererCreateToGltfLoadMs: elapsedBetween(
        firstStage('renderer:create'),
        firstStage('gltf:load')
      ),
      gltfLoadToLoadedMs: elapsedBetween(firstStage('gltf:load'), firstStage('gltf:loaded')),
      gltfLoadToSceneReadyMs: elapsedBetween(firstStage('gltf:load'), firstStage('scene:ready')),
      gltfParseMs: elapsedBetween(firstStage('gltf:lod:parse:start'), firstStage('gltf:lod:parse:done')),
      gltfNormalizeAndReadyMs: elapsedBetween(
        firstStage('gltf:lod:parse:done'),
        lastStage('gltf:lod:ready')
      ),
      sceneFinalizeMs: elapsedBetween(firstStage('gltf:loaded'), firstStage('scene:ready'))
    },
    stages
  }
}

function stripCockpitBenchmarkEvents(result: unknown): unknown {
  if (result == null || typeof result !== 'object') {
    return result
  }
  const { events: _events, ...rest } = result as Record<string, unknown>
  return rest
}

const DEV_API_BENCH_HISTORY_KEY = 'msfs.devapi.bench.history.v1'
const DEV_API_BENCH_HISTORY_LIMIT = 50

function readBenchHistory(): readonly StoredBenchRun[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DEV_API_BENCH_HISTORY_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is StoredBenchRun => (
          entry != null &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).id === 'string'
        ))
      : []
  } catch {
    return []
  }
}

function writeBenchHistory(history: readonly StoredBenchRun[]): void {
  window.localStorage.setItem(
    DEV_API_BENCH_HISTORY_KEY,
    JSON.stringify(history.slice(-DEV_API_BENCH_HISTORY_LIMIT))
  )
}

function clearBenchHistory(): void {
  window.localStorage.removeItem(DEV_API_BENCH_HISTORY_KEY)
}

function createLocalBenchTimestamp(now: Date): {
  readonly localDate: string
  readonly localTime: string
} {
  return {
    localDate: now.toLocaleDateString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }),
    localTime: now.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
  }
}

async function getDevApiGitMetadata(): Promise<unknown> {
  try {
    const response = await fetch('/__devapi/git.json', { cache: 'no-store' })
    if (!response.ok) {
      return {
        available: false,
        error: `HTTP ${response.status}`
      }
    }
    return await response.json()
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function storeBenchRun(run: StoredBenchRun): StoredBenchRun {
  const history = [...readBenchHistory(), run].slice(-DEV_API_BENCH_HISTORY_LIMIT)
  writeBenchHistory(history)
  return run
}

function getDevApiAssetCacheSnapshot(): Record<string, unknown> {
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const packageResources = resources.filter(entry => {
    try {
      const url = new URL(entry.name)
      return url.searchParams.has('assetVersion') ||
        url.pathname.startsWith('/aircrafts/') ||
        url.pathname.startsWith('/vendor/msfs-stock/')
    } catch {
      return false
    }
  })
  const xmlResources = packageResources.filter(entry => {
    try {
      return new URL(entry.name).pathname.toLowerCase().endsWith('.xml')
    } catch {
      return false
    }
  })
  const summarize = (entries: readonly PerformanceResourceTiming[]) => ({
    count: entries.length,
    transferBytes: entries.reduce((total, entry) => total + entry.transferSize, 0),
    encodedBytes: entries.reduce((total, entry) => total + entry.encodedBodySize, 0),
    durationMs: entries.reduce((total, entry) => total + entry.duration, 0)
  })

  return {
    packageSources: getMsfsPackageSourceCacheSnapshot(),
    behaviorXml: getMsfsBehaviorAssetSnapshot(),
    ddsRanges: getAircraftAssetCacheSnapshot(),
    resources: {
      packageAssets: summarize(packageResources),
      xml: summarize(xmlResources)
    }
  }
}

async function refreshDevApiPackageVersions(): Promise<{
  readonly changedRoots: readonly string[]
  readonly snapshot: Record<string, unknown>
}> {
  const before = new Map(
    getMsfsPackageSourceCacheSnapshot().packages.map(source => [source.rootUrl, source.revision])
  )
  const refreshed = await refreshMsfsPackageSourceVersions()
  const changedRoots = refreshed
    .filter(source => source.revision == null || before.get(source.rootUrl) !== source.revision)
    .map(source => source.rootUrl)

  if (changedRoots.length > 0) {
    clearMsfsBehaviorDocumentCache()
    await clearAircraftRangeCache()
  }

  return {
    changedRoots,
    snapshot: getDevApiAssetCacheSnapshot()
  }
}

export function installViewerBootDevApi(): void {
  const installedAt = performance.now()
  const ok = <T>(summary: string, data: T, warnings?: readonly string[]): DevApiResponse<T, never> => ({
    ok: true,
    summary,
    data,
    ...(warnings != null && warnings.length > 0 ? { warnings } : {})
  })
  const fail = <T>(summary: string, data: T, warnings?: readonly string[]): DevApiResponse<never, T> => ({
    ok: false,
    summary,
    data,
    ...(warnings != null && warnings.length > 0 ? { warnings } : {})
  })
  const sleep = (delayMs: number): Promise<void> =>
    new Promise(resolve => window.setTimeout(resolve, Math.max(0, delayMs)))
  const getLoadStage = getDevApiLoadStage
  const getGltfLoadingManagerStats = (): Record<string, unknown> | null => {
    const value = (globalThis as Record<string, unknown>).__msfsGltfLoadingManagerStats
    return typeof value === 'object' && value != null ? value as Record<string, unknown> : null
  }
  const loadingData = (): DevApiStatusData => ({
    ready: false,
    loadStage: getLoadStage(),
    gltfLoadingManager: getGltfLoadingManagerStats(),
    elapsedMs: performance.now() - installedAt,
    location: window.location.href
  })
  const unavailable = (method: string): DevApiResponse =>
    fail('Viewer is still loading; full DevApi is not ready yet.', {
      ...loadingData(),
      method
    }, [
      'Use __DevApi.status() or __DevApi.diagnostics() to inspect boot progress, then retry after __DevApi.ready().'
    ])

  let consoleApi: ViewerDevApi
  const bootApi: Partial<ViewerDevApi> = {
    ready: async () => {
      while (window.__DevApi === consoleApi) {
        await sleep(250)
      }
      return window.__DevApi?.ready?.() ?? unavailable('ready')
    },
    status: () => ok('Viewer is still loading.', loadingData()),
    help: () => ok('Boot DevApi is available while the full viewer loads.', {
      methods: [
        '__DevApi.status()',
        '__DevApi.diagnostics()',
        '__DevApi.assetCache.snapshot()',
        '__DevApi.bench.startup()',
        'await __DevApi.bench.all()',
        '__DevApi.bench.history()',
        'await __DevApi.ready()'
      ],
      note: 'Interaction, camera, gauge, and runtime helpers become available after model loading completes.'
    }),
    schema: () => ok('Returned boot DevApi schema summary.', {
      ready: false,
      methods: ['ready', 'status', 'help', 'schema', 'diagnostics', 'report', 'inspectWasm', 'assetCache.snapshot', 'assetCache.refreshPackageVersions', 'assetCache.clearDdsRanges', 'bench.startup', 'bench.all', 'bench.history']
    }),
    diagnostics: () => ok('Returned boot diagnostics.', {
      ...loadingData(),
      diagnostics: []
    }),
    report: () => ok('Returned boot report.', {
      ...loadingData(),
      diagnostics: [],
      performance: {
        fps: null
      }
    }),
    assetCache: {
      snapshot: () => ok('Collected package asset cache diagnostics.', getDevApiAssetCacheSnapshot()),
      refreshPackageVersions: async () => ok(
        'Refreshed package asset versions.',
        await refreshDevApiPackageVersions()
      ),
      clearDdsRanges: async () => {
        await clearAircraftRangeCache()
        return ok('Cleared cached DDS byte ranges.', getDevApiAssetCacheSnapshot())
      }
    },
    bench: {
      startup: () => ok('Collected startup benchmark.', getStartupBenchmarkData()),
      cockpitLod0: async () => unavailable('bench.cockpitLod0'),
      all: async () => unavailable('bench.all'),
      history: (options = {}) => {
        const limit = Math.max(1, Math.min(DEV_API_BENCH_HISTORY_LIMIT, Math.floor(options.limit ?? DEV_API_BENCH_HISTORY_LIMIT)))
        return ok('Collected stored benchmark history.', {
          storageKey: DEV_API_BENCH_HISTORY_KEY,
          entries: readBenchHistory().slice(-limit)
        })
      },
      clearHistory: () => {
        clearBenchHistory()
        return ok('Cleared stored benchmark history.', {
          storageKey: DEV_API_BENCH_HISTORY_KEY
        })
      }
    },
    camera: {
      enterCockpit: async () => unavailable('camera.enterCockpit'),
      exitCockpit: () => unavailable('camera.exitCockpit'),
      getPose: () => unavailable('camera.getPose'),
      setPose: () => unavailable('camera.setPose'),
      frame: () => unavailable('camera.frame')
    },
    settings: {
      get: () => unavailable('settings.get'),
      set: async () => unavailable('settings.set')
    },
    inspectWasm: async () => unavailable('inspectWasm')
  }
  const proxy = new Proxy(bootApi, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver)
      }
      if (typeof property === 'string') {
        return () => unavailable(property)
      }
      return undefined
    }
  }) as ViewerDevApi

  consoleApi = wrapDevApiForConsole(proxy, error =>
    fail('Boot DevApi call failed.', {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null
    })
  )
  window.__DevApi = consoleApi
  ;(globalThis as Record<string, unknown>).__DevApi = consoleApi
}

export function installViewerDevApi(context: ViewerDevApiContext): void {
  let highlightGroup: Group | null = null
  const ok = <T>(summary: string, data: T, warnings?: readonly string[]): DevApiResponse<T, never> => ({
    ok: true,
    summary,
    data,
    ...(warnings != null && warnings.length > 0 ? { warnings } : {})
  })
  const fail = <T>(summary: string, data: T, warnings?: readonly string[]): DevApiResponse<never, T> => ({
    ok: false,
    summary,
    data,
    ...(warnings != null && warnings.length > 0 ? { warnings } : {})
  })
  const sleep = (delayMs: number): Promise<void> =>
    new Promise(resolve => window.setTimeout(resolve, Math.max(0, delayMs)))
  const inspectedWasmModules = new Map<string, DevApiWasmModuleInfo>()
  const getWasmModuleInfo = (url: string): DevApiWasmModuleInfo =>
    inspectedWasmModules.get(url) ?? {
      url,
      status: 'resolved-url-only',
      byteLength: 0,
      imports: [],
      exports: [],
      error: null,
      inspectedAt: null
    }
  const storeWasmModuleInfo = (info: DevApiWasmModuleInfo): DevApiWasmModuleInfo => {
    inspectedWasmModules.set(info.url, info)
    return info
  }
  const getLoadStage = getDevApiLoadStage
  const getDiagnostics = (): readonly ImportDiagnostic[] => dedupeDiagnostics([
    ...context.packageData.diagnostics,
    ...context.getCompiledBehaviors().diagnostics,
    ...context.getRuntimeState().diagnostics,
    ...(context.getLoadedModel().interior?.vcockpitBinding?.diagnostics ?? [])
  ])
  const diagnosticCounts = (): Record<string, number> => {
    const counts = { error: 0, warning: 0, info: 0, other: 0 }
    for (const diagnostic of getDiagnostics()) {
      if (diagnostic.severity === 'error') counts.error += 1
      else if (diagnostic.severity === 'warning') counts.warning += 1
      else if (diagnostic.severity === 'info') counts.info += 1
      else counts.other += 1
    }
    return counts
  }
  const matchesDiagnosticFilter = (diagnostic: ImportDiagnostic, filter: string): boolean =>
    !filter || `${diagnostic.severity} ${diagnostic.code} ${diagnostic.message} ${diagnostic.sourcePath ?? ''}`.toLowerCase().includes(filter)
  const collectGaugeDiagnostics = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const rows: Record<string, unknown>[] = []
    for (const gauge of gauges()) {
      if (rows.length >= limit) break
      const summary = summarizeGauge(gauge)
      const scriptErrors = Array.isArray(summary.scriptErrors) ? summary.scriptErrors : []
      const assetErrors = Array.isArray(summary.assetErrors) ? summary.assetErrors : []
      const resourceErrors = Array.isArray(summary.resourceErrors) ? summary.resourceErrors : []
      const bridgeStats = typeof summary.bridgeStats === 'object' && summary.bridgeStats != null
        ? summary.bridgeStats as Record<string, unknown>
        : null
      const runtimeErrorCount = typeof bridgeStats?.runtimeErrorCount === 'number' ? bridgeStats.runtimeErrorCount : 0
      const unsupportedCalls = Array.isArray(bridgeStats?.unsupportedCalls) ? bridgeStats.unsupportedCalls : []
      if (
        scriptErrors.length === 0 &&
        assetErrors.length === 0 &&
        resourceErrors.length === 0 &&
        runtimeErrorCount === 0 &&
        unsupportedCalls.length === 0
      ) {
        continue
      }
      const haystack = `${gauge.gaugeKey} ${gauge.surface} ${gauge.source} ${JSON.stringify({
        scriptErrors,
        assetErrors,
        resourceErrors,
        runtimeErrorCount,
        unsupportedCalls
      })}`.toLowerCase()
      if (filter && !haystack.includes(filter)) continue
      rows.push({
        key: gauge.gaugeKey,
        surface: gauge.surface,
        source: gauge.source,
        status: gauge.status,
        scriptErrors,
        assetErrors,
        resourceErrors,
        bridge: {
          runtimeErrorCount,
          unsupportedCalls,
          wasmBridge: bridgeStats?.wasmBridge ?? null,
          status: bridgeStats?.status ?? null
        }
      })
    }
    return rows
  }
  const collectDiagnosticsReport = (options: DevApiDiagnosticsOptions = {}): Record<string, unknown> => {
    const severity = options.severity?.trim()
    const filter = options.filter?.trim().toLowerCase() ?? ''
    const limit = Math.max(1, Math.min(5_000, Math.floor(options.limit ?? 500)))
    const diagnostics = getDiagnostics().filter(diagnostic =>
      (severity == null || severity === '' || diagnostic.severity === severity) &&
      matchesDiagnosticFilter(diagnostic, filter)
    )
    const gaugeDiagnostics = options.includeGauges === false ? [] : collectGaugeDiagnostics(filter, limit)
    return {
      counts: diagnosticCounts(),
      filters: {
        severity: severity == null || severity === '' ? null : severity,
        filter: filter || null,
        limit,
        includeGauges: options.includeGauges !== false
      },
      diagnostics: diagnostics.slice(0, limit),
      truncatedDiagnostics: Math.max(0, diagnostics.length - limit),
      gaugeDiagnostics,
      interactionMisses: interactionDispatcher.snapshot.misses,
      status: statusData()
    }
  }
  const gauges = (): readonly VCockpitHtmlGaugeRuntime[] =>
    context.getLoadedModel().interior?.vcockpitBinding?.htmlGaugeRuntimes ?? []
  const isCapturableGauge = (runtime: VCockpitHtmlGaugeRuntime): boolean =>
    runtime.captured ||
    runtime.captureImage != null ||
    runtime.staticCaptureImage != null ||
    runtime.textureName.toUpperCase() !== 'NO_TEXTURE'
  const summarizeGauge = (runtime: VCockpitHtmlGaugeRuntime): DevApiGaugeSummary => ({
    key: runtime.gaugeKey,
    surface: runtime.surface,
    textureName: runtime.textureName,
    source: runtime.source,
    resolvedUrl: runtime.resolvedUrl,
    status: runtime.status,
    captured: runtime.captured,
    needsCapture: runtime.needsCapture,
    lastRenderStatus: runtime.lastRenderStatus,
    lastRenderKind: runtime.lastRenderKind,
    lastCaptureError: runtime.lastCaptureError,
    captureAttemptCount: runtime.captureAttemptCount,
    capturable: isCapturableGauge(runtime),
    backendOnly: !isCapturableGauge(runtime),
    hasIframe: runtime.iframe != null,
    hasCaptureImage: runtime.captureImage != null || runtime.staticCaptureImage != null,
    ...summarizeGaugeFrame(runtime)
  })
  const summarizeGaugeFrame = (runtime: VCockpitHtmlGaugeRuntime): Record<string, unknown> => {
    const frameDocument = runtime.iframe?.contentDocument
    const frameWindow = runtime.iframe?.contentWindow as
      | (Window & {
          readonly __msfsGaugeDirtyStats?: unknown
          readonly __msfsInstrumentRuntimeStats?: unknown
          readonly __msfsGaugeBridgeStats?: unknown
          readonly __msfsGaugeErrors?: unknown
          readonly __msfsGaugeAssetErrors?: unknown
          readonly __msfsGaugeResourceErrors?: unknown
        })
      | null
      | undefined
    const bridgeStats = frameWindow?.__msfsGaugeBridgeStats ?? null
    const wasmModuleUrl = getWasmModuleUrl(runtime)
    return {
      domNodeCount: frameDocument?.getElementsByTagName('*').length ?? null,
      canvasCount: frameDocument?.querySelectorAll('canvas').length ?? null,
      svgCount: frameDocument?.querySelectorAll('svg').length ?? null,
      dirtyStats: frameWindow?.__msfsGaugeDirtyStats ?? null,
      instrumentStats: frameWindow?.__msfsInstrumentRuntimeStats ?? null,
      bridgeStats: wasmModuleUrl == null
        ? bridgeStats
        : {
            ...(typeof bridgeStats === 'object' ? bridgeStats : {}),
            wasmModuleInfo: getWasmModuleInfo(wasmModuleUrl)
          },
      scriptErrors: frameWindow?.__msfsGaugeErrors ?? null,
      assetErrors: frameWindow?.__msfsGaugeAssetErrors ?? null,
      resourceErrors: frameWindow?.__msfsGaugeResourceErrors ?? null
    }
  }
  const getWasmModuleUrl = (runtime: VCockpitHtmlGaugeRuntime): string | null => {
    if (runtime.status !== 'loaded-wasm-bridge') {
      return null
    }
    if (runtime.wasmModuleUrl != null) {
      return runtime.wasmModuleUrl
    }
    if (runtime.resolvedUrl == null) {
      return null
    }
    try {
      return new URL(runtime.resolvedUrl).searchParams.get('wasmModuleUrl')
    } catch {
      return null
    }
  }
  const canvasDataUrl = (canvas: HTMLCanvasElement): string | null => {
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }
  const findObject = (query: string): Object3D | null => {
    const needle = query.trim().toLowerCase()
    if (!needle) return null
    let found: Object3D | null = null
    context.getLoadedModel().scene.traverse(object => {
      if (found != null) return
      if (object.name.toLowerCase() === needle) found = object
    })
    context.getLoadedModel().scene.traverse(object => {
      if (found != null) return
      if ((object.name || object.type).toLowerCase().includes(needle)) found = object
    })
    return found
  }
  const collectNodes = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const rows: Record<string, unknown>[] = []
    context.getLoadedModel().scene.traverse(object => {
      if (rows.length >= limit) return
      const label = object.name || object.type
      if (needle && !label.toLowerCase().includes(needle)) return
      rows.push({
        name: object.name || null,
        type: object.type,
        visible: object.visible,
        childCount: object.children.length,
        parent: object.parent?.name || object.parent?.type || null,
        position: object.position.toArray()
      })
    })
    return rows
  }
  const collectNodeAnimations = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const rows: Record<string, unknown>[] = []
    const sceneNodes = collectNodes('', 5_000)
    const sceneNodeNames = new Set<string>()
    const canonicalSceneNodeNames = new Set<string>()
    for (const row of sceneNodes) {
      if (typeof row.name !== 'string') continue
      sceneNodeNames.add(row.name.toLowerCase())
      const canonicalName = canonicalizeDevApiNodeAnimationName(row.name)
      if (canonicalName != null) canonicalSceneNodeNames.add(canonicalName)
    }
    for (const animation of context.aircraft.model?.nodeAnimations ?? []) {
      if (rows.length >= limit) break
      const label = animation.type || 'NodeAnimation'
      const nodes = animation.nodes.map(node => {
        const canonicalName = canonicalizeDevApiNodeAnimationName(node)
        const exactMatched = sceneNodeNames.has(node.toLowerCase())
        const canonicalMatched = canonicalName != null && canonicalSceneNodeNames.has(canonicalName)
        return {
          name: node,
          matched: exactMatched || canonicalMatched,
          match: exactMatched ? 'exact' : canonicalMatched ? 'canonical' : null,
          canonicalName
        }
      })
      if (
        needle &&
        !label.toLowerCase().includes(needle) &&
        !nodes.some(node => node.name.toLowerCase().includes(needle))
      ) {
        continue
      }
      rows.push({
        type: animation.type || null,
        nodeCount: nodes.length,
        matchedNodeCount: nodes.filter(node => node.matched).length,
        nodes
      })
    }
    return rows
  }
  const collectComponents = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const registry = context.getCockpitInteractionPickRegistry()
    const interactionRows = context.getRuntime().getInteractionBindings()
      .filter(binding => !needle || binding.target.toLowerCase().includes(needle))
      .map(binding => {
        const pickMeshes = [...registry.bindingsByMesh.entries()]
          .filter(([, candidate]) => candidate.target === binding.target)
          .map(([mesh]) => mesh.name || mesh.type)
        const fallback = registry.fallbackHitboxes.find(target => target.binding.target === binding.target)
        return {
          target: binding.target,
          kind: binding.metadata.sourceKind,
          sourcePath: binding.sourcePath,
          source: binding.expression.source,
          releaseSource: binding.releaseExpression?.source ?? null,
          feedbackTargets: binding.feedbackTargets,
          feedbackVariableKeys: binding.feedbackVariableKeys,
          soundEvents: binding.soundEvents,
          hasRelease: binding.releaseExpression != null,
          pickMeshes,
          fallbackHitbox: fallback == null
            ? null
            : {
                sourceNode: fallback.sourceNode.name || fallback.sourceNode.type,
                center: fallback.box.getCenter(new Vector3()).toArray(),
                size: fallback.box.getSize(new Vector3()).toArray()
              }
        }
      })
    const blockerRows = context.getRuntime().getInteractionBlockers()
      .filter(blocker => !needle || blocker.target.toLowerCase().includes(needle))
      .map(blocker => {
        const blockerMeshes = [...registry.blockersByMesh.entries()]
          .filter(([, candidate]) => candidate.target === blocker.target)
          .map(([mesh]) => mesh.name || mesh.type)
        const hitbox = registry.blockerHitboxes.find(target => target.blocker.target === blocker.target)
        return {
          target: blocker.target,
          kind: 'blocker',
          sourcePath: blocker.sourcePath,
          source: null,
          releaseSource: null,
          feedbackTargets: blocker.feedbackTargets,
          feedbackVariableKeys: [],
          soundEvents: [],
          hasRelease: false,
          pickMeshes: blockerMeshes,
          fallbackHitbox: hitbox == null
            ? null
            : {
                sourceNode: hitbox.sourceNode.name || hitbox.sourceNode.type,
                center: hitbox.box.getCenter(new Vector3()).toArray(),
                size: hitbox.box.getSize(new Vector3()).toArray()
              }
        }
      })
    return [...interactionRows, ...blockerRows].slice(0, limit)
  }
  const collectAnimations = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const runtimeState = context.getRuntimeState()
    return context.getCompiledBehaviors().animationBindings
      .filter(binding => !needle || binding.target.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(binding => ({
        target: binding.target,
        sourcePath: binding.sourcePath,
        value: runtimeState.animationValues.get(binding.target) ?? null
      }))
  }
  const collectAnimationTriggers = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    return context.getCompiledBehaviors().animationTriggerBindings
      .filter(binding => !needle || binding.animation.toLowerCase().includes(needle) || binding.eventName.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(binding => ({ ...binding }))
  }
  const collectCanonicalAliasesForExpression = (
    expression: CompiledExpression
  ): readonly Record<string, unknown>[] => {
    const aliases = new Map<string, Record<string, unknown>>()
    for (const variableKey of expression.variableKeys) {
      const normalizedKey = variableKey.split(',')[0]?.trim().toUpperCase() ?? ''
      if (normalizedKey.length === 0) continue
      const alias =
        normalizedKey.startsWith('A:')
          ? mapMsfsSimVarToCanonicalState(normalizedKey.slice(2))
          : normalizedKey.startsWith('L:')
            ? mapMsfsLocalVarToCanonicalState(normalizedKey.slice(2))
            : undefined
      if (alias == null) continue
      aliases.set(`${normalizedKey}:${alias.stateKey}`, {
        variable: normalizedKey,
        stateKey: alias.stateKey,
        canonicalUnit: alias.canonicalUnit,
      })
    }
    return [...aliases.values()]
  }

  const collectCanonicalVisuals = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const runtimeState = context.getRuntimeState()
    const canonicalRows = runtimeState.canonicalVisualBindings.map(binding => {
        const value =
          binding.channel === 'visibility'
            ? runtimeState.nodeVisibilities.get(binding.target) ?? null
            : binding.channel === 'material'
              ? runtimeState.materialValues.get(binding.target) ?? null
              : runtimeState.animationValues.get(binding.target) ?? null
        return {
          source: 'canonical',
          ...binding,
          value,
        }
      })
    const compiledRows = [
      ...context.getCompiledBehaviors().animationBindings.map(binding => ({
        source: 'compiled-msfs',
        channel: 'animation',
        target: binding.target,
        value: runtimeState.animationValues.get(binding.target) ?? null,
        sourcePath: binding.sourcePath,
        expression: binding.expression.source,
        canonicalAliases: collectCanonicalAliasesForExpression(binding.expression),
      })),
      ...context.getCompiledBehaviors().visibilityBindings.map(binding => ({
        source: 'compiled-msfs',
        channel: 'visibility',
        target: binding.target,
        value: runtimeState.nodeVisibilities.get(binding.target) ?? null,
        sourcePath: binding.sourcePath,
        expression: binding.expression.source,
        canonicalAliases: collectCanonicalAliasesForExpression(binding.expression),
      })),
      ...context.getCompiledBehaviors().materialBindings.map(binding => ({
        source: 'compiled-msfs',
        channel: 'material',
        target: binding.target,
        value: runtimeState.materialValues.get(binding.target) ?? null,
        sourcePath: binding.sourcePath,
        expression: binding.expression.source,
        canonicalAliases: collectCanonicalAliasesForExpression(binding.expression),
      })),
    ].filter(row => row.canonicalAliases.length > 0)

    return [...canonicalRows, ...compiledRows]
      .filter(row => {
        const haystack = JSON.stringify(row).toLowerCase()
        return !needle || haystack.includes(needle)
      })
      .slice(0, limit)
  }

  const summarizeMaterial = (material: Material): Record<string, unknown> => {
    const materialRecord = material as Material & {
      readonly color?: { readonly getHexString?: () => string }
      readonly emissive?: { readonly getHexString?: () => string }
      readonly emissiveIntensity?: number
      readonly map?: unknown
      readonly emissiveMap?: unknown
      readonly alphaMap?: unknown
      readonly opacity?: number
      readonly transparent?: boolean
      readonly depthTest?: boolean
      readonly depthWrite?: boolean
      readonly blending?: number
      readonly colorWrite?: boolean
    }
    return {
      name: material.name || null,
      type: material.type,
      visible: material.visible,
      opacity: materialRecord.opacity ?? null,
      transparent: materialRecord.transparent ?? null,
      color: materialRecord.color?.getHexString == null
        ? null
        : `#${materialRecord.color.getHexString()}`,
      emissive: materialRecord.emissive?.getHexString == null
        ? null
        : `#${materialRecord.emissive.getHexString()}`,
      emissiveIntensity: materialRecord.emissiveIntensity ?? null,
      map: materialRecord.map != null,
      emissiveMap: materialRecord.emissiveMap != null,
      alphaMap: materialRecord.alphaMap != null,
      depthTest: materialRecord.depthTest ?? null,
      depthWrite: materialRecord.depthWrite ?? null,
      blending: materialRecord.blending ?? null,
      colorWrite: materialRecord.colorWrite ?? null,
      msfs: {
        blendGBufferDepthMask: material.userData?.msfsBlendGBufferDepthMask ?? null,
        blendGBufferForwardColor: material.userData?.msfsBlendGBufferForwardColor ?? null,
        materialCode: material.userData?.msfsMaterialCode ?? null
      }
    }
  }
  const getObjectMaterials = (object: Object3D): readonly Material[] => {
    const material = (object as Object3D & { readonly material?: Material | Material[] }).material
    if (material == null) return []
    return Array.isArray(material) ? material : [material]
  }
  const summarizeMaterialObject = (
    object: Object3D,
    options: { readonly descendants?: boolean } = {}
  ): Record<string, unknown> => {
    const rows: Record<string, unknown>[] = []
    const appendObject = (candidate: Object3D): void => {
      const materials = getObjectMaterials(candidate)
      if (materials.length === 0) return
      rows.push({
        node: candidate.name || candidate.type,
        visible: candidate.visible,
        parent: candidate.parent?.name || candidate.parent?.type || null,
        runtimeEmissiveValue: context.getRuntimeState().materialValues.get(candidate.name) ?? null,
        bindings: context.getCompiledBehaviors().materialBindings
          .filter(binding => binding.target === candidate.name)
          .map(binding => ({
            target: binding.target,
            property: binding.property,
            source: binding.expression.source,
            overrideBaseEmissive: binding.overrideBaseEmissive,
            sourcePath: binding.sourcePath
          })),
        materials: materials.map(summarizeMaterial)
      })
    }

    appendObject(object)
    if (options.descendants === true) {
      object.traverse(child => {
        if (child !== object) appendObject(child)
      })
    }
    return {
      object: object.name || object.type,
      type: object.type,
      visible: object.visible,
      materialRows: rows
    }
  }
  const collectMaterials = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const rows: Record<string, unknown>[] = []
    context.getLoadedModel().scene.traverse(object => {
      if (rows.length >= limit) return
      const materials = getObjectMaterials(object)
      if (materials.length === 0) return
      const objectLabel = object.name || object.type
      const materialLabels = materials.map(material => material.name || material.type).join(' ')
      if (
        needle &&
        !objectLabel.toLowerCase().includes(needle) &&
        !materialLabels.toLowerCase().includes(needle)
      ) {
        return
      }
      rows.push(summarizeMaterialObject(object))
    })
    return rows
  }
  const collectVariables = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    return Object.entries(context.getRuntimeHost().getSnapshot())
      .filter(([name]) => !needle || name.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(([name, value]) => ({ name, value }))
  }
  const collectState = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const state = context.getRuntimeHost().simulatorEngine.state
    return state
      .listDefinitions()
      .filter(definition => !needle || definition.key.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(definition => ({
        key: definition.key,
        unit: definition.unit ?? null,
        valueType: definition.valueType ?? null,
        description: definition.description ?? null,
        entry: state.getEntry(definition.key) ?? null,
      }))
  }
  const statusData = (): DevApiStatusData => {
    const loadedModel = context.getLoadedModel()
    const cockpit = context.getCockpitCameraController()
    const binding = loadedModel.interior?.vcockpitBinding ?? null
    const gaugeRows = gauges()
    const capturableGaugeCount = gaugeRows.filter(isCapturableGauge).length
    const capturedCapturableGaugeCount = gaugeRows.filter(gauge => isCapturableGauge(gauge) && gauge.captured).length
    return {
      loadStage: getLoadStage(),
      packageRoot: context.packageRoot,
      packageName: context.packageData.packageName,
      aircraftId: context.aircraft.id,
      aircraftTitle: context.aircraft.title,
      renderer: {
        mode: context.rendererInfo.mode,
        pixelRatio: context.renderer.getPixelRatio(),
        size: context.renderer.getSize(new Vector2()).toArray()
      },
      cockpit: {
        available: cockpit.isAvailable(),
        active: cockpit.isActive(),
        activeInteriorLodIndex: loadedModel.interior?.loadedLodIndex ?? null
      },
      counts: {
        interactions: context.getRuntime().getInteractionBindings().length,
        materialBindings: context.getCompiledBehaviors().materialBindings.length,
        gauges: binding?.htmlGaugeCount ?? 0,
        loadedGauges: binding?.loadedHtmlGaugeCount ?? 0,
        capturedGauges: binding?.capturedHtmlGaugeCount ?? 0,
        capturableGauges: capturableGaugeCount,
        capturedCapturableGauges: capturedCapturableGaugeCount,
        backendOnlyGauges: Math.max(0, gaugeRows.length - capturableGaugeCount),
        variables: Object.keys(context.getRuntimeHost().getSnapshot()).length
      },
      fps: context.getFpsSnapshot(),
      diagnostics: diagnosticCounts()
    }
  }
  const isViewerReady = (): boolean => {
    const stage = getLoadStage()?.stage
    return typeof stage === 'string' && stage !== 'init:error'
  }
  const resolveGauge = (
    key?: string,
    options: { readonly surface?: string; readonly source?: string } = {}
  ): VCockpitHtmlGaugeRuntime | null => {
    const surfaceNeedle = options.surface?.trim().toLowerCase() ?? ''
    const sourceNeedle = options.source?.trim().toLowerCase() ?? ''
    const candidates = gauges().filter(gauge =>
      (!surfaceNeedle || gauge.surface.toLowerCase().includes(surfaceNeedle)) &&
      (!sourceNeedle || gauge.source.toLowerCase().includes(sourceNeedle))
    )
    if (key == null || key.trim() === '') return candidates[0] ?? null
    const needle = key.trim().toLowerCase()
    return candidates.find(gauge =>
      gauge.gaugeKey.toLowerCase() === needle ||
      gauge.gaugeKey.toLowerCase().includes(needle) ||
      gauge.source.toLowerCase().includes(needle) ||
      gauge.surface.toLowerCase().includes(needle)
    ) ?? null
  }
  const interactionAdapter = context.getCockpitInteractionAdapter()
  const interactionLifecycle = context.getCockpitInteractionLifecycle()
  const interactionDispatcher = context.getCockpitInteractionDispatcher()
  const interactionHistory = context.cockpitInteractionHistory
  const interactionTrace = context.cockpitInteractionTrace
  const activeInteractionStates = new Map<string, ActiveDevApiInteraction>()
  const stopAllDevApiInteractions = (): readonly ActiveDevApiInteraction[] => {
    const states = [...activeInteractionStates.values()]
    for (const state of states) {
      interactionLifecycle.stop(
        state.target,
        { source: 'devapi', operation: 'release', phase: 'release', timestampMs: performance.now() },
        { release: state.lifecycle === 'held', unlock: false }
      )
      interactionDispatcher.finish(state.target.id)
    }
    interactionAdapter.stopAll()
    activeInteractionStates.clear()
    return states
  }
  window.addEventListener(VIEWER_INTERACTION_STOP_EVENT, event => {
    const detail = (event as CustomEvent<ViewerInteractionStopDetail>).detail
    const states = stopAllDevApiInteractions()
    interactionHistory.add({
      timestampMs: Date.now(),
      source: 'viewer',
      target: '*',
      action: 'stop',
      result: 'stopped',
      detail: {
        reason: detail?.reason ?? 'external',
        targets: detail?.targets ?? states.map(state => state.target.id)
      }
    })
  })
  let cockpitInputStore = loadCockpitInputStore(window.localStorage)
  window.addEventListener('cockpit-input-settings-changed', () => {
    cockpitInputStore = loadCockpitInputStore(window.localStorage)
  })
  const cockpitInputProfilesApi = createCockpitInputProfilesApi({
    getStore: () => cockpitInputStore,
    commit: store => {
      saveCockpitInputStore(store, window.localStorage)
      cockpitInputStore = store
      window.dispatchEvent(new Event('cockpit-input-settings-changed'))
    },
    packageRoot: context.packageRoot,
    aircraftId: context.aircraft.id
  })
  const runInteraction = async (
    targetName: string,
    operation: CockpitInteractionOperation,
    options: InteractionSelector & { readonly steps?: number; readonly direction?: CockpitRelativeDirection; readonly value?: number | boolean | string; readonly unit?: string } = {}
  ): Promise<DevApiInteractionResult> => {
    let runningTargetId: string | null = null
    let retainActiveState = false
    const recordFailure = (result: DevApiInteractionResult, resolvedTarget = targetName): DevApiInteractionResult => {
      interactionHistory.add({
        timestampMs: Date.now(),
        source: 'devapi',
        target: resolvedTarget,
        action: operation,
        result: result.code
      })
      return result
    }
    try {
      const resolution = resolveInteractionWithHeldFallback(
        targetName,
        operation,
        interactionAdapter.resolve(targetName),
        activeInteractionStates
      )
      if (!resolution.ok) return recordFailure(interactionResolutionFailure(targetName, resolution))
      const variantFailure = rejectUnauthoredVariant(targetName, options.variant)
      if (variantFailure != null) return recordFailure(variantFailure)
      const request = resolveInteractionRequest(
        targetName,
        resolution,
        new Set([...activeInteractionStates.keys(), ...interactionDispatcher.snapshot.busy]),
        operation !== 'release'
      )
      if (!request.ok) return recordFailure(request.result)
      const target = request.target
      const heldState = activeInteractionStates.get(target.id)
      const trackRunning = (): void => {
        runningTargetId = target.id
        activeInteractionStates.set(target.id, {
          target,
          operation,
          source: 'devapi',
          lifecycle: 'running',
          startedAtMs: Date.now(),
          stopStatus: 'active'
        })
      }
      if (operation === 'on' || operation === 'off') {
        if (!interactionDispatcher.claim(target, operation)) return interactionResult(false, 'TARGET_BUSY', `${targetName} is busy.`, { target: target.id })
        trackRunning()
        const state = await interactionAdapter
          .setBooleanState(target, operation === 'on', options.interaction)
          .finally(() => interactionDispatcher.finish(target.id))
        return interactionResult(
          state.ok,
          state.code,
          state.ok ? `Set ${targetName} ${operation}.` : `Could not set ${targetName} ${operation}: ${state.code}.`,
          { target: target.id, operation, ...state }
        )
      }
      if (operation === 'set' && typeof options.value === 'boolean') {
        if (!interactionDispatcher.claim(target, operation)) return interactionResult(false, 'TARGET_BUSY', `${targetName} is busy.`, { target: target.id })
        trackRunning()
        const state = await interactionAdapter
          .setBooleanState(target, options.value, options.interaction)
          .finally(() => interactionDispatcher.finish(target.id))
        return interactionResult(state.ok, state.code, state.ok ? `Set ${targetName}.` : `Could not set ${targetName}: ${state.code}.`, { target: target.id, operation, ...state })
      }
      if (operation === 'set' && typeof options.value === 'string') {
        return interactionResult(false, 'VALUE_REACHABILITY_UNKNOWN', `String reachability is not authoritative for ${targetName}.`, { target: target.id, requested: options.value })
      }
      if ((operation === 'set' || operation === 'adjust') && typeof options.value === 'number') {
        if (!interactionDispatcher.claim(target, operation)) return interactionResult(false, 'TARGET_BUSY', `${targetName} is busy.`, { target: target.id })
        trackRunning()
        const exact = await (operation === 'set'
          ? interactionAdapter.setExact(target, options.value, options.unit, options.interaction)
          : interactionAdapter.adjustExact(target, options.value, options.unit, options.interaction)
        ).finally(() => interactionDispatcher.finish(target.id))
        const entry = interactionHistory.add({
          timestampMs: Date.now(),
          source: 'devapi',
          target: target.id,
          action: operation,
          result: exact.code,
          detail: { ...exact }
        })
        return interactionResult(
          exact.ok,
          exact.code,
          exact.ok ? `Executed exact ${operation} on ${targetName}.` : `Exact ${operation} failed on ${targetName}: ${exact.code}.`,
          { target: target.id, operation, historyId: entry.id, ...exact }
        )
      }
      const steps = options.steps ?? 1
      if (!Number.isInteger(steps) || steps <= 0) return interactionResult(false, 'OPERATION_UNSUPPORTED', 'steps must be a positive integer.', { steps })
      const routeOperation = operation === 'turn'
        ? interactionAdapter.resolveRelativeOperation(target, options.direction)
        : operation === 'hold' ? 'press' : operation
      const routeAction: CanonicalCockpitAction = {
        source: 'devapi',
        operation: operation === 'hold' ? 'hold' : routeOperation,
        phase: operation === 'hold' ? 'hold' : operation === 'release' ? 'release' : 'press',
        channel: options.interaction,
        direction: options.direction,
        value: options.value,
        unit: options.unit,
        timestampMs: performance.now()
      }
      const route = interactionAdapter.route(target, routeAction)
      if (route == null) {
        if (operation === 'release' && heldState?.lifecycle === 'held') {
          interactionDispatcher.finish(target.id)
          interactionAdapter.release(target)
          activeInteractionStates.delete(target.id)
          const entry = interactionHistory.add({
            timestampMs: Date.now(),
            source: 'devapi',
            target: target.id,
            action: operation,
            result: 'released',
            detail: { authoredRoute: false }
          })
          return interactionResult(true, 'OK', `Released held interaction ${targetName}.`, {
            target: target.id,
            operation,
            authoredRoute: false,
            historyId: entry.id
          })
        }
        return recordFailure(
          interactionResult(false, 'OPERATION_UNSUPPORTED', `${operation} is not authored for ${targetName}.`, { target: target.id, operations: target.operations }),
          target.id
        )
      }
      if (operation !== 'release') trackRunning()
      for (let index = 0; index < steps; index += 1) {
        const action: CanonicalCockpitAction = {
          ...routeAction,
          timestampMs: performance.now()
        }
        const dispatched = interactionDispatcher.dispatch(target, action)
        if (dispatched === 'busy') return recordFailure(interactionResult(false, 'TARGET_BUSY', `${targetName} is busy.`, { target: target.id }), target.id)
        if (dispatched !== 'executed') {
          if (operation === 'release' && heldState?.lifecycle === 'held') {
            interactionDispatcher.finish(target.id)
            interactionAdapter.release(target)
            activeInteractionStates.delete(target.id)
          }
          return recordFailure(interactionResult(false, 'INTERACTION_UNAVAILABLE', `${operation} could not execute.`, {
            target: target.id,
            heldStateReleased: operation === 'release' && heldState?.lifecycle === 'held'
          }), target.id)
        }
        interactionTrace.add(() => ({ kind: 'canonical-action', action, route, target: target.binding.metadata }))
        await Promise.resolve()
      }
      if (operation === 'hold') {
        const state = activeInteractionStates.get(target.id)
        if (state != null) activeInteractionStates.set(target.id, { ...state, lifecycle: 'held' })
        retainActiveState = true
      }
      if (operation === 'release') {
        interactionAdapter.release(target)
        activeInteractionStates.delete(target.id)
        runningTargetId = null
      }
      if (operation === 'press') {
        const releaseAction: CanonicalCockpitAction = { source: 'devapi', operation: 'release', phase: 'release', channel: options.interaction, timestampMs: performance.now() }
        if (interactionAdapter.route(target, releaseAction) != null) interactionDispatcher.dispatch(target, releaseAction)
        interactionAdapter.release(target)
      }
      const entry = interactionHistory.add({ timestampMs: Date.now(), source: 'devapi', target: target.id, action: operation, result: 'executed', detail: { steps, direction: options.direction } })
      return interactionResult(true, 'OK', `Executed ${operation} on ${targetName}.`, { target: target.id, operation, steps, historyId: entry.id })
    } catch (error) {
      console.error('DevApi interaction failed', error)
      interactionTrace.add(() => ({
        kind: 'error',
        target: targetName,
        operation,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }))
      return interactionResult(false, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error), { target: targetName, operation })
    } finally {
      if (runningTargetId != null && !retainActiveState) activeInteractionStates.delete(runningTargetId)
    }
  }
  const interactionsApi: DevApiInteractions = {
    list: (options = {}) => {
      const needle = options.filter?.toLowerCase() ?? ''
      const targets = interactionAdapter.list()
      const localization = context.getCockpitLocalization()
      const authoredCounts = new Map<string, number>()
      for (const target of targets) {
        const authoredId = target.binding.metadata.authoredId
        if (authoredId != null) authoredCounts.set(authoredId, (authoredCounts.get(authoredId) ?? 0) + 1)
      }
      const rows = targets
        .filter(target => !needle || `${target.binding.metadata.authoredId} ${target.id}`.toLowerCase().includes(needle))
        .slice(0, options.limit ?? 500)
        .map(target => summarizeInteractionTarget(
          target,
          target.binding.metadata.authoredId == null
            ? 0
            : authoredCounts.get(target.binding.metadata.authoredId) ?? 0,
          interactionAdapter.currentValue(target),
          target.bindings.map(binding => context.getRuntime().evaluateInteractionFormattedValue(binding)).find(value => value != null) ?? null,
          localization
        ))
      return interactionResult(true, 'OK', 'Listed cockpit interactions.', rows)
    },
    describe: target => {
      const result = interactionAdapter.resolve(target)
      return result.ok
        ? interactionResult(true, 'OK', `Described ${target}.`, describeInteractionTarget(result.target, {
            packageId: context.packageData.packageName,
            packageVersion: context.packageData.manifest?.packageVersion ?? null,
            currentValue: interactionAdapter.currentValue(result.target),
            formattedValue: result.target.bindings
              .map(binding => context.getRuntime().evaluateInteractionFormattedValue(binding))
              .find(value => value != null) ?? null,
            localization: context.getCockpitLocalization(),
            localizationAvailable: true,
            blockers: context.getCompiledBehaviors().interactionBlockers,
            diagnostics: getDiagnostics()
          }))
        : interactionResolutionFailure(target, result)
    },
    active: () => interactionResult(true, 'OK', 'Listed active interactions.', listActiveInteractionStates(
      activeInteractionStates,
      interactionAdapter.active(),
      interactionDispatcher.snapshot.busy
    )),
    history: (options = {}) => interactionResult(true, 'OK', 'Collected interaction history.', interactionHistory.list(options.limit)),
    trace: {
      snapshot: () => interactionResult(true, 'OK', 'Collected interaction trace.', interactionTrace.snapshot()),
      enable: (enabled = true) => {
        interactionTrace.enabled = enabled
        if (enabled) {
          interactionTrace.add({
            kind: 'trace-coverage',
            implemented: [
              'canonical-action', 'selected-route', 'hit-test', 'blocker', 'movement',
              'variable-read', 'variable-write', 'input-event-rpn', 'key-event', 'html-event',
              'sound-event', 'effect-event', 'feedback', 'scheduler', 'cancellation', 'provenance'
            ],
            unavailable: ['native simulator internals outside the viewer host']
          })
        }
        return interactionResult(true, 'OK', `Detailed tracing ${enabled ? 'enabled' : 'disabled'}.`, { enabled })
      },
      export: () => interactionResult(true, 'OK', 'Exported interaction trace.', interactionTrace.export())
    },
    profiles: cockpitInputProfilesApi,
    settings: { get: () => interactionResult(true, 'OK', 'Loaded cockpit input settings.', cockpitInputStore.globalSettings), set: settings => { cockpitInputStore = { ...cockpitInputStore, globalSettings: updateCockpitInputSettings(settings) }; window.dispatchEvent(new Event('cockpit-input-settings-changed')); return interactionResult(true, 'OK', 'Saved cockpit input settings.', cockpitInputStore.globalSettings) } },
    press: (target, options) => runInteraction(target, 'press', options),
    hold: (target, options) => runInteraction(target, 'hold', options),
    release: (target, options) => runInteraction(target, 'release', options),
    turn: (target, options) => runInteraction(target, 'turn', options),
    increase: (target, options) => runInteraction(target, 'increase', options),
    decrease: (target, options) => runInteraction(target, 'decrease', options),
    adjust: (target, options) => runInteraction(target, 'adjust', { ...options, value: options.delta }),
    set: (target, options) => runInteraction(target, 'set', options),
    on: (target, options) => runInteraction(target, 'on', options),
    off: (target, options) => runInteraction(target, 'off', options),
    toggle: (target, options) => runInteraction(target, 'toggle', options),
    stop: target => {
      const resolved = interactionAdapter.resolve(target)
      if (!resolved.ok) return interactionResolutionFailure(target, resolved)
      const state = activeInteractionStates.get(resolved.target.id)
      if (state?.lifecycle === 'held') {
        interactionLifecycle.stop(
          resolved.target,
          { source: 'devapi', operation: 'release', phase: 'release', timestampMs: performance.now() },
          { release: true, unlock: false }
        )
        interactionDispatcher.finish(resolved.target.id)
      } else {
        interactionDispatcher.stop(resolved.target.id)
        interactionLifecycle.stop(
          resolved.target,
          { source: 'devapi', operation: 'release', phase: 'release', timestampMs: performance.now() },
          { release: false, unlock: false }
        )
      }
      activeInteractionStates.delete(resolved.target.id)
      interactionHistory.add({
        timestampMs: Date.now(),
        source: 'devapi',
        target: resolved.target.id,
        action: 'stop',
        result: 'stopped'
      })
      return interactionResult(true, 'STOPPED', `Stopped ${target}.`, {
        target: resolved.target.id,
        status: 'stopped'
      })
    },
    stopAll: () => {
      interactionDispatcher.stopAll()
      const states = stopAllDevApiInteractions()
      interactionHistory.add({
        timestampMs: Date.now(),
        source: 'devapi',
        target: '*',
        action: 'stop',
        result: 'stopped',
        detail: { targets: states.map(state => state.target.id) }
      })
      return interactionResult(true, 'STOPPED', 'Stopped all interactions.', {
        targets: states.map(state => state.target.id),
        status: 'stopped'
      })
    },
    dispatch: (target, action) => startCanonicalInteractionDispatch(target, action, {
      resolve: name => resolveInteractionWithHeldFallback(
        name,
        action.operation,
        interactionAdapter.resolve(name),
        activeInteractionStates
      ),
      busyTargetIds: () => new Set([...activeInteractionStates.keys(), ...interactionDispatcher.snapshot.busy]),
      route: (resolved, canonicalAction) => interactionAdapter.route(resolved, canonicalAction),
      dispatch: (resolved, canonicalAction) => interactionDispatcher.dispatch(resolved, canonicalAction),
      onExecuted: (resolved, canonicalAction, route) => {
        interactionTrace.add(() => ({
          kind: 'canonical-action',
          action: canonicalAction,
          route,
          target: resolved.binding.metadata
        }))
        interactionHistory.add({
          timestampMs: Date.now(),
          source: canonicalAction.source,
          target: resolved.id,
          action: canonicalAction.operation,
          result: 'executed',
          detail: { phase: canonicalAction.phase }
        })
        if (canonicalAction.operation === 'hold') {
          activeInteractionStates.set(resolved.id, {
            target: resolved,
            operation: canonicalAction.operation,
            source: canonicalAction.source,
            lifecycle: 'held',
            startedAtMs: Date.now(),
            stopStatus: 'active'
          })
        }
        if (canonicalAction.operation === 'release') {
          interactionAdapter.release(resolved)
          activeInteractionStates.delete(resolved.id)
        }
      }
    })
  }
  function list(options: {
    readonly kind: 'gauges'
    readonly filter?: string
    readonly limit?: number
  }): DevApiResponse<readonly DevApiGaugeSummary[]>
  function list(options?: {
    readonly kind?: DevApiListKind
    readonly filter?: string
    readonly limit?: number
  }): DevApiResponse
  function list(options: {
    readonly kind?: DevApiListKind
    readonly filter?: string
    readonly limit?: number
  } = {}): DevApiResponse {
    const kind = options.kind ?? 'components'
    const filter = options.filter ?? ''
    const limit = Math.max(1, Math.min(5_000, Math.floor(options.limit ?? 500)))
    if (kind === 'nodes') return ok('Listed scene nodes.', collectNodes(filter, limit))
    if (kind === 'nodeAnimations') return ok('Listed model node animations.', collectNodeAnimations(filter, limit))
    if (kind === 'components' || kind === 'interactions') return ok('Listed cockpit components/interactions.', collectComponents(filter, limit))
    if (kind === 'gauges') return ok('Listed VCockpit gauges.', gauges().map(summarizeGauge).slice(0, limit))
    if (kind === 'animations') return ok('Listed animation bindings.', collectAnimations(filter, limit))
    if (kind === 'animationTriggers') return ok('Listed animation trigger bindings.', collectAnimationTriggers(filter, limit))
    if (kind === 'canonicalVisuals') return ok('Listed canonical visual bindings.', collectCanonicalVisuals(filter, limit))
    if (kind === 'materials') return ok('Listed scene materials.', collectMaterials(filter, limit))
    if (kind === 'inputEvents') {
      const normalizedFilter = filter.trim().toLowerCase()
      return ok(
        'Listed input-event bridge bindings.',
        context.getRuntimeHost()
          .getInputEventBindingNames()
          .filter(name => !normalizedFilter || name.toLowerCase().includes(normalizedFilter))
          .slice(0, limit)
      )
    }
    if (kind === 'variables') return ok('Listed runtime variables.', collectVariables(filter, limit))
    if (kind === 'state') return ok('Listed canonical engine state.', collectState(filter, limit))
    if (kind === 'commands') return ok('Listed canonical engine commands.', listCanonicalEngineCommands(filter, limit))
    if (kind === 'diagnostics') return api.diagnostics({ filter, limit })
    if (kind === 'events') return api.events()
    if (kind === 'settings') return api.settings.get()
    if (kind === 'camera') return api.camera.getPose()
    return fail(`Unknown list kind "${kind}".`, { kind })
  }
  const api: ViewerDevApi = {
    ready: async () => {
      const started = performance.now()
      while (performance.now() - started < 60_000) {
        if (isViewerReady()) return ok('Viewer scene is ready.', statusData())
        await sleep(50)
      }
      return fail('Timed out waiting for viewer scene readiness.', statusData())
    },
    status: () => ok('Collected viewer status.', statusData()),
    help: () => ok('Available on window.__DevApi.', {
      examples: [
        'await __DevApi.ready()',
        '__DevApi.find("baro")',
        'await __DevApi.interactions.press("PUSH_AP_MASTER")',
        'await __DevApi.interactions.hold("PUSH_STARTER")',
        'await __DevApi.interactions.increase("KNOB_HEADING", { steps: 3 })',
        'await __DevApi.waitFor({ kind: "gaugesReady", captured: true }, 45000)',
        'await __DevApi.waitFor({ kind: "event", eventKind: "html", name: "A320_Neo_CDU_1_BTN_MENU" }, 5000)',
        'await __DevApi.waitFor({ kind: "varChanged", var: "A:SPOILERS HANDLE POSITION", from: 0 }, 5000)',
        '__DevApi.list({ kind: "state", filter: "surfaces" })',
        '__DevApi.list({ kind: "commands", filter: "apu" })',
        '__DevApi.writeState("surfaces.flaps.target.ratio", 0.5, "ratio")',
        '__DevApi.dispatchCommand("surfaces.setTarget", { id: "flaps", ratio: 0.5 })',
        '__DevApi.checkGauge(undefined, { screenshot: true })',
        'await __DevApi.inspectWasm("terronnd")',
        '__DevApi.checkMaterial("PUSH_OVHD_HYD_ENG1PUMP_SEQ1")',
        '__DevApi.diagnostics({ severity: "warning", includeGauges: true })',
        '__DevApi.checkParam(["gear", "flaps", "spoilers", "parkingBrake"])',
        '__DevApi.setParam("spoilers", 50)',
        '__DevApi.bridgeCall("A32NX_PED_ECP_ENG_PB_Push")',
        '__DevApi.bridgeCall("InputEvent_Push_Long", [1, 1])',
        '__DevApi.events({ kind: "html", limit: 5 })',
        '__DevApi.assetCache.snapshot()',
        'await __DevApi.assetCache.refreshPackageVersions()',
        '__DevApi.bench.startup()',
        'await __DevApi.bench.cockpitLod0()',
        'await __DevApi.bench.all()',
        '__DevApi.bench.history()',
        '__DevApi.report()'
      ],
      methods: Object.keys(window.__DevApi ?? {})
    }),
    schema: () => ok('Returned DevApi schema summary.', {
      response: '{ ok, summary, data, warnings? }',
      listKinds: ['nodes', 'nodeAnimations', 'components', 'interactions', 'gauges', 'animations', 'animationTriggers', 'canonicalVisuals', 'materials', 'inputEvents', 'variables', 'state', 'commands', 'diagnostics', 'events', 'settings', 'camera'],
      interactionMethods: ['list', 'describe', 'active', 'history', 'press', 'hold', 'release', 'turn', 'increase', 'decrease', 'adjust', 'set', 'on', 'off', 'toggle', 'stop', 'stopAll', 'dispatch'],
      waitConditions: ['viewerReady', 'cockpitReady', 'gaugesLoaded', 'gaugesReady', 'gaugeCaptured', 'componentAvailable', 'varEquals', 'varAbove', 'varBelow', 'noNewErrors', 'event', 'varChanged', 'interactionExecuted'],
      waitEventKinds: ['key', 'html', 'sound', 'effect', 'bridge'],
      diagnosticsOptions: ['severity', 'filter', 'limit', 'includeGauges'],
      eventOptions: ['kind', 'limit'],
      checkGaugeOptions: ['screenshot', 'surface', 'source'],
      inspectWasmOptions: ['maxBytes', 'surface', 'source'],
      benchMethods: ['startup', 'cockpitLod0', 'all', 'history', 'clearHistory'],
      assetCacheMethods: ['snapshot', 'refreshPackageVersions', 'clearDdsRanges'],
      resetOptions: ['runtime', 'coldAndDark'],
      runtimeMethods: ['readVar', 'writeVar', 'readState', 'writeState', 'dispatchCommand', 'keyEvent', 'bridgeCall'],
      paramPresets: ['vspeed', 'altitude', 'pressure', 'location', 'gear', 'flaps', 'spoilers', 'parkingBrake']
    }),
    report: () => ok('Collected viewer debug report.', {
      status: statusData(),
      settings: context.getSettingsSnapshot(),
      diagnostics: getDiagnostics(),
      cockpitInteractionStats: { ...context.cockpitInteractionStats },
      interactionCompilerTotals: context.getCompiledBehaviors().interactionCompilerTotals,
      cockpitInteractionMisses: interactionDispatcher.snapshot.misses,
      gauges: gauges().map(summarizeGauge),
      events: api.events().data,
      perf: api.perf().data,
      bench: {
        startup: api.bench.startup().data,
        cockpitLod0State: context.getCockpitBenchmarkState()
      }
    }),
    reset: (options = {}) => {
      if (highlightGroup != null) {
        context.scene.remove(highlightGroup)
        highlightGroup.clear()
        highlightGroup = null
      }
      context.getCockpitPerfDiagnostics().reset()
      const shouldResetRuntime = options.runtime === true || options.coldAndDark === true
      if (shouldResetRuntime) {
        context.getRuntimeHost().resetRuntimeState({ coldAndDark: options.coldAndDark === true })
      }
      return ok(shouldResetRuntime ? 'Reset DevApi transient diagnostics and runtime state.' : 'Reset DevApi transient diagnostics.', {
        perf: context.getCockpitPerfDiagnostics().getSummary(),
        runtime: shouldResetRuntime ? context.getRuntimeHost().getStats() : null
      })
    },
    find: (query, options = {}) => {
      const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 50)))
      const needle = query.toLowerCase()
      return ok(`Searched viewer for "${query}".`, {
        nodes: collectNodes(query, limit),
        components: collectComponents(query, limit),
        gauges: gauges().filter(gauge => `${gauge.gaugeKey} ${gauge.source} ${gauge.surface}`.toLowerCase().includes(needle)).slice(0, limit).map(summarizeGauge),
        animations: collectAnimations(query, limit),
        canonicalVisuals: collectCanonicalVisuals(query, limit),
        variables: collectVariables(query, limit),
        diagnostics: getDiagnostics().filter(diagnostic => `${diagnostic.code} ${diagnostic.message} ${diagnostic.sourcePath ?? ''}`.toLowerCase().includes(needle)).slice(0, limit)
      })
    },
    list,
    interactions: interactionsApi,
    checkComponent: target => {
      const matches = collectComponents(target, 50)
      const exact = matches.find(row => row.target === target) ?? matches[0] ?? null
      return (exact != null ? ok : fail)(exact != null ? `Found component ${String(exact.target)}.` : `No component matched ${target}.`, {
        component: exact,
        matches,
        interactionStats: { ...context.cockpitInteractionStats }
      })
    },
    checkMaterial: (target, options = {}) => {
      const object = findObject(target)
      if (object == null) {
        return fail(`No scene object matched ${target}.`, {
          target,
          matches: collectNodes(target, 25),
          materials: collectMaterials(target, 25)
        })
      }
      return ok(`Checked materials for ${object.name || object.type}.`, {
        target,
        ...summarizeMaterialObject(object, options)
      })
    },
    checkGauge: (key, options = {}) => {
      const gauge = resolveGauge(key, {
        surface: options.surface,
        source: options.source
      })
      if (gauge == null) return fail('No VCockpit gauge matched.', { key, gauges: gauges().map(summarizeGauge) })
      const canvas = gauge.captureImage ?? gauge.staticCaptureImage
      return ok(`Checked gauge ${gauge.gaugeKey}.`, {
        gauge: summarizeGauge(gauge),
        screenshot: options.screenshot === true && canvas != null ? canvasDataUrl(canvas) : null
      })
    },
    inspectWasm: async (key, options = {}) => {
      const gauge = resolveGauge(key, {
        surface: options.surface,
        source: options.source
      })
      if (gauge == null) {
        return fail('No VCockpit gauge matched.', { key, gauges: gauges().map(summarizeGauge) })
      }

      const wasmModuleUrl = getWasmModuleUrl(gauge)
      if (wasmModuleUrl == null) {
        return fail('Matched gauge is not a bridge-backed WASM gauge.', summarizeGauge(gauge))
      }

      const maxBytes = Math.max(
        1,
        Math.min(100 * 1024 * 1024, Math.floor(options.maxBytes ?? 25 * 1024 * 1024))
      )
      try {
        const response = await fetch(wasmModuleUrl)
        if (!response.ok) {
          const info = storeWasmModuleInfo({
            url: wasmModuleUrl,
            status: 'fetch-error',
            byteLength: 0,
            imports: [],
            exports: [],
            error: `${response.status} ${response.statusText}`.trim(),
            inspectedAt: new Date().toISOString()
          })
          return fail('Failed to fetch WASM module.', {
            key: gauge.gaugeKey,
            source: gauge.source,
            wasmModuleUrl,
            status: response.status,
            statusText: response.statusText,
            wasmModuleInfo: info
          })
        }

        const contentLength = Number(response.headers.get('content-length') ?? NaN)
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          const info = storeWasmModuleInfo({
            url: wasmModuleUrl,
            status: 'too-large',
            byteLength: contentLength,
            imports: [],
            exports: [],
            error: `Module byte length ${contentLength} exceeds maxBytes ${maxBytes}.`,
            inspectedAt: new Date().toISOString()
          })
          return fail('WASM module exceeds inspectWasm maxBytes.', {
            key: gauge.gaugeKey,
            source: gauge.source,
            wasmModuleUrl,
            byteLength: contentLength,
            maxBytes,
            wasmModuleInfo: info
          })
        }

        const bytes = await response.arrayBuffer()
        if (bytes.byteLength > maxBytes) {
          const info = storeWasmModuleInfo({
            url: wasmModuleUrl,
            status: 'too-large',
            byteLength: bytes.byteLength,
            imports: [],
            exports: [],
            error: `Module byte length ${bytes.byteLength} exceeds maxBytes ${maxBytes}.`,
            inspectedAt: new Date().toISOString()
          })
          return fail('WASM module exceeds inspectWasm maxBytes.', {
            key: gauge.gaugeKey,
            source: gauge.source,
            wasmModuleUrl,
            byteLength: bytes.byteLength,
            maxBytes,
            wasmModuleInfo: info
          })
        }

        const module = await WebAssembly.compile(bytes)
        const imports = WebAssembly.Module.imports(module).map(entry => ({
          module: entry.module,
          name: entry.name,
          kind: entry.kind
        }))
        const exports = WebAssembly.Module.exports(module).map(entry => ({
          name: entry.name,
          kind: entry.kind
        }))
        const info = storeWasmModuleInfo({
          url: wasmModuleUrl,
          status: 'compiled',
          byteLength: bytes.byteLength,
          imports,
          exports,
          error: null,
          inspectedAt: new Date().toISOString()
        })

        return ok('Inspected resolved WASM module without instantiating native MSFS ABI.', {
          key: gauge.gaugeKey,
          surface: gauge.surface,
          source: gauge.source,
          wasmModuleUrl,
          byteLength: bytes.byteLength,
          imports,
          exports,
          wasmModuleInfo: info,
          nativeAbiExecuted: false
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        const info = storeWasmModuleInfo({
          url: wasmModuleUrl,
          status: 'inspect-error',
          byteLength: 0,
          imports: [],
          exports: [],
          error: errorMessage,
          inspectedAt: new Date().toISOString()
        })
        return fail('Failed to inspect WASM module.', {
          key: gauge.gaugeKey,
          source: gauge.source,
          wasmModuleUrl,
          error: errorMessage,
          wasmModuleInfo: info
        })
      }
    },
    checkParam: names => {
      const requested = Array.isArray(names) ? names : [names]
      return ok('Checked runtime parameters.', requested.map(name => createDevApiParamCheck(name, context.getRuntimeHost())), [
        'Plane physics state is not wired into this viewer loop; plane source is unavailable in v1.'
      ])
    },
    setParam: (name, value, unit = null) => {
      const mapping = resolveDevApiParamMapping(name, unit)
      return api.writeVar(mapping.simVar, value, mapping.unit)
    },
    diagnostics: (options = {}) => {
      const report = collectDiagnosticsReport(options)
      const counts = report.counts as Record<string, number>
      const gaugeDiagnostics = report.gaugeDiagnostics as readonly unknown[]
      return ok(
        `Collected diagnostics: ${counts.error ?? 0} error, ${counts.warning ?? 0} warning, ${counts.info ?? 0} info, ${gaugeDiagnostics.length} gauge issue group(s).`,
        report
      )
    },
    readVar: (name, unit = null) => ok(`Read ${name}.`, { name, unit, value: context.getRuntimeHost().readVariable(name, unit) }),
    writeVar: (name, value, unit = null) => {
      context.getRuntimeHost().writeVariable(name, value, unit)
      return ok(`Wrote ${name}.`, { name, unit, value: context.getRuntimeHost().readVariable(name, unit) })
    },
    readState: key => {
      const state = context.getRuntimeHost().simulatorEngine.state
      return ok(`Read canonical state ${key}.`, {
        key,
        entry: state.getEntry(key) ?? null,
        definition: state.getDefinition(key) ?? null,
      })
    },
    writeState: (key, value, unit = null) => {
      const state = context.getRuntimeHost().simulatorEngine.state
      const parsedUnit = parseDevApiStateUnit(unit)
      const definition = state.getDefinition(key)

      if (unit != null && unit.trim() !== '' && parsedUnit == null) {
        return fail(`Unknown canonical state unit "${unit}".`, {
          key,
          unit,
          allowedUnits: [...DEV_API_STATE_UNITS],
        })
      }

      try {
        state.set(key, value, {
          source: 'runtime',
          unit: parsedUnit ?? definition?.unit,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return fail(`Failed to write canonical state ${key}.`, {
          key,
          value,
          unit,
          error: message,
          definition: definition ?? null,
        })
      }

      return ok(`Wrote canonical state ${key}.`, {
        key,
        value,
        unit: parsedUnit ?? definition?.unit ?? null,
        entry: state.getEntry(key) ?? null,
        definition: state.getDefinition(key) ?? null,
      })
    },
    dispatchCommand: (type, payload = undefined) => {
      if (type.trim() === '') {
        return fail('Command type is required.', { type, payload })
      }

      const knownCommand = listCanonicalEngineCommands().find(
        (entry) => entry.type === type
      )
      if (knownCommand == null) {
        return fail(`Unknown engine command ${type}.`, {
          type,
          payload,
          knownCommands: listCanonicalEngineCommands().map((entry) => entry.type),
        })
      }

      const engine = context.getRuntimeHost().simulatorEngine
      const command: SimCommand = {
        type,
        payload,
        source: 'devapi',
      }
      const dispatch = engine.dispatch(command)

      return ok(`Dispatched engine command ${type}.`, {
        command,
        dispatch,
        diagnosticsCount: engine.diagnostics.length,
      })
    },
    keyEvent: (name, args = []) => {
      context.getRuntimeHost().invokeKeyEvent(name, args)
      return ok(`Invoked key event ${name}.`, { name, args, recent: context.getRuntimeHost().getKeyEvents().at(-1) ?? null })
    },
    bridgeCall: (name, args = [1]) => {
      context.getRuntimeHost().invokeBridgeCall(name, args)
      return ok(`Invoked bridge call ${name}.`, {
        name,
        args,
        stats: context.getRuntimeHost().getStats(),
        value: context.getRuntimeHost().readVariable(`B:${name}`)
      })
    },
    events: (options = {}) => {
      const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)))
      const recent = <T>(events: readonly T[]): readonly T[] => events.slice(-limit)
      return ok('Collected recent runtime events.', {
        key: options.kind == null || options.kind === 'key' ? recent(context.getRuntimeHost().getKeyEvents()) : [],
        html: options.kind == null || options.kind === 'html' ? recent(context.getRuntimeHost().getHtmlEvents()) : [],
        sound: options.kind == null || options.kind === 'sound' ? recent(context.getRuntimeHost().getSoundEvents()) : [],
        effect: options.kind == null || options.kind === 'effect' ? recent(context.getRuntimeHost().getEffectEvents()) : [],
        bridge: options.kind == null || options.kind === 'bridge' ? recent(context.getRuntimeHost().getBridgeEvents()) : [],
        interaction: options.kind == null || options.kind === 'interaction' ? { ...context.cockpitInteractionStats } : null
      })
    },
    watch: async (targets, options = {}) => {
      const names = Array.isArray(targets) ? targets : [targets]
      const durationMs = Math.max(0, Math.min(60_000, Math.floor(options.durationMs ?? 1_000)))
      const intervalMs = Math.max(16, Math.min(5_000, Math.floor(options.intervalMs ?? 100)))
      const started = performance.now()
      const samples: Record<string, unknown>[] = []
      do {
        samples.push({
          elapsedMs: performance.now() - started,
          values: Object.fromEntries(names.map(name => [name, context.getRuntimeHost().readVariable(name, options.unit ?? null)]))
        })
        await sleep(intervalMs)
      } while (performance.now() - started < durationMs)
      return ok('Collected watch samples.', { targets: names, samples })
    },
    waitFor: async (condition, timeoutMs = 10_000) => {
      const waitKind = getDevApiWaitConditionKind(condition)
      if (!isKnownDevApiWaitConditionKind(waitKind)) {
        return fail(`Unknown wait condition "${waitKind ?? ''}".`, {
          condition,
          supportedKinds: DEV_API_WAIT_CONDITION_KINDS
        })
      }
      const started = performance.now()
      const state: DevApiWaitEvaluationState = {}
      while (performance.now() - started < timeoutMs) {
        if (evaluateDevApiWaitCondition(condition, api, context, state)) return ok('Wait condition satisfied.', { condition, elapsedMs: performance.now() - started })
        await sleep(50)
      }
      return fail('Timed out waiting for condition.', {
        condition,
        timeoutMs,
        elapsedMs: performance.now() - started,
        lastObserved: getDevApiWaitLastObserved(condition, context),
        status: statusData()
      })
    },
    perf: () => ok('Collected performance summary.', {
      fps: context.getFpsSnapshot(),
      rendererInfo: { memory: { ...context.renderer.info.memory }, render: { ...context.renderer.info.render } },
      runtimeHost: context.getRuntimeHost().getStats(),
      cockpitPerf: context.getCockpitPerfDiagnostics().getSummary(),
      activeInterior: context.getCockpitPerfDiagnostics().getActiveInteriorStats(),
      panelSurfaces: context.getCockpitPerfDiagnostics().getPanelSurfaceStats()
    }),
    assetCache: {
      snapshot: () => ok('Collected package asset cache diagnostics.', getDevApiAssetCacheSnapshot()),
      refreshPackageVersions: async () => ok(
        'Refreshed package asset versions.',
        await refreshDevApiPackageVersions(),
        ['Reload the viewer if changedRoots is non-empty so compiled behavior state is rebuilt.']
      ),
      clearDdsRanges: async () => {
        await clearAircraftRangeCache()
        return ok('Cleared cached DDS byte ranges.', getDevApiAssetCacheSnapshot())
      }
    },
    bench: {
      startup: () => ok('Collected startup benchmark.', getStartupBenchmarkData()),
      cockpitLod0: async (options = {}) => {
        const state = context.getCockpitBenchmarkState()
        if (state.cockpitCameraAvailable !== true) {
          return fail('Cockpit LOD0 benchmark is unavailable because the selected aircraft has no cockpit camera.', state)
        }
        if (state.benchmarkRunning === true) {
          return fail('Cockpit LOD0 benchmark is already running.', state)
        }

        try {
          const result = await context.runCockpitBenchmark({
            targetInteriorLodIndex: 0,
            forceCold: true
          })
          const data =
            options.includeEvents === false
              ? stripCockpitBenchmarkEvents(result)
              : result
          return ok('Collected cockpit LOD0 load benchmark.', data)
        } catch (error) {
          return fail('Cockpit LOD0 benchmark failed.', {
            state: context.getCockpitBenchmarkState(),
            error: error instanceof Error ? error.message : String(error)
          })
        }
      },
      all: async (options = {}) => {
        const started = performance.now()
        const startup = api.bench.startup()
        const cockpitLod0 = await api.bench.cockpitLod0(options)
        const now = new Date()
        const localTimestamp = createLocalBenchTimestamp(now)
        const commit = await getDevApiGitMetadata()
        const data = {
          createdAt: now.toISOString(),
          ...localTimestamp,
          commit,
          elapsedMs: Number((performance.now() - started).toFixed(1)),
          startup: startup.data,
          cockpitLod0: cockpitLod0.data,
          results: {
            startup: {
              ok: startup.ok,
              summary: startup.summary,
              warnings: startup.warnings ?? []
            },
            cockpitLod0: {
              ok: cockpitLod0.ok,
              summary: cockpitLod0.summary,
              warnings: cockpitLod0.warnings ?? []
            }
          }
        }
        const allOk = startup.ok && cockpitLod0.ok
        const summary = allOk
            ? 'Collected all performance benchmarks.'
            : 'One or more performance benchmarks failed.'
        const stored = storeBenchRun({
          id: `${now.toISOString()}-${Math.random().toString(36).slice(2, 10)}`,
          kind: 'all',
          createdAt: now.toISOString(),
          ...localTimestamp,
          commit,
          ok: allOk,
          summary,
          data
        })

        return (allOk ? ok : fail)(summary, {
          ...data,
          stored: {
            key: DEV_API_BENCH_HISTORY_KEY,
            id: stored.id,
            count: readBenchHistory().length
          }
        })
      },
      history: (options = {}) => {
        const limit = Math.max(1, Math.min(DEV_API_BENCH_HISTORY_LIMIT, Math.floor(options.limit ?? DEV_API_BENCH_HISTORY_LIMIT)))
        return ok('Collected stored benchmark history.', {
          storageKey: DEV_API_BENCH_HISTORY_KEY,
          entries: readBenchHistory().slice(-limit)
        })
      },
      clearHistory: () => {
        clearBenchHistory()
        return ok('Cleared stored benchmark history.', {
          storageKey: DEV_API_BENCH_HISTORY_KEY
        })
      }
    },
    screenshot: (options = {}) => {
      if (options.target === 'gauge') {
        const gauge = resolveGauge(options.key)
        const canvas = gauge?.captureImage ?? gauge?.staticCaptureImage ?? null
        return canvas == null
          ? fail('Gauge screenshot is unavailable.', { key: options.key, gauge: gauge == null ? null : summarizeGauge(gauge) })
          : ok('Captured gauge screenshot.', { key: gauge?.gaugeKey ?? null, dataUrl: canvasDataUrl(canvas) })
      }
      return ok('Captured viewport screenshot.', {
        dataUrl: canvasDataUrl(context.renderer.domElement),
        width: context.renderer.domElement.width,
        height: context.renderer.domElement.height
      })
    },
    visualCheck: target => {
      const screenshot = target == null ? api.screenshot() : api.screenshot({ target: 'gauge', key: target })
      const data = screenshot.data as { readonly dataUrl?: unknown; readonly width?: unknown; readonly height?: unknown }
      const dataUrl = typeof data.dataUrl === 'string' ? data.dataUrl : null
      return (screenshot.ok && dataUrl != null ? ok : fail)(
        screenshot.ok && dataUrl != null ? 'Visual target produced a screenshot.' : 'Visual target did not produce a screenshot.',
        { target: target ?? 'viewport', hasImage: dataUrl != null, dataUrlLength: dataUrl?.length ?? 0, width: data.width ?? null, height: data.height ?? null }
      )
    },
    highlight: (target, options = {}) => {
      if (highlightGroup != null) {
        context.scene.remove(highlightGroup)
        highlightGroup.clear()
      }
      const object = findObject(target)
      if (object == null) return fail(`No scene object matched ${target}.`, { target, matches: collectNodes(target, 25) })
      object.updateWorldMatrix(true, true)
      const box = new Box3().setFromObject(object)
      if (box.isEmpty()) return fail(`Object ${target} has no highlightable bounds.`, { target, object: object.name || object.type })
      highlightGroup = new Group()
      highlightGroup.name = 'dev-api-highlight'
      highlightGroup.add(new Box3Helper(box, 0x38d973))
      context.scene.add(highlightGroup)
      const durationMs = Math.max(0, Math.min(60_000, Math.floor(options.durationMs ?? 4_000)))
      if (durationMs > 0) {
        window.setTimeout(() => {
          if (highlightGroup != null) {
            context.scene.remove(highlightGroup)
            highlightGroup.clear()
            highlightGroup = null
          }
        }, durationMs)
      }
      return ok(`Highlighted ${object.name || object.type}.`, { target, object: object.name || object.type, bounds: { min: box.min.toArray(), max: box.max.toArray() } })
    },
    camera: {
      enterCockpit: async () => {
        const controller = context.getCockpitCameraController()
        if (!controller.isAvailable()) return fail('Cockpit camera is unavailable for this aircraft.', statusData())
        controller.enter('keyboard')
        await sleep(0)
        return ok('Entered cockpit view.', api.camera.getPose().data)
      },
      exitCockpit: () => {
        context.getCockpitCameraController().exit('keyboard')
        return ok('Exited cockpit view.', api.camera.getPose().data)
      },
      getPose: () => ok('Collected camera pose.', {
        position: context.camera.position.toArray(),
        quaternion: context.camera.quaternion.toArray(),
        target: context.controls.target.toArray(),
        cockpitActive: context.getCockpitCameraController().isActive()
      }),
      setPose: pose => {
        if (pose.position != null && pose.position.length >= 3) context.camera.position.fromArray([...pose.position] as number[])
        if (pose.target != null && pose.target.length >= 3) context.controls.target.fromArray([...pose.target] as number[])
        context.camera.lookAt(context.controls.target)
        context.controls.update()
        return ok('Updated camera pose.', api.camera.getPose().data)
      },
      frame: target => {
        const object = findObject(target)
        if (object == null) return fail(`No scene object matched ${target}.`, { target, matches: collectNodes(target, 25) })
        object.updateWorldMatrix(true, true)
        const bounds = new Box3().setFromObject(object)
        const center = bounds.getCenter(new Vector3())
        const size = bounds.getSize(new Vector3())
        const radius = Math.max(size.x, size.y, size.z, 1)
        context.camera.near = 0.1
        context.camera.far = Math.max(5000, radius * 40)
        context.camera.position.copy(center).add(new Vector3(radius * 1.2, radius * 0.35, radius * 1.05))
        context.camera.lookAt(center)
        context.camera.updateProjectionMatrix()
        context.controls.target.copy(center)
        context.controls.update()
        return ok(`Framed ${object.name || object.type}.`, api.camera.getPose().data)
      }
    },
    settings: {
      get: () => ok('Collected viewer settings.', context.getSettingsSnapshot()),
      set: async settings => ok(await context.applySettings(settings) ?? 'Updated viewer settings.', {
        requested: settings,
        effective: context.getSettingsSnapshot()
      })
    }
  }
  const consoleApi = wrapDevApiForConsole(api, error =>
    fail('DevApi call failed.', {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null
    })
  )
  window.__DevApi = consoleApi
  ;(globalThis as Record<string, unknown>).__DevApi = consoleApi
}

function wrapDevApiForConsole<T>(
  value: T,
  createErrorResponse: (error: unknown) => DevApiResponse
): T {
  return wrapDevApiValueForConsole(value, '__DevApi', createErrorResponse, new WeakMap()) as T
}

function wrapDevApiValueForConsole(
  value: unknown,
  path: string,
  createErrorResponse: (error: unknown) => DevApiResponse,
  seen: WeakMap<object, unknown>
): unknown {
  if (typeof value === 'function') {
    return (...args: unknown[]) => {
      try {
        const result = value(...args)
        if (isPromiseLike(result)) {
          return result
            .then((response: unknown) => {
              logDevApiResponse(path, response)
              return response
            })
            .catch((error: unknown) => {
              const response = createErrorResponse(error)
              logDevApiResponse(path, response)
              return response
            })
        }
        logDevApiResponse(path, result)
        return result
      } catch (error) {
        const response = createErrorResponse(error)
        logDevApiResponse(path, response)
        return response
      }
    }
  }
  if (typeof value !== 'object' || value == null) {
    return value
  }
  const cached = seen.get(value)
  if (cached != null) {
    return cached
  }
  const wrapped: Record<string, unknown> = {}
  seen.set(value, wrapped)
  for (const [key, child] of Object.entries(value)) {
    wrapped[key] = wrapDevApiValueForConsole(
      child,
      `${path}.${key}`,
      createErrorResponse,
      seen
    )
  }
  return wrapped
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' &&
    value != null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
}

function logDevApiResponse(path: string, response: unknown): void {
  if (!isDevApiResponse(response)) {
    console.info(`[DevApi] ${path} returned a non-response value.`, response)
    return
  }
  const method = response.ok ? console.info : console.warn
  method(`[DevApi] ${path}: ${response.summary}`, response)
}

function isDevApiResponse(value: unknown): value is DevApiResponse {
  if (typeof value !== 'object' || value == null) {
    return false
  }
  const candidate = value as { readonly ok?: unknown; readonly summary?: unknown; readonly data?: unknown }
  return typeof candidate.ok === 'boolean' &&
    typeof candidate.summary === 'string' &&
    'data' in candidate
}

function createDevApiParamCheck(
  name: string,
  runtimeHost: SharedMsfsRuntimeHost
): Record<string, unknown> {
  const mapping = resolveDevApiParamMapping(name)
  const simValue = runtimeHost.readVariable(mapping.simVar, mapping.unit)
  return {
    name,
    preset: mapping.preset,
    unit: mapping.unit,
    plane: { available: false, value: null, source: null },
    sim: {
      available: true,
      variable: mapping.simVar,
      value: simValue,
      longitude: mapping.preset === 'location' || mapping.preset === 'position'
        ? runtimeHost.readVariable('A:GPS POSITION LON', 'degrees')
        : undefined,
      altitude: mapping.preset === 'location' || mapping.preset === 'position'
        ? runtimeHost.readVariable('A:PLANE ALTITUDE', 'feet')
        : undefined,
      source: 'SharedMsfsRuntimeHost'
    },
    delta: null,
    sources: { plane: 'unavailable', sim: 'runtime-host' }
  }
}

function resolveDevApiParamMapping(
  name: string,
  unit: string | null = null
): { readonly preset: string; readonly simVar: string; readonly unit: string | null } {
  const preset = name.trim().toLowerCase().replace(/[\s_-]+/gu, '')
  if (preset === 'vspeed' || preset === 'verticalspeed') {
    return { preset, simVar: 'A:VERTICAL SPEED', unit: 'feet per minute' }
  }
  if (preset === 'alt' || preset === 'altitude') {
    return { preset, simVar: 'A:PLANE ALTITUDE', unit: 'feet' }
  }
  if (preset === 'pressure' || preset === 'baro' || preset === 'barometricpressure') {
    return { preset, simVar: 'A:AMBIENT PRESSURE', unit: 'inHg' }
  }
  if (preset === 'location' || preset === 'position') {
    return { preset, simVar: 'A:GPS POSITION LAT', unit: 'degrees' }
  }
  if (preset === 'gear' || preset === 'gearhandle' || preset === 'landinggear') {
    return { preset, simVar: 'A:GEAR HANDLE POSITION', unit: null }
  }
  if (preset === 'flap' || preset === 'flaps' || preset === 'flapshandle') {
    return { preset, simVar: 'A:FLAPS HANDLE PERCENT', unit: unit ?? 'percent' }
  }
  if (preset === 'spoiler' || preset === 'spoilers' || preset === 'speedbrake' || preset === 'speedbrakes') {
    return { preset, simVar: 'A:SPOILERS HANDLE POSITION', unit: unit ?? 'percent' }
  }
  if (preset === 'parkingbrake' || preset === 'parkbrake') {
    return { preset, simVar: 'A:BRAKE PARKING POSITION', unit: null }
  }
  if (preset === 'battery' || preset === 'batteryswitch' || preset === 'masterbattery') {
    return { preset, simVar: 'A:BATTERY SWITCH', unit: null }
  }
  if (preset === 'externalpower' || preset === 'externalpowerswitch' || preset === 'extpower') {
    return { preset, simVar: 'A:EXTERNAL POWER ON', unit: null }
  }
  if (preset === 'avionics' || preset === 'avionicsswitch' || preset === 'avionicsmaster') {
    return { preset, simVar: 'A:AVIONICS MASTER SWITCH', unit: null }
  }
  return { preset, simVar: name, unit }
}

function finiteNumberOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function dedupeDiagnostics(diagnostics: readonly ImportDiagnostic[]): ImportDiagnostic[] {
  const seen = new Set<string>()
  const deduped: ImportDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.sourcePath ?? '',
      diagnostic.message
    ].join('\0')
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(diagnostic)
  }
  return deduped
}

function evaluateDevApiWaitCondition(
  condition: DevApiWaitCondition,
  api: ViewerDevApi,
  context: ViewerDevApiContext,
  state: DevApiWaitEvaluationState
): boolean {
  const kind = getDevApiWaitConditionKind(condition)
  const options = typeof condition === 'string' ? {} : condition
  switch (kind) {
    case 'viewerReady': case 'ready':
      const viewerStatus = api.status()
      const stage = viewerStatus.ok ? viewerStatus.data.loadStage?.stage : null
      return typeof stage === 'string' && stage !== 'init:error'
    case 'cockpitReady': case 'cockpitActive':
      return context.getCockpitCameraController().isActive()
    case 'gaugesLoaded': case 'gaugesReady':
      const gaugeStatus = api.status()
      if (!gaugeStatus.ok) return false
      const total = gaugeStatus.data.counts?.gauges ?? 0
      const loaded = gaugeStatus.data.counts?.loadedGauges ?? 0
      const captured = gaugeStatus.data.counts?.capturedGauges ?? 0
      const gaugeList = api.list({ kind: 'gauges', limit: 5_000 })
      if (!gaugeList.ok) return false
      const gaugeRows = gaugeList.data
      const isCapturableGauge = (gauge: DevApiGaugeSummary): boolean =>
        gauge.captured ||
        gauge.hasCaptureImage ||
        gauge.textureName.toUpperCase() !== 'NO_TEXTURE'
      const capturableTotal = gaugeRows.filter(isCapturableGauge).length
      const capturableCaptured = gaugeRows.filter(
        gauge => isCapturableGauge(gauge) && gauge.captured === true
      ).length
      const requestedMinimum = options.minimum
      const minimum =
        requestedMinimum == null
          ? total
          : Math.max(0, Math.min(total, Math.floor(requestedMinimum)))
      const capturedMinimum =
        requestedMinimum == null
          ? capturableTotal
          : Math.max(0, Math.min(capturableTotal, Math.floor(requestedMinimum)))
      const capturesRequired =
        kind === 'gaugesReady' &&
        options.captured !== false
      return total > 0 && loaded >= minimum && (!capturesRequired || (captured >= capturedMinimum && capturableCaptured >= capturedMinimum))
    case 'gaugeCaptured':
      const gaugeTarget = options.target
      const gaugeCheck = api.checkGauge(gaugeTarget)
      return gaugeCheck.ok && gaugeCheck.data.gauge.captured
    case 'componentAvailable':
      const componentTarget = options.target ?? ''
      return api.checkComponent(componentTarget).ok
    case 'varEquals': case 'varAbove': case 'varBelow':
      if (options.var == null) return false
      const variableValue = context.getRuntimeHost().readVariable(options.var, options.unit ?? null)
      return (
        (options.equals != null && Math.abs(variableValue - options.equals) < 1e-6) ||
        (options.above != null && variableValue > options.above) ||
        (options.below != null && variableValue < options.below)
      )
    case 'noNewErrors':
      const errorStatus = api.status()
      return errorStatus.ok && errorStatus.data.diagnostics?.error === 0
    case 'event':
      return evaluateDevApiEventWaitCondition(condition, context)
    case 'varChanged':
      return evaluateDevApiVarChangedCondition(condition, context, state)
    case 'interactionExecuted':
      return evaluateDevApiInteractionExecutedCondition(condition, context, state)
    default:
      return false
  }
}

function evaluateDevApiEventWaitCondition(
  condition: DevApiWaitCondition,
  context: ViewerDevApiContext
): boolean {
  if (typeof condition === 'string' || !isDevApiEventWaitKind(condition.eventKind)) return false
  return getDevApiRuntimeEvents(condition.eventKind, context).some(event =>
    matchesDevApiEventFilter(event, condition)
  )
}

function evaluateDevApiVarChangedCondition(
  condition: DevApiWaitCondition,
  context: ViewerDevApiContext,
  state: DevApiWaitEvaluationState
): boolean {
  if (typeof condition === 'string' || condition.var == null) return false
  const current = context.getRuntimeHost().readVariable(condition.var, condition.unit ?? null)
  const baseline = condition.from ?? state.varChangedBaseline
  if (baseline == null) {
    state.varChangedBaseline = current
    return false
  }
  const epsilon = Math.max(0, condition.epsilon ?? 1e-6)
  return Math.abs(current - baseline) > epsilon
}

function evaluateDevApiInteractionExecutedCondition(
  condition: DevApiWaitCondition,
  context: ViewerDevApiContext,
  state: DevApiWaitEvaluationState
): boolean {
  if (typeof condition === 'string') return false
  const current = context.getRuntime().getInteractionExecutionCount()
  const baseline = condition.sequenceAbove ?? state.interactionExecutionBaseline
  if (baseline == null) {
    state.interactionExecutionBaseline = current
    return false
  }
  const minimum = Math.max(1, Math.floor(condition.minimum ?? 1))
  const targetMatches = condition.target == null || context.cockpitInteractionStats.lastTarget === condition.target
  return targetMatches && current - baseline >= minimum
}

function getDevApiWaitLastObserved(
  condition: DevApiWaitCondition,
  context: ViewerDevApiContext
): unknown {
  const kind = getDevApiWaitConditionKind(condition)
  if (kind === 'event' && typeof condition !== 'string' && isDevApiEventWaitKind(condition.eventKind)) {
    return {
      eventKind: condition.eventKind,
      recent: getDevApiRuntimeEvents(condition.eventKind, context).slice(-5)
    }
  }
  if (kind === 'varChanged' && typeof condition !== 'string' && condition.var != null) {
    return {
      var: condition.var,
      unit: condition.unit ?? null,
      value: context.getRuntimeHost().readVariable(condition.var, condition.unit ?? null)
    }
  }
  if (kind === 'interactionExecuted') {
    return {
      executionCount: context.getRuntime().getInteractionExecutionCount(),
      interactionStats: { ...context.cockpitInteractionStats }
    }
  }
  return null
}

function getDevApiRuntimeEvents(
  eventKind: DevApiEventWaitKind,
  context: ViewerDevApiContext
): readonly DevApiRuntimeEvent[] {
  if (eventKind === 'key') return context.getRuntimeHost().getKeyEvents()
  if (eventKind === 'html') return context.getRuntimeHost().getHtmlEvents()
  if (eventKind === 'sound') return context.getRuntimeHost().getSoundEvents()
  if (eventKind === 'effect') return context.getRuntimeHost().getEffectEvents()
  return context.getRuntimeHost().getBridgeEvents()
}

function matchesDevApiEventFilter(
  event: DevApiRuntimeEvent,
  condition: Exclude<DevApiWaitCondition, string>
): boolean {
  if (condition.sequenceAbove != null && event.sequence <= condition.sequenceAbove) return false
  if (condition.name != null && !matchesDevApiTextFilter(event.name, condition.name)) return false
  if (condition.target != null && (!hasStringProperty(event, 'target') || !matchesDevApiTextFilter(event.target, condition.target))) return false
  if (condition.phase != null && (!hasStringProperty(event, 'phase') || !matchesDevApiTextFilter(event.phase, condition.phase))) return false
  if (condition.action != null && (!hasStringProperty(event, 'action') || !matchesDevApiTextFilter(event.action, condition.action))) return false
  if (condition.direction != null && (!hasStringProperty(event, 'direction') || !matchesDevApiTextFilter(event.direction, condition.direction))) return false
  if (condition.handledByBinding != null && (!hasBooleanProperty(event, 'handledByBinding') || event.handledByBinding !== condition.handledByBinding)) return false
  return true
}

function matchesDevApiTextFilter(value: string, filter: string): boolean {
  return value.trim().toLowerCase() === filter.trim().toLowerCase()
}

function hasStringProperty<T extends string>(
  value: DevApiRuntimeEvent,
  property: T
): value is DevApiRuntimeEvent & Record<T, string> {
  return typeof (value as unknown as Record<string, unknown>)[property] === 'string'
}

function hasBooleanProperty<T extends string>(
  value: DevApiRuntimeEvent,
  property: T
): value is DevApiRuntimeEvent & Record<T, boolean> {
  return typeof (value as unknown as Record<string, unknown>)[property] === 'boolean'
}

const DEV_API_WAIT_CONDITION_KINDS = [
  'viewerReady',
  'ready',
  'cockpitReady',
  'cockpitActive',
  'gaugesLoaded',
  'gaugesReady',
  'gaugeCaptured',
  'componentAvailable',
  'varEquals',
  'varAbove',
  'varBelow',
  'noNewErrors',
  'event',
  'varChanged',
  'interactionExecuted'
] as const

function getDevApiWaitConditionKind(condition: DevApiWaitCondition): string | undefined {
  return typeof condition === 'string' ? condition : condition.kind
}

function canonicalizeDevApiNodeAnimationName(name: string): string | null {
  const normalizedName = name.trim().toUpperCase()
  if (!normalizedName) return null

  if (normalizedName.includes('WING') && normalizedName.includes('BONE')) {
    const side = normalizedName.includes('LEFT') ? 'left'
      : normalizedName.includes('RIGHT') ? 'right'
      : null
    if (side == null) return null
    const indexMatch =
      normalizedName.match(/WING[_ ]*BONE(?:[_ ]*(?:LEFT|RIGHT))?[_ ]*0*([0-9]+)/u) ??
      normalizedName.match(/WING[_ ]*BONE[_ ]*0*([0-9]+)(?:[_ ]*(?:LEFT|RIGHT))?/u)
    const index = Number.parseInt(indexMatch?.[1] ?? '', 10)
    return `wingBone:${side}:${Number.isFinite(index) && index > 0 ? index : 1}`
  }

  if (normalizedName.includes('ENGINE') && normalizedName.includes('PIVOT')) {
    const side = normalizedName.includes('LEFT') ? 'left'
      : normalizedName.includes('RIGHT') ? 'right'
      : null
    if (side == null) return null
    const allNumbers = [...normalizedName.matchAll(/([0-9]+)/gu)].map(match => Number.parseInt(match[1] ?? '', 10))
    const index = allNumbers.at(-1) ?? 1
    return `enginePivot:${side}:${Number.isFinite(index) && index > 0 ? index : 1}`
  }

  return null
}

function isKnownDevApiWaitConditionKind(kind: string | undefined): boolean {
  return kind != null && DEV_API_WAIT_CONDITION_KINDS.includes(kind as (typeof DEV_API_WAIT_CONDITION_KINDS)[number])
}

function isDevApiEventWaitKind(kind: unknown): kind is DevApiEventWaitKind {
  return kind === 'key' || kind === 'html' || kind === 'sound' || kind === 'effect' || kind === 'bridge'
}
