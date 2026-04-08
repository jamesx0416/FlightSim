type GltfAccessorDef = {
  bufferView?: number
  byteOffset?: number
  componentType?: number
  count?: number
  max?: number[]
  min?: number[]
  sparse?: unknown
  type?: string
}

type GltfPrimitiveDef = {
  indices?: number
  mode?: number
  extras?: {
    ASOBO_primitive?: {
      PrimitiveCount?: number
      StartIndex?: number
    }
  }
}

type GltfMeshDef = {
  primitives?: GltfPrimitiveDef[]
}

type GltfSkinDef = {
  skeleton?: number
}

type GltfImageDef = {
  extras?: unknown
}

type GltfJson = {
  accessors?: GltfAccessorDef[]
  images?: GltfImageDef[]
  meshes?: GltfMeshDef[]
  skins?: GltfSkinDef[]
}

const GLTF_MODE_POINTS = 0
const GLTF_MODE_LINES = 1
const GLTF_MODE_LINE_LOOP = 2
const GLTF_MODE_LINE_STRIP = 3
const GLTF_MODE_TRIANGLES = 4
const GLTF_MODE_TRIANGLE_STRIP = 5
const GLTF_MODE_TRIANGLE_FAN = 6

const COMPONENT_BYTE_SIZES: Record<number, number> = {
  5121: 1,
  5123: 2,
  5125: 4,
}

export function sanitizeMsfsGltf(source: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(source) as GltfJson

  sanitizeSkins(clone)
  sanitizeImages(clone)
  rewriteAsoboPrimitiveIndexSlices(clone)

  return clone as Record<string, unknown>
}

function sanitizeSkins(gltf: GltfJson): void {
  if (!Array.isArray(gltf.skins)) {
    return
  }

  for (const skin of gltf.skins) {
    if (typeof skin.skeleton === 'number' && skin.skeleton < 0) {
      delete skin.skeleton
    }
  }
}

function sanitizeImages(gltf: GltfJson): void {
  if (!Array.isArray(gltf.images)) {
    return
  }

  for (const image of gltf.images) {
    if (image.extras === 'ASOBO_image_converted_meta') {
      delete image.extras
    }
  }
}

function rewriteAsoboPrimitiveIndexSlices(gltf: GltfJson): void {
  if (!Array.isArray(gltf.meshes) || !Array.isArray(gltf.accessors)) {
    return
  }

  for (const mesh of gltf.meshes) {
    if (!Array.isArray(mesh.primitives)) {
      continue
    }

    for (const primitive of mesh.primitives) {
      const primitiveMeta = primitive.extras?.ASOBO_primitive
      if (
        primitiveMeta == null ||
        typeof primitive.indices !== 'number' ||
        typeof primitiveMeta.PrimitiveCount !== 'number'
      ) {
        continue
      }

      const sourceAccessor = gltf.accessors[primitive.indices]
      if (
        sourceAccessor == null ||
        sourceAccessor.sparse != null ||
        sourceAccessor.type !== 'SCALAR' ||
        typeof sourceAccessor.count !== 'number' ||
        typeof sourceAccessor.componentType !== 'number'
      ) {
        continue
      }

      const componentByteSize = COMPONENT_BYTE_SIZES[sourceAccessor.componentType]
      const slicedIndexCount = getSlicedIndexCount(
        primitive.mode ?? GLTF_MODE_TRIANGLES,
        primitiveMeta.PrimitiveCount
      )
      const startIndex = primitiveMeta.StartIndex ?? 0

      if (
        componentByteSize == null ||
        !Number.isInteger(startIndex) ||
        !Number.isInteger(slicedIndexCount) ||
        startIndex < 0 ||
        slicedIndexCount <= 0 ||
        startIndex + slicedIndexCount > sourceAccessor.count
      ) {
        continue
      }

      if (startIndex === 0 && slicedIndexCount === sourceAccessor.count) {
        continue
      }

      const slicedAccessor: GltfAccessorDef = {
        ...sourceAccessor,
        byteOffset: (sourceAccessor.byteOffset ?? 0) + startIndex * componentByteSize,
        count: slicedIndexCount,
      }
      delete slicedAccessor.min
      delete slicedAccessor.max

      gltf.accessors.push(slicedAccessor)
      primitive.indices = gltf.accessors.length - 1
    }
  }
}

function getSlicedIndexCount(mode: number, primitiveCount: number): number | null {
  if (!Number.isInteger(primitiveCount) || primitiveCount <= 0) {
    return null
  }

  switch (mode) {
    case GLTF_MODE_POINTS:
      return primitiveCount
    case GLTF_MODE_LINES:
      return primitiveCount * 2
    case GLTF_MODE_LINE_LOOP:
      return primitiveCount
    case GLTF_MODE_LINE_STRIP:
      return primitiveCount + 1
    case GLTF_MODE_TRIANGLES:
      return primitiveCount * 3
    case GLTF_MODE_TRIANGLE_STRIP:
    case GLTF_MODE_TRIANGLE_FAN:
      return primitiveCount + 2
    default:
      return null
  }
}
