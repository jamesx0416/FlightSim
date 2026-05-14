import {
  DataTexture,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type LoadingManager,
  type Texture
} from 'three'

import { MSFSDecodedDDSLoader } from './MSFSDecodedDDSLoader'
import { MSFSMipSafeDDSLoader } from './MSFSMipSafeDDSLoader'
import { MSFSDDSLoader, type MSFSDDSLoadOptions } from './MSFSDDSLoader'

const EXTENSION_NAME = 'MSFT_texture_dds'
const MSFS_DDS_TEXTURE_DEPENDENCY_TIMEOUT_MS = 15000

interface GltfTextureDef {
  readonly extensions?: {
    readonly MSFT_texture_dds?: {
      readonly source: number
    }
  }
}

interface GltfTextureRef {
  readonly index: number
}

interface GltfPrimitiveDef {
  readonly material?: number
}

interface GltfMeshDef {
  readonly primitives?: readonly GltfPrimitiveDef[]
}

interface GltfNodeDef {
  readonly mesh?: number
  readonly children?: readonly number[]
}

interface GltfSceneDef {
  readonly nodes?: readonly number[]
}

interface GltfMaterialDef {
  readonly alphaMode?: string
  readonly normalTexture?: GltfTextureRef
  readonly pbrMetallicRoughness?: {
    readonly baseColorTexture?: GltfTextureRef
  }
  readonly extensions?: {
    readonly ASOBO_material_detail_map?: {
      readonly detailNormalTexture?: GltfTextureRef
    }
  }
}

interface GltfParserLike {
  readonly json: {
    readonly materials?: readonly GltfMaterialDef[]
    readonly meshes?: readonly GltfMeshDef[]
    readonly nodes?: readonly GltfNodeDef[]
    readonly scenes?: readonly GltfSceneDef[]
    readonly scene?: number
    readonly textures?: readonly GltfTextureDef[]
  }
  readonly options: {
    readonly manager: LoadingManager
  }
  loadTextureImage(
    textureIndex: number,
    sourceIndex: number,
    loader: unknown
  ): Promise<unknown>
}

class MSFTTextureDDSExtension {
  readonly name = EXTENSION_NAME
  private readonly usedMaterialIndices: ReadonlySet<number>

  constructor(
    private readonly parser: GltfParserLike,
    private readonly decodeNormalSources: boolean,
    private readonly textureLoadOptions: MSFSDDSLoadOptions
  ) {
    this.usedMaterialIndices = collectUsedMaterialIndices(parser.json)
  }

  loadTexture(textureIndex: number): Promise<unknown> | null {
    const textureDef = this.parser.json.textures?.[textureIndex]
    const sourceIndex = textureDef?.extensions?.MSFT_texture_dds?.source
    if (sourceIndex == null) {
      return null
    }

    const decodeTransparentBaseColor = shouldDecodeTransparentBaseColorSource(
      this.parser.json,
      sourceIndex
    )
    const normalSource = isNormalSource(
      this.parser.json,
      sourceIndex,
      this.usedMaterialIndices
    )
    const decodeNormalSource = normalSource && this.decodeNormalSources

    const textureLoadOptions = {
      ...this.textureLoadOptions,
      placeholderKind: normalSource
        ? 'normal'
        : decodeTransparentBaseColor
          ? 'transparent'
          : 'color'
    } as const
    const loader =
      decodeTransparentBaseColor || decodeNormalSource
        ? new MSFSDecodedDDSLoader(this.parser.options.manager, textureLoadOptions)
        : normalSource
          ? new MSFSMipSafeDDSLoader(this.parser.options.manager, textureLoadOptions)
          : new MSFSDDSLoader(this.parser.options.manager, textureLoadOptions)

    const fallbackTexture = (): Texture =>
      createFallbackTexture({
        transparent: decodeTransparentBaseColor,
        normal: normalSource
      })
    const texturePromise = this.parser
      .loadTextureImage(textureIndex, sourceIndex, loader)
      .catch(() => fallbackTexture())
      .then(async texture => {
        await waitUntilDocumentVisible()
        return texture
      })

    return withTextureDependencyTimeout(
      texturePromise,
      MSFS_DDS_TEXTURE_DEPENDENCY_TIMEOUT_MS,
      fallbackTexture
    )
  }
}

function waitUntilDocumentVisible(): Promise<void> {
  if (!document.hidden) {
    return Promise.resolve()
  }

  return new Promise(resolve => {
    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        return
      }

      document.removeEventListener('visibilitychange', handleVisibilityChange)
      resolve()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
  })
}

async function withTextureDependencyTimeout(
  texturePromise: Promise<unknown>,
  timeoutMs: number,
  createFallback: () => Texture
): Promise<unknown> {
  const timeout = createVisiblePageTimeout(timeoutMs)
  try {
    return await Promise.race([
      texturePromise,
      timeout.promise.then(createFallback)
    ])
  } finally {
    timeout.cancel()
  }
}

function createVisiblePageTimeout(timeoutMs: number): {
  readonly promise: Promise<void>
  readonly cancel: () => void
} {
  let cancel = (): void => {}
  const promise = new Promise<void>(resolve => {
    let remainingMs = Math.max(0, timeoutMs)
    let timerStartMs: number | null = null
    let timeoutId: number | null = null
    let settled = false

    const clearActiveTimer = (): void => {
      if (timeoutId != null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearActiveTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      resolve()
    }

    cancel = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearActiveTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }

    const pause = (): void => {
      if (timerStartMs != null) {
        remainingMs = Math.max(0, remainingMs - (performance.now() - timerStartMs))
        timerStartMs = null
      }
      clearActiveTimer()
    }

    const resume = (): void => {
      if (timeoutId != null) {
        return
      }
      if (document.hidden) {
        return
      }
      if (remainingMs <= 0) {
        finish()
        return
      }
      timerStartMs = performance.now()
      timeoutId = window.setTimeout(finish, remainingMs)
    }

    function handleVisibilityChange(): void {
      if (document.hidden) {
        pause()
      } else {
        resume()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    resume()
  })
  return { promise, cancel }
}

function createFallbackTexture(options: {
  readonly transparent: boolean
  readonly normal: boolean
}): Texture {
  const pixel = options.normal
    ? new Uint8Array([128, 128, 255, 255])
    : options.transparent
      ? new Uint8Array([255, 255, 255, 0])
      : new Uint8Array([255, 255, 255, 255])
  const texture = new DataTexture(pixel, 1, 1, RGBAFormat, UnsignedByteType)
  texture.colorSpace = options.normal ? NoColorSpace : SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

function shouldDecodeTransparentBaseColorSource(
  json: GltfParserLike['json'],
  sourceIndex: number
): boolean {
  if (json.materials == null || json.textures == null) {
    return false
  }

  for (const material of json.materials) {
    if (material.alphaMode !== 'BLEND' && material.alphaMode !== 'MASK') {
      continue
    }

    const textureIndex = material.pbrMetallicRoughness?.baseColorTexture?.index
    if (textureIndex == null) {
      continue
    }

    const textureDef = json.textures[textureIndex]
    if (textureDef?.extensions?.MSFT_texture_dds?.source === sourceIndex) {
      return true
    }
  }

  return false
}

function isNormalSource(
  json: GltfParserLike['json'],
  sourceIndex: number,
  usedMaterialIndices: ReadonlySet<number>
): boolean {
  if (json.materials == null || json.textures == null) {
    return false
  }

  for (const [materialIndex, material] of json.materials.entries()) {
    if (!usedMaterialIndices.has(materialIndex)) {
      continue
    }

    const normalTextureIndex = material.normalTexture?.index
    if (normalTextureIndex != null) {
      const textureDef = json.textures[normalTextureIndex]
      if (textureDef?.extensions?.MSFT_texture_dds?.source === sourceIndex) {
        return true
      }
    }

    const detailNormalTextureIndex =
      material.extensions?.ASOBO_material_detail_map?.detailNormalTexture?.index
    if (detailNormalTextureIndex == null) {
      continue
    }

    const detailTextureDef = json.textures[detailNormalTextureIndex]
    if (detailTextureDef?.extensions?.MSFT_texture_dds?.source === sourceIndex) {
      return true
    }
  }

  return false
}

function collectUsedMaterialIndices(json: GltfParserLike['json']): ReadonlySet<number> {
  const usedMaterials = new Set<number>()
  const meshes = json.meshes ?? []
  const nodes = json.nodes ?? []
  const scenes = json.scenes ?? []
  const roots =
    typeof json.scene === 'number'
      ? scenes[json.scene]?.nodes ?? []
      : scenes.flatMap(scene => scene.nodes ?? [])
  const pending = [...roots]
  const visitedNodes = new Set<number>()

  while (pending.length > 0) {
    const nodeIndex = pending.pop()
    if (nodeIndex == null || visitedNodes.has(nodeIndex)) {
      continue
    }

    visitedNodes.add(nodeIndex)
    const node = nodes[nodeIndex]
    if (node == null) {
      continue
    }

    if (typeof node.mesh === 'number') {
      const mesh = meshes[node.mesh]
      for (const primitive of mesh?.primitives ?? []) {
        if (typeof primitive.material === 'number') {
          usedMaterials.add(primitive.material)
        }
      }
    }

    for (const childIndex of node.children ?? []) {
      pending.push(childIndex)
    }
  }

  return usedMaterials
}

export function createMsftTextureDdsExtension(
  parser: GltfParserLike,
  options: {
    readonly decodeNormalSources?: boolean
    readonly textureLoadOptions?: MSFSDDSLoadOptions
  } = {}
): {
  readonly name: string
  loadTexture(textureIndex: number): Promise<unknown> | null
} {
  return new MSFTTextureDDSExtension(
    parser,
    options.decodeNormalSources === true,
    options.textureLoadOptions ?? {}
  )
}
