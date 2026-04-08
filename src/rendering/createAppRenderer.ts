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
  WebGLRenderer,
} from 'three'
import {
  WebGPURenderer,
  PMREMGenerator as WebGpuPMREMGenerator,
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
  const pmremGenerator =
    renderer instanceof WebGLRenderer
      ? new PMREMGenerator(renderer)
      : new WebGpuPMREMGenerator(renderer)
  const toneMapping = renderer.toneMapping
  const toneMappingExposure = renderer.toneMappingExposure
  const outputColorSpace = renderer.outputColorSpace
  const environmentTexture = createEnvironmentTexture()

  try {
    return {
      texture: pmremGenerator.fromEquirectangular(environmentTexture).texture,
      usedFallback: false,
    }
  } catch {
    environmentTexture.dispose()
    try {
      return {
        texture: createEnvironmentTexture(),
        usedFallback: true,
      }
    } catch {
      return {
        texture: createEnvironmentTexture(),
        usedFallback: true,
      }
    }
  } finally {
    environmentTexture.dispose()
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

  const failedConversions = new WeakSet<Material>()

  return material => {
    if (failedConversions.has(material)) {
      return null
    }

    if (
      (material as Material & { readonly isShaderMaterial?: boolean }).isShaderMaterial === true ||
      (
        (material as Material & { readonly isMeshStandardMaterial?: boolean }).isMeshStandardMaterial !== true &&
        (material as Material & { readonly isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial !== true
      )
    ) {
      return null
    }

    try {
      return renderer.library.fromMaterial(material)
    } catch {
      failedConversions.add(material)
      return null
    }
  }
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
  renderer.toneMappingExposure = renderer instanceof WebGPURenderer ? 1.1 : 0.72

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

function createEnvironmentTexture(): Texture {
  const width = 1024
  const height = 512
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
