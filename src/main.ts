import { GlobeControls, TilesRenderer } from '3d-tiles-renderer'
import {
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  UpdateOnChangePlugin
} from '3d-tiles-renderer/plugins'
import {
  AgXToneMapping,
  BufferAttribute,
  Box3,
  FrontSide,
  Matrix4,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Vector4,
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
import { FixedStepLoop } from './sim/FixedStepLoop'
import { NedFrame } from './sim/NedFrame'
import { flyByWireA320AircraftParams } from './sim/FlyByWireA320'
import { A320VisualAnimator } from './visual/A320VisualAnimator'
import {
  applyMsfsAircraftAnimationState,
  applyMsfsExtensions,
  createMsfsGltfLoader,
  hasNativeAircraftAnimations,
  setupMsfsAnimations,
  type MsfsAnimationState
} from './helpers/msfsGltf'
import { loadNormalizedMsfsSourceGltf } from './helpers/msfsSourceGltf'

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
const planeModelSources = [
  {
    modelUrl: '/vendor/fbw-a32nx/model/A320_NEO_LOD00.gltf',
    albedoTextureBaseUrl: '/aircraft/a32nx/exterior/LOD00-msfs/',
    normalizeSourceAsset: true
  }
] as const
const planeModelRotation = new Vector3((3 * Math.PI) / 2, Math.PI / 2, 0)

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
  onAnimations?: (state: MsfsAnimationState, model: Object3D) => void
): void {
  void loadPlaneModelWithFallback(plane, renderer, planeModelSources, onAnimations)
}

async function loadPlaneModelWithFallback(
  plane: Plane,
  renderer: WebGPURenderer,
  modelSources: readonly {
    modelUrl: string
    albedoTextureBaseUrl?: string
    textureManifestUrl?: string
    normalizeSourceAsset?: boolean
  }[],
  onAnimations?: (state: MsfsAnimationState, model: Object3D) => void
): Promise<void> {
  let lastError: unknown = null

  for (const source of modelSources) {
    const modelUrl = new URL(source.modelUrl, window.location.href)
    const manifestUrl = source.textureManifestUrl
      ? new URL(source.textureManifestUrl, window.location.href).href
      : new URL('texture-manifest.json', modelUrl).href

    const manifest = await fetch(manifestUrl)
      .then(async response => {
        if (!response.ok) return null
        return (await response.json()) as { available?: string[] }
      })
      .catch(() => null)

    const available = new Set(manifest?.available ?? [])
    const loader = createMsfsGltfLoader(renderer, {
      availableTextures: available
    })

    try {
      const gltf = source.normalizeSourceAsset
        ? await loadNormalizedMsfsSourceGltf(
            loader,
            modelUrl.href,
            new URL(
              source.albedoTextureBaseUrl ?? '/aircraft/a32nx/exterior/LOD00-msfs/',
              window.location.href
            ).href
          )
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

      const bounds = computeBoundsFromGeometry(model)
      const size = bounds.getSize(new Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const targetSpan = plane.params.wingSpanM
      if (Number.isFinite(maxDim) && maxDim > 0) {
        const scale = targetSpan / maxDim
        model.scale.setScalar(scale)
        model.updateMatrixWorld(true)

        const scaledBounds = computeBoundsFromGeometry(model)
        const center = scaledBounds.getCenter(new Vector3())
        if (Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z)) {
          model.position.sub(center)
        } else {
          console.warn('[msfs] invalid center; skipping recenter')
        }
      } else {
        console.warn('[msfs] invalid bounds; skipping scale/center')
      }

      forceVisibleAndBounds(model)
      repairAircraftGeometry(model)
      const initialVisualState = plane.getVisualState()
      applyMsfsAircraftAnimationState(
        animationState,
        initialVisualState,
        0,
        plane.params.configuration?.flapVisualSchedule
      )
      bindMsfsAnimatedControlSurfaceNodes(
        model,
        object => !NATIVE_OUTBOARD_FLAP_PATTERN.test(object.name)
      )
      applyMsfsAircraftAnimationState(
        animationState,
        { ...initialVisualState, flaps01: 0 },
        0,
        plane.params.configuration?.flapVisualSchedule
      )
      bindMsfsAnimatedControlSurfaceNodes(
        model,
        object => NATIVE_OUTBOARD_FLAP_PATTERN.test(object.name)
      )
      applyMsfsAircraftAnimationState(
        animationState,
        initialVisualState,
        0,
        plane.params.configuration?.flapVisualSchedule
      )
      updateMsfsAnimatedControlSurfaceNodes(model)
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
      applyFallbackExteriorPbr(targetMaterial, material.name)

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

function applyFallbackExteriorPbr(material: any, materialName: string): void {
  if (!('metalness' in material) || !('roughness' in material)) {
    return
  }

  const hasMetalnessMap =
    'metalnessMap' in material && material.metalnessMap != null
  const hasRoughnessMap =
    'roughnessMap' in material && material.roughnessMap != null
  if (hasMetalnessMap || hasRoughnessMap) {
    return
  }

  const fallback = fallbackExteriorPbrByMaterialName[materialName]
  if (!fallback) {
    return
  }

  material.metalness = fallback.metalness
  material.roughness = fallback.roughness
}

const fallbackExteriorPbrByMaterialName: Record<
  string,
  { metalness: number; roughness: number }
> = {
  FUSELAGE: { metalness: 0.02, roughness: 0.78 },
  WINGS: { metalness: 0.02, roughness: 0.78 },
  'WINGS DETAILS': { metalness: 0.04, roughness: 0.8 },
  ENGINES: { metalness: 0.15, roughness: 0.7 },
  FRONTLANDING: { metalness: 0.18, roughness: 0.72 },
  REARLANDING: { metalness: 0.18, roughness: 0.72 },
  Passenger_Door: { metalness: 0.02, roughness: 0.8 },
  METALFLAPS: { metalness: 0.06, roughness: 0.72 }
}

function repairAircraftGeometry(root: Object3D): void {
  root.traverse(object => {
    if (!('isMesh' in object) || !object.isMesh) return

    const mesh = object as Mesh
    if (!shouldFlipMeshWinding(mesh.name)) {
      return
    }

    const geometry = mesh.geometry.clone()
    flipGeometryWinding(geometry)
    geometry.deleteAttribute('tangent')
    if (shouldRecomputeMeshNormals(mesh.name)) {
      geometry.deleteAttribute('normal')
      geometry.computeVertexNormals()
    }
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    mesh.geometry = geometry
  })
}

interface MsfsAnimatedHelperBinding {
  readonly name: string
  readonly weight: number
}

interface MsfsAnimatedSurfaceBinding {
  readonly pivot: Object3D
  readonly helpers: Array<{ object: Object3D; weight: number }>
}

function bindMsfsAnimatedControlSurfaceNodes(
  root: Object3D,
  predicate: (object: Object3D) => boolean = () => true
): void {
  root.updateMatrixWorld(true)

  const surfacesToBind: Array<{
    object: Object3D
    helpers: Array<{ object: Object3D; weight: number }>
  }> = []

  root.traverse(object => {
    if (!predicate(object)) return
    const helperBindings = resolveAnimatedHelperBindings(root, object)
    if (helperBindings.length === 0) return
    surfacesToBind.push({ object, helpers: helperBindings })
  })

  const surfaceBindings =
    (root.userData.msfsAnimatedSurfaceBindings as MsfsAnimatedSurfaceBinding[] | undefined) ?? []
  for (const surface of surfacesToBind) {
    const pivot = new Object3D()
    pivot.name = `msfs_anim_${surface.object.name}`
    root.add(pivot)

    applyWeightedHelperTransform(root, pivot, surface.helpers)
    pivot.attach(surface.object)
    surfaceBindings.push({ pivot, helpers: surface.helpers })
  }

  root.userData.msfsAnimatedSurfaceBindings = surfaceBindings

  root.updateMatrixWorld(true)
}

function updateMsfsAnimatedControlSurfaceNodes(root: Object3D): void {
  const surfaceBindings = root.userData?.msfsAnimatedSurfaceBindings as
    | MsfsAnimatedSurfaceBinding[]
    | undefined
  if (!Array.isArray(surfaceBindings) || surfaceBindings.length === 0) return

  root.updateMatrixWorld(true)
  for (const binding of surfaceBindings) {
    applyWeightedHelperTransform(root, binding.pivot, binding.helpers)
  }
  root.updateMatrixWorld(true)
}

function resolveAnimatedHelperBindings(
  root: Object3D,
  surface: Object3D
): Array<{ object: Object3D; weight: number }> {
  if (NATIVE_FLAP_SKIP_PATTERN.test(surface.name)) {
    return []
  }

  const helperBindings = surface.userData?.msfsAnimationHelpers as
    | MsfsAnimatedHelperBinding[]
    | undefined
  if (!Array.isArray(helperBindings)) return []

  const resolvedBindings: Array<{ object: Object3D; weight: number }> = []
  for (const helperBinding of helperBindings) {
    if (
      !helperBinding ||
      typeof helperBinding.name !== 'string' ||
      !Number.isFinite(helperBinding.weight) ||
      helperBinding.weight <= 0
    ) {
      continue
    }

    const helper = root.getObjectByName(helperBinding.name)
    if (!helper || helper === surface) continue
    resolvedBindings.push({ object: helper, weight: helperBinding.weight })
  }

  const totalWeight = resolvedBindings.reduce((sum, binding) => sum + binding.weight, 0)
  if (totalWeight <= 0) return []
  return resolvedBindings.map(binding => ({
    object: binding.object,
    weight: binding.weight / totalWeight
  }))
}

const blendedPositionScratch = new Vector3()
const blendedQuaternionScratch = new Quaternion()
const helperWorldPositionScratch = new Vector3()
const helperWorldQuaternionScratch = new Quaternion()
const rootWorldQuaternionScratch = new Quaternion()
const blendedQuaternionVectorScratch = new Vector4()
const helperQuaternionVectorScratch = new Vector4()
const NATIVE_FLAP_SKIP_PATTERN = /^(?:x0_)?FLAPS_01_(?:LEFT|RIGHT)$/
const NATIVE_OUTBOARD_FLAP_PATTERN = /^(?:x0_)?FLAPS_02_(?:LEFT|RIGHT)$/

function applyWeightedHelperTransform(
  root: Object3D,
  pivot: Object3D,
  helpers: Array<{ object: Object3D; weight: number }>
): void {
  if (helpers.length === 0) return

  blendedPositionScratch.set(0, 0, 0)
  blendedQuaternionVectorScratch.set(0, 0, 0, 0)
  let referenceQuaternion: Quaternion | null = null

  for (const helper of helpers) {
    helper.object.getWorldPosition(helperWorldPositionScratch)
    blendedPositionScratch.addScaledVector(helperWorldPositionScratch, helper.weight)

    helper.object.getWorldQuaternion(helperWorldQuaternionScratch)
    if (referenceQuaternion == null) {
      referenceQuaternion = helperWorldQuaternionScratch.clone()
    } else if (referenceQuaternion.dot(helperWorldQuaternionScratch) < 0) {
      helperWorldQuaternionScratch.set(
        -helperWorldQuaternionScratch.x,
        -helperWorldQuaternionScratch.y,
        -helperWorldQuaternionScratch.z,
        -helperWorldQuaternionScratch.w
      )
    }

    helperQuaternionVectorScratch.set(
      helperWorldQuaternionScratch.x,
      helperWorldQuaternionScratch.y,
      helperWorldQuaternionScratch.z,
      helperWorldQuaternionScratch.w
    )
    blendedQuaternionVectorScratch.addScaledVector(
      helperQuaternionVectorScratch,
      helper.weight
    )
  }

  blendedQuaternionScratch.set(
    blendedQuaternionVectorScratch.x,
    blendedQuaternionVectorScratch.y,
    blendedQuaternionVectorScratch.z,
    blendedQuaternionVectorScratch.w
  )
  if (blendedQuaternionScratch.lengthSq() <= 1e-8) {
    blendedQuaternionScratch.identity()
  } else {
    blendedQuaternionScratch.normalize()
  }

  pivot.position.copy(root.worldToLocal(blendedPositionScratch.clone()))
  root.getWorldQuaternion(rootWorldQuaternionScratch)
  pivot.quaternion.copy(rootWorldQuaternionScratch).invert().multiply(blendedQuaternionScratch)
  pivot.updateMatrix()
}

const windingFlipMeshNames = new Set([
  'x0_FUSELAGE',
  'x0_FUSELAGE_1',
  'x0_FUSELAGE_4',
  'x0_LIVERY_OFFICIAL_FUSELAGE',
  'x0_LIVERY_OFFICIAL_FUSELAGE_1',
  'x0_LIVERY_OFFICIAL_FUSELAGE_2',
  'x0_LIVERY_OFFICIAL_FUSELAGE_3',
  'x0_DOOR_PASSENGER',
  'x0_DOOR_PASSENGER_1',
  'x0_DOOR_REAR',
  'x0_DOOR_REAR_3',
  'x0_PASSENGER_DOOR',
  'x0_PASSENGER_DOOR_1',
  'LIVERY_OFFICIAL_RDOOR',
  'LIVERY_OFFICIAL_RGEAR',
  'LIVERY_OFFICIAL_LGEAR',
  'R_DOOR03_RIGHT',
  'DOOR03_LEFT',
  'C_DOOR_01_RIGHT',
  'C_DOOR_02_RIGHT',
  'C_DOOR_01_LEFT',
  'C_DOOR_02_LEFT',
  'DOOR02_LEFT',
  'DOOR01_LEFT',
  'DOOR02_RIGHT',
  'DOOR01_RIGHT',
  'x0_WING_LEFT',
  'x0_WING_RIGHT',
  'x0_WING_LEFT_1',
  'x0_WING_RIGHT_1',
  'LIVERY_OFFICIAL_WINGL',
  'LIVERY_OFFICIAL_WINGR',
  'AILERON_LEFT',
  'AILERON_RIGHT',
  'ENGINES',
  'x0_REACTOR_LEFT',
  'x0_REACTOR_RIGHT',
  'x0_REACTOR_BACK_LEFT',
  'x0_REACTOR_BACK_RIGHT',
  'x0_PROP_SLOW_LEFT',
  'x0_PROP_SLOW_RIGHT',
  'x0_PROP_STILL_LEFT',
  'x0_PROP_STILL_RIGHT',
  'PROP_BLURRED_CONE_LEFT',
  'PROP_BLURRED_CONE_RIGHT',
  'TAIL_ELEVATOR_LEFT',
  'TAIL_ELEVATOR_RIGHT',
  'TAIL_ELEVATOR_TRIM_LEFT',
  'TAIL_ELEVATOR_TRIM_RIGHT',
  'TAIL_RUDDER',
  'TAIL_RUDDER_C',
  'LIVERY_OFFICIAL_RUDDER',
  'x0_LIVERY_OFFICIAL_RUDDER',
  'x0_LIVERY_OFFICIAL_RUDDER_1'
])

const normalRecomputeMeshNames = new Set([
  'x0_WING_LEFT',
  'x0_WING_RIGHT',
  'x0_WING_LEFT_1',
  'x0_WING_RIGHT_1',
  'LIVERY_OFFICIAL_WINGL',
  'LIVERY_OFFICIAL_WINGR',
  'LIVERY_OFFICIAL_RGEAR',
  'LIVERY_OFFICIAL_LGEAR',
  'R_DOOR03_RIGHT',
  'DOOR03_LEFT',
  'C_DOOR_01_RIGHT',
  'C_DOOR_02_RIGHT',
  'C_DOOR_01_LEFT',
  'C_DOOR_02_LEFT',
  'DOOR02_LEFT',
  'DOOR01_LEFT',
  'DOOR02_RIGHT',
  'DOOR01_RIGHT',
  'AILERON_LEFT',
  'AILERON_RIGHT',
  'ENGINES',
  'x0_REACTOR_LEFT',
  'x0_REACTOR_RIGHT',
  'x0_REACTOR_BACK_LEFT',
  'x0_REACTOR_BACK_RIGHT',
  'x0_PROP_SLOW_LEFT',
  'x0_PROP_SLOW_RIGHT',
  'x0_PROP_STILL_LEFT',
  'x0_PROP_STILL_RIGHT',
  'PROP_BLURRED_CONE_LEFT',
  'PROP_BLURRED_CONE_RIGHT',
  'TAIL_ELEVATOR_LEFT',
  'TAIL_ELEVATOR_RIGHT',
  'TAIL_ELEVATOR_TRIM_LEFT',
  'TAIL_ELEVATOR_TRIM_RIGHT',
  'TAIL_RUDDER',
  'TAIL_RUDDER_C',
  'LIVERY_OFFICIAL_RUDDER',
  'x0_LIVERY_OFFICIAL_RUDDER',
  'x0_LIVERY_OFFICIAL_RUDDER_1'
])

const windingFlipMeshPrefixes = [
  'WING_FLAP_',
  'WING_FLAPSKRUEGER_',
  'WING_SPOILER_',
  'FLAPSFAIRING_',
  'FLAPSKRUEGER_',
  'FLAPS_',
  'x0_FLAPS_',
  'SPOILER_',
  'x0_SPOILER_',
  'Flaps_Details_'
]

const normalRecomputeMeshPrefixes = [...windingFlipMeshPrefixes]

function shouldFlipMeshWinding(meshName: string): boolean {
  return matchesMeshName(meshName, windingFlipMeshNames, windingFlipMeshPrefixes)
}

function shouldRecomputeMeshNormals(meshName: string): boolean {
  return matchesMeshName(
    meshName,
    normalRecomputeMeshNames,
    normalRecomputeMeshPrefixes
  )
}

function matchesMeshName(
  meshName: string,
  exactNames: ReadonlySet<string>,
  prefixes: readonly string[]
): boolean {
  if (exactNames.has(meshName)) {
    return true
  }

  return prefixes.some(prefix => meshName.startsWith(prefix))
}

function flipGeometryWinding(geometry: Mesh['geometry']): void {
  if (geometry.index) {
    const index = geometry.index.array
    for (let i = 0; i + 2 < index.length; i += 3) {
      const temp = index[i + 1]
      index[i + 1] = index[i + 2]
      index[i + 2] = temp
    }
    geometry.index.needsUpdate = true
    return
  }

  swapTriangleVerticesAcrossAttributes(Object.values(geometry.attributes))
  for (const attributes of Object.values(geometry.morphAttributes)) {
    swapTriangleVerticesAcrossAttributes(attributes)
  }
}

function swapTriangleVerticesAcrossAttributes(
  attributes: Array<BufferAttribute | undefined>
): void {
  for (const attribute of attributes) {
    if (!attribute) continue

    const array = attribute.array
    const itemSize = attribute.itemSize
    for (let vertex = 0; vertex + 2 < attribute.count; vertex += 3) {
      const first = (vertex + 1) * itemSize
      const second = (vertex + 2) * itemSize
      for (let component = 0; component < itemSize; component++) {
        const temp = array[first + component]
        array[first + component] = array[second + component]
        array[second + component] = temp
      }
    }
    attribute.needsUpdate = true
  }
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

  const planeParams = flyByWireA320AircraftParams()
  const keyboard = new KeyboardFlightControls(
    window,
    planeParams.configuration?.flapDetents01,
    planeParams.configuration?.defaultFlapDetentIndex
  )
  const hud = new FlightHud()

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
  let aircraftVisualAnimator: A320VisualAnimator | null = null
  let wheelCycle01 = 0
  let lastRenderTimeMs = 0
  loadPlaneModel(plane, renderer, (state, model) => {
    planeAnimationState = state
    if (!model) return
    const usesNativeAircraftAnimations = hasNativeAircraftAnimations(state)
    aircraftVisualAnimator = new A320VisualAnimator(
      model,
      planeParams.configuration?.flapVisualSchedule ?? {
        detents01: planeParams.configuration?.flapDetents01 ?? [0, 1],
        trailingOutboardDeg: [0, 40],
        trailingInboardDeg: [0, 40],
        leadingDeg: [0, 27]
      },
      usesNativeAircraftAnimations
        ? {
            enableAilerons: false,
            enableElevator: false,
            enableRudder: false,
            enableLeadingEdge: false,
            enableSpoilers: false,
            enableGear: false,
            enableTrailingFlaps: true,
            enableInboardTrailingFlaps: true,
            enableOutboardTrailingFlaps: false
          }
        : undefined
    )
    wheelCycle01 = 0
    lastRenderTimeMs = 0
  })

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

    if (planeAnimationState?.mixer) {
      const frameDeltaSeconds =
        lastRenderTimeMs === 0 ? 0 : Math.max(0, (timeMs - lastRenderTimeMs) / 1000)
      lastRenderTimeMs = timeMs
      const tireCircumferenceMeters = 4.25
      wheelCycle01 =
        (wheelCycle01 +
          Math.max(0, latest.speedMS) * frameDeltaSeconds / tireCircumferenceMeters) %
        1
      applyMsfsAircraftAnimationState(
        planeAnimationState,
        plane.getVisualState(),
        wheelCycle01,
        planeParams.configuration?.flapVisualSchedule
      )
      const planeModel = plane.mesh.children[0]
      if (planeModel) {
        updateMsfsAnimatedControlSurfaceNodes(planeModel)
      }
    } else {
      lastRenderTimeMs = timeMs
    }

    aircraftVisualAnimator?.update(plane.getVisualState())

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
    renderer.dispose()
  }
}

init().catch(console.error)
