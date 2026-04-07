import {
  DataTexture,
  FileLoader,
  LinearFilter,
  Loader,
  RGBAFormat,
  UnsignedByteType,
  type LoadingManager
} from 'three'

type DecodedMipmap = {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

type DecodedDdsTexture = {
  readonly width: number
  readonly height: number
  readonly mipmaps: readonly DecodedMipmap[]
}

const DDS_MAGIC = 0x20534444
const DDSD_MIPMAPCOUNT = 0x20000

const HEADER_LENGTH_INT = 31
const OFF_MAGIC = 0
const OFF_SIZE = 1
const OFF_FLAGS = 2
const OFF_HEIGHT = 3
const OFF_WIDTH = 4
const OFF_MIPMAPCOUNT = 7
const OFF_PF_FOURCC = 21
const OFF_RGB_BIT_COUNT = 22
const OFF_R_BIT_MASK = 23
const OFF_G_BIT_MASK = 24
const OFF_B_BIT_MASK = 25
const OFF_A_BIT_MASK = 26

const FOURCC_DXT1 = fourCCToInt32('DXT1')
const FOURCC_DXT3 = fourCCToInt32('DXT3')
const FOURCC_DXT5 = fourCCToInt32('DXT5')
const FOURCC_ATI2 = fourCCToInt32('ATI2')
const FOURCC_AT2N = fourCCToInt32('AT2N')
const FOURCC_BC5U = fourCCToInt32('BC5U')
const FOURCC_BC5S = fourCCToInt32('BC5S')
const FOURCC_DX10 = fourCCToInt32('DX10')

const DXGI_FORMAT_BC5_UNORM = 83
const DXGI_FORMAT_BC5_SNORM = 84

export class MSFSDecodedDDSLoader extends Loader<DataTexture> {
  constructor(
    manager?: LoadingManager,
    private readonly options: {
      readonly loadMipmaps?: boolean
    } = {}
  ) {
    super(manager)
  }

  override load(
    url: string,
    onLoad?: (data: DataTexture) => void,
    onProgress?: (event: ProgressEvent<EventTarget>) => void,
    onError?: (error: unknown) => void
  ): DataTexture {
    const texture = new DataTexture()
    const fileLoader = new FileLoader(this.manager)
    fileLoader.setPath(this.path)
    fileLoader.setResponseType('arraybuffer')
    fileLoader.setRequestHeader(this.requestHeader)
    fileLoader.setWithCredentials(this.withCredentials)

    fileLoader.load(
      url,
      buffer => {
        try {
          const parsed = this.parse(
            buffer as ArrayBuffer,
            this.options.loadMipmaps !== false
          )
          texture.image = {
            data: parsed.mipmaps[0].data,
            width: parsed.width,
            height: parsed.height
          }
          texture.mipmaps = [...parsed.mipmaps]
          texture.format = RGBAFormat
          texture.type = UnsignedByteType
          texture.flipY = false
          texture.generateMipmaps = false
          texture.minFilter = parsed.mipmaps.length > 1 ? texture.minFilter : LinearFilter
          texture.magFilter = LinearFilter
          texture.needsUpdate = true
          onLoad?.(texture)
        } catch (error) {
          onError?.(error)
          this.manager.itemError(url)
        }
      },
      onProgress,
      onError,
    )

    return texture
  }

  parse(buffer: ArrayBuffer, loadMipmaps = true): DecodedDdsTexture {
    const header = new Int32Array(buffer, 0, HEADER_LENGTH_INT)
    if (header[OFF_MAGIC] !== DDS_MAGIC) {
      throw new Error('Invalid DDS header.')
    }

    const width = header[OFF_WIDTH]
    const height = header[OFF_HEIGHT]
    const mipmapCount =
      (header[OFF_FLAGS] & DDSD_MIPMAPCOUNT) !== 0 && loadMipmaps !== false
        ? Math.max(1, header[OFF_MIPMAPCOUNT])
        : 1
    const fourCC = header[OFF_PF_FOURCC]
    let dataOffset = header[OFF_SIZE] + 4

    let currentWidth = width
    let currentHeight = height
    let currentOffset = dataOffset
    const mipmaps: DecodedMipmap[] = []

    switch (fourCC) {
      case FOURCC_DXT1:
        for (let level = 0; level < mipmapCount; level += 1) {
          const byteLength = computeCompressedMipByteLength(currentWidth, currentHeight, 8)
          mipmaps.push({
            data: decodeDxt1(buffer, currentOffset, currentWidth, currentHeight),
            width: currentWidth,
            height: currentHeight
          })
          currentOffset += byteLength
          currentWidth = Math.max(1, currentWidth >> 1)
          currentHeight = Math.max(1, currentHeight >> 1)
        }
        break
      case FOURCC_DXT3:
        for (let level = 0; level < mipmapCount; level += 1) {
          const byteLength = computeCompressedMipByteLength(currentWidth, currentHeight, 16)
          mipmaps.push({
            data: decodeDxt3(buffer, currentOffset, currentWidth, currentHeight),
            width: currentWidth,
            height: currentHeight
          })
          currentOffset += byteLength
          currentWidth = Math.max(1, currentWidth >> 1)
          currentHeight = Math.max(1, currentHeight >> 1)
        }
        break
      case FOURCC_DXT5:
        for (let level = 0; level < mipmapCount; level += 1) {
          const byteLength = computeCompressedMipByteLength(currentWidth, currentHeight, 16)
          mipmaps.push({
            data: decodeDxt5(buffer, currentOffset, currentWidth, currentHeight),
            width: currentWidth,
            height: currentHeight
          })
          currentOffset += byteLength
          currentWidth = Math.max(1, currentWidth >> 1)
          currentHeight = Math.max(1, currentHeight >> 1)
        }
        break
      case FOURCC_ATI2:
      case FOURCC_AT2N:
      case FOURCC_BC5U:
        for (let level = 0; level < mipmapCount; level += 1) {
          const byteLength = computeCompressedMipByteLength(currentWidth, currentHeight, 16)
          mipmaps.push({
            data: decodeBc5(buffer, currentOffset, currentWidth, currentHeight, false),
            width: currentWidth,
            height: currentHeight
          })
          currentOffset += byteLength
          currentWidth = Math.max(1, currentWidth >> 1)
          currentHeight = Math.max(1, currentHeight >> 1)
        }
        break
      case FOURCC_BC5S:
        for (let level = 0; level < mipmapCount; level += 1) {
          const byteLength = computeCompressedMipByteLength(currentWidth, currentHeight, 16)
          mipmaps.push({
            data: decodeBc5(buffer, currentOffset, currentWidth, currentHeight, true),
            width: currentWidth,
            height: currentHeight
          })
          currentOffset += byteLength
          currentWidth = Math.max(1, currentWidth >> 1)
          currentHeight = Math.max(1, currentHeight >> 1)
        }
        break
      case FOURCC_DX10: {
        const dxgiHeader = new Int32Array(buffer, dataOffset, 5)
        const dxgiFormat = dxgiHeader[0]
        dataOffset += 20
        currentOffset = dataOffset

        if (dxgiFormat !== DXGI_FORMAT_BC5_UNORM && dxgiFormat !== DXGI_FORMAT_BC5_SNORM) {
          throw new Error(`Unsupported DX10 DDS format for RGBA decode: ${dxgiFormat}`)
        }

        const signed = dxgiFormat === DXGI_FORMAT_BC5_SNORM
        for (let level = 0; level < mipmapCount; level += 1) {
          const byteLength = computeCompressedMipByteLength(currentWidth, currentHeight, 16)
          mipmaps.push({
            data: decodeBc5(buffer, currentOffset, currentWidth, currentHeight, signed),
            width: currentWidth,
            height: currentHeight
          })
          currentOffset += byteLength
          currentWidth = Math.max(1, currentWidth >> 1)
          currentHeight = Math.max(1, currentHeight >> 1)
        }
        break
      }
      default:
        if (isUncompressedRgba(header)) {
          for (let level = 0; level < mipmapCount; level += 1) {
            const byteLength = currentWidth * currentHeight * 4
            mipmaps.push({
              data: decodeUncompressedArgb(buffer, currentOffset, currentWidth, currentHeight),
              width: currentWidth,
              height: currentHeight
            })
            currentOffset += byteLength
            currentWidth = Math.max(1, currentWidth >> 1)
            currentHeight = Math.max(1, currentHeight >> 1)
          }
          break
        }

        if (isUncompressedRgb(header)) {
          for (let level = 0; level < mipmapCount; level += 1) {
            const byteLength = currentWidth * currentHeight * 3
            mipmaps.push({
              data: decodeUncompressedRgb(buffer, currentOffset, currentWidth, currentHeight),
              width: currentWidth,
              height: currentHeight
            })
            currentOffset += byteLength
            currentWidth = Math.max(1, currentWidth >> 1)
            currentHeight = Math.max(1, currentHeight >> 1)
          }
          break
        }

        throw new Error(`Unsupported DDS format for RGBA decode: ${int32ToFourCC(fourCC)}`)
    }

    return {
      width,
      height,
      mipmaps
    }
  }
}

function computeCompressedMipByteLength(width: number, height: number, blockBytes: number): number {
  const blockWidth = Math.max(1, Math.ceil(width / 4))
  const blockHeight = Math.max(1, Math.ceil(height / 4))
  return blockWidth * blockHeight * blockBytes
}

function decodeDxt1(buffer: ArrayBuffer, dataOffset: number, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height * 4)
  const view = new DataView(buffer, dataOffset)
  const blockWidth = Math.max(1, Math.ceil(width / 4))
  const blockHeight = Math.max(1, Math.ceil(height / 4))

  for (let blockY = 0; blockY < blockHeight; blockY += 1) {
    for (let blockX = 0; blockX < blockWidth; blockX += 1) {
      const offset = (blockY * blockWidth + blockX) * 8
      const color0 = view.getUint16(offset, true)
      const color1 = view.getUint16(offset + 2, true)
      const selectors = view.getUint32(offset + 4, true)
      const colors = buildDxt1Palette(color0, color1, true)

      writeBlock(output, width, height, blockX, blockY, pixelIndex => {
        const colorIndex = (selectors >> (pixelIndex * 2)) & 0x03
        return colors[colorIndex]
      })
    }
  }

  return output
}

function decodeDxt3(buffer: ArrayBuffer, dataOffset: number, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height * 4)
  const view = new DataView(buffer, dataOffset)
  const blockWidth = Math.max(1, Math.ceil(width / 4))
  const blockHeight = Math.max(1, Math.ceil(height / 4))

  for (let blockY = 0; blockY < blockHeight; blockY += 1) {
    for (let blockX = 0; blockX < blockWidth; blockX += 1) {
      const offset = (blockY * blockWidth + blockX) * 16
      const alphaPalette = buildDxt3AlphaPalette(view, offset)
      const color0 = view.getUint16(offset + 8, true)
      const color1 = view.getUint16(offset + 10, true)
      const selectors = view.getUint32(offset + 12, true)
      const colors = buildDxt1Palette(color0, color1, false)

      writeBlock(output, width, height, blockX, blockY, pixelIndex => {
        const colorIndex = (selectors >> (pixelIndex * 2)) & 0x03
        const color = colors[colorIndex]
        return [color[0], color[1], color[2], alphaPalette[pixelIndex]]
      })
    }
  }

  return output
}

function decodeDxt5(buffer: ArrayBuffer, dataOffset: number, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height * 4)
  const view = new DataView(buffer, dataOffset)
  const blockWidth = Math.max(1, Math.ceil(width / 4))
  const blockHeight = Math.max(1, Math.ceil(height / 4))

  for (let blockY = 0; blockY < blockHeight; blockY += 1) {
    for (let blockX = 0; blockX < blockWidth; blockX += 1) {
      const offset = (blockY * blockWidth + blockX) * 16
      const alphaPalette = buildDxt5AlphaPalette(view, offset)
      const alphaIndices = view.getBigUint64(offset, true) >> 16n
      const color0 = view.getUint16(offset + 8, true)
      const color1 = view.getUint16(offset + 10, true)
      const selectors = view.getUint32(offset + 12, true)
      const colors = buildDxt1Palette(color0, color1, false)

      writeBlock(output, width, height, blockX, blockY, pixelIndex => {
        const colorIndex = (selectors >> (pixelIndex * 2)) & 0x03
        const alphaIndex = Number((alphaIndices >> BigInt(pixelIndex * 3)) & 0x07n)
        const color = colors[colorIndex]
        return [color[0], color[1], color[2], alphaPalette[alphaIndex]]
      })
    }
  }

  return output
}

function decodeBc5(
  buffer: ArrayBuffer,
  dataOffset: number,
  width: number,
  height: number,
  signed: boolean
): Uint8Array {
  const output = new Uint8Array(width * height * 4)
  const view = new DataView(buffer, dataOffset)
  const blockWidth = Math.max(1, Math.ceil(width / 4))
  const blockHeight = Math.max(1, Math.ceil(height / 4))

  for (let blockY = 0; blockY < blockHeight; blockY += 1) {
    for (let blockX = 0; blockX < blockWidth; blockX += 1) {
      const offset = (blockY * blockWidth + blockX) * 16

      writeBlock(output, width, height, blockX, blockY, pixelIndex => {
        const x = decodeBc4Value(view, offset, pixelIndex, signed)
        const y = decodeBc4Value(view, offset + 8, pixelIndex, signed)
        const z = Math.sqrt(Math.max(1 - x * x - y * y, 0))

        return [
          toByte(x * 0.5 + 0.5),
          toByte(y * 0.5 + 0.5),
          toByte(z * 0.5 + 0.5),
          255
        ]
      })
    }
  }

  return output
}

function buildDxt3AlphaPalette(view: DataView, offset: number): Uint8Array {
  const alpha = new Uint8Array(16)
  for (let row = 0; row < 4; row += 1) {
    const rowBits = view.getUint16(offset + row * 2, true)
    for (let column = 0; column < 4; column += 1) {
      const pixelIndex = row * 4 + column
      alpha[pixelIndex] = ((rowBits >> (column * 4)) & 0x0f) * 17
    }
  }
  return alpha
}

function buildDxt5AlphaPalette(view: DataView, offset: number): Uint8Array {
  const alpha0 = view.getUint8(offset)
  const alpha1 = view.getUint8(offset + 1)
  const palette = new Uint8Array(8)
  palette[0] = alpha0
  palette[1] = alpha1

  if (alpha0 > alpha1) {
    palette[2] = Math.floor((6 * alpha0 + alpha1) / 7)
    palette[3] = Math.floor((5 * alpha0 + 2 * alpha1) / 7)
    palette[4] = Math.floor((4 * alpha0 + 3 * alpha1) / 7)
    palette[5] = Math.floor((3 * alpha0 + 4 * alpha1) / 7)
    palette[6] = Math.floor((2 * alpha0 + 5 * alpha1) / 7)
    palette[7] = Math.floor((alpha0 + 6 * alpha1) / 7)
    return palette
  }

  palette[2] = Math.floor((4 * alpha0 + alpha1) / 5)
  palette[3] = Math.floor((3 * alpha0 + 2 * alpha1) / 5)
  palette[4] = Math.floor((2 * alpha0 + 3 * alpha1) / 5)
  palette[5] = Math.floor((alpha0 + 4 * alpha1) / 5)
  palette[6] = 0
  palette[7] = 255
  return palette
}

function decodeBc4Value(
  view: DataView,
  offset: number,
  pixelIndex: number,
  signed: boolean
): number {
  const endpoints = signed
    ? [
        snorm8ToFloat(view.getInt8(offset)),
        snorm8ToFloat(view.getInt8(offset + 1))
      ]
    : [
        view.getUint8(offset) / 255,
        view.getUint8(offset + 1) / 255
      ]

  const palette = buildBc4Palette(endpoints[0], endpoints[1], signed)
  const indices = readUint48(view, offset + 2)
  const paletteIndex = Number((indices >> BigInt(pixelIndex * 3)) & 0x07n)
  const value = palette[paletteIndex]
  return signed ? value : value * 2 - 1
}

function buildBc4Palette(endpoint0: number, endpoint1: number, signed: boolean): number[] {
  const palette = new Array<number>(8)
  palette[0] = endpoint0
  palette[1] = endpoint1

  if (endpoint0 > endpoint1) {
    palette[2] = (6 * endpoint0 + endpoint1) / 7
    palette[3] = (5 * endpoint0 + 2 * endpoint1) / 7
    palette[4] = (4 * endpoint0 + 3 * endpoint1) / 7
    palette[5] = (3 * endpoint0 + 4 * endpoint1) / 7
    palette[6] = (2 * endpoint0 + 5 * endpoint1) / 7
    palette[7] = (endpoint0 + 6 * endpoint1) / 7
    return palette
  }

  palette[2] = (4 * endpoint0 + endpoint1) / 5
  palette[3] = (3 * endpoint0 + 2 * endpoint1) / 5
  palette[4] = (2 * endpoint0 + 3 * endpoint1) / 5
  palette[5] = (endpoint0 + 4 * endpoint1) / 5
  palette[6] = signed ? -1 : 0
  palette[7] = 1
  return palette
}

function readUint48(view: DataView, offset: number): bigint {
  let value = 0n
  for (let index = 0; index < 6; index += 1) {
    value |= BigInt(view.getUint8(offset + index)) << BigInt(index * 8)
  }
  return value
}

function snorm8ToFloat(value: number): number {
  return Math.max(value / 127, -1)
}

function toByte(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 1) * 255)
}

function buildDxt1Palette(
  color0: number,
  color1: number,
  allowOneBitAlpha: boolean
): Array<readonly [number, number, number, number]> {
  const palette: Array<readonly [number, number, number, number]> = [
    rgb565ToRgba(color0, 255),
    rgb565ToRgba(color1, 255)
  ]

  if (color0 > color1 || !allowOneBitAlpha) {
    palette[2] = interpolateColor(palette[0], palette[1], 2, 1, 3)
    palette[3] = interpolateColor(palette[0], palette[1], 1, 2, 3)
    return palette
  }

  palette[2] = interpolateColor(palette[0], palette[1], 1, 1, 2)
  palette[3] = [0, 0, 0, 0]
  return palette
}

function interpolateColor(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number],
  leftWeight: number,
  rightWeight: number,
  divisor: number
): readonly [number, number, number, number] {
  return [
    Math.round((left[0] * leftWeight + right[0] * rightWeight) / divisor),
    Math.round((left[1] * leftWeight + right[1] * rightWeight) / divisor),
    Math.round((left[2] * leftWeight + right[2] * rightWeight) / divisor),
    Math.round((left[3] * leftWeight + right[3] * rightWeight) / divisor)
  ]
}

function rgb565ToRgba(color: number, alpha: number): readonly [number, number, number, number] {
  const red = (color >> 11) & 0x1f
  const green = (color >> 5) & 0x3f
  const blue = color & 0x1f

  return [
    (red << 3) | (red >> 2),
    (green << 2) | (green >> 4),
    (blue << 3) | (blue >> 2),
    alpha
  ]
}

function writeBlock(
  output: Uint8Array,
  width: number,
  height: number,
  blockX: number,
  blockY: number,
  getPixel: (pixelIndex: number) => readonly [number, number, number, number]
): void {
  for (let localY = 0; localY < 4; localY += 1) {
    for (let localX = 0; localX < 4; localX += 1) {
      const x = blockX * 4 + localX
      const y = blockY * 4 + localY
      if (x >= width || y >= height) {
        continue
      }

      const pixel = getPixel(localY * 4 + localX)
      const destinationOffset = (y * width + x) * 4
      output[destinationOffset] = pixel[0]
      output[destinationOffset + 1] = pixel[1]
      output[destinationOffset + 2] = pixel[2]
      output[destinationOffset + 3] = pixel[3]
    }
  }
}

function decodeUncompressedArgb(
  buffer: ArrayBuffer,
  dataOffset: number,
  width: number,
  height: number
): Uint8Array {
  const source = new Uint8Array(buffer, dataOffset, width * height * 4)
  const output = new Uint8Array(width * height * 4)
  let sourceOffset = 0
  let destinationOffset = 0

  while (sourceOffset < source.length) {
    const blue = source[sourceOffset]
    sourceOffset += 1
    const green = source[sourceOffset]
    sourceOffset += 1
    const red = source[sourceOffset]
    sourceOffset += 1
    const alpha = source[sourceOffset]
    sourceOffset += 1

    output[destinationOffset] = red
    output[destinationOffset + 1] = green
    output[destinationOffset + 2] = blue
    output[destinationOffset + 3] = alpha
    destinationOffset += 4
  }

  return output
}

function decodeUncompressedRgb(
  buffer: ArrayBuffer,
  dataOffset: number,
  width: number,
  height: number
): Uint8Array {
  const source = new Uint8Array(buffer, dataOffset, width * height * 3)
  const output = new Uint8Array(width * height * 4)
  let sourceOffset = 0
  let destinationOffset = 0

  while (sourceOffset < source.length) {
    const blue = source[sourceOffset]
    sourceOffset += 1
    const green = source[sourceOffset]
    sourceOffset += 1
    const red = source[sourceOffset]
    sourceOffset += 1

    output[destinationOffset] = red
    output[destinationOffset + 1] = green
    output[destinationOffset + 2] = blue
    output[destinationOffset + 3] = 255
    destinationOffset += 4
  }

  return output
}

function isUncompressedRgba(header: Int32Array): boolean {
  return (
    header[OFF_RGB_BIT_COUNT] === 32 &&
    (header[OFF_R_BIT_MASK] & 0xff0000) !== 0 &&
    (header[OFF_G_BIT_MASK] & 0xff00) !== 0 &&
    (header[OFF_B_BIT_MASK] & 0xff) !== 0 &&
    (header[OFF_A_BIT_MASK] & 0xff000000) !== 0
  )
}

function isUncompressedRgb(header: Int32Array): boolean {
  return (
    header[OFF_RGB_BIT_COUNT] === 24 &&
    (header[OFF_R_BIT_MASK] & 0xff0000) !== 0 &&
    (header[OFF_G_BIT_MASK] & 0xff00) !== 0 &&
    (header[OFF_B_BIT_MASK] & 0xff) !== 0
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
