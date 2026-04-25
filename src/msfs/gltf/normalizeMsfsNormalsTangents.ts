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
    const source = attribute.array

    for (let offset = 0; offset < source.length; offset += attribute.itemSize) {
      converted[offset] = clampSignedNormalized(source[offset]! / scale)

      if (attribute.itemSize >= 2) {
        converted[offset + 1] = clampSignedNormalized(source[offset + 1]! / scale)
      }
      if (attribute.itemSize >= 3) {
        converted[offset + 2] = clampSignedNormalized(source[offset + 2]! / scale)
      }
      if (attribute.itemSize >= 4) {
        converted[offset + 3] = clampSignedNormalized(source[offset + 3]! / scale)
      }

      normalizeVectorComponents(converted, offset, Math.min(3, attribute.itemSize))
    }

    geometry.setAttribute(
      attributeName,
      new Float32BufferAttribute(converted, attribute.itemSize, false)
    )
  }
}

function normalizeVectorComponents(
  values: Float32Array,
  offset: number,
  componentCount: number
): void {
  if (componentCount < 3) {
    return
  }

  const x = values[offset]
  const y = values[offset + 1]
  const z = values[offset + 2]
  const length = Math.hypot(x, y, z)
  if (length <= 0) {
    return
  }

  values[offset] = x / length
  values[offset + 1] = y / length
  values[offset + 2] = z / length
}

function clampSignedNormalized(value: number): number {
  return Math.max(-1, Math.min(1, value))
}
