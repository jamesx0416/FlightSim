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
  type NodeMaterial
} from 'three/webgpu'

export type RendererMode = 'webgl' | 'webgpu' | 'legacy-webgl'

type WebGpuFeatureName = 'texture-compression-bc'

export type AppRenderer = WebGLRenderer | WebGPURenderer

export interface RendererInfo {
  readonly renderer: AppRenderer
  readonly mode: RendererMode
  readonly hasBcTextureCompression: boolean | null
}

export interface AircraftEnvironmentInfo {
  readonly texture: Texture | null
  readonly usedFallback: boolean
}

export type NodeMaterialFactory = (material: Material) => NodeMaterial | null

export async function createAppRenderer(): Promise<RendererInfo> {
  try {
    const renderer = new WebGPURenderer(await createWebGpuRendererOptions())
    await renderer.init()
    return finalizeRenderer(renderer)
  } catch {
    return createPreferredWebGlRenderer()
  }
}

async function createPreferredWebGlRenderer(): Promise<RendererInfo> {
  try {
    const renderer = new WebGPURenderer({ antialias: true, forceWebGL: true })
    await renderer.init()
    return finalizeRenderer(renderer, 'webgl')
  } catch {
    return finalizeRenderer(
      new WebGLRenderer({ antialias: true }),
      'legacy-webgl'
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
  modeOverride?: RendererMode
): RendererInfo {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1

  return {
    renderer,
    mode: modeOverride ?? resolveRendererMode(renderer),
    hasBcTextureCompression: getRendererFeature(renderer, 'texture-compression-bc'),
  }
}

function resolveRendererMode(renderer: AppRenderer): RendererMode {
  if (renderer instanceof WebGLRenderer) {
    return 'legacy-webgl'
  }

  return renderer.backend.isWebGPUBackend === true
    ? 'webgpu'
    : 'webgl'
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

  // Keep the shared PMREM environment cool and moderately dim so MSFS
  // exterior materials do not wash out under indirect sky lighting.
  const zenith = new Color('#6d8cad').multiplyScalar(0.58)
  const horizon = new Color('#9db2c7').multiplyScalar(0.52)
  const ground = new Color('#3b4957').multiplyScalar(0.4)

  for (let y = 0; y < height; y += 1) {
    const v = y / Math.max(height - 1, 1)
    const gradientColor = new Color()

    if (v < 0.4) {
      gradientColor.copy(zenith).lerp(horizon, v / 0.4)
    } else {
      gradientColor.copy(horizon).lerp(ground, (v - 0.4) / 0.6)
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
