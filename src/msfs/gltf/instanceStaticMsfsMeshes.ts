import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Material,
  type Object3D
} from 'three'

import type { CompiledBehaviorSet } from '../types'

type InstancingCandidate = {
  readonly mesh: Mesh
  readonly geometry: BufferGeometry
  readonly material: Material
  readonly worldMatrix: Matrix4
}

export type StaticMeshInstancingStats = {
  readonly candidateMeshCount: number
  readonly instancedMeshCount: number
  readonly instancedBatchCount: number
  readonly skippedProtectedMeshCount: number
  readonly skippedUnsupportedMeshCount: number
  readonly disposedGeometryCount: number
}

const MIN_INSTANCES_PER_BATCH = 2

export function instanceStaticMsfsMeshes(
  root: Object3D,
  behaviorSet: CompiledBehaviorSet
): StaticMeshInstancingStats {
  const protectedNames = collectProtectedNodeNames(behaviorSet)
  const batches = new Map<string, InstancingCandidate[]>()
  let candidateMeshCount = 0
  let skippedProtectedMeshCount = 0
  let skippedUnsupportedMeshCount = 0

  root.updateWorldMatrix(true, true)
  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    if (isProtectedByOwnName(object, protectedNames)) {
      skippedProtectedMeshCount += 1
      return
    }

    const material = Array.isArray(object.material) ? null : object.material
    if (material == null || !object.visible || object.parent == null || !canInstanceMesh(object)) {
      skippedUnsupportedMeshCount += 1
      return
    }

    const anchor = findInstancingAnchor(object, root, protectedNames)
    const key = createInstancingKey(object.geometry, material, anchor)
    if (key == null) {
      skippedUnsupportedMeshCount += 1
      return
    }

    candidateMeshCount += 1
    const batch = batches.get(key) ?? []
    batch.push({
      mesh: object,
      geometry: object.geometry,
      material,
      worldMatrix: getMatrixRelativeToAnchor(object, findInstancingAnchor(object, root, protectedNames))
    })
    batches.set(key, batch)
  })

  const instancingRoot = new Group()
  instancingRoot.name = '__MSFS_STATIC_INSTANCES__'

  let instancedMeshCount = 0
  let instancedBatchCount = 0
  let disposedGeometryCount = 0
  const proxiedSourceGeometries = new Set<BufferGeometry>()

  for (const batch of batches.values()) {
    if (batch.length < MIN_INSTANCES_PER_BATCH) {
      continue
    }

    const canonical = batch[0]!
    const instancedMesh = new InstancedMesh(
      canonical.geometry,
      canonical.material,
      batch.length
    )
    instancedMesh.name = `__MSFS_STATIC_INSTANCE_BATCH_${instancedBatchCount}`
    instancedMesh.castShadow = batch.some(candidate => candidate.mesh.castShadow)
    instancedMesh.receiveShadow = batch.some(candidate => candidate.mesh.receiveShadow)
    instancedMesh.renderOrder = Math.max(...batch.map(candidate => candidate.mesh.renderOrder))
    instancedMesh.frustumCulled = true

    for (let index = 0; index < batch.length; index += 1) {
      const candidate = batch[index]!
      instancedMesh.setMatrixAt(index, candidate.worldMatrix)
      candidate.mesh.visible = false
      candidate.mesh.userData.msfsInstancedProxy = true
      proxiedSourceGeometries.add(candidate.geometry)
    }

    instancedMesh.instanceMatrix.needsUpdate = true
    instancedMesh.computeBoundingBox()
    instancedMesh.computeBoundingSphere()
    findInstancingAnchor(canonical.mesh, root, protectedNames).add(instancedMesh)
    instancedMeshCount += batch.length
    instancedBatchCount += 1
  }

  const visibleGeometries = collectVisibleGeometries(root)
  for (const geometry of proxiedSourceGeometries) {
    if (geometry !== undefined && !visibleGeometries.has(geometry)) {
      geometry.dispose()
      disposedGeometryCount += 1
    }
  }

  return {
    candidateMeshCount,
    instancedMeshCount,
    instancedBatchCount,
    skippedProtectedMeshCount,
    skippedUnsupportedMeshCount,
    disposedGeometryCount
  }
}

function collectProtectedNodeNames(behaviorSet: CompiledBehaviorSet): ReadonlySet<string> {
  const protectedNames = new Set<string>()
  for (const binding of behaviorSet.animationBindings) {
    protectedNames.add(binding.target)
    protectedNames.add(binding.target.toLowerCase())
  }
  for (const binding of behaviorSet.visibilityBindings) {
    protectedNames.add(binding.target)
    protectedNames.add(binding.target.toLowerCase())
  }
  return protectedNames
}

function isProtectedByOwnName(
  object: Object3D,
  protectedNames: ReadonlySet<string>
): boolean {
  return (
    object.name !== '' &&
    (protectedNames.has(object.name) || protectedNames.has(object.name.toLowerCase()))
  )
}

function findInstancingAnchor(
  object: Object3D,
  root: Object3D,
  protectedNames: ReadonlySet<string>
): Object3D {
  let current = object.parent
  while (current != null && current !== root) {
    if (isProtectedByOwnName(current, protectedNames)) {
      return current
    }
    current = current.parent
  }
  return root
}

function collectVisibleGeometries(root: Object3D): ReadonlySet<BufferGeometry> {
  const geometries = new Set<BufferGeometry>()
  root.traverse(object => {
    if (object instanceof Mesh && object.visible && object.geometry != null) {
      geometries.add(object.geometry)
    }
  })
  return geometries
}

function getMatrixRelativeToAnchor(object: Object3D, anchor: Object3D): Matrix4 {
  anchor.updateWorldMatrix(true, false)
  object.updateWorldMatrix(true, false)
  return anchor.matrixWorld.clone().invert().multiply(object.matrixWorld)
}

function canInstanceMesh(mesh: Mesh): boolean {
  if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
    return false
  }
  if (mesh.morphTargetInfluences != null && mesh.morphTargetInfluences.length > 0) {
    return false
  }
  if (Object.keys(mesh.geometry.morphAttributes).length > 0) {
    return false
  }
  return true
}

function createInstancingKey(
  geometry: BufferGeometry,
  material: Material,
  parent: Object3D
): string | null {
  const parts = [
    `parent:${parent.uuid}`,
    `material:${material.uuid}`,
    `drawRange:${geometry.drawRange.start}:${geometry.drawRange.count}`,
    `groups:${geometry.groups
      .map(group => `${group.start}:${group.count}:${group.materialIndex ?? -1}`)
      .join(',')}`
  ]

  if (geometry.index != null) {
    if (!(geometry.index instanceof BufferAttribute)) {
      return null
    }
    parts.push(`index:${createBufferAttributeKey(geometry.index)}`)
  } else {
    parts.push('index:none')
  }

  for (const [name, attribute] of Object.entries(geometry.attributes).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (!isSupportedAttribute(attribute)) {
      return null
    }
    parts.push(`attribute:${name}:${createBufferAttributeKey(attribute)}`)
  }

  return parts.join('|')
}

function isSupportedAttribute(
  attribute: unknown
): attribute is BufferAttribute | InterleavedBufferAttribute {
  return attribute instanceof BufferAttribute || attribute instanceof InterleavedBufferAttribute
}

function createBufferAttributeKey(attribute: BufferAttribute | InterleavedBufferAttribute): string {
  const attributeArray = attribute instanceof BufferAttribute
    ? attribute.array
    : attribute.data.array
  const offset = attribute instanceof InterleavedBufferAttribute ? attribute.offset : 0
  const stride = attribute instanceof InterleavedBufferAttribute ? attribute.data.stride : attribute.itemSize
  return [
    attributeArray.constructor.name,
    attributeArray.length,
    attribute.itemSize,
    attribute.normalized ? 1 : 0,
    attribute.count,
    offset,
    stride,
    hashTypedArray(attributeArray)
  ].join(':')
}

function hashTypedArray(attributeArray: BufferAttribute['array']): string {
  const bytes = new Uint8Array(
    attributeArray.buffer,
    attributeArray.byteOffset,
    attributeArray.byteLength
  )
  let hash = 0x811c9dc5
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index]!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
