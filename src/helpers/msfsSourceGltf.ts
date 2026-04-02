import {
  BufferAttribute,
  DataUtils,
  InterleavedBufferAttribute,
  Mesh,
  Object3D
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const ACCESSOR_COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4
}

export async function loadNormalizedMsfsSourceGltf(
  loader: GLTFLoader,
  modelUrl: string
): Promise<any> {
  const modelResponse = await fetch(modelUrl)
  if (!modelResponse.ok) {
    throw new Error(`[msfs] failed to fetch source glTF: ${modelResponse.status} ${modelResponse.statusText}`)
  }

  const json = (await modelResponse.json()) as Record<string, unknown>
  const bufferDefs = Array.isArray(json.buffers) ? (json.buffers as Array<Record<string, unknown>>) : null
  const primaryBuffer = bufferDefs?.[0]
  const bufferUri = typeof primaryBuffer?.uri === 'string' ? primaryBuffer.uri : null
  if (!bufferUri) {
    throw new Error('[msfs] source glTF is missing its primary buffer URI')
  }

  const bufferResponse = await fetch(new URL(bufferUri, modelUrl).href)
  if (!bufferResponse.ok) {
    throw new Error(`[msfs] failed to fetch source buffer: ${bufferResponse.status} ${bufferResponse.statusText}`)
  }

  const normalizedBin = normalizeAsoboPrimitiveRanges(
    json,
    new Uint8Array(await bufferResponse.arrayBuffer())
  )
  const bufferObjectUrl = URL.createObjectURL(
    new Blob([normalizedBin], { type: 'application/octet-stream' })
  )

  primaryBuffer.uri = bufferObjectUrl
  primaryBuffer.byteLength = normalizedBin.byteLength

  return await new Promise((resolve, reject) => {
    loader.parse(
      JSON.stringify(json),
      new URL('./', modelUrl).href,
      async gltf => {
        URL.revokeObjectURL(bufferObjectUrl)

        try {
          normalizeMsfsSourceScene(gltf.scene as Object3D)
          resolve(gltf)
        } catch (error) {
          reject(error)
        }
      },
      error => {
        URL.revokeObjectURL(bufferObjectUrl)
        reject(error)
      }
    )
  })
}

export function normalizeMsfsSourceScene(root: Object3D): void {
  root.updateMatrixWorld(true)

  root.traverse(object => {
    if (!(object as Mesh).isMesh) return
    const mesh = object as Mesh
    const geometry = mesh.geometry
    for (const name of Object.keys(geometry.attributes)) {
      const attr = geometry.attributes[name] as BufferAttribute | InterleavedBufferAttribute
      const deinterleaved = deinterleaveAttribute(attr)
      const normalized = normalizeMsfsTexcoordAttribute(deinterleaved, name)
      if (normalized !== attr) {
        geometry.setAttribute(name, normalized)
      }
    }
    if (geometry.morphAttributes) {
      for (const key of Object.keys(geometry.morphAttributes)) {
        const attrs = geometry.morphAttributes[key]
        if (!attrs) continue
        geometry.morphAttributes[key] = attrs.map(attr =>
          deinterleaveAttribute(attr as BufferAttribute | InterleavedBufferAttribute)
        )
      }
    }
    mesh.frustumCulled = false
  })

  root.updateMatrixWorld(true)
}

function deinterleaveAttribute(attr: BufferAttribute | InterleavedBufferAttribute): BufferAttribute {
  if (!(attr as InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    return attr as BufferAttribute
  }

  const arr = new Float32Array(attr.count * attr.itemSize)
  for (let i = 0; i < attr.count; i++) {
    if (attr.itemSize > 0) arr[i * attr.itemSize + 0] = attr.getX(i)
    if (attr.itemSize > 1) arr[i * attr.itemSize + 1] = attr.getY(i)
    if (attr.itemSize > 2) arr[i * attr.itemSize + 2] = attr.getZ(i)
    if (attr.itemSize > 3) arr[i * attr.itemSize + 3] = attr.getW(i)
  }

  const result = new BufferAttribute(arr, attr.itemSize, attr.normalized)
  result.setUsage(attr.usage)
  result.name = attr.name
  return result
}

function normalizeMsfsTexcoordAttribute(attr: BufferAttribute, attributeName: string): BufferAttribute {
  const name = attributeName.toLowerCase()
  if (!name.startsWith('uv')) {
    return attr
  }

  const array = attr.array
  const isInt =
    array instanceof Int8Array ||
    array instanceof Uint8Array ||
    array instanceof Int16Array ||
    array instanceof Uint16Array ||
    array instanceof Int32Array ||
    array instanceof Uint32Array
  const needsDecode = isInt || texcoordNeedsHalfFloatDecode(attr)

  if (!needsDecode || attr.normalized) {
    return attr
  }

  const out = new Float32Array(attr.count * attr.itemSize)
  for (let i = 0; i < attr.count; i++) {
    if (attr.itemSize > 0) out[i * attr.itemSize + 0] = DataUtils.fromHalfFloat(attr.getX(i) & 0xffff)
    if (attr.itemSize > 1) out[i * attr.itemSize + 1] = DataUtils.fromHalfFloat(attr.getY(i) & 0xffff)
    if (attr.itemSize > 2) out[i * attr.itemSize + 2] = DataUtils.fromHalfFloat(attr.getZ(i) & 0xffff)
    if (attr.itemSize > 3) out[i * attr.itemSize + 3] = DataUtils.fromHalfFloat(attr.getW(i) & 0xffff)
  }

  const result = new BufferAttribute(out, attr.itemSize, false)
  result.setUsage(attr.usage)
  result.name = attr.name || attributeName
  return result
}

function texcoordNeedsHalfFloatDecode(attr: BufferAttribute): boolean {
  const sampleCount = Math.min(attr.count, 8)
  for (let i = 0; i < sampleCount; i++) {
    const x = attr.getX(i)
    const y = attr.getY(i)
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      (Math.abs(x) > 1 || Math.abs(y) > 1)
    ) {
      return true
    }
  }
  return false
}

function normalizeAsoboPrimitiveRanges(
  json: Record<string, unknown>,
  binData: Uint8Array
): Uint8Array {
  const meshes = Array.isArray(json.meshes) ? (json.meshes as Array<Record<string, unknown>>) : null
  const accessors = Array.isArray(json.accessors) ? (json.accessors as Array<Record<string, any>>) : null
  const bufferViews = Array.isArray(json.bufferViews) ? (json.bufferViews as Array<Record<string, any>>) : null
  if (!meshes || !accessors || !bufferViews) return binData

  let nextBin = binData

  for (const mesh of meshes) {
    const primitives = Array.isArray(mesh.primitives)
      ? (mesh.primitives as Array<Record<string, any>>)
      : null
    if (!primitives) continue

    for (const primitive of primitives) {
      const extras = primitive.extras?.ASOBO_primitive as
        | { PrimitiveCount?: number; StartIndex?: number; BaseVertexIndex?: number; VertexType?: string }
        | undefined

      if (extras?.VertexType === 'BLEND1' && primitive.attributes?.WEIGHTS_0 != null) {
        const weightAccessorIndex = primitive.attributes.WEIGHTS_0 as number
        const weightAccessor = accessors[weightAccessorIndex]
        if (weightAccessor) {
          const materialized = materializeBlend1WeightsAccessor({
            accessors,
            bufferViews,
            binData: nextBin,
            count: weightAccessor.count,
            accessorName: weightAccessor.name
          })
          nextBin = materialized.binData
          primitive.attributes.WEIGHTS_0 = materialized.accessorIndex
        }
      }

      if (primitive.indices == null) continue

      const accessorIndex = primitive.indices as number
      const accessor = accessors[accessorIndex]
      if (!accessor) continue

      const startIndex = extras?.StartIndex ?? 0
      const baseVertexIndex = extras?.BaseVertexIndex ?? 0
      const slicedCount = getAsoboPrimitiveIndexCount(primitive, accessor)
      if (startIndex === 0 && (slicedCount == null || slicedCount === accessor.count) && baseVertexIndex === 0) {
        continue
      }

      const nextCount = slicedCount ?? accessor.count - startIndex
      if (startIndex < 0 || nextCount <= 0 || startIndex + nextCount > accessor.count) {
        throw new Error(
          `Invalid ASOBO index slice for accessor ${accessorIndex}: start=${startIndex} count=${nextCount} total=${accessor.count}`
        )
      }

      if (baseVertexIndex !== 0) {
        const materialized = materializeBaseVertexAccessor({
          accessors,
          accessor,
          accessorIndex,
          baseVertexIndex,
          binData: nextBin,
          bufferViews,
          count: nextCount,
          startIndex
        })
        nextBin = materialized.binData
        primitive.indices = materialized.accessorIndex
        continue
      }

      const componentBytes = ACCESSOR_COMPONENT_BYTES[accessor.componentType]
      if (!componentBytes) {
        throw new Error(`Unsupported index accessor component type: ${accessor.componentType}`)
      }

      const slicedAccessor: Record<string, unknown> = {
        ...accessor,
        byteOffset: (accessor.byteOffset ?? 0) + startIndex * componentBytes,
        count: nextCount
      }
      delete slicedAccessor.min
      delete slicedAccessor.max
      delete slicedAccessor.sparse
      if (typeof accessor.name === 'string' && accessor.name.length > 0) {
        slicedAccessor.name = `${accessor.name}__slice_${startIndex}_${nextCount}`
      }

      primitive.indices = accessors.push(slicedAccessor) - 1
    }
  }

  return nextBin
}

function materializeBlend1WeightsAccessor(options: {
  accessors: Array<Record<string, any>>
  bufferViews: Array<Record<string, any>>
  binData: Uint8Array
  count: number
  accessorName?: string
}) {
  const { accessors, bufferViews, binData, count, accessorName } = options

  const weights = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    weights[i * 4] = 1
  }

  const weightBytes = new Uint8Array(weights.buffer, weights.byteOffset, weights.byteLength)
  const byteOffset = appendAlignedBytes(binData, weightBytes.byteLength)
  const nextBin = new Uint8Array(byteOffset + weightBytes.byteLength)
  nextBin.set(binData, 0)
  nextBin.set(weightBytes, byteOffset)

  const bufferViewIndex =
    bufferViews.push({
      buffer: 0,
      byteLength: weightBytes.byteLength,
      byteOffset,
      target: 34962,
      name: accessorName ? `${accessorName}__blend1_weights` : 'blend1_weights'
    }) - 1

  return {
    accessorIndex:
      accessors.push({
        bufferView: bufferViewIndex,
        componentType: 5126,
        count,
        type: 'VEC4',
        name: accessorName ? `${accessorName}__blend1_weights` : 'blend1_weights'
      }) - 1,
    binData: nextBin
  }
}

function materializeBaseVertexAccessor(options: {
  accessors: Array<Record<string, any>>
  accessor: Record<string, any>
  accessorIndex: number
  baseVertexIndex: number
  binData: Uint8Array
  bufferViews: Array<Record<string, any>>
  count: number
  startIndex: number
}) {
  const {
    accessors,
    accessor,
    accessorIndex,
    baseVertexIndex,
    binData,
    bufferViews,
    count,
    startIndex
  } = options

  const bufferView = bufferViews[accessor.bufferView]
  if (!bufferView) {
    throw new Error(`Missing bufferView ${accessor.bufferView} for accessor ${accessorIndex}`)
  }

  const componentBytes = ACCESSOR_COMPONENT_BYTES[accessor.componentType]
  if (!componentBytes) {
    throw new Error(`Unsupported index accessor component type: ${accessor.componentType}`)
  }

  const sourceOffset =
    (bufferView.byteOffset ?? 0) +
    (accessor.byteOffset ?? 0) +
    startIndex * componentBytes
  const sourceView = new DataView(binData.buffer, binData.byteOffset, binData.byteLength)
  const rebased = new Uint32Array(count)

  for (let i = 0; i < count; i++) {
    rebased[i] =
      readIndexComponent(sourceView, sourceOffset + i * componentBytes, accessor.componentType) +
      baseVertexIndex
  }

  const rebasedBytes = new Uint8Array(rebased.buffer, rebased.byteOffset, rebased.byteLength)
  const byteOffset = appendAlignedBytes(binData, rebasedBytes.byteLength)
  const nextBin = new Uint8Array(byteOffset + rebasedBytes.byteLength)
  nextBin.set(binData, 0)
  nextBin.set(rebasedBytes, byteOffset)

  const bufferViewIndex =
    bufferViews.push({
      buffer: 0,
      byteLength: rebasedBytes.byteLength,
      byteOffset,
      target: 34963,
      name:
        typeof accessor.name === 'string'
          ? `${accessor.name}__rebased_${startIndex}_${count}`
          : `indices_${accessorIndex}__rebased_${startIndex}_${count}`
    }) - 1

  const accessorCopy: Record<string, unknown> = {
    componentType: 5125,
    count,
    type: 'SCALAR',
    bufferView: bufferViewIndex
  }
  if (typeof accessor.name === 'string' && accessor.name.length > 0) {
    accessorCopy.name = `${accessor.name}__rebased_${startIndex}_${count}`
  }

  return {
    accessorIndex: accessors.push(accessorCopy) - 1,
    binData: nextBin
  }
}

function appendAlignedBytes(binData: Uint8Array, byteLength: number): number {
  const appendAlignment = 4
  const padding = (appendAlignment - (binData.byteLength % appendAlignment)) % appendAlignment
  return binData.byteLength + padding
}

function getAsoboPrimitiveIndexCount(
  primitive: Record<string, any>,
  accessor: Record<string, any>
): number | null {
  const primitiveCount = primitive.extras?.ASOBO_primitive?.PrimitiveCount
  if (!Number.isFinite(primitiveCount) || primitiveCount <= 0) {
    return null
  }

  const mode = primitive.mode ?? 4
  if (mode !== 4) {
    return accessor.count
  }

  return primitiveCount * 3
}

function readIndexComponent(view: DataView, byteOffset: number, componentType: number): number {
  switch (componentType) {
    case 5121:
      return view.getUint8(byteOffset)
    case 5123:
      return view.getUint16(byteOffset, true)
    case 5125:
      return view.getUint32(byteOffset, true)
    default:
      throw new Error(`Unsupported index accessor component type: ${componentType}`)
  }
}
