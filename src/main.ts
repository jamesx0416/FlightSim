import {
  AmbientLight,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  Euler,
  Group,
  HemisphereLight,
  Material,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { compileMsfs2020Behaviors } from './msfs/behavior'
import { normalizeAsoboPrimitiveBaseVertex } from './msfs/gltf/normalizeAsoboPrimitiveBaseVertex'
import { createMsfsGltfLoader } from './msfs/gltf/createMsfsGltfLoader'
import { instanceStaticMsfsMeshes } from './msfs/gltf/instanceStaticMsfsMeshes'
import { mergeStaticMsfsMeshes } from './msfs/gltf/mergeStaticMsfsMeshes'
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
import { AircraftRuntime, DemoRuntimeHost } from './msfs/runtime'
import type { ImportedAircraft, RuntimeState } from './msfs/types'
import type { ImportedModelDefinition } from './msfs/types'
import {
  createAircraftEnvironment,
  createAppRenderer,
  createNodeMaterialFactory,
  type NodeMaterialFactory,
  type RendererInfo
} from './rendering/createAppRenderer'
import { createMsfsRenderPasses } from './rendering/createMsfsRenderPasses'

const DEFAULT_PACKAGE_ROOT = '/tmp/headwindsim-aircraft-a330-900/'
const DEFAULT_STOCK_BEHAVIOR_ROOT = '/vendor/msfs-stock/'
type AssetRoot = {
  readonly rootUrl: string
  readonly layoutPathIndex: ReadonlySet<string>
}

type LoadedModelComponent = {
  readonly kind: 'exterior' | 'interior'
  readonly modelDefinition: ImportedModelDefinition
  readonly scene: Group
  readonly animations: GLTF['animations']
  readonly loadedLodIndex: number
  readonly loadDiagnostics: ModelLoadDiagnostics
  readonly resourceStats: ModelResourceStats
}

type LoadedAircraftModel = {
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

type CockpitCameraController = {
  readonly isAvailable: () => boolean
  readonly dispose: () => void
  readonly isActive: () => boolean
  readonly update: () => void
  readonly enter: (source?: CockpitViewToggleSource) => void
  readonly exit: (source?: CockpitViewToggleSource) => void
}

type CockpitViewToggleSource = 'keyboard' | 'benchmark'

async function init(): Promise<void> {
  setGlobalLoadStage({ stage: 'init:start' })
  const backgroundColor = new Color('#405264')
  const searchParams = new URLSearchParams(window.location.search)
  const packageRoot = resolveRequestedPackageRoot(searchParams)
  const requestedLodIndex = resolveRequestedLodIndex(searchParams)
  const syncExteriorInterior = searchParams.has('syncExteriorInterior')
  const additionalPackageRoots = resolveAdditionalPackageRoots(searchParams)
  const additionalAssetRoots = await loadConfiguredAssetRoots(additionalPackageRoots)
  setGlobalLoadStage({ stage: 'import:package', packageRoot })
  const packageData = await importBuiltMsfs2020Package(packageRoot, {
    additionalPackageRoots
  })
  const requestedAircraftId = searchParams.get('aircraft')
  const aircraft = selectAircraft(
    packageData.aircraft,
    requestedAircraftId
  )
  ;(globalThis as Record<string, unknown>).__lastImportedPackage = packageData
  ;(globalThis as Record<string, unknown>).__lastSelectedAircraft = aircraft
  if (aircraft == null || aircraft.model == null) {
    if (requestedAircraftId != null) {
      const availableAircraft = packageData.aircraft
        .filter(candidate => candidate.model != null)
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

  const scene = new Scene()

  setGlobalLoadStage({ stage: 'compile:behaviors', aircraftId: aircraft.id })
  const compiledBehaviorsPromise = compileMsfs2020Behaviors(packageData, aircraft, {
    additionalPackageRoots
  })

  setGlobalLoadStage({ stage: 'renderer:create', aircraftId: aircraft.id })
  const rendererInfo = await createAppRenderer()
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
  const selector = createAircraftSelector(packageData.aircraft, aircraft)
  if (selector != null) {
    document.body.appendChild(selector)
  }

  const aircraftModelLoadContext = createAircraftModelLoadContext(
    aircraft,
    packageData.rootUrl,
    packageData.layoutEntries.map(entry => entry.path),
    additionalAssetRoots,
    rendererInfo
  )
  setGlobalLoadStage({ stage: 'gltf:load', aircraftId: aircraft.id })
  const gltfPromise = loadAircraftGltf(aircraftModelLoadContext, {
    preferredLodIndex: requestedLodIndex,
    loadExteriorInterior: syncExteriorInterior
  })
  const [compiledBehaviors, gltf] = await Promise.all([
    compiledBehaviorsPromise,
    gltfPromise
  ])
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
  fitCameraToObject(camera, controls, aircraftRoot)
  const renderPasses = createMsfsRenderPasses(renderer, scene, camera, aircraftRoot)

  const runtimeHost = new DemoRuntimeHost(compiledBehaviors.diagnostics as never, aircraft)
  let runtime = new AircraftRuntime(compiledBehaviors, loadedModel.scene, runtimeHost, aircraft)
  let runtimeMaterialState = collectRuntimeMaterialState(loadedModel.scene)
  ;(globalThis as Record<string, unknown>).__lastRuntimeHost = runtimeHost
  runtime.bindAnimations(loadedModel.animations)
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
    runtimeMaterialState = collectRuntimeMaterialState(loadedModel.scene)
    runtimeState = runtime.update(0)
    ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
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
      loadedModel.scene.remove(currentInterior.scene)
    }
    if (nextInterior != null && nextInterior.scene.parent !== loadedModel.scene) {
      loadedModel.scene.add(nextInterior.scene)
    }
    recordSwapPhase('interior-swap:scene-graph', sceneSwapStartMs)

    loadedModel = replaceLoadedAircraftInterior(loadedModel, nextInterior)
    ;(globalThis as Record<string, unknown>).__lastLoadedGltf = loadedModel
    const runtimeRebuildStartMs = performance.now()
    rebuildRuntimeForLoadedModel()
    recordSwapPhase('interior-swap:runtime-rebuild', runtimeRebuildStartMs)
    const renderPassRefreshStartMs = performance.now()
    renderPasses.refresh()
    recordSwapPhase('interior-swap:render-pass-refresh', renderPassRefreshStartMs)
    recordCockpitBenchmarkEvent('cockpit:interior:swap-complete', {
      loadedLodIndex: nextInterior?.loadedLodIndex ?? null,
      swapPhases
    })
  }

  let exteriorViewInterior = loadedModel.interior
  let exteriorViewInteriorLoadPromise: Promise<LoadedModelComponent | null> | null = null
  let cachedCockpitInteriorLod00: LoadedModelComponent | null =
    loadedModel.interior?.loadedLodIndex === 0 ? loadedModel.interior : null
  let shouldUseCockpitInteriorLod00 = false
  let hasRequestedCockpitInteriorLod00 = false
  let interiorLodUpgradePromise: Promise<void> | null = null
  const shouldLoadExteriorViewInterior = (): boolean => {
    return (
      aircraft.interiorModel != null &&
      aircraft.model?.modelOptions.withExteriorShowInterior === true
    )
  }

  const getExteriorViewInteriorPreferredLodIndex = (): number | null => {
    if (aircraft.model?.modelOptions.withExteriorShowInteriorHideFirstLod === true) {
      return Math.max(requestedLodIndex ?? 1, 1)
    }

    return requestedLodIndex ?? null
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
    exteriorViewInteriorLoadPromise = loadAircraftModelComponent(
      aircraftModelLoadContext,
      interiorModel,
      {
        kind: 'interior',
        preferredLodIndex: getExteriorViewInteriorPreferredLodIndex()
      }
    )
      .then(nextInterior => {
        exteriorViewInterior = nextInterior
        setGlobalLoadStage({
          stage: 'gltf:exterior-interior:deferred:ready',
          aircraftId: aircraft.id,
          loadedLodIndex: nextInterior.loadedLodIndex
        })
        if (!cockpitCameraController.isActive() && loadedModel.interior !== nextInterior) {
          setActiveInteriorComponent(nextInterior)
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

  const requestInteriorLod00Upgrade = (): void => {
    if (!hasRequestedCockpitInteriorLod00) {
      return
    }

    if (cachedCockpitInteriorLod00 != null) {
      if (
        shouldUseCockpitInteriorLod00 &&
        loadedModel.interior !== cachedCockpitInteriorLod00
      ) {
        recordCockpitBenchmarkEvent('cockpit:interior-upgrade:cache-hit', {
          loadedLodIndex: cachedCockpitInteriorLod00.loadedLodIndex
        })
        setActiveInteriorComponent(cachedCockpitInteriorLod00)
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
        const nextInterior = await loadAircraftModelComponent(
          aircraftModelLoadContext,
          interiorModel,
          {
            kind: 'interior',
            preferredLodIndex: 0,
            fallbackToOtherLods: false,
            textureLoadOptions: createCockpitSkipTextureLoadOptions(),
            stripTextures: true,
            instanceStaticMeshes: searchParams.has('cockpitInstanceStatic'),
            mergeStaticMeshes: searchParams.has('cockpitMergeStatic'),
            behaviorSet: compiledBehaviors
          }
        )
        cachedCockpitInteriorLod00 = nextInterior
        recordCockpitBenchmarkEvent('cockpit:interior-upgrade:component-loaded', {
          loadedLodIndex: nextInterior.loadedLodIndex,
          loadDiagnostics: nextInterior.loadDiagnostics,
          resourceStats: nextInterior.resourceStats
        })

        if (shouldUseCockpitInteriorLod00 && loadedModel.interior !== nextInterior) {
          setActiveInteriorComponent(nextInterior)
        }

        setGlobalLoadStage({
          stage: 'gltf:interior-upgrade:ready',
          aircraftId: aircraft.id
        })
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
    shouldUseCockpitInteriorLod00 = false
    if (loadedModel.interior === exteriorViewInterior) {
      return
    }

    setActiveInteriorComponent(exteriorViewInterior)
    void ensureExteriorViewInteriorLoaded()
  }

  const cockpitCameraController = installCockpitCameraShortcut(
    renderer.domElement,
    camera,
    controls,
    aircraftRoot,
    loadedModel.exterior.scene,
    aircraft,
    () => {
      shouldUseCockpitInteriorLod00 = true
      hasRequestedCockpitInteriorLod00 = true
      requestInteriorLod00Upgrade()
    },
    restoreExteriorInteriorLod,
    (mode, source) => {
      recordCockpitBenchmarkEvent(`cockpit:toggle:${mode}`, { source })
    }
  )
  if (!syncExteriorInterior) {
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

  const runCockpitBenchmark = async (): Promise<CockpitBenchmarkRunResult> => {
    if (!cockpitCameraController.isAvailable()) {
      throw new Error('Cockpit benchmark is unavailable because the selected aircraft has no cockpit camera.')
    }
    if (aircraft.interiorModel == null) {
      throw new Error('Cockpit benchmark is unavailable because the selected aircraft has no interior model.')
    }
    await ensureExteriorViewInteriorLoaded()
    if (exteriorViewInterior == null) {
      throw new Error('Cockpit benchmark is unavailable because the exterior-view interior LOD could not be loaded.')
    }
    if (activeCockpitBenchmarkEvents != null) {
      throw new Error('Cockpit benchmark is already running.')
    }

    const events: CockpitBenchmarkEvent[] = []
    activeCockpitBenchmarkEvents = events

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

      const coldAvailable = cachedCockpitInteriorLod00 == null
      await captureCockpitBenchmarkSnapshot('benchmark:cold:before')
      if (coldAvailable) {
        cockpitCameraController.enter('benchmark')
        await waitForCockpitBenchmarkCondition(
          () =>
            cockpitCameraController.isActive() &&
            loadedModel.interior?.loadedLodIndex === 0,
          120_000,
          'cold cockpit LOD00 activation'
        )
        recordCockpitBenchmarkEvent('benchmark:cold:active-interior')
        await waitForAnimationFrames(3)
        recordCockpitBenchmarkEvent('benchmark:cold:visual-ready')
        await captureCockpitBenchmarkSnapshot('benchmark:cold:after')
      } else {
        recordCockpitBenchmarkEvent('benchmark:cold:skipped', {
          reason: 'Interior LOD00 was already cached before the benchmark run started.'
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
          loadedModel.interior?.loadedLodIndex === 0,
        10_000,
        'warm cockpit LOD00 activation'
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
            : 'Interior LOD00 was already cached before the benchmark run started.'
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
      activeCockpitBenchmarkEvents = null
    }
  }

  ;(globalThis as Record<string, unknown>).__cockpitBenchmark = {
    getState: () => ({
      aircraftId: aircraft.id,
      cockpitCameraAvailable: cockpitCameraController.isAvailable(),
      cockpitViewActive: cockpitCameraController.isActive(),
      activeInteriorLodIndex: loadedModel.interior?.loadedLodIndex ?? null,
      cachedInteriorLod00Available: cachedCockpitInteriorLod00 != null,
      activeInteriorLoadDiagnostics: loadedModel.interior?.loadDiagnostics ?? null,
      activeInteriorResourceStats: loadedModel.interior?.resourceStats ?? null,
      cachedInteriorLod00LoadDiagnostics: cachedCockpitInteriorLod00?.loadDiagnostics ?? null,
      cachedInteriorLod00ResourceStats: cachedCockpitInteriorLod00?.resourceStats ?? null,
      benchmarkRunning: activeCockpitBenchmarkEvents != null,
      lastResult: lastCockpitBenchmarkResult
    }),
    run: runCockpitBenchmark
  }
  ;(globalThis as Record<string, unknown>).__lastCockpitBenchmarkResult =
    lastCockpitBenchmarkResult

  const clock = new Clock()
  let runtimeState: RuntimeState = runtime.update(0)
  ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
  const cockpitPerfDiagnostics = searchParams.has('cockpitPerf')
    ? createCockpitPerfDiagnostics(() => loadedModel)
    : createDisabledCockpitPerfDiagnostics(() => loadedModel)
  ;(globalThis as Record<string, unknown>).__cockpitPerf = cockpitPerfDiagnostics
  updateOverlay(
    overlay,
    packageRoot,
    packageData,
    aircraft,
    compiledBehaviors,
    runtimeState,
    rendererInfo
  )

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
      const runtimeStartMs = performance.now()
      runtimeState = runtime.update(dtSeconds)
      const runtimeEndMs = performance.now()
      ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
      syncRuntimeMaterialState(runtimeMaterialState, runtimeHost)
      const cameraStartMs = performance.now()
      cockpitCameraController.update()
      if (!cockpitCameraController.isActive()) {
        controls.update()
      }
      const cameraEndMs = performance.now()
      const renderStartMs = performance.now()
      renderPasses.render()
      const renderEndMs = performance.now()
      cockpitPerfDiagnostics.recordFrame({
        cockpitActive: cockpitCameraController.isActive(),
        loadedInteriorLodIndex: loadedModel.interior?.loadedLodIndex ?? null,
        frameMs: renderEndMs - frameStartMs,
        runtimeMs: runtimeEndMs - runtimeStartMs,
        cameraMs: cameraEndMs - cameraStartMs,
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
      runtimeState = runtime.update(dtSeconds)
      ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
      syncRuntimeMaterialState(runtimeMaterialState, runtimeHost)
      cockpitCameraController.update()
      if (!cockpitCameraController.isActive()) {
        controls.update()
      }
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
        rendererInfo
      )
    }
  })
}


type CockpitPerfFrameSample = {
  readonly cockpitActive: boolean
  readonly loadedInteriorLodIndex: number | null
  readonly frameMs: number
  readonly runtimeMs: number
  readonly cameraMs: number
  readonly renderMs: number
  readonly rendererCalls: number
  readonly rendererTriangles: number
  readonly rendererLines: number
  readonly rendererPoints: number
  readonly rendererTextures: number
  readonly rendererGeometries: number
}

type CockpitPerfDiagnostics = {
  readonly enabled: boolean
  readonly recordFrame: (sample: CockpitPerfFrameSample) => void
  readonly getSummary: () => Record<string, unknown>
  readonly getActiveInteriorStats: () => Record<string, unknown> | null
  readonly reset: () => void
}

function createCockpitPerfDiagnostics(
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
    reset: () => {
      samples.length = 0
    }
  }
}

function createDisabledCockpitPerfDiagnostics(
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
    cameraMs: summarizeNumericSamples(sourceSamples.map(sample => sample.cameraMs)),
    renderMs: summarizeNumericSamples(sourceSamples.map(sample => sample.renderMs)),
    rendererCalls: summarizeNumericSamples(sourceSamples.map(sample => sample.rendererCalls)),
    rendererTriangles: summarizeNumericSamples(sourceSamples.map(sample => sample.rendererTriangles)),
    rendererTextures: sourceSamples.at(-1)?.rendererTextures ?? null,
    rendererGeometries: sourceSamples.at(-1)?.rendererGeometries ?? null
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
    resourceStats: component.resourceStats
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
  return images.reduce((total, image) => total + getTextureImageByteLength(image), 0)
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
  const mipmapEstimate = record.mipmaps?.reduce(
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
  runtimeHost: DemoRuntimeHost
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

function createCockpitSkipTextureLoadOptions(): MSFSDDSLoadOptions {
  return {
    skipTextures: true
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
        textureLoadOptions: options?.textureLoadOptions
      }),
    createNodeMaterial: createNodeMaterialFactory(rendererInfo.renderer)
  }
}

async function loadAircraftGltf(
  context: AircraftModelLoadContext,
  options: {
    readonly preferredLodIndex?: number | null
    readonly loadExteriorInterior?: boolean
  } = {}
): Promise<LoadedAircraftModel> {
  const { aircraft } = context
  if (aircraft.model == null) {
    throw new Error(`Aircraft ${aircraft.id} does not have a model to load.`)
  }

  const exterior = await loadAircraftModelComponent(context, aircraft.model, {
    kind: 'exterior',
    preferredLodIndex: options.preferredLodIndex ?? null
  })
  const interior =
    options.loadExteriorInterior === true &&
    aircraft.interiorModel != null &&
    aircraft.model.modelOptions.withExteriorShowInterior
      ? await loadAircraftModelComponent(context, aircraft.interiorModel, {
          kind: 'interior',
          preferredLodIndex: aircraft.model.modelOptions.withExteriorShowInteriorHideFirstLod
            ? Math.max(options.preferredLodIndex ?? 1, 1)
            : options.preferredLodIndex ?? null
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
    readonly fallbackToOtherLods?: boolean
    readonly textureLoadOptions?: MSFSDDSLoadOptions
    readonly stripTextures?: boolean
    readonly instanceStaticMeshes?: boolean
    readonly mergeStaticMeshes?: boolean
    readonly behaviorSet?: typeof compiledBehaviors
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
    recordPhase
  )
  if (options.stripTextures === true) {
    const stripStartMs = performance.now()
    stripObjectTextures(loaded.gltf.scene)
    recordPhase('component:strip-textures', stripStartMs)
  }
  if (options.instanceStaticMeshes === true && options.behaviorSet != null) {
    const instanceStartMs = performance.now()
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
  const resourceStatsStartMs = performance.now()
  const resourceStats = collectModelResourceStats(loaded.gltf.scene)
  recordPhase('component:collect-resource-stats', resourceStatsStartMs, resourceStats)
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
    resourceStats
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
  ) => void = () => {}
): Promise<{
  readonly gltf: GLTF
  readonly loadedLodIndex: number
}> {
  let lastError: unknown = null
  const lodEntries = [...modelDefinition.lods]
    .sort((left, right) => right.minSize - left.minSize)
    .map((lod, index) => ({ lod, index }))
  const hasPreferredLod =
    preferredLodIndex != null &&
    preferredLodIndex >= 0 &&
    preferredLodIndex < lodEntries.length
  const loadOrder = hasPreferredLod
    ? fallbackToOtherLods
      ? [
          lodEntries[preferredLodIndex]!,
          ...lodEntries.filter(({ index }) => index !== preferredLodIndex)
        ]
      : [lodEntries[preferredLodIndex]!]
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
      }, recordPhase)
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
  ) => void = () => {}
): Promise<GLTF> {
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
  const baseUrl = url.slice(0, url.lastIndexOf('/') + 1)
  const sanitizeStartMs = performance.now()
  const sanitizedGltf = sanitizeMsfsGltf(gltfJson)
  recordPhase('lod:sanitize-msfs-gltf', sanitizeStartMs)
  if (loadContext != null) {
    setGlobalLoadStage({
      stage: 'gltf:lod:parse:start',
      ...loadContext
    })
  }
  const loaderParseStartMs = performance.now()
  const gltf = await loader.parseAsync(sanitizedGltf, baseUrl)
  recordPhase('lod:gltf-loader-parse', loaderParseStartMs)
  if (loadContext != null) {
    setGlobalLoadStage({
      stage: 'gltf:lod:parse:done',
      ...loadContext
    })
  }
  return gltf
}

function createTextureUrlResolver(
  aircraft: ImportedAircraft,
  packageRootUrl: string,
  layoutPaths: readonly string[],
  additionalAssetRoots: readonly AssetRoot[]
): (url: string) => string {
  const textureDirectories = aircraft.textureDirectories
  const layoutPathIndex = new Set(layoutPaths.map(path => normalizePath(path).toLowerCase()))

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
      if (!layoutPathIndex.has(candidatePath.toLowerCase())) {
        for (const assetRoot of additionalAssetRoots) {
          if (!assetRoot.layoutPathIndex.has(candidatePath.toLowerCase())) {
            continue
          }

          return new URL(candidatePath, assetRoot.rootUrl).toString()
        }
        continue
      }

      return new URL(candidatePath, packageRootUrl).toString()
    }

    if (textureCandidates.length > 0) {
      return new URL(textureCandidates[0], packageRootUrl).toString()
    }

    return parsedUrl.toString()
  }
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
  object: Group
): void {
  const bounds = computeApproximateBounds(object)
  const size = bounds.getSize(new Vector3())
  const center = bounds.getCenter(new Vector3())
  const radius = Math.max(size.x, size.y, size.z)
  camera.near = 0.1
  camera.far = Math.max(5000, radius * 40)
  camera.position
    .copy(center)
    .add(new Vector3(radius * 1.2, radius * 0.46, radius * 1.05))
  camera.updateProjectionMatrix()
  controls.target.copy(center).add(new Vector3(0, radius * 0.1, radius * 0.08))
  controls.update()
}

type CockpitCameraDefinition = {
  readonly position: Vector3
  readonly rotationPbhDegrees: Vector3
}

type ParsedCockpitCameraSection = {
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

const FEET_TO_METERS = 0.3048
let disposeCockpitCameraShortcut: (() => void) | null = null

function installCockpitCameraShortcut(
  domElement: HTMLElement,
  camera: PerspectiveCamera,
  controls: OrbitControls,
  aircraftRoot: Group,
  exteriorScene: Object3D,
  aircraft: ImportedAircraft,
  onEnterCockpit?: () => void,
  onExitCockpit?: () => void,
  onToggleCockpitView?: (mode: 'enter' | 'exit', source: CockpitViewToggleSource) => void
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
  let lastPointerX = 0
  let lastPointerY = 0
  let exteriorCameraSnapshot: OrbitCameraSnapshot | null = null
  let exteriorVisibilityBeforeCockpit = exteriorScene.visible
  const previousTouchAction = domElement.style.touchAction

  const applyCockpitCamera = (): void => {
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
    applyCockpitCamera()
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
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }

    activePointerId = event.pointerId
    lastPointerX = event.clientX
    lastPointerY = event.clientY
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

    releasePointer()
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
  domElement.addEventListener('wheel', onWheel, { passive: false })
  disposeCockpitCameraShortcut = () => {
    exitCockpitView()
    window.removeEventListener('keydown', onKeyDown)
    domElement.removeEventListener('pointerdown', onPointerDown)
    domElement.removeEventListener('pointermove', onPointerMove)
    domElement.removeEventListener('pointerup', onPointerUp)
    domElement.removeEventListener('pointercancel', onPointerUp)
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

  const cameraSections = camerasCfg.sections
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
    .filter((section): section is NonNullable<typeof section> => section != null)

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

function isSupportedCockpitCameraSection(section: ParsedCockpitCameraSection): boolean {
  if (section.category !== '' && section.category !== 'cockpit') {
    return false
  }

  return (
    section.origin === '' ||
    section.origin === 'virtual cockpit' ||
    section.origin === 'cockpit'
  )
}

function getCockpitCameraSectionScore(section: ParsedCockpitCameraSection): number {
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

  for (const value of Object.values(material as Record<string, unknown>)) {
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
  aircraft: readonly ImportedAircraft[],
  selectedAircraft: ImportedAircraft
): HTMLDivElement | null {
  if (aircraft.length <= 1) {
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

  const sortedAircraft = [...aircraft].sort((left, right) =>
    getAircraftDisplayName(left).localeCompare(getAircraftDisplayName(right))
  )
  for (const candidate of sortedAircraft) {
    const option = document.createElement('option')
    option.value = candidate.id
    option.textContent = getAircraftDisplayName(candidate)
    option.selected = candidate.id === selectedAircraft.id
    select.appendChild(option)
  }

  select.addEventListener('change', () => {
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('aircraft', select.value)
    window.location.assign(nextUrl.toString())
  })

  wrapper.append(label, select)
  return wrapper
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
    readonly variableKeys: readonly string[]
    readonly diagnostics: readonly { readonly severity: string; readonly message: string }[]
  },
  runtimeState: RuntimeState,
  rendererInfo: RendererInfo
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
    `Aircraft: ${aircraft.title}`,
    `Variation: ${aircraft.variationName ?? aircraft.sectionName}`,
    `Source: ${aircraft.sourcePath}`,
    '',
    `Animations compiled: ${compiledBehaviors.animationBindings.length}`,
    `Visibility bindings: ${compiledBehaviors.visibilityBindings.length}`,
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
  const parts = [rendererInfo.mode]

  if (rendererInfo.hasBcTextureCompression != null) {
    parts.push(`bc=${rendererInfo.hasBcTextureCompression ? 'on' : 'off'}`)
  }

  return parts.join(' ')
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function resolveRequestedPackageRoot(searchParams: URLSearchParams): string {
  return ensureTrailingSlash(
    searchParams.get('package') ||
      import.meta.env.VITE_MSFS_PACKAGE_ROOT ||
      DEFAULT_PACKAGE_ROOT
  )
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
      layoutPathIndex: new Set(
        (payload.content ?? [])
          .map(entry => typeof entry.path === 'string' ? normalizePath(entry.path).toLowerCase() : null)
          .filter((entry): entry is string => entry != null)
      )
    }
  } catch {
    return null
  }
}

function setGlobalLoadStage(payload: Record<string, unknown>): void {
  ;(globalThis as Record<string, unknown>).__msfsLoadStage = {
    ...(payload),
    timestamp: Date.now()
  }
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
