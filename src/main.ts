import {
  AmbientLight,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  Group,
  LoadingManager,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { compileMsfs2020Behaviors } from './msfs/behavior'
import { importBuiltMsfs2020Package } from './msfs/importer'
import { AircraftRuntime, DemoRuntimeHost } from './msfs/runtime'
import type { ImportedAircraft, RuntimeState } from './msfs/types'

const DEFAULT_PACKAGE_ROOT = '/tmp/headwindsim-aircraft-a330-900/'

async function init(): Promise<void> {
  const packageRoot = ensureTrailingSlash(
    import.meta.env.VITE_MSFS_PACKAGE_ROOT || DEFAULT_PACKAGE_ROOT
  )
  const packageData = await importBuiltMsfs2020Package(packageRoot)
  const aircraft = selectPrimaryAircraft(packageData.aircraft)
  if (aircraft == null || aircraft.model == null) {
    throw new Error('No importable aircraft model was found in the configured package.')
  }

  const compiledBehaviors = await compileMsfs2020Behaviors(packageData, aircraft)
  const scene = new Scene()
  scene.background = new Color('#d8e2ea')

  const renderer = new WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = SRGBColorSpace
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

  const ambientLight = new AmbientLight('#ffffff', 1.8)
  const keyLight = new DirectionalLight('#fff6df', 3.2)
  keyLight.position.set(20, 25, 15)
  const fillLight = new DirectionalLight('#bcd7ff', 1.6)
  fillLight.position.set(-15, 12, -18)
  scene.add(ambientLight, keyLight, fillLight)

  const overlay = createOverlay()
  document.body.appendChild(overlay)

  const gltf = await loadAircraftGltf(aircraft)
  const aircraftRoot = new Group()
  aircraftRoot.add(gltf.scene)
  scene.add(aircraftRoot)

  centerObjectAtOrigin(aircraftRoot)
  fitCameraToObject(camera, controls, aircraftRoot)

  const runtimeHost = new DemoRuntimeHost(compiledBehaviors.diagnostics as never)
  const runtime = new AircraftRuntime(compiledBehaviors, gltf.scene, runtimeHost)
  runtime.bindAnimations(gltf.animations)

  const clock = new Clock()
  let runtimeState: RuntimeState = runtime.update(0)
  updateOverlay(overlay, packageRoot, packageData.packageName, aircraft, compiledBehaviors, runtimeState)

  const handleResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  }

  window.addEventListener('resize', handleResize)

  renderer.setAnimationLoop(() => {
    const dtSeconds = clock.getDelta()
    runtimeState = runtime.update(dtSeconds)
    controls.update()
    renderer.render(scene, camera)
    updateOverlay(
      overlay,
      packageRoot,
      packageData.packageName,
      aircraft,
      compiledBehaviors,
      runtimeState
    )
  })
}

async function loadAircraftGltf(aircraft: ImportedAircraft): Promise<GLTF> {
  if (aircraft.model == null) {
    throw new Error(`Aircraft ${aircraft.id} does not have a model to load.`)
  }

  const loadingManager = new LoadingManager()
  loadingManager.addHandler(/\.dds$/iu, new DDSLoader())
  const loader = new GLTFLoader(loadingManager)

  let lastError: unknown = null
  const lods = [...aircraft.model.lods].sort((left, right) => left.minSize - right.minSize)
  for (const lod of lods) {
    try {
      return await loadMsfsGltfLod(loader, lod.url)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to load any exterior model LOD.')
}

async function loadMsfsGltfLod(loader: GLTFLoader, url: string): Promise<GLTF> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${response.status}`)
  }

  const gltfText = await response.text()
  const gltfJson = JSON.parse(gltfText) as Record<string, unknown>
  const baseUrl = url.slice(0, url.lastIndexOf('/') + 1)

  if (usesMsfsDdsTextures(gltfJson)) {
    const sanitizedGltf = stripUnsupportedTextureReferences(gltfJson)
    return await loader.parseAsync(JSON.stringify(sanitizedGltf), baseUrl)
  }

  return await loader.parseAsync(gltfText, baseUrl)
}

function usesMsfsDdsTextures(gltf: Record<string, unknown>): boolean {
  const extensionsUsed = Array.isArray(gltf.extensionsUsed) ? gltf.extensionsUsed : []
  return extensionsUsed.includes('MSFT_texture_dds')
}

function stripUnsupportedTextureReferences(
  source: Record<string, unknown>
): Record<string, unknown> {
  const clone = structuredClone(source)

  if (Array.isArray(clone.extensionsUsed)) {
    clone.extensionsUsed = clone.extensionsUsed.filter(
      value => value !== 'MSFT_texture_dds'
    )
  }
  if (Array.isArray(clone.extensionsRequired)) {
    clone.extensionsRequired = clone.extensionsRequired.filter(
      value => value !== 'MSFT_texture_dds'
    )
  }

  if (Array.isArray(clone.materials)) {
    for (const material of clone.materials as Record<string, unknown>[]) {
      delete material.normalTexture
      delete material.occlusionTexture
      delete material.emissiveTexture

      const pbr = material.pbrMetallicRoughness as Record<string, unknown> | undefined
      if (pbr) {
        delete pbr.baseColorTexture
        delete pbr.metallicRoughnessTexture
      }
    }
  }

  delete clone.textures
  delete clone.images
  delete clone.samplers

  return clone
}

function selectPrimaryAircraft(aircraft: readonly ImportedAircraft[]): ImportedAircraft | null {
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
  const bounds = new Box3().setFromObject(object)
  const center = bounds.getCenter(new Vector3())
  object.position.sub(center)

  const recenteredBounds = new Box3().setFromObject(object)
  const minimumY = recenteredBounds.min.y
  object.position.y -= minimumY
}

function fitCameraToObject(
  camera: PerspectiveCamera,
  controls: OrbitControls,
  object: Group
): void {
  const bounds = new Box3().setFromObject(object)
  const size = bounds.getSize(new Vector3())
  const center = bounds.getCenter(new Vector3())
  const radius = Math.max(size.x, size.y, size.z) * 0.8
  camera.near = 0.1
  camera.far = Math.max(5000, radius * 40)
  camera.position.copy(center).add(new Vector3(radius * 1.5, radius * 0.6, radius * 1.4))
  camera.updateProjectionMatrix()
  controls.target.copy(center)
  controls.update()
}

function createOverlay(): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.style.position = 'fixed'
  overlay.style.top = '16px'
  overlay.style.left = '16px'
  overlay.style.maxWidth = '420px'
  overlay.style.padding = '14px 16px'
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

function updateOverlay(
  overlay: HTMLDivElement,
  packageRoot: string,
  packageName: string,
  aircraft: ImportedAircraft,
  compiledBehaviors: {
    readonly animationBindings: readonly unknown[]
    readonly visibilityBindings: readonly unknown[]
    readonly variableKeys: readonly string[]
    readonly diagnostics: readonly { readonly severity: string; readonly message: string }[]
  },
  runtimeState: RuntimeState
): void {
  const diagnostics = runtimeState.diagnostics
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
    `MSFS package: ${packageName}`,
    `Root: ${packageRoot}`,
    `Aircraft: ${aircraft.title}`,
    `Source: ${aircraft.sourcePath}`,
    '',
    `Animations compiled: ${compiledBehaviors.animationBindings.length}`,
    `Visibility bindings: ${compiledBehaviors.visibilityBindings.length}`,
    `Variable symbols: ${compiledBehaviors.variableKeys.length}`,
    `Diagnostics: ${errors} error / ${warnings} warning / ${compiledBehaviors.diagnostics.length - errors - warnings} info`,
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

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

init().catch(error => {
  const overlay = createOverlay()
  overlay.style.pointerEvents = 'auto'
  overlay.textContent =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  document.body.appendChild(overlay)
  console.error(error)
})
