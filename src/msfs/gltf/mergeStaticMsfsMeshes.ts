import {
  BufferAttribute,
  Box3,
  BufferGeometry,
  InterleavedBufferAttribute,
  Matrix4,
  Vector3,
  Mesh,
  type Material,
  type Object3D
} from 'three'
import { deinterleaveGeometry, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

import type { CompiledBehaviorSet } from '../types'
import { usesBlendGBufferMaterial } from './normalizeMsfsMaterials'

type MergeAttribute = BufferAttribute | InterleavedBufferAttribute

type MergeCandidate = {
  readonly mesh: Mesh
  readonly geometry: BufferGeometry
  readonly material: Material
  readonly anchor: Object3D
  readonly anchorLocalMatrix: Matrix4
}

export type StaticMeshMergeStats = {
  readonly candidateMeshCount: number
  readonly mergedMeshCount: number
  readonly mergedBatchCount: number
  readonly skippedProtectedMeshCount: number
  readonly skippedUnsupportedMeshCount: number
  readonly disposedGeometryCount: number
}

const MIN_MESHES_PER_BATCH = 2
const MERGE_SPATIAL_CELL_SIZE_METERS = 0.5
const EMPTY_PROXY_GEOMETRY = new BufferGeometry()
const reusableBounds = new Box3()
const reusableCenter = new Vector3()

export function mergeStaticMsfsMeshes(
  root: Object3D,
  behaviorSet: CompiledBehaviorSet
): StaticMeshMergeStats {
  const protectedNames = collectProtectedNodeNames(behaviorSet)
  const batches = new Map<string, MergeCandidate[]>()
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
    if (
      material == null ||
      !object.visible ||
      object.parent == null ||
      !canMergeMesh(object, material)
    ) {
      skippedUnsupportedMeshCount += 1
      return
    }

    const anchor = findStaticMeshAnchor(object, root, protectedNames)
    const anchorLocalMatrix = getMatrixRelativeToAnchor(object, anchor)
    const key = createMergeKey(object, material, anchor, anchorLocalMatrix)
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
      anchorLocalMatrix
    })
    batches.set(key, batch)
  })

  let mergedMeshCount = 0
  let mergedBatchCount = 0
  let disposedGeometryCount = 0
  const proxiedSourceGeometries = new Set<BufferGeometry>()

  for (const batch of batches.values()) {
    if (batch.length < MIN_MESHES_PER_BATCH) {
      continue
    }

    const canonical = batch[0]!
    const transformedGeometries = batch.map(candidate => {
      const transformedGeometry = candidate.geometry.clone()
      deinterleaveGeometry(transformedGeometry)
      transformedGeometry.applyMatrix4(candidate.anchorLocalMatrix)
      return transformedGeometry
    })
    const mergedGeometry = mergeGeometries(transformedGeometries, false)
    for (const geometry of transformedGeometries) {
      geometry.dispose()
    }
    if (mergedGeometry == null) {
      skippedUnsupportedMeshCount += batch.length
      continue
    }

    const mergedMesh = new Mesh(mergedGeometry, canonical.material)
    mergedMesh.name = `__MSFS_STATIC_MERGE_BATCH_${mergedBatchCount}`
    mergedMesh.castShadow = canonical.mesh.castShadow
    mergedMesh.receiveShadow = canonical.mesh.receiveShadow
    mergedMesh.renderOrder = canonical.mesh.renderOrder
    mergedMesh.frustumCulled = true
    mergedMesh.layers.mask = canonical.mesh.layers.mask
    canonical.anchor.add(mergedMesh)

    for (const candidate of batch) {
      candidate.mesh.visible = false
      candidate.mesh.userData.msfsMergedProxy = true
      proxiedSourceGeometries.add(candidate.geometry)
      candidate.mesh.geometry = EMPTY_PROXY_GEOMETRY
    }

    mergedMeshCount += batch.length
    mergedBatchCount += 1
  }

  const visibleGeometries = collectVisibleGeometries(root)
  for (const geometry of proxiedSourceGeometries) {
    if (!visibleGeometries.has(geometry)) {
      geometry.dispose()
      disposedGeometryCount += 1
    }
  }

  return {
    candidateMeshCount,
    mergedMeshCount,
    mergedBatchCount,
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
  for (const binding of behaviorSet.materialBindings) {
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

function findStaticMeshAnchor(
  object: Object3D,
  root: Object3D,
  protectedNames: ReadonlySet<string>
): Object3D {
  let current = object.parent
  let nearestNamedAncestor: Object3D | null = null
  while (current != null && current !== root) {
    if (isProtectedByOwnName(current, protectedNames)) {
      return current
    }
    if (nearestNamedAncestor == null && isMeaningfulStaticGroupName(current.name)) {
      nearestNamedAncestor = current
    }
    current = current.parent
  }
  return nearestNamedAncestor ?? root
}

function isMeaningfulStaticGroupName(name: string): boolean {
  return name !== '' && !/^\d+$/.test(name)
}

function getMatrixRelativeToAnchor(object: Object3D, anchor: Object3D): Matrix4 {
  anchor.updateWorldMatrix(true, false)
  object.updateWorldMatrix(true, false)
  return anchor.matrixWorld.clone().invert().multiply(object.matrixWorld)
}

function canMergeMesh(mesh: Mesh, material: Material): boolean {
  const isBlendGBufferMaterial = usesBlendGBufferMaterial(material)
  if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
    return false
  }
  if (mesh.morphTargetInfluences != null && mesh.morphTargetInfluences.length > 0) {
    return false
  }
  if (Object.keys(mesh.geometry.morphAttributes).length > 0) {
    return false
  }
  if (material.transparent && !isBlendGBufferMaterial) {
    return false
  }
  return isMergeableGeometry(mesh.geometry)
}

function createMergeKey(
  mesh: Mesh,
  material: Material,
  anchor: Object3D,
  anchorLocalMatrix: Matrix4
): string | null {
  if (!isMergeableGeometry(mesh.geometry)) {
    return null
  }

  return [
    `anchor:${anchor.uuid}`,
    `material:${material.uuid}`,
    `renderOrder:${mesh.renderOrder}`,
    `castShadow:${mesh.castShadow ? '1' : '0'}`,
    `receiveShadow:${mesh.receiveShadow ? '1' : '0'}`,
    `layers:${mesh.layers.mask}`,
    `cell:${createSpatialCellKey(mesh.geometry, anchorLocalMatrix)}`,
    `attributes:${Object.entries(mesh.geometry.attributes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, attribute]) => {
        if (!isSupportedMergeAttribute(attribute)) {
          return `${name}:unsupported`
        }
        return `${name}:${attribute.itemSize}:${attribute.normalized ? '1' : '0'}:${getAttributeArrayConstructorName(attribute)}`
      })
      .join(',')}`,
    `indexed:${mesh.geometry.index == null ? '0' : '1'}`
  ].join('|')
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

function createSpatialCellKey(geometry: BufferGeometry, anchorLocalMatrix: Matrix4): string {
  if (geometry.boundingBox == null) {
    geometry.computeBoundingBox()
  }
  const bounds = geometry.boundingBox
  if (bounds == null) {
    return 'unknown'
  }

  reusableBounds.copy(bounds).applyMatrix4(anchorLocalMatrix)
  reusableBounds.getCenter(reusableCenter)
  return [reusableCenter.x, reusableCenter.y, reusableCenter.z]
    .map(value => Math.floor(value / MERGE_SPATIAL_CELL_SIZE_METERS))
    .join(':')
}

function isMergeableGeometry(geometry: BufferGeometry): boolean {
  if (geometry.drawRange.start !== 0 || Number.isFinite(geometry.drawRange.count)) {
    return false
  }
  if (geometry.groups.length > 0) {
    return false
  }
  if (geometry.index != null && !(geometry.index instanceof BufferAttribute)) {
    return false
  }
  return Object.values(geometry.attributes).every(isSupportedMergeAttribute)
}

function isSupportedMergeAttribute(attribute: unknown): attribute is MergeAttribute {
  return attribute instanceof BufferAttribute || attribute instanceof InterleavedBufferAttribute
}

function getAttributeArrayConstructorName(attribute: MergeAttribute): string {
  return attribute instanceof InterleavedBufferAttribute
    ? attribute.data.array.constructor.name
    : attribute.array.constructor.name
}
