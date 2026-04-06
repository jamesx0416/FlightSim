import { BufferGeometry, Float32BufferAttribute, Mesh, Object3D } from 'three'

const MSFS_FIXED_POINT_COLOR_SCALE = 16384
const MSFS_BYTE_COLOR_SCALE = 255

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

  let readComponent: ((index: number, component: number) => number) | null = null
  if (attribute.array instanceof Uint16Array) {
    readComponent = (index, component) =>
      getComponent(attribute, index, component) / MSFS_FIXED_POINT_COLOR_SCALE
  } else if (attribute.array instanceof Uint8Array) {
    readComponent = (index, component) =>
      getComponent(attribute, index, component) / MSFS_BYTE_COLOR_SCALE
  } else if (attribute.array instanceof Int8Array) {
    readComponent = (index, component) =>
      reinterpretSignedByteAsUnsigned(getComponent(attribute, index, component)) /
      MSFS_BYTE_COLOR_SCALE
  }

  if (readComponent == null) {
    return
  }

  const converted = new Float32Array(attribute.count * attribute.itemSize)
  for (let index = 0; index < attribute.count; index += 1) {
    const destinationOffset = index * attribute.itemSize
    converted[destinationOffset] = readComponent(index, 0)
    converted[destinationOffset + 1] = readComponent(index, 1)
    converted[destinationOffset + 2] = readComponent(index, 2)

    if (attribute.itemSize === 4) {
      converted[destinationOffset + 3] = readComponent(index, 3)
    }
  }

  geometry.setAttribute(
    'color',
    new Float32BufferAttribute(converted, attribute.itemSize, false)
  )
}

function getComponent(
  attribute: ReturnType<BufferGeometry['getAttribute']>,
  index: number,
  component: number
): number {
  switch (component) {
    case 0:
      return attribute.getX(index)
    case 1:
      return attribute.getY(index)
    case 2:
      return attribute.getZ(index)
    case 3:
      return attribute.getW(index)
    default:
      return 0
  }
}

function reinterpretSignedByteAsUnsigned(value: number): number {
  return value < 0 ? value + 256 : value
}
