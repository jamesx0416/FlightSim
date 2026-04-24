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
import { MSFSDDSLoader, type MSFSDDSLoadOptions } from './MSFSDDSLoader'

const EXTENSION_NAME = 'MSFT_texture_dds'

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
    const decodeNormalSource = shouldDecodeNormalSource(
      this.parser.json,
      sourceIndex,
      this.decodeNormalSources,
      this.usedMaterialIndices
    )

    const textureLoadOptions = {
      ...this.textureLoadOptions,
      placeholderKind: decodeNormalSource
        ? 'normal'
        : decodeTransparentBaseColor
          ? 'transparent'
          : 'color'
    } as const
    const loader =
      decodeTransparentBaseColor || decodeNormalSource
        ? new MSFSDecodedDDSLoader(this.parser.options.manager, textureLoadOptions)
        : new MSFSDDSLoader(this.parser.options.manager, textureLoadOptions)

    return this.parser
      .loadTextureImage(textureIndex, sourceIndex, loader)
      .catch(() =>
        createFallbackTexture({
          transparent: decodeTransparentBaseColor,
          normal: decodeNormalSource
        })
      )
  }
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

function shouldDecodeNormalSource(
  json: GltfParserLike['json'],
  sourceIndex: number,
  decodeNormalSources: boolean,
  usedMaterialIndices: ReadonlySet<number>
): boolean {
  if (!decodeNormalSources || json.materials == null || json.textures == null) {
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
