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
  BoxGeometry,
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
import { FixedStepLoop } from './sim/FixedStepLoop'
import { b737AircraftParams } from './sim/FlightModel'
import { NedFrame } from './sim/NedFrame'
import {
  applyMsfsExtensions,
  createMsfsGltfLoader,
  setupMsfsAnimations,
  type MsfsAnimationState
} from './helpers/msfsGltf'

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')

const CESIUM_ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN || ''
const ASSET_ID = '2275207'

const date = new Date()
const longitude = 138.5973
const latitude = 35.2138
const height = 0
const heading = 71
const pitch = -31
const distance = 7000
const planeModelUrl = '/aircraft/a32nx/exterior/LOD00-ktx2/A320_NEO_LOD00.gltf'
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
  onAnimations?: (state: MsfsAnimationState) => void
): void {
  const modelUrl = new URL(planeModelUrl, window.location.href)
  const manifestUrl = new URL('texture-manifest.json', modelUrl).href

  void fetch(manifestUrl)
    .then(async response => {
      if (!response.ok) return null
      return (await response.json()) as { available?: string[] }
    })
    .catch(() => null)
    .then(manifest => {
      const available = new Set(manifest?.available ?? [])
      const loader = createMsfsGltfLoader(renderer, {
        availableTextures: available
      })

      loader.load(modelUrl.href, gltf => {
        applyMsfsExtensions(gltf)
        const animationState = setupMsfsAnimations(gltf)
        onAnimations?.(animationState)

        const model = gltf.scene

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
        replaceWithUnlitMaterials(model)
        plane.setVisual(model)
      })
    })
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

  const bounds = new Box3().setFromObject(root)
  const size = bounds.getSize(new Vector3())
  const center = bounds.getCenter(new Vector3())
  const hasSize =
    Number.isFinite(size.x) &&
    Number.isFinite(size.y) &&
    Number.isFinite(size.z) &&
    size.x > 0 &&
    size.y > 0 &&
    size.z > 0
  if (hasSize) {
    const box = new Mesh(
      new BoxGeometry(size.x, size.y, size.z),
      new MeshBasicNodeMaterial({ wireframe: true })
    )
    box.position.copy(center)
    root.add(box)
  }
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

function replaceWithUnlitMaterials(root: Object3D): void {
  root.traverse(object => {
    if (!('isMesh' in object) || !object.isMesh) return
    const mesh = object as Mesh
    const material = mesh.material
    const nodeMaterial = new MeshBasicNodeMaterial()
    if (material && 'map' in material && material.map) {
      nodeMaterial.map = material.map
    }
    mesh.material = nodeMaterial
    if (Array.isArray(material)) {
      material.forEach(mat => mat.dispose())
    } else if (material) {
      material.dispose()
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

  const keyboard = new KeyboardFlightControls()
  const hud = new FlightHud()

  const plane = new Plane(b737AircraftParams())
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
  let lastAnimationTimeMs = 0
  loadPlaneModel(plane, renderer, state => {
    planeAnimationState = state
    lastAnimationTimeMs = 0
  })

  const spawnFrame = new NedFrame()
  const bodyToNedMatrix = new Matrix4()
  const qBodyToNed = new Quaternion()
  const qBodyToEcef = new Quaternion()
  const forwardNed = new Vector3()
  const rightNed = new Vector3()
  const downNed = new Vector3(0, 0, 1)
  const spawnPositionEcef = new Vector3()
  const spawnVelocityEcef = new Vector3()
  const spawnVelocityNed = new Vector3()

  const resetPlane = (): void => {
    spawnPositionEcef.copy(
      new Geodetic(radians(longitude), radians(latitude), 2500).toECEF()
    )
    spawnFrame.updateFromECEF(spawnPositionEcef)

    const yaw = radians(heading)
    forwardNed.set(Math.cos(yaw), Math.sin(yaw), 0).normalize()
    rightNed.crossVectors(downNed, forwardNed).normalize()

    bodyToNedMatrix.makeBasis(forwardNed, rightNed, downNed)
    qBodyToNed.setFromRotationMatrix(bodyToNedMatrix)
    qBodyToEcef.multiplyQuaternions(spawnFrame.qNedToEcef, qBodyToNed).normalize()

    spawnVelocityNed.copy(forwardNed).multiplyScalar(150)
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
      if (lastAnimationTimeMs === 0) {
        lastAnimationTimeMs = timeMs
      } else {
        const deltaSeconds = (timeMs - lastAnimationTimeMs) / 1000
        lastAnimationTimeMs = timeMs
        if (deltaSeconds > 0) {
          planeAnimationState.mixer.update(deltaSeconds)
        }
      }
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
    renderer.dispose()
  }
}

init().catch(console.error)
