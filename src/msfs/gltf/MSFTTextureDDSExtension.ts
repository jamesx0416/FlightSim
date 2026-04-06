import type { LoadingManager } from 'three'

import { MSFSDDSLoader } from './MSFSDDSLoader'

const EXTENSION_NAME = 'MSFT_texture_dds'

interface GltfTextureDef {
  readonly extensions?: {
    readonly MSFT_texture_dds?: {
      readonly source: number
    }
  }
}

interface GltfParserLike {
  readonly json: {
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

    return this.parser.loadTextureImage(
      textureIndex,
      sourceIndex,
      new MSFSDDSLoader(this.parser.options.manager)
    )
  }
}

export function createMsftTextureDdsExtension(parser: GltfParserLike): {
  readonly name: string
  loadTexture(textureIndex: number): Promise<unknown> | null
} {
  return new MSFTTextureDDSExtension(parser)
}
