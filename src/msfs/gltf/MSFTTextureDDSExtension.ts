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
  readonly pbrMetallicRoughness?: {
    readonly baseColorTexture?: GltfTextureRef
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

  constructor(private readonly parser: GltfParserLike) {}

  loadTexture(textureIndex: number): Promise<unknown> | null {
    const textureDef = this.parser.json.textures?.[textureIndex]
    const sourceIndex = textureDef?.extensions?.MSFT_texture_dds?.source
    if (sourceIndex == null) {
      return null
    }

    const loader = shouldDecodeTransparentBaseColorSource(this.parser.json, sourceIndex)
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

export function createMsftTextureDdsExtension(parser: GltfParserLike): {
  readonly name: string
  loadTexture(textureIndex: number): Promise<unknown> | null
} {
  return new MSFTTextureDDSExtension(parser)
}
