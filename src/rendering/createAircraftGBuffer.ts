import {
  DepthFormat,
  DepthTexture,
  HalfFloatType,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  RenderTarget,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  type Texture
} from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { mrt, texture } from 'three/tsl'

import type { AppRenderer } from './createAppRenderer'

export const AIRCRAFT_GBUFFER_BYTES_PER_SAMPLE = 24

export type AircraftGBufferTextures = {
  readonly g0: Texture
  readonly g1: Texture
  readonly g2: Texture
  readonly g3: Texture
}

export interface AircraftGBuffer {
  readonly renderTarget: RenderTarget
  readonly depthTexture: DepthTexture
  readonly textures: AircraftGBufferTextures
  readonly textureNodes: {
    readonly g0: ReturnType<typeof texture>
    readonly g1: ReturnType<typeof texture>
    readonly g2: ReturnType<typeof texture>
    readonly g3: ReturnType<typeof texture>
  }
  resize(): void
  dispose(): void
}

const drawingBufferSize = new Vector2()

export function supportsAircraftGBuffer(renderer: AppRenderer): renderer is WebGPURenderer {
  return (
    renderer instanceof WebGPURenderer &&
    (renderer.backend as { readonly isWebGPUBackend?: boolean }).isWebGPUBackend === true &&
    typeof (mrt({}) as { setBlendMode?: unknown }).setBlendMode === 'function' &&
    typeof (mrt({}) as { getBlendMode?: unknown }).getBlendMode === 'function'
  )
}

export function createAircraftGBuffer(renderer: WebGPURenderer): AircraftGBuffer {
  const renderTarget = new RenderTarget(1, 1, {
    count: 4,
    depthBuffer: true,
    stencilBuffer: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  })
  // ponytail: keep the four-attachment G-buffer single-sampled. MSAA multiplies
  // its bandwidth and memory cost and made camera updates appear unresponsive.
  renderTarget.samples = 0

  const [g0, g1, g2, g3] = renderTarget.textures
  configureAttachment(g0, 'aircraftG0', UnsignedByteType)
  configureAttachment(g1, 'aircraftG1', HalfFloatType)
  configureAttachment(g2, 'aircraftG2', UnsignedByteType)
  configureAttachment(g3, 'aircraftG3', HalfFloatType)

  const depthTexture = new DepthTexture(1, 1, UnsignedIntType)
  depthTexture.name = 'aircraft-depth'
  depthTexture.format = DepthFormat
  depthTexture.type = UnsignedIntType
  depthTexture.minFilter = NearestFilter
  depthTexture.magFilter = NearestFilter
  depthTexture.generateMipmaps = false
  renderTarget.depthTexture = depthTexture

  const resize = (): void => {
    renderer.getDrawingBufferSize(drawingBufferSize)
    const width = Math.max(1, Math.floor(drawingBufferSize.x))
    const height = Math.max(1, Math.floor(drawingBufferSize.y))
    if (renderTarget.width !== width || renderTarget.height !== height) {
      renderTarget.setSize(width, height)
    }
  }

  return {
    renderTarget,
    depthTexture,
    textures: { g0, g1, g2, g3 },
    textureNodes: {
      g0: texture(g0),
      g1: texture(g1),
      g2: texture(g2),
      g3: texture(g3),
    },
    resize,
    dispose: () => renderTarget.dispose(),
  }
}

function configureAttachment(
  attachment: Texture,
  name: string,
  type: typeof UnsignedByteType | typeof HalfFloatType
): void {
  attachment.name = name
  attachment.format = RGBAFormat
  attachment.type = type
  attachment.colorSpace = NoColorSpace
  attachment.minFilter = NearestFilter
  attachment.magFilter = NearestFilter
  attachment.generateMipmaps = false
}
