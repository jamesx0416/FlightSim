import { BufferAttribute, BufferGeometry, Mesh } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

type GltfAccessorDef = {
  readonly bufferView?: number
  readonly byteOffset?: number
  readonly componentType: number
  readonly count: number
  readonly normalized?: boolean
  readonly type: string
}

type GltfBufferViewDef = {
  readonly buffer: number
  readonly byteOffset?: number
  readonly byteStride?: number
}

type GltfPrimitiveDef = {
  readonly attributes?: Partial<Record<GltfAttributeSemantic, number>>
}

type GltfMeshDef = {
  readonly primitives?: readonly GltfPrimitiveDef[]
}

type GltfAssociation = {
  readonly meshes?: number
  readonly primitives?: number
}

type GltfParserLike = {
  readonly associations: Map<object, GltfAssociation>
  readonly json: {
    readonly accessors?: readonly GltfAccessorDef[]
    readonly bufferViews?: readonly GltfBufferViewDef[]
    readonly meshes?: readonly GltfMeshDef[]
  }
  getDependency(type: 'buffer', index: number): Promise<ArrayBuffer>
}

type GltfAttributeSemantic =
  | 'POSITION'
  | 'NORMAL'
  | 'TANGENT'
  | 'TEXCOORD_0'
  | 'TEXCOORD_1'
  | 'JOINTS_0'
  | 'WEIGHTS_0'
  | 'COLOR_0'

const ACCESSOR_TYPE_SIZES: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
}

const ATTRIBUTE_NAME_MAP: Record<GltfAttributeSemantic, string> = {
  POSITION: 'position',
  NORMAL: 'normal',
  TANGENT: 'tangent',
  TEXCOORD_0: 'uv',
  TEXCOORD_1: 'uv1',
  JOINTS_0: 'skinIndex',
  WEIGHTS_0: 'skinWeight',
  COLOR_0: 'color',
}

const COMPONENT_ARRAYS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
} as const

type SupportedComponentType = keyof typeof COMPONENT_ARRAYS

export async function repairMsfsSkinnedAttributes(gltf: GLTF): Promise<void> {
  const parser = (gltf as GLTF & { parser?: GltfParserLike }).parser
  if (parser == null) {
    return
  }

  const repairedGeometries = new WeakSet<BufferGeometry>()
  const bufferCache = new Map<number, Promise<ArrayBuffer>>()
  const repairTasks: Array<Promise<void>> = []

  gltf.scene.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const geometry = object.geometry
    if (geometry == null || repairedGeometries.has(geometry)) {
      return
    }

    const association = parser.associations.get(object)
    if (association?.meshes == null || association.primitives == null) {
      return
    }

    repairTasks.push(
      repairGeometryAttributes(
        geometry,
        parser,
        association.meshes,
        association.primitives,
        bufferCache
      )
    )
    repairedGeometries.add(geometry)
  })

  await Promise.all(repairTasks)
}

async function repairGeometryAttributes(
  geometry: BufferGeometry,
  parser: GltfParserLike,
  meshIndex: number,
  primitiveIndex: number,
  bufferCache: Map<number, Promise<ArrayBuffer>>
): Promise<void> {
  const primitiveDef = parser.json.meshes?.[meshIndex]?.primitives?.[primitiveIndex]
  if (primitiveDef?.attributes == null) {
    return
  }

  for (const [semantic, attributeName] of Object.entries(
    ATTRIBUTE_NAME_MAP
  ) as Array<[GltfAttributeSemantic, string]>) {
    const accessorIndex = primitiveDef.attributes[semantic]
    if (accessorIndex == null) {
      continue
    }

    const accessorDef = parser.json.accessors?.[accessorIndex]
    const bufferViewDef =
      accessorDef?.bufferView != null
        ? parser.json.bufferViews?.[accessorDef.bufferView]
        : null
    const currentAttribute = geometry.getAttribute(attributeName)

    if (
      accessorDef == null ||
      bufferViewDef == null ||
      bufferViewDef.byteStride == null ||
      currentAttribute == null ||
      !currentAttribute.isInterleavedBufferAttribute
    ) {
      continue
    }

    const sourceBuffer = await getBuffer(bufferCache, parser, bufferViewDef.buffer)
    const expectedOffset = (bufferViewDef.byteOffset ?? 0) + (accessorDef.byteOffset ?? 0)

    if (!isCorruptedInterleavedAttribute(currentAttribute, sourceBuffer, expectedOffset)) {
      continue
    }

    const repaired = createPackedAttributeFromAccessor(
      sourceBuffer,
      bufferViewDef,
      accessorDef
    )
    if (repaired != null) {
      geometry.setAttribute(attributeName, repaired)
    }
  }
}

function isCorruptedInterleavedAttribute(
  attribute: BufferAttribute,
  sourceBuffer: ArrayBuffer,
  expectedOffset: number
): boolean {
  const interleavedStride =
    attribute.isInterleavedBufferAttribute &&
    attribute.data?.stride != null &&
    attribute.array?.BYTES_PER_ELEMENT != null
      ? attribute.data.stride * attribute.array.BYTES_PER_ELEMENT
      : 0
  const byteLength = Math.min(
    Math.max(32, interleavedStride * 2),
    attribute.array.byteLength,
    Math.max(0, sourceBuffer.byteLength - expectedOffset)
  )
  if (byteLength <= 0) {
    return false
  }

  const actual = new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, byteLength)
  const expected = new Uint8Array(sourceBuffer, expectedOffset, byteLength)
  for (let index = 0; index < byteLength; index += 1) {
    if (actual[index] !== expected[index]) {
      return true
    }
  }

  return false
}

function createPackedAttributeFromAccessor(
  sourceBuffer: ArrayBuffer,
  bufferViewDef: GltfBufferViewDef,
  accessorDef: GltfAccessorDef
): BufferAttribute | null {
  const itemSize = ACCESSOR_TYPE_SIZES[accessorDef.type]
  const TypedArray = COMPONENT_ARRAYS[accessorDef.componentType as SupportedComponentType]
  if (itemSize == null || TypedArray == null || bufferViewDef.byteStride == null) {
    return null
  }

  const elementBytes = TypedArray.BYTES_PER_ELEMENT
  const packed = new TypedArray(accessorDef.count * itemSize)
  const view = new DataView(sourceBuffer)
  const baseOffset = (bufferViewDef.byteOffset ?? 0) + (accessorDef.byteOffset ?? 0)

  for (let itemIndex = 0; itemIndex < accessorDef.count; itemIndex += 1) {
    const sourceItemOffset = baseOffset + itemIndex * bufferViewDef.byteStride
    const destinationItemOffset = itemIndex * itemSize

    for (let componentIndex = 0; componentIndex < itemSize; componentIndex += 1) {
      const sourceComponentOffset = sourceItemOffset + componentIndex * elementBytes
      packed[destinationItemOffset + componentIndex] = readComponent(
        view,
        sourceComponentOffset,
        accessorDef.componentType as SupportedComponentType
      ) as never
    }
  }

  return new BufferAttribute(packed, itemSize, accessorDef.normalized === true)
}

function readComponent(
  view: DataView,
  byteOffset: number,
  componentType: SupportedComponentType
): number {
  switch (componentType) {
    case 5120:
      return view.getInt8(byteOffset)
    case 5121:
      return view.getUint8(byteOffset)
    case 5122:
      return view.getInt16(byteOffset, true)
    case 5123:
      return view.getUint16(byteOffset, true)
    case 5125:
      return view.getUint32(byteOffset, true)
    case 5126:
      return view.getFloat32(byteOffset, true)
    default:
      throw new Error(`Unsupported component type ${componentType}.`)
  }
}

function getBuffer(
  bufferCache: Map<number, Promise<ArrayBuffer>>,
  parser: GltfParserLike,
  bufferIndex: number
): Promise<ArrayBuffer> {
  let bufferPromise = bufferCache.get(bufferIndex)
  if (bufferPromise == null) {
    bufferPromise = parser.getDependency('buffer', bufferIndex)
    bufferCache.set(bufferIndex, bufferPromise)
  }
  return bufferPromise
}
