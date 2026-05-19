import {
  CompressedTexture,
  DataTexture,
  FileLoader,
  LinearFilter,
  LinearMipmapLinearFilter,
  Loader,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type LoadingManager,
  type Texture
} from 'three'

import { MSFSDecodedDDSLoader } from './MSFSDecodedDDSLoader'
import {
  MSFSDDSLoader,
  type MSFSDDSLoadOptions,
  type MSFSDDSPlaceholderKind
} from './MSFSDDSLoader'

export class MSFSMipSafeDDSLoader extends Loader<Texture> {
  constructor(
    manager?: LoadingManager,
    private readonly options: MSFSDDSLoadOptions = {}
  ) {
    super(manager)
  }

  override load(
    url: string,
    onLoad?: (data: Texture) => void,
    onProgress?: (event: ProgressEvent<EventTarget>) => void,
    onError?: (error: unknown) => void
  ): Texture {
    const placeholder = createPlaceholderTexture(this.options.placeholderKind ?? 'color')
    const fileLoader = new FileLoader(this.manager)
    fileLoader.setPath(this.path)
    fileLoader.setResponseType('arraybuffer')
    fileLoader.setRequestHeader(this.requestHeader)
    fileLoader.setWithCredentials(this.withCredentials)

    if (this.options.skipTextures === true) {
      onLoad?.(placeholder)
      return placeholder
    }

    if (this.options.rangeMaxTextureSize != null && this.options.rangeMaxTextureSize > 0) {
      const rangeLoader = new MSFSDecodedDDSLoader(this.manager, this.options)
      rangeLoader.setPath(this.path)
      rangeLoader.setRequestHeader(this.requestHeader)
      rangeLoader.setWithCredentials(this.withCredentials)
      return rangeLoader.load(url, onLoad, onProgress, onError)
    }

    if (this.options.immediatePlaceholder === true) {
      onLoad?.(placeholder)
    }

    fileLoader.load(
      url,
      buffer => {
        try {
          const arrayBuffer = buffer as ArrayBuffer
          const compressed = new MSFSDDSLoader(this.manager, this.options).parse(arrayBuffer, {
            loadMipmaps: this.options.loadMipmaps !== false,
            maxTextureSize: this.options.initialMaxTextureSize ?? this.options.maxTextureSize
          })

          if (shouldDecodeForGeneratedMipmaps(compressed)) {
            try {
              const decodedTexture = createDecodedTextureWithGeneratedMipmaps(arrayBuffer, this.options)
              if (this.options.immediatePlaceholder === true) {
                copyLoadedTextureState(placeholder, decodedTexture)
              } else {
                onLoad?.(decodedTexture)
              }
              return
            } catch {
              const compressedTexture = createCompressedTexture(compressed)
              if (this.options.immediatePlaceholder === true) {
                copyLoadedTextureState(placeholder, compressedTexture)
              } else {
                onLoad?.(compressedTexture)
              }
              return
            }
          }

          const compressedTexture = createCompressedTexture(compressed)
          if (this.options.immediatePlaceholder === true) {
            copyLoadedTextureState(placeholder, compressedTexture)
          } else {
            onLoad?.(compressedTexture)
          }
        } catch (error) {
          onError?.(error)
          this.manager.itemError(url)
        }
      },
      onProgress,
      onError
    )

    return placeholder
  }
}

function copyLoadedTextureState(target: Texture, source: Texture): void {
  target.image = source.image
  target.mipmaps = source.mipmaps
  target.format = source.format
  target.type = source.type
  target.colorSpace = source.colorSpace
  target.flipY = source.flipY
  target.minFilter = source.minFilter
  target.magFilter = source.magFilter
  target.generateMipmaps = source.generateMipmaps
  target.needsUpdate = true
}

function shouldDecodeForGeneratedMipmaps(parsed: ReturnType<MSFSDDSLoader['parse']>): boolean {
  return (
    !parsed.isCubemap &&
    parsed.mipmapCount === 1 &&
    parsed.width > 1 &&
    parsed.height > 1
  )
}

function createDecodedTextureWithGeneratedMipmaps(
  buffer: ArrayBuffer,
  options: MSFSDDSLoadOptions
): Texture {
  const parsed = new MSFSDecodedDDSLoader(undefined, options).parse(buffer, {
    loadMipmaps: false,
    maxTextureSize: options.initialMaxTextureSize ?? options.maxTextureSize
  })
  const baseMip = parsed.mipmaps[0]
  const texture = new DataTexture()

  texture.image = {
    data: baseMip?.data ?? new Uint8Array([128, 128, 255, 255]),
    width: parsed.width,
    height: parsed.height
  }
  texture.mipmaps = []
  texture.format = parsed.format as never
  texture.type = UnsignedByteType
  texture.colorSpace = NoColorSpace
  texture.flipY = false
  texture.generateMipmaps = true
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.needsUpdate = true

  return texture
}

function createCompressedTexture(parsed: ReturnType<MSFSDDSLoader['parse']>): CompressedTexture {
  const texture = new (CompressedTexture as typeof CompressedTexture & { new(): CompressedTexture })()

  if (parsed.isCubemap) {
    texture.image = createCompressedCubemapImages(parsed) as never
  } else {
    texture.image.width = parsed.width
    texture.image.height = parsed.height
    texture.mipmaps = parsed.mipmaps as never
  }

  texture.format = parsed.format as never
  texture.flipY = false
  texture.generateMipmaps = false
  texture.minFilter = parsed.mipmapCount === 1 ? LinearFilter : LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.needsUpdate = true

  return texture
}

function createCompressedCubemapImages(parsed: ReturnType<MSFSDDSLoader['parse']>): Array<{
  width: number
  height: number
  format: number | null
  mipmaps: ReturnType<MSFSDDSLoader['parse']>['mipmaps']
}> {
  const images: Array<{
    width: number
    height: number
    format: number | null
    mipmaps: ReturnType<MSFSDDSLoader['parse']>['mipmaps']
  }> = []
  const faces = parsed.mipmaps.length / parsed.mipmapCount

  for (let faceIndex = 0; faceIndex < faces; faceIndex += 1) {
    images[faceIndex] = {
      width: parsed.width,
      height: parsed.height,
      format: parsed.format,
      mipmaps: []
    }

    for (let mipIndex = 0; mipIndex < parsed.mipmapCount; mipIndex += 1) {
      images[faceIndex]!.mipmaps.push(parsed.mipmaps[faceIndex * parsed.mipmapCount + mipIndex]!)
    }
  }

  return images
}

function createPlaceholderTexture(placeholderKind: MSFSDDSPlaceholderKind): Texture {
  const data =
    placeholderKind === 'normal'
      ? new Uint8Array([128, 128, 255, 255])
      : placeholderKind === 'transparent'
        ? new Uint8Array([255, 255, 255, 0])
        : new Uint8Array([128, 128, 128, 255])
  const texture = new DataTexture(data, 1, 1, RGBAFormat, UnsignedByteType)
  texture.colorSpace = placeholderKind === 'normal' ? NoColorSpace : SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
