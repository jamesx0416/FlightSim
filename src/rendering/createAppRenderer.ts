import {
  ACESFilmicToneMapping,
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  LinearFilter,
  LinearSRGBColorSpace,
  Material,
  PMREMGenerator,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  Texture,
  UnsignedByteType,
  Vector3,
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

export interface AircraftEnvironmentInfo {
  readonly texture: Texture | null
  readonly usedFallback: boolean
}

export type NodeMaterialFactory = (material: Material) => NodeMaterial | null

const SKY_TURBIDITY = 2.2
const SKY_RAYLEIGH = 1.7
const SKY_MIE_COEFFICIENT = 0.02
const SKY_MIE_DIRECTIONAL_G = 0.92
const SKY_SUN_DIRECTION = new Vector3(0.4, 0.9, -0.35).normalize()

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

export function createAircraftEnvironment(renderer: AppRenderer): AircraftEnvironmentInfo {
  const pmremGenerator = new PMREMGenerator(renderer as never)
  const toneMapping = renderer.toneMapping
  const toneMappingExposure = renderer.toneMappingExposure
  const outputColorSpace = renderer.outputColorSpace

  try {
    return {
      texture: pmremGenerator.fromScene(createSkyScene(renderer)).texture,
      usedFallback: false,
    }
  } catch {
    const fallbackEnvironment = createFallbackEnvironmentTexture()
    try {
      return {
        texture: pmremGenerator.fromEquirectangular(fallbackEnvironment).texture,
        usedFallback: true,
      }
    } catch {
      fallbackEnvironment.dispose()
      return {
        texture: createFallbackEnvironmentTexture(),
        usedFallback: true,
      }
    }
  } finally {
    renderer.toneMapping = toneMapping
    renderer.toneMappingExposure = toneMappingExposure
    renderer.outputColorSpace = outputColorSpace
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
  uniforms['turbidity'].value = SKY_TURBIDITY
  uniforms['rayleigh'].value = SKY_RAYLEIGH
  uniforms['mieCoefficient'].value = SKY_MIE_COEFFICIENT
  uniforms['mieDirectionalG'].value = SKY_MIE_DIRECTIONAL_G
  uniforms['sunPosition'].value.copy(SKY_SUN_DIRECTION).multiplyScalar(120)

  return sky
}

function createWebGpuSky() {
  const sky = new SkyMesh()
  sky.turbidity.value = SKY_TURBIDITY
  sky.rayleigh.value = SKY_RAYLEIGH
  sky.mieCoefficient.value = SKY_MIE_COEFFICIENT
  sky.mieDirectionalG.value = SKY_MIE_DIRECTIONAL_G
  sky.sunPosition.value.copy(SKY_SUN_DIRECTION).multiplyScalar(120)

  return sky
}

function createFallbackEnvironmentTexture(): Texture {
  const width = 256
  const height = 128
  const data = new Uint8Array(width * height * 4)

  const zenith = new Color('#7ea7d4')
  const horizon = new Color('#d6e5f5')
  const ground = new Color('#405264')

  for (let y = 0; y < height; y += 1) {
    const v = y / Math.max(height - 1, 1)
    const gradientColor = new Color()

    if (v < 0.48) {
      gradientColor.copy(zenith).lerp(horizon, v / 0.48)
    } else {
      gradientColor.copy(horizon).lerp(ground, (v - 0.48) / 0.52)
    }

    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      data[offset] = Math.round(gradientColor.r * 255)
      data[offset + 1] = Math.round(gradientColor.g * 255)
      data[offset + 2] = Math.round(gradientColor.b * 255)
      data[offset + 3] = 255
    }
  }

  const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType)
  texture.mapping = EquirectangularReflectionMapping
  texture.colorSpace = LinearSRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
