import { Float32BufferAttribute, Mesh, Matrix3, Matrix4, Quaternion, Vector3 } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MSFS_DISCARDED_SKINNING_TRANSFORM_USER_DATA_KEY } from './normalizeMsfsSkinning'

type GltfAssociation = {
  readonly meshes?: number
  readonly primitives?: number
}

type GltfPrimitiveDef = {
  readonly material?: number
  readonly mode?: number
  readonly extras?: {
    readonly ASOBO_primitive?: {
      readonly VertexType?: string
    }
  }
}

type GltfMeshDef = {
  readonly primitives?: readonly GltfPrimitiveDef[]
}

type GltfParserLike = {
  readonly associations: Map<object, GltfAssociation>
  readonly json: {
    readonly meshes?: readonly GltfMeshDef[]
  }
}

const GLTF_MODE_TRIANGLES = 4
const MIRRORED_POSITION_KEY_SCALE = 10_000
const MIRRORED_CENTER_EPSILON = 1e-4
const MIRRORED_NORMAL_OPPOSITION_EPSILON = 1e-4
const DISCARDED_HALF_TURN_EPSILON = 1e-3

type MirroredPrimitiveCandidate = {
  readonly object: Mesh
  readonly centerX: number
  readonly averageNormal: Vector3
  readonly hasDiscardedHalfTurnXTransform: boolean
}

export function normalizeAsoboPrimitiveWinding(gltf: GLTF): void {
  const parser = (gltf as unknown as { parser?: GltfParserLike }).parser
  if (parser == null) {
    return
  }

  const flippedGeometries = new WeakSet<object>()

  gltf.scene.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const geometry = object.geometry
    if (geometry == null || flippedGeometries.has(geometry)) {
      return
    }

    const association = parser.associations.get(object as never)
    if (association?.meshes == null || association.primitives == null) {
      return
    }

    const primitiveDef =
      parser.json.meshes?.[association.meshes]?.primitives?.[association.primitives]
    if (!usesAsoboTrianglePrimitive(primitiveDef)) {
      return
    }

    const index = geometry.getIndex()
    if (index == null) {
      return
    }

    const indexArray = index.array
    for (let offset = 0; offset < indexArray.length; offset += 3) {
      const first = indexArray[offset]!
      indexArray[offset] = indexArray[offset + 2]!
      indexArray[offset + 2] = first
    }

    index.needsUpdate = true
    flippedGeometries.add(geometry)
  })

  normalizeMirroredAsoboPrimitiveWinding(gltf, parser)
}

function usesAsoboTrianglePrimitive(
  primitiveDef: GltfPrimitiveDef | undefined
): boolean {
  if (primitiveDef == null) {
    return false
  }

  if (primitiveDef.extras?.ASOBO_primitive == null) {
    return false
  }

  return (primitiveDef.mode ?? GLTF_MODE_TRIANGLES) === GLTF_MODE_TRIANGLES
}

function normalizeMirroredAsoboPrimitiveWinding(gltf: GLTF, parser: GltfParserLike): void {
  const candidatesByKey = new Map<string, MirroredPrimitiveCandidate[]>()

  gltf.scene.updateMatrixWorld(true)
  gltf.scene.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const geometry = object.geometry
    const index = geometry?.getIndex()
    const position = geometry?.getAttribute('position')
    if (geometry == null || index == null || position == null || position.itemSize < 3) {
      return
    }

    const association = parser.associations.get(object as never)
    if (association?.meshes == null || association.primitives == null) {
      return
    }

    const primitiveDef =
      parser.json.meshes?.[association.meshes]?.primitives?.[association.primitives]
    if (!usesAsoboTrianglePrimitive(primitiveDef)) {
      return
    }

    const averageNormal = computeAverageTriangleNormal(position, index)
    if (averageNormal == null) {
      return
    }

    const centerX = computeCenterX(position)
    if (Math.abs(centerX) < MIRRORED_CENTER_EPSILON) {
      return
    }

    const key = buildMirroredPrimitiveKey(position, index.count, primitiveDef?.material)
    const candidates = candidatesByKey.get(key) ?? []
    candidates.push({
      object,
      centerX,
      averageNormal,
      hasDiscardedHalfTurnXTransform: hasDiscardedHalfTurnXTransform(object),
    })
    candidatesByKey.set(key, candidates)
  })

  const compensatedGeometries = new WeakSet<object>()
  for (const candidates of candidatesByKey.values()) {
    const positive = candidates.filter(candidate => candidate.centerX > MIRRORED_CENTER_EPSILON)
    const negative = candidates.filter(candidate => candidate.centerX < -MIRRORED_CENTER_EPSILON)
    if (positive.length !== 1 || negative.length !== 1) {
      continue
    }

    const positiveCandidate = positive[0]!
    const negativeCandidate = negative[0]!
    if (
      positiveCandidate.hasDiscardedHalfTurnXTransform ===
      negativeCandidate.hasDiscardedHalfTurnXTransform
    ) {
      continue
    }

    const transformedCandidate = positiveCandidate.hasDiscardedHalfTurnXTransform
      ? positiveCandidate
      : negativeCandidate
    const stableCandidate = transformedCandidate === positiveCandidate
      ? negativeCandidate
      : positiveCandidate
    if (transformedCandidate.object.geometry === stableCandidate.object.geometry) {
      continue
    }

    const transformedMirroredNormal = mirrorXNormal(transformedCandidate.averageNormal)
    if (
      transformedMirroredNormal.dot(stableCandidate.averageNormal) >
      -1 + MIRRORED_NORMAL_OPPOSITION_EPSILON
    ) {
      continue
    }

    const geometry = transformedCandidate.object.geometry
    if (geometry == null || compensatedGeometries.has(geometry)) {
      continue
    }

    flipGeometryIndexWinding(transformedCandidate.object)
    transformDiscardedVectorAttributes(transformedCandidate.object)
    compensatedGeometries.add(geometry)
  }
}

function computeCenterX(position: ReturnType<Mesh['geometry']['getAttribute']>): number {
  let centerX = 0
  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    centerX += position.getX(vertexIndex)
  }
  return centerX / position.count
}

function computeAverageTriangleNormal(
  position: ReturnType<Mesh['geometry']['getAttribute']>,
  index: NonNullable<ReturnType<Mesh['geometry']['getIndex']>>
): Vector3 | null {
  const averageNormal = new Vector3()
  const first = new Vector3()
  const second = new Vector3()
  const third = new Vector3()
  const edgeB = new Vector3()
  const faceNormal = new Vector3()
  let triangleCount = 0

  for (let offset = 0; offset + 2 < index.count; offset += 3) {
    first.fromBufferAttribute(position, index.getX(offset))
    second.fromBufferAttribute(position, index.getX(offset + 1))
    third.fromBufferAttribute(position, index.getX(offset + 2))
    faceNormal
      .subVectors(second, first)
      .cross(edgeB.subVectors(third, first))
    if (faceNormal.lengthSq() <= 1e-18) {
      continue
    }

    averageNormal.add(faceNormal.normalize())
    triangleCount += 1
  }

  if (triangleCount === 0 || averageNormal.lengthSq() <= 0) {
    return null
  }

  return averageNormal.normalize()
}

function buildMirroredPrimitiveKey(
  position: ReturnType<Mesh['geometry']['getAttribute']>,
  indexCount: number,
  materialIndex: number | undefined
): string {
  const points: string[] = []
  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    points.push([
      quantizeMirroredPositionComponent(Math.abs(position.getX(vertexIndex))),
      quantizeMirroredPositionComponent(position.getY(vertexIndex)),
      quantizeMirroredPositionComponent(position.getZ(vertexIndex)),
    ].join(','))
  }
  points.sort()

  return [
    materialIndex ?? 'material',
    position.count,
    indexCount,
    points.join(';'),
  ].join('|')
}

function quantizeMirroredPositionComponent(value: number): number {
  return Math.round(value * MIRRORED_POSITION_KEY_SCALE)
}

function hasDiscardedHalfTurnXTransform(object: Mesh): boolean {
  const transform = (object.userData as Record<string, unknown>)[
    MSFS_DISCARDED_SKINNING_TRANSFORM_USER_DATA_KEY
  ]
  return transform instanceof Matrix4 && isApproximatelyHalfTurnXTransform(transform)
}

function isApproximatelyHalfTurnXTransform(transform: Matrix4): boolean {
  const quaternion = new Quaternion()
  const scale = new Vector3()
  transform.decompose(new Vector3(), quaternion, scale)

  return (
    Math.abs(Math.abs(quaternion.x) - 1) < DISCARDED_HALF_TURN_EPSILON &&
    Math.abs(quaternion.y) < DISCARDED_HALF_TURN_EPSILON &&
    Math.abs(quaternion.z) < DISCARDED_HALF_TURN_EPSILON &&
    Math.abs(quaternion.w) < DISCARDED_HALF_TURN_EPSILON
  )
}

function mirrorXNormal(normal: Vector3): Vector3 {
  return new Vector3(-normal.x, normal.y, normal.z)
}

function flipGeometryIndexWinding(object: Mesh): void {
  const index = object.geometry?.getIndex()
  if (index == null) {
    return
  }

  const indexArray = index.array
  for (let offset = 0; offset < indexArray.length; offset += 3) {
    const first = indexArray[offset]!
    indexArray[offset] = indexArray[offset + 2]!
    indexArray[offset + 2] = first
  }

  index.needsUpdate = true
}

function transformDiscardedVectorAttributes(object: Mesh): void {
  const transform = (object.userData as Record<string, unknown>)[
    MSFS_DISCARDED_SKINNING_TRANSFORM_USER_DATA_KEY
  ]
  if (!(transform instanceof Matrix4)) {
    return
  }

  const vectorTransform = new Matrix3().getNormalMatrix(transform)
  transformVectorAttribute(object, 'normal', vectorTransform)
  transformVectorAttribute(object, 'tangent', vectorTransform)
}

function transformVectorAttribute(
  object: Mesh,
  attributeName: 'normal' | 'tangent',
  transform: Matrix3
): void {
  const attribute = object.geometry.getAttribute(attributeName)
  if (attribute == null || attribute.itemSize < 3) {
    return
  }

  const converted = new Float32Array(attribute.count * attribute.itemSize)
  const vector = new Vector3()
  for (let vertexIndex = 0; vertexIndex < attribute.count; vertexIndex += 1) {
    const destinationOffset = vertexIndex * attribute.itemSize
    vector
      .set(
        getDecodedVectorComponent(attribute, vertexIndex, 0),
        getDecodedVectorComponent(attribute, vertexIndex, 1),
        getDecodedVectorComponent(attribute, vertexIndex, 2)
      )
      .applyMatrix3(transform)
      .normalize()
    converted[destinationOffset] = vector.x
    converted[destinationOffset + 1] = vector.y
    converted[destinationOffset + 2] = vector.z

    for (let componentIndex = 3; componentIndex < attribute.itemSize; componentIndex += 1) {
      converted[destinationOffset + componentIndex] = getDecodedVectorComponent(
        attribute,
        vertexIndex,
        componentIndex
      )
    }
  }

  object.geometry.setAttribute(
    attributeName,
    new Float32BufferAttribute(converted, attribute.itemSize, false)
  )
}

function getDecodedVectorComponent(
  attribute: ReturnType<Mesh['geometry']['getAttribute']>,
  vertexIndex: number,
  componentIndex: number
): number {
  const value = getVectorAttributeComponent(attribute, vertexIndex, componentIndex)
  const array = getVectorAttributeArray(attribute)
  if (array instanceof Int8Array) {
    return clampSignedNormalized(value / 127)
  }
  if (array instanceof Int16Array) {
    return clampSignedNormalized(value / 32767)
  }
  return value
}

function getVectorAttributeComponent(
  attribute: ReturnType<Mesh['geometry']['getAttribute']>,
  vertexIndex: number,
  componentIndex: number
): number {
  if (componentIndex === 0) {
    return attribute.getX(vertexIndex)
  }
  if (componentIndex === 1) {
    return attribute.getY(vertexIndex)
  }
  if (componentIndex === 2) {
    return attribute.getZ(vertexIndex)
  }
  return attribute.getW(vertexIndex)
}

function getVectorAttributeArray(
  attribute: ReturnType<Mesh['geometry']['getAttribute']>
): unknown {
  if ('array' in attribute) {
    return attribute.array
  }

  return (attribute as { readonly data?: { readonly array?: unknown } }).data?.array
}

function clampSignedNormalized(value: number): number {
  return Math.max(-1, Math.min(1, value))
}
