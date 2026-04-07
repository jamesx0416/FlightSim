import type { LoadingManager } from 'three'

import { MSFSDecodedDDSLoader } from './MSFSDecodedDDSLoader'
import { MSFSDDSLoader } from './MSFSDDSLoader'

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
    readonly textures?: readonly GltfTextureDef[]
  }
  readonly options: {
    readonly manager: LoadingManager
  }
  loadTextureImage(
    textureIndex: number,
    sourceIndex: number,
    loader: MSFSDDSLoader
  ): Promise<unknown>
}

class MSFTTextureDDSExtension {
  readonly name = EXTENSION_NAME

  constructor(
    private readonly parser: GltfParserLike,
    private readonly decodeNormalSources: boolean
  ) {}

  loadTexture(textureIndex: number): Promise<unknown> | null {
    const textureDef = this.parser.json.textures?.[textureIndex]
    const sourceIndex = textureDef?.extensions?.MSFT_texture_dds?.source
    if (sourceIndex == null) {
      return null
    }

    const loader = shouldDecodeTransparentBaseColorSource(this.parser.json, sourceIndex) ||
      shouldDecodeNormalSource(this.parser.json, sourceIndex, this.decodeNormalSources)
      ? new MSFSDecodedDDSLoader(this.parser.options.manager)
      : new MSFSDDSLoader(this.parser.options.manager)

    return this.parser.loadTextureImage(
      textureIndex,
      sourceIndex,
      loader
    )
  }
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
  decodeNormalSources: boolean
): boolean {
  if (!decodeNormalSources || json.materials == null || json.textures == null) {
    return false
  }

  for (const material of json.materials) {
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

export function createMsftTextureDdsExtension(
  parser: GltfParserLike,
  options: {
    readonly decodeNormalSources?: boolean
  } = {}
): {
  readonly name: string
  loadTexture(textureIndex: number): Promise<unknown> | null
} {
  return new MSFTTextureDDSExtension(parser, options.decodeNormalSources === true)
}
