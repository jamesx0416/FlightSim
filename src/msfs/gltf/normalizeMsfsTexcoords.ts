import { BufferGeometry, Float32BufferAttribute, Mesh, Object3D } from 'three'

const MSFS_FIXED_POINT_TEXCOORD_SCALE = 16384
const TEXCOORD_ATTRIBUTE_NAMES = ['uv', 'uv1', 'uv2', 'uv3'] as const

export function normalizeMsfsTexcoords(root: Object3D): void {
  const normalizedGeometries = new WeakSet<BufferGeometry>()

  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const geometry = object.geometry
    if (geometry == null || normalizedGeometries.has(geometry)) {
      return
    }

    normalizeGeometryTexcoords(geometry)
    normalizedGeometries.add(geometry)
  })
}

function normalizeGeometryTexcoords(geometry: BufferGeometry): void {
  for (const attributeName of TEXCOORD_ATTRIBUTE_NAMES) {
    const attribute = geometry.getAttribute(attributeName)
    if (
      attribute == null ||
      !(attribute.array instanceof Int16Array) ||
      attribute.itemSize !== 2 ||
      attribute.normalized
    ) {
      continue
    }

    const converted = new Float32Array(attribute.count * attribute.itemSize)
    for (let index = 0; index < attribute.count; index += 1) {
      const destinationOffset = index * attribute.itemSize
      converted[destinationOffset] = attribute.getX(index) / MSFS_FIXED_POINT_TEXCOORD_SCALE
      converted[destinationOffset + 1] =
        attribute.getY(index) / MSFS_FIXED_POINT_TEXCOORD_SCALE
    }

    geometry.setAttribute(
      attributeName,
      new Float32BufferAttribute(converted, attribute.itemSize, false)
    )
  }
}
