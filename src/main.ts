import { GlobeControls, TilesRenderer } from '3d-tiles-renderer'
import {
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  UpdateOnChangePlugin
} from '3d-tiles-renderer/plugins'
import {
  AgXToneMapping,
  Box3,
  FrontSide,
  Matrix4,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SkinnedMesh,
  Vector3
} from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import {
  diffuseColor,
  mrt,
  normalView,
  pass,
  toneMapping,
  uniform
} from 'three/tsl'
import {
  MeshBasicNodeMaterial,
  PostProcessing,
  WebGPURenderer
} from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import {
  aerialPerspective,
  AtmosphereContextNode,
  AtmosphereLight,
  AtmosphereLightNode
} from '@takram/three-atmosphere/webgpu'
import { Ellipsoid, Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import {
  dithering,
  highpVelocity,
  lensFlare,
  temporalAntialias
} from '@takram/three-geospatial/webgpu'

import { Plane } from './entities/Plane'
import { KeyboardFlightControls } from './input/KeyboardFlightControls'
import { TilesFadePlugin } from './plugins/fade/TilesFadePlugin'
import { FlightHud } from './ui/FlightHud'
import { MsfsCompatibilityDock } from './ui/MsfsCompatibilityDock'
import { FixedStepLoop } from './sim/FixedStepLoop'
import { hydrateCompatibilityAircraftParams } from './sim/MsfsAircraftPhysics'
import { NedFrame } from './sim/NedFrame'
import {
  applyMsfsAircraftAnimationState,
  applyMsfsExtensions,
  createMsfsGltfLoader,
  setupMsfsAnimations,
  type MsfsAnimationState
} from './helpers/msfsGltf'
import { loadNormalizedMsfsSourceGltf } from './helpers/msfsSourceGltf'
import { compatibilityChannelName, type CompatibilityBridgeMessage } from './msfs/runtime/bridge'
import type { AircraftCompatibilityDescriptor } from './msfs/runtime/descriptor'
import {
  loadCompatibilityDescriptor,
  loadCompatibilityIndex,
  selectCompatibilityDescriptorId
} from './msfs/runtime/loader'
import { AircraftCompatibilityRuntime } from './msfs/runtime/host'
import { applyCompatibilityRuntimeState } from './msfs/runtime/renderer'

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')

const CESIUM_ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN || ''
const ASSET_ID = '2275207'

function getJapanMiddayDate(reference = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(reference)

  const year = parts.find(part => part.type === 'year')?.value
  const month = parts.find(part => part.type === 'month')?.value
  const day = parts.find(part => part.type === 'day')?.value

  if (!year || !month || !day) {
    return reference
  }

  return new Date(`${year}-${month}-${day}T12:00:00+09:00`)
}

const date = getJapanMiddayDate()
const longitude = 144.8379
const latitude = -37.6707
const height = 0
const heading = 352
const pitch = -14
const distance = 3500
const ymmlRunway34 = {
  thresholdLatitude: -37.685789,
  thresholdLongitude: 144.840994,
  thresholdElevationMeters: 432 * 0.3048,
  headingDegrees: 351.4
} as const
const spawnDistanceFromThresholdMeters = 5000
const spawnGlideSlopeDegrees = 3
const spawnAirspeedMps = 75
const planeModelRotation = new Vector3((3 * Math.PI) / 2, Math.PI / 2, 0)

interface PlaneModelSource {
  modelUrl: string
  textureManifestUrl?: string | null
  normalizeSourceAsset?: boolean
}

interface PlaneModelLoadOptions {
  preserveModelOrigin: boolean
  targetWingSpanM?: number
  visualOffsetBodyMeters?: Vector3
}

function resolvePlaneModelSources(
  compatibilityDescriptor: AircraftCompatibilityDescriptor | null
): readonly PlaneModelSource[] {
  if (!compatibilityDescriptor) return []

  return [...compatibilityDescriptor.modelSources]
    .sort(compareCompatibilityModelSources)
    .map((source) => ({
      modelUrl: source.modelUrl,
      textureManifestUrl: source.textureManifestUrl ?? null,
      normalizeSourceAsset: source.normalizeSourceAsset
    }))
}

function compareCompatibilityModelSources(
  left: AircraftCompatibilityDescriptor['modelSources'][number],
  right: AircraftCompatibilityDescriptor['modelSources'][number]
): number {
  const roleDelta = modelRolePriority(left.role) - modelRolePriority(right.role)
  if (roleDelta !== 0) return roleDelta

  const minSizeDelta = (right.minSize ?? -Infinity) - (left.minSize ?? -Infinity)
  if (minSizeDelta !== 0) return minSizeDelta

  return left.modelPath.localeCompare(right.modelPath)
}

function modelRolePriority(role: string): number {
  switch (role.toLowerCase()) {
    case 'normal':
    case 'exterior':
      return 0
    case 'interior':
      return 1
    default:
      return 2
  }
}

class TileMaterialReplacementPlugin {
  tiles = undefined
  overrideMaterial = MeshBasicNodeMaterial

  constructor(Material = MeshBasicNodeMaterial) {
    this.overrideMaterial = Material
  }

  init(tiles) {
    this.tiles = tiles
    tiles.group.traverse(object => {
      if (object.isMesh) this.replaceMaterial(object)
    })
    tiles.addEventListener('load-model', this.handleLoadModel)
    tiles.addEventListener('dispose-model', this.handleDisposeModel)
  }

  replaceMaterial(mesh) {
    const material = mesh.material
    const nodeMaterial = new this.overrideMaterial()
    if (material.map && 'map' in nodeMaterial) {
      nodeMaterial.map = material.map.clone()
    }
    mesh.material = nodeMaterial
    material.dispose()
  }

  handleLoadModel = ({ scene }) => {
    scene.traverse(object => {
      if (object.isMesh) this.replaceMaterial(object)
    })
  }

  handleDisposeModel = ({ scene }) => {
    scene.traverse(object => {
      if (object.isMesh && object.material) object.material.dispose()
    })
  }

  dispose() {
    this.tiles?.removeEventListener('load-model', this.handleLoadModel)
    this.tiles?.removeEventListener('dispose-model', this.handleDisposeModel)
  }
}

function loadPlaneModel(
  plane: Plane,
  renderer: WebGPURenderer,
  modelSources: readonly PlaneModelSource[],
  options: PlaneModelLoadOptions,
  onAnimations?: (state: MsfsAnimationState, model: Object3D) => void
): void {
  void loadPlaneModelWithFallback(plane, renderer, modelSources, options, onAnimations)
}

async function loadPlaneModelWithFallback(
  plane: Plane,
  renderer: WebGPURenderer,
  modelSources: readonly PlaneModelSource[],
  options: PlaneModelLoadOptions,
  onAnimations?: (state: MsfsAnimationState, model: Object3D) => void
): Promise<void> {
  if (modelSources.length === 0) {
    console.warn('[msfs] no plane model sources are available for the selected aircraft')
    return
  }

  let lastError: unknown = null

  for (const source of modelSources) {
    const modelUrl = new URL(source.modelUrl, window.location.href)
    const manifest =
      source.textureManifestUrl === null
        ? null
        : await fetch(
            source.textureManifestUrl
              ? new URL(source.textureManifestUrl, window.location.href).href
              : new URL('texture-manifest.json', modelUrl).href
          )
            .then(async response => {
              if (!response.ok) return null
              return (await response.json()) as { available?: string[] }
            })
            .catch(() => null)

    const availableTextures =
      manifest?.available && manifest.available.length > 0
        ? new Set(manifest.available)
        : undefined
    const loader = createMsfsGltfLoader(
      renderer,
      availableTextures ? { availableTextures } : undefined
    )

    try {
      const gltf = source.normalizeSourceAsset
        ? await loadNormalizedMsfsSourceGltf(loader, modelUrl.href)
        : await new Promise<any>((resolve, reject) => {
            loader.load(modelUrl.href, resolve, undefined, reject)
          })

      applyMsfsExtensions(gltf)
      const animationState = setupMsfsAnimations(gltf)
      const model = gltf.scene
      if (!model) {
        throw new Error('[msfs] glTF scene is missing')
      }

      model.rotation.set(
        planeModelRotation.x,
        planeModelRotation.y,
        planeModelRotation.z
      )
      model.updateMatrixWorld(true)

      if (!options.preserveModelOrigin) {
        const bounds = computeBoundsFromGeometry(model)
        const size = bounds.getSize(new Vector3())
        const maxDim = Math.max(size.x, size.y, size.z)
        if (options.targetWingSpanM && Number.isFinite(maxDim) && maxDim > 0) {
          const scale = options.targetWingSpanM / maxDim
          model.scale.setScalar(scale)
          model.updateMatrixWorld(true)

          const scaledBounds = computeBoundsFromGeometry(model)
          const center = scaledBounds.getCenter(new Vector3())
          if (
            Number.isFinite(center.x) &&
            Number.isFinite(center.y) &&
            Number.isFinite(center.z)
          ) {
            model.position.sub(center)
          } else {
            console.warn('[msfs] invalid center; skipping recenter')
          }
        } else {
          console.warn('[msfs] invalid bounds; skipping scale/center')
        }
      }

      if (options.visualOffsetBodyMeters) {
        model.position.add(options.visualOffsetBodyMeters)
      }

      forceVisibleAndBounds(model)
      prepareAircraftMaterials(model)
      plane.setVisual(model)
      onAnimations?.(animationState, model)
      console.info('[msfs] loaded plane model from', modelUrl.pathname)
      return
    } catch (error) {
      lastError = error
      console.warn('[msfs] failed to load plane model from', modelUrl.pathname, error)
    }
  }

  console.error('[msfs] unable to load any plane model candidate', lastError)
}

function forceVisibleAndBounds(root: Object3D): void {
  root.updateMatrixWorld(true)
  root.traverse(object => {
    if (!('isMesh' in object) || !object.isMesh) return
    const mesh = object as Mesh
    mesh.visible = true
    mesh.frustumCulled = false
    const geometry = mesh.geometry
    if (geometry && !geometry.boundingBox) geometry.computeBoundingBox()
    if (geometry && !geometry.boundingSphere) geometry.computeBoundingSphere()
    if ((mesh as SkinnedMesh).isSkinnedMesh) {
      const skinned = mesh as SkinnedMesh
      skinned.normalizeSkinWeights()
      skinned.skeleton?.update()
    }
  })
}

function computeBoundsFromGeometry(root: Object3D): Box3 {
  root.updateMatrixWorld(true)
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert()
  const bounds = new Box3()
  const temp = new Box3()
  let hasBounds = false

  root.traverse(object => {
    if (!('isMesh' in object) || !object.isMesh) return
    const mesh = object as Mesh
    const geometry = mesh.geometry
    const position = geometry?.attributes?.position
    if (!position || position.count === 0) return
    temp.setFromBufferAttribute(position)
    temp.applyMatrix4(mesh.matrixWorld)
    temp.applyMatrix4(rootInverse)
    if (!hasBounds) {
      bounds.copy(temp)
      hasBounds = true
    } else {
      bounds.union(temp)
    }
  })

  return bounds
}

function prepareAircraftMaterials(root: Object3D): void {
  const emptyLiveryOverlayPattern = /^(?:LIVERY(?:\d+)?|LIVERY_TEXTS(?:\d+)?)$/
  const hiddenMaterialNames = new Set(['FROST', 'FROST_BLAST'])

  root.traverse(object => {
    if (!('isMesh' in object) || !object.isMesh) return
    const mesh = object as Mesh
    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const clonedMaterials = sourceMaterials.map(material => material?.clone?.() ?? material)
    mesh.material = Array.isArray(mesh.material) ? clonedMaterials : clonedMaterials[0]
    let hideMesh = sourceMaterials.length > 0
    const drawOrderOffset = sourceMaterials.reduce((maxOffset, material) => {
      const offset =
        typeof material?.userData?.asoboDrawOrderOffset === 'number'
          ? material.userData.asoboDrawOrderOffset
          : 0
      return Math.max(maxOffset, offset)
    }, 0)

    for (const [index, material] of sourceMaterials.entries()) {
      if (!material) continue
      const targetMaterial = clonedMaterials[index]
      if (!targetMaterial) continue

      const hasMap = 'map' in material && material.map != null
      const materialDrawOrderOffset =
        typeof material.userData?.asoboDrawOrderOffset === 'number'
          ? material.userData.asoboDrawOrderOffset
          : 0
      const hasAlphaTexture =
        !!('alphaMap' in material && material.alphaMap != null) ||
        hasMap
      const isAlphaBlendMaterial = material.transparent || material.alphaTest > 0
      const shouldHideEmptyOverlay =
        !hasMap &&
        (emptyLiveryOverlayPattern.test(material.name) ||
          (materialDrawOrderOffset > 0 && isAlphaBlendMaterial))
      const suppressBaseColorLayer =
        material.userData?.asoboBlendGBuffer?.baseColorBlendFactor === 0
      const shouldHideFrostLayer =
        material.userData?.asoboMaterialCode === 'GeoDecalFrosted' ||
        hiddenMaterialNames.has(material.name)
      hideMesh &&=
        shouldHideEmptyOverlay || suppressBaseColorLayer || shouldHideFrostLayer

      targetMaterial.side = FrontSide

      if (shouldHideEmptyOverlay || suppressBaseColorLayer || shouldHideFrostLayer) {
        targetMaterial.transparent = true
        targetMaterial.opacity = 0
        targetMaterial.alphaTest = 0
        targetMaterial.depthWrite = false
      } else if (material.transparent || material.alphaTest > 0) {
        targetMaterial.transparent = true
        targetMaterial.opacity = material.opacity
        targetMaterial.alphaTest = material.alphaTest
        targetMaterial.depthWrite = false
      } else {
        targetMaterial.transparent = false
        targetMaterial.opacity = 1
        targetMaterial.alphaTest = 0
        targetMaterial.depthWrite = true
      }

      if (materialDrawOrderOffset > 0) {
        targetMaterial.polygonOffset = true
        targetMaterial.polygonOffsetFactor = -materialDrawOrderOffset
        targetMaterial.polygonOffsetUnits = -materialDrawOrderOffset
      }

      targetMaterial.needsUpdate = true
    }

    mesh.visible = !hideMesh

    if (drawOrderOffset > 0) {
      mesh.renderOrder += drawOrderOffset
    }
  })
}

async function init(): Promise<() => void> {
  const renderer = new WebGPURenderer()
  renderer.highPrecision = true

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  document.body.appendChild(renderer.domElement)
  await renderer.init()

  const aspect = window.innerWidth / window.innerHeight
  const camera = new PerspectiveCamera(75, aspect)

  new PointOfView(distance, radians(heading), radians(pitch)).decompose(
    new Geodetic(radians(longitude), radians(latitude), height).toECEF(),
    camera.position,
    camera.quaternion,
    camera.up
  )

  const context = new AtmosphereContextNode()
  context.camera = camera

  const scene = new Scene()

  renderer.library.addLight(AtmosphereLightNode, AtmosphereLight)

  const light = new AtmosphereLight(context)
  scene.add(light)

  const tiles = new TilesRenderer(
    `https://assets.cesium.com/${ASSET_ID}/tileset.json`
  )
  tiles.setCamera(camera)
  tiles.setResolutionFromRenderer(camera, renderer as any)
  tiles.registerPlugin(
    new CesiumIonAuthPlugin({
      apiToken: CESIUM_ION_TOKEN,
      assetId: ASSET_ID,
      autoRefreshToken: true
    })
  )
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader }))
  tiles.registerPlugin(new TileCompressionPlugin())
  tiles.registerPlugin(new UpdateOnChangePlugin())
  tiles.registerPlugin(new TileMaterialReplacementPlugin(MeshBasicNodeMaterial))
  tiles.registerPlugin(new TilesFadePlugin())
  scene.add(tiles.group)

  const controls = new GlobeControls(scene, camera, renderer.domElement)
  controls.enableDamping = true

  controls.adjustHeight = false
  controls.addEventListener('start', () => {
    controls.adjustHeight = true
  })

  const compatibilityDescriptorId = await loadCompatibilityIndex()
    .then((entries) => selectCompatibilityDescriptorId(entries, new URLSearchParams(window.location.search)))
    .catch((error) => {
      console.warn('[msfs] failed to load compatibility index', error)
      return undefined
    })
  const compatibilityDescriptor = compatibilityDescriptorId
    ? await loadCompatibilityDescriptor(compatibilityDescriptorId).catch((error) => {
        console.warn('[msfs] failed to load compatibility descriptor', error)
        return null
      })
    : null
  const compatibilityRuntime = compatibilityDescriptor
    ? new AircraftCompatibilityRuntime(compatibilityDescriptor)
    : null
  const { aircraftParams: planeParams, visualOffsetBodyMeters } =
    hydrateCompatibilityAircraftParams(compatibilityDescriptor?.physics)
  const planeModelSources = resolvePlaneModelSources(compatibilityDescriptor)
  const useCompatibilityModelPath =
    compatibilityDescriptor != null && planeModelSources.length > 0
  if (compatibilityDescriptor && planeModelSources.length === 0) {
    const modelDiagnostics = compatibilityDescriptor.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === 'model_lod_missing' || diagnostic.code === 'model_assets_unavailable'
    )
    if (modelDiagnostics.length > 0) {
      for (const diagnostic of modelDiagnostics) {
        console.warn(
          '[msfs]',
          diagnostic.message,
          diagnostic.file ? `(${diagnostic.file})` : ''
        )
      }
    } else {
      console.warn('[msfs] compatibility descriptor has no loadable model assets')
    }
  }
  const keyboard = new KeyboardFlightControls(
    window,
    planeParams.configuration?.flapDetents01,
    planeParams.configuration?.defaultFlapDetentIndex
  )
  const hud = new FlightHud()
  const compatibilityDock = compatibilityDescriptor && compatibilityRuntime
    ? new MsfsCompatibilityDock(compatibilityDescriptor, compatibilityRuntime.runtimeId)
    : null
  const compatibilityChannel = compatibilityRuntime
    ? new BroadcastChannel(compatibilityChannelName(compatibilityRuntime.runtimeId))
    : null
  if (compatibilityRuntime && compatibilityChannel) {
    compatibilityChannel.onmessage = (
      event: MessageEvent<CompatibilityBridgeMessage>
    ) => {
      if (event.data.type === 'set-variable') {
        compatibilityRuntime.setVariable(event.data.reference, event.data.value)
        return
      }
      if (event.data.type === 'emit-event') {
        compatibilityRuntime.emitEvent(event.data.event, event.data.payload)
        return
      }
      if (event.data.type === 'dispatch-interaction') {
        compatibilityRuntime.dispatchInteraction(event.data.bindingId)
      }
    }
  }

  const plane = new Plane(planeParams)
  scene.add(plane.mesh)
  const controlsAny = controls as any
  const originalSetState = controlsAny.setState?.bind(controlsAny)
  const DRAG = 1
  const ROTATE = 2
  controlsAny.setState = (state = controlsAny.state, fireEvent = true) => {
    if (keyboard.isFollowEnabled() && state === DRAG) {
      state = ROTATE
    }
    return originalSetState ? originalSetState(state, fireEvent) : undefined
  }
  const originalRaycast = controlsAny._raycast?.bind(controlsAny)
  controlsAny._raycast = (raycaster: any) => {
    if (keyboard.isFollowEnabled()) {
      const point = plane.positionECEF.clone()
      const distance = raycaster.ray.origin.distanceTo(point)
      return { point, distance }
    }
    return originalRaycast ? originalRaycast(raycaster) : null
  }
  let planeAnimationState: MsfsAnimationState | null = null
  let wheelCycle01 = 0
  let lastRenderTimeMs = 0
  let lastCompatibilityPublishTimeMs = 0
  loadPlaneModel(
    plane,
    renderer,
    planeModelSources,
    {
      preserveModelOrigin: useCompatibilityModelPath,
      targetWingSpanM: useCompatibilityModelPath ? undefined : plane.params.wingSpanM,
      visualOffsetBodyMeters: useCompatibilityModelPath ? visualOffsetBodyMeters : undefined
    },
    (state, model) => {
      planeAnimationState = state
      if (!model) return
      wheelCycle01 = 0
      lastRenderTimeMs = 0
      lastCompatibilityPublishTimeMs = 0
    }
  )

  const spawnFrame = new NedFrame()
  const bodyToNedMatrix = new Matrix4()
  const qBodyToNed = new Quaternion()
  const qBodyToEcef = new Quaternion()
  const forwardNed = new Vector3()
  const rightNed = new Vector3()
  const downNed = new Vector3(0, 0, 1)
  const spawnPositionEcef = new Vector3()
  const runwayThresholdEcef = new Vector3()
  const spawnOffsetNed = new Vector3()
  const spawnVelocityEcef = new Vector3()
  const spawnVelocityNed = new Vector3()

  const resetPlane = (): void => {
    runwayThresholdEcef.copy(
      new Geodetic(
        radians(ymmlRunway34.thresholdLongitude),
        radians(ymmlRunway34.thresholdLatitude),
        ymmlRunway34.thresholdElevationMeters
      ).toECEF()
    )
    spawnFrame.updateFromECEF(runwayThresholdEcef)

    const yaw = radians(ymmlRunway34.headingDegrees)
    forwardNed.set(Math.cos(yaw), Math.sin(yaw), 0).normalize()
    rightNed.crossVectors(downNed, forwardNed).normalize()

    bodyToNedMatrix.makeBasis(forwardNed, rightNed, downNed)
    qBodyToNed.setFromRotationMatrix(bodyToNedMatrix)
    qBodyToEcef.multiplyQuaternions(spawnFrame.qNedToEcef, qBodyToNed).normalize()

    spawnOffsetNed.copy(forwardNed).multiplyScalar(-spawnDistanceFromThresholdMeters)
    spawnOffsetNed.z =
      -Math.tan(radians(spawnGlideSlopeDegrees)) * spawnDistanceFromThresholdMeters

    spawnPositionEcef
      .copy(spawnOffsetNed)
      .applyMatrix3(spawnFrame.nedToEcef)
      .add(runwayThresholdEcef)

    spawnVelocityNed.copy(forwardNed).multiplyScalar(spawnAirspeedMps)
    spawnVelocityEcef.copy(spawnVelocityNed).applyMatrix3(spawnFrame.nedToEcef)

    plane.resetTo(spawnPositionEcef, spawnVelocityEcef, qBodyToEcef)
  }
  resetPlane()

  const passNode = pass(scene, camera, { samples: 0 }).setMRT(
    mrt({ output: diffuseColor, normal: normalView, velocity: highpVelocity })
  )
  const colorNode = passNode.getTextureNode('output')
  const depthNode = passNode.getTextureNode('depth')
  const normalNode = passNode.getTextureNode('normal')
  const velocityNode = passNode.getTextureNode('velocity')

  const aerialNode = aerialPerspective(
    context,
    colorNode,
    depthNode,
    normalNode
  )
  const lensFlareNode = lensFlare(aerialNode)
  const toneMappingNode = toneMapping(AgXToneMapping, uniform(5), lensFlareNode)
  const taaNode = temporalAntialias(highpVelocity)(
    toneMappingNode,
    depthNode,
    velocityNode,
    camera
  )

  const postProcessing = new PostProcessing(renderer)
  postProcessing.outputNode = taaNode.add(dithering)

  const sim = new FixedStepLoop(1 / 120)
  let latest = plane.step(0)

  const chaseOffsetBody = new Vector3(-90, 0, -30)
  const chaseOffsetEcef = new Vector3()
  const chaseTarget = new Vector3()
  const planeForwardEcef = new Vector3()
  const upEcef = new Vector3()
  const followAnchorEcef = new Vector3()

  const observerECEF = new Vector3()
  void renderer.setAnimationLoop((timeMs: number) => {
    if (keyboard.consumeToggleFollowRequested()) {
      if (keyboard.isFollowEnabled()) {
        followAnchorEcef.copy(plane.positionECEF)
      }
    }

    controls.enabled = true
    controls.update()

    sim.tick(timeMs, dtSeconds => {
      if (keyboard.consumeResetRequested()) resetPlane()
      plane.setControls(keyboard.update(dtSeconds))
      latest = plane.step(dtSeconds)
    })

    const frameDeltaSeconds =
      lastRenderTimeMs === 0 ? 0 : Math.max(0, (timeMs - lastRenderTimeMs) / 1000)
    lastRenderTimeMs = timeMs

    const tireCircumferenceMeters = 4.25
    wheelCycle01 =
      (wheelCycle01 +
        Math.max(0, latest.airspeedMps ?? 0) * frameDeltaSeconds / tireCircumferenceMeters) %
      1

    const visualState = plane.getVisualState()
    compatibilityRuntime?.tick({
      dtSeconds: frameDeltaSeconds,
      elapsedSeconds: timeMs / 1000,
      wheelCycle01,
      visualState,
      telemetry: latest,
      angularRatesBodyRadPerSec: {
        x: plane.omegaBodyRadPerSec.x,
        y: plane.omegaBodyRadPerSec.y,
        z: plane.omegaBodyRadPerSec.z
      }
    })

    if (planeAnimationState?.mixer) {
      applyMsfsAircraftAnimationState(planeAnimationState, visualState, wheelCycle01)
      if (compatibilityRuntime) {
        applyCompatibilityRuntimeState(planeAnimationState, compatibilityRuntime)
      }
    }

    if (
      compatibilityRuntime &&
      compatibilityChannel &&
      timeMs - lastCompatibilityPublishTimeMs >= 125
    ) {
      const snapshot = compatibilityRuntime.createBridgeSnapshot()
      compatibilityChannel.postMessage({
        type: 'snapshot',
        snapshot
      } satisfies CompatibilityBridgeMessage)
      compatibilityDock?.update(snapshot)
      lastCompatibilityPublishTimeMs = timeMs
    }

    if (keyboard.isFollowEnabled()) {
      chaseOffsetEcef
        .copy(chaseOffsetBody)
        .applyQuaternion(plane.orientationBodyToECEF)
      if (followAnchorEcef.lengthSq() === 0) {
        camera.position.copy(plane.positionECEF).add(chaseOffsetEcef)
        followAnchorEcef.copy(plane.positionECEF)
      } else {
        const delta = plane.positionECEF.clone().sub(followAnchorEcef)
        camera.position.add(delta)
        followAnchorEcef.copy(plane.positionECEF)
      }

      Ellipsoid.WGS84.getSurfaceNormal(plane.positionECEF, upEcef)
      camera.up.copy(upEcef)

      controls.pivotPoint.copy(plane.positionECEF)
      controls.zoomPoint.copy(plane.positionECEF)
      controls.zoomPointSet = true
      controls._zoomPointWasSet = true
      controls.pivotMesh.position.copy(plane.positionECEF)
      controls.pivotMesh.visible = true
      camera.lookAt(plane.positionECEF)
    }

    camera.updateMatrixWorld()
    observerECEF.setFromMatrixPosition(camera.matrixWorld)

    const matrixECIToECEF = getECIToECEFRotationMatrix(
      date,
      context.matrixECIToECEF.value
    )
    getSunDirectionECI(
      date,
      context.sunDirectionECEF.value,
      observerECEF
    ).applyMatrix4(matrixECIToECEF)
    getMoonDirectionECI(
      date,
      context.moonDirectionECEF.value,
      observerECEF
    ).applyMatrix4(matrixECIToECEF)

    tiles.setCamera(camera)
    tiles.setResolutionFromRenderer(camera, renderer as any)
    tiles.update()

    hud.update(latest, keyboard.isFollowEnabled())
    postProcessing.render()
  })

  const handleResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  }
  window.addEventListener('resize', handleResize)

  return () => {
    window.removeEventListener('resize', handleResize)
    postProcessing.dispose()
    taaNode.dispose()
    lensFlareNode.dispose()
    aerialNode.dispose()
    passNode.dispose()
    controls.dispose()
    tiles.dispose()
    context.dispose()
    keyboard.dispose()
    hud.dispose()
    compatibilityChannel?.close()
    compatibilityDock?.dispose()
    renderer.dispose()
  }
}

init().catch(console.error)
