import { BufferGeometry, Float32BufferAttribute, Mesh, Object3D } from 'three'

const VECTOR_ATTRIBUTE_NAMES = ['normal', 'tangent'] as const

export function normalizeMsfsNormalsTangents(root: Object3D): void {
  const normalizedGeometries = new WeakSet<BufferGeometry>()

  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const geometry = object.geometry
    if (geometry == null || normalizedGeometries.has(geometry)) {
      return
    }

    normalizeGeometryVectors(geometry)
    normalizedGeometries.add(geometry)
  })
}

function normalizeGeometryVectors(geometry: BufferGeometry): void {
  for (const attributeName of VECTOR_ATTRIBUTE_NAMES) {
    const attribute = geometry.getAttribute(attributeName)
    if (attribute == null || attribute.normalized) {
      continue
    }

    if (!(attribute.array instanceof Int8Array) && !(attribute.array instanceof Int16Array)) {
      continue
    }

    const scale = attribute.array instanceof Int8Array ? 127 : 32767
    const converted = new Float32Array(attribute.count * attribute.itemSize)

    for (let index = 0; index < attribute.count; index += 1) {
      const destinationOffset = index * attribute.itemSize
      converted[destinationOffset] = clampSignedNormalized(attribute.getX(index) / scale)

      if (attribute.itemSize >= 2) {
        converted[destinationOffset + 1] = clampSignedNormalized(attribute.getY(index) / scale)
      }
      if (attribute.itemSize >= 3) {
        converted[destinationOffset + 2] = clampSignedNormalized(attribute.getZ(index) / scale)
      }
      if (attribute.itemSize >= 4) {
        converted[destinationOffset + 3] = clampSignedNormalized(attribute.getW(index) / scale)
      }
    }

    geometry.setAttribute(
      attributeName,
      new Float32BufferAttribute(converted, attribute.itemSize, false)
    )
  }
}

function clampSignedNormalized(value: number): number {
  return Math.max(-1, Math.min(1, value))
}
