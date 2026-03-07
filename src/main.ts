import { GlobeControls, TilesRenderer } from '3d-tiles-renderer'
import {
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  TileCompressionPlugin,
  UpdateOnChangePlugin
} from '3d-tiles-renderer/plugins'
import { AgXToneMapping, PerspectiveCamera, Scene, Vector3 } from 'three'
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
import { Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import {
  dithering,
  highpVelocity,
  lensFlare,
  temporalAntialias
} from '@takram/three-geospatial/webgpu'

import { TilesFadePlugin } from './plugins/fade/TilesFadePlugin'

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
  tiles.registerPlugin(new TilesFadePlugin())
  tiles.registerPlugin(new TileMaterialReplacementPlugin(MeshBasicNodeMaterial))
  scene.add(tiles.group)

  const controls = new GlobeControls(scene, camera, renderer.domElement)
  controls.enableDamping = true

  controls.adjustHeight = false
  controls.addEventListener('start', () => {
    controls.adjustHeight = true
  })

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

  const observerECEF = new Vector3()
  void renderer.setAnimationLoop(() => {
    controls.update()
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
    renderer.dispose()
  }
}

init().catch(console.error)
