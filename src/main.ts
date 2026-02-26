import { AgXToneMapping, PerspectiveCamera, Vector3 } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { toneMapping, uniform } from 'three/tsl'
import { PostProcessing, WebGPURenderer } from 'three/webgpu'

import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from '@takram/three-atmosphere'
import { AtmosphereContextNode, sky } from '@takram/three-atmosphere/webgpu'
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial'
import { dithering } from '@takram/three-geospatial/webgpu'

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

  const camera = new PerspectiveCamera(90, window.innerWidth / window.innerHeight, 1, 1e6)
  camera.position.set(1, 0, 0)

  const context = new AtmosphereContextNode()
  context.camera = camera
  context.showGround = false

  const position = new Vector3()
  const geodetic = new Geodetic(radians(longitude), radians(latitude), height)
  Ellipsoid.WGS84.getNorthUpEastFrame(geodetic.toECEF(position), context.matrixWorldToECEF.value)

  const skyNode = sky(context)
  skyNode.showSun = true
  skyNode.showMoon = true

  const toneMappingNode = toneMapping(AgXToneMapping, uniform(10), skyNode)

  const postProcessing = new PostProcessing(renderer)
  postProcessing.outputNode = toneMappingNode.add(dithering)

  const controls = new OrbitControls(camera, container)
  controls.enableDamping = true

  void renderer.setAnimationLoop(() => {
    controls.update()
    camera.updateMatrixWorld()

    getECIToECEFRotationMatrix(date, context.matrixECIToECEF.value)
    getSunDirectionECI(date, context.sunDirectionECEF.value).applyMatrix4(
      context.matrixECIToECEF.value
    )
    getMoonDirectionECI(date, context.moonDirectionECEF.value).applyMatrix4(
      context.matrixECIToECEF.value
    )

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
    toneMappingNode.dispose()
    skyNode.dispose()
    controls.dispose()
    context.dispose()
    renderer.dispose()
  }
}

const container = document.querySelector<HTMLDivElement>('#app')!
if (container) {
  init(container).catch(console.error)
}
