import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Box3Helper,
  CanvasTexture,
  Clock,
  Color,
  DirectionalLight,
  Euler,
  Group,
  HemisphereLight,
  LinearFilter,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PropertyBinding,
  Raycaster,
  Scene,
  SkinnedMesh,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  VideoTexture,
  type AnimationClip
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { compileMsfs2020Behaviors } from './msfs/behavior'
import { normalizeAsoboPrimitiveBaseVertex } from './msfs/gltf/normalizeAsoboPrimitiveBaseVertex'
import { createMsfsGltfLoader } from './msfs/gltf/createMsfsGltfLoader'
import { getMsfsGltfLoadingManagerStats } from './msfs/gltf/createMsfsGltfLoader'
import type { MSFSDDSLoadOptions } from './msfs/gltf/MSFSDDSLoader'
import { normalizeAsoboPrimitiveWinding } from './msfs/gltf/normalizeAsoboPrimitiveWinding'
import { normalizeMsfsMaterials } from './msfs/gltf/normalizeMsfsMaterials'
import { usesBlendGBufferMaterial, usesGeoDecalFrostedMaterial } from './msfs/gltf/normalizeMsfsMaterials'
import { normalizeMsfsNormalsTangents } from './msfs/gltf/normalizeMsfsNormalsTangents'
import { normalizeMsfsSkinning } from './msfs/gltf/normalizeMsfsSkinning'
import { normalizeMsfsTexcoords } from './msfs/gltf/normalizeMsfsTexcoords'
import { normalizeMsfsVertexColors } from './msfs/gltf/normalizeMsfsVertexColors'
import { repairMsfsSkinnedAttributes } from './msfs/gltf/repairMsfsSkinnedAttributes'
import { sanitizeMsfsGltf } from './msfs/gltf/sanitizeMsfsGltf'
import { importBuiltMsfs2020Package } from './msfs/importer'
import { normalizeSurfaceLookupName, parseVCockpitSurfaces } from './msfs/panel'
import type { VCockpitGaugeEntry, VCockpitSurface } from './msfs/panel'
import { AircraftRuntime, type RuntimeUpdateProfile, SharedMsfsRuntimeHost } from './msfs/runtime'
import { installViewerBootDevApi, installViewerDevApi } from './devApi'
import type {
  CompiledBehaviorSet,
  CompiledInteractionBlocker,
  ImportedAircraft,
  ImportedCfgSection,
  ImportDiagnostic,
  ModelLodEntry,
  RuntimeState
} from './msfs/types'
import type { CompiledInteractionBinding } from './msfs/types'
import type { ImportedModelDefinition } from './msfs/types'
import {
  createAircraftEnvironment,
  createAppRenderer,
  createNodeMaterialFactory,
  getRendererPixelRatio,
  type AppRenderer,
  type NodeMaterialFactory,
  type RendererInfo
} from './rendering/createAppRenderer'
import { createMsfsRenderPasses } from './rendering/createMsfsRenderPasses'
import { queueTask } from './worker/pool'

const DEFAULT_PACKAGE_ROOT = '/tmp/headwindsim-aircraft-a330-900/'
const DEFAULT_STOCK_BEHAVIOR_ROOT = '/vendor/msfs-stock/'
const DEV_DEFAULT_PACKAGE_ROOT = '/aircrafts/headwindsim-aircraft-a330-900/'
const DEV_DEFAULT_AIRCRAFT_ID = 'SimObjects/Airplanes/_Headwind_A330neo-LIVERY#fltsim.0'
const DEFAULT_COCKPIT_RANGE_TEXTURE_SIZE = 1024
const DEFAULT_BACKGROUND_COCKPIT_RANGE_TEXTURE_SIZE = 512
type AssetRoot = {
  readonly rootUrl: string
  readonly layoutPathIndex: ReadonlyMap<string, string>
}

type AircraftSelectorOption = {
  readonly packageRoot: string
  readonly packageName: string
  readonly aircraft: ImportedAircraft
}

async function seedSyncedGaugeSettings(
  packageRootUrl: string,
  layoutEntries: readonly { readonly path: string }[],
  runtimeHost: SharedMsfsRuntimeHost
): Promise<void> {
  const packageRoot = new URL(packageRootUrl, window.location.href)
  const candidates = layoutEntries
    .map(entry => entry.path)
    .filter(path => {
      const normalizedPath = path.toLowerCase()
      return (
        normalizedPath.endsWith('.js') &&
        (
          normalizedPath.includes('/efb/') ||
          normalizedPath.includes('/settings/') ||
          normalizedPath.endsWith('/settingssync.js')
        )
      )
    })

  await Promise.all(
    candidates.map(async path => {
      try {
        const response = await fetch(new URL(path, packageRoot))
        if (!response.ok) {
          return
        }
        const source = await response.text()
        const storagePrefix =
          /NXDataStore\.aircraftProjectPrefix\s*=\s*"([^"]+)"/u.exec(source)?.[1]?.toUpperCase() ??
          null

        for (const block of source.split('configKey:').slice(1)) {
          const setting = block.slice(0, 2500)
          const configKey = /^\s*"([^"]+)"/u.exec(setting)?.[1]
          const localVarName = /localVarName:\s*"([^"]+)"/u.exec(setting)?.[1]
          const defaultValue = /defaultValue:\s*"([^"]*)"/u.exec(setting)?.[1]
          if (configKey == null || localVarName == null || defaultValue == null) {
            continue
          }

          const storageKey = storagePrefix == null ? configKey : `${storagePrefix}_${configKey}`
          const storedValue = window.localStorage.getItem(storageKey)
          if (storedValue == null || storedValue.length === 0) {
            continue
          }
          const rawValue = storedValue.trim().toLowerCase()
          const value =
            rawValue === 'true' ? 1 : rawValue === 'false' ? 0 : Number.parseInt(rawValue, 10)
          if (Number.isFinite(value)) {
            runtimeHost.seedVariable(localVarName, value)
          }
        }
      } catch {
        // Gauge startup still applies these settings; this only prevents a visible first-frame default.
      }
    })
  )
}

export type LoadedModelComponent = {
  readonly kind: 'exterior' | 'interior'
  readonly modelDefinition: ImportedModelDefinition
  readonly scene: Group
  readonly animations: GLTF['animations']
  readonly loadedLodIndex: number
  readonly loadDiagnostics: ModelLoadDiagnostics
  readonly resourceStats: ModelResourceStats | null
  readonly vcockpitBinding: VCockpitSurfaceBindingResult | null
}

export type LoadedAircraftModel = {
  readonly scene: Group
  readonly animations: GLTF['animations']
  readonly exterior: LoadedModelComponent
  readonly interior: LoadedModelComponent | null
}

type AircraftModelLoadContext = {
  readonly aircraft: ImportedAircraft
  readonly createLoader: (options?: {
    readonly textureLoadOptions?: MSFSDDSLoadOptions
  }) => GLTFLoader
  readonly createNodeMaterial: NodeMaterialFactory | null
  readonly resolvePanelAssetUrl: (source: string) => string | null
}

type ModelLoadPhase = {
  readonly label: string
  readonly startMs: number
  readonly endMs: number
  readonly durationMs: number
  readonly details: Record<string, unknown> | null
}

type ModelLoadDiagnostics = {
  readonly phases: readonly ModelLoadPhase[]
  readonly totalDurationMs: number
}

type PreparedMsfsGltfLodWorkerPhase = {
  readonly label: string
  readonly durationMs: number
  readonly details: Record<string, unknown> | null
}

type PreparedMsfsGltfLodWorkerBuffer = {
  readonly index: number
  readonly buffer: ArrayBuffer
  readonly byteLength: number
}

type PreparedMsfsGltfLodWorkerResult = {
  readonly gltfJson: Record<string, unknown>
  readonly buffers: readonly PreparedMsfsGltfLodWorkerBuffer[]
  readonly phases: readonly PreparedMsfsGltfLodWorkerPhase[]
}

type ModelResourceStats = {
  readonly geometryCount: number
  readonly materialCount: number
  readonly textureCount: number
  readonly geometryAttributeBytes: number
  readonly geometryIndexBytes: number
  readonly textureKnownBytes: number
  readonly textureEstimatedBytes: number
  readonly totalKnownBytes: number
  readonly totalEstimatedBytes: number
}

export type CockpitCameraController = {
  readonly isAvailable: () => boolean
  readonly dispose: () => void
  readonly isActive: () => boolean
  readonly update: () => void
  readonly enter: (source?: CockpitViewToggleSource) => void
  readonly exit: (source?: CockpitViewToggleSource) => void
}

type CockpitViewToggleSource = 'keyboard' | 'benchmark'
type VCockpitGaugeMode = 'texture' | 'overlay' | 'video'
type VCockpitGaugeModeRequest = VCockpitGaugeMode | 'htmlTexture'
type ExteriorInteriorMode = 'deferred' | 'sync' | 'off'
type CockpitTextureMode = 'range-low' | 'full'

export type ViewerConfigProfile = {
  readonly packageRoot?: string
  readonly aircraftId?: string
  readonly lod?: number | null
  readonly interiorLod?: number | null
  readonly exteriorInteriorMode?: ExteriorInteriorMode
  readonly exteriorInteriorLod?: number | null
  readonly vcockpitSurfaces?: boolean
  readonly vcockpitLiveGauges?: boolean
  readonly vcockpitGaugeMode?: VCockpitGaugeMode
  readonly vcockpitGaugeCaptureFps?: number | null
  readonly vcockpitGaugeRasterScale?: number | null
  readonly vcockpitGaugeUpdateOutside?: boolean
  readonly cockpitTextures?: CockpitTextureMode
  readonly cockpitTextureSize?: number | null
  readonly cockpitMergeStatic?: boolean
  readonly cockpitInstanceStatic?: boolean
  readonly cockpitPerf?: boolean
  readonly cockpitInteractionHitboxes?: boolean
  readonly skipGaugeSettingSeed?: boolean
  readonly rendererPixelRatio?: number | null
  readonly rawQuery?: string
}

type ViewerConfigStore = {
  readonly version: 1
  readonly global: ViewerConfigProfile
  readonly aircraft: Record<string, ViewerConfigProfile>
}

type ViewerSettingsPanelScope = 'global' | 'aircraft'

type ViewerSettingsApplyEvent = {
  readonly scope: ViewerSettingsPanelScope
  readonly action: 'apply' | 'reset'
  readonly selectedPackageRoot: string
  readonly selectedAircraftId: string
}

type ViewerRuntimeSettingsSnapshot = {
  readonly exteriorLod: number | null
  readonly interiorLod: number | null
  readonly exteriorInteriorMode: ExteriorInteriorMode
  readonly exteriorInteriorLod: number | null
  readonly vcockpitSurfaces: boolean
  readonly vcockpitLiveGauges: boolean
  readonly vcockpitGaugeMode: VCockpitGaugeModeRequest
  readonly vcockpitGaugeCaptureFps: number
  readonly vcockpitGaugeRasterScale: number
  readonly vcockpitGaugeUpdateOutside: boolean
  readonly cockpitTextures: CockpitTextureMode
  readonly cockpitTextureSize: number | null
  readonly cockpitMergeStatic: boolean
  readonly cockpitInstanceStatic: boolean
  readonly cockpitPerf: boolean
  readonly cockpitInteractionHitboxes: boolean
  readonly skipGaugeSettingSeed: boolean
  readonly rendererPixelRatio: number
  readonly extraQuery: string
}

export type FpsCounterSnapshot = {
  readonly fps: number
  readonly averageFrameMs: number
  readonly lowFps: number
  readonly sampleCount: number
}

type FpsCounter = {
  readonly recordFrame: (deltaSeconds: number) => void
  readonly getSnapshot: () => FpsCounterSnapshot
}

async function init(): Promise<void> {
  setGlobalLoadStage({ stage: 'init:start' })
  installViewerBootDevApi()
  const backgroundColor = new Color('#405264')
  const searchParams = new URLSearchParams(window.location.search)
  const configStore = loadViewerConfigStore()
  const initialSearchParams = createEffectiveViewerSearchParams(
    searchParams,
    configStore.global,
    null
  )
  const discoveredPackageRoots = await discoverAircraftPackageRoots()
  const additionalPackageRoots = resolveAdditionalPackageRoots(initialSearchParams)
  const additionalAssetRoots = await loadConfiguredAssetRoots(additionalPackageRoots)
  const requestedAircraftId = initialSearchParams.get('aircraft')
  const packageRoot = await resolveRequestedPackageRoot(
    initialSearchParams,
    discoveredPackageRoots,
    requestedAircraftId,
    additionalPackageRoots
  )
  setGlobalLoadStage({ stage: 'import:package', packageRoot })
  const packageData = await importBuiltMsfs2020Package(packageRoot, {
    additionalPackageRoots,
    requestedAircraftId
  })
  const aircraft = selectAircraft(
    packageData.aircraft,
    requestedAircraftId
  )
  ;(globalThis as Record<string, unknown>).__lastImportedPackage = packageData
  ;(globalThis as Record<string, unknown>).__lastSelectedAircraft = aircraft
  if (aircraft == null || aircraft.model == null) {
    if (requestedAircraftId != null) {
      const availableAircraft = packageData.aircraft
        .map(candidate => candidate.id)
        .sort()
      throw new Error(
        [
          `Requested aircraft "${requestedAircraftId}" was not found in package root ${packageRoot}.`,
          availableAircraft.length > 0
            ? `Available aircraft IDs:\n- ${availableAircraft.join('\n- ')}`
            : 'The selected package does not contain any importable aircraft models.'
        ].join('\n\n')
      )
    }

    throw new Error('No importable aircraft model was found in the configured package.')
  }

  const aircraftConfigProfile =
    configStore.aircraft[getViewerAircraftConfigKey(packageRoot, aircraft.id)] ?? null
  let effectiveSearchParams = createEffectiveViewerSearchParams(
    searchParams,
    configStore.global,
    aircraftConfigProfile
  )
  let requestedLodIndex = resolveRequestedLodIndex(effectiveSearchParams)
  let requestedInteriorLodIndex = resolveRequestedInteriorLodIndex(effectiveSearchParams)
  let requestedExteriorInteriorLodIndex =
    resolveRequestedExteriorInteriorLodIndex(effectiveSearchParams)
  let exteriorInteriorMode = getExteriorInteriorMode(effectiveSearchParams)
  const syncExteriorInterior = exteriorInteriorMode === 'sync'

  const scene = new Scene()
  const deferInteriorBehaviors = !syncExteriorInterior && aircraft.interiorModel != null

  setGlobalLoadStage({ stage: 'compile:behaviors', aircraftId: aircraft.id })
  const compiledBehaviorsPromise = compileMsfs2020Behaviors(packageData, aircraft, {
    additionalPackageRoots,
    includeInteriorModel: !deferInteriorBehaviors
  })

  setGlobalLoadStage({ stage: 'renderer:create', aircraftId: aircraft.id })
  const rendererInfo = await createAppRenderer(effectiveSearchParams)
  const { renderer } = rendererInfo
  renderer.setClearColor(backgroundColor, 1)
  const aircraftEnvironment = createAircraftEnvironment(renderer)
  scene.environment = aircraftEnvironment.texture
  document.body.appendChild(renderer.domElement)

  const camera = new PerspectiveCamera(
    42,
    window.innerWidth / window.innerHeight,
    0.1,
    5000
  )
  camera.position.set(40, 20, 40)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.target.set(0, 4, 0)
  ;(globalThis as Record<string, unknown>).__lastRenderer = renderer
  ;(globalThis as Record<string, unknown>).__lastCamera = camera
  ;(globalThis as Record<string, unknown>).__lastControls = controls

  const ambientLight = new AmbientLight('#ffffff', 0.18)
  const fallbackSkyLight = aircraftEnvironment.usedFallback
    ? new HemisphereLight('#d6e5f5', '#405264', 0.55)
    : null
  const keyLight = new DirectionalLight('#fff1d5', 2.35)
  keyLight.position.set(34, 9, 18)
  const fillLight = new DirectionalLight('#b9d5ff', 0.28)
  fillLight.position.set(-22, 16, -28)
  const rimLight = new DirectionalLight('#d7e6ff', 0.95)
  rimLight.position.set(-30, 18, 24)
  scene.add(ambientLight, keyLight, fillLight, rimLight)
  if (fallbackSkyLight != null) {
    scene.add(fallbackSkyLight)
  }

  const overlay = createOverlay()
  document.body.appendChild(overlay)
  const selectedPackageSelectorOptions = createPackageAircraftSelectorOptions(
    packageData,
    packageRoot
  )
  const selector = createAircraftSelector(selectedPackageSelectorOptions, packageRoot, aircraft)
  if (selector != null) {
    document.body.appendChild(selector)
  }
  let handleViewerSettingsApplied:
    | ((event: ViewerSettingsApplyEvent) => Promise<string | null>)
    | null = null
  let settingsPanel = createSettingsPanel({
    selectorOptions: selectedPackageSelectorOptions,
    packageRoot,
    aircraft,
    configStore,
    effectiveSearchParams,
    onApply: event => handleViewerSettingsApplied?.(event) ?? null
  })
  document.body.appendChild(settingsPanel)

  const aircraftModelLoadContext = createAircraftModelLoadContext(
    aircraft,
    packageData.rootUrl,
    packageData.layoutEntries.map(entry => entry.path),
    additionalAssetRoots,
    rendererInfo
  )
  setGlobalLoadStage({ stage: 'gltf:load', aircraftId: aircraft.id })
  const runtimeHost = new SharedMsfsRuntimeHost([], aircraft)
  ;(globalThis as Record<string, unknown>).__lastRuntimeHost = runtimeHost
  const syncedSettingSeedPromise = shouldSkipGaugeSettingSeed(effectiveSearchParams)
    ? Promise.resolve()
    : seedSyncedGaugeSettings(packageData.rootUrl, packageData.layoutEntries, runtimeHost)
  const gltfPromise = loadAircraftGltf(aircraftModelLoadContext, {
    preferredLodIndex: requestedLodIndex,
    loadExteriorInterior: syncExteriorInterior,
    exteriorInteriorPreferredLodIndex: requestedExteriorInteriorLodIndex,
    bindVCockpitSurfaces: shouldBindVCockpitSurfaces(effectiveSearchParams),
    liveVCockpitGauges: shouldLiveRefreshVCockpitGauges(effectiveSearchParams),
    vcockpitGaugeMode: getVCockpitGaugeMode(effectiveSearchParams),
    vcockpitGaugeVideoFps: getVCockpitGaugeVideoFps(effectiveSearchParams),
    vcockpitGaugeCaptureFps: getVCockpitGaugeCaptureFps(effectiveSearchParams),
    vcockpitGaugeRasterScale: getVCockpitGaugeRasterScale(effectiveSearchParams),
    debugVCockpitGauges: shouldDebugVCockpitGauges(effectiveSearchParams),
    runtimeHost
  })
  const [initialCompiledBehaviors, gltf] = await Promise.all([
    compiledBehaviorsPromise,
    gltfPromise,
    syncedSettingSeedPromise
  ])
  let compiledBehaviors = initialCompiledBehaviors
  ;(globalThis as Record<string, unknown>).__lastCompiledBehaviors = compiledBehaviors
  setGlobalLoadStage({ stage: 'gltf:loaded', aircraftId: aircraft.id })
  ;(globalThis as Record<string, unknown>).__lastLoadedGltf = gltf
  let loadedModel = gltf
  const aircraftRoot = new Group()
  aircraftRoot.add(loadedModel.scene)
  scene.add(aircraftRoot)
  ;(globalThis as Record<string, unknown>).__lastAircraftRoot = aircraftRoot
  ;(globalThis as Record<string, unknown>).__lastScene = scene

  setGlobalLoadStage({ stage: 'scene:ready', aircraftId: aircraft.id })
  centerObjectAtOrigin(aircraftRoot)
  fitCameraToObject(camera, controls, aircraftRoot, aircraft)
  const renderPasses = createMsfsRenderPasses(renderer, scene, camera, aircraftRoot)
  const cameraDepthClipController = createCameraDepthClipController(camera, aircraftRoot)
  cameraDepthClipController.update()
  ;(globalThis as Record<string, unknown>).__lastCameraDepthClipController =
    cameraDepthClipController
  void loadAircraftSelectorOptions(
    discoveredPackageRoots,
    packageData,
    packageRoot,
    additionalPackageRoots
  )
    .then(selectorOptions => {
      const nextSelector = createAircraftSelector(selectorOptions, packageRoot, aircraft)
      if (nextSelector == null) {
        selector?.remove()
        return
      }

      selector?.replaceWith(nextSelector)
      if (selector == null) {
        document.body.appendChild(nextSelector)
      }
      const nextSettingsPanel = createSettingsPanel({
        selectorOptions,
        packageRoot,
        aircraft,
        configStore: loadViewerConfigStore(),
        effectiveSearchParams,
        onApply: event => handleViewerSettingsApplied?.(event) ?? null
      })
      settingsPanel.replaceWith(nextSettingsPanel)
      settingsPanel = nextSettingsPanel
    })
    .catch(error => {
      console.warn('Failed to populate aircraft selector options.', error)
    })

  let runtime = new AircraftRuntime(compiledBehaviors, loadedModel.scene, runtimeHost, aircraft)
  let runtimeMaterialState = collectRuntimeMaterialState(loadedModel.scene)
  runtime.bindAnimations(loadedModel.animations)
  let lastRuntimeModelRevision = runtime.getModelRevision()
  ;(globalThis as Record<string, unknown>).__lastAircraftRuntime = runtime
  const cockpitInteractionStats = {
    attemptCount: 0,
    hitCount: 0,
    executedCount: 0,
    lastTarget: null as string | null,
    activeHeldTarget: null as string | null,
    lastHitObject: null as string | null,
    lastHitKind: null as 'interaction-mesh' | 'fallback-hitbox' | 'blocker' | null,
    lastMissReason: null as string | null,
    interactionTargetCount: runtime.getInteractionBindings().length,
    interactionHitVolumeCount: 0,
    interactionPickableMeshCount: 0,
    interactionMappedBindingCount: 0,
    interactionFallbackHitboxCount: 0,
    interactionOccluderMeshCount: 0,
    lastOccluderObject: null as string | null
  }
  ;(globalThis as Record<string, unknown>).__lastCockpitInteractionStats = cockpitInteractionStats
  type CockpitBenchmarkMemorySample = {
    readonly usedJSHeapSize: number | null
    readonly totalJSHeapSize: number | null
    readonly jsHeapSizeLimit: number | null
    readonly userAgentSpecificBytes: number | null
    readonly userAgentSpecificError: string | null
    readonly rendererTextures: number | null
    readonly rendererGeometries: number | null
  }

  type CockpitBenchmarkEvent = {
    readonly label: string
    readonly nowMs: number
    readonly wallTimeMs: number
    readonly loadStage: string | null
    readonly loadStageTimestampMs: number | null
    readonly interiorLodIndex: number | null
    readonly cockpitViewActive: boolean
    readonly details: Record<string, unknown> | null
    readonly memory: CockpitBenchmarkMemorySample | null
  }

  type CockpitBenchmarkPhaseResult = {
    readonly status: 'measured' | 'skipped'
    readonly reason: string | null
    readonly toggleToLoadStartMs: number | null
    readonly toggleToComponentLoadedMs: number | null
    readonly toggleToSwapCompleteMs: number | null
    readonly toggleToActiveInteriorMs: number | null
    readonly toggleToVisualReadyMs: number | null
    readonly memoryBefore: CockpitBenchmarkMemorySample | null
    readonly memoryAfter: CockpitBenchmarkMemorySample | null
    readonly usedJSHeapDelta: number | null
    readonly userAgentSpecificBytesDelta: number | null
  }

  type CockpitBenchmarkRunResult = {
    readonly aircraftId: string
    readonly createdAt: string
    readonly cold: CockpitBenchmarkPhaseResult
    readonly cachedExterior: CockpitBenchmarkPhaseResult
    readonly warm: CockpitBenchmarkPhaseResult
    readonly events: readonly CockpitBenchmarkEvent[]
  }

  type PerformanceWithMemory = Performance & {
    readonly memory?: {
      readonly usedJSHeapSize: number
      readonly totalJSHeapSize: number
      readonly jsHeapSizeLimit: number
    }
    readonly measureUserAgentSpecificMemory?: () => Promise<{ readonly bytes: number }>
  }

  let activeCockpitBenchmarkEvents: CockpitBenchmarkEvent[] | null = null
  let lastCockpitBenchmarkResult: CockpitBenchmarkRunResult | null = null

  const getCockpitBenchmarkLoadStage = (): {
    readonly stage: string | null
    readonly timestampMs: number | null
  } => {
    const loadStage = (globalThis as Record<string, unknown>).__msfsLoadStage
    if (loadStage == null || typeof loadStage !== 'object') {
      return { stage: null, timestampMs: null }
    }

    const record = loadStage as Record<string, unknown>
    return {
      stage: typeof record.stage === 'string' ? record.stage : null,
      timestampMs: typeof record.timestamp === 'number' ? record.timestamp : null
    }
  }

  const collectCockpitBenchmarkMemory = async (): Promise<CockpitBenchmarkMemorySample> => {
    const performanceWithMemory = performance as PerformanceWithMemory
    const heap = performanceWithMemory.memory
    let userAgentSpecificBytes: number | null = null
    let userAgentSpecificError: string | null = null

    if (typeof performanceWithMemory.measureUserAgentSpecificMemory === 'function') {
      try {
        const userAgentSpecificMemory =
          await performanceWithMemory.measureUserAgentSpecificMemory()
        userAgentSpecificBytes = userAgentSpecificMemory.bytes
      } catch (error) {
        userAgentSpecificError = error instanceof Error ? error.message : String(error)
      }
    }

    return {
      usedJSHeapSize: heap?.usedJSHeapSize ?? null,
      totalJSHeapSize: heap?.totalJSHeapSize ?? null,
      jsHeapSizeLimit: heap?.jsHeapSizeLimit ?? null,
      userAgentSpecificBytes,
      userAgentSpecificError,
      rendererTextures: renderer.info.memory.textures ?? null,
      rendererGeometries: renderer.info.memory.geometries ?? null
    }
  }

  const pushCockpitBenchmarkEvent = (
    label: string,
    details: Record<string, unknown> | null = null,
    memory: CockpitBenchmarkMemorySample | null = null
  ): CockpitBenchmarkEvent | null => {
    if (activeCockpitBenchmarkEvents == null) {
      return null
    }

    const loadStage = getCockpitBenchmarkLoadStage()
    const event: CockpitBenchmarkEvent = {
      label,
      nowMs: performance.now(),
      wallTimeMs: Date.now(),
      loadStage: loadStage.stage,
      loadStageTimestampMs: loadStage.timestampMs,
      interiorLodIndex: loadedModel.interior?.loadedLodIndex ?? null,
      cockpitViewActive: cockpitCameraController.isActive(),
      details,
      memory
    }
    activeCockpitBenchmarkEvents.push(event)
    return event
  }

  const recordCockpitBenchmarkEvent = (
    label: string,
    details: Record<string, unknown> | null = null
  ): void => {
    pushCockpitBenchmarkEvent(label, details)
  }

  const captureCockpitBenchmarkSnapshot = async (
    label: string,
    details: Record<string, unknown> | null = null
  ): Promise<CockpitBenchmarkEvent | null> => {
    return pushCockpitBenchmarkEvent(
      label,
      details,
      await collectCockpitBenchmarkMemory()
    )
  }

  const waitForAnimationFrames = async (frameCount: number): Promise<void> => {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => resolve())
      })
    }
  }

  const waitForCockpitBenchmarkCondition = async (
    predicate: () => boolean,
    timeoutMs: number,
    description: string
  ): Promise<void> => {
    const startedAt = performance.now()
    while (performance.now() - startedAt < timeoutMs) {
      if (predicate()) {
        return
      }
      await new Promise(resolve => window.setTimeout(resolve, 16))
    }

    throw new Error(`Timed out waiting for ${description}.`)
  }

  const findCockpitBenchmarkEvent = (
    events: readonly CockpitBenchmarkEvent[],
    label: string,
    minNowMs: number
  ): CockpitBenchmarkEvent | null => {
    return events.find(event => event.label === label && event.nowMs >= minNowMs) ?? null
  }

  const toCockpitBenchmarkDelta = (
    startEvent: CockpitBenchmarkEvent | null,
    endEvent: CockpitBenchmarkEvent | null
  ): number | null => {
    return startEvent != null && endEvent != null
      ? Number((endEvent.nowMs - startEvent.nowMs).toFixed(1))
      : null
  }

  const toCockpitBenchmarkMemoryDelta = (
    before: CockpitBenchmarkMemorySample | null,
    after: CockpitBenchmarkMemorySample | null,
    key: 'usedJSHeapSize' | 'userAgentSpecificBytes'
  ): number | null => {
    const beforeValue = before?.[key]
    const afterValue = after?.[key]
    return typeof beforeValue === 'number' && typeof afterValue === 'number'
      ? afterValue - beforeValue
      : null
  }

  const summarizeCockpitBenchmarkPhase = (
    events: readonly CockpitBenchmarkEvent[],
    options: {
      readonly startLabel: string
      readonly beforeLabel: string
      readonly afterLabel: string
      readonly visualReadyLabel?: string
      readonly loadStartLabel?: string
      readonly componentLoadedLabel?: string
      readonly swapCompleteLabel?: string
      readonly activeInteriorLabel?: string
      readonly skipReason?: string | null
    }
  ): CockpitBenchmarkPhaseResult => {
    const beforeEvent = events.find(event => event.label === options.beforeLabel) ?? null
    const startEvent =
      beforeEvent != null
        ? findCockpitBenchmarkEvent(events, options.startLabel, beforeEvent.nowMs)
        : null
    const afterEvent =
      startEvent != null
        ? findCockpitBenchmarkEvent(events, options.afterLabel, startEvent.nowMs)
        : null

    if (startEvent == null || beforeEvent == null || afterEvent == null) {
      return {
        status: 'skipped',
        reason: options.skipReason ?? 'Required benchmark events were not recorded.',
        toggleToLoadStartMs: null,
        toggleToComponentLoadedMs: null,
        toggleToSwapCompleteMs: null,
        toggleToActiveInteriorMs: null,
        toggleToVisualReadyMs: null,
        memoryBefore: beforeEvent?.memory ?? null,
        memoryAfter: afterEvent?.memory ?? null,
        usedJSHeapDelta: toCockpitBenchmarkMemoryDelta(
          beforeEvent?.memory ?? null,
          afterEvent?.memory ?? null,
          'usedJSHeapSize'
        ),
        userAgentSpecificBytesDelta: toCockpitBenchmarkMemoryDelta(
          beforeEvent?.memory ?? null,
          afterEvent?.memory ?? null,
          'userAgentSpecificBytes'
        )
      }
    }

    return {
      status: 'measured',
      reason: null,
      toggleToLoadStartMs: toCockpitBenchmarkDelta(
        startEvent,
        options.loadStartLabel != null
          ? findCockpitBenchmarkEvent(events, options.loadStartLabel, startEvent.nowMs)
          : null
      ),
      toggleToComponentLoadedMs: toCockpitBenchmarkDelta(
        startEvent,
        options.componentLoadedLabel != null
          ? findCockpitBenchmarkEvent(events, options.componentLoadedLabel, startEvent.nowMs)
          : null
      ),
      toggleToSwapCompleteMs: toCockpitBenchmarkDelta(
        startEvent,
        options.swapCompleteLabel != null
          ? findCockpitBenchmarkEvent(events, options.swapCompleteLabel, startEvent.nowMs)
          : null
      ),
      toggleToActiveInteriorMs: toCockpitBenchmarkDelta(
        startEvent,
        options.activeInteriorLabel != null
          ? findCockpitBenchmarkEvent(events, options.activeInteriorLabel, startEvent.nowMs)
          : null
      ),
      toggleToVisualReadyMs: toCockpitBenchmarkDelta(
        startEvent,
        options.visualReadyLabel != null
          ? findCockpitBenchmarkEvent(events, options.visualReadyLabel, startEvent.nowMs)
          : afterEvent
      ),
      memoryBefore: beforeEvent.memory,
      memoryAfter: afterEvent.memory,
      usedJSHeapDelta: toCockpitBenchmarkMemoryDelta(
        beforeEvent.memory,
        afterEvent.memory,
        'usedJSHeapSize'
      ),
      userAgentSpecificBytesDelta: toCockpitBenchmarkMemoryDelta(
        beforeEvent.memory,
        afterEvent.memory,
        'userAgentSpecificBytes'
      )
    }
  }

  const rebuildRuntimeForLoadedModel = (): void => {
    runtime.dispose()
    runtime = new AircraftRuntime(compiledBehaviors, loadedModel.scene, runtimeHost, aircraft)
    runtime.bindAnimations(loadedModel.animations)
    ;(globalThis as Record<string, unknown>).__lastAircraftRuntime = runtime
    cockpitInteractionStats.interactionTargetCount = runtime.getInteractionBindings().length
    cockpitInteractionPickRegistryCache = null
    syncCockpitInteractionHitboxHelpers()
    runtimeMaterialState = collectRuntimeMaterialState(loadedModel.scene)
    runtimeState = runtime.update(0)
    lastRuntimeModelRevision = runtime.getModelRevision()
    cameraDepthClipController.markModelChanged()
    ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
  }

  let fullCompiledBehaviorsPromise: Promise<CompiledBehaviorSet> | null = null
  let hasFullCompiledBehaviors = !deferInteriorBehaviors
  const ensureFullCompiledBehaviors = (): Promise<CompiledBehaviorSet> => {
    if (hasFullCompiledBehaviors) {
      return Promise.resolve(compiledBehaviors)
    }
    if (fullCompiledBehaviorsPromise != null) {
      return fullCompiledBehaviorsPromise
    }

    setGlobalLoadStage({
      stage: 'compile:behaviors:full:start',
      aircraftId: aircraft.id
    })
    fullCompiledBehaviorsPromise = compileMsfs2020Behaviors(packageData, aircraft, {
      additionalPackageRoots,
      includeInteriorModel: true
    })
      .then(nextCompiledBehaviors => {
        compiledBehaviors = nextCompiledBehaviors
        hasFullCompiledBehaviors = true
        ;(globalThis as Record<string, unknown>).__lastCompiledBehaviors =
          compiledBehaviors
        rebuildRuntimeForLoadedModel()
        setGlobalLoadStage({
          stage: 'compile:behaviors:full:ready',
          aircraftId: aircraft.id
        })
        return compiledBehaviors
      })
      .catch(error => {
        setGlobalLoadStage({
          stage: 'compile:behaviors:full:error',
          aircraftId: aircraft.id,
          error: error instanceof Error ? error.message : String(error)
        })
        throw error
      })
      .finally(() => {
        fullCompiledBehaviorsPromise = null
      })

    return fullCompiledBehaviorsPromise
  }

  const setActiveInteriorComponent = (nextInterior: LoadedModelComponent | null): void => {
    const currentInterior = loadedModel.interior
    if (currentInterior === nextInterior) {
      return
    }

    const swapPhases: ModelLoadPhase[] = []
    const recordSwapPhase = (
      label: string,
      startMs: number,
      details: Record<string, unknown> | null = null
    ): void => {
      const endMs = performance.now()
      swapPhases.push({
        label,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        details
      })
    }

    const sceneSwapStartMs = performance.now()
    if (currentInterior != null) {
      currentInterior.vcockpitBinding?.setActive(false)
      loadedModel.scene.remove(currentInterior.scene)
    }
    if (nextInterior != null && nextInterior.scene.parent !== loadedModel.scene) {
      loadedModel.scene.add(nextInterior.scene)
    }
    if (nextInterior != null) {
      nextInterior.vcockpitBinding?.setActive(shouldUpdateVCockpitGaugesForCurrentView())
    }
    recordSwapPhase('interior-swap:scene-graph', sceneSwapStartMs)

    loadedModel = replaceLoadedAircraftInterior(loadedModel, nextInterior)
    ;(globalThis as Record<string, unknown>).__lastLoadedGltf = loadedModel
    cameraDepthClipController.markModelChanged()
    const runtimeRebuildStartMs = performance.now()
    rebuildRuntimeForLoadedModel()
    recordSwapPhase('interior-swap:runtime-rebuild', runtimeRebuildStartMs)
    const renderPassRefreshStartMs = performance.now()
    renderPasses.refresh()
    recordSwapPhase('interior-swap:render-pass-refresh', renderPassRefreshStartMs)
    if (cockpitCameraController.isActive()) {
      refreshCockpitCameraClipPlanes()
    }
    clock.getDelta()
    recordCockpitBenchmarkEvent('cockpit:interior:swap-complete', {
      loadedLodIndex: nextInterior?.loadedLodIndex ?? null,
      swapPhases
    })
    markCockpitPerfFrames('interior-swap', 12)
  }

  const shouldUpdateVCockpitGaugesForCurrentView = (): boolean =>
    cockpitCameraController.isActive() || shouldUpdateVCockpitGaugesOutside(effectiveSearchParams)
  let cockpitCameraClipPlanes: CameraClipPlanes = {
    near: COCKPIT_CAMERA_CLIP_NEAR,
    far: COCKPIT_CAMERA_DEFAULT_CLIP_FAR
  }
  const refreshCockpitCameraClipPlanes = (): void => {
    cockpitCameraClipPlanes = {
      near: COCKPIT_CAMERA_CLIP_NEAR,
      far:
        loadedModel.interior == null
          ? COCKPIT_CAMERA_DEFAULT_CLIP_FAR
          : computeCockpitCameraFarPlane(camera, loadedModel.interior.scene)
    }
  }

  let exteriorViewInterior = loadedModel.interior
  let exteriorViewInteriorLoadPromise: Promise<LoadedModelComponent | null> | null = null
  const getCockpitInteriorPreferredLodIndex = (): number | null => {
    const interiorModel = aircraft.interiorModel
    if (interiorModel == null || interiorModel.lods.length === 0) {
      return null
    }

    if (
      requestedInteriorLodIndex == null &&
      aircraft.model?.modelOptions.withInteriorForceFirstLod === true
    ) {
      return 0
    }

    if (requestedInteriorLodIndex == null) {
      return selectAutoCockpitInteriorLodIndex(interiorModel)
    }

    return Math.min(
      Math.max(requestedInteriorLodIndex, 0),
      interiorModel.lods.length - 1
    )
  }
  let cachedCockpitInterior: LoadedModelComponent | null =
    loadedModel.interior?.loadedLodIndex === getCockpitInteriorPreferredLodIndex()
      ? loadedModel.interior
      : null
  const rendererWarmedInteriorComponents = new WeakSet<LoadedModelComponent>()
  const warmInteriorRendererResources = async (
    interior: LoadedModelComponent,
    label: string
  ): Promise<Record<string, unknown> | null> => {
    if (rendererWarmedInteriorComponents.has(interior)) {
      return {
        skipped: 'already-warmed'
      }
    }

    const compileAsync = getRendererCompileAsync(renderer)
    if (compileAsync == null) {
      return {
        skipped: 'unsupported-renderer'
      }
    }

    const startMs = performance.now()
    markCockpitPerfFrames(`${label}:renderer-warm`, 12)

    try {
      await compileAsync(interior.scene, camera, scene)
      rendererWarmedInteriorComponents.add(interior)
      return {
        durationMs: performance.now() - startMs
      }
    } catch (error) {
      console.warn('Failed to warm interior renderer resources.', error)
      return {
        durationMs: performance.now() - startMs,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
  let shouldUseCockpitInterior = false
  let hasRequestedCockpitInterior = false
  let interiorLodUpgradePromise: Promise<void> | null = null
  const shouldLoadExteriorViewInterior = (): boolean => {
    return (
      exteriorInteriorMode !== 'off' &&
      aircraft.interiorModel != null &&
      aircraft.model?.modelOptions.withExteriorShowInterior === true
    )
  }

  const canUseExteriorViewInteriorMeshForCockpit = (): boolean => {
    return (
      !isEnabledFlagSearchParam(effectiveSearchParams, 'cockpitInstanceStatic') &&
      !isEnabledFlagSearchParam(effectiveSearchParams, 'cockpitMergeStatic')
    )
  }

  const canReuseExteriorViewInteriorForCockpit = (
    interior: LoadedModelComponent
  ): boolean =>
    interior.loadedLodIndex === getCockpitInteriorPreferredLodIndex() &&
    canUseExteriorViewInteriorMeshForCockpit()

  const showExteriorViewInteriorCockpitFallback = (
    interior: LoadedModelComponent
  ): void => {
    if (
      !shouldUseCockpitInterior ||
      cachedCockpitInterior != null ||
      !canUseExteriorViewInteriorMeshForCockpit()
    ) {
      return
    }

    recordCockpitBenchmarkEvent('cockpit:interior-upgrade:exterior-fallback', {
      loadedLodIndex: interior.loadedLodIndex,
      preferredLodIndex: getCockpitInteriorPreferredLodIndex()
    })
    interior.scene.visible = true
    if (loadedModel.interior === interior) {
      if (interior.scene.parent !== loadedModel.scene) {
        loadedModel.scene.add(interior.scene)
      }
      interior.vcockpitBinding?.setActive(shouldUpdateVCockpitGaugesForCurrentView())
      cameraDepthClipController.markModelChanged()
      renderPasses.refresh()
      return
    }

    setActiveInteriorComponent(interior)
  }

  let exteriorViewInteriorCockpitPromotionPromise:
    | Promise<LoadedModelComponent | null>
    | null = null
  const prepareExteriorViewInteriorForCockpit =
    async (): Promise<LoadedModelComponent | null> => {
      if (exteriorViewInteriorCockpitPromotionPromise != null) {
        return exteriorViewInteriorCockpitPromotionPromise
      }

      exteriorViewInteriorCockpitPromotionPromise = (async () => {
        const candidate =
          exteriorViewInterior ??
          (
            exteriorViewInteriorLoadPromise != null
              ? await exteriorViewInteriorLoadPromise
              : null
          )
        if (candidate == null || !canReuseExteriorViewInteriorForCockpit(candidate)) {
          return null
        }

        if (
          candidate.vcockpitBinding != null ||
          !shouldBindVCockpitSurfaces(effectiveSearchParams)
        ) {
          return candidate
        }

        const vcockpitBinding = await bindVCockpitPlaceholderSurfaces(
          candidate.scene,
          aircraft,
          aircraftModelLoadContext.resolvePanelAssetUrl,
          shouldLiveRefreshVCockpitGauges(effectiveSearchParams),
          getVCockpitGaugeMode(effectiveSearchParams),
          getVCockpitGaugeVideoFps(effectiveSearchParams),
          getVCockpitGaugeCaptureFps(effectiveSearchParams),
          getVCockpitGaugeRasterScale(effectiveSearchParams),
          shouldDebugVCockpitGauges(effectiveSearchParams),
          runtimeHost
        )
        vcockpitBinding.setActive(shouldUpdateVCockpitGaugesForCurrentView())
        ;(globalThis as Record<string, unknown>).__lastVCockpitSurfaceBinding =
          vcockpitBinding

        const promoted: LoadedModelComponent = {
          ...candidate,
          vcockpitBinding
        }
        exteriorViewInterior = promoted
        if (loadedModel.interior === candidate) {
          loadedModel = replaceLoadedAircraftInterior(loadedModel, promoted)
          ;(globalThis as Record<string, unknown>).__lastLoadedGltf = loadedModel
        }
        return promoted
      })().finally(() => {
        exteriorViewInteriorCockpitPromotionPromise = null
      })

      return exteriorViewInteriorCockpitPromotionPromise
    }

  const getExteriorViewInteriorPreferredLodIndex = (): number | null => {
    const interiorModel = aircraft.interiorModel
    if (interiorModel == null) {
      return null
    }

    const screenSizePercent = estimateObjectVerticalScreenSizePercent(camera, aircraftRoot)
    const firstAllowedLodIndex = getExteriorViewInteriorFirstAllowedLodIndex() ?? 0
    if (requestedExteriorInteriorLodIndex != null) {
      return Math.max(requestedExteriorInteriorLodIndex, firstAllowedLodIndex)
    }

    if (screenSizePercent != null) {
      return selectModelLodIndexForScreenSize(
        interiorModel,
        screenSizePercent,
        firstAllowedLodIndex
      )
    }

    return Math.max(requestedLodIndex ?? firstAllowedLodIndex, firstAllowedLodIndex)
  }

  const getExteriorViewInteriorFirstAllowedLodIndex = (): number | null => {
    return aircraft.model?.modelOptions.withExteriorShowInteriorHideFirstLod === true
      ? 1
      : null
  }

  const ensureExteriorViewInteriorLoaded = (): Promise<LoadedModelComponent | null> => {
    if (exteriorViewInterior != null || !shouldLoadExteriorViewInterior()) {
      return Promise.resolve(exteriorViewInterior)
    }
    if (exteriorViewInteriorLoadPromise != null) {
      return exteriorViewInteriorLoadPromise
    }

    const interiorModel = aircraft.interiorModel
    if (interiorModel == null) {
      return Promise.resolve(null)
    }

    setGlobalLoadStage({
      stage: 'gltf:exterior-interior:deferred:start',
      aircraftId: aircraft.id
    })
    exteriorViewInteriorLoadPromise = Promise.all([
      loadAircraftModelComponent(
        aircraftModelLoadContext,
        interiorModel,
        {
          kind: 'interior',
          preferredLodIndex: getExteriorViewInteriorPreferredLodIndex(),
          firstAllowedLodIndex: getExteriorViewInteriorFirstAllowedLodIndex(),
          bindVCockpitSurfaces: false,
          liveVCockpitGauges: false,
          runtimeHost
        }
      ),
      ensureFullCompiledBehaviors()
    ])
      .then(([nextInterior]) => {
        exteriorViewInterior = nextInterior
        if (loadedModel.interior !== nextInterior) {
          nextInterior.vcockpitBinding?.setActive(false)
        }
        setGlobalLoadStage({
          stage: 'gltf:exterior-interior:deferred:ready',
          aircraftId: aircraft.id,
          loadedLodIndex: nextInterior.loadedLodIndex
        })
        if (!cockpitCameraController.isActive() && loadedModel.interior !== nextInterior) {
          setActiveInteriorComponent(nextInterior)
        } else if (cockpitCameraController.isActive()) {
          showExteriorViewInteriorCockpitFallback(nextInterior)
          requestInteriorLodUpgrade()
        }
        return nextInterior
      })
      .catch(error => {
        setGlobalLoadStage({
          stage: 'gltf:exterior-interior:deferred:error',
          aircraftId: aircraft.id,
          error: error instanceof Error ? error.message : String(error)
        })
        console.error('Failed to load deferred exterior-view interior.', error)
        return null
      })
      .finally(() => {
        exteriorViewInteriorLoadPromise = null
      })

    return exteriorViewInteriorLoadPromise
  }

  const requestInteriorLodUpgrade = (): void => {
    if (!hasRequestedCockpitInterior) {
      return
    }

    if (exteriorViewInterior != null) {
      showExteriorViewInteriorCockpitFallback(exteriorViewInterior)
    } else if (exteriorViewInteriorLoadPromise != null) {
      void exteriorViewInteriorLoadPromise.then(interior => {
        if (interior != null) {
          showExteriorViewInteriorCockpitFallback(interior)
        }
      })
    }

    if (cachedCockpitInterior != null) {
      if (
        shouldUseCockpitInterior &&
        loadedModel.interior !== cachedCockpitInterior
      ) {
        recordCockpitBenchmarkEvent('cockpit:interior-upgrade:cache-hit', {
          loadedLodIndex: cachedCockpitInterior.loadedLodIndex,
          resourceStats:
            cachedCockpitInterior.resourceStats ??
            collectModelResourceStats(cachedCockpitInterior.scene)
        })
        const nextInterior = cachedCockpitInterior
        void (async () => {
          const rendererWarm = await warmInteriorRendererResources(
            nextInterior,
            'gltf:interior-upgrade:cache-hit'
          )
          recordCockpitBenchmarkEvent('cockpit:interior-upgrade:renderer-warm', {
            loadedLodIndex: nextInterior.loadedLodIndex,
            rendererWarm
          })
          if (shouldUseCockpitInterior && loadedModel.interior !== nextInterior) {
            setActiveInteriorComponent(nextInterior)
          }
        })()
      }
      return
    }

    if (interiorLodUpgradePromise != null) {
      return
    }

    interiorLodUpgradePromise = (async () => {
      try {
        const interiorModel = aircraft.interiorModel
        if (interiorModel == null) {
          return
        }

        setGlobalLoadStage({
          stage: 'gltf:interior-upgrade:start',
          aircraftId: aircraft.id
        })
        recordCockpitBenchmarkEvent('cockpit:interior-upgrade:start')
        await ensureFullCompiledBehaviors()
        const promotedExteriorInterior = await prepareExteriorViewInteriorForCockpit()
        if (promotedExteriorInterior != null) {
          cachedCockpitInterior = promotedExteriorInterior
          recordCockpitBenchmarkEvent('cockpit:interior-upgrade:exterior-reuse', {
            loadedLodIndex: promotedExteriorInterior.loadedLodIndex,
            hadVCockpitBinding: promotedExteriorInterior.vcockpitBinding != null,
            resourceStats:
              promotedExteriorInterior.resourceStats ??
              collectModelResourceStats(promotedExteriorInterior.scene)
          })

          if (
            !shouldUseCockpitInterior ||
            loadedModel.interior === promotedExteriorInterior
          ) {
            promotedExteriorInterior.vcockpitBinding?.setActive(
              loadedModel.interior === promotedExteriorInterior
            )
          } else {
            const rendererWarm = await warmInteriorRendererResources(
              promotedExteriorInterior,
              'gltf:interior-upgrade:exterior-reuse'
            )
            recordCockpitBenchmarkEvent('cockpit:interior-upgrade:renderer-warm', {
              loadedLodIndex: promotedExteriorInterior.loadedLodIndex,
              rendererWarm
            })
            setActiveInteriorComponent(promotedExteriorInterior)
          }

          setGlobalLoadStage({
            stage: 'gltf:interior-upgrade:ready',
            aircraftId: aircraft.id
          })
          cockpitInteractionPickRegistryCache = null
          syncCockpitInteractionHitboxHelpers()
          return
        }

        const nextInterior = await loadAircraftModelComponent(
          aircraftModelLoadContext,
          interiorModel,
          {
            kind: 'interior',
            preferredLodIndex: getCockpitInteriorPreferredLodIndex(),
            textureLoadOptions: createCockpitTextureLoadOptions(effectiveSearchParams, {
              immediatePlaceholder: true,
              defaultRangeMaxTextureSize: DEFAULT_BACKGROUND_COCKPIT_RANGE_TEXTURE_SIZE
            }),
            instanceStaticMeshes: isEnabledFlagSearchParam(
              effectiveSearchParams,
              'cockpitInstanceStatic'
            ),
            mergeStaticMeshes: isEnabledFlagSearchParam(
              effectiveSearchParams,
              'cockpitMergeStatic'
            ),
            bindVCockpitSurfaces: shouldBindVCockpitSurfaces(effectiveSearchParams),
            liveVCockpitGauges: shouldLiveRefreshVCockpitGauges(effectiveSearchParams),
            vcockpitGaugeMode: getVCockpitGaugeMode(effectiveSearchParams),
            vcockpitGaugeVideoFps: getVCockpitGaugeVideoFps(effectiveSearchParams),
            vcockpitGaugeCaptureFps: getVCockpitGaugeCaptureFps(effectiveSearchParams),
            vcockpitGaugeRasterScale: getVCockpitGaugeRasterScale(effectiveSearchParams),
            debugVCockpitGauges: shouldDebugVCockpitGauges(effectiveSearchParams),
            collectResourceStats:
              isEnabledFlagSearchParam(effectiveSearchParams, 'cockpitPerf') ||
              activeCockpitBenchmarkEvents != null,
            behaviorSet: compiledBehaviors,
            runtimeHost,
            prepareGltfInWorker: true,
            waitForTextureLoads: true
          }
        )
        cachedCockpitInterior = nextInterior
        if (!shouldUseCockpitInterior || loadedModel.interior === nextInterior) {
          nextInterior.vcockpitBinding?.setActive(loadedModel.interior === nextInterior)
        }
        recordCockpitBenchmarkEvent('cockpit:interior-upgrade:component-loaded', {
          loadedLodIndex: nextInterior.loadedLodIndex,
          loadDiagnostics: nextInterior.loadDiagnostics,
          resourceStats: nextInterior.resourceStats
        })
        markCockpitPerfFrames('interior-component-loaded', 12)

        if (shouldUseCockpitInterior && loadedModel.interior !== nextInterior) {
          const rendererWarm = await warmInteriorRendererResources(
            nextInterior,
            'gltf:interior-upgrade'
          )
          recordCockpitBenchmarkEvent('cockpit:interior-upgrade:renderer-warm', {
            loadedLodIndex: nextInterior.loadedLodIndex,
            rendererWarm
          })
        }

        if (shouldUseCockpitInterior && loadedModel.interior !== nextInterior) {
          setActiveInteriorComponent(nextInterior)
        }

        setGlobalLoadStage({
          stage: 'gltf:interior-upgrade:ready',
          aircraftId: aircraft.id
        })
        cockpitInteractionPickRegistryCache = null
        syncCockpitInteractionHitboxHelpers()
      } catch (error) {
        setGlobalLoadStage({
          stage: 'gltf:interior-upgrade:error',
          aircraftId: aircraft.id,
          error: error instanceof Error ? error.message : String(error)
        })
        recordCockpitBenchmarkEvent('cockpit:interior-upgrade:error', {
          error: error instanceof Error ? error.message : String(error)
        })
        console.error('Failed to upgrade interior LOD.', error)
      } finally {
        interiorLodUpgradePromise = null
      }
    })()
  }

  const restoreExteriorInteriorLod = (): void => {
    shouldUseCockpitInterior = false
    if (loadedModel.interior === exteriorViewInterior) {
      return
    }

    setActiveInteriorComponent(exteriorViewInterior)
    void ensureExteriorViewInteriorLoaded()
  }
  const cockpitInteractionRaycaster = new Raycaster()
  const cockpitInteractionPointer = new Vector2()
  let cockpitInteractionPickRegistryCache:
    | {
        readonly root: Object3D
        readonly runtime: AircraftRuntime
        readonly registry: CockpitInteractionPickRegistry
      }
    | null = null
  const handleCockpitInteractionPress = (
    event: MouseEvent | PointerEvent,
    options: { readonly holdFeedback: boolean }
  ): CompiledInteractionBinding | null => {
    cockpitInteractionStats.attemptCount += 1
    cockpitInteractionStats.lastMissReason = null
    cockpitInteractionStats.lastHitKind = null
    cockpitInteractionStats.lastOccluderObject = null

    const root = loadedModel.scene
    const rect = renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      cockpitInteractionStats.lastMissReason = 'empty-renderer-rect'
      return null
    }

    cockpitInteractionPointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1)
    )
    cockpitInteractionRaycaster.setFromCamera(cockpitInteractionPointer, camera)
    let sawOccludedHit = false

    const pickRegistry = getCockpitInteractionPickRegistry(root, runtime)
    const blockerHits = getCockpitInteractionBlockerHits(pickRegistry)
    const meshHits = cockpitInteractionRaycaster.intersectObjects([...pickRegistry.meshes], false)
    if (meshHits.length > 0) {
      cockpitInteractionStats.hitCount += 1
      for (const hit of meshHits) {
        const binding = pickRegistry.bindingsByMesh.get(hit.object)
        if (binding == null) {
          continue
        }
        if (isCockpitInteractionHitOccluded(hit.distance, pickRegistry)) {
          sawOccludedHit = true
          cockpitInteractionStats.lastMissReason = 'occluded'
          continue
        }
        if (isCockpitInteractionHitBlocked(hit.distance, blockerHits, pickRegistry)) {
          cockpitInteractionStats.lastMissReason = 'blocked'
          return null
        }
        const executedTarget = executeCockpitInteractionBinding(binding, hit.object, 'interaction-mesh', options)
        if (executedTarget != null) {
          return executedTarget
        }
      }
    }

    const fallbackHits = pickRegistry.fallbackHitboxes
      .map(target => {
        const point = cockpitInteractionRaycaster.ray.intersectBox(target.box, new Vector3())
        return point == null
          ? null
          : {
              target,
              distance: point.distanceTo(cockpitInteractionRaycaster.ray.origin)
            }
      })
      .filter((hit): hit is { readonly target: CockpitInteractionFallbackHitbox; readonly distance: number } => hit != null)
      .sort((left, right) => left.distance - right.distance)
    if (fallbackHits.length > 0) {
      cockpitInteractionStats.hitCount += 1
      for (const hit of fallbackHits) {
        const target = hit.target
        if (isCockpitInteractionHitOccluded(hit.distance, pickRegistry)) {
          sawOccludedHit = true
          cockpitInteractionStats.lastMissReason = 'occluded'
          continue
        }
        if (isCockpitInteractionHitBlocked(hit.distance, blockerHits, pickRegistry)) {
          cockpitInteractionStats.lastMissReason = 'blocked'
          return null
        }
        const executedTarget = executeCockpitInteractionBinding(
          target.binding,
          target.sourceNode,
          'fallback-hitbox',
          options
        )
        if (executedTarget != null) {
          return executedTarget
        }
      }
    }

    if (
      pickRegistry.meshes.length === 0 &&
      pickRegistry.fallbackHitboxes.length === 0 &&
      pickRegistry.blockerMeshes.length === 0 &&
      pickRegistry.blockerHitboxes.length === 0
    ) {
      cockpitInteractionStats.lastMissReason = 'empty-interaction-registry'
      return null
    }

    if (sawOccludedHit) {
      cockpitInteractionStats.lastMissReason = 'occluded'
      return null
    }

    if (blockerHits.length > 0) {
      cockpitInteractionStats.hitCount += 1
      cockpitInteractionStats.lastMissReason = 'blocked'
      return null
    }

    if (meshHits.length === 0 && fallbackHits.length === 0) {
      cockpitInteractionStats.lastMissReason = 'raycast-miss'
      return null
    }

    cockpitInteractionStats.lastMissReason = 'no-bound-interaction'
    return null
  }

  const getCockpitInteractionBlockerHits = (
    pickRegistry: CockpitInteractionPickRegistry
  ): readonly {
    readonly distance: number
    readonly object: Object3D
    readonly target: string
  }[] => {
    const meshHits = cockpitInteractionRaycaster
      .intersectObjects([...pickRegistry.blockerMeshes], false)
      .map(hit => ({
        distance: hit.distance,
        object: hit.object,
        target: pickRegistry.blockersByMesh.get(hit.object)?.target ?? hit.object.name
      }))
    const hitboxHits = pickRegistry.blockerHitboxes
      .map(blocker => {
        const point = cockpitInteractionRaycaster.ray.intersectBox(blocker.box, new Vector3())
        return point == null
          ? null
          : {
              distance: point.distanceTo(cockpitInteractionRaycaster.ray.origin),
              object: blocker.sourceNode,
              target: blocker.blocker.target
            }
      })
      .filter((hit): hit is { readonly distance: number; readonly object: Object3D; readonly target: string } => hit != null)
    return [...meshHits, ...hitboxHits].sort((left, right) => left.distance - right.distance)
  }

  const isCockpitInteractionHitBlocked = (
    hitDistance: number,
    blockerHits: readonly {
      readonly distance: number
      readonly object: Object3D
      readonly target: string
    }[],
    pickRegistry: CockpitInteractionPickRegistry
  ): boolean => {
    const blockerHit = blockerHits.find(hit => hit.distance <= hitDistance + 1e-4)
    if (blockerHit == null) {
      return false
    }
    if (isCockpitInteractionHitOccluded(blockerHit.distance, pickRegistry)) {
      return false
    }
    cockpitInteractionStats.lastHitObject = blockerHit.object.name || blockerHit.object.type
    cockpitInteractionStats.lastHitKind = 'blocker'
    cockpitInteractionStats.lastTarget = blockerHit.target
    return true
  }

  const isCockpitInteractionHitOccluded = (
    hitDistance: number,
    pickRegistry: CockpitInteractionPickRegistry
  ): boolean => {
    const maxDistance = Math.max(hitDistance - 1e-4, 0)
    if (maxDistance <= 0 || pickRegistry.occluderMeshes.length === 0) {
      return false
    }

    const occluderCandidates: Mesh[] = []
    for (const mesh of pickRegistry.occluderMeshes) {
      if (!isRenderableMesh(mesh)) {
        continue
      }
      mesh.updateWorldMatrix(true, false)
      const bounds = new Box3().setFromObject(mesh)
      if (bounds.isEmpty()) {
        continue
      }
      const point = cockpitInteractionRaycaster.ray.intersectBox(bounds, new Vector3())
      if (point == null) {
        continue
      }
      const distance = point.distanceTo(cockpitInteractionRaycaster.ray.origin)
      if (distance <= maxDistance) {
        occluderCandidates.push(mesh)
      }
    }

    const occluderHits = cockpitInteractionRaycaster.intersectObjects(occluderCandidates, false)
    const occluderHit = occluderHits.find(hit => hit.distance <= maxDistance)
    if (occluderHit == null) {
      return false
    }

    cockpitInteractionStats.lastOccluderObject = occluderHit.object.name || occluderHit.object.type
    return true
  }

  const executeCockpitInteractionBinding = (
    binding: CompiledInteractionBinding,
    hitObject: Object3D,
    hitKind: 'interaction-mesh' | 'fallback-hitbox',
    options: { readonly holdFeedback: boolean }
  ): CompiledInteractionBinding | null => {
    cockpitInteractionStats.lastHitObject = hitObject.name || hitObject.type
    cockpitInteractionStats.lastHitKind = hitKind
    if (runtime.executeInteractionBindingDirect(binding, { holdFeedback: options.holdFeedback })) {
      cockpitInteractionStats.executedCount += 1
      cockpitInteractionStats.lastTarget = binding.target
      cockpitInteractionStats.activeHeldTarget = options.holdFeedback ? binding.target : null
      cockpitInteractionStats.interactionTargetCount = runtime.getInteractionBindings().length
      return binding
    }

    return null
  }

  const executeCockpitInteractionDrag = (
    binding: CompiledInteractionBinding | null,
    options: {
      readonly relativeX: number
      readonly relativeY: number
      readonly relativeZ: number
      readonly dragPercent: number
    }
  ): boolean => {
    if (binding == null || binding.kind !== 'callback' || !binding.expression.source.includes('LeftDrag')) {
      return false
    }
    const dragged = runtime.executeInteractionCallbackEventForBinding(binding, {
      holdFeedback: true,
      mouseEvent: 'LeftDrag',
      inputType: 1,
      relativeX: options.relativeX,
      relativeY: options.relativeY,
      relativeZ: options.relativeZ,
      dragPercent: options.dragPercent
    })
    if (dragged) {
      cockpitInteractionStats.executedCount += 1
      cockpitInteractionStats.lastTarget = binding.target
      cockpitInteractionStats.activeHeldTarget = binding.target
    }
    return dragged
  }

  const releaseCockpitInteractionPress = (
    binding: CompiledInteractionBinding | null,
    options: { readonly unlock: boolean } = { unlock: false }
  ): void => {
    if (binding == null) {
      return
    }
    runtime.executeInteractionCallbackEventForBinding(binding, {
      holdFeedback: false,
      mouseEvent: 'LeftRelease'
    })
    if (options.unlock) {
      runtime.executeInteractionCallbackEventForBinding(binding, {
        holdFeedback: false,
        mouseEvent: 'Unlock'
      })
    }
    runtime.releaseInteractionBinding(binding)
    if (cockpitInteractionStats.activeHeldTarget === binding.target) {
      cockpitInteractionStats.activeHeldTarget = null
    }
  }

  const getCockpitInteractionPickRegistry = (
    root: Object3D,
    activeRuntime: AircraftRuntime
  ): CockpitInteractionPickRegistry => {
    if (
      cockpitInteractionPickRegistryCache != null &&
      cockpitInteractionPickRegistryCache.root === root &&
      cockpitInteractionPickRegistryCache.runtime === activeRuntime
    ) {
      return cockpitInteractionPickRegistryCache.registry
    }

    const registry = createCockpitInteractionPickRegistry(
      root,
      activeRuntime.getInteractionBindings(),
      activeRuntime.getInteractionBlockers(),
      loadedModel.animations
    )
    cockpitInteractionPickRegistryCache = {
      root,
      runtime: activeRuntime,
      registry
    }
    cockpitInteractionStats.interactionTargetCount = activeRuntime.getInteractionBindings().length
    cockpitInteractionStats.interactionHitVolumeCount =
      registry.fallbackHitboxes.length + registry.blockerHitboxes.length
    cockpitInteractionStats.interactionPickableMeshCount = registry.meshes.length
    cockpitInteractionStats.interactionMappedBindingCount = registry.bindingsByMesh.size
    cockpitInteractionStats.interactionFallbackHitboxCount = registry.fallbackHitboxes.length
    ;(cockpitInteractionStats as Record<string, unknown>).interactionBlockerCount =
      activeRuntime.getInteractionBlockers().length
    ;(cockpitInteractionStats as Record<string, unknown>).interactionBlockerMeshCount =
      registry.blockerMeshes.length
    ;(cockpitInteractionStats as Record<string, unknown>).interactionBlockerHitboxCount =
      registry.blockerHitboxes.length
    cockpitInteractionStats.interactionOccluderMeshCount = registry.occluderMeshes.length
    ;(globalThis as Record<string, unknown>).__lastCockpitInteractionPickRegistry = {
      meshes: registry.meshes.map(mesh => ({
        object: mesh.name,
        target: registry.bindingsByMesh.get(mesh)?.target ?? null
      })),
      blockerMeshes: registry.blockerMeshes.map(mesh => ({
        object: mesh.name,
        target: registry.blockersByMesh.get(mesh)?.target ?? null
      })),
      occluderMeshCount: registry.occluderMeshes.length,
      fallbackHitboxes: registry.fallbackHitboxes.map(target => ({
        target: target.binding.target,
        sourceNode: target.sourceNode.name,
        center: target.box.getCenter(new Vector3()).toArray(),
        size: target.box.getSize(new Vector3()).toArray()
      })),
      blockerHitboxes: registry.blockerHitboxes.map(blocker => ({
        target: blocker.blocker.target,
        sourceNode: blocker.sourceNode.name,
        center: blocker.box.getCenter(new Vector3()).toArray(),
        size: blocker.box.getSize(new Vector3()).toArray()
      }))
    }
    return registry
  }

  const syncCockpitInteractionHitboxHelpers = (): void => {
    if (cockpitInteractionHitboxHelperGroup != null) {
      scene.remove(cockpitInteractionHitboxHelperGroup)
      cockpitInteractionHitboxHelperGroup.clear()
      cockpitInteractionHitboxHelperGroup = null
    }
    cockpitInteractionMeshHelperPairs = []

    if (!shouldShowCockpitInteractionHitboxes(effectiveSearchParams)) {
      ;(globalThis as Record<string, unknown>).__lastCockpitInteractionHitboxHelpers = []
      return
    }

    const root = loadedModel.scene
    const registry = getCockpitInteractionPickRegistry(root, runtime)
    const group = new Group()
    group.name = 'cockpit-interaction-hitbox-helpers'
    const meshHelperMaterial = new MeshBasicMaterial({
      color: 0x2de36f,
      transparent: true,
      opacity: 0.22,
      wireframe: true,
      depthWrite: false
    })
    const blockerMeshHelperMaterial = new MeshBasicMaterial({
      color: 0xffb020,
      transparent: true,
      opacity: 0.24,
      wireframe: true,
      depthWrite: false
    })
    const meshProxyGeometry = getCockpitInteractionHitboxProxyGeometry()
    for (const mesh of registry.meshes) {
      const localBox = getCockpitInteractionMeshLocalBox(mesh)
      if (localBox == null) {
        continue
      }
      const helper = new Mesh(meshProxyGeometry, meshHelperMaterial)
      helper.name = `pickable-mesh:${registry.bindingsByMesh.get(mesh)?.target ?? mesh.name}`
      helper.matrixAutoUpdate = false
      updateCockpitInteractionMeshHitboxHelperMatrix(mesh, helper, localBox)
      helper.frustumCulled = false
      group.add(helper)
      cockpitInteractionMeshHelperPairs.push({ source: mesh, helper, localBox })
    }
    for (const mesh of registry.blockerMeshes) {
      const localBox = getCockpitInteractionMeshLocalBox(mesh)
      if (localBox == null) {
        continue
      }
      const helper = new Mesh(meshProxyGeometry, blockerMeshHelperMaterial)
      helper.name = `blocker-mesh:${registry.blockersByMesh.get(mesh)?.target ?? mesh.name}`
      helper.matrixAutoUpdate = false
      updateCockpitInteractionMeshHitboxHelperMatrix(mesh, helper, localBox)
      helper.frustumCulled = false
      group.add(helper)
      cockpitInteractionMeshHelperPairs.push({ source: mesh, helper, localBox })
    }
    for (const target of registry.fallbackHitboxes) {
      const helper = new Box3Helper(target.box, 0xff3333)
      helper.name = `fallback-hitbox:${target.binding.target}`
      group.add(helper)
    }
    for (const blocker of registry.blockerHitboxes) {
      const helper = new Box3Helper(blocker.box, 0xffb020)
      helper.name = `blocker-hitbox:${blocker.blocker.target}`
      group.add(helper)
    }
    cockpitInteractionHitboxHelperGroup = group
    scene.add(group)
    ;(globalThis as Record<string, unknown>).__lastCockpitInteractionHitboxHelpers =
      [
        ...registry.meshes.map(mesh => registry.bindingsByMesh.get(mesh)?.target ?? mesh.name),
        ...registry.blockerMeshes.map(mesh => registry.blockersByMesh.get(mesh)?.target ?? mesh.name)
      ]
  }

  const updateCockpitInteractionHitboxHelpers = (): void => {
    if (cockpitInteractionHitboxHelperGroup == null) {
      return
    }

    for (const { source, helper, localBox } of cockpitInteractionMeshHelperPairs) {
      updateCockpitInteractionMeshHitboxHelperMatrix(source, helper, localBox)
    }
  }

  const cockpitCameraController = installCockpitCameraShortcut(
    renderer.domElement,
    camera,
    controls,
    aircraftRoot,
    loadedModel.exterior.scene,
    () => cockpitCameraClipPlanes,
    refreshCockpitCameraClipPlanes,
    aircraft,
    () => {
      shouldUseCockpitInterior = true
      hasRequestedCockpitInterior = true
      requestInteriorLodUpgrade()
      syncCockpitInteractionHitboxHelpers()
    },
    restoreExteriorInteriorLod,
    (mode, source) => {
      recordCockpitBenchmarkEvent(`cockpit:toggle:${mode}`, { source })
    },
    handleCockpitInteractionPress,
    executeCockpitInteractionDrag,
    releaseCockpitInteractionPress
  )
  ;(globalThis as Record<string, unknown>).__lastCockpitCameraController =
    cockpitCameraController
  loadedModel.interior?.vcockpitBinding?.setActive(shouldUpdateVCockpitGaugesForCurrentView())
  if (exteriorInteriorMode === 'deferred') {
    requestAnimationFrame(() => {
      const idleCallback = (
        window as Window & {
          requestIdleCallback?: (
            callback: () => void,
            options?: { readonly timeout?: number }
          ) => number
        }
      ).requestIdleCallback
      if (typeof idleCallback === 'function') {
        idleCallback(() => {
          void ensureExteriorViewInteriorLoaded()
        }, { timeout: 1_000 })
        return
      }

      window.setTimeout(() => {
        void ensureExteriorViewInteriorLoaded()
      }, 0)
    })
  }

  const runCockpitBenchmark = async (options: {
    readonly targetInteriorLodIndex?: number
    readonly forceCold?: boolean
  } = {}): Promise<CockpitBenchmarkRunResult> => {
    if (!cockpitCameraController.isAvailable()) {
      throw new Error('Cockpit benchmark is unavailable because the selected aircraft has no cockpit camera.')
    }
    if (aircraft.interiorModel == null) {
      throw new Error('Cockpit benchmark is unavailable because the selected aircraft has no interior model.')
    }
    await ensureExteriorViewInteriorLoaded()
    if (shouldLoadExteriorViewInterior() && exteriorViewInterior == null) {
      throw new Error('Cockpit benchmark is unavailable because the exterior-view interior LOD could not be loaded.')
    }
    if (activeCockpitBenchmarkEvents != null) {
      throw new Error('Cockpit benchmark is already running.')
    }

    const events: CockpitBenchmarkEvent[] = []
    activeCockpitBenchmarkEvents = events
    const previousRequestedInteriorLodIndex = requestedInteriorLodIndex
    if (options.targetInteriorLodIndex != null) {
      requestedInteriorLodIndex = options.targetInteriorLodIndex
    }

    try {
      if (cockpitCameraController.isActive()) {
        cockpitCameraController.exit('benchmark')
      }
      await waitForCockpitBenchmarkCondition(
        () =>
          !cockpitCameraController.isActive() &&
          loadedModel.interior === exteriorViewInterior,
        10_000,
        'exterior LOD01 state before benchmark start'
      )
      await waitForAnimationFrames(3)
      if (options.forceCold === true) {
        invalidateCachedCockpitInterior()
      }

      const coldAvailable = cachedCockpitInterior == null
      const targetCockpitInteriorLodIndex = getCockpitInteriorPreferredLodIndex()
      await captureCockpitBenchmarkSnapshot('benchmark:cold:before')
      if (coldAvailable) {
        cockpitCameraController.enter('benchmark')
        await waitForCockpitBenchmarkCondition(
          () =>
            cockpitCameraController.isActive() &&
            loadedModel.interior?.loadedLodIndex === targetCockpitInteriorLodIndex,
          120_000,
          'cold cockpit interior LOD activation'
        )
        recordCockpitBenchmarkEvent('benchmark:cold:active-interior')
        await waitForAnimationFrames(3)
        recordCockpitBenchmarkEvent('benchmark:cold:visual-ready')
        await captureCockpitBenchmarkSnapshot('benchmark:cold:after')
      } else {
        recordCockpitBenchmarkEvent('benchmark:cold:skipped', {
          reason: 'Selected cockpit interior LOD was already cached before the benchmark run started.'
        })
      }

      cockpitCameraController.exit('benchmark')
      await waitForCockpitBenchmarkCondition(
        () =>
          !cockpitCameraController.isActive() &&
          loadedModel.interior === exteriorViewInterior,
        10_000,
        'cached exterior state after cold cockpit exit'
      )
      recordCockpitBenchmarkEvent('benchmark:cached-exterior:active-interior')
      await waitForAnimationFrames(3)
      recordCockpitBenchmarkEvent('benchmark:cached-exterior:visual-ready')
      await captureCockpitBenchmarkSnapshot('benchmark:cached-exterior:after')

      await captureCockpitBenchmarkSnapshot('benchmark:warm:before')
      cockpitCameraController.enter('benchmark')
      await waitForCockpitBenchmarkCondition(
        () =>
          cockpitCameraController.isActive() &&
          loadedModel.interior?.loadedLodIndex === targetCockpitInteriorLodIndex,
        10_000,
        'warm cockpit interior LOD activation'
      )
      recordCockpitBenchmarkEvent('benchmark:warm:active-interior')
      await waitForAnimationFrames(3)
      recordCockpitBenchmarkEvent('benchmark:warm:visual-ready')
      await captureCockpitBenchmarkSnapshot('benchmark:warm:after')

      const result: CockpitBenchmarkRunResult = {
        aircraftId: aircraft.id,
        createdAt: new Date().toISOString(),
        cold: summarizeCockpitBenchmarkPhase(events, {
          startLabel: 'cockpit:toggle:enter',
          beforeLabel: 'benchmark:cold:before',
          afterLabel: 'benchmark:cold:after',
          visualReadyLabel: 'benchmark:cold:visual-ready',
          loadStartLabel: 'cockpit:interior-upgrade:start',
          componentLoadedLabel: 'cockpit:interior-upgrade:component-loaded',
          swapCompleteLabel: 'cockpit:interior:swap-complete',
          activeInteriorLabel: 'benchmark:cold:active-interior',
          skipReason: coldAvailable
            ? null
            : 'Selected cockpit interior LOD was already cached before the benchmark run started.'
        }),
        cachedExterior: summarizeCockpitBenchmarkPhase(events, {
          startLabel: 'cockpit:toggle:exit',
          beforeLabel: 'benchmark:cold:after',
          afterLabel: 'benchmark:cached-exterior:after',
          visualReadyLabel: 'benchmark:cached-exterior:visual-ready',
          swapCompleteLabel: 'cockpit:interior:swap-complete',
          activeInteriorLabel: 'benchmark:cached-exterior:active-interior'
        }),
        warm: summarizeCockpitBenchmarkPhase(events, {
          startLabel: 'cockpit:toggle:enter',
          beforeLabel: 'benchmark:warm:before',
          afterLabel: 'benchmark:warm:after',
          visualReadyLabel: 'benchmark:warm:visual-ready',
          loadStartLabel: 'cockpit:interior-upgrade:cache-hit',
          swapCompleteLabel: 'cockpit:interior:swap-complete',
          activeInteriorLabel: 'benchmark:warm:active-interior'
        }),
        events: [...events]
      }
      lastCockpitBenchmarkResult = result
      ;(globalThis as Record<string, unknown>).__lastCockpitBenchmarkResult = result
      return result
    } finally {
      requestedInteriorLodIndex = previousRequestedInteriorLodIndex
      activeCockpitBenchmarkEvents = null
    }
  }

  ;(globalThis as Record<string, unknown>).__cockpitBenchmark = {
    getState: () => ({
      aircraftId: aircraft.id,
      cockpitCameraAvailable: cockpitCameraController.isAvailable(),
      cockpitViewActive: cockpitCameraController.isActive(),
      selectedInteriorLodIndex: getCockpitInteriorPreferredLodIndex(),
      activeInteriorLodIndex: loadedModel.interior?.loadedLodIndex ?? null,
      cachedInteriorAvailable: cachedCockpitInterior != null,
      cachedInteriorLod00Available: cachedCockpitInterior?.loadedLodIndex === 0,
      activeInteriorLoadDiagnostics: loadedModel.interior?.loadDiagnostics ?? null,
      activeInteriorResourceStats: loadedModel.interior?.resourceStats ?? null,
      cachedInteriorLoadDiagnostics: cachedCockpitInterior?.loadDiagnostics ?? null,
      cachedInteriorResourceStats: cachedCockpitInterior?.resourceStats ?? null,
      benchmarkRunning: activeCockpitBenchmarkEvents != null,
      lastResult: lastCockpitBenchmarkResult
    }),
    run: runCockpitBenchmark
  }
  ;(globalThis as Record<string, unknown>).__lastCockpitBenchmarkResult =
    lastCockpitBenchmarkResult

  const clock = new Clock()
  const fpsCounter = createFpsCounter()
  let runtimeState: RuntimeState = runtime.update(0)
  lastRuntimeModelRevision = runtime.getModelRevision()
  ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
  const updateCameraDepthClipController = (): void => {
    if (cockpitCameraController.isActive()) {
      if (
        shouldUpdateCameraClipPlane(camera.near, cockpitCameraClipPlanes.near) ||
        shouldUpdateCameraClipPlane(camera.far, cockpitCameraClipPlanes.far)
      ) {
        camera.near = cockpitCameraClipPlanes.near
        camera.far = cockpitCameraClipPlanes.far
        camera.updateProjectionMatrix()
      }
      return
    }

    const runtimeModelRevision = runtime.getModelRevision()
    if (runtimeModelRevision !== lastRuntimeModelRevision) {
      lastRuntimeModelRevision = runtimeModelRevision
      cameraDepthClipController.markModelChanged()
    }
    cameraDepthClipController.update()
  }
  let cockpitPerfDiagnostics = isEnabledFlagSearchParam(effectiveSearchParams, 'cockpitPerf')
    ? createCockpitPerfDiagnostics(aircraft, () => loadedModel)
    : createDisabledCockpitPerfDiagnostics(aircraft, () => loadedModel)
  ;(globalThis as Record<string, unknown>).__cockpitPerf = cockpitPerfDiagnostics
  let cockpitPerfFrameMarker: { label: string; remainingFrames: number } | null = null
  const markCockpitPerfFrames = (label: string, frameCount: number): void => {
    cockpitPerfFrameMarker = {
      label,
      remainingFrames: Math.max(0, Math.floor(frameCount))
    }
  }
  const consumeCockpitPerfFrameMarker = (): string | null => {
    if (cockpitPerfFrameMarker == null || cockpitPerfFrameMarker.remainingFrames <= 0) {
      cockpitPerfFrameMarker = null
      return null
    }

    const label = cockpitPerfFrameMarker.label
    cockpitPerfFrameMarker.remainingFrames -= 1
    if (cockpitPerfFrameMarker.remainingFrames <= 0) {
      cockpitPerfFrameMarker = null
    }
    return label
  }
  let cockpitInteractionHitboxHelperGroup: Group | null = null
  let cockpitInteractionHitboxProxyGeometry: BoxGeometry | null = null
  const cockpitInteractionHitboxLocalCenter = new Vector3()
  const cockpitInteractionHitboxLocalSize = new Vector3()
  const cockpitInteractionHitboxTranslateMatrix = new Matrix4()
  const cockpitInteractionHitboxScaleMatrix = new Matrix4()
  let cockpitInteractionMeshHelperPairs: {
    readonly source: Mesh
    readonly helper: Mesh
    readonly localBox: Box3
  }[] = []

  const getCockpitInteractionHitboxProxyGeometry = (): BoxGeometry => {
    if (cockpitInteractionHitboxProxyGeometry == null) {
      cockpitInteractionHitboxProxyGeometry = new BoxGeometry(1, 1, 1)
    }
    return cockpitInteractionHitboxProxyGeometry
  }

  const getCockpitInteractionMeshLocalBox = (mesh: Mesh): Box3 | null => {
    if (mesh.geometry.boundingBox == null) {
      mesh.geometry.computeBoundingBox()
    }
    return mesh.geometry.boundingBox?.clone() ?? null
  }

  const updateCockpitInteractionMeshHitboxHelperMatrix = (
    source: Mesh,
    helper: Mesh,
    localBox: Box3
  ): void => {
    source.updateWorldMatrix(true, false)
    localBox.getCenter(cockpitInteractionHitboxLocalCenter)
    localBox.getSize(cockpitInteractionHitboxLocalSize)
    cockpitInteractionHitboxTranslateMatrix.makeTranslation(
      cockpitInteractionHitboxLocalCenter.x,
      cockpitInteractionHitboxLocalCenter.y,
      cockpitInteractionHitboxLocalCenter.z
    )
    cockpitInteractionHitboxScaleMatrix.makeScale(
      cockpitInteractionHitboxLocalSize.x,
      cockpitInteractionHitboxLocalSize.y,
      cockpitInteractionHitboxLocalSize.z
    )
    helper.matrix
      .copy(source.matrixWorld)
      .multiply(cockpitInteractionHitboxTranslateMatrix)
      .multiply(cockpitInteractionHitboxScaleMatrix)
    helper.matrixWorldNeedsUpdate = true
  }
  updateOverlay(
    overlay,
    packageRoot,
    packageData,
    aircraft,
    compiledBehaviors,
    runtimeState,
    rendererInfo,
    fpsCounter.getSnapshot()
  )

  const resolveCurrentStoredEffectiveSearchParams = (): URLSearchParams => {
    const nextStore = loadViewerConfigStore()
    return createEffectiveViewerSearchParams(
      searchParams,
      nextStore.global,
      nextStore.aircraft[getViewerAircraftConfigKey(packageRoot, aircraft.id)] ?? null
    )
  }

  const setActiveEffectiveSearchParams = (nextSearchParams: URLSearchParams): void => {
    effectiveSearchParams = nextSearchParams
    requestedLodIndex = resolveRequestedLodIndex(effectiveSearchParams)
    requestedInteriorLodIndex = resolveRequestedInteriorLodIndex(effectiveSearchParams)
    requestedExteriorInteriorLodIndex =
      resolveRequestedExteriorInteriorLodIndex(effectiveSearchParams)
    exteriorInteriorMode = getExteriorInteriorMode(effectiveSearchParams)
  }

  const setCockpitPerfDiagnosticsEnabled = (enabled: boolean): void => {
    cockpitPerfDiagnostics = enabled
      ? createCockpitPerfDiagnostics(aircraft, () => loadedModel)
      : createDisabledCockpitPerfDiagnostics(aircraft, () => loadedModel)
    ;(globalThis as Record<string, unknown>).__cockpitPerf = cockpitPerfDiagnostics
  }

  const invalidateCachedCockpitInterior = (): void => {
    const previousCachedCockpitInterior = cachedCockpitInterior
    cachedCockpitInterior = null
    hasRequestedCockpitInterior = false
    if (
      previousCachedCockpitInterior != null &&
      previousCachedCockpitInterior !== loadedModel.interior &&
      previousCachedCockpitInterior !== exteriorViewInterior
    ) {
      disposeLoadedModelComponent(previousCachedCockpitInterior)
    }
  }

  const loadCockpitInteriorWithActiveSettings =
    async (): Promise<LoadedModelComponent | null> => {
      const interiorModel = aircraft.interiorModel
      if (interiorModel == null) {
        return null
      }

      await ensureFullCompiledBehaviors()
      return loadAircraftModelComponent(
        aircraftModelLoadContext,
        interiorModel,
        {
          kind: 'interior',
          preferredLodIndex: getCockpitInteriorPreferredLodIndex(),
          textureLoadOptions: createCockpitTextureLoadOptions(effectiveSearchParams, {
            immediatePlaceholder: cockpitCameraController.isActive(),
            defaultRangeMaxTextureSize: cockpitCameraController.isActive()
              ? DEFAULT_BACKGROUND_COCKPIT_RANGE_TEXTURE_SIZE
              : DEFAULT_COCKPIT_RANGE_TEXTURE_SIZE
          }),
          instanceStaticMeshes: isEnabledFlagSearchParam(
            effectiveSearchParams,
            'cockpitInstanceStatic'
          ),
          mergeStaticMeshes: isEnabledFlagSearchParam(
            effectiveSearchParams,
            'cockpitMergeStatic'
          ),
          bindVCockpitSurfaces: shouldBindVCockpitSurfaces(effectiveSearchParams),
          liveVCockpitGauges: shouldLiveRefreshVCockpitGauges(effectiveSearchParams),
          vcockpitGaugeMode: getVCockpitGaugeMode(effectiveSearchParams),
          vcockpitGaugeVideoFps: getVCockpitGaugeVideoFps(effectiveSearchParams),
          vcockpitGaugeCaptureFps: getVCockpitGaugeCaptureFps(effectiveSearchParams),
          vcockpitGaugeRasterScale: getVCockpitGaugeRasterScale(effectiveSearchParams),
          debugVCockpitGauges: shouldDebugVCockpitGauges(effectiveSearchParams),
          collectResourceStats:
            isEnabledFlagSearchParam(effectiveSearchParams, 'cockpitPerf') ||
            activeCockpitBenchmarkEvents != null,
          behaviorSet: compiledBehaviors,
          runtimeHost,
          prepareGltfInWorker: cockpitCameraController.isActive(),
          waitForTextureLoads: cockpitCameraController.isActive()
        }
      )
    }

  const reloadCockpitInteriorWithActiveSettings = async (): Promise<void> => {
    const previousCockpitInterior = cachedCockpitInterior
    const nextCockpitInterior = await loadCockpitInteriorWithActiveSettings()
    if (nextCockpitInterior == null) {
      invalidateCachedCockpitInterior()
      return
    }

    cachedCockpitInterior = nextCockpitInterior
    hasRequestedCockpitInterior = cockpitCameraController.isActive()
    if (cockpitCameraController.isActive()) {
      shouldUseCockpitInterior = true
      setActiveInteriorComponent(nextCockpitInterior)
    } else {
      nextCockpitInterior.vcockpitBinding?.setActive(false)
    }

    if (
      previousCockpitInterior != null &&
      previousCockpitInterior !== nextCockpitInterior &&
      previousCockpitInterior !== exteriorViewInterior &&
      previousCockpitInterior !== loadedModel.interior
    ) {
      disposeLoadedModelComponent(previousCockpitInterior)
    }
  }

  const reloadExteriorViewInteriorWithActiveSettings = async (): Promise<void> => {
    const previousExteriorInterior = exteriorViewInterior
    exteriorViewInterior = null
    exteriorViewInteriorLoadPromise = null
    if (!cockpitCameraController.isActive() && loadedModel.interior === previousExteriorInterior) {
      setActiveInteriorComponent(null)
    }

    if (
      previousExteriorInterior != null &&
      previousExteriorInterior !== cachedCockpitInterior &&
      previousExteriorInterior !== loadedModel.interior
    ) {
      disposeLoadedModelComponent(previousExteriorInterior)
    }

    if (!cockpitCameraController.isActive()) {
      await ensureExteriorViewInteriorLoaded()
    }
  }

  const reloadExteriorModelWithActiveSettings = async (): Promise<void> => {
    if (aircraft.model == null) {
      return
    }

    const previousExterior = loadedModel.exterior
    const reusableExteriorScene = previousExterior.scene
    const wasVisible = reusableExteriorScene.visible
    const nextExterior = await loadAircraftModelComponent(aircraftModelLoadContext, aircraft.model, {
      kind: 'exterior',
      preferredLodIndex: requestedLodIndex
    })

    disposeObjectResources(reusableExteriorScene)
    reusableExteriorScene.clear()
    while (nextExterior.scene.children.length > 0) {
      reusableExteriorScene.add(nextExterior.scene.children[0])
    }
    reusableExteriorScene.visible = wasVisible

    loadedModel = {
      scene: loadedModel.scene,
      animations: buildLoadedAircraftAnimations(
        { ...nextExterior, scene: reusableExteriorScene },
        loadedModel.interior
      ),
      exterior: { ...nextExterior, scene: reusableExteriorScene },
      interior: loadedModel.interior
    }
    ;(globalThis as Record<string, unknown>).__lastLoadedGltf = loadedModel
    rebuildRuntimeForLoadedModel()
    renderPasses.refresh()
    cameraDepthClipController.refreshBounds()
  }

  const applyViewerSettingsToLoadedAircraft = async (
    event: ViewerSettingsApplyEvent
  ): Promise<string | null> => {
    if (
      ensureTrailingSlash(event.selectedPackageRoot) !== ensureTrailingSlash(packageRoot) ||
      event.selectedAircraftId !== aircraft.id
    ) {
      return event.scope === 'aircraft' ? 'Saved profile for selected aircraft.' : null
    }

    const previousSettings = createViewerRuntimeSettingsSnapshot(effectiveSearchParams)
    const nextSearchParams = resolveCurrentStoredEffectiveSearchParams()
    const nextSettings = createViewerRuntimeSettingsSnapshot(nextSearchParams)
    setActiveEffectiveSearchParams(nextSearchParams)

    const actions: string[] = []
    const exteriorLodChanged = previousSettings.exteriorLod !== nextSettings.exteriorLod
    const interiorLodChanged = previousSettings.interiorLod !== nextSettings.interiorLod
    const exteriorInteriorChanged =
      previousSettings.exteriorInteriorMode !== nextSettings.exteriorInteriorMode ||
      previousSettings.exteriorInteriorLod !== nextSettings.exteriorInteriorLod
    const vcockpitBindingChanged =
      previousSettings.vcockpitSurfaces !== nextSettings.vcockpitSurfaces ||
      previousSettings.vcockpitLiveGauges !== nextSettings.vcockpitLiveGauges ||
      previousSettings.vcockpitGaugeMode !== nextSettings.vcockpitGaugeMode ||
      previousSettings.vcockpitGaugeRasterScale !== nextSettings.vcockpitGaugeRasterScale
    const gaugeCaptureFpsChanged =
      previousSettings.vcockpitGaugeCaptureFps !== nextSettings.vcockpitGaugeCaptureFps
    const gaugeUpdateOutsideChanged =
      previousSettings.vcockpitGaugeUpdateOutside !== nextSettings.vcockpitGaugeUpdateOutside
    const cockpitTextureChanged =
      previousSettings.cockpitTextures !== nextSettings.cockpitTextures ||
      previousSettings.cockpitTextureSize !== nextSettings.cockpitTextureSize ||
      previousSettings.cockpitMergeStatic !== nextSettings.cockpitMergeStatic ||
      previousSettings.cockpitInstanceStatic !== nextSettings.cockpitInstanceStatic
    const cockpitPerfChanged = previousSettings.cockpitPerf !== nextSettings.cockpitPerf
    const cockpitInteractionHitboxesChanged =
      previousSettings.cockpitInteractionHitboxes !== nextSettings.cockpitInteractionHitboxes
    const skipGaugeSettingSeedChanged =
      previousSettings.skipGaugeSettingSeed !== nextSettings.skipGaugeSettingSeed
    const rendererPixelRatioChanged =
      previousSettings.rendererPixelRatio !== nextSettings.rendererPixelRatio
    const extraQueryChanged = previousSettings.extraQuery !== nextSettings.extraQuery

    if (exteriorLodChanged) {
      await reloadExteriorModelWithActiveSettings()
      actions.push('reloaded exterior model')
    }

    if (exteriorInteriorChanged) {
      await reloadExteriorViewInteriorWithActiveSettings()
      actions.push(
        cockpitCameraController.isActive()
          ? 'queued exterior-view interior reload'
          : 'reloaded exterior-view interior'
      )
    }

    if (gaugeCaptureFpsChanged && loadedModel.interior?.vcockpitBinding != null) {
      loadedModel.interior.vcockpitBinding.setCaptureFps(nextSettings.vcockpitGaugeCaptureFps)
      actions.push('updated gauge capture FPS')
    }

    if (gaugeUpdateOutsideChanged && loadedModel.interior?.vcockpitBinding != null) {
      loadedModel.interior.vcockpitBinding.setActive(shouldUpdateVCockpitGaugesForCurrentView())
      actions.push(
        nextSettings.vcockpitGaugeUpdateOutside
          ? 'enabled outside-view gauge updates'
          : 'disabled outside-view gauge updates'
      )
    }

    if (cockpitPerfChanged) {
      setCockpitPerfDiagnosticsEnabled(nextSettings.cockpitPerf)
      actions.push(nextSettings.cockpitPerf ? 'enabled cockpit perf' : 'disabled cockpit perf')
    }

    if (cockpitInteractionHitboxesChanged) {
      syncCockpitInteractionHitboxHelpers()
      actions.push(
        nextSettings.cockpitInteractionHitboxes
          ? 'enabled interaction hitboxes'
          : 'disabled interaction hitboxes'
      )
    }

    if (rendererPixelRatioChanged) {
      renderer.setPixelRatio(nextSettings.rendererPixelRatio)
      renderer.setSize(window.innerWidth, window.innerHeight)
      actions.push('updated renderer pixel ratio')
    }

    if (interiorLodChanged || vcockpitBindingChanged || cockpitTextureChanged) {
      if (cockpitCameraController.isActive()) {
        await reloadCockpitInteriorWithActiveSettings()
        actions.push('reloaded cockpit interior')
      } else {
        invalidateCachedCockpitInterior()
        actions.push('queued cockpit settings for next cockpit load')
      }
    }

    if (extraQueryChanged) {
      actions.push('saved extra query for next load')
    }

    if (skipGaugeSettingSeedChanged) {
      actions.push('saved gauge setting seed mode for next load')
    }

    return actions.length > 0 ? actions.join(', ') : 'Saved settings.'
  }

  handleViewerSettingsApplied = applyViewerSettingsToLoadedAircraft

  installViewerDevApi({
    packageRoot,
    packageData,
    aircraft,
    scene,
    renderer,
    camera,
    controls,
    rendererInfo,
    getEffectiveSearchParams: () => effectiveSearchParams,
    getCompiledBehaviors: () => compiledBehaviors,
    getLoadedModel: () => loadedModel,
    getRuntime: () => runtime,
    getRuntimeHost: () => runtimeHost,
    getRuntimeState: () => runtimeState,
    getFpsSnapshot: () => fpsCounter.getSnapshot(),
    getSettingsSnapshot: () => createViewerRuntimeSettingsSnapshot(effectiveSearchParams),
    getCockpitPerfDiagnostics: () => cockpitPerfDiagnostics,
    cockpitInteractionStats,
    getCockpitInteractionPickRegistry: () =>
      getCockpitInteractionPickRegistry(loadedModel.scene, runtime),
    getCockpitCameraController: () => cockpitCameraController,
    getCockpitBenchmarkState: () =>
      ((globalThis as Record<string, unknown>).__cockpitBenchmark as {
        readonly getState?: () => Record<string, unknown>
      } | undefined)?.getState?.() ?? {},
    runCockpitBenchmark: async options => runCockpitBenchmark(options),
    applySettings: async settings => {
      const nextStore = loadViewerConfigStore()
      const key = getViewerAircraftConfigKey(packageRoot, aircraft.id)
      const previousProfile = nextStore.aircraft[key] ?? {}
      const nextProfile: ViewerConfigProfile = {
        ...previousProfile,
        ...settings,
        packageRoot,
        aircraftId: aircraft.id
      }
      saveViewerConfigStore({
        ...nextStore,
        aircraft: {
          ...nextStore.aircraft,
          [key]: nextProfile
        }
      })
      return applyViewerSettingsToLoadedAircraft({
        scope: 'aircraft',
        action: 'apply',
        selectedPackageRoot: packageRoot,
        selectedAircraftId: aircraft.id
      })
    }
  })

  const handleResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  }

  window.addEventListener('resize', handleResize)
  let nextOverlayUpdateMs = 0

  renderer.setAnimationLoop(() => {
    if (cockpitPerfDiagnostics.enabled) {
      const frameStartMs = performance.now()
      const dtSeconds = clock.getDelta()
      fpsCounter.recordFrame(dtSeconds)
      const runtimeStartMs = performance.now()
      runtimeState = runtime.update(dtSeconds, { profile: true })
      const runtimeEndMs = performance.now()
      const runtimeProfile = runtime.getLastUpdateProfile()
      ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
      syncRuntimeMaterialState(runtimeMaterialState, runtimeHost)
      const cameraStartMs = performance.now()
      cockpitCameraController.update()
      if (!cockpitCameraController.isActive()) {
        controls.update()
      }
      updateCameraDepthClipController()
      const cameraEndMs = performance.now()
      const vcockpitStartMs = performance.now()
      loadedModel.interior?.vcockpitBinding?.update(
        performance.now(),
        camera,
        renderer.domElement
      )
      const vcockpitEndMs = performance.now()
      updateCockpitInteractionHitboxHelpers()
      const renderStartMs = performance.now()
      renderPasses.render()
      const renderEndMs = performance.now()
      cockpitPerfDiagnostics.recordFrame({
        marker: consumeCockpitPerfFrameMarker(),
        cockpitActive: cockpitCameraController.isActive(),
        loadedInteriorLodIndex: loadedModel.interior?.loadedLodIndex ?? null,
        frameMs: renderEndMs - frameStartMs,
        runtimeMs: runtimeEndMs - runtimeStartMs,
        runtimeProfile,
        cameraMs: cameraEndMs - cameraStartMs,
        vcockpitMs: vcockpitEndMs - vcockpitStartMs,
        renderMs: renderEndMs - renderStartMs,
        rendererCalls: renderer.info.render.calls,
        rendererTriangles: renderer.info.render.triangles,
        rendererLines: renderer.info.render.lines,
        rendererPoints: renderer.info.render.points,
        rendererTextures: renderer.info.memory.textures,
        rendererGeometries: renderer.info.memory.geometries
      })
    } else {
      const dtSeconds = clock.getDelta()
      fpsCounter.recordFrame(dtSeconds)
      runtimeState = runtime.update(dtSeconds)
      ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
      syncRuntimeMaterialState(runtimeMaterialState, runtimeHost)
      cockpitCameraController.update()
      if (!cockpitCameraController.isActive()) {
        controls.update()
      }
      updateCameraDepthClipController()
      loadedModel.interior?.vcockpitBinding?.update(
        performance.now(),
        camera,
        renderer.domElement
      )
      updateCockpitInteractionHitboxHelpers()
      renderPasses.render()
    }
    const nowMs = performance.now()
    if (nowMs >= nextOverlayUpdateMs) {
      nextOverlayUpdateMs = nowMs + 250
      updateOverlay(
        overlay,
        packageRoot,
        packageData,
        aircraft,
        compiledBehaviors,
        runtimeState,
        rendererInfo,
        fpsCounter.getSnapshot()
      )
    }
  })
}


type CockpitPerfFrameSample = {
  readonly marker: string | null
  readonly cockpitActive: boolean
  readonly loadedInteriorLodIndex: number | null
  readonly frameMs: number
  readonly runtimeMs: number
  readonly runtimeProfile: RuntimeUpdateProfile | null
  readonly cameraMs: number
  readonly vcockpitMs: number
  readonly renderMs: number
  readonly rendererCalls: number
  readonly rendererTriangles: number
  readonly rendererLines: number
  readonly rendererPoints: number
  readonly rendererTextures: number
  readonly rendererGeometries: number
}

export type CockpitPerfDiagnostics = {
  readonly enabled: boolean
  readonly recordFrame: (sample: CockpitPerfFrameSample) => void
  readonly getSummary: () => Record<string, unknown>
  readonly getActiveInteriorStats: () => Record<string, unknown> | null
  readonly getPanelSurfaceStats: () => Record<string, unknown>
  readonly reset: () => void
}

function createCockpitPerfDiagnostics(
  aircraft: ImportedAircraft,
  getLoadedModel: () => LoadedAircraftModel
): CockpitPerfDiagnostics {
  const samples: CockpitPerfFrameSample[] = []
  const maxSamples = 240

  return {
    enabled: true,
    recordFrame: sample => {
      samples.push(sample)
      if (samples.length > maxSamples) {
        samples.shift()
      }
    },
    getSummary: () => summarizeCockpitPerfSamples(samples),
    getActiveInteriorStats: () => {
      const interior = getLoadedModel().interior
      return interior == null ? null : collectLoadedComponentStats(interior)
    },
    getPanelSurfaceStats: () => collectPanelSurfaceStats(aircraft),
    reset: () => {
      samples.length = 0
    }
  }
}

function createDisabledCockpitPerfDiagnostics(
  aircraft: ImportedAircraft,
  getLoadedModel: () => LoadedAircraftModel
): CockpitPerfDiagnostics {
  return {
    enabled: false,
    recordFrame: () => {},
    getSummary: () => ({ enabled: false }),
    getActiveInteriorStats: () => {
      const interior = getLoadedModel().interior
      return interior == null ? null : collectLoadedComponentStats(interior)
    },
    getPanelSurfaceStats: () => collectPanelSurfaceStats(aircraft),
    reset: () => {}
  }
}

function summarizeCockpitPerfSamples(samples: readonly CockpitPerfFrameSample[]): Record<string, unknown> {
  const activeSamples = samples.filter(sample => sample.cockpitActive)
  const sourceSamples = activeSamples.length > 0 ? activeSamples : samples
  return {
    sampleCount: sourceSamples.length,
    cockpitSampleCount: activeSamples.length,
    latest: sourceSamples.at(-1) ?? null,
    frameMs: summarizeNumericSamples(sourceSamples.map(sample => sample.frameMs)),
    runtimeMs: summarizeNumericSamples(sourceSamples.map(sample => sample.runtimeMs)),
    runtimeProfile: summarizeRuntimeUpdateProfiles(
      sourceSamples
        .map(sample => sample.runtimeProfile)
        .filter(profile => profile != null)
    ),
    cameraMs: summarizeNumericSamples(sourceSamples.map(sample => sample.cameraMs)),
    vcockpitMs: summarizeNumericSamples(sourceSamples.map(sample => sample.vcockpitMs)),
    renderMs: summarizeNumericSamples(sourceSamples.map(sample => sample.renderMs)),
    markedFrames: summarizeMarkedCockpitPerfFrames(sourceSamples),
    slowestFrames: summarizeSlowestCockpitPerfFrames(sourceSamples),
    rendererCalls: summarizeNumericSamples(sourceSamples.map(sample => sample.rendererCalls)),
    rendererTriangles: summarizeNumericSamples(sourceSamples.map(sample => sample.rendererTriangles)),
    rendererTextures: sourceSamples.at(-1)?.rendererTextures ?? null,
    rendererGeometries: sourceSamples.at(-1)?.rendererGeometries ?? null
  }
}

function summarizeMarkedCockpitPerfFrames(
  samples: readonly CockpitPerfFrameSample[]
): Record<string, unknown> {
  const samplesByMarker = new Map<string, CockpitPerfFrameSample[]>()
  for (const sample of samples) {
    if (sample.marker == null) {
      continue
    }
    const markerSamples = samplesByMarker.get(sample.marker) ?? []
    markerSamples.push(sample)
    samplesByMarker.set(sample.marker, markerSamples)
  }

  return Object.fromEntries(
    [...samplesByMarker.entries()].map(([marker, markerSamples]) => [
      marker,
      {
        sampleCount: markerSamples.length,
        frameMs: summarizeNumericSamples(markerSamples.map(sample => sample.frameMs)),
        runtimeMs: summarizeNumericSamples(markerSamples.map(sample => sample.runtimeMs)),
        vcockpitMs: summarizeNumericSamples(markerSamples.map(sample => sample.vcockpitMs)),
        renderMs: summarizeNumericSamples(markerSamples.map(sample => sample.renderMs))
      }
    ])
  )
}

function summarizeSlowestCockpitPerfFrames(
  samples: readonly CockpitPerfFrameSample[]
): readonly Record<string, unknown>[] {
  return [...samples]
    .sort((left, right) => right.frameMs - left.frameMs)
    .slice(0, 8)
    .map(sample => ({
      marker: sample.marker,
      loadedInteriorLodIndex: sample.loadedInteriorLodIndex,
      frameMs: sample.frameMs,
      runtimeMs: sample.runtimeMs,
      runtimeProfile: sample.runtimeProfile,
      cameraMs: sample.cameraMs,
      vcockpitMs: sample.vcockpitMs,
      renderMs: sample.renderMs,
      rendererCalls: sample.rendererCalls
    }))
}

function summarizeRuntimeUpdateProfiles(
  profiles: readonly RuntimeUpdateProfile[]
): Record<string, unknown> | null {
  if (profiles.length === 0) {
    return null
  }

  const latest = profiles.at(-1)!
  return {
    latest,
    totalMs: summarizeNumericSamples(profiles.map(profile => profile.totalMs)),
    hostTickMs: summarizeNumericSamples(profiles.map(profile => profile.hostTickMs)),
    updateBindingsMs: summarizeNumericSamples(profiles.map(profile => profile.updateBindingsMs)),
    interactionFeedbackMs: summarizeNumericSamples(profiles.map(profile => profile.interactionFeedbackMs)),
    animationMs: summarizeNumericSamples(profiles.map(profile => profile.animationMs)),
    mixerMs: summarizeNumericSamples(profiles.map(profile => profile.mixerMs)),
    wingFlexMs: summarizeNumericSamples(profiles.map(profile => profile.wingFlexMs)),
    visibilityMs: summarizeNumericSamples(profiles.map(profile => profile.visibilityMs)),
    materialMs: summarizeNumericSamples(profiles.map(profile => profile.materialMs)),
    bindingCounts: {
      animation: latest.animationBindingCount,
      visibility: latest.visibilityBindingCount,
      material: latest.materialBindingCount,
      update: latest.updateBindingCount
    }
  }
}

function summarizeNumericSamples(values: readonly number[]): Record<string, number | null> {
  if (values.length === 0) {
    return { min: null, median: null, p95: null, max: null, average: null }
  }

  const sorted = [...values].sort((left, right) => left - right)
  const sum = values.reduce((total, value) => total + value, 0)
  return {
    min: sorted[0]!,
    median: sorted[Math.floor(sorted.length * 0.5)]!,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
    max: sorted.at(-1)!,
    average: sum / values.length
  }
}

function collectLoadedComponentStats(component: LoadedModelComponent): Record<string, unknown> {
  return {
    ...collectModelRenderStats(component.scene),
    loadedLodIndex: component.loadedLodIndex,
    loadDiagnostics: component.loadDiagnostics,
    resourceStats: component.resourceStats ?? collectModelResourceStats(component.scene),
    vcockpitBinding:
      component.vcockpitBinding == null
        ? null
        : {
            surfaceCount: component.vcockpitBinding.surfaces.length,
            boundSurfaceCount: component.vcockpitBinding.boundSurfaceCount,
            gaugeMode: component.vcockpitBinding.gaugeMode,
            videoFps: component.vcockpitBinding.videoFps,
            rasterScale: component.vcockpitBinding.rasterScale,
            htmlGaugeCount: component.vcockpitBinding.htmlGaugeCount,
            loadedHtmlGaugeCount: component.vcockpitBinding.loadedHtmlGaugeCount,
            capturedHtmlGaugeCount: component.vcockpitBinding.capturedHtmlGaugeCount,
            diagnostics: component.vcockpitBinding.diagnostics
          }
  }
}

function collectPanelSurfaceStats(aircraft: ImportedAircraft): Record<string, unknown> {
  const panelFiles = aircraft.cfgFiles.filter(file => file.kind === 'panel')
  const vcockpitSurfaces = panelFiles.flatMap(file =>
    file.sections
      .filter(section => /^vcockpit\d+$/iu.test(section.name))
      .map(section => collectPanelSectionSurfaceStats(file.path, section, 'VCockpit'))
  )
  const paintingSurfaces = panelFiles.flatMap(file =>
    file.sections
      .filter(section => /^vpainting\d+$/iu.test(section.name))
      .map(section => collectPanelSectionSurfaceStats(file.path, section, 'VPainting'))
  )

  return {
    panelFileCount: panelFiles.length,
    panelFiles: panelFiles.map(file => file.path),
    vcockpitSurfaceCount: vcockpitSurfaces.length,
    vcockpitRenderableSurfaceCount: vcockpitSurfaces.filter(surface => surface.texture !== 'NO_TEXTURE')
      .length,
    htmlGaugeCount: vcockpitSurfaces.reduce((total, surface) => total + surface.htmlGaugeCount, 0),
    gaugeCount: vcockpitSurfaces.reduce((total, surface) => total + surface.gaugeCount, 0),
    paintingSurfaceCount: paintingSurfaces.length,
    paintingCount: paintingSurfaces.reduce((total, surface) => total + surface.paintingCount, 0),
    vcockpitSurfaces,
    paintingSurfaces
  }
}

function collectPanelSectionSurfaceStats(
  panelPath: string,
  section: ImportedCfgSection,
  kind: 'VCockpit' | 'VPainting'
): {
  readonly kind: 'VCockpit' | 'VPainting'
  readonly panelPath: string
  readonly section: string
  readonly texture: string | null
  readonly sizeMm: string | null
  readonly pixelSize: string | null
  readonly htmlGaugeCount: number
  readonly gaugeCount: number
  readonly paintingCount: number
  readonly htmlGauges: readonly string[]
  readonly gauges: readonly string[]
  readonly paintings: readonly string[]
} {
  const entries = [...section.values.entries()]
  const htmlGauges = entries
    .filter(([key]) => /^htmlgauge\d+$/iu.test(key))
    .map(([, value]) => value)
  const gauges = entries
    .filter(([key]) => /^gauge\d+$/iu.test(key))
    .map(([, value]) => value)
  const paintings = entries
    .filter(([key]) => /^painting\d+$/iu.test(key))
    .map(([, value]) => value)

  return {
    kind,
    panelPath,
    section: section.name,
    texture: normalizeCfgValue(section.values.get('texture')),
    sizeMm: normalizeCfgValue(section.values.get('size_mm')),
    pixelSize: normalizeCfgValue(section.values.get('pixel_size')),
    htmlGaugeCount: htmlGauges.length,
    gaugeCount: gauges.length,
    paintingCount: paintings.length,
    htmlGauges,
    gauges,
    paintings
  }
}

function collectModelRenderStats(root: Object3D): Record<string, unknown> {
  const geometries = new Set<NonNullable<Mesh['geometry']>>()
  const materials = new Set<Material>()
  let meshCount = 0
  let visibleMeshCount = 0
  let skinnedMeshCount = 0
  let morphTargetMeshCount = 0
  let blendGBufferMeshCount = 0
  let transparentMeshCount = 0
  let namedMeshCount = 0
  let unnamedMeshCount = 0
  let staticMergeCandidateCount = 0
  let staticMergeCandidateTriangles = 0
  const staticMergeCandidateMaterialCounts = new Map<Material, number>()
  let triangleCount = 0
  let indexedTriangleCount = 0
  let nonIndexedTriangleCount = 0
  let vertexCount = 0
  let drawCallEstimate = 0

  root.updateWorldMatrix(true, true)
  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    meshCount += 1
    if (object.visible) {
      visibleMeshCount += 1
    }
    if ((object as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
      skinnedMeshCount += 1
    }
    if (object.morphTargetInfluences != null && object.morphTargetInfluences.length > 0) {
      morphTargetMeshCount += 1
    }
    if (object.name) {
      namedMeshCount += 1
    } else {
      unnamedMeshCount += 1
    }

    const materialList = Array.isArray(object.material) ? object.material : [object.material]
    if (object.visible) {
      drawCallEstimate += Math.max(1, materialList.filter(material => material != null).length)
    }
    let hasBlendGBufferMaterial = false
    let hasTransparentMaterial = false
    for (const material of materialList) {
      if (material != null) {
        materials.add(material)
        if (usesBlendGBufferMaterial(material)) {
          hasBlendGBufferMaterial = true
        }
        if (material.transparent) {
          hasTransparentMaterial = true
        }
      }
    }
    if (hasBlendGBufferMaterial) {
      blendGBufferMeshCount += 1
    }
    if (hasTransparentMaterial) {
      transparentMeshCount += 1
    }

    const geometry = object.geometry
    if (geometry == null || geometries.has(geometry)) {
      return
    }
    geometries.add(geometry)

    const position = geometry.getAttribute('position')
    const geometryVertexCount = position?.count ?? 0
    if (!object.visible) {
      return
    }
    vertexCount += geometryVertexCount
    let geometryTriangles = 0
    if (geometry.index != null) {
      geometryTriangles = Math.floor(geometry.index.count / 3)
      indexedTriangleCount += geometryTriangles
      triangleCount += geometryTriangles
    } else {
      geometryTriangles = Math.floor(geometryVertexCount / 3)
      nonIndexedTriangleCount += geometryTriangles
      triangleCount += geometryTriangles
    }

    if (
      !hasBlendGBufferMaterial &&
      !hasTransparentMaterial &&
      materialList.length === 1 &&
      materialList[0] != null &&
      (object as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh !== true &&
      (object.morphTargetInfluences == null || object.morphTargetInfluences.length === 0)
    ) {
      staticMergeCandidateCount += 1
      staticMergeCandidateTriangles += geometryTriangles
      staticMergeCandidateMaterialCounts.set(
        materialList[0],
        (staticMergeCandidateMaterialCounts.get(materialList[0]) ?? 0) + 1
      )
    }
  })

  return {
    meshCount,
    visibleMeshCount,
    geometryCount: geometries.size,
    materialCount: materials.size,
    drawCallEstimate,
    skinnedMeshCount,
    morphTargetMeshCount,
    blendGBufferMeshCount,
    transparentMeshCount,
    namedMeshCount,
    unnamedMeshCount,
    staticMergeCandidateCount,
    staticMergeCandidateTriangles,
    staticMergeCandidateMaterialGroups: staticMergeCandidateMaterialCounts.size,
    largestStaticMergeGroupSize: Math.max(0, ...staticMergeCandidateMaterialCounts.values()),
    vertexCount,
    triangleCount,
    indexedTriangleCount,
    nonIndexedTriangleCount
  }
}

function collectModelResourceStats(root: Object3D): ModelResourceStats {
  const resources = collectSceneResources(root)
  let geometryAttributeBytes = 0
  let geometryIndexBytes = 0
  let textureKnownBytes = 0
  let textureEstimatedBytes = 0

  for (const geometry of resources.geometries) {
    for (const attribute of Object.values(geometry.attributes)) {
      geometryAttributeBytes += getBufferAttributeByteLength(attribute)
    }

    for (const morphAttributes of Object.values(geometry.morphAttributes)) {
      for (const attribute of morphAttributes) {
        geometryAttributeBytes += getBufferAttributeByteLength(attribute)
      }
    }

    if (geometry.index != null) {
      geometryIndexBytes += getBufferAttributeByteLength(geometry.index)
    }
  }

  for (const texture of resources.textures) {
    const textureBytes = estimateTextureByteSize(texture)
    textureKnownBytes += textureBytes.knownBytes
    textureEstimatedBytes += textureBytes.estimatedBytes
  }

  return {
    geometryCount: resources.geometries.size,
    materialCount: resources.materials.size,
    textureCount: resources.textures.size,
    geometryAttributeBytes,
    geometryIndexBytes,
    textureKnownBytes,
    textureEstimatedBytes,
    totalKnownBytes: geometryAttributeBytes + geometryIndexBytes + textureKnownBytes,
    totalEstimatedBytes: geometryAttributeBytes + geometryIndexBytes + textureEstimatedBytes
  }
}

function getBufferAttributeByteLength(attribute: unknown): number {
  const array = (attribute as { readonly array?: ArrayBufferView | null }).array
  return array?.byteLength ?? 0
}

function estimateTextureByteSize(texture: Texture): {
  readonly knownBytes: number
  readonly estimatedBytes: number
} {
  const textureRecord = texture as unknown as {
    readonly image?: unknown
    readonly mipmaps?: readonly unknown[]
  }
  const knownFromMipmaps = sumTextureImageByteLengths(textureRecord.mipmaps ?? [])
  if (knownFromMipmaps > 0) {
    return {
      knownBytes: knownFromMipmaps,
      estimatedBytes: knownFromMipmaps
    }
  }

  const knownFromImage = sumTextureImageByteLengths([textureRecord.image])
  if (knownFromImage > 0) {
    return {
      knownBytes: knownFromImage,
      estimatedBytes: knownFromImage
    }
  }

  return {
    knownBytes: 0,
    estimatedBytes: estimateTextureImageByteLength(textureRecord.image)
  }
}

function sumTextureImageByteLengths(images: readonly unknown[]): number {
  return images.reduce<number>((total, image) => total + getTextureImageByteLength(image), 0)
}

function getTextureImageByteLength(image: unknown): number {
  if (Array.isArray(image)) {
    return sumTextureImageByteLengths(image)
  }

  if (image == null || typeof image !== 'object') {
    return 0
  }

  const record = image as {
    readonly data?: { readonly byteLength?: number } | ArrayBufferView | null
    readonly mipmaps?: readonly unknown[]
  }
  const dataByteLength =
    record.data == null
      ? 0
      : 'byteLength' in record.data && typeof record.data.byteLength === 'number'
        ? record.data.byteLength
        : 0
  return dataByteLength + sumTextureImageByteLengths(record.mipmaps ?? [])
}

function estimateTextureImageByteLength(image: unknown): number {
  if (Array.isArray(image)) {
    return image.reduce((total, item) => total + estimateTextureImageByteLength(item), 0)
  }

  if (image == null || typeof image !== 'object') {
    return 0
  }

  const record = image as {
    readonly width?: number
    readonly height?: number
    readonly mipmaps?: readonly unknown[]
  }
  const mipmapEstimate = record.mipmaps?.reduce<number>(
    (total, mipmap) => total + estimateTextureImageByteLength(mipmap),
    0
  )
  if (mipmapEstimate != null && mipmapEstimate > 0) {
    return mipmapEstimate
  }

  if (typeof record.width !== 'number' || typeof record.height !== 'number') {
    return 0
  }

  return Math.max(0, record.width) * Math.max(0, record.height) * 4
}

type RuntimeFrostMaterialState = {
  readonly material: Material & {
    opacity?: number
    visible?: boolean
    transparent?: boolean
    needsUpdate?: boolean
    userData?: {
      msfsBaseOpacity?: number
    }
  }
  readonly baseOpacity: number
}

type RuntimeMaterialState = {
  readonly frostedMaterials: readonly RuntimeFrostMaterialState[]
}

function collectRuntimeMaterialState(root: Group): RuntimeMaterialState {
  const seenMaterials = new Set<Material>()
  const frostedMaterials: RuntimeFrostMaterialState[] = []

  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const materials = Array.isArray(object.material)
      ? object.material
      : object.material != null
        ? [object.material]
        : []

    for (const material of materials) {
      if (material == null || seenMaterials.has(material)) {
        continue
      }
      seenMaterials.add(material)

      if (!usesGeoDecalFrostedMaterial(material)) {
        continue
      }

      const typedMaterial = material as RuntimeFrostMaterialState['material']
      typedMaterial.userData ??= {}
      const baseOpacity = typedMaterial.userData.msfsBaseOpacity ?? typedMaterial.opacity ?? 1
      typedMaterial.userData.msfsBaseOpacity = baseOpacity
      frostedMaterials.push({
        material: typedMaterial,
        baseOpacity
      })
    }
  })

  return {
    frostedMaterials
  }
}

function syncRuntimeMaterialState(
  materialState: RuntimeMaterialState,
  runtimeHost: SharedMsfsRuntimeHost
): void {
  const structuralIce = clamp01(
    runtimeHost.readVariable('A:STRUCTURAL ICE PCT', 'percent over 100')
  )

  for (const frostState of materialState.frostedMaterials) {
    const { material, baseOpacity } = frostState
    const nextOpacity = baseOpacity * structuralIce
    const nextVisible = structuralIce > 0.0001
    const opacityChanged = material.opacity !== nextOpacity
    const visibilityChanged = material.visible !== nextVisible

    if (!opacityChanged && !visibilityChanged) {
      continue
    }

    material.opacity = nextOpacity
    material.visible = nextVisible
    material.needsUpdate = true
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function createCockpitTextureLoadOptions(
  searchParams: URLSearchParams,
  options: {
    readonly immediatePlaceholder?: boolean
    readonly defaultRangeMaxTextureSize?: number
  } = {}
): MSFSDDSLoadOptions {
  if (getCockpitTextureMode(searchParams) === 'range-low') {
    return {
      rangeMaxTextureSize: getCockpitRangeTextureSize(
        searchParams,
        options.defaultRangeMaxTextureSize
      ),
      rangeFallback: 'full',
      immediatePlaceholder: options.immediatePlaceholder
    }
  }

  return {}
}

function getCockpitTextureMode(searchParams: URLSearchParams): CockpitTextureMode {
  return searchParams.get('cockpitTextures') === 'full' ? 'full' : 'range-low'
}

function shouldLoadCockpitRangeTextures(searchParams: URLSearchParams): boolean {
  return getCockpitTextureMode(searchParams) === 'range-low'
}

function shouldBindVCockpitSurfaces(searchParams: URLSearchParams): boolean {
  return searchParams.get('vcockpitSurfaces') !== 'off'
}

function shouldLiveRefreshVCockpitGauges(searchParams: URLSearchParams): boolean {
  return searchParams.get('vcockpitLiveGauges') !== 'off'
}

function getVCockpitGaugeMode(searchParams: URLSearchParams): VCockpitGaugeModeRequest {
  const mode = searchParams.get('vcockpitGaugeMode')
  return mode === 'overlay' || mode === 'video' || mode === 'htmlTexture' ? mode : 'texture'
}

function getConfigurableVCockpitGaugeMode(searchParams: URLSearchParams): VCockpitGaugeMode {
  const mode = getVCockpitGaugeMode(searchParams)
  return mode === 'htmlTexture' ? 'texture' : mode
}

function getVCockpitGaugeVideoFps(searchParams: URLSearchParams): number {
  const parsed = parsePositiveQueryNumber(searchParams.get('vcockpitGaugeVideoFps'))
  if (parsed == null) {
    return 15
  }

  return Math.min(60, Math.max(1, parsed))
}

function getVCockpitGaugeCaptureFps(searchParams: URLSearchParams): number {
  const parsed =
    parsePositiveQueryNumber(searchParams.get('vcockpitGaugeCaptureFps')) ??
    parsePositiveQueryNumber(searchParams.get('vcockpitGaugeCaptureHz'))
  if (parsed == null) {
    return VCOCKPIT_HTML_GAUGE_DEFAULT_CAPTURE_HZ
  }

  return Math.min(60, Math.max(1, parsed))
}

function getVCockpitGaugeRasterScale(searchParams: URLSearchParams): number {
  const parsed = parsePositiveQueryNumber(searchParams.get('vcockpitGaugeRasterScale'))
  if (parsed == null) {
    return VCOCKPIT_HTML_GAUGE_DEFAULT_RASTER_SCALE
  }

  return Math.min(1, Math.max(0.25, parsed))
}

function shouldUpdateVCockpitGaugesOutside(searchParams: URLSearchParams): boolean {
  return isEnabledFlagSearchParam(searchParams, 'vcockpitGaugeUpdateOutside')
}

function getVCockpitGaugeUpdateThrottleMs(searchParams: URLSearchParams): number | null {
  const rawMilliseconds = searchParams.get('vcockpitGaugeUpdateMs')
  const explicitMilliseconds = parsePositiveQueryNumber(rawMilliseconds)
  if (explicitMilliseconds != null) {
    return Math.min(5000, Math.max(16, explicitMilliseconds))
  }
  if (isExplicitlyDisabledQueryValue(rawMilliseconds)) {
    return 0
  }

  const rawHertz = searchParams.get('vcockpitGaugeUpdateHz')
  const explicitHertz = parsePositiveQueryNumber(rawHertz)
  if (explicitHertz != null) {
    return 1000 / Math.min(60, Math.max(0.2, explicitHertz))
  }
  if (isExplicitlyDisabledQueryValue(rawHertz)) {
    return 0
  }

  const gaugeMode = getVCockpitGaugeMode(searchParams)
  if (gaugeMode === 'texture' || gaugeMode === 'htmlTexture') {
    return 1000 / getVCockpitGaugeCaptureFps(searchParams)
  }

  return null
}

function isExplicitlyDisabledQueryValue(rawValue: string | null): boolean {
  if (rawValue == null) {
    return false
  }

  const normalized = rawValue.trim().toLowerCase()
  return normalized === '' || normalized === 'off' || normalized === 'false' || normalized === '0'
}

function parsePositiveQueryNumber(rawValue: string | null): number | null {
  if (rawValue == null) {
    return null
  }

  const normalized = rawValue.trim().toLowerCase()
  if (normalized === '' || normalized === 'off' || normalized === 'false' || normalized === '0') {
    return null
  }

  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function shouldDebugVCockpitGauges(searchParams: URLSearchParams): boolean {
  return searchParams.has('vcockpitGaugeDebug')
}

function shouldShowCockpitInteractionHitboxes(searchParams: URLSearchParams): boolean {
  return isEnabledFlagSearchParam(searchParams, 'cockpitInteractionHitboxes')
}

function isEnabledFlagSearchParam(searchParams: URLSearchParams, key: string): boolean {
  const rawValue = searchParams.get(key)
  if (rawValue == null) {
    return false
  }

  const normalized = rawValue.trim().toLowerCase()
  return normalized !== 'off' && normalized !== 'false' && normalized !== '0'
}

function getCockpitRangeTextureSize(
  searchParams: URLSearchParams,
  defaultSize = DEFAULT_COCKPIT_RANGE_TEXTURE_SIZE
): number {
  const rawSize = searchParams.get('cockpitTextureSize')
  if (rawSize == null || rawSize.trim() === '') {
    return defaultSize
  }

  const parsed = Number.parseInt(rawSize, 10)
  if (!Number.isFinite(parsed)) {
    return defaultSize
  }

  return Math.min(2048, Math.max(128, parsed))
}

function getExteriorInteriorMode(searchParams: URLSearchParams): ExteriorInteriorMode {
  const rawMode = searchParams.get('exteriorInterior')?.trim().toLowerCase()
  if (rawMode === 'off' || rawMode === 'disabled' || rawMode === 'none') {
    return 'off'
  }
  if (rawMode === 'sync' || searchParams.has('syncExteriorInterior')) {
    return 'sync'
  }

  return 'deferred'
}

function shouldSkipGaugeSettingSeed(searchParams: URLSearchParams): boolean {
  return isEnabledFlagSearchParam(searchParams, 'skipGaugeSettingSeed')
}

function resolveRequestedExteriorInteriorLodIndex(
  searchParams: URLSearchParams
): number | null {
  const rawValue = searchParams.get('exteriorInteriorLod')
  if (rawValue == null || rawValue.trim() === '' || rawValue.trim().toLowerCase() === 'auto') {
    return null
  }

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid exteriorInteriorLod query parameter "${rawValue}". Expected "auto" or a zero-based integer.`
    )
  }

  return parsed
}

function resolveRequestedInteriorLodIndex(searchParams: URLSearchParams): number | null {
  const rawValue = searchParams.get('interiorLod')
  if (rawValue == null || rawValue.trim() === '' || rawValue.trim().toLowerCase() === 'auto') {
    return null
  }

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `Invalid interiorLod query parameter "${rawValue}". Expected "auto" or a zero-based integer.`
    )
  }

  return parsed
}

const VIEWER_CONFIG_STORAGE_KEY = 'msfs.viewer.config.v1'

const PROFILE_QUERY_KEYS = [
  'package',
  'aircraft',
  'lod',
  'interiorLod',
  'exteriorInterior',
  'syncExteriorInterior',
  'exteriorInteriorLod',
  'vcockpitSurfaces',
  'vcockpitLiveGauges',
  'vcockpitGaugeMode',
  'vcockpitGaugeCaptureFps',
  'vcockpitGaugeCaptureHz',
  'vcockpitGaugeRasterScale',
  'vcockpitGaugeUpdateOutside',
  'cockpitTextures',
  'cockpitTextureSize',
  'cockpitMergeStatic',
  'cockpitInstanceStatic',
  'cockpitPerf',
  'cockpitInteractionHitboxes',
  'skipGaugeSettingSeed',
  'rendererPixelRatio'
] as const

function loadViewerConfigStore(): ViewerConfigStore {
  try {
    const rawValue = window.localStorage.getItem(VIEWER_CONFIG_STORAGE_KEY)
    if (rawValue == null) {
      return createEmptyViewerConfigStore()
    }

    const parsed = JSON.parse(rawValue) as unknown
    if (parsed == null || typeof parsed !== 'object') {
      return createEmptyViewerConfigStore()
    }

    const record = parsed as {
      readonly global?: unknown
      readonly aircraft?: unknown
    }
    return {
      version: 1,
      global: normalizeViewerConfigProfile(record.global),
      aircraft: normalizeViewerAircraftProfiles(record.aircraft)
    }
  } catch {
    return createEmptyViewerConfigStore()
  }
}

function saveViewerConfigStore(store: ViewerConfigStore): void {
  window.localStorage.setItem(VIEWER_CONFIG_STORAGE_KEY, JSON.stringify(store))
}

function createEmptyViewerConfigStore(): ViewerConfigStore {
  return {
    version: 1,
    global: {},
    aircraft: {}
  }
}

function normalizeViewerAircraftProfiles(value: unknown): Record<string, ViewerConfigProfile> {
  if (value == null || typeof value !== 'object') {
    return {}
  }

  const profiles: Record<string, ViewerConfigProfile> = {}
  for (const [key, profile] of Object.entries(value as Record<string, unknown>)) {
    profiles[key] = normalizeViewerConfigProfile(profile)
  }
  return profiles
}

function normalizeViewerConfigProfile(value: unknown): ViewerConfigProfile {
  if (value == null || typeof value !== 'object') {
    return {}
  }

  const record = value as Record<string, unknown>
  return {
    packageRoot: typeof record.packageRoot === 'string' ? record.packageRoot : undefined,
    aircraftId: typeof record.aircraftId === 'string' ? record.aircraftId : undefined,
    lod: normalizeNullableInteger(record.lod),
    interiorLod: normalizeNullableInteger(record.interiorLod),
    exteriorInteriorMode: normalizeExteriorInteriorMode(record.exteriorInteriorMode),
    exteriorInteriorLod: normalizeNullableInteger(record.exteriorInteriorLod),
    vcockpitSurfaces: normalizeOptionalBoolean(record.vcockpitSurfaces),
    vcockpitLiveGauges: normalizeOptionalBoolean(record.vcockpitLiveGauges),
    vcockpitGaugeMode: normalizeVCockpitGaugeMode(record.vcockpitGaugeMode),
    vcockpitGaugeCaptureFps: normalizeNullableNumber(record.vcockpitGaugeCaptureFps),
    vcockpitGaugeRasterScale: normalizeNullableNumber(record.vcockpitGaugeRasterScale),
    vcockpitGaugeUpdateOutside: normalizeOptionalBoolean(record.vcockpitGaugeUpdateOutside),
    cockpitTextures:
      record.cockpitTextures === 'full'
        ? 'full'
        : record.cockpitTextures === 'range-low' ? 'range-low' : undefined,
    cockpitTextureSize: normalizeNullableInteger(record.cockpitTextureSize),
    cockpitMergeStatic: normalizeOptionalBoolean(record.cockpitMergeStatic),
    cockpitInstanceStatic: normalizeOptionalBoolean(record.cockpitInstanceStatic),
    cockpitPerf: normalizeOptionalBoolean(record.cockpitPerf),
    cockpitInteractionHitboxes: normalizeOptionalBoolean(record.cockpitInteractionHitboxes),
    skipGaugeSettingSeed: normalizeOptionalBoolean(record.skipGaugeSettingSeed),
    rendererPixelRatio: normalizeNullableNumber(record.rendererPixelRatio),
    rawQuery: typeof record.rawQuery === 'string' ? record.rawQuery : undefined
  }
}

function normalizeNullableInteger(value: unknown): number | null | undefined {
  if (value == null) {
    return value === null ? null : undefined
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function normalizeNullableNumber(value: unknown): number | null | undefined {
  if (value == null) {
    return value === null ? null : undefined
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeExteriorInteriorMode(value: unknown): ExteriorInteriorMode | undefined {
  return value === 'deferred' || value === 'sync' || value === 'off' ? value : undefined
}

function normalizeVCockpitGaugeMode(value: unknown): VCockpitGaugeMode | undefined {
  return value === 'texture' || value === 'overlay' || value === 'video' ? value : undefined
}

function getViewerAircraftConfigKey(packageRoot: string, aircraftId: string): string {
  return `${ensureTrailingSlash(packageRoot)}\n${aircraftId}`
}

function createEffectiveViewerSearchParams(
  urlSearchParams: URLSearchParams,
  globalProfile: ViewerConfigProfile,
  aircraftProfile: ViewerConfigProfile | null
): URLSearchParams {
  const effectiveSearchParams = new URLSearchParams()
  applyViewerConfigProfileToSearchParams(effectiveSearchParams, globalProfile, true)
  if (aircraftProfile != null) {
    applyViewerConfigProfileToSearchParams(effectiveSearchParams, aircraftProfile, true)
  }
  overlaySearchParams(effectiveSearchParams, urlSearchParams)
  return effectiveSearchParams
}

function overlaySearchParams(target: URLSearchParams, source: URLSearchParams): void {
  for (const key of new Set(source.keys())) {
    target.delete(key)
  }

  for (const [key, value] of source) {
    target.append(key, value)
  }
}

function applyViewerConfigProfileToSearchParams(
  searchParams: URLSearchParams,
  profile: ViewerConfigProfile,
  overwrite: boolean
): void {
  applyRawQueryToSearchParams(searchParams, profile.rawQuery, overwrite)
  setProfileSearchParam(searchParams, 'package', profile.packageRoot, overwrite)
  setProfileSearchParam(searchParams, 'aircraft', profile.aircraftId, overwrite)
  setNullableIntegerSearchParam(searchParams, 'lod', profile.lod, overwrite)
  setNullableIntegerSearchParam(searchParams, 'interiorLod', profile.interiorLod, overwrite)
  setExteriorInteriorModeSearchParam(searchParams, profile.exteriorInteriorMode, overwrite)
  setNullableIntegerSearchParam(
    searchParams,
    'exteriorInteriorLod',
    profile.exteriorInteriorLod,
    overwrite
  )
  setBooleanSearchParam(searchParams, 'vcockpitSurfaces', profile.vcockpitSurfaces, overwrite, 'on', 'off')
  setBooleanSearchParam(searchParams, 'vcockpitLiveGauges', profile.vcockpitLiveGauges, overwrite, 'on', 'off')
  setProfileSearchParam(searchParams, 'vcockpitGaugeMode', profile.vcockpitGaugeMode, overwrite)
  setNullableNumberSearchParam(
    searchParams,
    'vcockpitGaugeCaptureFps',
    profile.vcockpitGaugeCaptureFps,
    overwrite
  )
  setNullableNumberSearchParam(
    searchParams,
    'vcockpitGaugeRasterScale',
    profile.vcockpitGaugeRasterScale,
    overwrite
  )
  setBooleanSearchParam(
    searchParams,
    'vcockpitGaugeUpdateOutside',
    profile.vcockpitGaugeUpdateOutside,
    overwrite,
    'on',
    'off'
  )
  setProfileSearchParam(searchParams, 'cockpitTextures', profile.cockpitTextures, overwrite)
  setNullableIntegerSearchParam(
    searchParams,
    'cockpitTextureSize',
    profile.cockpitTextureSize,
    overwrite
  )
  setFlagSearchParam(searchParams, 'cockpitMergeStatic', profile.cockpitMergeStatic, overwrite)
  setFlagSearchParam(searchParams, 'cockpitInstanceStatic', profile.cockpitInstanceStatic, overwrite)
  setFlagSearchParam(searchParams, 'cockpitPerf', profile.cockpitPerf, overwrite)
  setFlagSearchParam(
    searchParams,
    'cockpitInteractionHitboxes',
    profile.cockpitInteractionHitboxes,
    overwrite
  )
  setFlagSearchParam(searchParams, 'skipGaugeSettingSeed', profile.skipGaugeSettingSeed, overwrite)
  setNullableNumberSearchParam(
    searchParams,
    'rendererPixelRatio',
    profile.rendererPixelRatio,
    overwrite
  )
}

function applyRawQueryToSearchParams(
  searchParams: URLSearchParams,
  rawQuery: string | undefined,
  overwrite: boolean
): void {
  if (rawQuery == null || rawQuery.trim() === '') {
    return
  }

  for (const line of rawQuery.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    const key = separatorIndex < 0 ? trimmed : trimmed.slice(0, separatorIndex).trim()
    const value = separatorIndex < 0 ? '' : trimmed.slice(separatorIndex + 1).trim()
    if (key === '' || (!overwrite && searchParams.has(key))) {
      continue
    }

    searchParams.set(key, value)
  }
}

function setProfileSearchParam(
  searchParams: URLSearchParams,
  key: string,
  value: string | null | undefined,
  overwrite: boolean
): void {
  if (value == null || value === '') {
    return
  }
  if (!overwrite && searchParams.has(key)) {
    return
  }
  searchParams.set(key, value)
}

function setNullableIntegerSearchParam(
  searchParams: URLSearchParams,
  key: string,
  value: number | null | undefined,
  overwrite: boolean
): void {
  if (value === null) {
    if (overwrite) {
      searchParams.delete(key)
    }
    return
  }
  if (value == null) {
    return
  }
  setProfileSearchParam(searchParams, key, String(value), overwrite)
}

function setNullableNumberSearchParam(
  searchParams: URLSearchParams,
  key: string,
  value: number | null | undefined,
  overwrite: boolean
): void {
  if (value === null) {
    if (overwrite) {
      searchParams.delete(key)
    }
    return
  }
  if (value == null) {
    return
  }
  setProfileSearchParam(searchParams, key, String(value), overwrite)
}

function setBooleanSearchParam(
  searchParams: URLSearchParams,
  key: string,
  value: boolean | undefined,
  overwrite: boolean,
  trueValue: string,
  falseValue: string
): void {
  if (value == null || (!overwrite && searchParams.has(key))) {
    return
  }
  searchParams.set(key, value ? trueValue : falseValue)
}

function setFlagSearchParam(
  searchParams: URLSearchParams,
  key: string,
  value: boolean | undefined,
  overwrite: boolean
): void {
  if (value == null || (!overwrite && searchParams.has(key))) {
    return
  }
  if (value) {
    searchParams.set(key, '')
  } else if (overwrite) {
    searchParams.set(key, 'off')
  }
}

function setExteriorInteriorModeSearchParam(
  searchParams: URLSearchParams,
  value: ExteriorInteriorMode | undefined,
  overwrite: boolean
): void {
  if (value == null || (!overwrite && (searchParams.has('exteriorInterior') || searchParams.has('syncExteriorInterior')))) {
    return
  }

  searchParams.delete('syncExteriorInterior')
  if (value === 'sync') {
    searchParams.set('exteriorInterior', 'sync')
  } else if (value === 'off') {
    searchParams.set('exteriorInterior', 'off')
  } else {
    searchParams.delete('exteriorInterior')
  }
}

function createAircraftModelLoadContext(
  aircraft: ImportedAircraft,
  packageRootUrl: string,
  layoutPaths: readonly string[],
  additionalAssetRoots: readonly AssetRoot[],
  rendererInfo: RendererInfo
): AircraftModelLoadContext {
  const textureUrlResolver = createTextureUrlResolver(
    aircraft,
    packageRootUrl,
    layoutPaths,
    additionalAssetRoots
  )
  const decodeNormalSources = rendererInfo.hasBcTextureCompression === false

  return {
    aircraft,
    createLoader: options =>
      createMsfsGltfLoader({
        urlResolver: textureUrlResolver,
        decodeNormalSources,
        textureLoadOptions: options?.textureLoadOptions ?? createDefaultModelTextureLoadOptions()
      }),
    createNodeMaterial: createNodeMaterialFactory(rendererInfo.renderer),
    resolvePanelAssetUrl: createPanelAssetUrlResolver(
      packageRootUrl,
      layoutPaths,
      additionalAssetRoots
    )
  }
}

async function loadAircraftGltf(
  context: AircraftModelLoadContext,
  options: {
    readonly preferredLodIndex?: number | null
    readonly loadExteriorInterior?: boolean
    readonly exteriorInteriorPreferredLodIndex?: number | null
    readonly bindVCockpitSurfaces?: boolean
    readonly liveVCockpitGauges?: boolean
    readonly vcockpitGaugeMode?: VCockpitGaugeModeRequest
    readonly vcockpitGaugeVideoFps?: number
    readonly vcockpitGaugeCaptureFps?: number
    readonly vcockpitGaugeRasterScale?: number
    readonly debugVCockpitGauges?: boolean
    readonly runtimeHost?: SharedMsfsRuntimeHost
  } = {}
): Promise<LoadedAircraftModel> {
  const { aircraft } = context
  if (aircraft.model == null) {
    throw new Error(`Aircraft ${aircraft.id} does not have a model to load.`)
  }

  const exterior = await loadAircraftModelComponent(context, aircraft.model, {
    kind: 'exterior',
    preferredLodIndex: options.preferredLodIndex ?? null,
    runtimeHost: options.runtimeHost
  })
  const interior =
    options.loadExteriorInterior === true &&
    aircraft.interiorModel != null &&
    aircraft.model.modelOptions.withExteriorShowInterior
      ? await loadAircraftModelComponent(context, aircraft.interiorModel, {
          kind: 'interior',
          preferredLodIndex:
            options.exteriorInteriorPreferredLodIndex ??
            (
              aircraft.model.modelOptions.withExteriorShowInteriorHideFirstLod
                ? Math.max(options.preferredLodIndex ?? 1, 1)
                : options.preferredLodIndex ?? null
            ),
          firstAllowedLodIndex: aircraft.model.modelOptions.withExteriorShowInteriorHideFirstLod
            ? 1
            : null,
          bindVCockpitSurfaces: false,
          liveVCockpitGauges: false,
          runtimeHost: options.runtimeHost
        })
      : null

  return combineLoadedAircraftModel(exterior, interior)
}

async function loadAircraftModelComponent(
  context: AircraftModelLoadContext,
  modelDefinition: ImportedModelDefinition,
  options: {
    readonly kind: LoadedModelComponent['kind']
    readonly preferredLodIndex: number | null
    readonly firstAllowedLodIndex?: number | null
    readonly fallbackToOtherLods?: boolean
    readonly textureLoadOptions?: MSFSDDSLoadOptions
    readonly stripTextures?: boolean
    readonly instanceStaticMeshes?: boolean
    readonly mergeStaticMeshes?: boolean
    readonly bindVCockpitSurfaces?: boolean
    readonly liveVCockpitGauges?: boolean
    readonly vcockpitGaugeMode?: VCockpitGaugeModeRequest
    readonly vcockpitGaugeVideoFps?: number
    readonly vcockpitGaugeCaptureFps?: number
    readonly vcockpitGaugeRasterScale?: number
    readonly debugVCockpitGauges?: boolean
    readonly runtimeHost?: SharedMsfsRuntimeHost
    readonly collectResourceStats?: boolean
    readonly behaviorSet?: CompiledBehaviorSet
    readonly prepareGltfInWorker?: boolean
    readonly waitForTextureLoads?: boolean
  }
): Promise<LoadedModelComponent> {
  const phases: ModelLoadPhase[] = []
  const componentLoadStartMs = performance.now()
  const recordPhase = (
    label: string,
    startMs: number,
    details: Record<string, unknown> | null = null
  ): void => {
    const endMs = performance.now()
    phases.push({
      label,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      details
    })
  }
  const loader = context.createLoader({
    textureLoadOptions: options.textureLoadOptions
  })
  const loaded = await loadAircraftModelDefinitionGltf(
    loader,
    context.aircraft,
    modelDefinition,
    context.createNodeMaterial,
    options.preferredLodIndex,
    options.fallbackToOtherLods ?? true,
    recordPhase,
    options.firstAllowedLodIndex ?? null,
    options.prepareGltfInWorker === true
  )
  if (options.stripTextures === true) {
    const stripStartMs = performance.now()
    stripObjectTextures(loaded.gltf.scene)
    recordPhase('component:strip-textures', stripStartMs)
  }
  if (options.instanceStaticMeshes === true && options.behaviorSet != null) {
    const instanceStartMs = performance.now()
    const { instanceStaticMsfsMeshes } = await import(
      './msfs/gltf/instanceStaticMsfsMeshes'
    )
    const instancingStats = instanceStaticMsfsMeshes(
      loaded.gltf.scene,
      options.behaviorSet
    )
    recordPhase('component:instance-static-meshes', instanceStartMs, instancingStats)
    setGlobalLoadStage({
      stage: 'gltf:lod:instance-static-meshes',
      aircraftId: context.aircraft.id,
      ...instancingStats
    })
  }
  if (options.mergeStaticMeshes === true && options.behaviorSet != null) {
    const mergeStartMs = performance.now()
    const { mergeStaticMsfsMeshes } = await import('./msfs/gltf/mergeStaticMsfsMeshes')
    const mergeStats = mergeStaticMsfsMeshes(
      loaded.gltf.scene,
      options.behaviorSet
    )
    recordPhase('component:merge-static-meshes', mergeStartMs, mergeStats)
    setGlobalLoadStage({
      stage: 'gltf:lod:merge-static-meshes',
      aircraftId: context.aircraft.id,
      ...mergeStats
    })
  }
  let vcockpitBinding: VCockpitSurfaceBindingResult | null = null
  if (options.bindVCockpitSurfaces === true && options.kind === 'interior') {
    const vcockpitStartMs = performance.now()
    vcockpitBinding = await bindVCockpitPlaceholderSurfaces(
      loaded.gltf.scene,
      context.aircraft,
      context.resolvePanelAssetUrl,
      options.liveVCockpitGauges === true,
      options.vcockpitGaugeMode ?? 'texture',
      options.vcockpitGaugeVideoFps ?? 15,
      options.vcockpitGaugeCaptureFps ?? VCOCKPIT_HTML_GAUGE_DEFAULT_CAPTURE_HZ,
      options.vcockpitGaugeRasterScale ?? 1,
      options.debugVCockpitGauges === true,
      options.runtimeHost ?? new SharedMsfsRuntimeHost([], context.aircraft)
    )
    recordPhase('component:bind-vcockpit-surfaces', vcockpitStartMs, {
      surfaceCount: vcockpitBinding.surfaces.length,
      boundSurfaceCount: vcockpitBinding.boundSurfaceCount,
      materialBindingCount: vcockpitBinding.materialBindingCount,
      gaugeMode: vcockpitBinding.gaugeMode,
      videoFps: vcockpitBinding.videoFps,
      rasterScale: vcockpitBinding.rasterScale,
      htmlGaugeCount: vcockpitBinding.htmlGaugeCount,
      loadedHtmlGaugeCount: vcockpitBinding.loadedHtmlGaugeCount,
      capturedHtmlGaugeCount: vcockpitBinding.capturedHtmlGaugeCount,
      diagnostics: vcockpitBinding.diagnostics
    })
    ;(globalThis as Record<string, unknown>).__lastVCockpitSurfaceBinding =
      vcockpitBinding
    setGlobalLoadStage({
      stage: 'gltf:lod:bind-vcockpit-surfaces',
      aircraftId: context.aircraft.id,
      surfaceCount: vcockpitBinding.surfaces.length,
      boundSurfaceCount: vcockpitBinding.boundSurfaceCount,
      materialBindingCount: vcockpitBinding.materialBindingCount,
      gaugeMode: vcockpitBinding.gaugeMode,
      videoFps: vcockpitBinding.videoFps,
      rasterScale: vcockpitBinding.rasterScale,
      htmlGaugeCount: vcockpitBinding.htmlGaugeCount,
      loadedHtmlGaugeCount: vcockpitBinding.loadedHtmlGaugeCount,
      capturedHtmlGaugeCount: vcockpitBinding.capturedHtmlGaugeCount
    })
  }
  if (options.waitForTextureLoads === true) {
    await waitForMsfsGltfLoaderIdle(loader, recordPhase)
  }
  const resourceStatsStartMs = performance.now()
  const resourceStats =
    options.collectResourceStats === true
      ? collectModelResourceStats(loaded.gltf.scene)
      : null
  if (resourceStats != null) {
    recordPhase('component:collect-resource-stats', resourceStatsStartMs, resourceStats)
  }
  const loadDiagnostics: ModelLoadDiagnostics = {
    phases,
    totalDurationMs: performance.now() - componentLoadStartMs
  }
  ;(globalThis as Record<string, unknown>).__lastMsfsModelLoadDiagnostics = {
    aircraftId: context.aircraft.id,
    kind: options.kind,
    loadedLodIndex: loaded.loadedLodIndex,
    loadDiagnostics,
    resourceStats
  }

  return {
    kind: options.kind,
    modelDefinition,
    scene: loaded.gltf.scene,
    animations: loaded.gltf.animations,
    loadedLodIndex: loaded.loadedLodIndex,
    loadDiagnostics,
    resourceStats,
    vcockpitBinding
  }
}

function stripObjectTextures(root: Object3D): void {
  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const materials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) {
      if (material != null) {
        stripMaterialTextures(material)
      }
    }
  })
}

function stripMaterialTextures(material: Material): void {
  const materialRecord = material as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(materialRecord)) {
    if (value instanceof Texture) {
      value.dispose()
      materialRecord[key] = null
    }
  }
  material.needsUpdate = true
}

export type VCockpitSurfaceBindingResult = {
  readonly surfaces: readonly VCockpitSurface[]
  readonly boundSurfaceCount: number
  readonly materialBindingCount: number
  readonly htmlGaugeCount: number
  readonly gaugeMode: VCockpitGaugeMode
  readonly videoFps: number | null
  readonly rasterScale: number
  readonly loadedHtmlGaugeCount: number
  readonly capturedHtmlGaugeCount: number
  readonly htmlGaugeRuntimes: readonly VCockpitHtmlGaugeRuntime[]
  readonly captureStats: readonly Record<string, unknown>[]
  readonly update: (
    nowMs: number,
    camera: PerspectiveCamera,
    viewportElement: HTMLElement
  ) => void
  readonly setCaptureFps: (captureFps: number) => void
  readonly setActive: (active: boolean) => void
  readonly dispose: () => void
  readonly diagnostics: readonly ImportDiagnostic[]
}

type VCockpitGaugeDirtyKind = 'dom' | 'canvas' | 'unknown'

const VCOCKPIT_HTML_GAUGE_LOAD_TIMEOUT_MS = 15000

export type VCockpitHtmlGaugeRuntime = {
  readonly surface: string
  readonly textureName: string
  readonly gaugeKey: string
  readonly gauge: VCockpitGaugeEntry | null
  readonly source: string
  readonly resolvedUrl: string | null
  readonly wasmModuleUrl: string | null
  readonly status:
    | 'loaded'
    | 'loaded-wasm-bridge'
    | 'missing'
    | 'deferred-native-wasm'
    | 'iframe-error'
    | 'unsupported-native-abi'
  iframe: HTMLIFrameElement | null
  sourceObjectUrl: string | null
  captured: boolean
  captureImage: HTMLCanvasElement | null
  captureAttemptCount: number
  lastCaptureError: string | null
  lastVisualSignature: string | null
  lastChangeVersion: number | null
  lastRenderStatus: 'pending' | 'captured' | 'skipped-clean' | 'blank' | 'error'
  lastRenderKind: VCockpitGaugeDirtyKind | 'static' | null
  pendingChangeVersion: number | null
  pendingDirtyKind: VCockpitGaugeDirtyKind | null
  needsCapture: boolean
  staticCaptureImage: HTMLCanvasElement | null
  staticCaptureSignature: string | null
}

type CachedGaugeSvgImage = {
  readonly signature: string
  image: HTMLImageElement | null
  promise: Promise<HTMLImageElement> | null
}

type CanvasOriginCleanCacheEntry = {
  readonly clean: boolean
  readonly checkedAtMs: number
}

type VCockpitSurfaceTextureRuntime = {
  readonly surface: VCockpitSurface
  readonly canvas: HTMLCanvasElement
  readonly context: CanvasRenderingContext2D
  readonly texture: Texture
  readonly canvasTexture: CanvasTexture
  readonly videoTexture: VideoTexture | null
  readonly videoElement: HTMLVideoElement | null
  readonly videoStream: MediaStream | null
  readonly videoTrack: CanvasCaptureMediaStreamTrack | null
  readonly videoFps: number | null
  captureIntervalMs: number
  readonly rasterScale: number
  readonly htmlGaugeRuntimes: VCockpitHtmlGaugeRuntime[]
  readonly liveCapture: boolean
  readonly gaugeMode: VCockpitGaugeMode
  readonly overlayObjects: Object3D[]
  readonly debugOverlay: boolean
  nextCaptureMs: number
  isCapturing: boolean
  captureCount: number
  lastCaptureDurationMs: number
  averageCaptureDurationMs: number
}

const VCOCKPIT_HTML_MAX_CAPTURE_ATTEMPTS = 6
const VCOCKPIT_HTML_GAUGE_LOAD_CONCURRENCY = 1
const VCOCKPIT_HTML_GAUGE_DOM_READY_TIMEOUT_MS = 1000
const VCOCKPIT_HTML_GAUGE_LOAD_IDLE_TIMEOUT_MS = 250
const VCOCKPIT_HTML_GAUGE_DEFAULT_CAPTURE_HZ = 8
const VCOCKPIT_HTML_GAUGE_DEFAULT_RASTER_SCALE = 0.75
const VCOCKPIT_RUNTIME_READ_MIN_INTERVAL_MS = 1000
const VCOCKPIT_SURFACE_CAPTURE_CONCURRENCY = 1
const CANVAS_ORIGIN_CLEAN_CACHE_MS = 10_000

const accessibleGaugeCssTextByDocument = new WeakMap<
  Document,
  {
    readonly styleSheetCount: number
    readonly cssText: string
  }
>()
const gaugeSvgImageCache = new WeakMap<SVGSVGElement, CachedGaugeSvgImage>()
const canvasOriginCleanCache = new WeakMap<HTMLCanvasElement, CanvasOriginCleanCacheEntry>()

let activeVCockpitHtmlGaugeLoads = 0
let activeVCockpitSurfaceTextureCaptures = 0
let canvasOriginCleanScratchCanvas: HTMLCanvasElement | null = null
let canvasOriginCleanScratchContext: CanvasRenderingContext2D | null = null
const queuedVCockpitHtmlGaugeLoads: Array<() => void> = []

function scheduleVCockpitHtmlGaugeRuntimeLoad(
  task: () => Promise<VCockpitHtmlGaugeRuntime>
): Promise<VCockpitHtmlGaugeRuntime> {
  return new Promise((resolve, reject) => {
    queuedVCockpitHtmlGaugeLoads.push(() => {
      activeVCockpitHtmlGaugeLoads += 1
      waitForVCockpitHtmlGaugeLoadSlot()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeVCockpitHtmlGaugeLoads -= 1
          startNextVCockpitHtmlGaugeLoad()
        })
    })

    startNextVCockpitHtmlGaugeLoad()
  })
}

function startNextVCockpitHtmlGaugeLoad(): void {
  if (activeVCockpitHtmlGaugeLoads >= VCOCKPIT_HTML_GAUGE_LOAD_CONCURRENCY) {
    return
  }

  const next = queuedVCockpitHtmlGaugeLoads.shift()
  if (next != null) {
    next()
  }
}

function waitForVCockpitHtmlGaugeLoadSlot(): Promise<void> {
  return new Promise(resolve => {
    const idleCallback = (
      window as Window & {
        requestIdleCallback?: (
          callback: () => void,
          options?: { readonly timeout: number }
        ) => number
      }
    ).requestIdleCallback

    if (idleCallback != null) {
      idleCallback.call(window, () => resolve(), {
        timeout: VCOCKPIT_HTML_GAUGE_LOAD_IDLE_TIMEOUT_MS
      })
      return
    }

    window.setTimeout(() => resolve(), 0)
  })
}

function resolveEffectiveVCockpitGaugeMode(
  requestedGaugeMode: VCockpitGaugeModeRequest,
  liveHtmlGaugeCapture: boolean,
  diagnostics: ImportDiagnostic[]
): VCockpitGaugeMode {
  if (requestedGaugeMode === 'htmlTexture') {
    const nativeHtmlTextureSupport = detectNativeHtmlGaugeTextureSupport()
    if (!nativeHtmlTextureSupport.supported) {
      diagnostics.push({
        code: 'vcockpit-html-texture-unsupported',
        severity: 'info',
        message: 'VCockpit native HTML texture mode is unavailable; falling back to CanvasTexture mode.',
        details: nativeHtmlTextureSupport.details
      })
      return 'texture'
    }

    diagnostics.push({
      code: 'vcockpit-html-texture-blocked',
      severity: 'info',
      message: 'VCockpit native HTML texture mode is detected but remains disabled pending renderer integration and long-session validation.',
      details: nativeHtmlTextureSupport.details
    })
    return 'texture'
  }

  if (requestedGaugeMode !== 'video') {
    return requestedGaugeMode
  }

  if (!liveHtmlGaugeCapture) {
    diagnostics.push({
      code: 'vcockpit-html-video-static-fallback',
      severity: 'info',
      message: 'VCockpit video gauge mode requires live gauges; falling back to texture mode for one-shot capture.'
    })
    return 'texture'
  }

  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    diagnostics.push({
      code: 'vcockpit-html-video-unsupported',
      severity: 'warning',
      message: 'VCockpit video gauge mode is unavailable because canvas captureStream() is not supported.'
    })
    return 'texture'
  }

  return 'video'
}

type NativeHtmlGaugeTextureSupport = {
  readonly drawElementImage: boolean
  readonly texElementImage2D: boolean
  readonly copyElementImageToTexture: boolean
  readonly supported: boolean
  readonly details: string
}

function detectNativeHtmlGaugeTextureSupport(): NativeHtmlGaugeTextureSupport {
  const canvas2dPrototype = globalThis.CanvasRenderingContext2D?.prototype as
    | (CanvasRenderingContext2D & { readonly drawElementImage?: unknown })
    | undefined
  const webgl2Prototype = globalThis.WebGL2RenderingContext?.prototype as
    | (WebGL2RenderingContext & { readonly texElementImage2D?: unknown })
    | undefined
  const gpuQueuePrototype = (
    globalThis as typeof globalThis & {
      readonly GPUQueue?: {
        readonly prototype?: { readonly copyElementImageToTexture?: unknown }
      }
    }
  ).GPUQueue?.prototype

  const drawElementImage = typeof canvas2dPrototype?.drawElementImage === 'function'
  const texElementImage2D = typeof webgl2Prototype?.texElementImage2D === 'function'
  const copyElementImageToTexture =
    typeof gpuQueuePrototype?.copyElementImageToTexture === 'function'

  return {
    drawElementImage,
    texElementImage2D,
    copyElementImageToTexture,
    supported: drawElementImage || texElementImage2D || copyElementImageToTexture,
    details: [
      `drawElementImage=${drawElementImage ? 'yes' : 'no'}`,
      `texElementImage2D=${texElementImage2D ? 'yes' : 'no'}`,
      `copyElementImageToTexture=${copyElementImageToTexture ? 'yes' : 'no'}`
    ].join(', ')
  }
}

type VCockpitGaugeDirtyMessage = {
  readonly type: 'msfs-vcockpit-gauge-dirty'
  readonly version: number
  readonly kind?: VCockpitGaugeDirtyKind
}

function isVCockpitGaugeDirtyMessage(value: unknown): value is VCockpitGaugeDirtyMessage {
  if (typeof value !== 'object' || value == null) {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    record.type === 'msfs-vcockpit-gauge-dirty' &&
    typeof record.version === 'number' &&
    Number.isFinite(record.version) &&
    (
      record.kind == null ||
      record.kind === 'dom' ||
      record.kind === 'canvas' ||
      record.kind === 'unknown'
    )
  )
}

function mergeVCockpitGaugeDirtyKind(
  previous: VCockpitGaugeDirtyKind | null,
  next: VCockpitGaugeDirtyKind | null | undefined
): VCockpitGaugeDirtyKind {
  if (previous === 'dom' || next === 'dom') {
    return 'dom'
  }
  if (previous === 'unknown' || next == null || next === 'unknown') {
    return 'unknown'
  }
  return 'canvas'
}

function isLoadedVCockpitHtmlGaugeStatus(
  status: VCockpitHtmlGaugeRuntime['status']
): boolean {
  return status === 'loaded' || status === 'loaded-wasm-bridge'
}

function getSurfaceHostedGaugeEntries(surface: VCockpitSurface): readonly VCockpitGaugeEntry[] {
  return [...surface.htmlGauges, ...surface.wasmInstruments]
}

type VCockpitGaugeRuntimeRequest = {
  readonly type: 'msfs-vcockpit-runtime-request'
  readonly id: number
  readonly op: 'readVariable' | 'writeVariable' | 'keyEvent' | 'bridgeCall'
  readonly name?: string
  readonly unit?: string | null
  readonly value?: number
  readonly args?: readonly number[]
}

type VCockpitGaugeRuntimeResponse = {
  readonly type: 'msfs-vcockpit-runtime-response'
  readonly id: number
  readonly ok: boolean
  readonly value?: number
  readonly error?: string
}

type VCockpitGaugeInteractionEventMessage = {
  readonly type: 'msfs-vcockpit-interaction-event'
  readonly name: string
  readonly args: readonly (number | string)[]
  readonly sequence: number
}

type VCockpitGaugeKeyEventMessage = {
  readonly type: 'msfs-vcockpit-key-event'
  readonly name: string
  readonly args: readonly number[]
  readonly sequence: number
}

function isVCockpitGaugeRuntimeRequest(value: unknown): value is VCockpitGaugeRuntimeRequest {
  if (typeof value !== 'object' || value == null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    record.type === 'msfs-vcockpit-runtime-request' &&
    typeof record.id === 'number' &&
    (
      record.op === 'readVariable' ||
      record.op === 'writeVariable' ||
      record.op === 'keyEvent' ||
      record.op === 'bridgeCall'
    )
  )
}

function handleVCockpitGaugeRuntimeRequest(
  request: VCockpitGaugeRuntimeRequest,
  runtimeHost: SharedMsfsRuntimeHost
): VCockpitGaugeRuntimeResponse {
  try {
    if (request.op === 'readVariable') {
      return {
        type: 'msfs-vcockpit-runtime-response',
        id: request.id,
        ok: true,
        value: runtimeHost.readVariable(request.name ?? '', request.unit ?? null)
      }
    }
    if (request.op === 'writeVariable') {
      runtimeHost.writeVariable(request.name ?? '', Number(request.value ?? 0), request.unit ?? null)
      return {
        type: 'msfs-vcockpit-runtime-response',
        id: request.id,
        ok: true,
        value: Number(request.value ?? 0)
      }
    }
    if (request.op === 'keyEvent') {
      runtimeHost.invokeKeyEvent(request.name ?? '', request.args ?? [])
      return { type: 'msfs-vcockpit-runtime-response', id: request.id, ok: true, value: 0 }
    }
    runtimeHost.invokeBridgeCall(request.name ?? request.op, request.args ?? [1])
    return { type: 'msfs-vcockpit-runtime-response', id: request.id, ok: true, value: 0 }
  } catch (error) {
    return {
      type: 'msfs-vcockpit-runtime-response',
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function bindVCockpitPlaceholderSurfaces(
  root: Object3D,
  aircraft: ImportedAircraft,
  resolvePanelAssetUrl: (source: string) => string | null,
  liveHtmlGaugeCapture: boolean,
  gaugeMode: VCockpitGaugeModeRequest,
  videoFps: number,
  captureFps: number,
  rasterScale: number,
  debugHtmlGaugeOverlay: boolean,
  runtimeHost: SharedMsfsRuntimeHost
): Promise<VCockpitSurfaceBindingResult> {
  const parsed = parseVCockpitSurfaces(aircraft)
  const diagnostics: ImportDiagnostic[] = [...parsed.diagnostics]
  const effectiveGaugeMode = resolveEffectiveVCockpitGaugeMode(
    gaugeMode,
    liveHtmlGaugeCapture,
    diagnostics
  )
  const effectiveRasterScale = effectiveGaugeMode === 'overlay' ? 1 : rasterScale
  const replacementByMaterial = new Map<Material, MeshBasicMaterial>()
  const boundSurfaceNames = new Set<string>()
  const visitedSurfaceNames = new Set<string>()
  const htmlGaugeRuntimes: VCockpitHtmlGaugeRuntime[] = []
  const surfaceTextureRuntimes: VCockpitSurfaceTextureRuntime[] = []
  const htmlGaugeRuntimeByWindow = new WeakMap<Window, VCockpitHtmlGaugeRuntime>()
  const surfaceTextureRuntimeByGaugeRuntime = new WeakMap<
    VCockpitHtmlGaugeRuntime,
    VCockpitSurfaceTextureRuntime
  >()
  let active = true
  let disposed = false
  let materialBindingCount = 0
  const onGaugeBridgeRequest = (event: MessageEvent): void => {
    if (disposed || !isVCockpitGaugeRuntimeRequest(event.data)) {
      return
    }

    const sourceWindow = event.source as Window | null
    if (sourceWindow == null || htmlGaugeRuntimeByWindow.get(sourceWindow) == null) {
      return
    }

    const response = handleVCockpitGaugeRuntimeRequest(event.data, runtimeHost)
    postWindowMessage(sourceWindow, response)
  }
  const removeHtmlEventListener = runtimeHost.addHtmlEventListener(event => {
    if (disposed) {
      return
    }
    const message: VCockpitGaugeInteractionEventMessage = {
      type: 'msfs-vcockpit-interaction-event',
      name: event.name,
      args: event.args,
      sequence: event.sequence
    }
    for (const gaugeRuntime of htmlGaugeRuntimes) {
      postVCockpitGaugeRuntimeMessage(gaugeRuntime, message)
    }
  })
  const removeKeyEventListener = runtimeHost.addKeyEventListener(event => {
    if (disposed) {
      return
    }
    const message: VCockpitGaugeKeyEventMessage = {
      type: 'msfs-vcockpit-key-event',
      name: event.name,
      args: event.args,
      sequence: event.sequence
    }
    for (const gaugeRuntime of htmlGaugeRuntimes) {
      postVCockpitGaugeRuntimeMessage(gaugeRuntime, message)
    }
  })
  const markGaugeRuntimeDirty = (
    runtime: VCockpitHtmlGaugeRuntime,
    version: number | null,
    kind: VCockpitGaugeDirtyKind | null | undefined = 'unknown'
  ): void => {
    runtime.pendingChangeVersion = version
    runtime.pendingDirtyKind = mergeVCockpitGaugeDirtyKind(runtime.pendingDirtyKind, kind)
    const surfaceRuntime = surfaceTextureRuntimeByGaugeRuntime.get(runtime)
    if (surfaceRuntime == null) {
      runtime.needsCapture = false
      runtime.lastRenderStatus = isLoadedVCockpitHtmlGaugeStatus(runtime.status)
        ? 'skipped-clean'
        : runtime.lastRenderStatus
      return
    }

    runtime.needsCapture = true
    if (!runtime.captured) {
      surfaceRuntime.nextCaptureMs = performance.now()
    }
  }
  const onGaugeDirtyMessage = (event: MessageEvent): void => {
    if (disposed || !isVCockpitGaugeDirtyMessage(event.data)) {
      return
    }

    const runtime = event.source == null
      ? null
      : htmlGaugeRuntimeByWindow.get(event.source as Window)
    if (runtime == null) {
      return
    }

    markGaugeRuntimeDirty(runtime, event.data.version, event.data.kind)
  }
  window.addEventListener('message', onGaugeDirtyMessage)
  window.addEventListener('message', onGaugeBridgeRequest)
  const setActive = (nextActive: boolean): void => {
    if (active === nextActive) {
      return
    }

    active = nextActive
    for (const runtime of htmlGaugeRuntimes) {
      setVCockpitHtmlGaugeRuntimeActive(runtime, nextActive)
      if (
        nextActive &&
        isLoadedVCockpitHtmlGaugeStatus(runtime.status) &&
        !runtime.captured &&
        surfaceTextureRuntimeByGaugeRuntime.has(runtime)
      ) {
        markGaugeRuntimeDirty(runtime, getHtmlGaugeChangeVersion(runtime), 'dom')
      }
    }
    for (const surfaceRuntime of surfaceTextureRuntimes) {
      if (nextActive) {
        surfaceRuntime.nextCaptureMs = performance.now()
      } else {
        hideVCockpitOverlayGaugeFrames(surfaceRuntime.htmlGaugeRuntimes)
      }
    }
  }

  const loadSurfaceHtmlGaugeRuntimes = (
    surface: VCockpitSurface,
    surfaceTextureRuntime: VCockpitSurfaceTextureRuntime
  ): void => {
    for (const gauge of getSurfaceHostedGaugeEntries(surface)) {
      void scheduleVCockpitHtmlGaugeRuntimeLoad(() => {
        if (disposed) {
          return Promise.resolve(createAbandonedVCockpitHtmlGaugeRuntime(surface, gauge))
        }

        return createVCockpitHtmlGaugeRuntime(
          surface,
          gauge,
          resolvePanelAssetUrl,
          diagnostics
        )
      })
      .then(runtime => {
        if (disposed) {
          runtime.iframe?.remove()
          return
        }

        htmlGaugeRuntimes.push(runtime)
        surfaceTextureRuntime.htmlGaugeRuntimes.push(runtime)
        surfaceTextureRuntimeByGaugeRuntime.set(runtime, surfaceTextureRuntime)
        if (runtime.iframe?.contentWindow != null) {
          htmlGaugeRuntimeByWindow.set(runtime.iframe.contentWindow, runtime)
        }
        setVCockpitHtmlGaugeRuntimeActive(runtime, active)
        if (isLoadedVCockpitHtmlGaugeStatus(runtime.status)) {
          markGaugeRuntimeDirty(runtime, getHtmlGaugeChangeVersion(runtime), 'dom')
        }
        drawVCockpitPlaceholderSurface(
          surfaceTextureRuntime.context,
          surfaceTextureRuntime.surface,
          surfaceTextureRuntime.htmlGaugeRuntimes,
          surfaceTextureRuntime.canvas.width,
          surfaceTextureRuntime.canvas.height,
          surfaceTextureRuntime.debugOverlay
        )
        markVCockpitSurfaceTextureRuntimeUpdated(surfaceTextureRuntime)
        surfaceTextureRuntime.nextCaptureMs = performance.now()
      })
      .catch(error => {
        diagnostics.push({
          code: 'vcockpit-html-gauge-runtime-error',
          severity: 'warning',
          sourcePath: surface.panelPath,
          message: `${surface.sectionName} HTML gauge runtimes could not be created.`,
          details: formatCaughtErrorForDiagnostics(error)
        })
      })
    }
  }

  const loadBackendGaugeRuntimes = (surface: VCockpitSurface): void => {
    for (const gauge of getSurfaceHostedGaugeEntries(surface)) {
      void scheduleVCockpitHtmlGaugeRuntimeLoad(() => {
        if (disposed) {
          return Promise.resolve(createAbandonedVCockpitHtmlGaugeRuntime(surface, gauge))
        }

        return createVCockpitHtmlGaugeRuntime(
          surface,
          gauge,
          resolvePanelAssetUrl,
          diagnostics
        )
      })
      .then(runtime => {
        if (disposed) {
          runtime.iframe?.remove()
          return
        }

        runtime.needsCapture = false
        runtime.pendingDirtyKind = null
        runtime.lastRenderStatus = isLoadedVCockpitHtmlGaugeStatus(runtime.status)
          ? 'skipped-clean'
          : runtime.lastRenderStatus
        htmlGaugeRuntimes.push(runtime)
        if (runtime.iframe?.contentWindow != null) {
          htmlGaugeRuntimeByWindow.set(runtime.iframe.contentWindow, runtime)
        }
        setVCockpitHtmlGaugeRuntimeActive(runtime, active)
        if (isLoadedVCockpitHtmlGaugeStatus(runtime.status)) {
          const backendKind = isWasmBackedHtmlGauge(gauge) ? 'WASM bridge' : 'HTML'
          diagnostics.push({
            code: isWasmBackedHtmlGauge(gauge)
              ? 'vcockpit-backend-wasm-bridge-loaded'
              : 'vcockpit-backend-html-gauge-loaded',
            severity: 'info',
            sourcePath: surface.panelPath,
            message: `${surface.sectionName} ${gauge.key} loaded as a backend-only ${backendKind} host without texture capture or material binding.`
          })
        }
      })
      .catch(error => {
        diagnostics.push({
          code: 'vcockpit-backend-html-gauge-error',
          severity: 'warning',
          sourcePath: surface.panelPath,
          message: `${surface.sectionName} backend-only HTML gauge runtimes could not be created.`,
          details: formatCaughtErrorForDiagnostics(error)
        })
      })
    }
  }

  for (const surface of parsed.surfaces) {
    if (surface.normalizedTextureName === 'notexture') {
      loadBackendGaugeRuntimes(surface)
    }
  }

  for (const surface of parsed.surfaces) {
    if (
      surface.normalizedTextureName === '' ||
      surface.normalizedTextureName === 'notexture'
    ) {
      continue
    }

    if (visitedSurfaceNames.has(surface.normalizedTextureName)) {
      continue
    }
    visitedSurfaceNames.add(surface.normalizedTextureName)

    if (
      surface.pixelSize == null ||
      surface.pixelSize.width <= 0 ||
      surface.pixelSize.height <= 0
    ) {
      diagnostics.push({
        code: 'vcockpit-surface-invalid-dimensions',
        severity: 'warning',
        sourcePath: surface.panelPath,
        message: `${surface.sectionName} texture ${surface.textureName} cannot be bound without positive pixel_size dimensions.`
      })
      continue
    }

    const surfaceRuntimes: VCockpitHtmlGaugeRuntime[] = []
    const surfaceTextureRuntime = createVCockpitSurfaceTextureRuntime(
      surface,
      surfaceRuntimes,
      liveHtmlGaugeCapture,
      effectiveGaugeMode,
      videoFps,
      captureFps,
      effectiveRasterScale,
      debugHtmlGaugeOverlay,
      diagnostics
    )
    const overlayObjects = new Set<Object3D>()
    let surfaceBindingCount = 0

    root.traverse(object => {
      if (!(object instanceof Mesh)) {
        return
      }

      const materials = Array.isArray(object.material)
        ? object.material
        : object.material != null
          ? [object.material]
          : []

      for (const [materialIndex, material] of materials.entries()) {
        if (material == null) {
          continue
        }

        const materialMatchesSurface =
          normalizeSurfaceLookupName(material.name) === surface.normalizedTextureName
        const meshMatchesSurface =
          !materialMatchesSurface && doesMeshMatchVCockpitSurfaceName(object, surface)
        if (!materialMatchesSurface && !meshMatchesSurface) {
          continue
        }

        if (materialMatchesSurface) {
          if (!replacementByMaterial.has(material)) {
            replacementByMaterial.set(
              material,
              createVCockpitSurfaceMaterial(
                material,
                surface,
                surfaceTextureRuntime.texture
              )
            )
          }
        } else {
          setMeshMaterialAtIndex(
            object,
            materialIndex,
            createVCockpitSurfaceMaterial(
              material,
              surface,
              surfaceTextureRuntime.texture
            )
          )
        }
        overlayObjects.add(object)
        surfaceBindingCount += 1
      }
    })

    if (surfaceBindingCount === 0) {
      disposeVCockpitSurfaceTextureRuntime(surfaceTextureRuntime)
      diagnostics.push({
        code: 'vcockpit-surface-unresolved-material',
        severity: 'warning',
        sourcePath: surface.panelPath,
        message: `${surface.sectionName} texture ${surface.textureName} did not match a cockpit material name.`
      })
      continue
    }

    surfaceTextureRuntime.overlayObjects.push(...overlayObjects)
    boundSurfaceNames.add(surface.normalizedTextureName)
    surfaceTextureRuntimes.push(surfaceTextureRuntime)
    loadSurfaceHtmlGaugeRuntimes(surface, surfaceTextureRuntime)
    materialBindingCount += surfaceBindingCount
  }

  if (replacementByMaterial.size > 0) {
    root.traverse(object => {
      if (!(object instanceof Mesh)) {
        return
      }

      if (Array.isArray(object.material)) {
        object.material = object.material.map(material =>
          material == null ? material : replacementByMaterial.get(material) ?? material
        )
        return
      }

      if (object.material != null) {
        object.material = replacementByMaterial.get(object.material) ?? object.material
      }
    })
  }

  return {
    surfaces: parsed.surfaces,
    boundSurfaceCount: boundSurfaceNames.size,
    materialBindingCount,
    gaugeMode: effectiveGaugeMode,
    videoFps: effectiveGaugeMode === 'video' ? videoFps : null,
    rasterScale: effectiveRasterScale,
    htmlGaugeCount: parsed.surfaces.reduce(
      (total, surface) => total + getSurfaceHostedGaugeEntries(surface).length,
      0
    ),
    get loadedHtmlGaugeCount() {
      return htmlGaugeRuntimes.filter(runtime => isLoadedVCockpitHtmlGaugeStatus(runtime.status)).length
    },
    get capturedHtmlGaugeCount() {
      return htmlGaugeRuntimes.filter(runtime => runtime.captured).length
    },
    htmlGaugeRuntimes,
    get captureStats() {
      return surfaceTextureRuntimes.map(surfaceRuntime => ({
        sectionName: surfaceRuntime.surface.sectionName,
        textureName: surfaceRuntime.surface.textureName,
        captureCount: surfaceRuntime.captureCount,
        lastCaptureDurationMs: surfaceRuntime.lastCaptureDurationMs,
        averageCaptureDurationMs: surfaceRuntime.averageCaptureDurationMs,
        currentCaptureIntervalMs: getVCockpitSurfaceCaptureIntervalMs(surfaceRuntime),
        dirtyGaugeCount: surfaceRuntime.htmlGaugeRuntimes.filter(runtime => runtime.needsCapture).length,
        runtimeHost: runtimeHost.getStats(),
        gauges: surfaceRuntime.htmlGaugeRuntimes.map(getVCockpitHtmlGaugeRuntimeStats)
      }))
    },
    update: (nowMs, camera, viewportElement) => {
      if (!active || disposed) {
        return
      }

      updateVCockpitSurfaceTextureRuntimes(surfaceTextureRuntimes, diagnostics, nowMs)
      updateVCockpitHtmlGaugeOverlayRuntimes(
        surfaceTextureRuntimes,
        camera,
        viewportElement
      )
    },
    setCaptureFps: captureFps => {
      const captureIntervalMs = 1000 / Math.min(60, Math.max(1, captureFps))
      for (const surfaceRuntime of surfaceTextureRuntimes) {
        surfaceRuntime.captureIntervalMs = captureIntervalMs
        surfaceRuntime.nextCaptureMs = performance.now()
      }
    },
    setActive,
    dispose: () => {
      disposed = true
      active = false
      removeHtmlEventListener()
      removeKeyEventListener()
      window.removeEventListener('message', onGaugeDirtyMessage)
      window.removeEventListener('message', onGaugeBridgeRequest)
      for (const surfaceRuntime of surfaceTextureRuntimes) {
        disposeVCockpitSurfaceTextureRuntime(surfaceRuntime)
      }
      for (const gaugeRuntime of htmlGaugeRuntimes) {
        setVCockpitHtmlGaugeRuntimeActive(gaugeRuntime, false)
        gaugeRuntime.iframe?.remove()
      }
    },
    diagnostics
  }
}

function createAbandonedVCockpitHtmlGaugeRuntime(
  surface: VCockpitSurface,
  gauge: VCockpitGaugeEntry
): VCockpitHtmlGaugeRuntime {
  return {
    surface: surface.sectionName,
    textureName: surface.textureName,
    gaugeKey: gauge.key,
    gauge: null,
    source: gauge.source,
    resolvedUrl: null,
    wasmModuleUrl: null,
    status: 'iframe-error',
    iframe: null,
    sourceObjectUrl: null,
    captured: false,
    captureImage: null,
    captureAttemptCount: 0,
    lastCaptureError: null,
    lastVisualSignature: null,
    lastChangeVersion: null,
    lastRenderStatus: 'error',
    lastRenderKind: null,
    pendingChangeVersion: null,
    pendingDirtyKind: null,
    needsCapture: false,
    staticCaptureImage: null,
    staticCaptureSignature: null
  }
}

function formatCaughtErrorForDiagnostics(error: unknown): string {
  if (error instanceof Error) {
    return error.stack != null && error.stack !== ''
      ? error.stack
      : error.message
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function doesMeshMatchVCockpitSurfaceName(mesh: Mesh, surface: VCockpitSurface): boolean {
  const objectName = normalizeSurfaceLookupName(mesh.name)
  const geometryName = normalizeSurfaceLookupName(mesh.geometry?.name ?? '')
  const names = new Set<string>([objectName, geometryName].filter(name => name !== ''))
  const candidates = createVCockpitSurfaceScreenNameCandidates(surface.normalizedTextureName)
  for (const name of names) {
    for (const candidate of candidates) {
      if (name.includes(`screen${candidate}`)) {
        return true
      }
      if (doesDisplayMeshNameContainSurfaceCandidate(name, candidate)) {
        return true
      }
    }
  }
  return false
}

function createVCockpitSurfaceScreenNameCandidates(normalizedTextureName: string): readonly string[] {
  const candidates = new Set<string>([normalizedTextureName])
  const ndMatch = /^nd([lr])$/u.exec(normalizedTextureName)
  if (ndMatch != null) {
    candidates.add(`mfd${ndMatch[1]}`)
  }
  return [...candidates]
}

function doesDisplayMeshNameContainSurfaceCandidate(name: string, candidate: string): boolean {
  if (candidate.length < 3 || !name.includes(candidate)) {
    return false
  }

  return (
    name.includes('screen') ||
    name.includes('display') ||
    name.includes('glass')
  )
}

function setMeshMaterialAtIndex(mesh: Mesh, materialIndex: number, material: Material): void {
  if (Array.isArray(mesh.material)) {
    const materials = [...mesh.material]
    materials[materialIndex] = material
    mesh.material = materials
    return
  }

  mesh.material = material
}

async function createVCockpitHtmlGaugeRuntime(
  surface: VCockpitSurface,
  gauge: VCockpitGaugeEntry,
  resolvePanelAssetUrl: (source: string) => string | null,
  diagnostics: ImportDiagnostic[]
): Promise<VCockpitHtmlGaugeRuntime> {
  const wasmBacked = isWasmBackedHtmlGauge(gauge)
  const resolvedUrl = resolvePanelAssetUrl(gauge.source)
  const wasmModuleUrl = wasmBacked
    ? resolveSyntheticWasmModuleUrl(surface, gauge, resolvePanelAssetUrl)
    : ''
  if (resolvedUrl == null) {
    if (wasmBacked) {
      diagnostics.push({
        code: 'vcockpit-html-gauge-wasm-bridge-synthetic-host',
        severity: 'info',
        sourcePath: surface.panelPath,
        message: `${surface.sectionName} ${gauge.key} uses a synthetic bridge-first host for ${gauge.source}; native MSFS WASM ABI execution is not emulated.`
      })

      const syntheticUrl = createSyntheticWasmInstrumentHostUrl(gauge, wasmModuleUrl)
      const loadResult = await createSandboxedHtmlGaugeFrame(
        surface,
        gauge,
        syntheticUrl,
        diagnostics,
        createSyntheticWasmInstrumentHostHtml(
          gauge,
          wasmModuleUrl
        )
      )
      if (loadResult.status !== 'loaded') {
        diagnostics.push({
          code: 'vcockpit-html-gauge-frame-error',
          severity: 'warning',
          sourcePath: surface.panelPath,
          message: `${surface.sectionName} ${gauge.key} failed to load synthetic bridge host for ${gauge.source}.`,
          details: loadResult.error ?? undefined
        })
      }

      return {
        surface: surface.sectionName,
        textureName: surface.textureName,
        gaugeKey: gauge.key,
        gauge,
        source: gauge.source,
        resolvedUrl: syntheticUrl,
        wasmModuleUrl: wasmModuleUrl === '' ? null : wasmModuleUrl,
        status: loadResult.status === 'loaded' ? 'loaded-wasm-bridge' : loadResult.status,
        iframe: loadResult.iframe,
        sourceObjectUrl: loadResult.sourceObjectUrl,
        captured: false,
        captureImage: null,
        captureAttemptCount: 0,
        lastCaptureError: null,
        lastVisualSignature: null,
        lastChangeVersion: null,
        lastRenderStatus: loadResult.status === 'loaded' ? 'pending' : 'error',
        lastRenderKind: null,
        pendingChangeVersion: null,
        pendingDirtyKind: loadResult.status === 'loaded' ? 'dom' : null,
        needsCapture: loadResult.status === 'loaded',
        staticCaptureImage: null,
        staticCaptureSignature: null
      } satisfies VCockpitHtmlGaugeRuntime
    }

    diagnostics.push({
      code: 'vcockpit-html-gauge-missing-asset',
      severity: 'warning',
      sourcePath: surface.panelPath,
      message: `${surface.sectionName} ${gauge.key} could not resolve ${gauge.source}.`
    })
    return {
      surface: surface.sectionName,
      textureName: surface.textureName,
      gaugeKey: gauge.key,
      gauge: null,
      source: gauge.source,
      resolvedUrl: null,
      wasmModuleUrl: null,
      status: 'missing',
      iframe: null,
      sourceObjectUrl: null,
      captured: false,
      captureImage: null,
      captureAttemptCount: 0,
      lastCaptureError: null,
      lastVisualSignature: null,
      lastChangeVersion: null,
      lastRenderStatus: 'error',
      lastRenderKind: null,
      pendingChangeVersion: null,
      pendingDirtyKind: null,
      needsCapture: false,
      staticCaptureImage: null,
      staticCaptureSignature: null
    } satisfies VCockpitHtmlGaugeRuntime
  }

  const loadResult = await createSandboxedHtmlGaugeFrame(
    surface,
    gauge,
    resolvedUrl,
    diagnostics
  )
  if (loadResult.status !== 'loaded') {
    diagnostics.push({
      code: 'vcockpit-html-gauge-frame-error',
      severity: 'warning',
      sourcePath: surface.panelPath,
      message: `${surface.sectionName} ${gauge.key} failed to load ${gauge.source}.`,
      details: loadResult.error ?? undefined
    })
  }
  if (wasmBacked && loadResult.status === 'loaded') {
    diagnostics.push({
      code: 'vcockpit-html-gauge-wasm-bridge-loaded',
      severity: 'info',
      sourcePath: surface.panelPath,
      message: `${surface.sectionName} ${gauge.key} loaded as a bridge-first WASM-backed HTML host; native MSFS WASM ABI execution is not emulated.`
    })
  }

  return {
    surface: surface.sectionName,
    textureName: surface.textureName,
    gaugeKey: gauge.key,
    gauge,
    source: gauge.source,
    resolvedUrl,
    wasmModuleUrl: wasmModuleUrl === '' ? null : wasmModuleUrl,
    status: loadResult.status === 'loaded' && wasmBacked
      ? 'loaded-wasm-bridge'
      : loadResult.status,
    iframe: loadResult.iframe,
    sourceObjectUrl: loadResult.sourceObjectUrl,
    captured: false,
    captureImage: null,
    captureAttemptCount: 0,
    lastCaptureError: null,
    lastVisualSignature: null,
    lastChangeVersion: null,
    lastRenderStatus: loadResult.status === 'loaded' ? 'pending' : 'error',
    lastRenderKind: null,
    pendingChangeVersion: null,
    pendingDirtyKind: loadResult.status === 'loaded' ? 'dom' : null,
    needsCapture: loadResult.status === 'loaded',
    staticCaptureImage: null,
    staticCaptureSignature: null
  } satisfies VCockpitHtmlGaugeRuntime
}

function isWasmBackedHtmlGauge(gauge: VCockpitGaugeEntry): boolean {
  return (
    gauge.kind === 'wasmInstrument' ||
    gauge.source.toLowerCase().startsWith('wasminstrument/') ||
    gauge.source.toLowerCase().includes('wasm_module=')
  )
}

function createSyntheticWasmInstrumentHostUrl(
  gauge: VCockpitGaugeEntry,
  wasmModuleUrl: string
): string {
  const url = new URL('synthetic-msfs-wasm-instrument-host.html', window.location.href)
  url.searchParams.set('source', gauge.source)
  if (wasmModuleUrl !== '') {
    url.searchParams.set('wasmModuleUrl', wasmModuleUrl)
  }
  return url.toString()
}

function resolveSyntheticWasmModuleUrl(
  surface: VCockpitSurface,
  gauge: VCockpitGaugeEntry,
  resolvePanelAssetUrl: (source: string) => string | null
): string {
  const params = new URLSearchParams(gauge.source.split('?')[1] ?? '')
  const wasmModule = params.get('wasm_module') ?? ''
  if (wasmModule === '') {
    return ''
  }
  const panelDirectory = surface.panelPath.replace(/[^/\\]*$/u, '')
  return (
    resolvePanelAssetUrl(`${panelDirectory}${wasmModule}`) ??
    resolvePanelAssetUrl(wasmModule) ??
    ''
  )
}

function createSyntheticWasmInstrumentHostHtml(
  gauge: VCockpitGaugeEntry,
  wasmModuleUrl: string
): string {
  const params = new URLSearchParams(gauge.source.split('?')[1] ?? '')
  const wasmModule = params.get('wasm_module') ?? ''
  const wasmGauge = params.get('wasm_gauge') ?? ''
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html,
      body,
      wasm-instrument {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }
      wasm-instrument {
        display: block;
      }
    </style>
  </head>
  <body>
    <wasm-instrument
      data-msfs-instrument="synthetic-wasm-bridge"
      data-msfs-wasm-module="${escapeHtmlAttribute(wasmModule)}"
      data-msfs-wasm-module-url="${escapeHtmlAttribute(wasmModuleUrl)}"
      data-msfs-wasm-gauge="${escapeHtmlAttribute(wasmGauge)}"
      data-msfs-wasm-source="${escapeHtmlAttribute(gauge.source)}"></wasm-instrument>
  </body>
</html>`
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

async function createSandboxedHtmlGaugeFrame(
  surface: VCockpitSurface,
  gauge: VCockpitGaugeEntry,
  resolvedUrl: string,
  diagnostics: ImportDiagnostic[],
  sourceHtmlOverride?: string
): Promise<{
  readonly status: 'loaded' | 'iframe-error'
  readonly iframe: HTMLIFrameElement | null
  readonly sourceObjectUrl: string | null
  readonly error: string | null
}> {
  let sourceHtml = sourceHtmlOverride
  if (sourceHtml == null) {
    const htmlResponse = await fetch(resolvedUrl).catch(error => error)
    if (htmlResponse instanceof Error) {
      return { status: 'iframe-error', iframe: null, sourceObjectUrl: null, error: htmlResponse.message }
    }
    if (!htmlResponse.ok) {
      return {
        status: 'iframe-error',
        iframe: null,
        sourceObjectUrl: null,
        error: `HTTP ${htmlResponse.status} ${htmlResponse.statusText}`.trim()
      }
    }
    sourceHtml = await htmlResponse.text()
  }

  const gaugeSourceHtml = sourceHtml ?? ''
  if (isWasmBackedHtmlGauge(gauge)) {
    diagnostics.push({
      code: 'vcockpit-html-gauge-native-wasm-unsupported',
      severity: 'info',
      sourcePath: surface.panelPath,
      message: `${surface.sectionName} ${gauge.key} may request a native MSFS WASM module; this loader records those requests but does not emulate the native ABI.`
    })
  }
  const iframe = document.createElement('iframe')
  iframe.dataset.msfsVCockpitSurface = surface.sectionName
  iframe.dataset.msfsVCockpitTexture = surface.textureName
  iframe.dataset.msfsVCockpitGauge = gauge.key
  iframe.sandbox.add('allow-scripts')
  iframe.sandbox.add('allow-same-origin')
  iframe.loading = 'eager'
  const sourceObjectUrl = URL.createObjectURL(new Blob(
    [await adaptMsfsHtmlGaugeDocument(gaugeSourceHtml, resolvedUrl, gauge)],
    { type: 'text/html' }
  ))
  iframe.src = sourceObjectUrl
  iframe.style.position = 'fixed'
  iframe.style.left = '-10000px'
  iframe.style.top = '0'
  iframe.style.width = `${Math.max(1, Math.round(gauge.width ?? surface.pixelSize?.width ?? 1))}px`
  iframe.style.height = `${Math.max(1, Math.round(gauge.height ?? surface.pixelSize?.height ?? 1))}px`
  iframe.style.border = '0'
  iframe.style.pointerEvents = 'none'
  iframe.style.visibility = 'hidden'

  let iframeError: string | null = null
  const status = await new Promise<'loaded' | 'iframe-error'>(resolve => {
    let settled = false
    const settle = (nextStatus: 'loaded' | 'iframe-error'): void => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(domReadyTimeoutId)
      window.clearTimeout(loadTimeoutId)
      resolve(nextStatus)
    }
    const domReadyTimeoutId = window.setTimeout(() => {
      const frameDocument = iframe.contentDocument
      if (frameDocument?.documentElement != null && frameDocument.body != null) {
        settle('loaded')
      }
    }, VCOCKPIT_HTML_GAUGE_DOM_READY_TIMEOUT_MS)
    const timeoutId = window.setTimeout(() => {
      iframeError = `iframe load timed out after ${VCOCKPIT_HTML_GAUGE_LOAD_TIMEOUT_MS} ms`
      settle('iframe-error')
    }, VCOCKPIT_HTML_GAUGE_LOAD_TIMEOUT_MS)
    const loadTimeoutId = timeoutId
    iframe.addEventListener(
      'load',
      () => {
        settle('loaded')
      },
      { once: true }
    )
    iframe.addEventListener(
      'error',
      event => {
        iframeError = event instanceof ErrorEvent
          ? event.message
          : 'iframe emitted an error event'
        settle('iframe-error')
      },
      { once: true }
    )
    document.body.appendChild(iframe)
  })

  if (status !== 'loaded') {
    iframe.remove()
    URL.revokeObjectURL(sourceObjectUrl)
    return { status, iframe: null, sourceObjectUrl: null, error: iframeError }
  }

  return { status, iframe, sourceObjectUrl, error: null }
}

async function adaptMsfsHtmlGaugeDocument(
  sourceHtml: string,
  resolvedUrl: string,
  gauge: VCockpitGaugeEntry
): Promise<string> {
  const htmlUiRootUrl = getHtmlUiRootUrl(resolvedUrl)
  const updateThrottleMs = getVCockpitGaugeUpdateThrottleMs(
    new URLSearchParams(window.location.search)
  )
  const documentUrl = new URL(resolvedUrl, window.location.href)
  const documentDirectoryUrl = new URL('.', documentUrl).toString()
  const parser = new DOMParser()
  const document = parser.parseFromString(sourceHtml, 'text/html')

  const base = document.createElement('base')
  base.href = documentDirectoryUrl
  document.head.prepend(base)

  const viewportStyle = document.createElement('style')
  viewportStyle.textContent = `
    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
    }
    [id$="_CONTENT"],
    #Mainframe,
    #MSFS_REACT_MOUNT {
      width: 100%;
      height: 100%;
      min-height: 100%;
    }
    [id$="_CONTENT"] div {
      width: 100%;
      height: 100%;
      min-height: 100%;
    }
    svg[class$="-svg"],
    svg[class*="-svg "],
    canvas[class$="-canvas"],
    canvas[class*="-canvas "] {
      width: 100%;
      height: 100%;
    }
  `
  document.head.prepend(viewportStyle)

  const bridgeScript = document.createElement('script')
  bridgeScript.textContent = createVCockpitGaugeBridgeScript(
    htmlUiRootUrl,
    resolvedUrl,
    updateThrottleMs,
    gauge.kind,
    isWasmBackedHtmlGauge(gauge)
  )
  document.head.prepend(bridgeScript)

  for (const script of [...document.querySelectorAll('script[src*="@vite/client"]')]) {
    script.remove()
  }

  await inlineMsfsHtmlGaugeImports(document, htmlUiRootUrl, documentDirectoryUrl)

  for (const element of [...document.querySelectorAll<HTMLElement>('[href], [src]')]) {
    const href = element.getAttribute('href')
    if (href != null) {
      element.setAttribute(
        'href',
        resolveMsfsHtmlAssetUrl(href, htmlUiRootUrl, documentDirectoryUrl)
      )
    }
    const src = element.getAttribute('src')
    if (src != null) {
      element.setAttribute(
        'src',
        resolveMsfsHtmlAssetUrl(src, htmlUiRootUrl, documentDirectoryUrl)
      )
    }
  }

  return `<!doctype html>${document.documentElement.outerHTML}`
}

async function inlineMsfsHtmlGaugeImports(
  document: Document,
  htmlUiRootUrl: string,
  documentDirectoryUrl: string,
  visited = new Set<string>()
): Promise<void> {
  for (const script of [...document.querySelectorAll('script[import-script]')]) {
    const importSource = script.getAttribute('import-script')
    if (importSource == null || importSource.trim() === '') {
      continue
    }

    if (isBrowserProvidedMsfsImport(importSource)) {
      script.remove()
      continue
    }

    const resolvedSource = resolveMsfsHtmlAssetUrl(importSource, htmlUiRootUrl, documentDirectoryUrl)
    if (!isMsfsHtmlImport(resolvedSource)) {
      const replacement = document.createElement('script')
      replacement.src = resolvedSource
      replacement.async = script.getAttribute('import-async') !== 'false'
      script.replaceWith(replacement)
      continue
    }

    if (visited.has(resolvedSource)) {
      script.remove()
      continue
    }
    visited.add(resolvedSource)

    const response = await fetch(resolvedSource).catch(error => error)
    if (response instanceof Error || !response.ok) {
      const replacement = document.createElement('script')
      replacement.src = resolvedSource
      replacement.async = script.getAttribute('import-async') !== 'false'
      script.replaceWith(replacement)
      continue
    }

    const importedDocument = new DOMParser().parseFromString(await response.text(), 'text/html')
    if (isViteFallbackHtmlDocument(importedDocument)) {
      script.remove()
      continue
    }

    const importedDirectoryUrl = new URL('.', resolvedSource).toString()
    await inlineMsfsHtmlGaugeImports(importedDocument, htmlUiRootUrl, importedDirectoryUrl, visited)

    const importedNodes = [
      ...importedDocument.head.children,
      ...importedDocument.body.children
    ]
      .filter(node => !isDisposableImportedHtmlNode(node))
      .map(node => document.importNode(node, true))

    script.replaceWith(...importedNodes)
  }
}

function isMsfsHtmlImport(source: string): boolean {
  const pathname = new URL(source, window.location.href).pathname.toLowerCase()
  return pathname.endsWith('.html') || pathname.endsWith('.htm')
}

function isDisposableImportedHtmlNode(node: Element): boolean {
  return node.tagName.toLowerCase() === 'base' || node.tagName.toLowerCase() === 'title'
}

function isViteFallbackHtmlDocument(document: Document): boolean {
  return document.querySelector('script[src*="@vite/client"], script[src*="/src/main.ts"]') != null
}

function isBrowserProvidedMsfsImport(source: string): boolean {
  const normalized = source.trim().replaceAll('\\', '/').toLowerCase()
  return normalized === '/js/datastorage.js' || normalized.endsWith('/js/datastorage.js')
}

function getHtmlUiRootUrl(resolvedUrl: string): string {
  const marker = '/html_ui/'
  const markerIndex = resolvedUrl.toLowerCase().indexOf(marker)
  if (markerIndex < 0) {
    return new URL('.', resolvedUrl).toString()
  }

  return resolvedUrl.slice(0, markerIndex + marker.length)
}

function getPackageRootUrlFromHtmlUiRootUrl(htmlUiRootUrl: string): string {
  const marker = '/html_ui/'
  const markerIndex = htmlUiRootUrl.toLowerCase().indexOf(marker)
  if (markerIndex < 0) {
    return htmlUiRootUrl
  }

  return htmlUiRootUrl.slice(0, markerIndex + 1)
}

function resolveMsfsHtmlAssetUrl(
  source: string,
  htmlUiRootUrl: string,
  documentDirectoryUrl: string
): string {
  const trimmed = source.trim()
  const lowerTrimmed = trimmed.toLowerCase()
  const couiHtmlUiPrefix = 'coui://html_ui/'
  if (lowerTrimmed.startsWith(couiHtmlUiPrefix)) {
    return new URL(trimmed.slice(couiHtmlUiPrefix.length), htmlUiRootUrl).toString()
  }

  if (/^(?:[a-z][a-z0-9+.-]*:|data:|blob:)/iu.test(trimmed)) {
    return trimmed
  }

  if (trimmed.startsWith('/')) {
    const normalized = trimmed.slice(1)
    if (/^vfs\//iu.test(normalized)) {
      return new URL(normalized.slice(4), getPackageRootUrlFromHtmlUiRootUrl(htmlUiRootUrl)).toString()
    }
    return new URL(normalized, htmlUiRootUrl).toString()
  }

  return new URL(trimmed, documentDirectoryUrl).toString()
}

function createVCockpitGaugeBridgeScript(
  htmlUiRootUrl: string,
  resolvedUrl: string,
  updateThrottleMs: number | null,
  gaugeKind: VCockpitGaugeEntry['kind'],
  wasmBridge: boolean
): string {
  const packageRootUrl = getPackageRootUrlFromHtmlUiRootUrl(htmlUiRootUrl)
  return `
(() => {
  const noop = () => {};
  const zero = () => 0;
  const htmlUiRootUrl = ${JSON.stringify(htmlUiRootUrl)};
  const packageRootUrl = ${JSON.stringify(packageRootUrl)};
  const gaugeDocumentUrl = ${JSON.stringify(resolvedUrl)};
  const gaugeKind = ${JSON.stringify(gaugeKind)};
  const wasmBridge = ${JSON.stringify(wasmBridge)};
  const gaugeDocumentDirectoryUrl = new URL('.', gaugeDocumentUrl).toString();
  const instrumentUpdateMs = ${JSON.stringify(updateThrottleMs)};
  const runtimeReadMinIntervalMs = ${JSON.stringify(VCOCKPIT_RUNTIME_READ_MIN_INTERVAL_MS)};
  const resolveMsfsResourceUrl = value => {
    const text = String(value ?? '');
    const couiHtmlUiPrefix = 'coui://html_ui/';
    if (text.toLowerCase().startsWith(couiHtmlUiPrefix)) {
      try {
        return new URL(text.slice(couiHtmlUiPrefix.length), htmlUiRootUrl).toString();
      } catch {
        return text;
      }
    }
    if (text.startsWith('/')) {
      try {
        const normalized = text.replace(/^\\/+/, '');
        if (/^vfs\\//iu.test(normalized)) {
          return new URL(normalized.slice(4), packageRootUrl).toString();
        }
        return new URL(
          normalized,
          /^html_ui(?:\\/|$)/iu.test(normalized) ? packageRootUrl : htmlUiRootUrl
        ).toString();
      } catch {
        return text;
      }
    }
    if (/^(?:\\.\\.?\\/|[^:?#]+(?:\\/|$))/u.test(text)) {
      try {
        return new URL(text, gaugeDocumentDirectoryUrl).toString();
      } catch {
        return text;
      }
    }
    return text;
  };
  const rewriteStyleUrls = value => String(value ?? '').replace(
    /url\\((['"]?)(coui:\\/\\/html_ui\\/[^'")]+|\\/(?:JS|Pages|html_ui)\\/[^'")]+)\\1\\)/giu,
    (_match, quote, path) => 'url(' + quote + resolveMsfsResourceUrl(path) + quote + ')'
  );
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const normalizedName = String(name).toLowerCase();
    if (normalizedName === 'src' || normalizedName === 'href') {
      return nativeSetAttribute.call(this, name, resolveMsfsResourceUrl(value));
    }
    if (normalizedName === 'style') {
      return nativeSetAttribute.call(this, name, rewriteStyleUrls(value));
    }
    return nativeSetAttribute.call(this, name, value);
  };
  const imageSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (imageSrcDescriptor?.set != null && imageSrcDescriptor?.get != null) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: imageSrcDescriptor.enumerable,
      get: imageSrcDescriptor.get,
      set(value) {
        imageSrcDescriptor.set.call(this, resolveMsfsResourceUrl(value));
      }
    });
  }
  const nativeStyleSetProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function(property, value, priority) {
    return nativeStyleSetProperty.call(this, property, rewriteStyleUrls(value), priority);
  };
  const cssTextDescriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
  if (cssTextDescriptor?.set != null && cssTextDescriptor?.get != null) {
    Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
      configurable: true,
      enumerable: cssTextDescriptor.enumerable,
      get: cssTextDescriptor.get,
      set(value) {
        cssTextDescriptor.set.call(this, rewriteStyleUrls(value));
      }
    });
  }
  const gaugeErrors = [];
  const gaugeAssetErrors = [];
  const gaugeResourceErrors = [];
  const recordGaugeError = error => {
    if (gaugeErrors.length >= 100) {
      gaugeErrors.splice(0, gaugeErrors.length - 99);
    }
    gaugeErrors.push({
      message: String(error?.message ?? error?.reason?.message ?? error?.type ?? error),
      filename: String(error?.filename ?? error?.target?.src ?? error?.target?.href ?? ''),
      lineno: Number(error?.lineno ?? 0),
      colno: Number(error?.colno ?? 0)
    });
  };
  const recordGaugeAssetError = event => {
    if (gaugeAssetErrors.length >= 100) {
      gaugeAssetErrors.splice(0, gaugeAssetErrors.length - 99);
    }
    const target = event?.target;
    gaugeAssetErrors.push({
      tagName: String(target?.tagName ?? ''),
      source: String(target?.currentSrc ?? target?.src ?? target?.href ?? target?.data ?? ''),
      outerHTML: String(target?.outerHTML ?? '').slice(0, 500)
    });
  };
  const recordGaugeResourceError = (source, status, statusText = '') => {
    if (gaugeResourceErrors.length >= 100) {
      gaugeResourceErrors.splice(0, gaugeResourceErrors.length - 99);
    }
    gaugeResourceErrors.push({
      source: String(source ?? ''),
      status: Number(status ?? 0),
      statusText: String(statusText ?? '')
    });
  };
  globalThis.__msfsGaugeErrors = gaugeErrors;
  globalThis.__msfsGaugeAssetErrors = gaugeAssetErrors;
  globalThis.__msfsGaugeResourceErrors = gaugeResourceErrors;
  window.addEventListener('error', event => {
    recordGaugeError(event);
    const target = event.target;
    if (target instanceof HTMLElement && target !== window) {
      recordGaugeAssetError(event);
    }
  }, true);
  window.addEventListener('unhandledrejection', event => {
    recordGaugeError(event);
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const source = input instanceof Request ? input.url : input;
    const resolvedSource = resolveMsfsResourceUrl(source);
    if (/\\.wasm(?:[?#]|$)/iu.test(String(resolvedSource))) {
      recordUnsupportedBridgeCall('nativeWasm.fetch', [resolvedSource]);
    }
    const request = input instanceof Request
      ? new Request(resolvedSource, input)
      : resolvedSource;
    return nativeFetch(request, init).then(response => {
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || (/\\/vfs\\//iu.test(String(resolvedSource)) && contentType.includes('text/html'))) {
        recordGaugeResourceError(resolvedSource, response.status, response.statusText);
      }
      return response;
    });
  };
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    const resolvedUrl = resolveMsfsResourceUrl(url);
    if (/\\.wasm(?:[?#]|$)/iu.test(String(resolvedUrl))) {
      recordUnsupportedBridgeCall('nativeWasm.xhr', [resolvedUrl]);
    }
    return nativeXhrOpen.call(this, method, resolvedUrl, ...args);
  };
  const bridgeStats = {
    unsupportedCalls: [],
    supportedHostServiceCalls: [],
    apiCallCounts: {},
    registeredSimVarCount: 0,
    registeredSimVarCacheHitCount: 0,
    storedSimVarCount: 0,
    runtimeRequestCount: 0,
    runtimeResponseCount: 0,
    runtimeErrorCount: 0,
    keyEventCount: 0,
    htmlEventCount: 0,
    hostServiceCallCount: 0,
    wasmBridge,
    gaugeKind,
    listenerCount: 0,
    commBusSubscriberCount: 0,
    storageWriteCount: 0
  };
  globalThis.__msfsGaugeBridgeStats = bridgeStats;
  const incrementBridgeCall = name => {
    bridgeStats.apiCallCounts[name] = (bridgeStats.apiCallCounts[name] ?? 0) + 1;
  };
  const serializeBridgeArg = value => {
    if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
      return value;
    }
    try {
      return JSON.stringify(value).slice(0, 300);
    } catch {
      return Object.prototype.toString.call(value);
    }
  };
  const recordUnsupportedBridgeCall = (name, args = []) => {
    incrementBridgeCall(name);
    if (bridgeStats.unsupportedCalls.length >= 100) {
      bridgeStats.unsupportedCalls.splice(0, bridgeStats.unsupportedCalls.length - 99);
    }
    bridgeStats.unsupportedCalls.push({
      name: String(name),
      args: Array.from(args).slice(0, 8).map(serializeBridgeArg)
    });
  };
  const recordSupportedHostServiceCall = (name, args = []) => {
    incrementBridgeCall(name);
    bridgeStats.hostServiceCallCount += 1;
    if (bridgeStats.supportedHostServiceCalls.length >= 100) {
      bridgeStats.supportedHostServiceCalls.splice(0, bridgeStats.supportedHostServiceCalls.length - 99);
    }
    bridgeStats.supportedHostServiceCalls.push({
      name: String(name),
      args: Array.from(args).slice(0, 8).map(serializeBridgeArg)
    });
  };
  let nextRuntimeRequestId = 1;
  const pendingRuntimeRequests = new Map();
  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.type !== 'msfs-vcockpit-runtime-response') {
      return;
    }
    const pending = pendingRuntimeRequests.get(data.id);
    if (pending == null) {
      return;
    }
    pendingRuntimeRequests.delete(data.id);
    bridgeStats.runtimeResponseCount += 1;
    if (data.ok === false) {
      bridgeStats.runtimeErrorCount += 1;
      pending.reject(new Error(String(data.error ?? 'MSFS runtime bridge request failed')));
      return;
    }
    pending.resolve(data.value);
  });
  const postRuntimeRequest = payload => new Promise((resolve, reject) => {
    const id = nextRuntimeRequestId++;
    bridgeStats.runtimeRequestCount += 1;
    pendingRuntimeRequests.set(id, { resolve, reject });
    window.parent?.postMessage({
      type: 'msfs-vcockpit-runtime-request',
      id,
      ...payload
    }, '*');
    window.setTimeout(() => {
      if (!pendingRuntimeRequests.has(id)) {
        return;
      }
      pendingRuntimeRequests.delete(id);
      bridgeStats.runtimeErrorCount += 1;
      reject(new Error('MSFS runtime bridge request timed out'));
    }, 2000);
  });
  const postRuntimeNotification = payload => {
    const id = nextRuntimeRequestId++;
    bridgeStats.runtimeRequestCount += 1;
    window.parent?.postMessage({
      type: 'msfs-vcockpit-runtime-request',
      id,
      ...payload
    }, '*');
  };
  let gaugeChangeVersion = 1;
  let pendingDirtyMessage = false;
  let dirtyMessageCount = 0;
  let postedDirtyMessageCount = 0;
  let coalescedDirtyMessageCount = 0;
  let dirtyBurstCount = 0;
  let lastDirtyMarkMs = -Infinity;
  let pendingDirtyKind = null;
  let gaugeRuntimeActive = true;
  let runtimeBridgeActive = false;
  const dirtyStats = {
    dirtyMessageCount,
    postedDirtyMessageCount,
    coalescedDirtyMessageCount,
    dirtyBurstCount
  };
  globalThis.__msfsGaugeDirtyStats = dirtyStats;
  const setGaugeRuntimeActive = value => {
    gaugeRuntimeActive = value !== false;
    if (gaugeRuntimeActive) {
      markGaugeChanged();
    }
  };
  globalThis.__msfsSetGaugeActive = setGaugeRuntimeActive;
  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.type === 'msfs-vcockpit-gauge-active') {
      runtimeBridgeActive = true;
      setGaugeRuntimeActive(data.active);
    }
  });
  const postGaugeDirtyMessage = () => {
    if (!gaugeRuntimeActive) {
      pendingDirtyMessage = false;
      pendingDirtyKind = null;
      return;
    }

    pendingDirtyMessage = false;
    const kind = pendingDirtyKind ?? 'unknown';
    pendingDirtyKind = null;
    postedDirtyMessageCount += 1;
    dirtyStats.postedDirtyMessageCount = postedDirtyMessageCount;
    window.parent?.postMessage({
      type: 'msfs-vcockpit-gauge-dirty',
      version: gaugeChangeVersion,
      kind
    }, '*');
  };
  const getDirtyPostDelayMs = () => {
    if (dirtyBurstCount > 600) return 500;
    if (dirtyBurstCount > 240) return 250;
    if (dirtyBurstCount > 120) return 100;
    if (dirtyBurstCount > 60) return 50;
    return 0;
  };
  const mergeDirtyKind = nextKind => {
    if (pendingDirtyKind === 'dom' || nextKind === 'dom') return 'dom';
    if (pendingDirtyKind === 'unknown' || nextKind == null || nextKind === 'unknown') return 'unknown';
    return 'canvas';
  };
  const markGaugeChanged = (kind = 'unknown') => {
    if (!gaugeRuntimeActive) {
      return;
    }

    if (pendingDirtyMessage) {
      pendingDirtyKind = mergeDirtyKind(kind);
      coalescedDirtyMessageCount += 1;
      dirtyStats.coalescedDirtyMessageCount = coalescedDirtyMessageCount;
      return;
    }

    const nowMs = performance.now();
    if (nowMs - lastDirtyMarkMs > 1000) {
      dirtyBurstCount = 0;
    }
    lastDirtyMarkMs = nowMs;
    dirtyBurstCount += 1;
    dirtyMessageCount += 1;
    gaugeChangeVersion += 1;
    globalThis.__msfsGaugeChangeVersion = gaugeChangeVersion;
    dirtyStats.dirtyMessageCount = dirtyMessageCount;
    dirtyStats.dirtyBurstCount = dirtyBurstCount;
    pendingDirtyMessage = true;
    pendingDirtyKind = mergeDirtyKind(kind);
    const delayMs = getDirtyPostDelayMs();
    if (delayMs > 0) {
      window.setTimeout(postGaugeDirtyMessage, delayMs);
      return;
    }
    window.requestAnimationFrame(postGaugeDirtyMessage);
  };
  const markGaugeCanvasChanged = () => {
    if (pendingDirtyMessage) {
      return;
    }
    markGaugeChanged('canvas');
  };
  globalThis.__msfsGaugeChangeVersion = gaugeChangeVersion;
  window.setTimeout(postGaugeDirtyMessage, 0);
  const observeGaugeDomChanges = () => {
    const root = document.documentElement ?? document.body;
    if (root == null || typeof MutationObserver === 'undefined') {
      return;
    }
    const observer = new MutationObserver(() => markGaugeChanged('dom'));
    observer.observe(root, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    globalThis.__msfsGaugeMutationObserver = observer;
  };
  const markCanvasDrawMethods = [
    'clearRect',
    'drawFocusIfNeeded',
    'drawImage',
    'fill',
    'fillRect',
    'fillText',
    'putImageData',
    'reset',
    'stroke',
    'strokeRect',
    'strokeText'
  ];
  for (const methodName of markCanvasDrawMethods) {
    const original = CanvasRenderingContext2D.prototype[methodName];
    if (typeof original !== 'function') {
      continue;
    }
    CanvasRenderingContext2D.prototype[methodName] = function(...args) {
      markGaugeCanvasChanged();
      return original.apply(this, args);
    };
  }
  const ensureBody = () => {
    if (document.body != null) {
      return document.body;
    }
    const body = document.createElement('body');
    document.documentElement.appendChild(body);
    return body;
  };
  const ensureVCockpitPanelHost = () => {
    const body = ensureBody();
    let panel = body.querySelector('vcockpit-panel');
    if (panel == null) {
      panel = document.createElement('vcockpit-panel');
      panel.style.display = 'none';
      body.appendChild(panel);
    }
    const desiredTagName = gaugeKind === 'wasmInstrument' ? 'wasm-instrument' : 'html-gauge';
    let gaugeHost = Array.from(panel.children).find(child => child.tagName.toLowerCase() === desiredTagName);
    if (gaugeHost == null) {
      gaugeHost = document.createElement(desiredTagName);
      panel.appendChild(gaugeHost);
    }
    gaugeHost.setAttribute('url', gaugeDocumentUrl);
    if (wasmBridge) {
      gaugeHost.setAttribute('wasm-bridge', 'unsupported-native-abi');
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeGaugeDomChanges, { once: true });
  } else {
    observeGaugeDomChanges();
  }
  ensureVCockpitPanelHost();
  const registeredSimVars = new Map();
  const registeredSimVarById = [];
  const registeredSimVarFastIds = new Map();
  const simVarValues = new Map();
  const runtimeReadRequests = new Map();
  const runtimeReadRequestTimes = new Map();
  const normalizeRuntimeBridgeVariableName = (name, source = '') => {
    const text = String(name ?? '').trim();
    if (/^[ALOKHBEI]:/iu.test(text)) return text.toUpperCase();
    if (String(source).toLowerCase() === 'gamevar') return 'A:' + text.toUpperCase();
    if (String(source).toLowerCase() === 'globalvar') return 'A:' + text.toUpperCase();
    return 'A:' + text.toUpperCase();
  };
  const normalizeSimVarKey = (name, unit = '', source = '') =>
    normalizeRuntimeBridgeVariableName(name, source).toLowerCase() + '|' + String(unit).toLowerCase();
  const readDemoSimVar = (name, unit) => {
    const normalizedName = String(name ?? '').toLowerCase();
    const normalizedUnit = String(unit ?? '').toLowerCase();
    const hasPower =
      simVarValues.get(normalizeSimVarKey('ELECTRICAL MASTER BATTERY', 'Bool', '')) === 1 ||
      simVarValues.get(normalizeSimVarKey('EXTERNAL POWER ON', 'Bool', '')) === 1 ||
      simVarValues.get(normalizeSimVarKey('APU GENERATOR SWITCH:1', 'Bool', '')) === 1 ||
      simVarValues.get(normalizeSimVarKey('GENERAL ENG MASTER ALTERNATOR:1', 'Bool', '')) === 1 ||
      simVarValues.get(normalizeSimVarKey('GENERAL ENG MASTER ALTERNATOR:2', 'Bool', '')) === 1;
    if (normalizedUnit.includes('bool')) {
      if (normalizedName.includes('healthy') || normalizedName.includes('available') || normalizedName.includes('valid')) {
        return 1;
      }
      return normalizedName.includes('power') ||
        normalizedName.includes('powered') ||
        normalizedName.includes('electric') ||
        normalizedName.includes('bus') ||
        normalizedName.includes('circuit') ||
        normalizedName.includes('light')
        ? hasPower ? 1 : 0
        : 0;
    }
    if (normalizedName.includes('brightness') || normalizedName.includes('potentiometer')) {
      const poweredValue = hasPower ? 100 : 0;
      return normalizedUnit.includes('percent over 100') ? poweredValue / 100 : poweredValue;
    }
    if (normalizedName.includes('absolute time')) {
      return Date.now() / 1000 + 62135596800;
    }
    if (normalizedName.includes('simulation time')) {
      return performance.now() / 1000;
    }
    if (normalizedName.includes('latitude')) return 0;
    if (normalizedName.includes('longitude')) return 0;
    if (normalizedName.includes('altitude')) return 10000;
    if (normalizedName.includes('heading')) return 0;
    if (normalizedName.includes('airspeed')) return 250;
    if (normalizedName.includes('mach')) return 0.78;
    if (normalizedName.includes('ambient pressure')) return 29.92;
    if (normalizedName.includes('ambient temperature')) return 15;
    if (normalizedName.includes('voltage') || normalizedName.includes('volts')) return hasPower ? 28 : 0;
    if (normalizedName.includes('power') || normalizedName.includes('powered')) return hasPower ? 1 : 0;
    if (normalizedUnit.includes('percent over 100')) return hasPower ? 1 : 0;
    if (normalizedUnit.includes('percent')) return hasPower ? 100 : 0;
    return 0;
  };
  const readDemoStringValue = name => {
    const normalizedName = String(name ?? '').toLowerCase();
    if (normalizedName.includes('navdata') && normalizedName.includes('date range')) {
      return 'MAY07JUN03/26';
    }
    if (normalizedName.includes('aircraft') && normalizedName.includes('title')) {
      return document.title || 'MSFS Aircraft';
    }
    return '';
  };
  const readBoolSimVar = name => readDemoSimVar(name, 'Bool') === 1;
  const readNumberSimVar = (name, unit = 'Number') => Number(readDemoSimVar(name, unit)) || 0;
  const createSimplaneFallback = () => new Proxy({
    getAltitude: () => readNumberSimVar('PLANE ALTITUDE', 'Feet'),
    getAltitudeAboveGround: () => readNumberSimVar('PLANE ALT ABOVE GROUND', 'Feet'),
    getIndicatedSpeed: () => readNumberSimVar('AIRSPEED INDICATED', 'Knots'),
    getTrueSpeed: () => readNumberSimVar('AIRSPEED TRUE', 'Knots'),
    getMachSpeed: () => readNumberSimVar('AIRSPEED MACH', 'Mach'),
    getVerticalSpeed: () => readNumberSimVar('VERTICAL SPEED', 'Feet per minute'),
    getHeadingMagnetic: () => readNumberSimVar('PLANE HEADING DEGREES MAGNETIC', 'Degrees'),
    getHeadingTrue: () => readNumberSimVar('PLANE HEADING DEGREES TRUE', 'Degrees'),
    getTrackAngle: () => readNumberSimVar('GPS GROUND TRUE TRACK', 'Degrees'),
    getGroundSpeed: () => readNumberSimVar('GPS GROUND SPEED', 'Knots'),
    getAutoPilotDisplayedAltitudeLockValue: () => readNumberSimVar('AUTOPILOT ALTITUDE LOCK VAR', 'Feet'),
    getAutoPilotAltitudeLockValue: () => readNumberSimVar('AUTOPILOT ALTITUDE LOCK VAR', 'Feet'),
    getAutoPilotSelectedAltitudeLockValue: () => readNumberSimVar('AUTOPILOT ALTITUDE LOCK VAR', 'Feet'),
    getAutoPilotDisplayedHeadingValue: () => readNumberSimVar('AUTOPILOT HEADING LOCK DIR', 'Degrees'),
    getAutoPilotHeadingLockValue: () => readNumberSimVar('AUTOPILOT HEADING LOCK DIR', 'Degrees'),
    getAutoPilotAirspeedHoldValue: () => readNumberSimVar('AUTOPILOT AIRSPEED HOLD VAR', 'Knots'),
    getAutoPilotMachHoldValue: () => readNumberSimVar('AUTOPILOT MACH HOLD VAR', 'Mach'),
    getAutoPilotVerticalSpeedHoldValue: () => readNumberSimVar('AUTOPILOT VERTICAL HOLD VAR', 'Feet per minute'),
    getAutoPilotAirspeedManaged: () => readBoolSimVar('AUTOPILOT AIRSPEED MANAGED'),
    getAutoPilotHeadingManaged: () => readBoolSimVar('AUTOPILOT HEADING MANAGED'),
    getAutoPilotAltitudeManaged: () => readBoolSimVar('AUTOPILOT ALTITUDE MANAGED'),
    getAutoPilotFlightDirectorActive: () => readBoolSimVar('AUTOPILOT FLIGHT DIRECTOR ACTIVE'),
    getAutoPilotActive: () => readBoolSimVar('AUTOPILOT MASTER'),
    getIsGrounded: () => readBoolSimVar('SIM ON GROUND'),
    getEngineActive: () => true,
    getEngineThrottleMode: () => 0,
    getEngineThrottleCommandedN1: () => 0,
    getEngineThrottlePosition: () => 0,
    getOrientationAxis: () => ({ pitch: 0, bank: 0, heading: readNumberSimVar('PLANE HEADING DEGREES TRUE', 'Degrees') }),
    getCurrentLat: () => readNumberSimVar('PLANE LATITUDE', 'Degrees'),
    getCurrentLon: () => readNumberSimVar('PLANE LONGITUDE', 'Degrees'),
    getFlapsHandleIndex: () => 0,
    getFlapsHandlePercent: () => 0,
    getTrim: () => 0,
    getTotalAirTemperature: () => readNumberSimVar('TOTAL AIR TEMPERATURE', 'Celsius'),
    getAmbientTemperature: () => readNumberSimVar('AMBIENT TEMPERATURE', 'Celsius'),
    getPressureSelectedMode: () => 'STD',
    getPressureValue: () => readNumberSimVar('KOHLSMAN SETTING HG', 'inHg')
  }, {
    get(target, property) {
      if (property in target) {
        return target[property];
      }
      if (typeof property === 'string' && property.startsWith('get')) {
        return (...args) => {
          recordUnsupportedBridgeCall('Simplane.' + property, args);
          return property.startsWith('getIs') || property.endsWith('Active') ? false : 0;
        };
      }
      return undefined;
    }
  });
  const registerSimVar = (name, unit, source = '') => {
    const key = String(source) + '|' + String(name) + '|' + String(unit);
    if (registeredSimVars.has(key)) {
      return registeredSimVars.get(key);
    }
    const id = registeredSimVarById.length;
    registeredSimVars.set(key, id);
    registeredSimVarById.push({ name, unit, source });
    bridgeStats.registeredSimVarCount = registeredSimVarById.length;
    return id;
  };
  const getRegisteredSimVarFastId = (name, unit, source = 'SimVar') => {
    const key = String(source) + '|' + String(name) + '|' + String(unit);
    const cached = registeredSimVarFastIds.get(key);
    if (cached != null) {
      bridgeStats.registeredSimVarCacheHitCount += 1;
      return cached;
    }

    incrementBridgeCall('SimVar.GetRegisteredId');
    const id = registerSimVar(name, unit, source);
    registeredSimVarFastIds.set(key, id);
    return id;
  };
  const normalizeDependencyValue = value => {
    if (value == null || typeof value !== 'object') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  let activeDependencyCollector = null;
  const dependencyInputs = new Map();
  const recordDependencyValue = (source, name, unit, value) => {
    if (activeDependencyCollector == null) {
      return value;
    }
    const key = String(source) + '|' + String(name) + '|' + String(unit);
    dependencyInputs.set(key, { source, name, unit });
    activeDependencyCollector.set(key, normalizeDependencyValue(value));
    return value;
  };
  const readTrackedDemoSimVar = (name, unit, source = '') => {
    if (String(unit ?? '').toLowerCase().includes('string')) {
      return recordDependencyValue(source, name, unit, readDemoStringValue(name));
    }
    const runtimeName = normalizeRuntimeBridgeVariableName(name, source);
    const storedKey = normalizeSimVarKey(name, unit, source);
    const fallbackKey = normalizeSimVarKey(runtimeName, unit, '');
    const value = simVarValues.has(storedKey)
      ? simVarValues.get(storedKey)
        : simVarValues.has(fallbackKey)
          ? simVarValues.get(fallbackKey)
          : readDemoSimVar(name, unit);
    const nowMs = performance.now();
    const lastRequestMs = runtimeReadRequestTimes.get(storedKey) ?? -Infinity;
    if (
      runtimeBridgeActive &&
      !runtimeReadRequests.has(storedKey) &&
      nowMs - lastRequestMs > runtimeReadMinIntervalMs
    ) {
      runtimeReadRequestTimes.set(storedKey, nowMs);
      const request = postRuntimeRequest({
        op: 'readVariable',
        name: runtimeName,
        unit
      }).then(nextValue => {
        const numericValue = Number(nextValue);
        if (Number.isFinite(numericValue)) {
          simVarValues.set(storedKey, numericValue);
          bridgeStats.storedSimVarCount = simVarValues.size;
        }
      }).catch(() => {
        // The cached/fallback value remains usable; aggregate timeout counts live in bridgeStats.
      }).finally(() => {
        runtimeReadRequests.delete(storedKey);
      });
      runtimeReadRequests.set(storedKey, request);
    }
    return recordDependencyValue(source, name, unit, value);
  };
  const readCurrentSimVar = (name, unit, source = '') => {
    if (String(unit ?? '').toLowerCase().includes('string')) {
      return readDemoStringValue(name);
    }
    const runtimeName = normalizeRuntimeBridgeVariableName(name, source);
    const storedKey = normalizeSimVarKey(name, unit, source);
    const fallbackKey = normalizeSimVarKey(runtimeName, unit, '');
    return simVarValues.has(storedKey)
      ? simVarValues.get(storedKey)
      : simVarValues.has(fallbackKey)
        ? simVarValues.get(fallbackKey)
        : readDemoSimVar(name, unit);
  };
  const writeTrackedSimVar = (name, unit, value, source = '') => {
    const runtimeName = normalizeRuntimeBridgeVariableName(name, source);
    const numericValue = Number(value);
    simVarValues.set(normalizeSimVarKey(runtimeName, unit, source), Number.isFinite(numericValue) ? numericValue : 0);
    bridgeStats.storedSimVarCount = simVarValues.size;
    markGaugeChanged('unknown');
    if (/^K:/iu.test(runtimeName)) {
      return triggerRuntimeKeyEvent(runtimeName.slice(2), [Number(value ?? 0)]);
    }
    postRuntimeNotification({
      op: 'writeVariable',
      name: runtimeName,
      unit,
      value: Number.isFinite(numericValue) ? numericValue : 0
    });
    return Promise.resolve(Number.isFinite(numericValue) ? numericValue : 0);
  };
  const triggerRuntimeKeyEvent = (name, args = []) => {
    incrementBridgeCall('KeyEvent:' + String(name ?? ''));
    bridgeStats.keyEventCount += 1;
    markGaugeChanged('unknown');
    postRuntimeNotification({
      op: 'keyEvent',
      name: String(name ?? '').replace(/^K:/iu, ''),
      args: Array.from(args).map(value => Number(value) || 0)
    });
    return Promise.resolve(0);
  };
  const readTrackedRegisteredSimVar = id => {
    const entry = registeredSimVarById[id];
    if (entry == null) {
      return recordDependencyValue('registered', 'missing', id, 0);
    }
    return readTrackedDemoSimVar(entry.name, entry.unit, entry.source);
  };
  const hasChangedDependency = ([key, previousValue]) => {
    const input = dependencyInputs.get(key);
    if (input == null) {
      return true;
    }
    return normalizeDependencyValue(readCurrentSimVar(input.name, input.unit, input.source)) !== previousValue;
  };
  globalThis.simvar ??= {
    getValueReg: id => readTrackedRegisteredSimVar(id),
    getValueReg_String: id => String(readTrackedRegisteredSimVar(id)),
    getValue_LatLongAlt: () => recordDependencyValue('simvar', 'LatLongAlt', '', { lat: 0, long: 0, alt: 10000 }),
    getValue_LatLongAltPBH: () => recordDependencyValue('simvar', 'LatLongAltPBH', '', { lat: 0, long: 0, alt: 10000, pitch: 0, bank: 0, heading: 0 }),
    getValue_PBH: () => recordDependencyValue('simvar', 'PBH', '', { pitch: 0, bank: 0, heading: 0 }),
    getValue_PID_STRUCT: () => recordDependencyValue('simvar', 'PID_STRUCT', '', { pid_p: 0, pid_i: 0, pid_d: 0 }),
    getValue_XYZ: () => recordDependencyValue('simvar', 'XYZ', '', { x: 0, y: 0, z: 0 })
  };
  class CodexBaseInstrument extends HTMLElement {
    constructor() {
      super();
      this._lastUpdateMs = performance.now();
    }
    connectedCallback() {
      if (this.__msfsTemplateAttached) {
        return;
      }
      this.__msfsTemplateAttached = true;
      const templateId = this.templateID;
      const template = typeof templateId === 'string'
        ? document.getElementById(templateId)
        : null;
      if (template?.textContent) {
        const holder = document.createElement('div');
        holder.innerHTML = template.textContent;
        while (holder.firstChild) {
          this.appendChild(holder.firstChild);
        }
      }
    }
    disconnectedCallback() {}
    Update() {}
    getGameState() {
      return globalThis.GameState?.ingame ?? 2;
    }
    onInteractionEvent() {}
    onGameStateChanged() {}
    onFlightStart() {}
    onSoundEnd() {}
  }
  class CodexWasmInstrument extends CodexBaseInstrument {
    connectedCallback() {
      super.connectedCallback();
      this.dataset.msfsInstrument ??= 'synthetic-wasm-bridge';
      this.dataset.msfsWasmBridge = 'true';
      if (!this.querySelector('[data-msfs-wasm-placeholder]')) {
        const placeholder = document.createElement('span');
        placeholder.dataset.msfsWasmPlaceholder = 'true';
        placeholder.hidden = true;
        this.appendChild(placeholder);
      }
    }
  }
  class LatLongAlt {
    constructor(latOrValue = 0, long = 0, alt = 0) {
      if (typeof latOrValue === 'object' && latOrValue != null) {
        this.lat = Number(latOrValue.lat ?? latOrValue.latitude ?? 0);
        this.long = Number(latOrValue.long ?? latOrValue.lon ?? latOrValue.longitude ?? 0);
        this.alt = Number(latOrValue.alt ?? latOrValue.altitude ?? 0);
        return;
      }
      this.lat = Number(latOrValue);
      this.long = Number(long);
      this.alt = Number(alt);
    }
  }
  class LatLongAltPBH extends LatLongAlt {
    constructor(value = 0, long = 0, alt = 0, pitch = 0, bank = 0, heading = 0) {
      super(value, long, alt);
      if (typeof value === 'object' && value != null) {
        this.pitch = Number(value.pitch ?? 0);
        this.bank = Number(value.bank ?? 0);
        this.heading = Number(value.heading ?? 0);
        return;
      }
      this.pitch = Number(pitch);
      this.bank = Number(bank);
      this.heading = Number(heading);
    }
  }
  class LatLong {
    constructor(latOrValue = 0, long = 0) {
      if (typeof latOrValue === 'object' && latOrValue != null) {
        this.lat = Number(latOrValue.lat ?? latOrValue.latitude ?? 0);
        this.long = Number(latOrValue.long ?? latOrValue.lon ?? latOrValue.longitude ?? 0);
        return;
      }
      this.lat = Number(latOrValue);
      this.long = Number(long);
    }
  }
  class CodexBingMapElement extends HTMLElement {
    constructor() {
      super();
      this.m_configId = 0;
      this.m_configs = [];
    }
    connectedCallback() {
      this.dataset.msfsPlaceholder = 'bing-map';
      this.style.display ||= 'block';
      this.style.width ||= '100%';
      this.style.height ||= '100%';
      this.style.background ||= 'rgba(0, 12, 18, 0.85)';
    }
    setConfig(configId) { this.m_configId = Number(configId) || 0; }
    setBingId(id) { this.dataset.bingId = String(id ?? ''); }
    setVisible(visible) { this.style.visibility = visible ? 'visible' : 'hidden'; }
    setParams(params) { this._params = params; }
    setPositionRadius(lla, radius) { this._params = { lla, radius }; }
  }
  class SvgMapConfig {
    constructor() {
      this.loaded = false;
      this.path = '';
    }
    load(path, callback) {
      this.loaded = true;
      this.path = String(path ?? '');
      callback?.();
    }
    generateBingMap(mapElement) {
      if (mapElement != null) {
        mapElement.m_configs ??= [];
        mapElement.m_configs.push({ id: 'placeholder', path: this.path });
      }
    }
  }
  class PitchBankHeading {
    constructor(value = 0, bank = 0, heading = 0) {
      if (typeof value === 'object' && value != null) {
        this.pitch = Number(value.pitch ?? 0);
        this.bank = Number(value.bank ?? 0);
        this.heading = Number(value.heading ?? 0);
        return;
      }
      this.pitch = Number(value);
      this.bank = Number(bank);
      this.heading = Number(heading);
    }
  }
  class PID_STRUCT {
    constructor(value = 0, i = 0, d = 0) {
      if (typeof value === 'object' && value != null) {
        this.pid_p = Number(value.pid_p ?? value.p ?? 0);
        this.pid_i = Number(value.pid_i ?? value.i ?? 0);
        this.pid_d = Number(value.pid_d ?? value.d ?? 0);
        return;
      }
      this.pid_p = Number(value);
      this.pid_i = Number(i);
      this.pid_d = Number(d);
    }
  }
  class XYZ {
    constructor(value = 0, y = 0, z = 0) {
      if (typeof value === 'object' && value != null) {
        this.x = Number(value.x ?? 0);
        this.y = Number(value.y ?? 0);
        this.z = Number(value.z ?? 0);
        return;
      }
      this.x = Number(value);
      this.y = Number(y);
      this.z = Number(z);
    }
  }
  globalThis.BaseInstrument ??= CodexBaseInstrument;
  if (!customElements.get('wasm-instrument')) {
    customElements.define('wasm-instrument', CodexWasmInstrument);
  }
  if (!customElements.get('bing-map')) {
    customElements.define('bing-map', CodexBingMapElement);
  }
  globalThis.LatLong ??= LatLong;
  globalThis.LatLongAlt ??= LatLongAlt;
  globalThis.LatLongAltPBH ??= LatLongAltPBH;
  globalThis.SvgMapConfig ??= SvgMapConfig;
  globalThis.PitchBankHeading ??= PitchBankHeading;
  globalThis.PID_STRUCT ??= PID_STRUCT;
  globalThis.XYZ ??= XYZ;
  globalThis.Vec2 ??= class Vec2 {
    constructor(x = 0, y = 0) {
      this.x = Number(x);
      this.y = Number(y);
    }
  };
  globalThis.Vec3 ??= class Vec3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = Number(x);
      this.y = Number(y);
      this.z = Number(z);
    }
  };
  globalThis.Size ??= class Size {
    constructor(width = 0, height = 0) {
      this.width = Number(width);
      this.height = Number(height);
    }
  };
  globalThis.RunwayDesignator ??= {
    RUNWAY_DESIGNATOR_NONE: 0,
    RUNWAY_DESIGNATOR_LEFT: 1,
    RUNWAY_DESIGNATOR_RIGHT: 2,
    RUNWAY_DESIGNATOR_CENTER: 3,
    RUNWAY_DESIGNATOR_WATER: 4,
    RUNWAY_DESIGNATOR_A: 5,
    RUNWAY_DESIGNATOR_B: 6
  };
  globalThis.EmptyCallback ??= { Void: noop };
  globalThis.Simplane ??= createSimplaneFallback();
  globalThis.GameState ??= {
    briefing: 0,
    loading: 1,
    ingame: 2,
    mainmenu: 3
  };
  globalThis.InputBar ??= {
    MENU_BUTTON_A: 'KEY_MENU_VALID'
  };
  const instrumentRegistry = globalThis.__msfsInstrumentRegistry ?? new Map();
  globalThis.__msfsInstrumentRegistry = instrumentRegistry;
  const instrumentRuntimeStats = globalThis.__msfsInstrumentRuntimeStats ?? {
    registerCallCount: 0,
    createdElementCount: 0,
    reusedElementCount: 0,
    activeLoopCount: 0,
    updateCallCount: 0
  };
  globalThis.__msfsInstrumentRuntimeStats = instrumentRuntimeStats;
  globalThis.registerInstrument ??= (tagName, InstrumentClass) => {
    if (typeof tagName !== 'string' || typeof InstrumentClass !== 'function') {
      return;
    }
    instrumentRuntimeStats.registerCallCount += 1;
    const normalizedTagName = tagName.includes('-') ? tagName.toLowerCase() : 'msfs-' + tagName.toLowerCase();
    if (!customElements.get(normalizedTagName)) {
      customElements.define(normalizedTagName, InstrumentClass);
    }
    const registered = instrumentRegistry.get(normalizedTagName);
    if (registered?.element?.isConnected) {
      window.__msfsInstrumentElement = registered.element;
      instrumentRuntimeStats.reusedElementCount += 1;
      return registered.element;
    }

    const element = document.createElement(normalizedTagName);
    element.dataset.msfsInstrument = normalizedTagName;
    ensureBody().appendChild(element);
    window.__msfsInstrumentElement = element;
    instrumentRuntimeStats.createdElementCount += 1;
    instrumentRuntimeStats.activeLoopCount += 1;
    instrumentRegistry.set(normalizedTagName, { element });
    let lastUpdateMs = -Infinity;
    let lastDependencyProbeMs = -Infinity;
    let dependencySnapshot = null;
    let consecutiveUpdateErrors = 0;
    let nextUpdateErrorLogMs = -Infinity;
    let nextUpdateAfterErrorMs = -Infinity;
    const shouldRunInstrumentUpdate = nowMs => {
      if (nowMs < nextUpdateAfterErrorMs) {
        return false;
      }

      if (instrumentUpdateMs != null) {
        if (instrumentUpdateMs <= 0) {
          return true;
        }
        return nowMs - lastUpdateMs >= instrumentUpdateMs;
      }

      if (dependencySnapshot == null) {
        return true;
      }

      if (nowMs - lastDependencyProbeMs < 100) {
        return false;
      }
      lastDependencyProbeMs = nowMs;

      return dependencySnapshot.size > 0 &&
        Array.from(dependencySnapshot.entries()).some(hasChangedDependency);
    };
    const getNextInstrumentUpdateDelayMs = nowMs => {
      if (!gaugeRuntimeActive) {
        return 250;
      }

      if (nowMs < nextUpdateAfterErrorMs) {
        return nextUpdateAfterErrorMs - nowMs;
      }

      if (instrumentUpdateMs != null) {
        if (instrumentUpdateMs <= 0) {
          return 0;
        }
        return Math.max(0, instrumentUpdateMs - (nowMs - lastUpdateMs));
      }

      if (dependencySnapshot == null) {
        return 0;
      }

      return Math.max(0, 100 - (nowMs - lastDependencyProbeMs));
    };
    const scheduleInstrumentUpdate = delayMs => {
      if (delayMs <= 8) {
        window.requestAnimationFrame(update);
        return;
      }
      window.setTimeout(() => window.requestAnimationFrame(update), delayMs);
    };
    const runInstrumentUpdate = nowMs => {
      lastUpdateMs = nowMs;
      const nextDependencies = new Map();
      activeDependencyCollector = nextDependencies;
      try {
        element.Update?.();
        instrumentRuntimeStats.updateCallCount += 1;
        consecutiveUpdateErrors = 0;
        nextUpdateAfterErrorMs = -Infinity;
      } catch (error) {
        consecutiveUpdateErrors += 1;
        if (consecutiveUpdateErrors <= 3 || nowMs >= nextUpdateErrorLogMs) {
          console.warn('MSFS instrument update failed', error);
          nextUpdateErrorLogMs = nowMs + 30000;
        }
        nextUpdateAfterErrorMs = nowMs + Math.min(1000, 100 * consecutiveUpdateErrors);
      } finally {
        activeDependencyCollector = null;
      }
      dependencySnapshot = nextDependencies;
    };
    const update = nowMs => {
      if (!element.isConnected) {
        instrumentRuntimeStats.activeLoopCount = Math.max(0, instrumentRuntimeStats.activeLoopCount - 1);
        return;
      }
      if (gaugeRuntimeActive && shouldRunInstrumentUpdate(nowMs)) {
        runInstrumentUpdate(nowMs);
      }
      scheduleInstrumentUpdate(getNextInstrumentUpdateDelayMs(performance.now()));
    };
    window.requestAnimationFrame(update);
  };
  globalThis.SimVar = { ...(globalThis.SimVar ?? {}) };
  globalThis.SimVar.GetRegisteredId = (name, unit, source = 'SimVar') => {
    return getRegisteredSimVarFastId(name, unit, source);
  };
  globalThis.SimVar.GetSimVarValue = (name, unit) => {
    incrementBridgeCall('SimVar.GetSimVarValue');
    return readTrackedDemoSimVar(name, unit, 'SimVar');
  };
  globalThis.SimVar.GetSimVarValueFastReg = id => {
    incrementBridgeCall('SimVar.GetSimVarValueFastReg');
    return readTrackedRegisteredSimVar(id);
  };
  globalThis.SimVar.SetSimVarValue = (name, unit, value) => {
    incrementBridgeCall('SimVar.SetSimVarValue');
    return writeTrackedSimVar(name, unit, value, 'SimVar');
  };
  globalThis.SimVar.GetGameVarValue = (name, unit) => {
    incrementBridgeCall('SimVar.GetGameVarValue');
    return readTrackedDemoSimVar(name, unit, 'GameVar');
  };
  globalThis.SimVar.SetGameVarValue = (name, unit, value) => {
    incrementBridgeCall('SimVar.SetGameVarValue');
    return writeTrackedSimVar(name, unit, value, 'GameVar');
  };
  globalThis.SimVar.GetGlobalVarValue = (name, unit) => {
    incrementBridgeCall('SimVar.GetGlobalVarValue');
    return readTrackedDemoSimVar(name, unit, 'GlobalVar');
  };
  globalThis.SimVar.SetGlobalVarValue = (name, unit, value) => {
    incrementBridgeCall('SimVar.SetGlobalVarValue');
    return writeTrackedSimVar(name, unit, value, 'GlobalVar');
  };
  globalThis.SimVar.SimVarBatch ??= class {
    constructor(countName, indexName) {
      this.countName = countName;
      this.indexName = indexName;
      this.entries = [];
    }

    add(name, unit, type = unit) {
      this.entries.push({ name, unit, type });
      return this;
    }
  };
  globalThis.SimVar.GetSimVarArrayValues = (batch, callback) => {
    incrementBridgeCall('SimVar.GetSimVarArrayValues');
    const entries = Array.isArray(batch?.entries) ? batch.entries : [];
    const count = Math.max(0, Math.min(512, Math.trunc(Number(readTrackedDemoSimVar(batch?.countName, 'Number', 'SimVar')) || 0)));
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      if (batch?.indexName != null) {
        writeTrackedSimVar(batch.indexName, 'Number', index, 'SimVar');
      }
      rows.push(entries.map(entry => readTrackedDemoSimVar(entry.name, entry.unit, 'SimVar')));
    }
    if (typeof callback === 'function') {
      window.setTimeout(() => callback(rows), 0);
    }
    return rows;
  };
  globalThis.SimVar.SetBatchSimVarValue = values => {
    incrementBridgeCall('SimVar.SetBatchSimVarValue');
    const entries = values == null
      ? []
      : typeof values[Symbol.iterator] === 'function'
        ? Array.from(values)
        : Object.values(values);
    const writes = [];
    for (const entry of entries) {
      if (Array.isArray(entry)) {
        writes.push(writeTrackedSimVar(entry[0], entry[1], entry[2], 'SimVar'));
      } else if (entry != null && typeof entry === 'object') {
        writes.push(writeTrackedSimVar(entry.name, entry.unit, entry.value, 'SimVar'));
      }
    }
    return Promise.all(writes).then(() => undefined);
  };
  const globalListeners = new Map();
  const interceptedKeyEvents = new Set();
  const subscribeGlobalListener = (eventName, listener) => {
    if (typeof listener !== 'function') {
      return noop;
    }
    const key = String(eventName ?? '');
    const existing = globalListeners.get(key) ?? new Set();
    existing.add(listener);
    globalListeners.set(key, existing);
    return () => {
      existing.delete(listener);
      if (existing.size === 0) {
        globalListeners.delete(key);
      }
    };
  };
  const unsubscribeGlobalListener = (eventName, listener) => {
    const existing = globalListeners.get(String(eventName ?? ''));
    if (listener == null) {
      existing?.clear();
    } else {
      existing?.delete(listener);
    }
  };
  const dispatchGlobalListener = (eventName, ...args) => {
    const key = String(eventName ?? '');
    const callbacks = [
      ...Array.from(globalListeners.get(key) ?? []),
      ...(key === '*' ? [] : Array.from(globalListeners.get('*') ?? []))
    ];
    for (const callback of callbacks) {
      try {
        callback(...args);
      } catch (error) {
        console.warn('MSFS gauge listener failed', eventName, error);
      }
    }
    return callbacks.length;
  };
  globalThis.__msfsDispatchCoherentEvent = dispatchGlobalListener;
  const commBusSubscribers = new Map();
  const normalizeCommBusChannel = channel => String(channel ?? '').trim();
  const updateCommBusSubscriberCount = () => {
    bridgeStats.commBusSubscriberCount = Array.from(commBusSubscribers.values())
      .reduce((total, subscribers) => total + subscribers.size, 0);
  };
  const subscribeCommBus = (channel, callback) => {
    const normalizedChannel = normalizeCommBusChannel(channel);
    if (normalizedChannel === '' || typeof callback !== 'function') {
      updateCommBusSubscriberCount();
      return noop;
    }
    const subscribers = commBusSubscribers.get(normalizedChannel) ?? new Set();
    subscribers.add(callback);
    commBusSubscribers.set(normalizedChannel, subscribers);
    updateCommBusSubscriberCount();
    return () => {
      subscribers.delete(callback);
      if (subscribers.size === 0) {
        commBusSubscribers.delete(normalizedChannel);
      }
      updateCommBusSubscriberCount();
    };
  };
  const unsubscribeCommBus = (channel, callback) => {
    const normalizedChannel = normalizeCommBusChannel(channel);
    if (normalizedChannel === '') {
      return;
    }
    const subscribers = commBusSubscribers.get(normalizedChannel);
    if (subscribers == null) {
      return;
    }
    if (typeof callback === 'function') {
      subscribers.delete(callback);
    } else {
      subscribers.clear();
    }
    if (subscribers.size === 0) {
      commBusSubscribers.delete(normalizedChannel);
    }
    updateCommBusSubscriberCount();
  };
  const callCommBus = (channel, ...args) => {
    const normalizedChannel = normalizeCommBusChannel(channel);
    if (normalizedChannel === '') {
      return 0;
    }
    let delivered = 0;
    for (const callback of commBusSubscribers.get(normalizedChannel) ?? []) {
      try {
        callback(...args);
        delivered += 1;
      } catch (error) {
        console.warn('MSFS fsCommBus callback failed', normalizedChannel, error);
      }
    }
    delivered += dispatchGlobalListener('fsCommBus:' + normalizedChannel, ...args);
    if (delivered > 0) {
      markGaugeChanged('unknown');
    }
    return delivered;
  };
  globalThis.fsCommBusRegister ??= (channel, callback) => {
    recordSupportedHostServiceCall('fsCommBusRegister', [channel]);
    subscribeCommBus(channel, callback);
    return normalizeCommBusChannel(channel);
  };
  globalThis.fsCommBusUnregister ??= (channel, callback) => {
    recordSupportedHostServiceCall('fsCommBusUnregister', [channel]);
    unsubscribeCommBus(channel, callback);
    return 0;
  };
  globalThis.fsCommBusCall ??= (channel, ...args) => {
    recordSupportedHostServiceCall('fsCommBusCall', [channel, ...args]);
    return callCommBus(channel, ...args);
  };
  const createListenerHandle = name => {
    incrementBridgeCall(name);
    bridgeStats.listenerCount += 1;
    const listeners = new Map();
    const globalUnsubscribers = new Map();
    const rememberGlobalUnsubscribe = (eventName, listener, unsubscribe) => {
      const key = String(eventName ?? '');
      const existing = globalUnsubscribers.get(key) ?? new Map();
      existing.set(listener, unsubscribe);
      globalUnsubscribers.set(key, existing);
    };
    const forgetGlobalUnsubscribe = (eventName, listener) => {
      const key = String(eventName ?? '');
      const existing = globalUnsubscribers.get(key);
      if (existing == null) {
        return;
      }
      existing.get(listener)?.();
      existing.delete(listener);
      if (existing.size === 0) {
        globalUnsubscribers.delete(key);
      }
    };
    const subscribe = (eventName, listener) => {
      if (typeof listener !== 'function') {
        return;
      }
      const key = String(eventName ?? '');
      const existing = listeners.get(key) ?? new Set();
      existing.add(listener);
      listeners.set(key, existing);
      rememberGlobalUnsubscribe(key, listener, subscribeGlobalListener(key, listener));
    };
    const unsubscribe = (eventName, listener) => {
      if (eventName == null) {
        listeners.clear();
        for (const removers of globalUnsubscribers.values()) {
          for (const remove of removers.values()) {
            remove();
          }
        }
        globalUnsubscribers.clear();
        return;
      }
      const existing = listeners.get(String(eventName));
      if (listener == null) {
        existing?.clear();
        const removers = globalUnsubscribers.get(String(eventName));
        for (const remove of removers?.values() ?? []) {
          remove();
        }
        globalUnsubscribers.delete(String(eventName));
      } else {
        existing?.delete(listener);
        forgetGlobalUnsubscribe(eventName, listener);
      }
    };
    const trigger = (eventName, ...args) => {
      const invoke = callback => callback(...args);
      listeners.get(String(eventName ?? ''))?.forEach(invoke);
      listeners.get('*')?.forEach(invoke);
    };
    return {
      name,
      on: subscribe,
      off: unsubscribe,
      clear: () => unsubscribe(),
      triggerToAllSubscribers: trigger,
      trigger,
      call: (...args) => {
        recordUnsupportedBridgeCall(name + '.call', args);
        return Promise.resolve();
      },
      unregister: () => unsubscribe()
    };
  };
  const dispatchInteractionEvent = (name, args) => {
    const eventName = String(name ?? '');
    const eventArgs = Array.isArray(args) && args.length > 0 ? args : [eventName];
    bridgeStats.htmlEventCount += 1;
    markGaugeChanged('unknown');
    dispatchGlobalListener('OnInteractionEvent', eventName, eventArgs);
    dispatchGlobalListener(eventName, ...eventArgs);
    const seen = new Set();
    const invokeInstrument = element => {
      if (element == null || seen.has(element) || typeof element.onInteractionEvent !== 'function') {
        return;
      }
      seen.add(element);
      try {
        element.onInteractionEvent(eventArgs);
      } catch (error) {
        console.warn('MSFS instrument interaction event failed', eventName, error);
      }
    };
    invokeInstrument(globalThis.__msfsInstrumentElement);
    for (const entry of instrumentRegistry.values()) {
      invokeInstrument(entry?.element);
    }
  };
  const dispatchKeyEvent = (name, args) => {
    const eventName = String(name ?? '').replace(/^K:/i, '');
    if (!interceptedKeyEvents.has(eventName.toUpperCase())) {
      return;
    }
    const eventArgs = Array.isArray(args) ? args.map(value => Number(value) || 0) : [];
    bridgeStats.keyEventCount += 1;
    markGaugeChanged('unknown');
    dispatchGlobalListener('keyIntercepted', eventName, eventArgs[1] ?? 0, eventArgs[0] ?? 0, eventArgs[2] ?? 0);
    dispatchGlobalListener('OnKeyIntercepted', eventName, eventArgs[1] ?? 0, eventArgs[0] ?? 0, eventArgs[2] ?? 0);
    dispatchGlobalListener(eventName, ...eventArgs);
  };
  window.addEventListener('message', event => {
    const data = event.data;
    if (data?.type === 'msfs-vcockpit-interaction-event') {
      dispatchInteractionEvent(data.name, data.args);
      return;
    }
    if (data?.type === 'msfs-vcockpit-key-event') {
      dispatchKeyEvent(data.name, data.args);
    }
  });
  globalThis.RegisterViewListener ??= (name, callback) => {
    const handle = createListenerHandle('RegisterViewListener:' + String(name ?? ''));
    window.setTimeout(() => callback?.(), 0);
    return handle;
  };
  globalThis.RegisterGenericDataListener ??= callback => {
    incrementBridgeCall('RegisterGenericDataListener');
    const listeners = new Map();
    const handle = {
      onDataReceived: (key, listener) => {
        if (typeof listener === 'function') {
          listeners.set(String(key), listener);
        }
      },
      send: (key, data) => {
        listeners.get(String(key))?.(data);
      },
      close: noop,
      clear: noop
    };
    window.setTimeout(() => callback?.(), 0);
    return handle;
  };
  globalThis.SendKeyEvent ??= (name, ...args) => triggerRuntimeKeyEvent(name, args);
  globalThis.TriggerKeyEvent ??= (name, ...args) => triggerRuntimeKeyEvent(name, args);
  globalThis.LaunchFlowEvent ??= (name, ...args) => triggerRuntimeKeyEvent(name, args);
  globalThis.KeyEventManager ??= {
    triggerKey: (name, ...args) => triggerRuntimeKeyEvent(name, args),
    triggerKeyEvent: (name, ...args) => triggerRuntimeKeyEvent(name, args),
    sendKeyEvent: (name, ...args) => triggerRuntimeKeyEvent(name, args)
  };
  const isSupportedNoopCoherentCall = name => {
    const normalized = String(name ?? '').toUpperCase();
    return normalized === 'INTERCEPT_KEY_EVENT' ||
      normalized === 'START_NEAREST_SEARCH_SESSION' ||
      normalized === 'STOP_NEAREST_SEARCH_SESSION' ||
      normalized === 'SET_NEAREST_AIRPORT_FILTER' ||
      normalized === 'SET_NEAREST_EXTENDED_AIRPORT_FILTERS' ||
      normalized === 'SET_NEAREST_INTERSECTION_FILTER' ||
      normalized === 'SET_NEAREST_NDB_FILTER' ||
      normalized === 'SET_NEAREST_VOR_FILTER';
  };
  globalThis.Coherent ??= {
    call: (name, ...args) => {
      const normalizedCallName = String(name ?? '');
      const registeredWriteMatch = /^setValueReg_(?:Number|Bool|String)$/u.exec(normalizedCallName);
      if (registeredWriteMatch != null) {
        const entry = registeredSimVarById[Number(args[0])];
        if (entry != null) {
          incrementBridgeCall('Coherent.call:' + normalizedCallName);
          return writeTrackedSimVar(entry.name, entry.unit, args[1], entry.source);
        }
      }
      if (/^K:/iu.test(normalizedCallName)) {
        return triggerRuntimeKeyEvent(name, args);
      }
      if (normalizedCallName.toUpperCase() === 'INTERCEPT_KEY_EVENT') {
        const keyName = String(args[0] ?? '').replace(/^K:/i, '').toUpperCase();
        if (keyName) {
          interceptedKeyEvents.add(keyName);
        }
        incrementBridgeCall('Coherent.call:' + normalizedCallName);
        return Promise.resolve(args[0] ?? 0);
      }
      if (normalizedCallName.toUpperCase() === 'TRIGGER_KEY_EVENT') {
        return triggerRuntimeKeyEvent(args[0], [args[2], args[3], args[4]]);
      }
      if (normalizedCallName.toUpperCase() === 'GET_AIR_TRAFFIC') {
        recordSupportedHostServiceCall('Coherent.call:' + normalizedCallName, args);
        return Promise.resolve([]);
      }
      if (normalizedCallName.toUpperCase() === 'SEARCH_NEAREST') {
        recordSupportedHostServiceCall('Coherent.call:' + normalizedCallName, args);
        return Promise.resolve([]);
      }
      if (normalizedCallName.toUpperCase() === 'FSCOMMBUSREGISTER') {
        return Promise.resolve(globalThis.fsCommBusRegister(args[0], args[1]));
      }
      if (normalizedCallName.toUpperCase() === 'FSCOMMBUSUNREGISTER') {
        return Promise.resolve(globalThis.fsCommBusUnregister(args[0], args[1]));
      }
      if (normalizedCallName.toUpperCase() === 'FSCOMMBUSCALL') {
        return Promise.resolve(globalThis.fsCommBusCall(args[0], ...args.slice(1)));
      }
      if (isSupportedNoopCoherentCall(normalizedCallName)) {
        recordSupportedHostServiceCall('Coherent.call:' + normalizedCallName, args);
        return Promise.resolve(args[0] ?? 0);
      }
      recordUnsupportedBridgeCall('Coherent.call:' + normalizedCallName, args);
      return Promise.resolve();
    },
    on: (name, callback) => {
      const handle = createListenerHandle('Coherent.on:' + String(name ?? ''));
      if (typeof callback === 'function') {
        handle.on(name, callback);
      }
      return handle;
    },
    off: (name, callback) => unsubscribeGlobalListener(name, callback),
    trigger: (name, ...args) => dispatchGlobalListener(name, ...args),
    triggerToAllSubscribers: (name, ...args) => dispatchGlobalListener(name, ...args)
  };
  globalThis.GetStoredData ??= key => {
    incrementBridgeCall('GetStoredData');
    return localStorage.getItem(String(key)) ?? '';
  };
  globalThis.SetStoredData ??= (key, value) => {
    incrementBridgeCall('SetStoredData');
    bridgeStats.storageWriteCount += 1;
    localStorage.setItem(String(key), String(value));
  };
  globalThis.DeleteStoredData ??= key => {
    incrementBridgeCall('DeleteStoredData');
    localStorage.removeItem(String(key));
  };
  globalThis.DataStorage ??= {
    get: key => globalThis.GetStoredData(key),
    set: (key, value) => globalThis.SetStoredData(key, value),
    delete: key => globalThis.DeleteStoredData(key),
    searchData: prefix => Object.keys(localStorage).filter(key => key.startsWith(String(prefix ?? '')))
  };
  const toLatLong = (value, fallbackLong = 0) => {
    if (value != null && typeof value === 'object') {
      return {
        lat: Number(value.lat ?? value.latitude ?? 0) || 0,
        long: Number(value.long ?? value.lon ?? value.longitude ?? 0) || 0
      };
    }
    return {
      lat: Number(value) || 0,
      long: Number(fallbackLong) || 0
    };
  };
  const genericUtils = {
    Clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    DEG2RAD: Math.PI / 180,
    RAD2DEG: 180 / Math.PI,
    TWO_PI: Math.PI * 2,
    generateGUID: () =>
      globalThis.crypto?.randomUUID?.() ??
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, marker => {
        const value = Math.floor(Math.random() * 16);
        return (marker === 'x' ? value : (value & 0x3) | 0x8).toString(16);
      }),
    clampAngle: angle => {
      const value = Number(angle) || 0;
      return ((value % 360) + 360) % 360;
    },
    diffAngle: (from, to) => ((((Number(to) - Number(from)) % 360) + 540) % 360) - 180,
    lerpAngle: (from, to, amount) => {
      const delta = ((((to - from) % 360) + 540) % 360) - 180;
      return from + delta * amount;
    },
    computeGreatCircleDistance: (from, to) => {
      const first = toLatLong(from);
      const second = toLatLong(to);
      const dLat = (second.lat - first.lat) * Math.PI / 180;
      const dLon = (second.long - first.long) * Math.PI / 180;
      const lat1 = first.lat * Math.PI / 180;
      const lat2 = second.lat * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    },
    computeGreatCircleHeading: (from, to) => {
      const first = toLatLong(from);
      const second = toLatLong(to);
      const lat1 = first.lat * Math.PI / 180;
      const lat2 = second.lat * Math.PI / 180;
      const dLon = (second.long - first.long) * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      return genericUtils.clampAngle(Math.atan2(y, x) * 180 / Math.PI);
    },
    bearingDistanceToCoordinates: (bearing, distanceNm, lat, long) => {
      const angularDistance = (Number(distanceNm) || 0) / 3440.065;
      const bearingRad = (Number(bearing) || 0) * Math.PI / 180;
      const lat1 = (Number(lat) || 0) * Math.PI / 180;
      const lon1 = (Number(long) || 0) * Math.PI / 180;
      const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angularDistance) +
          Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearingRad)
      );
      const lon2 = lon1 + Math.atan2(
        Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
      );
      return new globalThis.LatLongAlt(
        lat2 * 180 / Math.PI,
        ((((lon2 * 180 / Math.PI) + 180) % 360) + 360) % 360 - 180,
        0
      );
    },
    make_adf_bcd32: frequency => {
      const digits = String(Math.trunc(Math.abs(Number(frequency) || 0))).replace(/\D/gu, '').slice(-8);
      return Array.from(digits).reduce((value, digit) => (value << 4) | Number(digit), 0);
    },
    formatRunway: ident => String(ident ?? '').trim()
  };
  globalThis.Avionics ??= {};
  globalThis.Utils = { ...genericUtils, ...(globalThis.Utils ?? {}) };
  globalThis.Avionics.Utils = { ...genericUtils, ...(globalThis.Avionics.Utils ?? {}) };
  const parseCurveColor = value => {
    const text = String(value ?? '').trim().replace(/^#/u, '');
    const normalized = text.length >= 6 ? text.slice(0, 6) : text.padEnd(6, '0');
    return [
      Number.parseInt(normalized.slice(0, 2), 16) || 0,
      Number.parseInt(normalized.slice(2, 4), 16) || 0,
      Number.parseInt(normalized.slice(4, 6), 16) || 0
    ];
  };
  const formatCurveColor = ([r, g, b]) => '#' + [r, g, b]
    .map(channel => Math.round(genericUtils.Clamp(channel, 0, 255)).toString(16).padStart(2, '0'))
    .join('');
  const numberInterpolation = (start, end, amount) =>
    Number(start) + (Number(end) - Number(start)) * amount;
  const stringColorInterpolation = (start, end, amount) => {
    const left = parseCurveColor(start);
    const right = parseCurveColor(end);
    return formatCurveColor(left.map((channel, index) => channel + (right[index] - channel) * amount));
  };
  globalThis.Avionics.CurveTool ??= {
    NumberInterpolation: numberInterpolation,
    StringColorRGBInterpolation: stringColorInterpolation
  };
  globalThis.Avionics.Curve ??= class Curve {
    constructor() {
      this.points = [];
      this.interpolationFunction = numberInterpolation;
    }
    add(x, y) {
      this.points.push({ x: Number(x) || 0, y });
      this.points.sort((left, right) => left.x - right.x);
    }
    evaluate(x) {
      const value = Number(x) || 0;
      if (this.points.length === 0) {
        return 0;
      }
      if (value <= this.points[0].x) {
        return this.points[0].y;
      }
      const last = this.points[this.points.length - 1];
      if (value >= last.x) {
        return last.y;
      }
      for (let index = 1; index < this.points.length; index += 1) {
        const right = this.points[index];
        if (value > right.x) {
          continue;
        }
        const left = this.points[index - 1];
        const amount = (value - left.x) / Math.max(1e-9, right.x - left.x);
        return this.interpolationFunction(left.y, right.y, amount);
      }
      return last.y;
    }
  };
  globalThis.__msfsGaugeBridgeReady = true;
})();
`
}

function createVCockpitSurfaceTextureRuntime(
  surface: VCockpitSurface,
  htmlGaugeRuntimes: VCockpitHtmlGaugeRuntime[],
  liveCapture: boolean,
  gaugeMode: VCockpitGaugeMode,
  videoFps: number,
  captureFps: number,
  rasterScale: number,
  debugOverlay: boolean,
  diagnostics: ImportDiagnostic[]
): VCockpitSurfaceTextureRuntime {
  const width = scaleVCockpitRasterDimension(surface.pixelSize?.width ?? 1, rasterScale)
  const height = scaleVCockpitRasterDimension(surface.pixelSize?.height ?? 1, rasterScale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const context = canvas.getContext('2d')
  if (context != null) {
    drawVCockpitPlaceholderSurface(
      context,
      surface,
      htmlGaugeRuntimes,
      width,
      height,
      debugOverlay
    )
  }

  const canvasTexture = createVCockpitCanvasTexture(canvas, surface.textureName)
  const videoRuntime =
    gaugeMode === 'video'
      ? createVCockpitVideoTextureRuntime(canvas, surface, videoFps, diagnostics)
      : null
  const texture = videoRuntime?.texture ?? canvasTexture
  return {
    surface,
    canvas,
    context: context ?? canvas.getContext('2d')!,
    texture,
    canvasTexture,
    videoTexture: videoRuntime?.texture ?? null,
    videoElement: videoRuntime?.video ?? null,
    videoStream: videoRuntime?.stream ?? null,
    videoTrack: videoRuntime?.track ?? null,
    videoFps: videoRuntime == null ? null : videoFps,
    captureIntervalMs: 1000 / captureFps,
    rasterScale,
    htmlGaugeRuntimes,
    liveCapture,
    gaugeMode: videoRuntime == null && gaugeMode === 'video' ? 'texture' : gaugeMode,
    overlayObjects: [],
    debugOverlay,
    nextCaptureMs: 0,
    isCapturing: false,
    captureCount: 0,
    lastCaptureDurationMs: 0,
    averageCaptureDurationMs: 0
  }
}

function createVCockpitCanvasTexture(canvas: HTMLCanvasElement, textureName: string): CanvasTexture {
  const texture = new CanvasTexture(canvas)
  texture.name = textureName
  texture.colorSpace = SRGBColorSpace
  texture.flipY = false
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.needsUpdate = true
  return texture
}

function scaleVCockpitRasterDimension(value: number, rasterScale: number): number {
  return Math.max(1, Math.round(value * rasterScale))
}

function scaleVCockpitRasterCoordinate(value: number, rasterScale: number): number {
  return Math.round(value * rasterScale)
}

function createVCockpitCanvasVideoCapture(
  canvas: HTMLCanvasElement,
  fallbackFps: number
): {
  readonly stream: MediaStream
  readonly track: CanvasCaptureMediaStreamTrack | null
} {
  try {
    const manualStream = canvas.captureStream(0)
    const manualTrack = getCanvasCaptureMediaStreamTrack(manualStream)
    if (manualTrack != null) {
      return { stream: manualStream, track: manualTrack }
    }

    manualStream.getTracks().forEach(track => track.stop())
  } catch {
    // Fall back to browser-driven capture if manual frame production is unsupported.
  }

  const stream = canvas.captureStream(fallbackFps)
  return {
    stream,
    track: getCanvasCaptureMediaStreamTrack(stream)
  }
}

function getCanvasCaptureMediaStreamTrack(
  stream: MediaStream
): CanvasCaptureMediaStreamTrack | null {
  const rawTrack = stream.getVideoTracks()[0] as
    | (MediaStreamTrack & { readonly requestFrame?: () => void })
    | undefined
  if (rawTrack == null || typeof rawTrack.requestFrame !== 'function') {
    return null
  }

  return rawTrack as CanvasCaptureMediaStreamTrack
}

function createVCockpitVideoTextureRuntime(
  canvas: HTMLCanvasElement,
  surface: VCockpitSurface,
  videoFps: number,
  diagnostics: ImportDiagnostic[]
): {
  readonly texture: VideoTexture
  readonly video: HTMLVideoElement
  readonly stream: MediaStream
  readonly track: CanvasCaptureMediaStreamTrack | null
} | null {
  try {
    const capture = createVCockpitCanvasVideoCapture(canvas, videoFps)
    const stream = capture.stream
    const track = capture.track
    const video = document.createElement('video')
    video.muted = true
    video.autoplay = true
    video.playsInline = true
    video.srcObject = stream
    video.style.display = 'none'
    document.body.appendChild(video)
    void video.play().catch(error => {
      diagnostics.push({
        code: 'vcockpit-html-video-playback-error',
        severity: 'warning',
        sourcePath: surface.panelPath,
        message: `${surface.sectionName} video-backed gauge texture could not start playback.`,
        details: error instanceof Error ? error.message : String(error)
      })
    })

    const texture = new VideoTexture(video)
    texture.name = surface.textureName
    texture.colorSpace = SRGBColorSpace
    texture.flipY = false
    texture.minFilter = LinearFilter
    texture.magFilter = LinearFilter
    track?.requestFrame()
    return { texture, video, stream, track }
  } catch (error) {
    diagnostics.push({
      code: 'vcockpit-html-video-stream-error',
      severity: 'warning',
      sourcePath: surface.panelPath,
      message: `${surface.sectionName} video-backed gauge texture could not capture its canvas stream.`,
      details: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

function getVCockpitSurfaceBackgroundFillStyle(surface: VCockpitSurface): string {
  return surface.backgroundColor
    ? `rgb(${surface.backgroundColor.r}, ${surface.backgroundColor.g}, ${surface.backgroundColor.b})`
    : '#09131f'
}

function drawVCockpitPlaceholderSurface(
  context: CanvasRenderingContext2D,
  surface: VCockpitSurface,
  htmlGaugeRuntimes: readonly VCockpitHtmlGaugeRuntime[],
  width: number,
  height: number,
  debugOverlay: boolean
): void {
  context.fillStyle = getVCockpitSurfaceBackgroundFillStyle(surface)
  context.fillRect(0, 0, width, height)

  if (!debugOverlay) {
    return
  }

  const accent = createVCockpitSurfaceAccent(surface)
  context.strokeStyle = accent
  context.lineWidth = Math.max(2, Math.round(Math.min(width, height) * 0.012))
  context.strokeRect(
    context.lineWidth * 0.5,
    context.lineWidth * 0.5,
    width - context.lineWidth,
    height - context.lineWidth
  )

  context.fillStyle = accent
  context.globalAlpha = 0.2
  const gridStep = Math.max(32, Math.round(Math.min(width, height) / 8))
  for (let x = 0; x < width; x += gridStep) {
    context.fillRect(x, 0, 1, height)
  }
  for (let y = 0; y < height; y += gridStep) {
    context.fillRect(0, y, width, 1)
  }
  context.globalAlpha = 1

  const fontSize = Math.max(14, Math.min(44, Math.round(Math.min(width, height) * 0.08)))
  context.font = `600 ${fontSize}px system-ui, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillStyle = '#f5fbff'
  context.fillText(surface.textureName, width / 2, height / 2)

  const captionSize = Math.max(10, Math.round(fontSize * 0.42))
  context.font = `500 ${captionSize}px system-ui, sans-serif`
  context.fillStyle = '#a6d7ff'
  context.fillText(
    `${surface.sectionName} ${width}x${height}`,
    width / 2,
    Math.min(height - captionSize * 1.5, height / 2 + fontSize)
  )

  if (debugOverlay) {
    drawVCockpitGaugeStatusOverlay(context, htmlGaugeRuntimes, width, height, captionSize)
  }
}

function drawVCockpitGaugeStatusOverlay(
  context: CanvasRenderingContext2D,
  htmlGaugeRuntimes: readonly VCockpitHtmlGaugeRuntime[],
  width: number,
  height: number,
  captionSize: number
): void {
  if (htmlGaugeRuntimes.length === 0) {
    return
  }

  context.textAlign = 'left'
  context.textBaseline = 'top'
  const rowHeight = Math.max(18, Math.round(captionSize * 1.45))
  const panelWidth = Math.min(width - 24, Math.max(width * 0.45, 260))
  const preferredPanelHeight = rowHeight * (htmlGaugeRuntimes.length + 1) + 12
  const panelHeight = Math.min(
    Math.max(1, height - 24),
    preferredPanelHeight
  )
  const panelX = 12
  const panelY = 12
  context.fillStyle = 'rgba(0, 0, 0, 0.54)'
  context.fillRect(panelX, panelY, panelWidth, panelHeight)
  context.font = `600 ${captionSize}px system-ui, sans-serif`
  context.fillStyle = '#f5fbff'
  context.fillText('HTML gauges', panelX + 8, panelY + 6)
  context.font = `500 ${Math.max(9, Math.round(captionSize * 0.82))}px system-ui, sans-serif`
  htmlGaugeRuntimes.forEach((runtime, index) => {
    const rowY = panelY + rowHeight * (index + 1) + 6
    context.fillStyle = getVCockpitGaugeStatusColor(runtime.status)
    context.fillRect(panelX + 8, rowY + 4, 8, 8)
    context.fillStyle = '#d8ecff'
    context.fillText(
      `${runtime.gaugeKey}: ${runtime.status}${runtime.captured ? ' captured' : ''} ${runtime.source}`,
      panelX + 22,
      rowY
    )
  })
}

function getVCockpitGaugeStatusColor(status: VCockpitHtmlGaugeRuntime['status']): string {
  switch (status) {
    case 'loaded':
    case 'loaded-wasm-bridge':
      return '#6ee7a8'
    case 'deferred-native-wasm':
      return '#f6c85f'
    case 'missing':
    case 'iframe-error':
    case 'unsupported-native-abi':
      return '#ff7a7a'
  }
}

function updateVCockpitSurfaceTextureRuntimes(
  surfaceTextureRuntimes: readonly VCockpitSurfaceTextureRuntime[],
  diagnostics: ImportDiagnostic[],
  nowMs: number
): void {
  if (activeVCockpitSurfaceTextureCaptures >= VCOCKPIT_SURFACE_CAPTURE_CONCURRENCY) {
    return
  }

  for (const surfaceRuntime of surfaceTextureRuntimes) {
    if (
      surfaceRuntime.gaugeMode === 'overlay' ||
      surfaceRuntime.isCapturing ||
      nowMs < surfaceRuntime.nextCaptureMs
    ) {
      continue
    }

    const captureCandidates = getVCockpitSurfaceCaptureCandidates(surfaceRuntime)
    if (captureCandidates.length === 0) {
      continue
    }

    surfaceRuntime.isCapturing = true
    activeVCockpitSurfaceTextureCaptures += 1
    const captureStartMs = performance.now()
    void captureVCockpitSurfaceTexture(surfaceRuntime, diagnostics, captureCandidates)
      .catch(error => {
        diagnostics.push({
          code: 'vcockpit-html-capture-error',
          severity: 'warning',
          sourcePath: surfaceRuntime.surface.panelPath,
          message: `${surfaceRuntime.surface.sectionName} HTML gauge capture failed.`,
          details: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => {
        const captureEndMs = performance.now()
        const captureDurationMs = Math.max(0, captureEndMs - captureStartMs)
        surfaceRuntime.captureCount += 1
        surfaceRuntime.lastCaptureDurationMs = captureDurationMs
        surfaceRuntime.averageCaptureDurationMs =
          surfaceRuntime.averageCaptureDurationMs <= 0
            ? captureDurationMs
            : surfaceRuntime.averageCaptureDurationMs * 0.85 + captureDurationMs * 0.15
        surfaceRuntime.nextCaptureMs =
          captureEndMs + getVCockpitSurfaceCaptureIntervalMs(surfaceRuntime)
        activeVCockpitSurfaceTextureCaptures = Math.max(
          0,
          activeVCockpitSurfaceTextureCaptures - 1
        )
        surfaceRuntime.isCapturing = false
      })
    return
  }
}

function getVCockpitSurfaceCaptureIntervalMs(
  surfaceRuntime: VCockpitSurfaceTextureRuntime
): number {
  const cpuBudgetedIntervalMs =
    surfaceRuntime.averageCaptureDurationMs > 0
      ? surfaceRuntime.averageCaptureDurationMs * 4
      : 0
  return Math.min(
    2_000,
    Math.max(surfaceRuntime.captureIntervalMs, cpuBudgetedIntervalMs)
  )
}

function updateVCockpitHtmlGaugeOverlayRuntimes(
  surfaceTextureRuntimes: readonly VCockpitSurfaceTextureRuntime[],
  camera: PerspectiveCamera,
  viewportElement: HTMLElement
): void {
  for (const surfaceRuntime of surfaceTextureRuntimes) {
    if (surfaceRuntime.gaugeMode !== 'overlay') {
      continue
    }

    const surfaceRect = projectObjectsToViewportRect(
      surfaceRuntime.overlayObjects,
      camera,
      viewportElement
    )
    if (surfaceRect == null) {
      hideVCockpitOverlayGaugeFrames(surfaceRuntime.htmlGaugeRuntimes)
      continue
    }

    const surfaceWidth = Math.max(1, surfaceRuntime.canvas.width)
    const surfaceHeight = Math.max(1, surfaceRuntime.canvas.height)
    for (const gaugeRuntime of surfaceRuntime.htmlGaugeRuntimes) {
      const iframe = gaugeRuntime.iframe
      const gauge = gaugeRuntime.gauge
      if (!isLoadedVCockpitHtmlGaugeStatus(gaugeRuntime.status) || iframe == null || gauge == null) {
        if (iframe != null) {
          iframe.style.visibility = 'hidden'
        }
        continue
      }

      const gaugeX = Math.round(gauge.x ?? 0)
      const gaugeY = Math.round(gauge.y ?? 0)
      const gaugeWidth = Math.max(1, Math.round(gauge.width ?? surfaceWidth))
      const gaugeHeight = Math.max(1, Math.round(gauge.height ?? surfaceHeight))
      iframe.style.left = `${surfaceRect.left + (gaugeX / surfaceWidth) * surfaceRect.width}px`
      iframe.style.top = `${surfaceRect.top + (gaugeY / surfaceHeight) * surfaceRect.height}px`
      iframe.style.width = `${(gaugeWidth / surfaceWidth) * surfaceRect.width}px`
      iframe.style.height = `${(gaugeHeight / surfaceHeight) * surfaceRect.height}px`
      iframe.style.visibility = 'visible'
    }
  }
}

function hideVCockpitOverlayGaugeFrames(
  htmlGaugeRuntimes: readonly VCockpitHtmlGaugeRuntime[]
): void {
  for (const gaugeRuntime of htmlGaugeRuntimes) {
    if (gaugeRuntime.iframe != null) {
      gaugeRuntime.iframe.style.visibility = 'hidden'
    }
  }
}

function projectObjectsToViewportRect(
  objects: readonly Object3D[],
  camera: PerspectiveCamera,
  viewportElement: HTMLElement
): {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
} | null {
  if (objects.length === 0) {
    return null
  }

  const bounds = new Box3()
  for (const object of objects) {
    bounds.expandByObject(object)
  }

  if (bounds.isEmpty()) {
    return null
  }

  const viewportRect = viewportElement.getBoundingClientRect()
  const corners = [
    new Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
    new Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
    new Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
    new Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
    new Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
    new Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
    new Vector3(bounds.max.x, bounds.max.y, bounds.max.z)
  ]

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let visibleCornerCount = 0

  for (const corner of corners) {
    const projected = corner.project(camera)
    if (
      !Number.isFinite(projected.x) ||
      !Number.isFinite(projected.y) ||
      !Number.isFinite(projected.z)
    ) {
      return null
    }

    if (projected.z >= -1 && projected.z <= 1) {
      visibleCornerCount += 1
    }

    const x = viewportRect.left + ((projected.x + 1) * 0.5) * viewportRect.width
    const y = viewportRect.top + ((1 - projected.y) * 0.5) * viewportRect.height
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  const width = maxX - minX
  const height = maxY - minY
  if (
    visibleCornerCount === 0 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 2 ||
    height < 2
  ) {
    return null
  }

  return {
    left: minX,
    top: minY,
    width,
    height
  }
}

function getVCockpitSurfaceCaptureCandidates(
  surfaceRuntime: VCockpitSurfaceTextureRuntime
): readonly VCockpitHtmlGaugeRuntime[] {
  const loadedRuntimes = surfaceRuntime.htmlGaugeRuntimes.filter(
    isRenderableVCockpitHtmlGaugeRuntime
  )

  if (surfaceRuntime.liveCapture) {
    if (surfaceRuntime.debugOverlay) {
      return loadedRuntimes
    }

    const dirtyRuntimes = loadedRuntimes.filter(
      runtime => !runtime.captured || runtime.needsCapture
    )
    return expandVCockpitCaptureCandidatesForOverlap(
      surfaceRuntime,
      loadedRuntimes,
      dirtyRuntimes
    )
  }

  return loadedRuntimes.some(
    runtime =>
      !runtime.captured &&
      runtime.captureAttemptCount < VCOCKPIT_HTML_MAX_CAPTURE_ATTEMPTS
  )
    ? loadedRuntimes
    : []
}

function isRenderableVCockpitHtmlGaugeRuntime(
  runtime: VCockpitHtmlGaugeRuntime
): boolean {
  return (
    isLoadedVCockpitHtmlGaugeStatus(runtime.status) &&
    runtime.iframe != null &&
    runtime.gauge != null
  )
}

function expandVCockpitCaptureCandidatesForOverlap(
  surfaceRuntime: VCockpitSurfaceTextureRuntime,
  loadedRuntimes: readonly VCockpitHtmlGaugeRuntime[],
  captureRuntimes: readonly VCockpitHtmlGaugeRuntime[]
): readonly VCockpitHtmlGaugeRuntime[] {
  if (captureRuntimes.length === 0 || captureRuntimes.length === loadedRuntimes.length) {
    return captureRuntimes
  }

  const selectedRuntimes = new Set(captureRuntimes)
  let addedOverlap = true
  while (addedOverlap) {
    addedOverlap = false
    const selectedRects = [...selectedRuntimes].map(runtime =>
      getVCockpitGaugePanelRect(surfaceRuntime, runtime)
    )
    for (const runtime of loadedRuntimes) {
      if (selectedRuntimes.has(runtime)) {
        continue
      }

      const rect = getVCockpitGaugePanelRect(surfaceRuntime, runtime)
      if (selectedRects.some(selectedRect => doPanelRectsOverlap(rect, selectedRect))) {
        selectedRuntimes.add(runtime)
        addedOverlap = true
      }
    }
  }

  return loadedRuntimes.filter(runtime => selectedRuntimes.has(runtime))
}

function getVCockpitGaugePanelRect(
  surfaceRuntime: VCockpitSurfaceTextureRuntime,
  runtime: VCockpitHtmlGaugeRuntime
): {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
} {
  const gauge = runtime.gauge
  const fallbackWidth =
    surfaceRuntime.surface.pixelSize?.width ??
    surfaceRuntime.canvas.width / surfaceRuntime.rasterScale
  const fallbackHeight =
    surfaceRuntime.surface.pixelSize?.height ??
    surfaceRuntime.canvas.height / surfaceRuntime.rasterScale
  const left = gauge?.x ?? 0
  const top = gauge?.y ?? 0
  const width = Math.max(1, gauge?.width ?? fallbackWidth)
  const height = Math.max(1, gauge?.height ?? fallbackHeight)
  return {
    left,
    top,
    right: left + width,
    bottom: top + height
  }
}

function doPanelRectsOverlap(
  left: {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
  },
  right: {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
  }
): boolean {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  )
}

async function captureVCockpitSurfaceTexture(
  surfaceRuntime: VCockpitSurfaceTextureRuntime,
  diagnostics: ImportDiagnostic[],
  htmlGaugeRuntimes: readonly VCockpitHtmlGaugeRuntime[]
): Promise<void> {
  let surfaceDirty = false
  const surfaceWasCleared = !surfaceRuntime.liveCapture || surfaceRuntime.debugOverlay
  if (surfaceWasCleared) {
    drawVCockpitPlaceholderSurface(
      surfaceRuntime.context,
      surfaceRuntime.surface,
      surfaceRuntime.htmlGaugeRuntimes,
      surfaceRuntime.canvas.width,
      surfaceRuntime.canvas.height,
      surfaceRuntime.debugOverlay
    )
    surfaceDirty = true
  }

  for (const gaugeRuntime of htmlGaugeRuntimes) {
    const gauge = gaugeRuntime.gauge
    const x = scaleVCockpitRasterCoordinate(gauge?.x ?? 0, surfaceRuntime.rasterScale)
    const y = scaleVCockpitRasterCoordinate(gauge?.y ?? 0, surfaceRuntime.rasterScale)
    const width = scaleVCockpitRasterDimension(
      gauge?.width ?? surfaceRuntime.surface.pixelSize?.width ?? surfaceRuntime.canvas.width,
      surfaceRuntime.rasterScale
    )
    const height = scaleVCockpitRasterDimension(
      gauge?.height ?? surfaceRuntime.surface.pixelSize?.height ?? surfaceRuntime.canvas.height,
      surfaceRuntime.rasterScale
    )

    if (
      !surfaceRuntime.liveCapture &&
      gaugeRuntime.captured &&
      gaugeRuntime.captureImage != null
    ) {
      surfaceRuntime.context.drawImage(gaugeRuntime.captureImage, x, y, width, height)
      continue
    }

    if (
      !isLoadedVCockpitHtmlGaugeStatus(gaugeRuntime.status) ||
      gaugeRuntime.iframe == null ||
      gauge == null ||
      (
        !surfaceRuntime.liveCapture &&
        !gaugeRuntime.captured &&
        gaugeRuntime.captureAttemptCount >= VCOCKPIT_HTML_MAX_CAPTURE_ATTEMPTS
      )
    ) {
      continue
    }

    let attemptedChangeVersion: number | null = null
    try {
      if (surfaceRuntime.liveCapture || !gaugeRuntime.captured) {
        gaugeRuntime.captureAttemptCount += 1
      }
      if (surfaceRuntime.liveCapture) {
        const changeVersion =
          gaugeRuntime.pendingChangeVersion ?? getHtmlGaugeChangeVersion(gaugeRuntime)
        attemptedChangeVersion = changeVersion
        const forceCompositeRedraw =
          !surfaceWasCleared && gaugeRuntime.captured && !gaugeRuntime.needsCapture
        let visualSignature = forceCompositeRedraw ? gaugeRuntime.lastVisualSignature : null

        if (!surfaceWasCleared && !forceCompositeRedraw) {
          if (
            changeVersion != null &&
            gaugeRuntime.captured &&
            changeVersion === gaugeRuntime.lastChangeVersion
          ) {
            gaugeRuntime.pendingChangeVersion = null
            gaugeRuntime.pendingDirtyKind = null
            gaugeRuntime.needsCapture = false
            gaugeRuntime.lastRenderStatus = 'skipped-clean'
            continue
          }
          assertHtmlGaugeHasRenderableContent(gaugeRuntime)
          visualSignature =
            changeVersion == null ? getHtmlGaugeStableVisualSignature(gaugeRuntime) : null
          if (
            visualSignature != null &&
            gaugeRuntime.captured &&
            visualSignature === gaugeRuntime.lastVisualSignature
          ) {
            gaugeRuntime.pendingChangeVersion = null
            gaugeRuntime.pendingDirtyKind = null
            gaugeRuntime.needsCapture = false
            gaugeRuntime.lastRenderStatus = 'skipped-clean'
            continue
          }
        } else {
          assertHtmlGaugeHasRenderableContent(gaugeRuntime)
        }

        const renderKind =
          gaugeRuntime.pendingDirtyKind ?? (gaugeRuntime.captured ? 'unknown' : 'dom')
        if (!surfaceWasCleared && gaugeRuntime.needsCapture) {
          surfaceRuntime.context.fillStyle = getVCockpitSurfaceBackgroundFillStyle(
            surfaceRuntime.surface
          )
          surfaceRuntime.context.fillRect(x, y, width, height)
          surfaceDirty = true
        }

        await drawHtmlGaugeLiveFrameToContext(
          gaugeRuntime,
          surfaceRuntime.context,
          x,
          y,
          width,
          height,
          renderKind
        )
        gaugeRuntime.lastChangeVersion = changeVersion
        gaugeRuntime.pendingChangeVersion = null
        gaugeRuntime.pendingDirtyKind = null
        gaugeRuntime.needsCapture = false
        gaugeRuntime.lastVisualSignature = visualSignature
        gaugeRuntime.lastRenderKind = renderKind
        surfaceDirty = true
      } else {
        assertHtmlGaugeHasRenderableContent(gaugeRuntime)
        const image = await captureHtmlGaugeFrameImage(gaugeRuntime, width, height)
        surfaceRuntime.context.drawImage(image, x, y, width, height)
        gaugeRuntime.captureImage = image
        gaugeRuntime.lastRenderKind = 'static'
        surfaceDirty = true
      }
      gaugeRuntime.captured = true
      gaugeRuntime.lastRenderStatus = 'captured'
      if (surfaceRuntime.liveCapture) {
        gaugeRuntime.captureImage = null
      }
      gaugeRuntime.lastCaptureError = null
      if (!surfaceRuntime.liveCapture) {
        releaseVCockpitHtmlGaugeFrame(gaugeRuntime)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        surfaceRuntime.liveCapture &&
        isBlankVCockpitHtmlGaugeCaptureError(message)
      ) {
        if (!surfaceWasCleared) {
          surfaceRuntime.context.fillStyle = getVCockpitSurfaceBackgroundFillStyle(
            surfaceRuntime.surface
          )
          surfaceRuntime.context.fillRect(x, y, width, height)
          surfaceDirty = true
        }
        gaugeRuntime.lastCaptureError = message
        gaugeRuntime.lastVisualSignature = null
        gaugeRuntime.lastChangeVersion = attemptedChangeVersion
        gaugeRuntime.pendingChangeVersion = null
        gaugeRuntime.pendingDirtyKind = null
        gaugeRuntime.needsCapture = false
        gaugeRuntime.captured = true
        gaugeRuntime.lastRenderStatus = 'blank'
        gaugeRuntime.lastRenderKind = null
        continue
      }
      if (gaugeRuntime.lastCaptureError !== message) {
        diagnostics.push({
          code: 'vcockpit-html-gauge-capture-error',
          severity: 'warning',
          sourcePath: surfaceRuntime.surface.panelPath,
          message: `${surfaceRuntime.surface.sectionName} ${gaugeRuntime.gaugeKey} could not be captured into a texture.`,
          details: message
        })
      }
      gaugeRuntime.lastCaptureError = message
      gaugeRuntime.lastVisualSignature = null
      gaugeRuntime.lastChangeVersion = null
      gaugeRuntime.pendingChangeVersion = null
      gaugeRuntime.pendingDirtyKind = null
      gaugeRuntime.needsCapture = !surfaceRuntime.liveCapture
      gaugeRuntime.captured = false
      gaugeRuntime.lastRenderStatus = 'error'
      gaugeRuntime.lastRenderKind = null
      if (
        !surfaceRuntime.liveCapture &&
        gaugeRuntime.captureAttemptCount >= VCOCKPIT_HTML_MAX_CAPTURE_ATTEMPTS
      ) {
        releaseVCockpitHtmlGaugeFrame(gaugeRuntime)
      }
    }
  }

  if (surfaceRuntime.debugOverlay) {
    const captionSize = Math.max(
      10,
      Math.min(
        18,
        Math.round(Math.min(surfaceRuntime.canvas.width, surfaceRuntime.canvas.height) * 0.035)
      )
    )
    drawVCockpitGaugeStatusOverlay(
      surfaceRuntime.context,
      surfaceRuntime.htmlGaugeRuntimes,
      surfaceRuntime.canvas.width,
      surfaceRuntime.canvas.height,
      captionSize
    )
    surfaceDirty = true
  }
  if (surfaceDirty) {
    markVCockpitSurfaceTextureRuntimeUpdated(surfaceRuntime)
  }
}

function markVCockpitSurfaceTextureRuntimeUpdated(
  surfaceRuntime: VCockpitSurfaceTextureRuntime
): void {
  if (surfaceRuntime.gaugeMode === 'video') {
    surfaceRuntime.videoTrack?.requestFrame()
    return
  }

  surfaceRuntime.canvasTexture.needsUpdate = true
}

function disposeVCockpitSurfaceTextureRuntime(
  surfaceRuntime: VCockpitSurfaceTextureRuntime
): void {
  surfaceRuntime.videoStream?.getTracks().forEach(track => track.stop())
  surfaceRuntime.videoElement?.pause()
  if (surfaceRuntime.videoElement != null) {
    surfaceRuntime.videoElement.srcObject = null
  }
  surfaceRuntime.videoElement?.remove()
  surfaceRuntime.videoTexture?.dispose()
  surfaceRuntime.canvasTexture.dispose()
}

function releaseVCockpitHtmlGaugeFrame(gaugeRuntime: VCockpitHtmlGaugeRuntime): void {
  gaugeRuntime.iframe?.remove()
  gaugeRuntime.iframe = null
  if (gaugeRuntime.sourceObjectUrl != null) {
    URL.revokeObjectURL(gaugeRuntime.sourceObjectUrl)
    gaugeRuntime.sourceObjectUrl = null
  }
  gaugeRuntime.staticCaptureImage = null
  gaugeRuntime.staticCaptureSignature = null
}

function setVCockpitHtmlGaugeRuntimeActive(
  gaugeRuntime: VCockpitHtmlGaugeRuntime,
  active: boolean
): void {
  postVCockpitGaugeRuntimeMessage(gaugeRuntime, {
    type: 'msfs-vcockpit-gauge-active',
    active
  })
}

function postVCockpitGaugeRuntimeMessage(
  gaugeRuntime: VCockpitHtmlGaugeRuntime,
  message: unknown
): void {
  const frameWindow = gaugeRuntime.iframe?.contentWindow
  if (frameWindow == null) {
    return
  }
  postWindowMessage(frameWindow, message)
}

function postWindowMessage(targetWindow: Window, message: unknown): void {
  targetWindow.postMessage(message, '*')
}

function getVCockpitHtmlGaugeRuntimeStats(
  gaugeRuntime: VCockpitHtmlGaugeRuntime
): Record<string, unknown> {
  const frameDocument = gaugeRuntime.iframe?.contentDocument
  const frameWindow = gaugeRuntime.iframe?.contentWindow as
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
  const wasmModuleUrl = getSyntheticWasmModuleUrlFromRuntime(gaugeRuntime)
  return {
    key: gaugeRuntime.gaugeKey,
    source: gaugeRuntime.source,
    status: gaugeRuntime.status,
    captured: gaugeRuntime.captured,
    needsCapture: gaugeRuntime.needsCapture,
    pendingDirtyKind: gaugeRuntime.pendingDirtyKind,
    lastRenderStatus: gaugeRuntime.lastRenderStatus,
    lastRenderKind: gaugeRuntime.lastRenderKind,
    lastCaptureError: gaugeRuntime.lastCaptureError,
    hasStaticCaptureImage: gaugeRuntime.staticCaptureImage != null,
    captureAttemptCount: gaugeRuntime.captureAttemptCount,
    changeVersion: getHtmlGaugeChangeVersion(gaugeRuntime),
    domNodeCount: frameDocument?.getElementsByTagName('*').length ?? null,
    canvasCount: frameDocument?.querySelectorAll('canvas').length ?? null,
    svgCount: frameDocument?.querySelectorAll('svg').length ?? null,
    dirtyStats: frameWindow?.__msfsGaugeDirtyStats ?? null,
    instrumentStats: frameWindow?.__msfsInstrumentRuntimeStats ?? null,
    bridgeStats: wasmModuleUrl == null
      ? bridgeStats
      : {
          ...(typeof bridgeStats === 'object' ? bridgeStats : {}),
          wasmModuleInfo: {
            url: wasmModuleUrl,
            status: 'resolved-url-only',
            byteLength: 0,
            imports: [],
            exports: [],
            error: null
          }
        },
    scriptErrors: frameWindow?.__msfsGaugeErrors ?? null,
    assetErrors: frameWindow?.__msfsGaugeAssetErrors ?? null,
    resourceErrors: frameWindow?.__msfsGaugeResourceErrors ?? null
  }
}

function getSyntheticWasmModuleUrlFromRuntime(
  gaugeRuntime: VCockpitHtmlGaugeRuntime
): string | null {
  if (gaugeRuntime.status !== 'loaded-wasm-bridge') {
    return null
  }
  if (gaugeRuntime.wasmModuleUrl != null) {
    return gaugeRuntime.wasmModuleUrl
  }
  if (gaugeRuntime.resolvedUrl == null) {
    return null
  }
  try {
    return new URL(gaugeRuntime.resolvedUrl).searchParams.get('wasmModuleUrl')
  } catch {
    return null
  }
}

function assertHtmlGaugeHasRenderableContent(
  gaugeRuntime: VCockpitHtmlGaugeRuntime
): void {
  const frameDocument = gaugeRuntime.iframe?.contentDocument
  if (frameDocument == null) {
    throw new Error('iframe document is not accessible')
  }

  const instrumentElement = frameDocument.querySelector('[data-msfs-instrument]')
  const bodyText = frameDocument.body?.innerText?.trim() ?? ''
  const placeholderText = "If you're seeing this, instrument didn't load."
  const hasOnlyPlaceholderText =
    bodyText !== '' && bodyText.replaceAll(placeholderText, '').trim() === ''
  const hasMountedInstrument =
    instrumentElement != null &&
    instrumentElement.childElementCount > 0 &&
    !hasOnlyPlaceholderText
  const hasNonPlaceholderText =
    bodyText !== '' && !hasOnlyPlaceholderText

  if (!hasMountedInstrument && !hasNonPlaceholderText) {
    throw new Error('gauge iframe loaded but did not mount visible instrument DOM')
  }
}

function isBlankVCockpitHtmlGaugeCaptureError(message: string): boolean {
  return message === 'gauge iframe loaded but did not mount visible instrument DOM'
}

async function captureHtmlGaugeFrameImage(
  gaugeRuntime: VCockpitHtmlGaugeRuntime,
  width: number,
  height: number
): Promise<HTMLCanvasElement> {
  const frameDocument = getHtmlGaugeFrameDocument(gaugeRuntime)

  return renderHtmlGaugeToCleanCanvas(frameDocument, width, height)
}

async function drawHtmlGaugeFrameToContext(
  gaugeRuntime: VCockpitHtmlGaugeRuntime,
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<void> {
  const frameDocument = getHtmlGaugeFrameDocument(gaugeRuntime)

  await drawHtmlGaugeDocumentToContext(context, frameDocument, x, y, width, height)
}

async function drawHtmlGaugeLiveFrameToContext(
  gaugeRuntime: VCockpitHtmlGaugeRuntime,
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  dirtyKind: VCockpitGaugeDirtyKind
): Promise<void> {
  const staticImage = await getHtmlGaugeStaticCaptureImage(
    gaugeRuntime,
    width,
    height,
    dirtyKind === 'dom'
  )
  context.drawImage(staticImage, x, y, width, height)

  const frameDocument = getHtmlGaugeFrameDocument(gaugeRuntime)
  const root = frameDocument.querySelector<HTMLElement>('[data-msfs-instrument]') ??
    frameDocument.body
  if (root == null) {
    return
  }

  context.save()
  context.translate(x, y)
  try {
    applyHtmlGaugeCaptureScale(context, frameDocument, width, height)
    await drawGaugeCanvases(context, root)
  } finally {
    context.restore()
  }
}

async function getHtmlGaugeStaticCaptureImage(
  gaugeRuntime: VCockpitHtmlGaugeRuntime,
  width: number,
  height: number,
  forceRefresh: boolean
): Promise<HTMLCanvasElement> {
  if (!forceRefresh && gaugeRuntime.staticCaptureImage != null) {
    return gaugeRuntime.staticCaptureImage
  }

  const frameDocument = getHtmlGaugeFrameDocument(gaugeRuntime)
  const signature = getHtmlGaugeStaticCaptureSignature(frameDocument, width, height)
  if (
    !forceRefresh &&
    gaugeRuntime.staticCaptureImage != null &&
    gaugeRuntime.staticCaptureSignature === signature
  ) {
    return gaugeRuntime.staticCaptureImage
  }

  const canvas = gaugeRuntime.staticCaptureImage ?? document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context == null) {
    throw new Error('could not create static HTML gauge capture canvas')
  }

  await drawHtmlGaugeStaticDocumentToContext(context, frameDocument, 0, 0, width, height)
  gaugeRuntime.staticCaptureImage = canvas
  gaugeRuntime.staticCaptureSignature = signature
  return canvas
}

function getHtmlGaugeStaticCaptureSignature(
  frameDocument: Document,
  width: number,
  height: number
): string {
  const root = frameDocument.querySelector<HTMLElement>('[data-msfs-instrument]') ??
    frameDocument.body
  return [
    `${width}x${height}`,
    resolveGaugeBackground(frameDocument),
    getSanitizedAccessibleCssText(frameDocument),
    root == null ? '' : getHtmlGaugeStaticDomSignature(root)
  ].join('\n/* vcockpit-static-signature */\n')
}

function getHtmlGaugeStaticDomSignature(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('canvas, video, iframe, object, embed').forEach(element => {
    element.replaceWith(root.ownerDocument.createElement(element.tagName.toLowerCase()))
  })
  return clone.outerHTML
}

function getHtmlGaugeFrameDocument(gaugeRuntime: VCockpitHtmlGaugeRuntime): Document {
  const iframe = gaugeRuntime.iframe
  const frameDocument = iframe?.contentDocument
  if (iframe == null || frameDocument == null) {
    throw new Error('iframe document is not accessible')
  }

  return frameDocument
}

function getHtmlGaugeChangeVersion(gaugeRuntime: VCockpitHtmlGaugeRuntime): number | null {
  const frameWindow = gaugeRuntime.iframe?.contentWindow as
    | (Window & { readonly __msfsGaugeChangeVersion?: unknown })
    | null
    | undefined
  const version = frameWindow?.__msfsGaugeChangeVersion
  return typeof version === 'number' && Number.isFinite(version) ? version : null
}

function getHtmlGaugeStableVisualSignature(
  gaugeRuntime: VCockpitHtmlGaugeRuntime
): string | null {
  const frameDocument = getHtmlGaugeFrameDocument(gaugeRuntime)
  const root = frameDocument.querySelector<HTMLElement>('[data-msfs-instrument]') ??
    frameDocument.body
  if (
    root == null ||
    hasPotentiallySelfAnimatingGaugeContent(root)
  ) {
    return null
  }

  return [
    resolveGaugeBackground(frameDocument),
    getSanitizedAccessibleCssText(frameDocument),
    root.outerHTML
  ].join('\n/* vcockpit-signature */\n')
}

function hasPotentiallySelfAnimatingGaugeContent(root: HTMLElement): boolean {
  const elements = [root, ...root.querySelectorAll<HTMLElement>('*')]
  for (const element of elements) {
    if (
      element.shadowRoot != null ||
      element.matches('canvas, video, iframe, object, embed') ||
      isAnimatedImageElement(element) ||
      hasActiveCssAnimationOrTransition(element)
    ) {
      return true
    }
  }

  return false
}

function isAnimatedImageElement(element: HTMLElement): boolean {
  if (!(element instanceof HTMLImageElement)) {
    return false
  }

  const source = (element.currentSrc || element.src || '').trim().toLowerCase()
  return source.includes('.gif') || source.startsWith('data:image/gif')
}

function hasActiveCssAnimationOrTransition(element: HTMLElement): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  if (style == null) {
    return false
  }

  return (
    style.animationName !== 'none' ||
    hasNonZeroCssTimeList(style.transitionDuration)
  )
}

function hasNonZeroCssTimeList(value: string): boolean {
  return value
    .split(',')
    .map(part => part.trim())
    .some(part => {
      if (part.endsWith('ms')) {
        return Number.parseFloat(part) > 0
      }

      if (part.endsWith('s')) {
        return Number.parseFloat(part) > 0
      }

      return false
    })
}

function getSanitizedAccessibleCssText(frameDocument: Document): string {
  const styleSheetCount = frameDocument.styleSheets.length
  const cached = accessibleGaugeCssTextByDocument.get(frameDocument)
  if (cached != null && cached.styleSheetCount === styleSheetCount) {
    return cached.cssText
  }

  const cssBlocks: string[] = []
  for (const styleSheet of [...frameDocument.styleSheets]) {
    try {
      cssBlocks.push(
        [...styleSheet.cssRules].map(rule => rule.cssText).join('\n')
      )
    } catch {
      // Cross-origin or blocked stylesheets cannot be inlined into the SVG capture.
    }
  }

  const cssText = sanitizeGaugeSvgCssText(cssBlocks.join('\n'))
  accessibleGaugeCssTextByDocument.set(frameDocument, { styleSheetCount, cssText })
  return cssText
}

async function renderHtmlGaugeToCleanCanvas(
  frameDocument: Document,
  width: number,
  height: number
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context == null) {
    throw new Error('could not create HTML gauge capture canvas')
  }

  await drawHtmlGaugeDocumentToContext(context, frameDocument, 0, 0, width, height)

  assertCanvasIsOriginClean(canvas)
  return canvas
}

async function drawHtmlGaugeDocumentToContext(
  context: CanvasRenderingContext2D,
  frameDocument: Document,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<void> {
  context.fillStyle = resolveGaugeBackground(frameDocument)
  context.fillRect(x, y, width, height)

  const root = frameDocument.querySelector<HTMLElement>('[data-msfs-instrument]') ??
    frameDocument.body
  if (root == null) {
    return
  }

  context.save()
  context.translate(x, y)
  try {
    applyHtmlGaugeCaptureScale(context, frameDocument, width, height)
    await drawGaugeCanvases(context, root)
    await drawGaugeSvgs(context, frameDocument, root)
    drawGaugeText(context, root)
  } finally {
    context.restore()
  }
}

async function drawHtmlGaugeStaticDocumentToContext(
  context: CanvasRenderingContext2D,
  frameDocument: Document,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<void> {
  context.fillStyle = resolveGaugeBackground(frameDocument)
  context.fillRect(x, y, width, height)

  const root = frameDocument.querySelector<HTMLElement>('[data-msfs-instrument]') ??
    frameDocument.body
  if (root == null) {
    return
  }

  context.save()
  context.translate(x, y)
  try {
    applyHtmlGaugeCaptureScale(context, frameDocument, width, height)
    await drawGaugeSvgs(context, frameDocument, root)
    drawGaugeText(context, root)
  } finally {
    context.restore()
  }
}

function applyHtmlGaugeCaptureScale(
  context: CanvasRenderingContext2D,
  frameDocument: Document,
  outputWidth: number,
  outputHeight: number
): void {
  const viewportSize = getHtmlGaugeViewportSize(frameDocument)
  context.scale(
    outputWidth / viewportSize.width,
    outputHeight / viewportSize.height
  )
}

function getHtmlGaugeViewportSize(frameDocument: Document): { readonly width: number; readonly height: number } {
  const view = frameDocument.defaultView
  const documentElement = frameDocument.documentElement
  const body = frameDocument.body
  return {
    width: Math.max(1, view?.innerWidth ?? documentElement?.clientWidth ?? body?.clientWidth ?? 1),
    height: Math.max(1, view?.innerHeight ?? documentElement?.clientHeight ?? body?.clientHeight ?? 1)
  }
}

function resolveGaugeBackground(frameDocument: Document): string {
  const bodyBackground = frameDocument.defaultView == null || frameDocument.body == null
    ? ''
    : frameDocument.defaultView.getComputedStyle(frameDocument.body).backgroundColor
  return bodyBackground !== '' && bodyBackground !== 'rgba(0, 0, 0, 0)'
    ? bodyBackground
    : '#000'
}

async function drawGaugeCanvases(
  context: CanvasRenderingContext2D,
  root: Element
): Promise<void> {
  for (const canvas of [...root.querySelectorAll('canvas')]) {
    const rect = canvas.getBoundingClientRect()
    if (!isRenderableRect(rect)) {
      continue
    }

    if (!isCanvasOriginClean(canvas)) {
      continue
    }

    try {
      context.drawImage(canvas, rect.left, rect.top, rect.width, rect.height)
    } catch {
      // Some gauges may use internally-tainted map canvases; skip those rather than
      // tainting the VCockpit texture uploaded to the renderer.
    }
  }
}

async function drawGaugeSvgs(
  context: CanvasRenderingContext2D,
  frameDocument: Document,
  root: Element
): Promise<void> {
  const cssText = getSanitizedAccessibleCssText(frameDocument)
  const svgElements = [...root.querySelectorAll<SVGSVGElement>('svg')]
    .filter(svgElement => svgElement.parentElement?.closest('svg') == null)
  for (const svgElement of svgElements) {
    const rect = svgElement.getBoundingClientRect()
    if (!isRenderableRect(rect)) {
      continue
    }

    const image = await loadGaugeSvgImage(svgElement, frameDocument, rect, cssText)
    context.drawImage(image, rect.left, rect.top, rect.width, rect.height)
  }
}

async function loadGaugeSvgImage(
  svgElement: SVGSVGElement,
  frameDocument: Document,
  rect: DOMRect,
  cssText: string
): Promise<HTMLImageElement> {
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const signature = `${width}x${height}|${cssText}|${svgElement.outerHTML}`
  const cached = gaugeSvgImageCache.get(svgElement)
  if (cached?.signature === signature) {
    if (cached.image != null) {
      return cached.image
    }
    if (cached.promise != null) {
      return cached.promise
    }
  }

  const clone = svgElement.cloneNode(true) as SVGSVGElement
  clone.querySelectorAll('script, foreignObject').forEach(element => element.remove())
  removeUnsafeSvgExternalReferences(clone)
  sanitizeGaugeSvgForImageLoad(clone)
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', `${width}`)
  clone.setAttribute('height', `${height}`)
  if (!clone.hasAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${Math.max(1, rect.width)} ${Math.max(1, rect.height)}`)
  }
  if (cssText !== '') {
    const style = frameDocument.createElementNS('http://www.w3.org/2000/svg', 'style')
    style.textContent = cssText
    clone.prepend(style)
  }

  const nextCache: CachedGaugeSvgImage = {
    signature,
    image: null,
    promise: null
  }
  nextCache.promise = loadImageElement(createSvgObjectUrl(clone), true)
    .then(image => {
      nextCache.image = image
      nextCache.promise = null
      return image
    })
    .catch(error => {
      if (gaugeSvgImageCache.get(svgElement) === nextCache) {
        gaugeSvgImageCache.delete(svgElement)
      }
      throw error
    })
  gaugeSvgImageCache.set(svgElement, nextCache)
  return nextCache.promise
}

function sanitizeGaugeSvgForImageLoad(svgElement: SVGSVGElement): void {
  const lengthAttributes = [
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'width',
    'height'
  ]
  for (const element of [svgElement, ...svgElement.querySelectorAll<Element>('*')]) {
    const transform = element.getAttribute('transform')
    if (
      transform != null &&
      /\b(?:matrix3d|perspective|rotate[XYZ]|translateZ|scaleZ)\s*\(/iu.test(transform)
    ) {
      element.removeAttribute('transform')
    }

    for (const attribute of lengthAttributes) {
      const value = element.getAttribute(attribute)
      if (value != null && /\bNaN\b/iu.test(value)) {
        element.removeAttribute(attribute)
      }
    }
  }
}

function removeUnsafeSvgExternalReferences(svgElement: SVGSVGElement): void {
  for (const element of [...svgElement.querySelectorAll<Element>('[href], [xlink\\:href]')]) {
    const href =
      element.getAttribute('href') ??
      element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
      ''
    const normalized = href.trim().toLowerCase()
    if (
      normalized === '' ||
      normalized.startsWith('#') ||
      normalized.startsWith('data:image/')
    ) {
      continue
    }

    element.remove()
  }
}

function drawGaugeText(
  context: CanvasRenderingContext2D,
  root: Element
): void {
  const textElements = [...root.querySelectorAll<HTMLElement>('*')]
    .filter(element =>
      element.closest('svg') == null &&
      element.querySelector('svg, canvas') == null &&
      getElementOwnText(element).trim() !== '' &&
      isElementRenderable(element)
    )

  for (const element of textElements) {
    const rect = element.getBoundingClientRect()
    if (!isRenderableRect(rect)) {
      continue
    }

    const view = element.ownerDocument.defaultView
    const style = view?.getComputedStyle(element)
    const text = getElementOwnText(element).trim()
    if (style == null || text === '') {
      continue
    }

    context.save()
    context.globalAlpha = Number.parseFloat(style.opacity || '1')
    context.fillStyle = style.color || '#fff'
    context.font = [
      style.fontStyle,
      style.fontVariant,
      style.fontWeight,
      style.fontSize,
      style.fontFamily
    ].filter(Boolean).join(' ')
    context.textAlign = style.textAlign === 'right'
      ? 'right'
      : style.textAlign === 'center'
        ? 'center'
        : 'left'
    context.textBaseline = 'top'

    const x = context.textAlign === 'right'
      ? rect.right
      : context.textAlign === 'center'
        ? rect.left + rect.width / 2
        : rect.left
    const lineHeight = resolveCssPixelSize(style.lineHeight, resolveCssPixelSize(style.fontSize, 12) * 1.2)
    text.split(/\s*\n+\s*/u).forEach((line, index) => {
      context.fillText(line, x, rect.top + index * lineHeight, rect.width)
    })
    context.restore()
  }
}

function getElementOwnText(element: Element): string {
  return [...element.childNodes]
    .filter(node => node.nodeType === Node.TEXT_NODE)
    .map(node => node.textContent ?? '')
    .join('')
}

function isElementRenderable(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView
  const style = view?.getComputedStyle(element)
  return (
    style != null &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number.parseFloat(style.opacity || '1') > 0
  )
}

function isRenderableRect(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0 && Number.isFinite(rect.left) && Number.isFinite(rect.top)
}

function resolveCssPixelSize(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function sanitizeGaugeSvgCssText(cssText: string): string {
  return cssText
    .replaceAll(/url\([^)]*\)/giu, 'none')
    .replaceAll(/@font-face\s*\{[^}]*\}/giu, '')
}

function createSvgObjectUrl(svgElement: SVGSVGElement): string {
  const serialized = new XMLSerializer().serializeToString(svgElement)
  return URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }))
}

function assertCanvasIsOriginClean(canvas: HTMLCanvasElement): void {
  const context = getCanvasOriginCleanScratchContext()
  context.clearRect(0, 0, 1, 1)
  try {
    context.drawImage(canvas, 0, 0, 1, 1)
    context.getImageData(0, 0, 1, 1)
  } catch (error) {
    resetCanvasOriginCleanScratch()
    throw error
  }
}

function getCanvasOriginCleanScratchContext(): CanvasRenderingContext2D {
  if (canvasOriginCleanScratchCanvas == null) {
    canvasOriginCleanScratchCanvas = document.createElement('canvas')
    canvasOriginCleanScratchCanvas.width = 1
    canvasOriginCleanScratchCanvas.height = 1
  }

  if (canvasOriginCleanScratchContext == null) {
    canvasOriginCleanScratchContext =
      canvasOriginCleanScratchCanvas.getContext('2d', { willReadFrequently: true })
    if (canvasOriginCleanScratchContext == null) {
      throw new Error('could not create canvas origin-clean test context')
    }
  }

  return canvasOriginCleanScratchContext
}

function resetCanvasOriginCleanScratch(): void {
  if (canvasOriginCleanScratchCanvas == null) {
    canvasOriginCleanScratchContext = null
    return
  }

  canvasOriginCleanScratchCanvas.width = 1
  canvasOriginCleanScratchCanvas.height = 1
  canvasOriginCleanScratchContext =
    canvasOriginCleanScratchCanvas.getContext('2d', { willReadFrequently: true })
}

function isCanvasOriginClean(canvas: HTMLCanvasElement): boolean {
  const nowMs = performance.now()
  const cached = canvasOriginCleanCache.get(canvas)
  if (cached != null && nowMs - cached.checkedAtMs < CANVAS_ORIGIN_CLEAN_CACHE_MS) {
    return cached.clean
  }

  try {
    assertCanvasIsOriginClean(canvas)
    canvasOriginCleanCache.set(canvas, { clean: true, checkedAtMs: nowMs })
    return true
  } catch {
    canvasOriginCleanCache.set(canvas, { clean: false, checkedAtMs: nowMs })
    return false
  }
}

function loadImageElement(url: string, revokeUrl = false): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      if (revokeUrl) {
        URL.revokeObjectURL(url)
      }
      resolve(image)
    }
    image.onerror = () => {
      if (revokeUrl) {
        URL.revokeObjectURL(url)
      }
      reject(new Error('failed to load serialized gauge image'))
    }
    image.src = url
  })
}

function createVCockpitSurfaceAccent(surface: VCockpitSurface): string {
  let hash = 0
  for (const character of surface.normalizedTextureName) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  }
  const hue = hash % 360
  return `hsl(${hue}, 84%, 62%)`
}

function createVCockpitSurfaceMaterial(
  sourceMaterial: Material,
  surface: VCockpitSurface,
  texture: Texture
): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    name: sourceMaterial.name || surface.textureName,
    map: texture,
    toneMapped: false,
    side: sourceMaterial.side,
    transparent: sourceMaterial.transparent,
    opacity: sourceMaterial.opacity
  })
  material.userData = {
    ...sourceMaterial.userData,
    msfsVCockpitSurface: {
      panelPath: surface.panelPath,
      sectionName: surface.sectionName,
      textureName: surface.textureName
    }
  }
  return material
}

function combineLoadedAircraftModel(
  exterior: LoadedModelComponent,
  interior: LoadedModelComponent | null
): LoadedAircraftModel {
  const scene = new Group()
  scene.add(exterior.scene)
  if (interior != null) {
    scene.add(interior.scene)
  }

  return {
    scene,
    animations: buildLoadedAircraftAnimations(exterior, interior),
    exterior,
    interior
  }
}

function replaceLoadedAircraftInterior(
  model: LoadedAircraftModel,
  interior: LoadedModelComponent | null
): LoadedAircraftModel {
  return {
    scene: model.scene,
    animations: buildLoadedAircraftAnimations(model.exterior, interior),
    exterior: model.exterior,
    interior
  }
}

function disposeLoadedModelComponent(component: LoadedModelComponent): void {
  component.vcockpitBinding?.dispose()
  disposeObjectResources(component.scene)
}

function disposeObjectResources(object: Object3D): void {
  const disposedGeometries = new Set<unknown>()
  const disposedMaterials = new Set<Material>()
  const disposedTextures = new Set<Texture>()

  object.traverse(child => {
    if (!(child instanceof Mesh)) {
      return
    }

    if (child.geometry != null && !disposedGeometries.has(child.geometry)) {
      child.geometry.dispose()
      disposedGeometries.add(child.geometry)
    }

    const materials = Array.isArray(child.material)
      ? child.material
      : child.material != null
        ? [child.material]
        : []
    for (const material of materials) {
      if (material == null || disposedMaterials.has(material)) {
        continue
      }
      disposeMaterialTextures(material, disposedTextures)
      material.dispose()
      disposedMaterials.add(material)
    }
  })
}

function disposeMaterialTextures(material: Material, disposedTextures: Set<Texture>): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (value instanceof Texture && !disposedTextures.has(value)) {
      value.dispose()
      disposedTextures.add(value)
    }
  }
}

function buildLoadedAircraftAnimations(
  exterior: LoadedModelComponent,
  interior: LoadedModelComponent | null
): GLTF['animations'] {
  return interior != null
    ? [...exterior.animations, ...interior.animations]
    : [...exterior.animations]
}

async function loadAircraftModelDefinitionGltf(
  loader: GLTFLoader,
  aircraft: ImportedAircraft,
  modelDefinition: ImportedModelDefinition,
  createNodeMaterial: NodeMaterialFactory | null,
  preferredLodIndex: number | null,
  fallbackToOtherLods = true,
  recordPhase: (
    label: string,
    startMs: number,
    details?: Record<string, unknown> | null
  ) => void = () => {},
  firstAllowedLodIndex: number | null = null,
  prepareGltfInWorker = false
): Promise<{
  readonly gltf: GLTF
  readonly loadedLodIndex: number
}> {
  let lastError: unknown = null
  const allLodEntries = [...modelDefinition.lods]
    .sort((left, right) => right.minSize - left.minSize)
    .map((lod, index) => ({ lod, index }))
  const minimumLodIndex = firstAllowedLodIndex == null
    ? 0
    : Math.max(0, Math.min(firstAllowedLodIndex, allLodEntries.length))
  const lodEntries = allLodEntries.filter(({ index }) => index >= minimumLodIndex)
  if (lodEntries.length === 0) {
    throw new Error(`No model LOD satisfies first allowed LOD index ${minimumLodIndex}.`)
  }

  const maximumLodIndex = allLodEntries.length - 1
  const resolvedPreferredLodIndex =
    preferredLodIndex == null
      ? null
      : Math.min(Math.max(preferredLodIndex, minimumLodIndex), maximumLodIndex)
  const preferredLodEntry =
    resolvedPreferredLodIndex == null
      ? null
      : lodEntries.find(({ index }) => index === resolvedPreferredLodIndex) ?? null
  const loadOrder = preferredLodEntry != null
    ? fallbackToOtherLods
      ? [
          preferredLodEntry,
          ...lodEntries.filter(({ index }) => index !== preferredLodEntry.index)
        ]
      : [preferredLodEntry]
    : lodEntries

  for (const { lod, index } of loadOrder) {
    try {
      setGlobalLoadStage({
        stage: 'gltf:lod:fetch',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      const gltf = await loadMsfsGltfLod(loader, lod.url, {
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      }, recordPhase, prepareGltfInWorker)
      setGlobalLoadStage({
        stage: 'gltf:lod:repair-skinned',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      const repairStartMs = performance.now()
      await repairMsfsSkinnedAttributes(gltf)
      recordPhase('lod:repair-skinned-attributes', repairStartMs)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-skinning',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      const skinningStartMs = performance.now()
      normalizeMsfsSkinning(gltf.scene)
      recordPhase('lod:normalize-skinning', skinningStartMs)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-texcoords',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      const texcoordStartMs = performance.now()
      normalizeMsfsTexcoords(gltf.scene)
      recordPhase('lod:normalize-texcoords', texcoordStartMs)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-colors',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      const colorStartMs = performance.now()
      normalizeMsfsVertexColors(gltf.scene)
      recordPhase('lod:normalize-vertex-colors', colorStartMs)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-normals',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      const normalsStartMs = performance.now()
      normalizeMsfsNormalsTangents(gltf.scene)
      recordPhase('lod:normalize-normals-tangents', normalsStartMs)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-asobo-primitive-base-vertex',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      const baseVertexStartMs = performance.now()
      normalizeAsoboPrimitiveBaseVertex(gltf)
      recordPhase('lod:normalize-asobo-primitive-base-vertex', baseVertexStartMs)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-asobo-primitive-winding',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      const windingStartMs = performance.now()
      normalizeAsoboPrimitiveWinding(gltf)
      recordPhase('lod:normalize-asobo-primitive-winding', windingStartMs)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-materials',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      const materialStartMs = performance.now()
      await normalizeMsfsMaterials(gltf, { createNodeMaterial })
      recordPhase('lod:normalize-materials', materialStartMs)
      setGlobalLoadStage({
        stage: 'gltf:lod:ready',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      return {
        gltf,
        loadedLodIndex: index
      }
    } catch (error) {
      lastError = error
      recordPhase('lod:error', performance.now(), {
        loadedLodIndex: index,
        error: error instanceof Error ? error.message : String(error)
      })
      setGlobalLoadStage({
        stage: 'gltf:lod:error',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to load any model LOD for ${modelDefinition.behaviorPath}.`)
}

async function loadMsfsGltfLod(
  loader: GLTFLoader,
  url: string,
  loadContext: {
    readonly aircraftId: string
    readonly lodUrl: string
    readonly lodMinSize: number
  } | null = null,
  recordPhase: (
    label: string,
    startMs: number,
    details?: Record<string, unknown> | null
  ) => void = () => {},
  prepareGltfInWorker = false
): Promise<GLTF> {
  const baseUrl = url.slice(0, url.lastIndexOf('/') + 1)
  const workerPrepared = !prepareGltfInWorker
    ? null
    : await prepareMsfsGltfLodWithWorkerFallback(
      url,
      loadContext,
      recordPhase
    )
  const sanitizedGltf = workerPrepared?.gltfJson ?? await prepareMsfsGltfJsonOnMainThread(
    url,
    loadContext,
    recordPhase
  )
  const preparedBuffers = workerPrepared ?? await prepareExternalGltfBuffers(
    sanitizedGltf,
    baseUrl,
    loadContext,
    recordPhase
  )
  if (loadContext != null) {
    setGlobalLoadStage({
      stage: 'gltf:lod:parse:start',
      ...loadContext
    })
  }
  const loaderParseStartMs = performance.now()
  try {
    const gltf = await loader.parseAsync(sanitizedGltf as never, baseUrl)
    recordPhase('lod:gltf-loader-parse', loaderParseStartMs)
    if (loadContext != null) {
      setGlobalLoadStage({
        stage: 'gltf:lod:parse:done',
        ...loadContext
      })
    }
    return gltf
  } finally {
    for (const objectUrl of preparedBuffers.objectUrls) {
      URL.revokeObjectURL(objectUrl)
    }
  }
}

async function waitForMsfsGltfLoaderIdle(
  loader: GLTFLoader,
  recordPhase: (
    label: string,
    startMs: number,
    details?: Record<string, unknown> | null
  ) => void
): Promise<void> {
  const stats = getMsfsGltfLoadingManagerStats(loader.manager)
  if (stats == null || stats.activeCount === 0) {
    return
  }

  const waitStartMs = performance.now()
  while (stats.activeCount > 0) {
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => resolve())
    })
  }
  recordPhase('component:wait-textures', waitStartMs, {
    started: stats.started,
    ended: stats.ended,
    errored: stats.errored
  })
}

async function prepareMsfsGltfLodWithWorkerFallback(
  url: string,
  loadContext: {
    readonly aircraftId: string
    readonly lodUrl: string
    readonly lodMinSize: number
  } | null,
  recordPhase: (
    label: string,
    startMs: number,
    details?: Record<string, unknown> | null
  ) => void
): Promise<{
  readonly gltfJson: Record<string, unknown>
  readonly objectUrls: readonly string[]
} | null> {
  const workerStartMs = performance.now()
  if (loadContext != null) {
    setGlobalLoadStage({
      stage: 'gltf:lod:worker:start',
      ...loadContext
    })
  }
  try {
    const prepared = await queueTask('prepareMsfsGltfLod', [url])
    const workerPrepared = createPreparedGltfObjectUrls(prepared)
    recordPhase('lod:worker-prepare', workerStartMs, {
      bufferCount: prepared.buffers.length,
      byteLength: prepared.buffers.reduce((total, buffer) => {
        return total + buffer.byteLength
      }, 0),
      workerPhases: prepared.phases
    })
    if (loadContext != null) {
      setGlobalLoadStage({
        stage: 'gltf:lod:worker:done',
        ...loadContext
      })
    }
    return workerPrepared
  } catch (error) {
    recordPhase('lod:worker-prepare:error', workerStartMs, {
      error: error instanceof Error ? error.message : String(error)
    })
    if (loadContext != null) {
      setGlobalLoadStage({
        stage: 'gltf:lod:worker:fallback',
        ...loadContext,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return null
  }
}

function createPreparedGltfObjectUrls(
  prepared: PreparedMsfsGltfLodWorkerResult
): {
  readonly gltfJson: Record<string, unknown>
  readonly objectUrls: readonly string[]
} {
  const buffers = Array.isArray(prepared.gltfJson.buffers)
    ? prepared.gltfJson.buffers as Array<Record<string, unknown>>
    : []
  const objectUrls: string[] = []
  try {
    for (const preparedBuffer of prepared.buffers) {
      const gltfBuffer = buffers[preparedBuffer.index]
      if (gltfBuffer == null) {
        throw new Error(`Prepared GLTF buffer ${preparedBuffer.index} was not found.`)
      }
      const objectUrl = URL.createObjectURL(new Blob([preparedBuffer.buffer], {
        type: 'application/octet-stream'
      }))
      objectUrls.push(objectUrl)
      gltfBuffer.uri = objectUrl
    }
    return {
      gltfJson: prepared.gltfJson,
      objectUrls
    }
  } catch (error) {
    for (const objectUrl of objectUrls) {
      URL.revokeObjectURL(objectUrl)
    }
    throw error
  }
}

async function prepareMsfsGltfJsonOnMainThread(
  url: string,
  loadContext: {
    readonly aircraftId: string
    readonly lodUrl: string
    readonly lodMinSize: number
  } | null,
  recordPhase: (
    label: string,
    startMs: number,
    details?: Record<string, unknown> | null
  ) => void
): Promise<Record<string, unknown>> {
  const fetchStartMs = performance.now()
  const response = await fetch(url)
  recordPhase('lod:fetch', fetchStartMs, {
    httpStatus: response.status,
    ok: response.ok
  })
  if (loadContext != null) {
    setGlobalLoadStage({
      stage: 'gltf:lod:fetch:response',
      ...loadContext,
      httpStatus: response.status
    })
  }
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${response.status}`)
  }

  const contentLengthHeader = response.headers.get('content-length')
  const contentLength =
    contentLengthHeader == null ? null : Number.parseInt(contentLengthHeader, 10)
  const jsonStartMs = performance.now()
  const gltfJson = (await response.json()) as Record<string, unknown>
  recordPhase('lod:parse-json', jsonStartMs, {
    byteLength: Number.isFinite(contentLength) ? contentLength : null
  })
  if (loadContext != null) {
    setGlobalLoadStage({
      stage: 'gltf:lod:json:loaded',
      ...loadContext,
      byteLength: Number.isFinite(contentLength) ? contentLength : null
    })
  }

  const sanitizeStartMs = performance.now()
  const sanitizedGltf = sanitizeMsfsGltf(gltfJson)
  recordPhase('lod:sanitize-msfs-gltf', sanitizeStartMs)
  return sanitizedGltf
}

async function prepareExternalGltfBuffers(
  gltfJson: Record<string, unknown>,
  baseUrl: string,
  loadContext: {
    readonly aircraftId: string
    readonly lodUrl: string
    readonly lodMinSize: number
  } | null,
  recordPhase: (
    label: string,
    startMs: number,
    details?: Record<string, unknown> | null
  ) => void
): Promise<{ readonly objectUrls: readonly string[] }> {
  const buffers = Array.isArray(gltfJson.buffers)
    ? gltfJson.buffers as Array<Record<string, unknown>>
    : []
  const externalBuffers = buffers
    .map((buffer, index) => ({ buffer, index, uri: buffer.uri }))
    .filter((entry): entry is {
      readonly buffer: Record<string, unknown>
      readonly index: number
      readonly uri: string
    } => typeof entry.uri === 'string' && !isEmbeddedGltfBufferUri(entry.uri))

  if (externalBuffers.length === 0) {
    return { objectUrls: [] }
  }

  const objectUrls: string[] = []
  try {
    await Promise.all(externalBuffers.map(async ({ buffer, index, uri }) => {
      const bufferUrl = new URL(uri, baseUrl).toString()
      const bufferStartMs = performance.now()
      if (loadContext != null) {
        setGlobalLoadStage({
          stage: 'gltf:lod:buffer:fetch',
          ...loadContext,
          bufferIndex: index,
          bufferUrl
        })
      }
      const arrayBuffer = await fetchExternalGltfBuffer(
        bufferUrl,
        progress => {
          if (loadContext != null) {
            setGlobalLoadStage({
              stage: 'gltf:lod:buffer:fetch',
              ...loadContext,
              bufferIndex: index,
              bufferUrl,
              ...progress
            })
          }
        }
      )
      recordPhase('lod:fetch-buffer', bufferStartMs, {
        bufferIndex: index,
        byteLength: arrayBuffer.byteLength
      })
      const objectUrl = URL.createObjectURL(new Blob([arrayBuffer], {
        type: 'application/octet-stream'
      }))
      objectUrls.push(objectUrl)
      buffer.uri = objectUrl
    }))
  } catch (error) {
    for (const objectUrl of objectUrls) {
      URL.revokeObjectURL(objectUrl)
    }
    throw error
  }

  return { objectUrls }
}

const GLTF_BUFFER_CHUNK_BYTES = 256 * 1024
const GLTF_BUFFER_CHUNK_TIMEOUT_MS = 60000
const GLTF_BUFFER_CHUNK_CONCURRENCY = 6

async function fetchExternalGltfBuffer(
  url: string,
  onProgress: (progress: {
    readonly loadedBytes: number
    readonly totalBytes: number | null
    readonly loadedChunks: number
    readonly totalChunks: number | null
  }) => void = () => {}
): Promise<ArrayBuffer> {
  const requestUrl = appendGltfBufferCacheBuster(url)
  const firstEnd = GLTF_BUFFER_CHUNK_BYTES - 1
  const firstResponse = await fetchExternalGltfBufferRange(requestUrl, 0, firstEnd)
  if (firstResponse.status !== 206) {
    if (!firstResponse.ok) {
      throw new Error(`Failed to load ${url}: HTTP ${firstResponse.status}`)
    }
    onProgress({
      loadedBytes: firstResponse.buffer.byteLength,
      totalBytes: firstResponse.buffer.byteLength,
      loadedChunks: 1,
      totalChunks: 1
    })
    return firstResponse.buffer
  }

  const firstRange = parseContentRange(firstResponse.contentRange)
  if (firstRange == null) {
    return firstResponse.buffer
  }

  const output = new Uint8Array(firstRange.size)
  output.set(new Uint8Array(firstResponse.buffer), 0)
  const ranges: Array<{ readonly start: number; readonly end: number }> = []
  for (let start = firstRange.end + 1; start < firstRange.size; start += GLTF_BUFFER_CHUNK_BYTES) {
    ranges.push({
      start,
      end: Math.min(start + GLTF_BUFFER_CHUNK_BYTES - 1, firstRange.size - 1)
    })
  }
  const totalChunks = ranges.length + 1
  let loadedChunks = 1
  let loadedBytes = firstResponse.buffer.byteLength
  onProgress({
    loadedBytes,
    totalBytes: firstRange.size,
    loadedChunks,
    totalChunks
  })

  let nextRangeIndex = 0
  const loadNextRange = async (): Promise<void> => {
    while (nextRangeIndex < ranges.length) {
      const range = ranges[nextRangeIndex]!
      nextRangeIndex += 1
      const { start, end } = range
      const response = await fetchExternalGltfBufferRange(requestUrl, start, end)
      if (response.status !== 206 && !response.ok) {
        throw new Error(`Failed to load ${url}: HTTP ${response.status}`)
      }
      output.set(new Uint8Array(response.buffer), start)
      loadedChunks += 1
      loadedBytes += response.buffer.byteLength
      onProgress({
        loadedBytes,
        totalBytes: firstRange.size,
        loadedChunks,
        totalChunks
      })
    }
  }
  await Promise.all(
    Array.from({
      length: Math.min(GLTF_BUFFER_CHUNK_CONCURRENCY, ranges.length)
    }, () => loadNextRange())
  )
  return output.buffer
}

async function fetchExternalGltfBufferRange(
  url: string,
  start: number,
  end: number
): Promise<{
  readonly ok: boolean
  readonly status: number
  readonly contentRange: string | null
  readonly buffer: ArrayBuffer
}> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    GLTF_BUFFER_CHUNK_TIMEOUT_MS
  )
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Range: `bytes=${start}-${end}`
      },
      signal: controller.signal
    })
    const buffer = await response.arrayBuffer()
    return {
      ok: response.ok,
      status: response.status,
      contentRange: response.headers.get('content-range'),
      buffer
    }
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function appendGltfBufferCacheBuster(url: string): string {
  const parsedUrl = new URL(url, window.location.href)
  parsedUrl.searchParams.set(
    'msfsBufferLoad',
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  )
  return parsedUrl.toString()
}

function parseContentRange(header: string | null): {
  readonly start: number
  readonly end: number
  readonly size: number
} | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/iu.exec(header ?? '')
  if (match == null) {
    return null
  }

  return {
    start: Number.parseInt(match[1]!, 10),
    end: Number.parseInt(match[2]!, 10),
    size: Number.parseInt(match[3]!, 10)
  }
}

function isEmbeddedGltfBufferUri(uri: string): boolean {
  return uri.startsWith('data:') || uri.startsWith('blob:')
}

function createDefaultModelTextureLoadOptions(): MSFSDDSLoadOptions {
  return {
    rangeMaxTextureSize: 1024,
    rangeFallback: 'full'
  }
}

function createTextureUrlResolver(
  aircraft: ImportedAircraft,
  packageRootUrl: string,
  layoutPaths: readonly string[],
  additionalAssetRoots: readonly AssetRoot[]
): (url: string) => string {
  const textureDirectories = aircraft.textureDirectories
  const layoutPathIndex = new Map(
    layoutPaths.map(path => {
      const normalizedPath = normalizePath(path)
      return [normalizedPath.toLowerCase(), normalizedPath] as const
    })
  )

  return (url: string): string => {
    if (!url.toLowerCase().endsWith('.dds')) {
      return url
    }

    const parsedUrl = new URL(url, window.location.href)
    const fileName = parsedUrl.pathname.split('/').at(-1)
    if (!fileName) {
      return parsedUrl.toString()
    }

    const textureCandidates = textureDirectories.map(textureDirectory =>
      normalizePath(`${textureDirectory}/${fileName}`)
    )

    for (const candidatePath of textureCandidates) {
      const normalizedCandidatePath = candidatePath.toLowerCase()
      const resolvedPackagePath = layoutPathIndex.get(normalizedCandidatePath)
      if (resolvedPackagePath == null) {
        for (const assetRoot of additionalAssetRoots) {
          const resolvedAssetPath = assetRoot.layoutPathIndex.get(normalizedCandidatePath)
          if (resolvedAssetPath == null) {
            continue
          }

          return new URL(resolvedAssetPath, assetRoot.rootUrl).toString()
        }
        continue
      }

      return new URL(resolvedPackagePath, packageRootUrl).toString()
    }

    if (textureCandidates.length > 0) {
      return new URL(textureCandidates[0], packageRootUrl).toString()
    }

    return parsedUrl.toString()
  }
}

function createPanelAssetUrlResolver(
  packageRootUrl: string,
  layoutPaths: readonly string[],
  additionalAssetRoots: readonly AssetRoot[]
): (source: string) => string | null {
  const layoutPathIndex = new Map(
    layoutPaths.map(path => {
      const normalizedPath = normalizePath(path)
      return [normalizedPath.toLowerCase(), normalizedPath] as const
    })
  )

  return (source: string): string | null => {
    const parsedSource = parsePanelAssetSource(source)
    if (parsedSource == null) {
      return null
    }

    for (const candidatePath of getPanelAssetCandidatePaths(parsedSource.path)) {
      const normalizedCandidatePath = candidatePath.toLowerCase()
      const packagePath = layoutPathIndex.get(normalizedCandidatePath)
      if (packagePath != null) {
        return new URL(`${packagePath}${parsedSource.query}`, packageRootUrl).toString()
      }

      for (const assetRoot of additionalAssetRoots) {
        const assetPath = assetRoot.layoutPathIndex.get(normalizedCandidatePath)
        if (assetPath != null) {
          return new URL(`${assetPath}${parsedSource.query}`, assetRoot.rootUrl).toString()
        }
      }
    }

    return null
  }
}

function parsePanelAssetSource(source: string): {
  readonly path: string
  readonly query: string
} | null {
  const trimmed = source.trim()
  if (trimmed === '') {
    return null
  }

  const queryIndex = trimmed.indexOf('?')
  const sourcePath = queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed
  const query = queryIndex >= 0 ? trimmed.slice(queryIndex) : ''
  const normalizedSourcePath = normalizePath(sourcePath.replace(/^\/+/u, ''))
  if (normalizedSourcePath === '') {
    return null
  }

  return {
    path: normalizedSourcePath,
    query
  }
}

function getPanelAssetCandidatePaths(sourcePath: string): string[] {
  const normalizedSourcePath = normalizePath(sourcePath)
  return [
    `html_ui/Pages/VCockpit/Instruments/${normalizedSourcePath}`,
    `html_ui/Pages/VCockpit/${normalizedSourcePath}`,
    `html_ui/${normalizedSourcePath}`,
    normalizedSourcePath
  ].map(normalizePath)
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+/gu, '/')
}

function selectAircraft(
  aircraft: readonly ImportedAircraft[],
  requestedId: string | null
): ImportedAircraft | null {
  if (requestedId != null) {
    return aircraft.find(candidate => candidate.id === requestedId && candidate.model != null) ?? null
  }

  const devDefaultAircraft = aircraft.find(
    candidate => candidate.id === DEV_DEFAULT_AIRCRAFT_ID && candidate.model != null
  )
  if (devDefaultAircraft != null) {
    return devDefaultAircraft
  }

  const rankedAircraft = [...aircraft].sort((left, right) => {
    const leftScore = getAircraftSelectionScore(left)
    const rightScore = getAircraftSelectionScore(right)
    return rightScore - leftScore
  })

  return rankedAircraft.find(candidate => candidate.model != null) ?? null
}

function getAircraftSelectionScore(aircraft: ImportedAircraft): number {
  let score = 0
  if (aircraft.model != null) score += 100
  if (aircraft.isUserSelectable) score += 20
  if (aircraft.isFlyable) score += 20
  score += aircraft.inheritedFromPaths.length * 5
  return score
}

function centerObjectAtOrigin(object: Group): void {
  const bounds = computeApproximateBounds(object)
  const center = bounds.getCenter(new Vector3())
  object.position.sub(center)

  const recenteredBounds = computeApproximateBounds(object)
  const minimumY = recenteredBounds.min.y
  object.position.y -= minimumY
}

function fitCameraToObject(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  object: Group,
  aircraft: ImportedAircraft
): void {
  const bounds = computeApproximateBounds(object)
  const size = bounds.getSize(new Vector3())
  const viewerCenter = computeViewerOrbitTarget(object, bounds)
  const radius = Math.max(size.x, size.y, size.z)
  const externalCamera = resolveExternalAircraftCameraDefinition(aircraft)
  camera.near = 0.1
  camera.far = Math.max(5000, radius * 40)

  if (externalCamera != null) {
    camera.position.copy(viewerCenter).add(externalCamera.positionOffset)
  } else {
    camera.position
      .copy(viewerCenter)
      .add(new Vector3(radius * 1.2, radius * 0.35, radius * 1.05))
  }

  camera.lookAt(viewerCenter)
  camera.updateProjectionMatrix()
  controls.target.copy(viewerCenter)
  controls.update()
}

type CameraDepthClipController = {
  refreshBounds(): void
  markModelChanged(): void
  update(): void
}

type CameraClipPlanes = {
  readonly near: number
  readonly far: number
}

type CameraDepthClipBound = {
  readonly mesh: Mesh
  readonly localBox: Box3
  readonly worldBox: Box3
  readonly lastMatrixWorld: number[]
  hasWorldBox: boolean
}

function createCameraDepthClipController(
  camera: PerspectiveCamera,
  object: Group
): CameraDepthClipController {
  const cameraSpaceCorner = new Vector3()
  const cameraWorldPosition = new Vector3()
  const meshWorldBox = new Box3()
  const meshBounds: CameraDepthClipBound[] = []
  const lastCameraPosition = new Vector3(Number.NaN, Number.NaN, Number.NaN)
  const lastCameraQuaternion = camera.quaternion.clone()
  let nextFallbackUpdateMs = 0
  let forceNextUpdate = true

  const refreshBounds = (): void => {
    meshBounds.length = 0
    object.updateWorldMatrix(true, true)
    object.traverse(node => {
      if (!(node instanceof Mesh) || node.geometry == null) {
        return
      }

      if (node instanceof SkinnedMesh) {
        node.computeBoundingBox()
      } else if (node.geometry.boundingBox == null) {
        node.geometry.computeBoundingBox()
      }

      const localBox =
        node instanceof SkinnedMesh
          ? node.boundingBox
          : node.geometry.boundingBox

      if (localBox == null || localBox.isEmpty()) {
        return
      }

      meshBounds.push({
        mesh: node,
        localBox: localBox.clone(),
        worldBox: new Box3(),
        lastMatrixWorld: new Array<number>(16).fill(Number.NaN),
        hasWorldBox: false
      })
    })
    forceNextUpdate = true
  }

  const update = (): void => {
    if (meshBounds.length === 0) {
      return
    }

    const nowMs = performance.now()
    const cameraChanged =
      forceNextUpdate ||
      camera.position.distanceToSquared(lastCameraPosition) > 1e-6 ||
      Math.abs(camera.quaternion.dot(lastCameraQuaternion)) < 0.999999
    if (!cameraChanged && nowMs < nextFallbackUpdateMs) {
      return
    }
    if (cameraChanged) {
      lastCameraPosition.copy(camera.position)
      lastCameraQuaternion.copy(camera.quaternion)
    }
    forceNextUpdate = false
    nextFallbackUpdateMs = nowMs + CAMERA_DEPTH_CLIP_FALLBACK_INTERVAL_MS

    camera.updateMatrixWorld()
    camera.getWorldPosition(cameraWorldPosition)
    let nearestDepth = Number.POSITIVE_INFINITY
    let farthestDepth = 0
    let intersectsCamera = false

    for (const bound of meshBounds) {
      const { mesh } = bound
      if (!isVisibleInHierarchy(mesh)) {
        continue
      }

      updateCameraDepthClipWorldBox(bound)
      meshWorldBox.copy(bound.worldBox)

      if (meshWorldBox.isEmpty()) {
        continue
      }

      if (meshWorldBox.containsPoint(cameraWorldPosition)) {
        intersectsCamera = true
      }

      let meshNearestDepth = Number.POSITIVE_INFINITY
      let meshFarthestDepth = 0
      forEachBoxCorner(meshWorldBox, cameraSpaceCorner, corner => {
        corner.applyMatrix4(camera.matrixWorldInverse)
        const depth = -corner.z
        if (depth <= 0) {
          return
        }
        meshNearestDepth = Math.min(meshNearestDepth, depth)
        meshFarthestDepth = Math.max(meshFarthestDepth, depth)
      })

      if (meshFarthestDepth <= 0) {
        continue
      }

      farthestDepth = Math.max(farthestDepth, meshFarthestDepth)
      nearestDepth = Math.min(nearestDepth, meshNearestDepth)
    }

    if (farthestDepth <= 0) {
      return
    }

    const depthRange = Math.max(MIN_CAMERA_CLIP_RANGE, farthestDepth - nearestDepth)
    const farClipPadding = Math.max(
      MIN_CAMERA_CLIP_PADDING,
      depthRange * CAMERA_CLIP_DEPTH_PADDING_RATIO
    )
    const nearClipPadding = intersectsCamera
      ? farClipPadding
      : Math.min(
          CAMERA_NEAR_CLIP_MAX_PADDING,
          nearestDepth * CAMERA_NEAR_CLIP_PADDING_RATIO
        )
    const nextNear = intersectsCamera
      ? MIN_CAMERA_CLIP_NEAR
      : Math.max(MIN_CAMERA_CLIP_NEAR, nearestDepth - nearClipPadding)
    const nextFar = Math.max(nextNear + MIN_CAMERA_CLIP_RANGE, farthestDepth + farClipPadding)

    if (!shouldUpdateCameraClipPlane(camera.near, nextNear)) {
      if (!shouldUpdateCameraClipPlane(camera.far, nextFar)) {
        return
      }
    }

    camera.near = nextNear
    camera.far = nextFar
    camera.updateProjectionMatrix()
  }

  refreshBounds()

  return {
    refreshBounds: () => {
      refreshBounds()
      update()
    },
    markModelChanged: () => {
      forceNextUpdate = true
    },
    update
  }
}

const MIN_CAMERA_CLIP_NEAR = 0.01
const MIN_CAMERA_CLIP_RANGE = 0.01
const MIN_CAMERA_CLIP_PADDING = 0.5
const CAMERA_CLIP_DEPTH_PADDING_RATIO = 0.08
const CAMERA_NEAR_CLIP_MAX_PADDING = 0.05
const CAMERA_NEAR_CLIP_PADDING_RATIO = 0.25
const CAMERA_DEPTH_CLIP_FALLBACK_INTERVAL_MS = 1_000
const COCKPIT_CAMERA_CLIP_NEAR = 0.01
const COCKPIT_CAMERA_MIN_CLIP_FAR = 25
const COCKPIT_CAMERA_DEFAULT_CLIP_FAR = 250
const COCKPIT_CAMERA_CLIP_FAR_PADDING = 10

const cameraDepthClipWorldBoxCorner = new Vector3()

function updateCameraDepthClipWorldBox(bound: CameraDepthClipBound): void {
  if (
    bound.hasWorldBox &&
    matrixWorldElementsEqual(bound.mesh.matrixWorld.elements, bound.lastMatrixWorld)
  ) {
    return
  }

  const matrixWorldElements = bound.mesh.matrixWorld.elements
  bound.worldBox.makeEmpty()
  forEachBoxCorner(bound.localBox, cameraDepthClipWorldBoxCorner, corner => {
    bound.worldBox.expandByPoint(corner.applyMatrix4(bound.mesh.matrixWorld))
  })
  for (let index = 0; index < 16; index += 1) {
    bound.lastMatrixWorld[index] = matrixWorldElements[index]!
  }
  bound.hasWorldBox = true
}

function matrixWorldElementsEqual(
  left: readonly number[],
  right: readonly number[]
): boolean {
  for (let index = 0; index < 16; index += 1) {
    if (Math.abs(left[index]! - right[index]!) > 1e-10) {
      return false
    }
  }
  return true
}

function shouldUpdateCameraClipPlane(current: number, next: number): boolean {
  return Math.abs(current - next) > Math.max(0.001, Math.abs(next) * 0.001)
}

function forEachBoxCorner(
  box: Box3,
  target: Vector3,
  callback: (corner: Vector3) => void
): void {
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        callback(target.set(x, y, z))
      }
    }
  }
}

function isVisibleInHierarchy(object: Object3D): boolean {
  let current: Object3D | null = object
  while (current != null) {
    if (!current.visible) {
      return false
    }
    current = current.parent
  }
  return true
}

function estimateObjectVerticalScreenSizePercent(
  camera: PerspectiveCamera,
  object: Group
): number | null {
  const bounds = computeApproximateBounds(object)
  if (bounds.isEmpty()) {
    return null
  }

  const corners = [
    new Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
    new Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
    new Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
    new Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
    new Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
    new Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
    new Vector3(bounds.max.x, bounds.max.y, bounds.max.z)
  ]

  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const corner of corners) {
    const projected = corner.project(camera)
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
      return null
    }
    minY = Math.min(minY, projected.y)
    maxY = Math.max(maxY, projected.y)
  }

  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY) {
    return null
  }

  return Math.max(0, (maxY - minY) * 50)
}

function selectModelLodIndexForScreenSize(
  modelDefinition: ImportedModelDefinition,
  screenSizePercent: number,
  firstAllowedLodIndex: number
): number | null {
  const lodEntries = [...modelDefinition.lods]
    .sort((left, right) => right.minSize - left.minSize)
    .map((lod, index) => ({ lod, index }))
    .filter(({ index }) => index >= firstAllowedLodIndex)

  if (lodEntries.length === 0) {
    return null
  }

  return (
    lodEntries.find(({ lod }) => screenSizePercent >= lod.minSize) ??
    lodEntries.at(-1)!
  ).index
}

const AUTO_COCKPIT_INTERIOR_LOD_MAX_ESTIMATED_BYTES = 8 * 1024 * 1024

function selectAutoCockpitInteriorLodIndex(modelDefinition: ImportedModelDefinition): number {
  const lodEntries = [...modelDefinition.lods]
    .sort((left, right) => right.minSize - left.minSize)
    .map((lod, index) => ({ lod, index }))

  for (const { lod, index } of lodEntries) {
    const estimatedBytes = estimateModelLodResourceBytes(lod)
    if (
      estimatedBytes == null ||
      estimatedBytes <= AUTO_COCKPIT_INTERIOR_LOD_MAX_ESTIMATED_BYTES
    ) {
      return index
    }
  }

  return lodEntries.at(-1)?.index ?? 0
}

function estimateModelLodResourceBytes(lod: ModelLodEntry): number | null {
  const sizes = [lod.modelFileSize, lod.siblingBufferFileSize]
    .filter((size): size is number => typeof size === 'number' && Number.isFinite(size))
  if (sizes.length === 0) {
    return null
  }

  return sizes.reduce((sum, size) => sum + size, 0)
}

function computeViewerOrbitTarget(object: Group, bounds: Box3): Vector3 {
  const center = bounds.getCenter(new Vector3())
  return new Vector3(
    center.x,
    computeTrimmedVisualCenterY(object, bounds),
    center.z
  )
}

function computeTrimmedVisualCenterY(object: Group, bounds: Box3): number {
  const fallbackCenter = bounds.getCenter(new Vector3()).y
  const samples: number[] = []
  const worldPosition = new Vector3()
  object.updateWorldMatrix(true, true)

  object.traverse(node => {
    if (!(node instanceof Mesh) || !node.visible) {
      return
    }

    const position = node.geometry?.attributes.position
    if (position == null || position.count <= 0) {
      return
    }

    const stride = Math.max(1, Math.ceil(position.count / 160))
    for (let index = 0; index < position.count; index += stride) {
      worldPosition
        .fromBufferAttribute(position, index)
        .applyMatrix4(node.matrixWorld)
      if (Number.isFinite(worldPosition.y)) {
        samples.push(worldPosition.y)
      }
    }
  })

  if (samples.length < 8) {
    return fallbackCenter
  }

  samples.sort((left, right) => left - right)
  const lowIndex = Math.floor(samples.length * 0.12)
  const highIndex = Math.max(lowIndex + 1, Math.ceil(samples.length * 0.72))
  const lower = samples[lowIndex] ?? fallbackCenter
  const upper = samples[highIndex - 1] ?? fallbackCenter

  return (lower + upper) * 0.5
}

type CockpitCameraDefinition = {
  readonly position: Vector3
  readonly rotationPbhDegrees: Vector3
}

type ExternalAircraftCameraDefinition = {
  readonly positionOffset: Vector3
}

type ParsedCameraSection = {
  readonly declarationIndex: number
  readonly origin: string
  readonly category: string
  readonly subCategory: string
  readonly subCategoryItem: string
  readonly title: string
  readonly initialXyz: [number, number, number]
  readonly initialPbh: [number, number, number]
}

type OrbitCameraSnapshot = {
  readonly position: Vector3
  readonly target: Vector3
  readonly up: Vector3
  readonly zoom: number
}

export type CockpitInteractionFallbackHitbox = {
  readonly binding: CompiledInteractionBinding
  readonly sourceNode: Object3D
  readonly box: Box3
}

export type CockpitInteractionBlockerHitbox = {
  readonly blocker: CompiledInteractionBlocker
  readonly sourceNode: Object3D
  readonly box: Box3
}

export type CockpitInteractionPickRegistry = {
  readonly meshes: readonly Mesh[]
  readonly bindingsByMesh: ReadonlyMap<Object3D, CompiledInteractionBinding>
  readonly fallbackHitboxes: readonly CockpitInteractionFallbackHitbox[]
  readonly blockerMeshes: readonly Mesh[]
  readonly blockersByMesh: ReadonlyMap<Object3D, CompiledInteractionBlocker>
  readonly blockerHitboxes: readonly CockpitInteractionBlockerHitbox[]
  readonly occluderMeshes: readonly Mesh[]
}

const FEET_TO_METERS = 0.3048
let disposeCockpitCameraShortcut: (() => void) | null = null

function createCockpitInteractionPickRegistry(
  root: Object3D,
  bindings: readonly CompiledInteractionBinding[],
  blockers: readonly CompiledInteractionBlocker[],
  animations: readonly AnimationClip[]
): CockpitInteractionPickRegistry {
  const nodesByName = new Map<string, Object3D>()
  root.updateWorldMatrix(true, true)
  root.traverse(node => {
    if (!node.name) {
      return
    }
    if (!nodesByName.has(node.name)) {
      nodesByName.set(node.name, node)
    }
    const lowerName = node.name.toLowerCase()
    if (!nodesByName.has(lowerName)) {
      nodesByName.set(lowerName, node)
    }
  })
  const animationNodesByName = buildAnimationNodesByName(animations, nodesByName)

  const meshes: Mesh[] = []
  const bindingsByMesh = new Map<Object3D, CompiledInteractionBinding>()
  const bindingDepthByMesh = new Map<Object3D, number>()
  const fallbackHitboxes: CockpitInteractionFallbackHitbox[] = []
  const seen = new Set<string>()
  for (const binding of bindings) {
    const node = resolveCockpitInteractionNode(binding, nodesByName, animationNodesByName)
    if (node == null) {
      continue
    }
    const key = `${binding.target}\n${node.uuid}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    const nodeMeshes = collectRenderableMeshDescendants(node)
    if (nodeMeshes.length === 0) {
      fallbackHitboxes.push({
        binding,
        sourceNode: node,
        box: createCockpitInteractionFallbackBox(node)
      })
      continue
    }

    for (const mesh of nodeMeshes) {
      const depth = getObjectDepthFromAncestor(mesh, node)
      const previousDepth = bindingDepthByMesh.get(mesh)
      if (previousDepth != null && previousDepth <= depth) {
        continue
      }
      if (previousDepth == null) {
        meshes.push(mesh)
      }
      bindingsByMesh.set(mesh, binding)
      bindingDepthByMesh.set(mesh, depth)
    }
  }

  const blockerMeshes: Mesh[] = []
  const blockersByMesh = new Map<Object3D, CompiledInteractionBlocker>()
  const blockerDepthByMesh = new Map<Object3D, number>()
  const blockerHitboxes: CockpitInteractionBlockerHitbox[] = []
  const seenBlockers = new Set<string>()
  for (const blocker of blockers) {
    const node = resolveCockpitInteractionNode(blocker, nodesByName, animationNodesByName)
    if (node == null) {
      continue
    }
    const key = `${blocker.target}\n${node.uuid}`
    if (seenBlockers.has(key)) {
      continue
    }
    seenBlockers.add(key)

    const nodeMeshes = collectRenderableMeshDescendants(node)
    if (nodeMeshes.length === 0) {
      blockerHitboxes.push({
        blocker,
        sourceNode: node,
        box: createCockpitInteractionFallbackBox(node)
      })
      continue
    }

    for (const mesh of nodeMeshes) {
      const depth = getObjectDepthFromAncestor(mesh, node)
      const previousDepth = blockerDepthByMesh.get(mesh)
      if (previousDepth != null && previousDepth <= depth) {
        continue
      }
      if (previousDepth == null) {
        blockerMeshes.push(mesh)
      }
      blockersByMesh.set(mesh, blocker)
      blockerDepthByMesh.set(mesh, depth)
    }
  }

  const interactiveMeshSet = new Set([...meshes, ...blockerMeshes])
  const occluderMeshes: Mesh[] = []
  root.traverse(node => {
    if (!isRenderableMesh(node) || interactiveMeshSet.has(node) || !isCockpitInteractionOccluderMesh(node)) {
      return
    }
    occluderMeshes.push(node)
  })

  return {
    meshes,
    bindingsByMesh,
    fallbackHitboxes,
    blockerMeshes,
    blockersByMesh,
    blockerHitboxes,
    occluderMeshes
  }
}

function resolveCockpitInteractionNode(
  binding: CompiledInteractionBinding | CompiledInteractionBlocker,
  nodesByName: ReadonlyMap<string, Object3D>,
  animationNodesByName: ReadonlyMap<string, readonly Object3D[]>
): Object3D | null {
  for (const name of [binding.target, ...binding.feedbackTargets]) {
    const trimmedName = name.trim()
    if (!trimmedName) {
      continue
    }
    const node =
      nodesByName.get(trimmedName) ??
      nodesByName.get(trimmedName.toLowerCase())
    if (node != null) {
      return node
    }
    const animatedNodes =
      animationNodesByName.get(trimmedName) ??
      animationNodesByName.get(trimmedName.toLowerCase())
    if (animatedNodes != null) {
      const renderableNode = animatedNodes.find(candidate => collectRenderableMeshDescendants(candidate).length > 0)
      return renderableNode ?? animatedNodes[0] ?? null
    }
  }
  return null
}

function buildAnimationNodesByName(
  animations: readonly AnimationClip[],
  nodesByName: ReadonlyMap<string, Object3D>
): ReadonlyMap<string, readonly Object3D[]> {
  const animationNodesByName = new Map<string, Object3D[]>()
  for (const animation of animations) {
    const nodes: Object3D[] = []
    const seenNodes = new Set<string>()
    for (const track of animation.tracks) {
      const trackTarget = PropertyBinding.parseTrackName(track.name).nodeName
      const node = nodesByName.get(trackTarget) ?? nodesByName.get(trackTarget.toLowerCase())
      if (node == null || seenNodes.has(node.uuid)) {
        continue
      }
      seenNodes.add(node.uuid)
      nodes.push(node)
    }
    if (nodes.length === 0) {
      continue
    }
    animationNodesByName.set(animation.name, nodes)
    animationNodesByName.set(animation.name.toLowerCase(), nodes)
  }
  return animationNodesByName
}

function collectRenderableMeshDescendants(node: Object3D): Mesh[] {
  const meshes: Mesh[] = []
  node.traverse(descendant => {
    if (!isRenderableMesh(descendant)) {
      return
    }
    meshes.push(descendant)
  })
  return meshes
}

function isRenderableMesh(object: Object3D): object is Mesh {
  const maybeMesh = object as Mesh
  return maybeMesh.isMesh === true && maybeMesh.geometry != null && object.visible
}

function isCockpitInteractionOccluderMesh(mesh: Mesh): boolean {
  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : mesh.material != null
      ? [mesh.material]
      : []
  if (materials.length === 0) {
    return true
  }

  return materials.some(material => {
    const materialRecord = material as Material & { readonly colorWrite?: boolean; readonly depthWrite?: boolean }
    if (material.visible === false || materialRecord.colorWrite === false) {
      return false
    }
    if (material.transparent && material.opacity <= 0.05) {
      return false
    }
    if (material.transparent && materialRecord.depthWrite === false) {
      return false
    }
    return true
  })
}

function getObjectDepthFromAncestor(object: Object3D, ancestor: Object3D): number {
  let depth = 0
  let current: Object3D | null = object
  while (current != null && current !== ancestor) {
    depth += 1
    current = current.parent
  }
  return current === ancestor ? depth : -1
}

function createCockpitInteractionFallbackBox(node: Object3D): Box3 {
  const center = node.getWorldPosition(new Vector3())
  const halfSize = 0.015
  return new Box3(
    new Vector3(center.x - halfSize, center.y - halfSize, center.z - halfSize),
    new Vector3(center.x + halfSize, center.y + halfSize, center.z + halfSize)
  )
}

function installCockpitCameraShortcut(
  domElement: HTMLElement,
  camera: PerspectiveCamera,
  controls: OrbitControls,
  aircraftRoot: Group,
  exteriorScene: Object3D,
  getCockpitCameraClipPlanes: () => CameraClipPlanes,
  refreshCockpitCameraClipPlanes: () => void,
  aircraft: ImportedAircraft,
  onEnterCockpit?: () => void,
  onExitCockpit?: () => void,
  onToggleCockpitView?: (mode: 'enter' | 'exit', source: CockpitViewToggleSource) => void,
  onCockpitPress?: (
    event: MouseEvent | PointerEvent,
    options: { readonly holdFeedback: boolean }
  ) => CompiledInteractionBinding | null,
  onCockpitDrag?: (
    binding: CompiledInteractionBinding | null,
    options: {
      readonly relativeX: number
      readonly relativeY: number
      readonly relativeZ: number
      readonly dragPercent: number
    }
  ) => boolean,
  onCockpitRelease?: (
    binding: CompiledInteractionBinding | null,
    options?: { readonly unlock: boolean }
  ) => void
): CockpitCameraController {
  disposeCockpitCameraShortcut?.()
  disposeCockpitCameraShortcut = null

  const cockpitCamera = resolveCockpitCameraDefinition(aircraft)
  if (cockpitCamera == null) {
    return {
      isAvailable: () => false,
      dispose: () => {},
      isActive: () => false,
      update: () => {},
      enter: () => {},
      exit: () => {}
    }
  }

  const LOOK_RADIANS_PER_PIXEL = 0.003
  const MIN_PITCH_RADIANS = degreesToRadians(-89)
  const MAX_PITCH_RADIANS = degreesToRadians(89)
  const MIN_ZOOM = 0.5
  const MAX_ZOOM = 4
  const basePitchRadians = degreesToRadians(cockpitCamera.rotationPbhDegrees.x)
  const baseBankRadians = degreesToRadians(cockpitCamera.rotationPbhDegrees.y)
  const baseHeadingRadians = degreesToRadians(cockpitCamera.rotationPbhDegrees.z)
  let isCockpitViewActive = false
  let yawOffsetRadians = 0
  let pitchOffsetRadians = 0
  let cockpitZoom = camera.zoom
  let activePointerId: number | null = null
  let activePointerIsRightMouse = false
  let lastPointerX = 0
  let lastPointerY = 0
  let startPointerX = 0
  let startPointerY = 0
  let activeCockpitPressDragged = false
  let activeCockpitDragCallbackEmitted = false
  let activeCockpitPressBinding: CompiledInteractionBinding | null = null
  let exteriorCameraSnapshot: OrbitCameraSnapshot | null = null
  let exteriorVisibilityBeforeCockpit = exteriorScene.visible
  const previousTouchAction = domElement.style.touchAction

  const applyCockpitCamera = (options: { readonly refreshClipPlanes?: boolean } = {}): void => {
    if (!isCockpitViewActive) {
      return
    }

    const worldPosition = aircraftRoot.localToWorld(cockpitCamera.position.clone())
    const pitchRadians = Math.min(
      MAX_PITCH_RADIANS,
      Math.max(MIN_PITCH_RADIANS, basePitchRadians + pitchOffsetRadians)
    )
    const orientation = new Euler(
      pitchRadians,
      baseHeadingRadians + yawOffsetRadians,
      baseBankRadians,
      'YXZ'
    )
    const forward = new Vector3(0, 0, 1).applyEuler(orientation).normalize()
    const up = new Vector3(0, 1, 0).applyEuler(orientation).normalize()

    camera.position.copy(worldPosition)
    camera.up.copy(up)
    camera.zoom = cockpitZoom
    camera.lookAt(worldPosition.clone().add(forward))
    if (options.refreshClipPlanes === true) {
      refreshCockpitCameraClipPlanes()
    }
    const clipPlanes = getCockpitCameraClipPlanes()
    camera.near = clipPlanes.near
    camera.far = clipPlanes.far
    camera.updateProjectionMatrix()
  }

  const releasePointer = (): void => {
    if (activePointerId == null) {
      return
    }

    if (typeof domElement.releasePointerCapture === 'function') {
      try {
        domElement.releasePointerCapture(activePointerId)
      } catch {
        // Ignore pointer capture release failures when the pointer is already gone.
      }
    }
    activePointerId = null
    activePointerIsRightMouse = false
    activeCockpitPressDragged = false
    activeCockpitDragCallbackEmitted = false
  }

  const isSupportedCockpitPointerButton = (event: PointerEvent): boolean =>
    event.pointerType !== 'mouse' || event.button === 0 || event.button === 2

  const getPointerRelativeValues = (event: PointerEvent): {
    readonly relativeX: number
    readonly relativeY: number
    readonly relativeZ: number
    readonly dragPercent: number
  } => {
    const rect = domElement.getBoundingClientRect()
    const width = Math.max(rect.width, 1)
    const height = Math.max(rect.height, 1)
    const relativeX = Math.min(1, Math.max(0, (event.clientX - rect.left) / width))
    const relativeY = Math.min(1, Math.max(0, (event.clientY - rect.top) / height))
    const dragPercent = Math.min(
      1,
      Math.max(
        0,
        Math.max(
          Math.abs(event.clientX - startPointerX) / width,
          Math.abs(event.clientY - startPointerY) / height
        )
      )
    )
    return {
      relativeX,
      relativeY,
      relativeZ: 0,
      dragPercent
    }
  }

  const exitCockpitView = (source: CockpitViewToggleSource = 'keyboard'): void => {
    if (!isCockpitViewActive) {
      return
    }

    onToggleCockpitView?.('exit', source)
    releasePointer()
    isCockpitViewActive = false
    domElement.style.touchAction = previousTouchAction
    controls.enabled = true
    exteriorScene.visible = exteriorVisibilityBeforeCockpit

    if (exteriorCameraSnapshot == null) {
      return
    }

    camera.position.copy(exteriorCameraSnapshot.position)
    camera.up.copy(exteriorCameraSnapshot.up)
    camera.zoom = exteriorCameraSnapshot.zoom
    controls.target.copy(exteriorCameraSnapshot.target)
    camera.updateProjectionMatrix()
    controls.update()
    onExitCockpit?.()
  }

  const enterCockpitView = (source: CockpitViewToggleSource = 'keyboard'): void => {
    if (isCockpitViewActive) {
      return
    }

    onToggleCockpitView?.('enter', source)
    exteriorCameraSnapshot = {
      position: camera.position.clone(),
      target: controls.target.clone(),
      up: camera.up.clone(),
      zoom: camera.zoom
    }
    exteriorVisibilityBeforeCockpit = exteriorScene.visible
    isCockpitViewActive = true
    yawOffsetRadians = 0
    pitchOffsetRadians = 0
    cockpitZoom = camera.zoom
    domElement.style.touchAction = 'none'
    controls.enabled = false
    exteriorScene.visible = false
    applyCockpitCamera({ refreshClipPlanes: true })
    onEnterCockpit?.()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.code !== 'KeyC' || shouldIgnoreKeyboardShortcut(event)) {
      return
    }

    if (isCockpitViewActive) {
      exitCockpitView('keyboard')
    } else {
      enterCockpitView('keyboard')
    }
    event.preventDefault()
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!isCockpitViewActive) {
      return
    }
    if (!isSupportedCockpitPointerButton(event)) {
      return
    }

    activePointerId = event.pointerId
    activePointerIsRightMouse = event.pointerType === 'mouse' && event.button === 2
    lastPointerX = event.clientX
    lastPointerY = event.clientY
    startPointerX = event.clientX
    startPointerY = event.clientY
    activeCockpitPressDragged = false
    activeCockpitDragCallbackEmitted = false
    activeCockpitPressBinding = onCockpitPress?.(event, { holdFeedback: true }) ?? null
    domElement.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (!isCockpitViewActive || activePointerId !== event.pointerId) {
      return
    }

    const deltaX = event.clientX - lastPointerX
    const deltaY = event.clientY - lastPointerY
    lastPointerX = event.clientX
    lastPointerY = event.clientY
    if (activeCockpitPressBinding != null) {
      const movedFarEnough = Math.hypot(event.clientX - startPointerX, event.clientY - startPointerY) >= 2
      if (movedFarEnough) {
        activeCockpitPressDragged = true
      }
      if (activePointerIsRightMouse && activeCockpitPressDragged) {
        activeCockpitDragCallbackEmitted =
          onCockpitDrag?.(activeCockpitPressBinding, getPointerRelativeValues(event)) === true ||
          activeCockpitDragCallbackEmitted
      }
      event.preventDefault()
      return
    }

    yawOffsetRadians += deltaX * LOOK_RADIANS_PER_PIXEL
    const nextPitchRadians = basePitchRadians + pitchOffsetRadians - deltaY * LOOK_RADIANS_PER_PIXEL
    pitchOffsetRadians = Math.min(
      MAX_PITCH_RADIANS,
      Math.max(MIN_PITCH_RADIANS, nextPitchRadians)
    ) - basePitchRadians
    applyCockpitCamera()
    event.preventDefault()
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (activePointerId !== event.pointerId) {
      return
    }

    onCockpitRelease?.(activeCockpitPressBinding, { unlock: activeCockpitDragCallbackEmitted })
    activeCockpitPressBinding = null
    releasePointer()
    event.preventDefault()
  }

  const onContextMenu = (event: MouseEvent): void => {
    if (!isCockpitViewActive) {
      return
    }
    event.preventDefault()
  }

  const onWheel = (event: WheelEvent): void => {
    if (!isCockpitViewActive) {
      return
    }

    cockpitZoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, cockpitZoom * Math.exp(-event.deltaY * 0.0015))
    )
    applyCockpitCamera()
    event.preventDefault()
  }

  window.addEventListener('keydown', onKeyDown)
  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointermove', onPointerMove)
  domElement.addEventListener('pointerup', onPointerUp)
  domElement.addEventListener('pointercancel', onPointerUp)
  domElement.addEventListener('contextmenu', onContextMenu)
  domElement.addEventListener('wheel', onWheel, { passive: false })
  disposeCockpitCameraShortcut = () => {
    exitCockpitView()
    window.removeEventListener('keydown', onKeyDown)
    domElement.removeEventListener('pointerdown', onPointerDown)
    domElement.removeEventListener('pointermove', onPointerMove)
    domElement.removeEventListener('pointerup', onPointerUp)
    domElement.removeEventListener('pointercancel', onPointerUp)
    domElement.removeEventListener('contextmenu', onContextMenu)
    domElement.removeEventListener('wheel', onWheel)
  }

  return {
    isAvailable: () => true,
    dispose: () => {
      disposeCockpitCameraShortcut?.()
      disposeCockpitCameraShortcut = null
    },
    isActive: () => isCockpitViewActive,
    update: applyCockpitCamera,
    enter: source => enterCockpitView(source ?? 'benchmark'),
    exit: source => exitCockpitView(source ?? 'benchmark')
  }
}

function resolveCockpitCameraDefinition(
  aircraft: ImportedAircraft
): CockpitCameraDefinition | null {
  const camerasCfg = aircraft.cfgFiles.find(file => file.kind === 'cameras')
  if (camerasCfg == null) {
    return null
  }

  const viewsSection = camerasCfg.sections.find(section => section.name.toLowerCase() === 'views')
  const eyepoint = parseNumericTriple(viewsSection?.values.get('eyepoint')) ?? [0, 0, 0]

  const cameraSections = parseCameraSections(camerasCfg.sections)

  const selectedCamera = [...cameraSections]
    .filter(isSupportedCockpitCameraSection)
    .sort((left, right) => {
      const scoreDelta =
        getCockpitCameraSectionScore(right) - getCockpitCameraSectionScore(left)
      if (scoreDelta !== 0) {
        return scoreDelta
      }

      return left.declarationIndex - right.declarationIndex
    })[0] ?? null

  if (selectedCamera == null) {
    return null
  }

  const localPosition = getCameraOriginBasePosition(selectedCamera.origin, eyepoint).add(
    convertCameraOffsetToLocalPosition(selectedCamera.initialXyz)
  )
  const [pitchDegrees, bankDegrees, headingDegrees] = selectedCamera.initialPbh

  return {
    position: localPosition,
    rotationPbhDegrees: new Vector3(
      pitchDegrees,
      selectedCamera.origin === 'cockpit' ? 0 : bankDegrees,
      headingDegrees
    )
  }
}

function resolveExternalAircraftCameraDefinition(
  aircraft: ImportedAircraft
): ExternalAircraftCameraDefinition | null {
  const camerasCfg = aircraft.cfgFiles.find(file => file.kind === 'cameras')
  if (camerasCfg == null) {
    return null
  }

  const selectedCamera = parseCameraSections(camerasCfg.sections)
    .filter(isSupportedExternalAircraftCameraSection)
    .sort((left, right) => {
      const scoreDelta =
        getExternalAircraftCameraSectionScore(right) -
        getExternalAircraftCameraSectionScore(left)
      if (scoreDelta !== 0) {
        return scoreDelta
      }

      return left.declarationIndex - right.declarationIndex
    })[0] ?? null

  if (selectedCamera == null) {
    return null
  }

  return {
    positionOffset: convertCameraOffsetToLocalPosition(selectedCamera.initialXyz)
  }
}

function parseCameraSections(
  sections: readonly ImportedCfgSection[]
): ParsedCameraSection[] {
  return sections
    .filter(section => section.name.toLowerCase().startsWith('cameradefinition.'))
    .map((section, declarationIndex) => {
      const initialXyz = parseNumericTriple(section.values.get('initialxyz'))
      const initialPbh = parseNumericTriple(section.values.get('initialpbh'))
      if (initialXyz == null || initialPbh == null) {
        return null
      }

      return {
        declarationIndex,
        origin: normalizeCfgValue(section.values.get('origin')),
        category: normalizeCfgValue(section.values.get('category')),
        subCategory: normalizeCfgValue(section.values.get('subcategory')),
        subCategoryItem: normalizeCfgValue(section.values.get('subcategoryitem')),
        title: normalizeCfgValue(section.values.get('title')),
        initialXyz,
        initialPbh
      }
    })
    .filter((section): section is ParsedCameraSection => section != null)
}

function isSupportedCockpitCameraSection(section: ParsedCameraSection): boolean {
  if (section.category !== '' && section.category !== 'cockpit') {
    return false
  }

  return (
    section.origin === '' ||
    section.origin === 'virtual cockpit' ||
    section.origin === 'cockpit'
  )
}

function getCockpitCameraSectionScore(section: ParsedCameraSection): number {
  let score = 0

  if (section.origin === '' || section.origin === 'virtual cockpit') {
    score += 40
  } else if (section.origin === 'cockpit') {
    score += 30
  }

  if (section.category === 'cockpit') {
    score += 20
  }

  if (section.subCategory === 'pilot') {
    score += 120
  } else if (section.subCategory === '') {
    score += 5
  }

  switch (section.subCategoryItem) {
    case 'defaultpilot':
      score += 200
      break
    case 'closepilot':
      score += 150
      break
    case 'landingpilot':
      score += 140
      break
    case 'truecockpit':
      score += 80
      break
    case 'pilotvr':
      score -= 40
      break
    case 'copilot':
      score -= 160
      break
  }

  if (section.title.includes('copilot')) {
    score -= 120
  }
  if (section.title.includes('cabin') || section.title.includes('galley')) {
    score -= 200
  }

  return score
}

function isSupportedExternalAircraftCameraSection(section: ParsedCameraSection): boolean {
  return section.category === 'aircraft' && section.origin === 'center'
}

function getExternalAircraftCameraSectionScore(section: ParsedCameraSection): number {
  let score = 0

  if (section.title === 'default_chase') {
    score += 200
  } else if (section.title.includes('chase')) {
    score += 120
  }

  if (section.subCategory === '' || section.subCategory === 'none') {
    score += 20
  }
  if (section.subCategoryItem === '' || section.subCategoryItem === 'none') {
    score += 10
  }

  return score
}

function getCameraOriginBasePosition(
  origin: string,
  eyepoint: [number, number, number]
): Vector3 {
  if (origin === 'cockpit') {
    return new Vector3()
  }

  return convertEyepointToLocalPosition(eyepoint)
}

function convertEyepointToLocalPosition(eyepoint: [number, number, number]): Vector3 {
  const [longitudinalFeet, lateralFeet, verticalFeet] = eyepoint
  return new Vector3(
    -lateralFeet * FEET_TO_METERS,
    verticalFeet * FEET_TO_METERS,
    longitudinalFeet * FEET_TO_METERS
  )
}

function convertCameraOffsetToLocalPosition(offset: [number, number, number]): Vector3 {
  const [lateralMeters, verticalMeters, longitudinalMeters] = offset
  return new Vector3(-lateralMeters, verticalMeters, longitudinalMeters)
}

function parseNumericTriple(value: string | undefined): [number, number, number] | null {
  if (value == null) {
    return null
  }

  const parts = value
    .split(',')
    .map(part => Number.parseFloat(part.trim()))

  if (parts.length < 3 || parts.slice(0, 3).some(part => Number.isNaN(part))) {
    return null
  }

  return [parts[0]!, parts[1]!, parts[2]!]
}

function normalizeCfgValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function shouldIgnoreKeyboardShortcut(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return true
  }

  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180
}

function computeApproximateBounds(object: Group): Box3 {
  const bounds = new Box3().makeEmpty()
  object.updateWorldMatrix(true, true)

  object.traverse(node => {
    if (!(node instanceof Mesh)) {
      return
    }

    const geometry = node.geometry
    if (geometry == null) {
      return
    }

    if (geometry.boundingBox == null) {
      geometry.computeBoundingBox()
    }

    if (geometry.boundingBox == null) {
      return
    }

    bounds.union(geometry.boundingBox.clone().applyMatrix4(node.matrixWorld))
  })

  return bounds
}

function computeCockpitCameraFarPlane(camera: PerspectiveCamera, interior: Object3D): number {
  const bounds = computeApproximateBounds(interior as Group)
  if (bounds.isEmpty()) {
    return COCKPIT_CAMERA_DEFAULT_CLIP_FAR
  }

  camera.updateMatrixWorld()
  const cameraPosition = new Vector3().setFromMatrixPosition(camera.matrixWorld)
  let farthestDistance = 0
  forEachBoxCorner(bounds, new Vector3(), corner => {
    farthestDistance = Math.max(farthestDistance, cameraPosition.distanceTo(corner))
  })

  return Math.max(COCKPIT_CAMERA_MIN_CLIP_FAR, farthestDistance + COCKPIT_CAMERA_CLIP_FAR_PADDING)
}

type SceneResourceIndex = {
  readonly geometries: Set<NonNullable<Mesh['geometry']>>
  readonly materials: Set<Material>
  readonly textures: Set<Texture>
}

function disposeDetachedSceneResources(detachedRoot: Object3D, retainedRoot: Object3D): void {
  const retainedResources = collectSceneResources(retainedRoot)
  const detachedResources = collectSceneResources(detachedRoot)

  for (const geometry of detachedResources.geometries) {
    if (!retainedResources.geometries.has(geometry)) {
      geometry.dispose()
    }
  }

  for (const material of detachedResources.materials) {
    if (!retainedResources.materials.has(material)) {
      material.dispose()
    }
  }

  for (const texture of detachedResources.textures) {
    if (!retainedResources.textures.has(texture)) {
      texture.dispose()
    }
  }
}

function collectSceneResources(root: Object3D): SceneResourceIndex {
  const geometries = new Set<NonNullable<Mesh['geometry']>>()
  const materials = new Set<Material>()
  const textures = new Set<Texture>()

  root.traverse(node => {
    if (!(node instanceof Mesh)) {
      return
    }

    if (node.geometry != null) {
      geometries.add(node.geometry)
    }

    const nodeMaterials = Array.isArray(node.material)
      ? node.material
      : node.material != null
        ? [node.material]
        : []

    for (const material of nodeMaterials) {
      if (material == null) {
        continue
      }

      materials.add(material)
      collectMaterialTextures(material, textures)
    }
  })

  return {
    geometries,
    materials,
    textures
  }
}

function collectMaterialTextures(material: Material, textures: Set<Texture>): void {
  const collectValue = (value: unknown): void => {
    if (value instanceof Texture) {
      textures.add(value)
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectValue(item)
      }
      return
    }

    if (value != null && typeof value === 'object' && 'value' in value) {
      collectValue((value as { readonly value: unknown }).value)
    }
  }

  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    collectValue(value)
  }

  const uniforms = (material as { readonly uniforms?: Record<string, { readonly value: unknown }> })
    .uniforms
  if (uniforms == null) {
    return
  }

  for (const uniform of Object.values(uniforms)) {
    collectValue(uniform?.value)
  }
}

type RendererCompileAsync = (
  object: Object3D,
  camera: PerspectiveCamera,
  targetScene?: Scene | null
) => Promise<unknown>

function getRendererCompileAsync(renderer: AppRenderer): RendererCompileAsync | null {
  const compileAsync = (renderer as { readonly compileAsync?: unknown }).compileAsync
  return typeof compileAsync === 'function'
    ? (compileAsync.bind(renderer) as RendererCompileAsync)
    : null
}

function createFpsCounter(): FpsCounter {
  const frameTimesMs: number[] = []
  const maxSamples = 120
  let totalFrameMs = 0

  return {
    recordFrame: deltaSeconds => {
      if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
        return
      }

      const frameMs = Math.min(1_000, deltaSeconds * 1_000)
      frameTimesMs.push(frameMs)
      totalFrameMs += frameMs
      while (frameTimesMs.length > maxSamples) {
        totalFrameMs -= frameTimesMs.shift() ?? 0
      }
    },
    getSnapshot: () => {
      if (frameTimesMs.length === 0) {
        return {
          fps: 0,
          averageFrameMs: 0,
          lowFps: 0,
          sampleCount: 0
        }
      }

      const averageFrameMs = totalFrameMs / frameTimesMs.length
      const worstFrameMs = Math.max(...frameTimesMs)
      return {
        fps: 1_000 / averageFrameMs,
        averageFrameMs,
        lowFps: 1_000 / worstFrameMs,
        sampleCount: frameTimesMs.length
      }
    }
  }
}

function formatFpsCounter(snapshot: FpsCounterSnapshot): string {
  if (snapshot.sampleCount === 0) {
    return 'warming up'
  }

  return [
    `${snapshot.fps.toFixed(1)} fps`,
    `${snapshot.averageFrameMs.toFixed(1)} ms`,
    `low ${snapshot.lowFps.toFixed(1)}`
  ].join(' / ')
}

function createOverlay(): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.style.position = 'fixed'
  overlay.style.top = '16px'
  overlay.style.left = '16px'
  overlay.style.maxWidth = '340px'
  overlay.style.maxHeight = 'calc(100vh - 32px)'
  overlay.style.overflow = 'hidden'
  overlay.style.padding = '12px 14px'
  overlay.style.borderRadius = '14px'
  overlay.style.background = 'rgba(15, 23, 32, 0.78)'
  overlay.style.backdropFilter = 'blur(10px)'
  overlay.style.color = '#f3f7fb'
  overlay.style.font = '12px/1.45 "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
  overlay.style.boxShadow = '0 12px 36px rgba(0, 0, 0, 0.18)'
  overlay.style.pointerEvents = 'none'
  overlay.style.whiteSpace = 'pre-wrap'
  return overlay
}

function createAircraftSelector(
  options: readonly AircraftSelectorOption[],
  selectedPackageRoot: string,
  selectedAircraft: ImportedAircraft
): HTMLDivElement | null {
  if (options.length <= 1) {
    return null
  }

  const wrapper = document.createElement('div')
  wrapper.style.position = 'fixed'
  wrapper.style.top = '16px'
  wrapper.style.right = '16px'
  wrapper.style.padding = '10px 12px'
  wrapper.style.borderRadius = '12px'
  wrapper.style.background = 'rgba(15, 23, 32, 0.78)'
  wrapper.style.backdropFilter = 'blur(10px)'
  wrapper.style.color = '#f3f7fb'
  wrapper.style.font = '12px/1.35 "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
  wrapper.style.boxShadow = '0 12px 36px rgba(0, 0, 0, 0.18)'
  wrapper.style.pointerEvents = 'auto'

  const label = document.createElement('label')
  label.textContent = 'Variation'
  label.style.display = 'block'
  label.style.marginBottom = '6px'
  label.style.fontWeight = '600'

  const select = document.createElement('select')
  select.style.minWidth = '260px'
  select.style.padding = '6px 8px'
  select.style.border = '1px solid rgba(255, 255, 255, 0.14)'
  select.style.borderRadius = '8px'
  select.style.background = 'rgba(9, 14, 20, 0.9)'
  select.style.color = '#f3f7fb'
  select.style.font = 'inherit'

  const selectedValue = createAircraftSelectorValue(selectedPackageRoot, selectedAircraft.id)
  const sortedOptions = [...options].sort((left, right) =>
    getAircraftSelectorDisplayName(left).localeCompare(getAircraftSelectorDisplayName(right))
  )
  for (const candidate of sortedOptions) {
    const option = document.createElement('option')
    option.value = createAircraftSelectorValue(candidate.packageRoot, candidate.aircraft.id)
    option.textContent = getAircraftSelectorDisplayName(candidate)
    option.selected = option.value === selectedValue
    select.appendChild(option)
  }

  select.addEventListener('change', () => {
    const selectedOption = options.find(
      candidate => createAircraftSelectorValue(candidate.packageRoot, candidate.aircraft.id) === select.value
    )
    if (selectedOption == null) {
      return
    }

    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('package', selectedOption.packageRoot)
    nextUrl.searchParams.set('aircraft', selectedOption.aircraft.id)
    window.location.assign(nextUrl.toString())
  })

  wrapper.append(label, select)
  return wrapper
}

type SettingsProfileEditor = {
  readonly root: HTMLDivElement
  readonly readProfile: () => ViewerConfigProfile
  readonly refreshForSelectedAircraft: () => void
  readonly setProfile: (profile: ViewerConfigProfile) => void
}

function createSettingsPanel(options: {
  readonly selectorOptions: readonly AircraftSelectorOption[]
  readonly packageRoot: string
  readonly aircraft: ImportedAircraft
  readonly configStore: ViewerConfigStore
  readonly effectiveSearchParams: URLSearchParams
  readonly onApply?: (
    event: ViewerSettingsApplyEvent
  ) => Promise<string | null> | string | null
}): HTMLDivElement {
  const root = document.createElement('div')
  root.style.position = 'fixed'
  root.style.right = '16px'
  root.style.bottom = '16px'
  root.style.zIndex = '20'
  root.style.font = '12px/1.35 "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace'
  root.style.color = '#f3f7fb'
  root.style.pointerEvents = 'auto'

  const toggleButton = document.createElement('button')
  toggleButton.type = 'button'
  toggleButton.textContent = 'Settings'
  stylePanelButton(toggleButton)

  const drawer = document.createElement('div')
  drawer.hidden = true
  drawer.style.width = 'min(560px, calc(100vw - 32px))'
  drawer.style.maxHeight = 'calc(100vh - 88px)'
  drawer.style.overflow = 'auto'
  drawer.style.marginBottom = '10px'
  drawer.style.padding = '14px'
  drawer.style.borderRadius = '12px'
  drawer.style.background = 'rgba(15, 23, 32, 0.92)'
  drawer.style.backdropFilter = 'blur(12px)'
  drawer.style.boxShadow = '0 18px 48px rgba(0, 0, 0, 0.28)'

  toggleButton.addEventListener('click', () => {
    drawer.hidden = !drawer.hidden
  })

  const heading = document.createElement('div')
  heading.textContent = 'Viewer Settings'
  heading.style.fontWeight = '700'
  heading.style.fontSize = '13px'
  heading.style.marginBottom = '10px'

  const selectedValue = createAircraftSelectorValue(options.packageRoot, options.aircraft.id)
  const sortedOptions = [...options.selectorOptions].sort((left, right) =>
    getAircraftSelectorDisplayName(left).localeCompare(getAircraftSelectorDisplayName(right))
  )
  const fallbackOption = sortedOptions.find(
    option => createAircraftSelectorValue(option.packageRoot, option.aircraft.id) === selectedValue
  ) ?? {
    packageRoot: options.packageRoot,
    packageName: '',
    aircraft: options.aircraft
  }

  const aircraftSelect = createSettingsSelect('Aircraft')
  for (const option of sortedOptions) {
    const element = document.createElement('option')
    element.value = createAircraftSelectorValue(option.packageRoot, option.aircraft.id)
    element.textContent = getAircraftSelectorDisplayName(option)
    element.selected = element.value === selectedValue
    aircraftSelect.appendChild(element)
  }
  if (aircraftSelect.selectedIndex < 0) {
    aircraftSelect.value = createAircraftSelectorValue(
      fallbackOption.packageRoot,
      fallbackOption.aircraft.id
    )
  }

  const getSelectedAircraftOption = (): AircraftSelectorOption => {
    return sortedOptions.find(
      option => createAircraftSelectorValue(option.packageRoot, option.aircraft.id) === aircraftSelect.value
    ) ?? fallbackOption
  }

  const globalEditor = createSettingsProfileEditor({
    title: 'Global',
    scope: 'global',
    getSelectedOption: getSelectedAircraftOption,
    initialProfile: options.configStore.global
  })
  const aircraftEditor = createSettingsProfileEditor({
    title: 'Aircraft',
    scope: 'aircraft',
    getSelectedOption: getSelectedAircraftOption,
    initialProfile:
      options.configStore.aircraft[
        getViewerAircraftConfigKey(options.packageRoot, options.aircraft.id)
      ] ?? {}
  })

  aircraftSelect.addEventListener('change', () => {
    const selectedOption = getSelectedAircraftOption()
    globalEditor.refreshForSelectedAircraft()
    aircraftEditor.setProfile(
      loadViewerConfigStore().aircraft[
        getViewerAircraftConfigKey(selectedOption.packageRoot, selectedOption.aircraft.id)
      ] ?? {}
    )
  })

  const status = document.createElement('div')
  status.style.minHeight = '16px'
  status.style.marginTop = '10px'
  status.style.color = 'rgba(243, 247, 251, 0.72)'

  const applyGlobalProfile = (): void => {
    const nextStore = loadViewerConfigStore()
    saveViewerConfigStore({
      ...nextStore,
      global: globalEditor.readProfile()
    })
  }

  const applyAircraftProfile = (): void => {
    const selectedOption = getSelectedAircraftOption()
    const nextStore = loadViewerConfigStore()
    saveViewerConfigStore({
      ...nextStore,
      aircraft: {
        ...nextStore.aircraft,
        [getViewerAircraftConfigKey(selectedOption.packageRoot, selectedOption.aircraft.id)]:
          aircraftEditor.readProfile()
      }
    })
  }

  const resetGlobalProfile = (): void => {
    const nextStore = loadViewerConfigStore()
    saveViewerConfigStore({
      ...nextStore,
      global: {}
    })
    globalEditor.setProfile({})
  }

  const resetAircraftProfile = (): void => {
    const selectedOption = getSelectedAircraftOption()
    const nextStore = loadViewerConfigStore()
    const aircraftProfiles = { ...nextStore.aircraft }
    delete aircraftProfiles[
      getViewerAircraftConfigKey(selectedOption.packageRoot, selectedOption.aircraft.id)
    ]
    saveViewerConfigStore({
      ...nextStore,
      aircraft: aircraftProfiles
    })
    aircraftEditor.setProfile({})
  }

  const tabs = document.createElement('div')
  tabs.style.display = 'flex'
  tabs.style.alignItems = 'end'
  tabs.style.gap = '8px'
  tabs.style.marginBottom = '12px'

  const globalTab = createSettingsTabButton('Global')
  const aircraftTab = createSettingsTabButton('Aircraft')
  tabs.append(globalTab, aircraftTab)

  let activePanel: 'global' | 'aircraft' = 'global'
  const setActivePanel = (nextActivePanel: 'global' | 'aircraft'): void => {
    activePanel = nextActivePanel
    const activeGlobal = nextActivePanel === 'global'
    globalEditor.root.hidden = !activeGlobal
    aircraftEditor.root.hidden = activeGlobal
    globalTab.setAttribute('aria-selected', activeGlobal ? 'true' : 'false')
    aircraftTab.setAttribute('aria-selected', activeGlobal ? 'false' : 'true')
    styleSettingsTabButton(globalTab, activeGlobal)
    styleSettingsTabButton(aircraftTab, !activeGlobal)
  }

  globalTab.addEventListener('click', () => setActivePanel('global'))
  aircraftTab.addEventListener('click', () => setActivePanel('aircraft'))
  setActivePanel('global')

  const aircraftField = createSettingsField('Aircraft', aircraftSelect)
  aircraftField.style.marginBottom = '12px'

  const applyButton = createActionButton('Apply')
  const resetButton = createActionButton('Reset')
  const notifyApplied = async (action: ViewerSettingsApplyEvent['action']): Promise<void> => {
    const selectedOption = getSelectedAircraftOption()
    const message = await options.onApply?.({
      scope: activePanel,
      action,
      selectedPackageRoot: selectedOption.packageRoot,
      selectedAircraftId: selectedOption.aircraft.id
    })
    if (message != null && message !== '') {
      status.textContent = message
    }
  }

  applyButton.addEventListener('click', () => {
    void (async () => {
      applyButton.disabled = true
      resetButton.disabled = true
      try {
        if (activePanel === 'global') {
          applyGlobalProfile()
          status.textContent = 'Saved global defaults.'
        } else {
          applyAircraftProfile()
          status.textContent = 'Saved aircraft profile.'
        }
        await notifyApplied('apply')
      } finally {
        applyButton.disabled = false
        resetButton.disabled = false
      }
    })()
  })
  resetButton.addEventListener('click', () => {
    void (async () => {
      applyButton.disabled = true
      resetButton.disabled = true
      try {
        if (activePanel === 'global') {
          resetGlobalProfile()
          status.textContent = 'Cleared global defaults.'
        } else {
          resetAircraftProfile()
          status.textContent = 'Cleared aircraft profile.'
        }
        await notifyApplied('reset')
      } finally {
        applyButton.disabled = false
        resetButton.disabled = false
      }
    })()
  })

  const actions = document.createElement('div')
  actions.style.display = 'grid'
  actions.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))'
  actions.style.gap = '8px'
  actions.style.marginTop = '12px'
  actions.append(applyButton, resetButton)

  drawer.append(
    heading,
    aircraftField,
    tabs,
    globalEditor.root,
    aircraftEditor.root,
    actions,
    status
  )
  root.append(drawer, toggleButton)
  return root
}

function createSettingsProfileEditor(options: {
  readonly title: string
  readonly scope: 'global' | 'aircraft'
  readonly getSelectedOption: () => AircraftSelectorOption
  readonly initialProfile: ViewerConfigProfile
}): SettingsProfileEditor {
  const root = document.createElement('div')
  root.style.minWidth = '0'
  root.style.paddingTop = '2px'
  root.setAttribute('aria-label', `${options.title} settings`)
  const inheritsFromGlobal = options.scope === 'aircraft'

  const form = document.createElement('form')
  form.addEventListener('submit', event => event.preventDefault())

  const exteriorLodSelect = createSettingsSelect('Exterior LOD')
  const interiorLodSelect = createSettingsSelect('Interior LOD')
  const exteriorInteriorModeSelect = createSettingsSelect('Exterior Interior')
  const exteriorInteriorLodSelect = createSettingsSelect('Exterior Interior LOD')
  const vcockpitSurfacesSelect = createSettingsSelect('VCockpit Surfaces')
  const vcockpitLiveSelect = createSettingsSelect('Live Gauges')
  const vcockpitGaugeModeSelect = createSettingsSelect('Gauge Mode')
  const cockpitTexturesSelect = createSettingsSelect('Cockpit Textures')
  const cockpitTextureSizeInput = createSettingsInput('Cockpit Texture Size', 'number')
  const vcockpitCaptureFpsInput = createSettingsInput('Gauge Capture FPS', 'number')
  const vcockpitRasterScaleInput = createSettingsInput('Gauge Raster Scale', 'number')
  const vcockpitGaugeUpdateOutsideSelect = createSettingsSelect('Gauge Updates Outside')
  const cockpitMergeSelect = createSettingsSelect('Cockpit Merge Static')
  const cockpitInstanceSelect = createSettingsSelect('Cockpit Instance Static')
  const cockpitPerfSelect = createSettingsSelect('Cockpit Perf')
  const cockpitInteractionHitboxesSelect = createSettingsSelect('Interaction Hitboxes')
  const skipGaugeSettingSeedSelect = createSettingsSelect('Seed Nothing')
  const rendererPixelRatioInput = createSettingsInput('Renderer Pixel Ratio', 'number')
  const rawQueryTextarea = createSettingsTextarea('Extra Query')

  const appendGlobalOption = (select: HTMLSelectElement): void => {
    if (inheritsFromGlobal) {
      select.append(createSettingsOption('global', 'Global'))
    }
  }

  appendGlobalOption(exteriorInteriorModeSelect)
  exteriorInteriorModeSelect.append(
    createSettingsOption('deferred', 'Deferred auto'),
    createSettingsOption('sync', 'Sync at load'),
    createSettingsOption('off', 'Off')
  )
  appendGlobalOption(vcockpitSurfacesSelect)
  vcockpitSurfacesSelect.append(
    createSettingsOption('on', 'On'),
    createSettingsOption('off', 'Off')
  )
  appendGlobalOption(vcockpitLiveSelect)
  vcockpitLiveSelect.append(
    createSettingsOption('on', 'On'),
    createSettingsOption('off', 'Off')
  )
  appendGlobalOption(vcockpitGaugeModeSelect)
  vcockpitGaugeModeSelect.append(
    createSettingsOption('texture', 'Texture'),
    createSettingsOption('overlay', 'Overlay'),
    createSettingsOption('video', 'Video')
  )
  appendGlobalOption(cockpitTexturesSelect)
  cockpitTexturesSelect.append(
    createSettingsOption('range-low', 'Range low'),
    createSettingsOption('full', 'Full')
  )
  for (const select of [
    cockpitMergeSelect,
    cockpitInstanceSelect,
    cockpitPerfSelect,
    cockpitInteractionHitboxesSelect,
    skipGaugeSettingSeedSelect,
    vcockpitGaugeUpdateOutsideSelect
  ]) {
    appendGlobalOption(select)
    select.append(createSettingsOption('off', 'Off'), createSettingsOption('on', 'On'))
  }

  const refreshLodOptions = (
    lod: number | null | undefined,
    interiorLod: number | null | undefined,
    exteriorInteriorLod: number | null | undefined
  ): void => {
    const selectedOption = options.getSelectedOption()
    replaceLodSelectOptions(
      exteriorLodSelect,
      selectedOption.aircraft.model?.lods.length ?? 0,
      0,
      lod,
      inheritsFromGlobal
    )
    replaceLodSelectOptions(
      interiorLodSelect,
      selectedOption.aircraft.interiorModel?.lods.length ?? 0,
      0,
      interiorLod,
      inheritsFromGlobal
    )
    replaceLodSelectOptions(
      exteriorInteriorLodSelect,
      selectedOption.aircraft.interiorModel?.lods.length ?? 0,
      selectedOption.aircraft.model?.modelOptions.withExteriorShowInteriorHideFirstLod === true
        ? 1
        : 0,
      exteriorInteriorLod,
      inheritsFromGlobal
    )
  }

  const setProfile = (profile: ViewerConfigProfile): void => {
    refreshLodOptions(profile.lod, profile.interiorLod, profile.exteriorInteriorLod)
    interiorLodSelect.value =
      profile.interiorLod === undefined && inheritsFromGlobal
        ? 'global'
        : profile.interiorLod == null ? 'auto' : String(profile.interiorLod)
    exteriorInteriorModeSelect.value =
      profile.exteriorInteriorMode ?? (inheritsFromGlobal ? 'global' : 'deferred')
    exteriorInteriorLodSelect.value =
      profile.exteriorInteriorLod === undefined && inheritsFromGlobal
        ? 'global'
        : profile.exteriorInteriorLod == null ? 'auto' : String(profile.exteriorInteriorLod)
    vcockpitSurfacesSelect.value = formatSettingsBooleanValue(
      profile.vcockpitSurfaces,
      inheritsFromGlobal
    )
    vcockpitLiveSelect.value = formatSettingsBooleanValue(
      profile.vcockpitLiveGauges,
      inheritsFromGlobal
    )
    vcockpitGaugeModeSelect.value =
      profile.vcockpitGaugeMode ?? (inheritsFromGlobal ? 'global' : 'texture')
    cockpitTexturesSelect.value =
      profile.cockpitTextures ?? (inheritsFromGlobal ? 'global' : 'range-low')
    cockpitTextureSizeInput.value =
      profile.cockpitTextureSize == null ? '' : String(profile.cockpitTextureSize)
    vcockpitCaptureFpsInput.value =
      profile.vcockpitGaugeCaptureFps == null ? '' : String(profile.vcockpitGaugeCaptureFps)
    vcockpitRasterScaleInput.value =
      profile.vcockpitGaugeRasterScale == null ? '' : String(profile.vcockpitGaugeRasterScale)
    vcockpitGaugeUpdateOutsideSelect.value = formatSettingsBooleanValue(
      profile.vcockpitGaugeUpdateOutside,
      inheritsFromGlobal
    )
    cockpitMergeSelect.value = formatSettingsBooleanValue(
      profile.cockpitMergeStatic,
      inheritsFromGlobal
    )
    cockpitInstanceSelect.value = formatSettingsBooleanValue(
      profile.cockpitInstanceStatic,
      inheritsFromGlobal
    )
    cockpitPerfSelect.value = formatSettingsBooleanValue(profile.cockpitPerf, inheritsFromGlobal)
    cockpitInteractionHitboxesSelect.value = formatSettingsBooleanValue(
      profile.cockpitInteractionHitboxes,
      inheritsFromGlobal
    )
    skipGaugeSettingSeedSelect.value =
      profile.skipGaugeSettingSeed === undefined && inheritsFromGlobal
        ? 'global'
        : formatSettingsBooleanValue(profile.skipGaugeSettingSeed ?? false, inheritsFromGlobal)
    rendererPixelRatioInput.value =
      profile.rendererPixelRatio == null ? '' : String(profile.rendererPixelRatio)
    rawQueryTextarea.value = profile.rawQuery ?? ''
  }

  const readProfile = (): ViewerConfigProfile => {
    return {
      lod: parseSettingsNullableInteger(exteriorLodSelect.value),
      interiorLod: parseSettingsNullableInteger(interiorLodSelect.value),
      exteriorInteriorMode: parseSettingsExteriorInteriorMode(
        exteriorInteriorModeSelect.value,
        inheritsFromGlobal
      ),
      exteriorInteriorLod: parseSettingsNullableInteger(exteriorInteriorLodSelect.value),
      vcockpitSurfaces: parseSettingsBooleanValue(vcockpitSurfacesSelect.value, inheritsFromGlobal),
      vcockpitLiveGauges: parseSettingsBooleanValue(vcockpitLiveSelect.value, inheritsFromGlobal),
      vcockpitGaugeMode: parseSettingsGaugeMode(
        vcockpitGaugeModeSelect.value,
        inheritsFromGlobal
      ),
      vcockpitGaugeCaptureFps: parseSettingsNullableNumber(
        vcockpitCaptureFpsInput.value,
        inheritsFromGlobal
      ),
      vcockpitGaugeRasterScale: parseSettingsNullableNumber(
        vcockpitRasterScaleInput.value,
        inheritsFromGlobal
      ),
      vcockpitGaugeUpdateOutside: parseSettingsBooleanValue(
        vcockpitGaugeUpdateOutsideSelect.value,
        inheritsFromGlobal
      ),
      cockpitTextures: parseSettingsCockpitTextures(
        cockpitTexturesSelect.value,
        inheritsFromGlobal
      ),
      cockpitTextureSize: parseSettingsNullableInteger(
        cockpitTextureSizeInput.value,
        inheritsFromGlobal
      ),
      cockpitMergeStatic: parseSettingsBooleanValue(cockpitMergeSelect.value, inheritsFromGlobal),
      cockpitInstanceStatic: parseSettingsBooleanValue(
        cockpitInstanceSelect.value,
        inheritsFromGlobal
      ),
      cockpitPerf: parseSettingsBooleanValue(cockpitPerfSelect.value, inheritsFromGlobal),
      cockpitInteractionHitboxes: parseSettingsBooleanValue(
        cockpitInteractionHitboxesSelect.value,
        inheritsFromGlobal
      ),
      skipGaugeSettingSeed: parseSettingsBooleanValue(
        skipGaugeSettingSeedSelect.value,
        inheritsFromGlobal
      ),
      rendererPixelRatio: parseSettingsNullableNumber(
        rendererPixelRatioInput.value,
        inheritsFromGlobal
      ),
      rawQuery:
        inheritsFromGlobal && rawQueryTextarea.value.trim() === ''
          ? undefined
          : rawQueryTextarea.value
    }
  }

  const refreshForSelectedAircraft = (): void => {
    refreshLodOptions(
      parseSettingsNullableInteger(exteriorLodSelect.value, inheritsFromGlobal),
      parseSettingsNullableInteger(interiorLodSelect.value, inheritsFromGlobal),
      parseSettingsNullableInteger(exteriorInteriorLodSelect.value, inheritsFromGlobal)
    )
  }

  form.append(
    createSettingsField('Exterior LOD', exteriorLodSelect),
    createSettingsField('Interior LOD', interiorLodSelect),
    createSettingsField('Exterior Interior', exteriorInteriorModeSelect),
    createSettingsField('Exterior Interior LOD', exteriorInteriorLodSelect),
    createSettingsField('VCockpit Surfaces', vcockpitSurfacesSelect),
    createSettingsField('Live Gauges', vcockpitLiveSelect),
    createSettingsField('Gauge Mode', vcockpitGaugeModeSelect),
    createSettingsField('Gauge Capture FPS', vcockpitCaptureFpsInput),
    createSettingsField('Gauge Raster Scale', vcockpitRasterScaleInput),
    createSettingsField('Gauge Updates Outside', vcockpitGaugeUpdateOutsideSelect),
    createSettingsField('Cockpit Textures', cockpitTexturesSelect),
    createSettingsField('Cockpit Texture Size', cockpitTextureSizeInput),
    createSettingsField('Cockpit Merge Static', cockpitMergeSelect),
    createSettingsField('Cockpit Instance Static', cockpitInstanceSelect),
    createSettingsField('Cockpit Perf', cockpitPerfSelect),
    createSettingsField('Interaction Hitboxes', cockpitInteractionHitboxesSelect),
    createSettingsField('Seed Nothing', skipGaugeSettingSeedSelect),
    createSettingsField('Renderer Pixel Ratio', rendererPixelRatioInput),
    createSettingsField('Extra Query', rawQueryTextarea)
  )

  root.append(form)
  setProfile(options.initialProfile)
  return {
    root,
    readProfile,
    refreshForSelectedAircraft,
    setProfile
  }
}

function createViewerConfigProfileFromSearchParams(
  searchParams: URLSearchParams
): ViewerConfigProfile {
  return {
    packageRoot: searchParams.get('package') ?? undefined,
    aircraftId: searchParams.get('aircraft') ?? undefined,
    lod: resolveRequestedLodIndex(searchParams),
    interiorLod: resolveRequestedInteriorLodIndex(searchParams),
    exteriorInteriorMode: getExteriorInteriorMode(searchParams),
    exteriorInteriorLod: resolveRequestedExteriorInteriorLodIndex(searchParams),
    vcockpitSurfaces: shouldBindVCockpitSurfaces(searchParams),
    vcockpitLiveGauges: shouldLiveRefreshVCockpitGauges(searchParams),
    vcockpitGaugeMode: getConfigurableVCockpitGaugeMode(searchParams),
    vcockpitGaugeCaptureFps: getVCockpitGaugeCaptureFps(searchParams),
    vcockpitGaugeRasterScale: getVCockpitGaugeRasterScale(searchParams),
    vcockpitGaugeUpdateOutside: shouldUpdateVCockpitGaugesOutside(searchParams),
    cockpitTextures: getCockpitTextureMode(searchParams),
    cockpitTextureSize: searchParams.has('cockpitTextureSize')
      ? getCockpitRangeTextureSize(searchParams)
      : null,
    cockpitMergeStatic: isEnabledFlagSearchParam(searchParams, 'cockpitMergeStatic'),
    cockpitInstanceStatic: isEnabledFlagSearchParam(searchParams, 'cockpitInstanceStatic'),
    cockpitPerf: isEnabledFlagSearchParam(searchParams, 'cockpitPerf'),
    cockpitInteractionHitboxes: shouldShowCockpitInteractionHitboxes(searchParams),
    skipGaugeSettingSeed: shouldSkipGaugeSettingSeed(searchParams),
    rendererPixelRatio: searchParams.has('rendererPixelRatio')
      ? getRendererPixelRatio(searchParams)
      : null
  }
}

function createViewerRuntimeSettingsSnapshot(
  searchParams: URLSearchParams
): ViewerRuntimeSettingsSnapshot {
  return {
    exteriorLod: resolveRequestedLodIndex(searchParams),
    interiorLod: resolveRequestedInteriorLodIndex(searchParams),
    exteriorInteriorMode: getExteriorInteriorMode(searchParams),
    exteriorInteriorLod: resolveRequestedExteriorInteriorLodIndex(searchParams),
    vcockpitSurfaces: shouldBindVCockpitSurfaces(searchParams),
    vcockpitLiveGauges: shouldLiveRefreshVCockpitGauges(searchParams),
    vcockpitGaugeMode: getVCockpitGaugeMode(searchParams),
    vcockpitGaugeCaptureFps: getVCockpitGaugeCaptureFps(searchParams),
    vcockpitGaugeRasterScale: getVCockpitGaugeRasterScale(searchParams),
    vcockpitGaugeUpdateOutside: shouldUpdateVCockpitGaugesOutside(searchParams),
    cockpitTextures: getCockpitTextureMode(searchParams),
    cockpitTextureSize: searchParams.has('cockpitTextureSize')
      ? getCockpitRangeTextureSize(searchParams)
      : null,
    cockpitMergeStatic: isEnabledFlagSearchParam(searchParams, 'cockpitMergeStatic'),
    cockpitInstanceStatic: isEnabledFlagSearchParam(searchParams, 'cockpitInstanceStatic'),
    cockpitPerf: isEnabledFlagSearchParam(searchParams, 'cockpitPerf'),
    cockpitInteractionHitboxes: shouldShowCockpitInteractionHitboxes(searchParams),
    skipGaugeSettingSeed: shouldSkipGaugeSettingSeed(searchParams),
    rendererPixelRatio: getRendererPixelRatio(searchParams),
    extraQuery: getUnmanagedRawQuery(`?${searchParams.toString()}`)
  }
}

function getUnmanagedRawQuery(search: string): string {
  const searchParams = new URLSearchParams(search)
  for (const key of PROFILE_QUERY_KEYS) {
    searchParams.delete(key)
  }
  return [...searchParams.entries()]
    .map(([key, value]) => (value === '' ? key : `${key}=${value}`))
    .join('\n')
}

function replaceLodSelectOptions(
  select: HTMLSelectElement,
  lodCount: number,
  firstAllowedLodIndex: number,
  selectedLod: number | null | undefined,
  allowGlobal = false
): void {
  select.replaceChildren()
  if (allowGlobal) {
    select.appendChild(createSettingsOption('global', 'Global'))
  }
  select.appendChild(createSettingsOption('auto', 'Auto'))
  for (let index = firstAllowedLodIndex; index < lodCount; index += 1) {
    select.appendChild(createSettingsOption(String(index), `LOD${String(index).padStart(2, '0')}`))
  }
  select.value = selectedLod === undefined && allowGlobal
    ? 'global'
    : selectedLod == null ? 'auto' : String(selectedLod)
  if (select.selectedIndex < 0) {
    select.value = allowGlobal ? 'global' : 'auto'
  }
}

function parseSettingsNullableInteger(
  value: string,
  inheritOnBlank = false
): number | null | undefined {
  if (value === 'global' || (inheritOnBlank && value.trim() === '')) {
    return undefined
  }
  if (value === '' || value === 'auto') {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseSettingsNullableNumber(
  value: string,
  inheritOnBlank = false
): number | null | undefined {
  if (value.trim() === '') {
    return inheritOnBlank ? undefined : null
  }
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function formatSettingsBooleanValue(value: boolean | undefined, allowGlobal: boolean): string {
  if (value == null && allowGlobal) {
    return 'global'
  }
  return value === false ? 'off' : 'on'
}

function parseSettingsBooleanValue(
  value: string,
  allowGlobal: boolean
): boolean | undefined {
  if (allowGlobal && value === 'global') {
    return undefined
  }
  return value !== 'off'
}

function parseSettingsExteriorInteriorMode(
  value: string,
  allowGlobal: boolean
): ExteriorInteriorMode | undefined {
  if (allowGlobal && value === 'global') {
    return undefined
  }
  return value === 'sync' || value === 'off' ? value : 'deferred'
}

function parseSettingsGaugeMode(
  value: string,
  allowGlobal: boolean
): VCockpitGaugeMode | undefined {
  if (allowGlobal && value === 'global') {
    return undefined
  }
  return value === 'overlay' || value === 'video' ? value : 'texture'
}

function parseSettingsCockpitTextures(
  value: string,
  allowGlobal: boolean
): ViewerConfigProfile['cockpitTextures'] {
  if (allowGlobal && value === 'global') {
    return undefined
  }
  return value === 'full' ? 'full' : 'range-low'
}

function createSettingsField(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label')
  label.style.display = 'grid'
  label.style.gridTemplateColumns = '160px minmax(0, 1fr)'
  label.style.alignItems = 'center'
  label.style.gap = '8px'
  label.style.marginBottom = '8px'

  const span = document.createElement('span')
  span.textContent = labelText
  span.style.color = 'rgba(243, 247, 251, 0.82)'
  label.append(span, control)
  return label
}

function createSettingsSelect(_label: string): HTMLSelectElement {
  const select = document.createElement('select')
  styleSettingsControl(select)
  return select
}

function createSettingsInput(_label: string, type: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = type
  input.min = '0'
  input.step = type === 'number' ? '0.25' : ''
  styleSettingsControl(input)
  return input
}

function createSettingsTextarea(_label: string): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  textarea.rows = 4
  textarea.placeholder = 'key=value'
  styleSettingsControl(textarea)
  textarea.style.resize = 'vertical'
  return textarea
}

function createSettingsOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  return option
}

function createSettingsTabButton(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.setAttribute('role', 'tab')
  button.style.minWidth = '104px'
  button.style.padding = '8px 14px'
  button.style.borderRadius = '8px 8px 0 0'
  button.style.border = '1px solid rgba(255, 255, 255, 0.16)'
  button.style.borderBottom = '0'
  button.style.font = 'inherit'
  button.style.cursor = 'pointer'
  styleSettingsTabButton(button, false)
  return button
}

function styleSettingsTabButton(button: HTMLButtonElement, active: boolean): void {
  button.style.background = active
    ? 'rgba(42, 58, 75, 0.98)'
    : 'rgba(15, 24, 34, 0.82)'
  button.style.color = active ? '#f7fbff' : 'rgba(243, 247, 251, 0.72)'
  button.style.fontWeight = active ? '700' : '500'
}

function createActionButton(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  stylePanelButton(button)
  button.style.width = '100%'
  return button
}

function styleSettingsControl(control: HTMLElement): void {
  control.style.width = '100%'
  control.style.minWidth = '0'
  control.style.boxSizing = 'border-box'
  control.style.padding = '6px 8px'
  control.style.border = '1px solid rgba(255, 255, 255, 0.14)'
  control.style.borderRadius = '8px'
  control.style.background = 'rgba(9, 14, 20, 0.9)'
  control.style.color = '#f3f7fb'
  control.style.font = 'inherit'
}

function stylePanelButton(button: HTMLButtonElement): void {
  button.style.padding = '7px 10px'
  button.style.border = '1px solid rgba(255, 255, 255, 0.16)'
  button.style.borderRadius = '8px'
  button.style.background = 'rgba(23, 35, 48, 0.94)'
  button.style.color = '#f3f7fb'
  button.style.font = 'inherit'
  button.style.cursor = 'pointer'
}

function createAircraftSelectorValue(packageRoot: string, aircraftId: string): string {
  return `${packageRoot}\n${aircraftId}`
}

function getAircraftSelectorDisplayName(option: AircraftSelectorOption): string {
  const aircraftName = getAircraftDisplayName(option.aircraft)
  return option.packageName === '' ? aircraftName : `${option.packageName} - ${aircraftName}`
}

function getAircraftDisplayName(aircraft: ImportedAircraft): string {
  const typeName = aircraft.uiType ?? aircraft.title
  if (aircraft.variationName != null && aircraft.variationName !== '') {
    return `${typeName} - ${aircraft.variationName}`
  }

  return typeName
}

function updateOverlay(
  overlay: HTMLDivElement,
  packageRoot: string,
  packageData: {
    readonly packageName: string
    readonly diagnostics: readonly { readonly severity: string; readonly message: string }[]
  },
  aircraft: ImportedAircraft,
  compiledBehaviors: {
    readonly animationBindings: readonly unknown[]
    readonly visibilityBindings: readonly unknown[]
    readonly materialBindings: readonly unknown[]
    readonly interactionBindings?: readonly unknown[]
    readonly variableKeys: readonly string[]
    readonly diagnostics: readonly { readonly severity: string; readonly message: string }[]
  },
  runtimeState: RuntimeState,
  rendererInfo: RendererInfo,
  fpsCounter: FpsCounterSnapshot
): void {
  const diagnostics = [
    ...packageData.diagnostics,
    ...compiledBehaviors.diagnostics,
    ...runtimeState.diagnostics
  ]
  const errors = diagnostics.filter(item => item.severity === 'error').length
  const warnings = diagnostics.filter(item => item.severity === 'warning').length
  const activeAnimations = [...runtimeState.animationValues.entries()]
    .slice(0, 6)
    .map(([name, value]) => `${name}=${value.toFixed(1)}`)
    .join('\n')
  const visibilityPreview = [...runtimeState.nodeVisibilities.entries()]
    .slice(0, 4)
    .map(([name, value]) => `${name}=${value ? 'on' : 'off'}`)
    .join('\n')
  const diagnosticPreview = diagnostics
    .slice(0, 6)
    .map(item => `${item.severity.toUpperCase()}: ${item.message}`)
    .join('\n')

  overlay.textContent = [
    `MSFS package: ${packageData.packageName}`,
    `Root: ${packageRoot}`,
    `Renderer: ${formatRendererLabel(rendererInfo)}`,
    `FPS: ${formatFpsCounter(fpsCounter)}`,
    `Aircraft: ${aircraft.title}`,
    `Variation: ${aircraft.variationName ?? aircraft.sectionName}`,
    `Source: ${aircraft.sourcePath}`,
    '',
    `Animations compiled: ${compiledBehaviors.animationBindings.length}`,
    `Visibility bindings: ${compiledBehaviors.visibilityBindings.length}`,
    `Material bindings: ${compiledBehaviors.materialBindings.length}`,
    `Interaction bindings: ${compiledBehaviors.interactionBindings?.length ?? 0}`,
    `Variable symbols: ${compiledBehaviors.variableKeys.length}`,
    `Diagnostics: ${errors} error / ${warnings} warning / ${diagnostics.length - errors - warnings} info`,
    `Package diagnostics: ${packageData.diagnostics.length}`,
    `Behavior diagnostics: ${compiledBehaviors.diagnostics.length}`,
    `Runtime diagnostics: ${runtimeState.diagnostics.length}`,
    '',
    'Sample animation outputs:',
    activeAnimations || 'none',
    '',
    'Sample visibility outputs:',
    visibilityPreview || 'none',
    '',
    'Diagnostics preview:',
    diagnosticPreview || 'none'
  ].join('\n')
}

function formatRendererLabel(rendererInfo: RendererInfo): string {
  const parts: string[] = [rendererInfo.mode]

  if (rendererInfo.hasBcTextureCompression != null) {
    parts.push(`bc=${rendererInfo.hasBcTextureCompression ? 'on' : 'off'}`)
  }

  return parts.join(' ')
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

async function discoverAircraftPackageRoots(): Promise<readonly string[]> {
  try {
    const response = await fetch('/aircrafts/index.json')
    if (!response.ok) {
      return []
    }

    const payload = (await response.json()) as {
      readonly packages?: readonly unknown[]
    }
    return (payload.packages ?? [])
      .filter((root): root is string => typeof root === 'string')
      .map(ensureTrailingSlash)
      .filter((root, index, roots) => roots.indexOf(root) === index)
  } catch {
    return []
  }
}

async function loadAircraftSelectorOptions(
  packageRoots: readonly string[],
  selectedPackage: Awaited<ReturnType<typeof importBuiltMsfs2020Package>>,
  selectedPackageRoot: string,
  additionalPackageRoots: readonly string[]
): Promise<readonly AircraftSelectorOption[]> {
  const roots = [selectedPackageRoot, ...packageRoots]
    .map(ensureTrailingSlash)
    .filter((root, index, values) => values.indexOf(root) === index)
  const options: AircraftSelectorOption[] = []

  for (const root of roots) {
    const packageData =
      root === selectedPackageRoot
        ? selectedPackage
        : await importBuiltMsfs2020Package(root, {
            additionalPackageRoots,
            lightweightAircraftOnly: true
          })

    for (const aircraft of packageData.aircraft) {
      options.push({
        packageRoot: root,
        packageName: packageData.packageName,
        aircraft
      })
    }
  }

  return options
}

function createPackageAircraftSelectorOptions(
  packageData: Awaited<ReturnType<typeof importBuiltMsfs2020Package>>,
  packageRoot: string
): readonly AircraftSelectorOption[] {
  return packageData.aircraft.map(aircraft => ({
    packageRoot,
    packageName: packageData.packageName,
    aircraft
  }))
}

async function resolveRequestedPackageRoot(
  searchParams: URLSearchParams,
  discoveredPackageRoots: readonly string[],
  requestedAircraftId: string | null,
  additionalPackageRoots: readonly string[]
): Promise<string> {
  const explicitPackageRoot = searchParams.get('package')
  if (explicitPackageRoot != null && explicitPackageRoot.trim() !== '') {
    return ensureTrailingSlash(explicitPackageRoot)
  }

  if (requestedAircraftId != null) {
    const discoveredPackageRoot = await findPackageRootForAircraft(
      discoveredPackageRoots,
      requestedAircraftId,
      additionalPackageRoots
    )
    if (discoveredPackageRoot != null) {
      return discoveredPackageRoot
    }
  }

  return ensureTrailingSlash(
    discoveredPackageRoots.includes(DEV_DEFAULT_PACKAGE_ROOT)
      ? DEV_DEFAULT_PACKAGE_ROOT
      : discoveredPackageRoots[0] ||
      import.meta.env.VITE_MSFS_PACKAGE_ROOT ||
      DEFAULT_PACKAGE_ROOT
  )
}

async function findPackageRootForAircraft(
  packageRoots: readonly string[],
  requestedAircraftId: string,
  additionalPackageRoots: readonly string[]
): Promise<string | null> {
  for (const root of packageRoots) {
    const packageData = await importBuiltMsfs2020Package(root, {
      additionalPackageRoots,
      lightweightAircraftOnly: true
    })
    if (packageData.aircraft.some(aircraft => aircraft.id === requestedAircraftId)) {
      return ensureTrailingSlash(root)
    }
  }

  return null
}

function resolveRequestedLodIndex(searchParams: URLSearchParams): number | null {
  const rawValue = searchParams.get('lod')
  if (rawValue == null || rawValue.trim() === '') {
    return null
  }

  const parsed = Number.parseInt(rawValue, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid lod query parameter "${rawValue}". Expected a zero-based integer.`)
  }

  return parsed
}

function resolveAdditionalPackageRoots(searchParams: URLSearchParams): string[] {
  const includeBundledStockBehaviorRoot =
    searchParams.get('stockBehaviors') !== 'off' &&
    import.meta.env.VITE_MSFS_STOCK_BEHAVIOR_ROOT !== 'off'
  const urlConfiguredRoots = [
    ...searchParams.getAll('packages'),
    ...searchParams.getAll('deps')
  ]

  const combinedRoots = [
    ...(includeBundledStockBehaviorRoot
      ? [import.meta.env.VITE_MSFS_STOCK_BEHAVIOR_ROOT || DEFAULT_STOCK_BEHAVIOR_ROOT]
      : []),
    ...urlConfiguredRoots,
    import.meta.env.VITE_MSFS_ADDITIONAL_PACKAGE_ROOTS ?? ''
  ]

  return combinedRoots
    .flatMap(parseConfiguredPackageRoots)
    .filter((rootUrl, index, values) => values.indexOf(rootUrl) === index)
}

function parseConfiguredPackageRoots(value: string | undefined): string[] {
  if (value == null || value.trim() === '') {
    return []
  }

  return value
    .split(/[\n,;]/u)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(ensureTrailingSlash)
}

async function loadConfiguredAssetRoots(rootUrls: readonly string[]): Promise<readonly AssetRoot[]> {
  const assetRoots: AssetRoot[] = []

  for (const rootUrl of rootUrls) {
    const assetRoot = await tryLoadAssetRoot(rootUrl)
    if (assetRoot != null) {
      assetRoots.push(assetRoot)
    }
  }

  return assetRoots
}

async function tryLoadAssetRoot(rootUrl: string): Promise<AssetRoot | null> {
  try {
    const response = await fetch(new URL('layout.json', rootUrl))
    if (!response.ok) {
      return null
    }

    const payload = (await response.json()) as {
      readonly content?: readonly {
        readonly path?: string
      }[]
    }

    return {
      rootUrl,
      layoutPathIndex: new Map(
        (payload.content ?? [])
          .map(entry => {
            if (typeof entry.path !== 'string') {
              return null
            }

            const normalizedPath = normalizePath(entry.path)
            return [normalizedPath.toLowerCase(), normalizedPath] as const
          })
          .filter((entry): entry is readonly [string, string] => entry != null)
      )
    }
  } catch {
    return null
  }
}

function setGlobalLoadStage(payload: Record<string, unknown>): void {
  const stage = {
    ...(payload),
    timestamp: Date.now(),
    nowMs: performance.now()
  }
  ;(globalThis as Record<string, unknown>).__msfsLoadStage = stage

  const globalRecord = globalThis as Record<string, unknown>
  const history = Array.isArray(globalRecord.__msfsLoadStageHistory)
    ? globalRecord.__msfsLoadStageHistory
    : []
  history.push(stage)
  globalRecord.__msfsLoadStageHistory = history
}

init().catch(error => {
  setGlobalLoadStage({
    stage: 'init:error',
    error: error instanceof Error ? error.message : String(error)
  })
  const overlay = createOverlay()
  overlay.style.pointerEvents = 'auto'
  overlay.textContent =
    error instanceof Error
      ? `${error.name}: ${error.message}\n\n${error.stack ?? ''}`
      : String(error)
  document.body.appendChild(overlay)
  console.error(error)
})
