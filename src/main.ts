import { AgXToneMapping, Group, Mesh, PerspectiveCamera, Scene, SphereGeometry, Vector3 } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { mrt, normalView, output, pass, toneMapping, uniform } from 'three/tsl'
import { PostProcessing, WebGPURenderer } from 'three/webgpu'

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
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial'
import {
  dithering,
  highpVelocity,
  lensFlare,
  temporalAntialias
} from '@takram/three-geospatial/webgpu'

const date = new Date('2000-01-01T09:00:00Z')
const longitude = 30
const latitude = 35
const height = 300

async function init(container: HTMLDivElement): Promise<() => void> {
  const renderer = new WebGPURenderer()
  renderer.highPrecision = true
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  container.appendChild(renderer.domElement)
  await renderer.init()

  const aspect = window.innerWidth / window.innerHeight
  const camera = new PerspectiveCamera(90, aspect, 10, 1e6)

  const positionECEF = new Geodetic(
    radians(longitude),
    radians(latitude),
    height
  ).toECEF()

  const east = new Vector3()
  const north = new Vector3()
  const up = new Vector3()
  Ellipsoid.WGS84.getEastNorthUpVectors(positionECEF, east, north, up)
  camera.up.copy(up)
  camera.position.copy(positionECEF).add(north).sub(up.multiplyScalar(0.75))

  const scene = new Scene()

  const group = new Group()
  scene.add(group)
  Ellipsoid.WGS84.getEastNorthUpFrame(positionECEF).decompose(
    group.position,
    group.quaternion,
    group.scale
  )

  const geometry = new SphereGeometry(1e5, 64, 64)
  const mesh = new Mesh(geometry)
  mesh.position.z = 1e5 - height + 200
  group.add(mesh)

  const context = new AtmosphereContextNode()
  context.camera = camera

  renderer.library.addLight(AtmosphereLightNode, AtmosphereLight)
  const light = new AtmosphereLight(context)
  scene.add(light)

  const passNode = pass(scene, camera, { samples: 0 }).setMRT(
    mrt({
      output,
      normal: normalView,
      velocity: highpVelocity
    })
  )
  const colorNode = passNode.getTextureNode('output')
  const depthNode = passNode.getTextureNode('depth')
  const normalNode = passNode.getTextureNode('normal')
  const velocityNode = passNode.getTextureNode('velocity')

  const aerialNode = aerialPerspective(context, colorNode, depthNode, normalNode)
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

  const controls = new OrbitControls(camera, container)
  controls.enableDamping = true
  controls.target.copy(positionECEF)

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
    geometry.dispose()
    context.dispose()
    renderer.dispose()
  }
}

const container = document.querySelector<HTMLDivElement>('#app')!
if (container) {
  init(container).catch(console.error)
}
