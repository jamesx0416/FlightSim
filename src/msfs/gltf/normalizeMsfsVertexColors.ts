import { BufferGeometry, Float32BufferAttribute, Mesh, Object3D } from 'three'

const MSFS_FIXED_POINT_COLOR_SCALE = 16384

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
    !(attribute.array instanceof Uint16Array) ||
    attribute.normalized ||
    (attribute.itemSize !== 3 && attribute.itemSize !== 4)
  ) {
    return
  }

  const converted = new Float32Array(attribute.count * attribute.itemSize)
  for (let index = 0; index < attribute.count; index += 1) {
    const destinationOffset = index * attribute.itemSize
    converted[destinationOffset] =
      attribute.getX(index) / MSFS_FIXED_POINT_COLOR_SCALE
    converted[destinationOffset + 1] =
      attribute.getY(index) / MSFS_FIXED_POINT_COLOR_SCALE
    converted[destinationOffset + 2] =
      attribute.getZ(index) / MSFS_FIXED_POINT_COLOR_SCALE

    if (attribute.itemSize === 4) {
      converted[destinationOffset + 3] =
        attribute.getW(index) / MSFS_FIXED_POINT_COLOR_SCALE
    }
  }

  geometry.setAttribute(
    'color',
    new Float32BufferAttribute(converted, attribute.itemSize, false)
  )
}
