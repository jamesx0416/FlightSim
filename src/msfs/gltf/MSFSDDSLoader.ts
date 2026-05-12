import {
  CompressedTexture,
  DataTexture,
  FileLoader,
  LinearFilter,
  LinearMipmapLinearFilter,
  CompressedTextureLoader,
  RED_GREEN_RGTC2_Format,
  RED_RGTC1_Format,
  RGBA_BPTC_Format,
  RGBAFormat,
  RGBA_S3TC_DXT3_Format,
  RGBA_S3TC_DXT5_Format,
  RGB_BPTC_SIGNED_Format,
  RGB_BPTC_UNSIGNED_Format,
  RGB_ETC1_Format,
  RGB_S3TC_DXT1_Format,
  SIGNED_RED_GREEN_RGTC2_Format,
  SIGNED_RED_RGTC1_Format,
  UnsignedByteType
} from 'three'

type DdsParseResult = {
  readonly mipmaps: Array<{
    readonly data: Uint8Array
    readonly width: number
    readonly height: number
  }>
  width: number
  height: number
  format: number | null
  mipmapCount: number
  isCubemap: boolean
}

type DdsParseOptions = {
  readonly loadMipmaps?: boolean
  readonly maxTextureSize?: number
}

type DdsFormatInfo = {
  readonly blockBytes: number
  readonly format: number
  readonly dataOffset: number
  readonly isRgbaUncompressed: boolean
  readonly isRgbUncompressed: boolean
}

type DdsHeaderInfo = DdsFormatInfo & {
  readonly width: number
  readonly height: number
  readonly mipmapCount: number
  readonly isCubemap: boolean
}

type DdsMipLayout = {
  readonly mipIndex: number
  readonly offset: number
  readonly byteLength: number
  readonly width: number
  readonly height: number
}

export type MSFSDDSPlaceholderKind = 'color' | 'transparent' | 'normal'

export type MSFSDDSLoadOptions = {
  readonly loadMipmaps?: boolean
  readonly maxTextureSize?: number
  readonly initialMaxTextureSize?: number
  readonly rangeMaxTextureSize?: number
  readonly rangeFallback?: 'placeholder' | 'full'
  readonly upgradeDelayMs?: number
  readonly upgradeToFullResolution?: boolean
  readonly immediatePlaceholder?: boolean
  readonly placeholderKind?: MSFSDDSPlaceholderKind
  readonly skipTextures?: boolean
}

export class MSFSDDSLoader extends CompressedTextureLoader {
  constructor(
    manager?: ConstructorParameters<typeof CompressedTextureLoader>[0],
    private readonly options: MSFSDDSLoadOptions = {}
  ) {
    super(manager)
  }

  override load(
    url: string | string[],
    onLoad?: (texture: CompressedTexture) => void,
    onProgress?: (event: ProgressEvent<EventTarget>) => void,
    onError?: (error: unknown) => void
  ): CompressedTexture {
    const texture = new (CompressedTexture as typeof CompressedTexture & { new(): CompressedTexture })()
    const loader = new FileLoader(this.manager)
    loader.setPath(this.path)
    loader.setResponseType('arraybuffer')
    loader.setRequestHeader(this.requestHeader)
    loader.setWithCredentials(this.withCredentials)

    if (this.options.skipTextures === true) {
      applyPlaceholderTexture(texture, this.options.placeholderKind ?? 'color')
      onLoad?.(texture)
      return texture
    }

    const useImmediatePlaceholder = this.options.immediatePlaceholder === true
    if (useImmediatePlaceholder) {
      applyPlaceholderTexture(texture, this.options.placeholderKind ?? 'color')
      onLoad?.(texture)
    }

    const handleParsedTexture = (texDatas: DdsParseResult): void => {
      applyParsedTexture(texture, texDatas)
      if (!useImmediatePlaceholder) {
        onLoad?.(texture)
      }
    }

    const loadSingle = (requestUrl: string): void => {
      if (this.options.rangeMaxTextureSize != null && this.options.rangeMaxTextureSize > 0) {
        this.loadSingleRangeMip(
          requestUrl,
          texture,
          handleParsedTexture,
          onLoad,
          onProgress,
          onError,
          loader
        )
        return
      }

      loader.load(
        requestUrl,
        buffer => {
          try {
            const arrayBuffer = buffer as ArrayBuffer
            const initialTexDatas = this.parse(arrayBuffer, {
              loadMipmaps: this.options.loadMipmaps !== false,
              maxTextureSize: this.options.initialMaxTextureSize ?? this.options.maxTextureSize
            })
            handleParsedTexture(initialTexDatas)
            if (this.options.upgradeToFullResolution === true) {
              this.scheduleFullResolutionUpgrade(texture, arrayBuffer, initialTexDatas)
            }
          } catch (error) {
            onError?.(error)
            this.manager.itemError(requestUrl)
          }
        },
        onProgress,
        onError
      )
    }

    if (Array.isArray(url)) {
      let loadedFaces = 0
      const faceImages: Array<{
        width: number
        height: number
        format: number | null
        mipmaps: DdsParseResult['mipmaps']
      }> = new Array(url.length)

      url.forEach((requestUrl, index) => {
        loader.load(
          requestUrl,
          buffer => {
            try {
              const texDatas = this.parse(buffer as ArrayBuffer, {
                loadMipmaps: this.options.loadMipmaps !== false,
                maxTextureSize: this.options.maxTextureSize
              })
              faceImages[index] = {
                width: texDatas.width,
                height: texDatas.height,
                format: texDatas.format,
                mipmaps: texDatas.mipmaps
              }
              loadedFaces += 1
              if (loadedFaces !== url.length) {
                return
              }

              if (texDatas.mipmapCount === 1) {
                texture.minFilter = LinearFilter
              }

              texture.image = faceImages as never
              texture.format = texDatas.format as never
              texture.needsUpdate = true
              if (!useImmediatePlaceholder) {
                onLoad?.(texture)
              }
            } catch (error) {
              onError?.(error)
              this.manager.itemError(requestUrl)
            }
          },
          onProgress,
          onError
        )
      })

      return texture
    }

    loadSingle(url)
    return texture
  }

  private loadSingleRangeMip(
    requestUrl: string,
    texture: CompressedTexture,
    onParsed: (texDatas: DdsParseResult) => void,
    onLoad: ((texture: CompressedTexture) => void) | undefined,
    onProgress: ((event: ProgressEvent<EventTarget>) => void) | undefined,
    onError: ((error: unknown) => void) | undefined,
    fallbackLoader: FileLoader
  ): void {
    const itemUrl = resolveTextureUrl(this.path, requestUrl)
    const resolvedUrl = this.manager.resolveURL(itemUrl)
    this.manager.itemStart(resolvedUrl)
    void shouldBypassDdsRangeReduction(resolvedUrl, this.requestHeader)
      .then(bypassRangeReduction => {
        if (bypassRangeReduction) {
          this.manager.itemEnd(resolvedUrl)
          this.loadFullTexture(requestUrl, onParsed, onProgress, onError, fallbackLoader)
          return undefined
        }

        return this.fetchRangeMipTexture(resolvedUrl, onProgress)
      })
      .then(texDatas => {
        if (texDatas === undefined) {
          return
        }
        if (texDatas == null) {
          this.manager.itemEnd(resolvedUrl)
          this.loadRangeFallback(
            requestUrl,
            texture,
            onParsed,
            onLoad,
            onProgress,
            onError,
            fallbackLoader
          )
          return
        }

        onParsed(texDatas)
        this.manager.itemEnd(resolvedUrl)
      })
      .catch(error => {
        this.manager.itemEnd(resolvedUrl)
        this.loadRangeFallback(
          requestUrl,
          texture,
          onParsed,
          onLoad,
          onProgress,
          onError,
          fallbackLoader,
          error
        )
      })
  }

  private loadRangeFallback(
    requestUrl: string,
    texture: CompressedTexture,
    onParsed: (texDatas: DdsParseResult) => void,
    onLoad: ((texture: CompressedTexture) => void) | undefined,
    onProgress: ((event: ProgressEvent<EventTarget>) => void) | undefined,
    onError: ((error: unknown) => void) | undefined,
    fallbackLoader: FileLoader,
    cause?: unknown
  ): void {
    if (this.options.rangeFallback === 'full') {
      this.loadFullTexture(requestUrl, onParsed, onProgress, onError, fallbackLoader)
      return
    }

    applyPlaceholderTexture(texture, this.options.placeholderKind ?? 'color')
    if (this.options.immediatePlaceholder !== true) {
      onLoad?.(texture)
    }
    if (cause != null && shouldLogDdsFallbacks()) {
      console.warn('DDS range mip load fell back to a placeholder.', cause)
    }
  }

  private loadFullTexture(
    requestUrl: string,
    onParsed: (texDatas: DdsParseResult) => void,
    onProgress: ((event: ProgressEvent<EventTarget>) => void) | undefined,
    onError: ((error: unknown) => void) | undefined,
    loader: FileLoader
  ): void {
    loader.load(
      requestUrl,
      buffer => {
        try {
          const texDatas = this.parse(buffer as ArrayBuffer, {
            loadMipmaps: this.options.loadMipmaps !== false,
            maxTextureSize: this.options.initialMaxTextureSize ?? this.options.maxTextureSize
          })
          onParsed(texDatas)
        } catch (error) {
          onError?.(error)
          this.manager.itemError(requestUrl)
        }
      },
      onProgress,
      onError
    )
  }

  private async fetchRangeMipTexture(
    url: string,
    onProgress: ((event: ProgressEvent<EventTarget>) => void) | undefined
  ): Promise<DdsParseResult | null> {
    const headerBuffer = await fetchArrayBufferRange(url, 0, 4095, this.requestHeader)
    if (headerBuffer == null) {
      return null
    }

    const headerInfo = parseDdsHeaderInfo(headerBuffer, this.options.loadMipmaps !== false)
    if (headerInfo.isCubemap) {
      return null
    }

    const firstMipIndex = computeFirstMipIndex(
      headerInfo.width,
      headerInfo.height,
      headerInfo.mipmapCount,
      this.options.rangeMaxTextureSize
    )
    const mipLayouts = computeDdsMipLayouts(headerInfo)
    const selectedLayouts = mipLayouts.slice(firstMipIndex)
    const firstLayout = selectedLayouts[0]
    const lastLayout = selectedLayouts[selectedLayouts.length - 1]
    if (firstLayout == null || lastLayout == null) {
      return null
    }

    const rangeStart = firstLayout.offset
    const rangeEnd = lastLayout.offset + lastLayout.byteLength - 1
    const dataBuffer = await fetchArrayBufferRange(url, rangeStart, rangeEnd, this.requestHeader)
    if (dataBuffer == null) {
      return null
    }

    onProgress?.(
      new ProgressEvent('progress', {
        lengthComputable: true,
        loaded: headerBuffer.byteLength + dataBuffer.byteLength,
        total: headerBuffer.byteLength + dataBuffer.byteLength
      })
    )

    const mipmaps = selectedLayouts.map(layout => ({
      data: readDdsMipData(headerInfo, dataBuffer, layout.offset - rangeStart, layout),
      width: layout.width,
      height: layout.height
    }))

    return {
      mipmaps,
      width: firstLayout.width,
      height: firstLayout.height,
      format: headerInfo.format,
      mipmapCount: mipmaps.length,
      isCubemap: false
    }
  }

  private scheduleFullResolutionUpgrade(
    texture: CompressedTexture,
    buffer: ArrayBuffer,
    initialTexDatas: DdsParseResult
  ): void {
    if (this.options.initialMaxTextureSize == null) {
      return
    }

    globalThis.setTimeout(() => {
      try {
        const upgradedTexDatas = this.parse(buffer, {
          loadMipmaps: this.options.loadMipmaps !== false,
          maxTextureSize: this.options.maxTextureSize
        })
        if (
          upgradedTexDatas.width === initialTexDatas.width &&
          upgradedTexDatas.height === initialTexDatas.height &&
          upgradedTexDatas.mipmapCount === initialTexDatas.mipmapCount
        ) {
          return
        }

        applyParsedTexture(texture, upgradedTexDatas)
      } catch (error) {
        console.warn('Failed to upgrade DDS texture mip level.', error)
      }
    }, Math.max(0, this.options.upgradeDelayMs ?? 0))
  }

  parse(buffer: ArrayBuffer, loadMipmaps?: boolean): DdsParseResult
  parse(buffer: ArrayBuffer, options?: DdsParseOptions): DdsParseResult
  parse(buffer: ArrayBuffer, options: boolean | DdsParseOptions = true): DdsParseResult {
    const parseOptions = normalizeDdsParseOptions(options)
    const dds: DdsParseResult = {
      mipmaps: [],
      width: 0,
      height: 0,
      format: null,
      mipmapCount: 1,
      isCubemap: false
    }

    const DDS_MAGIC = 0x20534444
    const DDSD_MIPMAPCOUNT = 0x20000
    const DDSCAPS2_CUBEMAP = 0x200
    const DDSCAPS2_CUBEMAP_POSITIVEX = 0x400
    const DDSCAPS2_CUBEMAP_NEGATIVEX = 0x800
    const DDSCAPS2_CUBEMAP_POSITIVEY = 0x1000
    const DDSCAPS2_CUBEMAP_NEGATIVEY = 0x2000
    const DDSCAPS2_CUBEMAP_POSITIVEZ = 0x4000
    const DDSCAPS2_CUBEMAP_NEGATIVEZ = 0x8000

    const DXGI_FORMAT_BC4_UNORM = 80
    const DXGI_FORMAT_BC4_SNORM = 81
    const DXGI_FORMAT_BC5_UNORM = 83
    const DXGI_FORMAT_BC5_SNORM = 84
    const DXGI_FORMAT_BC6H_UF16 = 95
    const DXGI_FORMAT_BC6H_SF16 = 96
    const DXGI_FORMAT_BC7_UNORM = 98
    const DXGI_FORMAT_BC7_UNORM_SRGB = 99

    const fourCCToInt32 = (value: string): number =>
      value.charCodeAt(0) +
      (value.charCodeAt(1) << 8) +
      (value.charCodeAt(2) << 16) +
      (value.charCodeAt(3) << 24)

    const int32ToFourCC = (value: number): string =>
      String.fromCharCode(
        value & 0xff,
        (value >> 8) & 0xff,
        (value >> 16) & 0xff,
        (value >> 24) & 0xff
      )

    const loadArgbMip = (
      sourceBuffer: ArrayBuffer,
      dataOffset: number,
      width: number,
      height: number
    ): Uint8Array => {
      const dataLength = width * height * 4
      const source = new Uint8Array(sourceBuffer, dataOffset, dataLength)
      const target = new Uint8Array(dataLength)
      let destinationOffset = 0
      let sourceOffset = 0

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const blue = source[sourceOffset]
          sourceOffset += 1
          const green = source[sourceOffset]
          sourceOffset += 1
          const red = source[sourceOffset]
          sourceOffset += 1
          const alpha = source[sourceOffset]
          sourceOffset += 1

          target[destinationOffset] = red
          destinationOffset += 1
          target[destinationOffset] = green
          destinationOffset += 1
          target[destinationOffset] = blue
          destinationOffset += 1
          target[destinationOffset] = alpha
          destinationOffset += 1
        }
      }

      return target
    }

    const loadRgbMip = (
      sourceBuffer: ArrayBuffer,
      dataOffset: number,
      width: number,
      height: number
    ): Uint8Array => {
      const dataLength = width * height * 3
      const source = new Uint8Array(sourceBuffer, dataOffset, dataLength)
      const target = new Uint8Array(width * height * 4)
      let destinationOffset = 0
      let sourceOffset = 0

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const blue = source[sourceOffset]
          sourceOffset += 1
          const green = source[sourceOffset]
          sourceOffset += 1
          const red = source[sourceOffset]
          sourceOffset += 1

          target[destinationOffset] = red
          destinationOffset += 1
          target[destinationOffset] = green
          destinationOffset += 1
          target[destinationOffset] = blue
          destinationOffset += 1
          target[destinationOffset] = 255
          destinationOffset += 1
        }
      }

      return target
    }

    const FOURCC_DXT1 = fourCCToInt32('DXT1')
    const FOURCC_DXT3 = fourCCToInt32('DXT3')
    const FOURCC_DXT5 = fourCCToInt32('DXT5')
    const FOURCC_ETC1 = fourCCToInt32('ETC1')
    const FOURCC_ATI1 = fourCCToInt32('ATI1')
    const FOURCC_AT1N = fourCCToInt32('AT1N')
    const FOURCC_BC4U = fourCCToInt32('BC4U')
    const FOURCC_BC4S = fourCCToInt32('BC4S')
    const FOURCC_ATI2 = fourCCToInt32('ATI2')
    const FOURCC_AT2N = fourCCToInt32('AT2N')
    const FOURCC_BC5U = fourCCToInt32('BC5U')
    const FOURCC_BC5S = fourCCToInt32('BC5S')
    const FOURCC_DX10 = fourCCToInt32('DX10')

    const headerLengthInt = 31
    const extendedHeaderLengthInt = 5
    const offMagic = 0
    const offSize = 1
    const offFlags = 2
    const offHeight = 3
    const offWidth = 4
    const offMipmapCount = 7
    const offPfFourCC = 21
    const offRgbBitCount = 22
    const offRBitMask = 23
    const offGBitMask = 24
    const offBBitMask = 25
    const offABitMask = 26
    const offCaps2 = 28
    const offDxgiFormat = 0

    const header = new Int32Array(buffer, 0, headerLengthInt)
    if (header[offMagic] !== DDS_MAGIC) {
      throw new Error('THREE.MSFSDDSLoader.parse: Invalid magic number in DDS header.')
    }

    let blockBytes = 0
    const fourCC = header[offPfFourCC]
    let isRgbaUncompressed = false
    let isRgbUncompressed = false
    let dataOffset = header[offSize] + 4

    switch (fourCC) {
      case FOURCC_DXT1:
        blockBytes = 8
        dds.format = RGB_S3TC_DXT1_Format
        break
      case FOURCC_DXT3:
        blockBytes = 16
        dds.format = RGBA_S3TC_DXT3_Format
        break
      case FOURCC_DXT5:
        blockBytes = 16
        dds.format = RGBA_S3TC_DXT5_Format
        break
      case FOURCC_ETC1:
        blockBytes = 8
        dds.format = RGB_ETC1_Format
        break
      case FOURCC_ATI1:
      case FOURCC_AT1N:
      case FOURCC_BC4U:
        blockBytes = 8
        dds.format = RED_RGTC1_Format
        break
      case FOURCC_BC4S:
        blockBytes = 8
        dds.format = SIGNED_RED_RGTC1_Format
        break
      case FOURCC_ATI2:
      case FOURCC_AT2N:
      case FOURCC_BC5U:
        blockBytes = 16
        dds.format = RED_GREEN_RGTC2_Format
        break
      case FOURCC_BC5S:
        blockBytes = 16
        dds.format = SIGNED_RED_GREEN_RGTC2_Format
        break
      case FOURCC_DX10: {
        dataOffset += extendedHeaderLengthInt * 4
        const extendedHeader = new Int32Array(
          buffer,
          (headerLengthInt + 1) * 4,
          extendedHeaderLengthInt
        )
        const dxgiFormat = extendedHeader[offDxgiFormat]
        switch (dxgiFormat) {
          case DXGI_FORMAT_BC4_UNORM:
            blockBytes = 8
            dds.format = RED_RGTC1_Format
            break
          case DXGI_FORMAT_BC4_SNORM:
            blockBytes = 8
            dds.format = SIGNED_RED_RGTC1_Format
            break
          case DXGI_FORMAT_BC5_UNORM:
            blockBytes = 16
            dds.format = RED_GREEN_RGTC2_Format
            break
          case DXGI_FORMAT_BC5_SNORM:
            blockBytes = 16
            dds.format = SIGNED_RED_GREEN_RGTC2_Format
            break
          case DXGI_FORMAT_BC6H_SF16:
            blockBytes = 16
            dds.format = RGB_BPTC_SIGNED_Format
            break
          case DXGI_FORMAT_BC6H_UF16:
            blockBytes = 16
            dds.format = RGB_BPTC_UNSIGNED_Format
            break
          case DXGI_FORMAT_BC7_UNORM:
          case DXGI_FORMAT_BC7_UNORM_SRGB:
            blockBytes = 16
            dds.format = RGBA_BPTC_Format
            break
          default:
            throw new Error(
              `THREE.MSFSDDSLoader.parse: Unsupported DXGI_FORMAT code ${dxgiFormat}.`
            )
        }
        break
      }
      default:
        if (
          header[offRgbBitCount] === 32 &&
          (header[offRBitMask] & 0xff0000) !== 0 &&
          (header[offGBitMask] & 0xff00) !== 0 &&
          (header[offBBitMask] & 0xff) !== 0 &&
          (header[offABitMask] & 0xff000000) !== 0
        ) {
          isRgbaUncompressed = true
          blockBytes = 64
          dds.format = RGBAFormat
        } else if (
          header[offRgbBitCount] === 24 &&
          (header[offRBitMask] & 0xff0000) !== 0 &&
          (header[offGBitMask] & 0xff00) !== 0 &&
          (header[offBBitMask] & 0xff) !== 0
        ) {
          isRgbUncompressed = true
          blockBytes = 64
          dds.format = RGBAFormat
        } else {
          throw new Error(
            `THREE.MSFSDDSLoader.parse: Unsupported FourCC code ${int32ToFourCC(fourCC)}.`
          )
        }
    }

    if ((header[offFlags] & DDSD_MIPMAPCOUNT) !== 0 && parseOptions.loadMipmaps !== false) {
      dds.mipmapCount = Math.max(1, header[offMipmapCount])
    }

    const caps2 = header[offCaps2]
    dds.isCubemap = (caps2 & DDSCAPS2_CUBEMAP) !== 0
    if (
      dds.isCubemap &&
      ((caps2 & DDSCAPS2_CUBEMAP_POSITIVEX) === 0 ||
        (caps2 & DDSCAPS2_CUBEMAP_NEGATIVEX) === 0 ||
        (caps2 & DDSCAPS2_CUBEMAP_POSITIVEY) === 0 ||
        (caps2 & DDSCAPS2_CUBEMAP_NEGATIVEY) === 0 ||
        (caps2 & DDSCAPS2_CUBEMAP_POSITIVEZ) === 0 ||
        (caps2 & DDSCAPS2_CUBEMAP_NEGATIVEZ) === 0)
    ) {
      throw new Error('THREE.MSFSDDSLoader.parse: Incomplete cubemap faces.')
    }

    const sourceWidth = header[offWidth]
    const sourceHeight = header[offHeight]
    const sourceMipmapCount = dds.mipmapCount
    const firstMipIndex = computeFirstMipIndex(
      sourceWidth,
      sourceHeight,
      sourceMipmapCount,
      parseOptions.maxTextureSize
    )
    dds.width = computeMipDimension(sourceWidth, firstMipIndex)
    dds.height = computeMipDimension(sourceHeight, firstMipIndex)
    dds.mipmapCount = sourceMipmapCount - firstMipIndex

    const faceCount = dds.isCubemap ? 6 : 1
    for (let faceIndex = 0; faceIndex < faceCount; faceIndex += 1) {
      let width = sourceWidth
      let height = sourceHeight

      for (let mipIndex = 0; mipIndex < sourceMipmapCount; mipIndex += 1) {
        const shouldLoadMip = mipIndex >= firstMipIndex
        let dataLength = 0
        let byteArray: Uint8Array | null = null

        if (isRgbaUncompressed) {
          dataLength = width * height * 4
          if (shouldLoadMip) {
            byteArray = loadArgbMip(buffer, dataOffset, width, height)
          }
        } else if (isRgbUncompressed) {
          dataLength = width * height * 3
          if (shouldLoadMip) {
            byteArray = loadRgbMip(buffer, dataOffset, width, height)
          }
        } else {
          dataLength = (Math.max(4, width) / 4) * (Math.max(4, height) / 4) * blockBytes
          if (shouldLoadMip) {
            byteArray = new Uint8Array(buffer, dataOffset, dataLength).slice()
          }
        }

        if (byteArray != null) {
          dds.mipmaps.push({ data: byteArray, width, height })
        }
        dataOffset += dataLength
        width = Math.max(width >> 1, 1)
        height = Math.max(height >> 1, 1)
      }
    }

    return dds
  }
}

function applyParsedTexture(texture: CompressedTexture, texDatas: DdsParseResult): void {
  if (texDatas.isCubemap) {
    const images: Array<{
      width: number
      height: number
      format: number | null
      mipmaps: DdsParseResult['mipmaps']
    }> = []
    const faces = texDatas.mipmaps.length / texDatas.mipmapCount

    for (let faceIndex = 0; faceIndex < faces; faceIndex += 1) {
      images[faceIndex] = {
        mipmaps: [],
        format: texDatas.format,
        width: texDatas.width,
        height: texDatas.height
      }

      for (let mipIndex = 0; mipIndex < texDatas.mipmapCount; mipIndex += 1) {
        images[faceIndex]!.mipmaps.push(
          texDatas.mipmaps[faceIndex * texDatas.mipmapCount + mipIndex]!
        )
      }
    }

    texture.image = images as never
  } else {
    texture.image.width = texDatas.width
    texture.image.height = texDatas.height
    texture.mipmaps = texDatas.mipmaps as never
  }

  texture.minFilter = texDatas.mipmapCount === 1 ? LinearFilter : LinearMipmapLinearFilter
  texture.format = texDatas.format as never
  texture.needsUpdate = true
}

function applyPlaceholderTexture(
  texture: CompressedTexture,
  placeholderKind: MSFSDDSPlaceholderKind
): void {
  const data =
    placeholderKind === 'normal'
      ? new Uint8Array([128, 128, 255, 255])
      : placeholderKind === 'transparent'
        ? new Uint8Array([255, 255, 255, 0])
        : new Uint8Array([128, 128, 128, 255])
  const placeholder = new DataTexture(data, 1, 1, RGBAFormat, UnsignedByteType)
  texture.image = placeholder.image
  texture.mipmaps = []
  texture.format = RGBAFormat as never
  texture.type = UnsignedByteType
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
}

function normalizeDdsParseOptions(options: boolean | DdsParseOptions): DdsParseOptions {
  return typeof options === 'boolean' ? { loadMipmaps: options } : options
}

function resolveTextureUrl(path: string, url: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) {
    return url
  }

  if (path === '') {
    return url
  }

  try {
    return new URL(url, path).toString()
  } catch {
    return `${path}${url}`
  }
}

async function fetchArrayBufferRange(
  url: string,
  start: number,
  end: number,
  requestHeader: Record<string, string>
): Promise<ArrayBuffer | null> {
  const headers = new Headers(requestHeader)
  headers.set('Range', `bytes=${start}-${end}`)
  const response = await fetchWithTimeout(url, {
    headers,
    credentials: 'same-origin'
  }, 2000)

  if (response.status !== 206) {
    await response.body?.cancel()
    return null
  }

  return response.arrayBuffer()
}

export async function shouldBypassDdsRangeReduction(
  url: string,
  requestHeader: Record<string, string>
): Promise<boolean> {
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return false
  }

  let response: Response
  try {
    response = await fetchWithTimeout(`${url}.FLAGS`, {
      headers: requestHeader,
      credentials: 'same-origin'
    }, 500)
  } catch {
    return false
  }

  if (!response.ok) {
    await response.body?.cancel()
    return false
  }

  const flags = (await response.text()).toUpperCase()
  return flags.includes('+NOREDUCE') || /\bNOREDUCE\b/.test(flags)
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function shouldLogDdsFallbacks(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has('ddsDebug')
  } catch {
    return false
  }
}

const DDS_MAGIC = 0x20534444
const DDSD_MIPMAPCOUNT = 0x20000
const DDSCAPS2_CUBEMAP = 0x200
const DDSCAPS2_CUBEMAP_POSITIVEX = 0x400
const DDSCAPS2_CUBEMAP_NEGATIVEX = 0x800
const DDSCAPS2_CUBEMAP_POSITIVEY = 0x1000
const DDSCAPS2_CUBEMAP_NEGATIVEY = 0x2000
const DDSCAPS2_CUBEMAP_POSITIVEZ = 0x4000
const DDSCAPS2_CUBEMAP_NEGATIVEZ = 0x8000

const DXGI_FORMAT_BC4_UNORM = 80
const DXGI_FORMAT_BC4_SNORM = 81
const DXGI_FORMAT_BC5_UNORM = 83
const DXGI_FORMAT_BC5_SNORM = 84
const DXGI_FORMAT_BC6H_UF16 = 95
const DXGI_FORMAT_BC6H_SF16 = 96
const DXGI_FORMAT_BC7_UNORM = 98
const DXGI_FORMAT_BC7_UNORM_SRGB = 99

const FOURCC_DXT1 = fourCCToInt32('DXT1')
const FOURCC_DXT3 = fourCCToInt32('DXT3')
const FOURCC_DXT5 = fourCCToInt32('DXT5')
const FOURCC_ETC1 = fourCCToInt32('ETC1')
const FOURCC_ATI1 = fourCCToInt32('ATI1')
const FOURCC_AT1N = fourCCToInt32('AT1N')
const FOURCC_BC4U = fourCCToInt32('BC4U')
const FOURCC_BC4S = fourCCToInt32('BC4S')
const FOURCC_ATI2 = fourCCToInt32('ATI2')
const FOURCC_AT2N = fourCCToInt32('AT2N')
const FOURCC_BC5U = fourCCToInt32('BC5U')
const FOURCC_BC5S = fourCCToInt32('BC5S')
const FOURCC_DX10 = fourCCToInt32('DX10')

const DDS_HEADER_LENGTH_INT = 31
const DDS_EXTENDED_HEADER_LENGTH_INT = 5
const DDS_OFF_MAGIC = 0
const DDS_OFF_SIZE = 1
const DDS_OFF_FLAGS = 2
const DDS_OFF_HEIGHT = 3
const DDS_OFF_WIDTH = 4
const DDS_OFF_MIPMAP_COUNT = 7
const DDS_OFF_PF_FOURCC = 21
const DDS_OFF_RGB_BIT_COUNT = 22
const DDS_OFF_R_BIT_MASK = 23
const DDS_OFF_G_BIT_MASK = 24
const DDS_OFF_B_BIT_MASK = 25
const DDS_OFF_A_BIT_MASK = 26
const DDS_OFF_CAPS2 = 28
const DDS_OFF_DXGI_FORMAT = 0

function parseDdsHeaderInfo(buffer: ArrayBuffer, loadMipmaps: boolean): DdsHeaderInfo {
  const header = new Int32Array(buffer, 0, DDS_HEADER_LENGTH_INT)
  if (header[DDS_OFF_MAGIC] !== DDS_MAGIC) {
    throw new Error('THREE.MSFSDDSLoader.range: Invalid magic number in DDS header.')
  }

  const formatInfo = parseDdsFormatInfo(buffer, header)
  const caps2 = header[DDS_OFF_CAPS2]
  const isCubemap = (caps2 & DDSCAPS2_CUBEMAP) !== 0
  if (
    isCubemap &&
    ((caps2 & DDSCAPS2_CUBEMAP_POSITIVEX) === 0 ||
      (caps2 & DDSCAPS2_CUBEMAP_NEGATIVEX) === 0 ||
      (caps2 & DDSCAPS2_CUBEMAP_POSITIVEY) === 0 ||
      (caps2 & DDSCAPS2_CUBEMAP_NEGATIVEY) === 0 ||
      (caps2 & DDSCAPS2_CUBEMAP_POSITIVEZ) === 0 ||
      (caps2 & DDSCAPS2_CUBEMAP_NEGATIVEZ) === 0)
  ) {
    throw new Error('THREE.MSFSDDSLoader.range: Incomplete cubemap faces.')
  }

  return {
    ...formatInfo,
    width: header[DDS_OFF_WIDTH],
    height: header[DDS_OFF_HEIGHT],
    mipmapCount:
      (header[DDS_OFF_FLAGS] & DDSD_MIPMAPCOUNT) !== 0 && loadMipmaps
        ? Math.max(1, header[DDS_OFF_MIPMAP_COUNT])
        : 1,
    isCubemap
  }
}

function parseDdsFormatInfo(buffer: ArrayBuffer, header: Int32Array): DdsFormatInfo {
  const fourCC = header[DDS_OFF_PF_FOURCC]
  let dataOffset = header[DDS_OFF_SIZE] + 4

  switch (fourCC) {
    case FOURCC_DXT1:
      return createCompressedDdsFormatInfo(8, RGB_S3TC_DXT1_Format, dataOffset)
    case FOURCC_DXT3:
      return createCompressedDdsFormatInfo(16, RGBA_S3TC_DXT3_Format, dataOffset)
    case FOURCC_DXT5:
      return createCompressedDdsFormatInfo(16, RGBA_S3TC_DXT5_Format, dataOffset)
    case FOURCC_ETC1:
      return createCompressedDdsFormatInfo(8, RGB_ETC1_Format, dataOffset)
    case FOURCC_ATI1:
    case FOURCC_AT1N:
    case FOURCC_BC4U:
      return createCompressedDdsFormatInfo(8, RED_RGTC1_Format, dataOffset)
    case FOURCC_BC4S:
      return createCompressedDdsFormatInfo(8, SIGNED_RED_RGTC1_Format, dataOffset)
    case FOURCC_ATI2:
    case FOURCC_AT2N:
    case FOURCC_BC5U:
      return createCompressedDdsFormatInfo(16, RED_GREEN_RGTC2_Format, dataOffset)
    case FOURCC_BC5S:
      return createCompressedDdsFormatInfo(16, SIGNED_RED_GREEN_RGTC2_Format, dataOffset)
    case FOURCC_DX10: {
      dataOffset += DDS_EXTENDED_HEADER_LENGTH_INT * 4
      const extendedHeader = new Int32Array(
        buffer,
        (DDS_HEADER_LENGTH_INT + 1) * 4,
        DDS_EXTENDED_HEADER_LENGTH_INT
      )
      const dxgiFormat = extendedHeader[DDS_OFF_DXGI_FORMAT]
      switch (dxgiFormat) {
        case DXGI_FORMAT_BC4_UNORM:
          return createCompressedDdsFormatInfo(8, RED_RGTC1_Format, dataOffset)
        case DXGI_FORMAT_BC4_SNORM:
          return createCompressedDdsFormatInfo(8, SIGNED_RED_RGTC1_Format, dataOffset)
        case DXGI_FORMAT_BC5_UNORM:
          return createCompressedDdsFormatInfo(16, RED_GREEN_RGTC2_Format, dataOffset)
        case DXGI_FORMAT_BC5_SNORM:
          return createCompressedDdsFormatInfo(16, SIGNED_RED_GREEN_RGTC2_Format, dataOffset)
        case DXGI_FORMAT_BC6H_SF16:
          return createCompressedDdsFormatInfo(16, RGB_BPTC_SIGNED_Format, dataOffset)
        case DXGI_FORMAT_BC6H_UF16:
          return createCompressedDdsFormatInfo(16, RGB_BPTC_UNSIGNED_Format, dataOffset)
        case DXGI_FORMAT_BC7_UNORM:
        case DXGI_FORMAT_BC7_UNORM_SRGB:
          return createCompressedDdsFormatInfo(16, RGBA_BPTC_Format, dataOffset)
        default:
          throw new Error(`THREE.MSFSDDSLoader.range: Unsupported DXGI_FORMAT code ${dxgiFormat}.`)
      }
    }
    default:
      if (isDdsRgbaUncompressed(header)) {
        return {
          blockBytes: 64,
          format: RGBAFormat,
          dataOffset,
          isRgbaUncompressed: true,
          isRgbUncompressed: false
        }
      }

      if (isDdsRgbUncompressed(header)) {
        return {
          blockBytes: 64,
          format: RGBAFormat,
          dataOffset,
          isRgbaUncompressed: false,
          isRgbUncompressed: true
        }
      }

      throw new Error(
        `THREE.MSFSDDSLoader.range: Unsupported FourCC code ${int32ToFourCC(fourCC)}.`
      )
  }
}

function createCompressedDdsFormatInfo(
  blockBytes: number,
  format: number,
  dataOffset: number
): DdsFormatInfo {
  return {
    blockBytes,
    format,
    dataOffset,
    isRgbaUncompressed: false,
    isRgbUncompressed: false
  }
}

function computeDdsMipLayouts(header: DdsHeaderInfo): DdsMipLayout[] {
  let width = header.width
  let height = header.height
  let offset = header.dataOffset
  const layouts: DdsMipLayout[] = []

  for (let mipIndex = 0; mipIndex < header.mipmapCount; mipIndex += 1) {
    const byteLength = computeDdsMipByteLength(header, width, height)
    layouts.push({
      mipIndex,
      offset,
      byteLength,
      width,
      height
    })
    offset += byteLength
    width = Math.max(width >> 1, 1)
    height = Math.max(height >> 1, 1)
  }

  return layouts
}

function computeDdsMipByteLength(header: DdsFormatInfo, width: number, height: number): number {
  if (header.isRgbaUncompressed) {
    return width * height * 4
  }

  if (header.isRgbUncompressed) {
    return width * height * 3
  }

  const blockWidth = Math.max(1, Math.ceil(width / 4))
  const blockHeight = Math.max(1, Math.ceil(height / 4))
  return blockWidth * blockHeight * header.blockBytes
}

function readDdsMipData(
  header: DdsHeaderInfo,
  buffer: ArrayBuffer,
  dataOffset: number,
  layout: DdsMipLayout
): Uint8Array {
  if (header.isRgbaUncompressed) {
    return loadArgbMipData(buffer, dataOffset, layout.width, layout.height)
  }

  if (header.isRgbUncompressed) {
    return loadRgbMipData(buffer, dataOffset, layout.width, layout.height)
  }

  return new Uint8Array(buffer, dataOffset, layout.byteLength).slice()
}

function loadArgbMipData(
  sourceBuffer: ArrayBuffer,
  dataOffset: number,
  width: number,
  height: number
): Uint8Array {
  const dataLength = width * height * 4
  const source = new Uint8Array(sourceBuffer, dataOffset, dataLength)
  const target = new Uint8Array(dataLength)
  let destinationOffset = 0
  let sourceOffset = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const blue = source[sourceOffset]
      sourceOffset += 1
      const green = source[sourceOffset]
      sourceOffset += 1
      const red = source[sourceOffset]
      sourceOffset += 1
      const alpha = source[sourceOffset]
      sourceOffset += 1

      target[destinationOffset] = red
      destinationOffset += 1
      target[destinationOffset] = green
      destinationOffset += 1
      target[destinationOffset] = blue
      destinationOffset += 1
      target[destinationOffset] = alpha
      destinationOffset += 1
    }
  }

  return target
}

function loadRgbMipData(
  sourceBuffer: ArrayBuffer,
  dataOffset: number,
  width: number,
  height: number
): Uint8Array {
  const dataLength = width * height * 3
  const source = new Uint8Array(sourceBuffer, dataOffset, dataLength)
  const target = new Uint8Array(width * height * 4)
  let destinationOffset = 0
  let sourceOffset = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const blue = source[sourceOffset]
      sourceOffset += 1
      const green = source[sourceOffset]
      sourceOffset += 1
      const red = source[sourceOffset]
      sourceOffset += 1

      target[destinationOffset] = red
      destinationOffset += 1
      target[destinationOffset] = green
      destinationOffset += 1
      target[destinationOffset] = blue
      destinationOffset += 1
      target[destinationOffset] = 255
      destinationOffset += 1
    }
  }

  return target
}

function isDdsRgbaUncompressed(header: Int32Array): boolean {
  return (
    header[DDS_OFF_RGB_BIT_COUNT] === 32 &&
    (header[DDS_OFF_R_BIT_MASK] & 0xff0000) !== 0 &&
    (header[DDS_OFF_G_BIT_MASK] & 0xff00) !== 0 &&
    (header[DDS_OFF_B_BIT_MASK] & 0xff) !== 0 &&
    (header[DDS_OFF_A_BIT_MASK] & 0xff000000) !== 0
  )
}

function isDdsRgbUncompressed(header: Int32Array): boolean {
  return (
    header[DDS_OFF_RGB_BIT_COUNT] === 24 &&
    (header[DDS_OFF_R_BIT_MASK] & 0xff0000) !== 0 &&
    (header[DDS_OFF_G_BIT_MASK] & 0xff00) !== 0 &&
    (header[DDS_OFF_B_BIT_MASK] & 0xff) !== 0
  )
}

function fourCCToInt32(value: string): number {
  return (
    value.charCodeAt(0) +
    (value.charCodeAt(1) << 8) +
    (value.charCodeAt(2) << 16) +
    (value.charCodeAt(3) << 24)
  )
}

function int32ToFourCC(value: number): string {
  return String.fromCharCode(
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff
  )
}

function computeFirstMipIndex(
  width: number,
  height: number,
  mipmapCount: number,
  maxTextureSize: number | undefined
): number {
  if (maxTextureSize == null || maxTextureSize <= 0) {
    return 0
  }

  let mipIndex = 0
  let mipWidth = width
  let mipHeight = height
  while (
    mipIndex < mipmapCount - 1 &&
    (mipWidth > maxTextureSize || mipHeight > maxTextureSize)
  ) {
    mipIndex += 1
    mipWidth = computeMipDimension(width, mipIndex)
    mipHeight = computeMipDimension(height, mipIndex)
  }

  return mipIndex
}

function computeMipDimension(value: number, mipIndex: number): number {
  return Math.max(1, value >> mipIndex)
}
