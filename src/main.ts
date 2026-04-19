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
  PerspectiveCamera,
  Scene,
  Vector3
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { compileMsfs2020Behaviors } from './msfs/behavior'
import { normalizeAsoboPrimitiveBaseVertex } from './msfs/gltf/normalizeAsoboPrimitiveBaseVertex'
import { createMsfsGltfLoader } from './msfs/gltf/createMsfsGltfLoader'
import { normalizeAsoboPrimitiveWinding } from './msfs/gltf/normalizeAsoboPrimitiveWinding'
import { normalizeMsfsMaterials } from './msfs/gltf/normalizeMsfsMaterials'
import { usesGeoDecalFrostedMaterial } from './msfs/gltf/normalizeMsfsMaterials'
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
  type AppRenderer,
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

type LoadedAircraftModel = {
  readonly scene: Group
  readonly animations: GLTF['animations']
}

async function init(): Promise<void> {
  setGlobalLoadStage({ stage: 'init:start' })
  const backgroundColor = new Color('#405264')
  const searchParams = new URLSearchParams(window.location.search)
  const packageRoot = resolveRequestedPackageRoot(searchParams)
  const requestedLodIndex = resolveRequestedLodIndex(searchParams)
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

  setGlobalLoadStage({ stage: 'gltf:load', aircraftId: aircraft.id })
  const gltfPromise = loadAircraftGltf(
    aircraft,
    packageData.rootUrl,
    packageData.layoutEntries.map(entry => entry.path),
    additionalAssetRoots,
    rendererInfo,
    {
      preferredLodIndex: requestedLodIndex
    }
  )
  const [compiledBehaviors, gltf] = await Promise.all([
    compiledBehaviorsPromise,
    gltfPromise
  ])
  ;(globalThis as Record<string, unknown>).__lastCompiledBehaviors = compiledBehaviors
  setGlobalLoadStage({ stage: 'gltf:loaded', aircraftId: aircraft.id })
  ;(globalThis as Record<string, unknown>).__lastLoadedGltf = gltf
  const aircraftRoot = new Group()
  aircraftRoot.add(gltf.scene)
  scene.add(aircraftRoot)
  ;(globalThis as Record<string, unknown>).__lastAircraftRoot = aircraftRoot
  ;(globalThis as Record<string, unknown>).__lastScene = scene

  setGlobalLoadStage({ stage: 'scene:ready', aircraftId: aircraft.id })
  centerObjectAtOrigin(aircraftRoot)
  fitCameraToObject(camera, controls, aircraftRoot)
  installCockpitCameraShortcut(camera, controls, aircraftRoot, aircraft)
  const renderPasses = createMsfsRenderPasses(renderer, scene, camera, aircraftRoot)

  const runtimeHost = new DemoRuntimeHost(compiledBehaviors.diagnostics as never, aircraft)
  const runtime = new AircraftRuntime(compiledBehaviors, gltf.scene, runtimeHost, aircraft)
  const runtimeMaterialState = collectRuntimeMaterialState(gltf.scene)
  ;(globalThis as Record<string, unknown>).__lastRuntimeHost = runtimeHost
  runtime.bindAnimations(gltf.animations)

  const clock = new Clock()
  let runtimeState: RuntimeState = runtime.update(0)
  ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
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

  renderer.setAnimationLoop(() => {
    const dtSeconds = clock.getDelta()
    runtimeState = runtime.update(dtSeconds)
    ;(globalThis as Record<string, unknown>).__lastRuntimeState = runtimeState
    syncRuntimeMaterialState(runtimeMaterialState, runtimeHost)
    controls.update()
    renderPasses.render()
    updateOverlay(
      overlay,
      packageRoot,
      packageData,
      aircraft,
      compiledBehaviors,
      runtimeState,
      rendererInfo
    )
  })
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

async function loadAircraftGltf(
  aircraft: ImportedAircraft,
  packageRootUrl: string,
  layoutPaths: readonly string[],
  additionalAssetRoots: readonly AssetRoot[],
  rendererInfo: RendererInfo,
  options: {
    readonly preferredLodIndex?: number | null
  } = {}
): Promise<LoadedAircraftModel> {
  if (aircraft.model == null) {
    throw new Error(`Aircraft ${aircraft.id} does not have a model to load.`)
  }

  const textureUrlResolver = createTextureUrlResolver(
    aircraft,
    packageRootUrl,
    layoutPaths,
    additionalAssetRoots
  )
  const decodeNormalSources = rendererInfo.hasBcTextureCompression === false
  const loader = createMsfsGltfLoader({
    urlResolver: textureUrlResolver,
    decodeNormalSources,
  })
  const createNodeMaterial = createNodeMaterialFactory(rendererInfo.renderer)

  const loadedScene = new Group()
  const loadedAnimations: GLTF['animations'] = []

  const modelDefinitions = [aircraft.model]
  if (
    aircraft.interiorModel != null &&
    aircraft.model.modelOptions.withExteriorShowInterior
  ) {
    modelDefinitions.push(aircraft.interiorModel)
  }

  for (const modelDefinition of modelDefinitions) {
    const modelPreferredLodIndex =
      modelDefinition === aircraft.interiorModel &&
      aircraft.model.modelOptions.withExteriorShowInteriorHideFirstLod
        ? Math.max(options.preferredLodIndex ?? 1, 1)
        : options.preferredLodIndex ?? null
    const gltf = await loadAircraftModelDefinitionGltf(
      loader,
      aircraft,
      modelDefinition,
      createNodeMaterial,
      modelPreferredLodIndex
    )
    loadedScene.add(gltf.scene)
    loadedAnimations.push(...gltf.animations)
  }

  return {
    scene: loadedScene,
    animations: loadedAnimations
  }
}

async function loadAircraftModelDefinitionGltf(
  loader: GLTFLoader,
  aircraft: ImportedAircraft,
  modelDefinition: ImportedModelDefinition,
  createNodeMaterial: NodeMaterialFactory,
  preferredLodIndex: number | null
): Promise<GLTF> {
  let lastError: unknown = null
  const lods = [...modelDefinition.lods].sort((left, right) => right.minSize - left.minSize)
  const loadOrder =
    preferredLodIndex != null && preferredLodIndex >= 0 && preferredLodIndex < lods.length
      ? [
          lods[preferredLodIndex]!,
          ...lods.filter((_, index) => index !== preferredLodIndex)
        ]
      : lods

  for (const lod of loadOrder) {
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
      })
      setGlobalLoadStage({
        stage: 'gltf:lod:repair-skinned',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      await repairMsfsSkinnedAttributes(gltf)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-skinning',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      normalizeMsfsSkinning(gltf.scene)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-texcoords',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      normalizeMsfsTexcoords(gltf.scene)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-colors',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      normalizeMsfsVertexColors(gltf.scene)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-normals',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      normalizeMsfsNormalsTangents(gltf.scene)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-asobo-primitive-base-vertex',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      normalizeAsoboPrimitiveBaseVertex(gltf)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-asobo-primitive-winding',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      normalizeAsoboPrimitiveWinding(gltf)
      setGlobalLoadStage({
        stage: 'gltf:lod:normalize-materials',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      await normalizeMsfsMaterials(gltf, { createNodeMaterial })
      setGlobalLoadStage({
        stage: 'gltf:lod:ready',
        aircraftId: aircraft.id,
        lodUrl: lod.url,
        lodMinSize: lod.minSize
      })
      return gltf
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
  } | null = null
): Promise<GLTF> {
  const response = await fetch(url)
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

  const gltfText = await response.text()
  if (loadContext != null) {
    setGlobalLoadStage({
      stage: 'gltf:lod:text:loaded',
      ...loadContext,
      textLength: gltfText.length
    })
  }
  const baseUrl = url.slice(0, url.lastIndexOf('/') + 1)
  const sanitizedGltf = sanitizeMsfsGltf(JSON.parse(gltfText) as Record<string, unknown>)
  if (loadContext != null) {
    setGlobalLoadStage({
      stage: 'gltf:lod:parse:start',
      ...loadContext
    })
  }
  const gltf = await loader.parseAsync(JSON.stringify(sanitizedGltf), baseUrl)
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

const FEET_TO_METERS = 0.3048
let disposeCockpitCameraShortcut: (() => void) | null = null

function installCockpitCameraShortcut(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  aircraftRoot: Group,
  aircraft: ImportedAircraft
): void {
  disposeCockpitCameraShortcut?.()
  disposeCockpitCameraShortcut = null

  const cockpitCamera = resolveCockpitCameraDefinition(aircraft)
  if (cockpitCamera == null) {
    return
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.code !== 'KeyC' || shouldIgnoreKeyboardShortcut(event)) {
      return
    }

    const worldPosition = aircraftRoot.localToWorld(cockpitCamera.position.clone())
    const orientation = new Euler(
      degreesToRadians(cockpitCamera.rotationPbhDegrees.x),
      degreesToRadians(cockpitCamera.rotationPbhDegrees.z),
      degreesToRadians(cockpitCamera.rotationPbhDegrees.y),
      'YXZ'
    )
    const forward = new Vector3(0, 0, 1).applyEuler(orientation).normalize()
    const up = new Vector3(0, 1, 0).applyEuler(orientation).normalize()

    camera.position.copy(worldPosition)
    camera.up.copy(up)
    controls.target.copy(worldPosition).add(forward.multiplyScalar(12))
    camera.updateProjectionMatrix()
    controls.update()
    event.preventDefault()
  }

  window.addEventListener('keydown', onKeyDown)
  disposeCockpitCameraShortcut = () => {
    window.removeEventListener('keydown', onKeyDown)
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
    .map(section => {
      const initialXyz = parseNumericTriple(section.values.get('initialxyz'))
      const initialPbh = parseNumericTriple(section.values.get('initialpbh'))
      if (initialXyz == null || initialPbh == null) {
        return null
      }

      return {
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

  const selectedCamera =
    cameraSections.find(section =>
      section.origin === 'virtual cockpit' &&
      section.category === 'cockpit' &&
      section.subCategory === 'pilot' &&
      section.subCategoryItem === 'defaultpilot'
    ) ??
    cameraSections.find(section =>
      section.origin === 'virtual cockpit' &&
      section.category === 'cockpit' &&
      section.subCategory === 'pilot'
    ) ??
    cameraSections.find(section => section.origin === 'virtual cockpit') ??
    null

  if (selectedCamera == null) {
    return null
  }

  const [eyeLongitudinalFeet, eyeLateralFeet, eyeVerticalFeet] = eyepoint
  const [offsetLateralFeet, offsetVerticalFeet, offsetLongitudinalFeet] =
    selectedCamera.initialXyz

  const localPosition = new Vector3(
    -(eyeLateralFeet + offsetLateralFeet) * FEET_TO_METERS,
    (eyeVerticalFeet + offsetVerticalFeet) * FEET_TO_METERS,
    (eyeLongitudinalFeet + offsetLongitudinalFeet) * FEET_TO_METERS
  )
  const [pitchDegrees, bankDegrees, headingDegrees] = selectedCamera.initialPbh

  return {
    position: localPosition,
    rotationPbhDegrees: new Vector3(pitchDegrees, bankDegrees, headingDegrees)
  }
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
