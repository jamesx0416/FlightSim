import {
  BufferAttribute,
  DataUtils,
  InterleavedBufferAttribute,
  Material,
  Mesh,
  Object3D,
  SRGBColorSpace,
  SkinnedMesh,
  Texture,
  TextureLoader,
  Vector3
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
  modelUrl: string,
  albedoTextureBaseUrl: string
): Promise<any> {
  const modelResponse = await fetch(modelUrl)
  if (!modelResponse.ok) {
    throw new Error(`[msfs] failed to fetch source glTF: ${modelResponse.status} ${modelResponse.statusText}`)
  }

  const json = (await modelResponse.json()) as Record<string, unknown>
  stripEmbeddedTextureGraph(json)
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
      '',
      async gltf => {
        URL.revokeObjectURL(bufferObjectUrl)

        try {
          bakeMsfsSourceScene(gltf.scene as Object3D)
          await bindWorkingLiveryTextures(
            gltf.scene as Object3D,
            albedoTextureBaseUrl
          )
          gltf.animations = []
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

function stripEmbeddedTextureGraph(json: Record<string, unknown>): void {
  delete json.images
  delete json.textures
  delete json.samplers

  const materials = Array.isArray(json.materials)
    ? (json.materials as Array<Record<string, unknown>>)
    : null
  if (materials) {
    for (const material of materials) {
      delete material.normalTexture
      delete material.occlusionTexture
      delete material.emissiveTexture

      const pbr = material.pbrMetallicRoughness as Record<string, unknown> | undefined
      if (pbr) {
        delete pbr.baseColorTexture
        delete pbr.metallicRoughnessTexture
      }
    }
  }

  const extensionsUsed = Array.isArray(json.extensionsUsed)
    ? (json.extensionsUsed as string[]).filter(name => name !== 'MSFT_texture_dds')
    : null
  if (extensionsUsed) {
    json.extensionsUsed = extensionsUsed
  }

  const extensionsRequired = Array.isArray(json.extensionsRequired)
    ? (json.extensionsRequired as string[]).filter(name => name !== 'MSFT_texture_dds')
    : null
  if (extensionsRequired) {
    json.extensionsRequired = extensionsRequired
  }
}

async function bindWorkingLiveryTextures(
  root: Object3D,
  albedoTextureBaseUrl: string
): Promise<void> {
  const textureNames = new Set<string>()
  root.traverse(object => {
    if (!(object as Mesh).isMesh) return
    const mesh = object as Mesh
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      if (!material) continue
      const textureName = MATERIAL_ALBEDO_TEXTURES[material.name]
      if (textureName) {
        textureNames.add(textureName)
      }
    }
  })

  if (textureNames.size === 0) return

  const loader = new TextureLoader()
  const textures = new Map<string, Texture>()
  await Promise.all(
    [...textureNames].map(
      textureName =>
        new Promise<void>((resolve, reject) => {
          loader.load(
            new URL(textureName, albedoTextureBaseUrl).href,
            texture => {
              texture.flipY = false
              texture.colorSpace = SRGBColorSpace
              textures.set(textureName, texture)
              resolve()
            },
            undefined,
            reject
          )
        })
    )
  )

  root.traverse(object => {
    if (!(object as Mesh).isMesh) return
    const mesh = object as Mesh
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) {
      if (!material) continue
      const textureName = MATERIAL_ALBEDO_TEXTURES[material.name]
      if (!textureName) continue
      const texture = textures.get(textureName)
      if (!texture) continue
      applyBaseColorTexture(material, texture)
    }
  })
}

function applyBaseColorTexture(material: Material, texture: Texture): void {
  if (!('map' in material)) return
  material.map = texture
  material.needsUpdate = true
}

function bakeMsfsSourceScene(root: Object3D): void {
  root.updateMatrixWorld(true)

  const skinnedMeshes: SkinnedMesh[] = []
  root.traverse(object => {
    if ((object as SkinnedMesh).isSkinnedMesh) {
      skinnedMeshes.push(object as SkinnedMesh)
    }
  })

  for (const skinned of skinnedMeshes) {
    const baked = bakeSkinnedMesh(skinned, !shouldResetRightWingTransform(skinned))
    const parent = skinned.parent ?? root
    parent.add(baked)
    parent.remove(skinned)
  }

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

  const objectsToRemove: Object3D[] = []

  root.traverse(object => {
    if (shouldExcludeExteriorObject(object)) {
      objectsToRemove.push(object)
    }
  })

  for (const object of objectsToRemove) {
    object.parent?.remove(object)
  }

  root.traverse(object => {
    if (shouldResetRightWingTransform(object)) {
      resetLocalTransform(object)
      return
    }
    if (shouldResetMirroredPatchTargetTransform(object)) {
      resetLocalTransform(object)
    }
  })

  root.updateMatrixWorld(true)
}

function bakeSkinnedMesh(skinned: SkinnedMesh, preserveLocalTransform: boolean): Mesh {
  const geometry = skinned.geometry
  const position = geometry.attributes.position
  const skinIndex = geometry.attributes.skinIndex
  const skinWeight = geometry.attributes.skinWeight

  if (!position || !skinIndex || !skinWeight) {
    throw new Error(`SkinnedMesh ${skinned.name || '(unnamed)'} missing skin attributes`)
  }

  skinned.updateMatrixWorld(true)
  skinned.skeleton.update()
  skinned.normalizeSkinWeights()

  const bakedPositions = new Float32Array(position.count * 3)
  const skinnedPosition = new Vector3()

  for (let i = 0; i < position.count; i++) {
    skinned.getVertexPosition(i, skinnedPosition)

    if (
      !Number.isFinite(skinnedPosition.x) ||
      !Number.isFinite(skinnedPosition.y) ||
      !Number.isFinite(skinnedPosition.z)
    ) {
      skinnedPosition.fromBufferAttribute(position, i)
    }

    const offset = i * 3
    bakedPositions[offset + 0] = skinnedPosition.x
    bakedPositions[offset + 1] = skinnedPosition.y
    bakedPositions[offset + 2] = skinnedPosition.z
  }

  const bakedGeometry = geometry.clone()
  bakedGeometry.setAttribute('position', new BufferAttribute(bakedPositions, 3))
  for (const name of Object.keys(bakedGeometry.attributes)) {
    if (name === 'skinIndex' || name === 'skinWeight') {
      bakedGeometry.deleteAttribute(name)
      continue
    }
    if (name.toLowerCase().includes('color')) {
      bakedGeometry.deleteAttribute(name)
    }
  }

  bakedGeometry.computeVertexNormals()
  bakedGeometry.computeBoundingBox()
  bakedGeometry.computeBoundingSphere()

  const bakedMesh = new Mesh(bakedGeometry, skinned.material)
  bakedMesh.name = skinned.name
  if (preserveLocalTransform) {
    bakedMesh.position.copy(skinned.position)
    bakedMesh.quaternion.copy(skinned.quaternion)
    bakedMesh.scale.copy(skinned.scale)
    bakedMesh.matrix.copy(skinned.matrix)
    bakedMesh.matrixWorld.copy(skinned.matrixWorld)
  }
  bakedMesh.matrixAutoUpdate = skinned.matrixAutoUpdate
  bakedMesh.visible = skinned.visible
  bakedMesh.castShadow = skinned.castShadow
  bakedMesh.receiveShadow = skinned.receiveShadow
  bakedMesh.renderOrder = skinned.renderOrder
  bakedMesh.userData = { ...skinned.userData }
  bakedMesh.frustumCulled = false

  return bakedMesh
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

const MATERIAL_ALBEDO_TEXTURES: Record<string, string | undefined> = {
  WINGS: 'A320NEO_AIRFRAME_WINGS_ALBD.PNG.png',
  FUSELAGE: 'A320NEO_AIRFRAME_FUSELAGE_ALBD.PNG.png',
  RIBBONS: 'A320NEO_AIRFRAME_RIBBONS_ALBD.PNG.png',
  ENGINES: 'A320NEO_AIRFRAME_ENGINES_ALBD.PNG.png',
  DECALS: 'A320NEO_AIRFRAME_DECALS_ALBD.PNG.png',
  DECALS2: 'A320NEO_AIRFRAME_DECALS_ALBD.PNG.png',
  FRONTLANDING: 'A320NEO_AIRFRAME_FRONTLANDING_ALBD.PNG.png',
  Passenger_Door: 'PASSENGER_DOOR_ALBD.PNG.png',
  Cargo_Door: 'CARGO_DOOR_ALBD.PNG.png',
  Cargo_Soute: 'CARGO_SOUTE_ALBD.PNG.png',
  'WINGS DETAILS': 'A320NEO_AIRFRAME_INWING_DETAILS_ALBD.PNG.png'
}

const MIRRORED_POSITION_PATCHES = [
  ['AILERON_LEFT', 'AILERON_RIGHT'],
  ['ARM04_LEFT', 'ARM04_RIGHT'],
  ['ARM05_LEFT', 'ARM05_RIGHT'],
  ['ARM06_LEFT', 'ARM06_RIGHT'],
  ['ARM03_LEFT', 'ARM03_RIGHT'],
  ['ARM09_LEFT', 'ARM09_RIGHT'],
  ['BASE_LEFT', 'BASE_RIGHT'],
  ['DOOR01_LEFT', 'DOOR01_RIGHT'],
  ['DOOR02_LEFT', 'DOOR02_RIGHT'],
  ['Flaps_Details_Verin02_LEFT', 'Flaps_Details_Verin02_RIGHT'],
  ['Flaps_Details_Verin04_LEFT', 'Flaps_Details_Verin04_RIGHT'],
  ['Flaps_Details_Verin15_LEFT', 'Flaps_Details_Verin15_RIGHT'],
  ['Flaps_Details_Verin16_LEFT', 'Flaps_Details_Verin16_RIGHT'],
  ['GLASS_LEFT', 'GLASS_RIGHT'],
  ['HYDROLIC_LEFT', 'HYDROLIC_RIGHT'],
  ['LIVERY_OFFICIAL_WINGL', 'LIVERY_OFFICIAL_WINGR'],
  ['PIVOT_LEFT', 'PIVOT_RIGHT'],
  ['SUSPENSION01_LEFT', 'SUSPENSION01_RIGHT'],
  ['SUSPENSION02_LEFT', 'SUSPENSION02_RIGHT'],
  ['SUSPENSION03_LEFT', 'SUSPENSION03_RIGHT'],
  ['SUSPENSION04_LEFT', 'SUSPENSION04_RIGHT'],
  ['SUPPORT_LEFT', 'SUPPORT_RIGHT']
] as const

const MIRRORED_POSITION_PATCH_TARGETS = new Set(
  MIRRORED_POSITION_PATCHES.map(([, target]) => target)
)

const EXCLUDED_EXTERIOR_OBJECT_PATTERN =
  /^(?:WIRE_LEFT|WIRE_RIGHT|C_WIRE|C_DOOR_0[12]_HYDROLIC_(?:LEFT|RIGHT)|x0_TAIL_ELEVATOR_TRIM_(?:LEFT|RIGHT)_FROSTED(?:_1)?)$/

const RIGHT_WING_TRANSFORM_RESET_PATTERN =
  /^(?:AILERON_RIGHT|WING_RIGHT(?:_1|_FROSTED)?|FLAPS(?:_01|_02)?_RIGHT|FLAPSFAIRING_(?:04|05|06)_RIGHT(?:_1|_FROSTED)?|FLAPSKRUEGER(?:_02)?_RIGHT(?:_FROSTED)?|SPOILER(?:_2_[13])?_RIGHT|Flaps_Details_(?:Spoiler1|01|Verin(?:01|02|10|11|12))_RIGHT|WING_STROBE_RIGHT|DETAIL_TEXT_WING11_RIGHT|DECALS_(?:RIVETS_(?:WING|FLAPS|FLAPSFAIRING[123]|FLAPSKRUEGER_(?:01|02))|CUT_WING)_RIGHT)$/

function shouldResetRightWingTransform(object: Object3D): boolean {
  if (!RIGHT_WING_TRANSFORM_RESET_PATTERN.test(object.name)) {
    return false
  }

  const epsilon = 1e-3
  const position = object.position
  const scale = object.scale
  const rotation = object.rotation

  return (
    Math.abs(position.x) < epsilon &&
    Math.abs(position.y) < epsilon &&
    Math.abs(position.z) < epsilon &&
    Math.abs(scale.x - 1) < epsilon &&
    Math.abs(scale.y - 1) < epsilon &&
    Math.abs(scale.z - 1) < epsilon &&
    Math.abs(rotation.x) >= Math.PI / 2 - 0.05 &&
    Math.abs(rotation.y) < 0.01 &&
    Math.abs(rotation.z) < 0.01
  )
}

function shouldResetMirroredPatchTargetTransform(object: Object3D): boolean {
  return MIRRORED_POSITION_PATCH_TARGETS.has(
    object.name as (typeof MIRRORED_POSITION_PATCHES)[number][1]
  )
}

function shouldExcludeExteriorObject(object: Object3D): boolean {
  return EXCLUDED_EXTERIOR_OBJECT_PATTERN.test(object.name)
}

function resetLocalTransform(object: Object3D): void {
  object.position.set(0, 0, 0)
  object.quaternion.identity()
  object.scale.set(1, 1, 1)
  object.updateMatrix()
  object.updateMatrixWorld(true)
}
