import {
  BufferAttribute,
  BufferGeometry,
  type AnimationClip,
  InterleavedBufferAttribute,
  Group,
  InstancedMesh,
  LOD,
  Matrix4,
  Mesh,
  type Material,
  type Object3D
} from 'three'

import type { CompiledBehaviorSet } from '../types'
import { collectStaticMeshAnimationTargets } from './collectStaticMeshAnimationTargets'
import { collectProtectedNodeNames } from './collectProtectedNodeNames'
import { isSafeStaticMeshBatchCandidate } from './staticMeshBatchingEligibility'

type InstancingCandidate = {
  readonly mesh: Mesh
  readonly geometry: BufferGeometry
  readonly material: Material
  readonly anchor: Object3D
  readonly worldMatrix: Matrix4
}

export type StaticMeshInstancingStats = {
  readonly candidateMeshCount: number
  readonly instancedMeshCount: number
  readonly instancedBatchCount: number
  readonly skippedProtectedMeshCount: number
  readonly skippedUnsupportedMeshCount: number
  readonly animationTargetResolutionFailed: boolean
  readonly disposedGeometryCount: number
}

const MIN_INSTANCES_PER_BATCH = 2

export function instanceStaticMsfsMeshes(
  root: Object3D,
  behaviorSet: CompiledBehaviorSet,
  animations: readonly AnimationClip[]
): StaticMeshInstancingStats {
  const protectedNames = collectProtectedNodeNames(behaviorSet)
  const animationTargets = collectStaticMeshAnimationTargets(root, animations)
  if (animationTargets == null) {
    return {
      candidateMeshCount: 0,
      instancedMeshCount: 0,
      instancedBatchCount: 0,
      skippedProtectedMeshCount: 0,
      skippedUnsupportedMeshCount: countMeshes(root),
      animationTargetResolutionFailed: true,
      disposedGeometryCount: 0
    }
  }

  const batches = new Map<string, InstancingCandidate[]>()
  let candidateMeshCount = 0
  let skippedProtectedMeshCount = 0
  let skippedUnsupportedMeshCount = 0

  root.updateWorldMatrix(true, true)
  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    if (isProtectedByOwnName(object, protectedNames) || animationTargets.nodes.has(object)) {
      skippedProtectedMeshCount += 1
      return
    }

    const material = Array.isArray(object.material) ? null : object.material
    if (material != null && animationTargets.materials.has(material)) {
      skippedProtectedMeshCount += 1
      return
    }
    if (
      material == null ||
      !object.visible ||
      object.parent == null ||
      !canInstanceMesh(object, material)
    ) {
      skippedUnsupportedMeshCount += 1
      return
    }

    const anchor = findInstancingAnchor(object, root, protectedNames, animationTargets.nodes)
    const worldMatrix = getMatrixRelativeToAnchor(object, anchor)
    const key = createInstancingKey(object, material, anchor, worldMatrix)
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
      anchor,
      worldMatrix
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
    instancedMesh.castShadow = canonical.mesh.castShadow
    instancedMesh.receiveShadow = canonical.mesh.receiveShadow
    instancedMesh.renderOrder = canonical.mesh.renderOrder
    instancedMesh.frustumCulled = canonical.mesh.frustumCulled
    instancedMesh.layers.mask = canonical.mesh.layers.mask

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
    canonical.anchor.add(instancedMesh)
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
    animationTargetResolutionFailed: false,
    disposedGeometryCount
  }
}

function countMeshes(root: Object3D): number {
  let count = 0
  root.traverse(object => {
    if (object instanceof Mesh) count += 1
  })
  return count
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
  protectedNames: ReadonlySet<string>,
  animatedTargets: ReadonlySet<Object3D>
): Object3D {
  let current = object.parent
  while (current != null && current !== root) {
    if (
      isProtectedByOwnName(current, protectedNames) ||
      animatedTargets.has(current) ||
      current.visible === false ||
      current instanceof Group ||
      current.parent instanceof LOD
    ) {
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

function canInstanceMesh(mesh: Mesh, material: Material): boolean {
  return (
    !material.transparent &&
    material.depthTest &&
    material.depthWrite &&
    isSafeStaticMeshBatchCandidate(mesh, material)
  )
}

function createInstancingKey(
  mesh: Mesh,
  material: Material,
  parent: Object3D,
  worldMatrix: Matrix4
): string | null {
  if (worldMatrix.determinant() <= 0) {
    return null
  }

  const geometry = mesh.geometry
  const parts = [
    `parent:${parent.uuid}`,
    `material:${material.uuid}`,
    `renderOrder:${mesh.renderOrder}`,
    `castShadow:${mesh.castShadow ? '1' : '0'}`,
    `receiveShadow:${mesh.receiveShadow ? '1' : '0'}`,
    `frustumCulled:${mesh.frustumCulled ? '1' : '0'}`,
    `layers:${mesh.layers.mask}`,
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
