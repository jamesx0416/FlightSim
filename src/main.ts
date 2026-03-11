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
  Matrix4,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3
} from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
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
const planeModelUrl = new URL('../B737-800.glb', import.meta.url).href
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

function loadPlaneModel(plane: Plane): void {
  const loader = new GLTFLoader()
  loader.load(planeModelUrl, gltf => {
    const model = gltf.scene

    model.rotation.set(planeModelRotation.x, planeModelRotation.y, planeModelRotation.z)
    model.updateMatrixWorld(true)

    const bounds = new Box3().setFromObject(model)
    const size = bounds.getSize(new Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    const targetSpan = plane.params.wingSpanM
    if (maxDim > 0) {
      const scale = targetSpan / maxDim
      model.scale.setScalar(scale)
      model.updateMatrixWorld(true)
    }

    const scaledBounds = new Box3().setFromObject(model)
    const center = scaledBounds.getCenter(new Vector3())
    model.position.sub(center)

    replaceWithUnlitMaterials(model)
    plane.setVisual(model)
  })
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
  loadPlaneModel(plane)

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

  const observerECEF = new Vector3()
  void renderer.setAnimationLoop((timeMs: number) => {
    if (keyboard.consumeToggleFollowRequested()) {
      controls.enabled = !keyboard.isFollowEnabled()
    }

    if (!keyboard.isFollowEnabled()) {
      controls.enabled = true
      controls.update()
    } else {
      controls.enabled = false
    }

    sim.tick(timeMs, dtSeconds => {
      if (keyboard.consumeResetRequested()) resetPlane()
      plane.setControls(keyboard.update(dtSeconds))
      latest = plane.step(dtSeconds)
    })

    if (keyboard.isFollowEnabled()) {
      chaseOffsetEcef
        .copy(chaseOffsetBody)
        .applyQuaternion(plane.orientationBodyToECEF)
      camera.position.copy(plane.positionECEF).add(chaseOffsetEcef)

      planeForwardEcef.set(1, 0, 0).applyQuaternion(plane.orientationBodyToECEF)
      chaseTarget.copy(plane.positionECEF).addScaledVector(planeForwardEcef, 80)

      Ellipsoid.WGS84.getSurfaceNormal(plane.positionECEF, upEcef)
      camera.up.copy(upEcef)
      camera.lookAt(chaseTarget)
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
