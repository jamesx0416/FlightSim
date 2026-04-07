import {
  ACESFilmicToneMapping,
  Color,
  Material,
  PMREMGenerator,
  SRGBColorSpace,
  Scene,
  Texture,
  WebGLRenderer,
} from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js'
import {
  WebGPURenderer,
  type NodeMaterial
} from 'three/webgpu'

export type RendererPreference = 'webgl' | 'webgpu' | 'auto'
export type RendererMode = 'webgl' | 'webgpu' | 'webgpu-fallback-webgl'

type WebGpuFeatureName = 'texture-compression-bc'

export type AppRenderer = WebGLRenderer | WebGPURenderer

export interface RendererInfo {
  readonly renderer: AppRenderer
  readonly preference: RendererPreference
  readonly mode: RendererMode
  readonly hasBcTextureCompression: boolean | null
}

export type NodeMaterialFactory = (material: Material) => NodeMaterial | null

export async function createAppRenderer(
  searchParams: URLSearchParams
): Promise<RendererInfo> {
  const preference = resolveRendererPreference(searchParams)
  if (preference === 'webgl') {
    return finalizeRenderer(new WebGLRenderer({ antialias: true }), preference)
  }

  try {
    const renderer = new WebGPURenderer(await createWebGpuRendererOptions())
    await renderer.init()
    return finalizeRenderer(renderer, preference)
  } catch (error) {
    if (preference !== 'auto') {
      throw error
    }

    return finalizeRenderer(
      new WebGLRenderer({ antialias: true }),
      preference,
      'webgpu-fallback-webgl'
    )
  }
}

async function createWebGpuRendererOptions(): Promise<{ antialias: true; requiredLimits?: Record<string, number> }> {
  const requiredLimits = await getWebGpuRequiredLimits()
  return requiredLimits == null
    ? { antialias: true }
    : { antialias: true, requiredLimits }
}

async function getWebGpuRequiredLimits(): Promise<Record<string, number> | undefined> {
  if (typeof navigator === 'undefined' || navigator.gpu == null) {
    return undefined
  }

  const adapter = await navigator.gpu.requestAdapter()
  if (adapter == null) {
    return undefined
  }

  const maxColorAttachmentBytesPerSample = adapter.limits.maxColorAttachmentBytesPerSample
  if (typeof maxColorAttachmentBytesPerSample !== 'number' || maxColorAttachmentBytesPerSample <= 32) {
    return undefined
  }

  return {
    maxColorAttachmentBytesPerSample,
  }
}

export function createAircraftEnvironment(renderer: AppRenderer): Texture | null {
  const pmremGenerator = new PMREMGenerator(renderer as never)
  try {
    return pmremGenerator.fromScene(createSkyScene(renderer)).texture
  } catch {
    return null
  } finally {
    pmremGenerator.dispose()
  }
}

export function createNodeMaterialFactory(
  renderer: AppRenderer
): NodeMaterialFactory | null {
  if (renderer instanceof WebGLRenderer) {
    return null
  }

  return material => renderer.library.fromMaterial(material)
}

function finalizeRenderer(
  renderer: AppRenderer,
  preference: RendererPreference,
  modeOverride?: RendererMode
): RendererInfo {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.72

  return {
    renderer,
    preference,
    mode: modeOverride ?? resolveRendererMode(renderer),
    hasBcTextureCompression: getRendererFeature(renderer, 'texture-compression-bc'),
  }
}

function resolveRendererPreference(searchParams: URLSearchParams): RendererPreference {
  const requestedRenderer = searchParams.get('renderer') ?? import.meta.env.VITE_RENDERER ?? 'webgl'

  switch (requestedRenderer.toLowerCase()) {
    case 'auto':
      return 'auto'
    case 'webgpu':
      return 'webgpu'
    default:
      return 'webgl'
  }
}

function resolveRendererMode(renderer: AppRenderer): RendererMode {
  if (renderer instanceof WebGLRenderer) {
    return 'webgl'
  }

  return renderer.backend.isWebGPUBackend === true
    ? 'webgpu'
    : 'webgpu-fallback-webgl'
}

function getRendererFeature(
  renderer: AppRenderer,
  featureName: WebGpuFeatureName
): boolean | null {
  if (renderer instanceof WebGLRenderer) {
    return null
  }

  return renderer.hasFeature(featureName)
}

function createSkyScene(renderer: AppRenderer) {
  const scene = new Scene()
  scene.background = new Color('#405264')

  const sky =
    renderer instanceof WebGLRenderer
      ? createWebGlSky()
      : createWebGpuSky()
  sky.scale.setScalar(450000)
  scene.add(sky)

  return scene
}

function createWebGlSky() {
  const sky = new Sky()
  sky.scale.setScalar(450000)

  const uniforms = sky.material.uniforms
  uniforms['turbidity'].value = 2.2
  uniforms['rayleigh'].value = 1.7
  uniforms['mieCoefficient'].value = 0.02
  uniforms['mieDirectionalG'].value = 0.92
  uniforms['sunPosition'].value.set(0.4, 0.9, -0.35).normalize().multiplyScalar(120)

  return sky
}

function createWebGpuSky() {
  const sky = new SkyMesh()
  sky.turbidity.value = 2.2
  sky.rayleigh.value = 1.7
  sky.mieCoefficient.value = 0.02
  sky.mieDirectionalG.value = 0.92
  sky.sunPosition.value.set(0.4, 0.9, -0.35).normalize().multiplyScalar(120)

  return sky
}
