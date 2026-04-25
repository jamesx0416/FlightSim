import { BufferGeometry, Float32BufferAttribute, Mesh, Object3D } from 'three'

const MSFS_BYTE_COLOR_SCALE = 255
const FLOAT16_BUFFER = new ArrayBuffer(2)
const FLOAT16_VIEW = new DataView(FLOAT16_BUFFER)

export function normalizeMsfsVertexColors(root: Object3D): void {
  const normalizedGeometries = new WeakSet<BufferGeometry>()

  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const geometry = object.geometry
    if (geometry == null || normalizedGeometries.has(geometry)) {
      return
    }

    normalizeGeometryVertexColors(geometry)
    normalizedGeometries.add(geometry)
  })
}

function normalizeGeometryVertexColors(geometry: BufferGeometry): void {
  const attribute = geometry.getAttribute('color')
  if (
    attribute == null ||
    attribute.normalized ||
    (attribute.itemSize !== 3 && attribute.itemSize !== 4)
  ) {
    return
  }

  if (attribute.array instanceof Uint16Array) {
    convertVertexColorAttribute(
      geometry,
      attribute.itemSize,
      attribute.array,
      decodeFloat16Bits
    )
    return
  }

  if (attribute.array instanceof Uint8Array) {
    convertVertexColorAttribute(
      geometry,
      attribute.itemSize,
      attribute.array,
      value => value / MSFS_BYTE_COLOR_SCALE
    )
    return
  }

  if (attribute.array instanceof Int8Array) {
    convertVertexColorAttribute(
      geometry,
      attribute.itemSize,
      attribute.array,
      value => reinterpretSignedByteAsUnsigned(value) / MSFS_BYTE_COLOR_SCALE
    )
  }
}

function convertVertexColorAttribute(
  geometry: BufferGeometry,
  itemSize: number,
  source: Uint16Array | Uint8Array | Int8Array,
  convertComponent: (value: number) => number
): void {
  const converted = new Float32Array(source.length)
  for (let offset = 0; offset < source.length; offset += itemSize) {
    converted[offset] = convertComponent(source[offset]!)
    converted[offset + 1] = convertComponent(source[offset + 1]!)
    converted[offset + 2] = convertComponent(source[offset + 2]!)

    if (itemSize === 4) {
      converted[offset + 3] = convertComponent(source[offset + 3]!)
    }
  }
  geometry.setAttribute(
    'color',
    new Float32BufferAttribute(converted, itemSize, false)
  )
}

function reinterpretSignedByteAsUnsigned(value: number): number {
  return value < 0 ? value + 256 : value
}

function decodeFloat16Bits(value: number): number {
  FLOAT16_VIEW.setUint16(0, value, true)
  return FLOAT16_VIEW.getFloat16(0, true)
}
