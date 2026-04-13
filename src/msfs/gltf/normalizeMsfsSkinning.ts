import {
  BufferAttribute,
  Float32BufferAttribute,
  Matrix4,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Uint8BufferAttribute,
} from 'three'

export function normalizeMsfsSkinning(root: SkinnedMesh | { traverse(callback: (object: unknown) => void): void }): void {
  const parentWrapperGroups = new Set<Object3D>()
  const rigidRotationRootMeshes: SkinnedMesh[] = []

  root.traverse(object => {
    if (!(object instanceof SkinnedMesh)) {
      return
    }
    const skinIndex = object.geometry.getAttribute('skinIndex')
    const skinWeight = object.geometry.getAttribute('skinWeight')
    const skeleton = object.skeleton
    if (skinIndex == null || skinWeight == null || skeleton == null) {
      return
    }
    normalizeSkinAttributeSizes(object.geometry, skinIndex, skinWeight)

    const normalizedSkinIndex = object.geometry.getAttribute('skinIndex')
    const normalizedSkinWeight = object.geometry.getAttribute('skinWeight')
    if (normalizedSkinIndex == null || normalizedSkinWeight == null) {
      return
    }

    const maxBoneIndex = skeleton.bones.length - 1
    if (maxBoneIndex < 0) {
      return
    }

    let didClamp = false
    const array = normalizedSkinIndex.array as ArrayLike<number> & { [index: number]: number }
    for (let index = 0; index < array.length; index += 1) {
      const value = array[index]
      if (value <= maxBoneIndex) {
        continue
      }

      array[index] = maxBoneIndex
      didClamp = true
    }

    if (didClamp) {
      normalizedSkinIndex.needsUpdate = true
    }

    if (shouldRebindRigidRotationRootMesh(root, object)) {
      rigidRotationRootMeshes.push(object)
    }

    bakeLocalBindTransform(object)
    const parent = object.parent
    if (isSkinnedWrapperGroup(parent)) {
      parentWrapperGroups.add(parent)
    }
  })

  for (const group of parentWrapperGroups) {
    bakeParentWrapperBindTransform(group)
  }

  for (const mesh of rigidRotationRootMeshes) {
    rebindRigidRotationRootMesh(mesh)
  }
}

function bakeLocalBindTransform(mesh: SkinnedMesh): void {
  if (mesh.skeleton == null) {
    return
  }
  mesh.updateMatrix()
  if (!matrixApproximatelyEquals(mesh.bindMatrix, IDENTITY_MATRIX)) {
    return
  }
  if (matrixApproximatelyEquals(mesh.matrix, IDENTITY_MATRIX)) {
    return
  }

  const bakedBindMatrix = mesh.bindMatrix.clone().multiply(mesh.matrix)
  mesh.position.set(0, 0, 0)
  mesh.quaternion.identity()
  mesh.scale.set(1, 1, 1)
  mesh.updateMatrix()
  mesh.bind(mesh.skeleton, bakedBindMatrix)
}

function bakeParentWrapperBindTransform(group: Object3D): void {
  if (!isSkinnedWrapperGroup(group)) {
    return
  }

  group.updateMatrix()
  if (matrixApproximatelyEquals(group.matrix, IDENTITY_MATRIX)) {
    return
  }

  for (const child of group.children) {
    if (!(child instanceof SkinnedMesh) || child.skeleton == null) {
      continue
    }
    child.updateMatrix()
    if (!isIdentityTranslation(child) || !isIdentityScale(child) || !isIdentityQuaternion(child)) {
      return
    }

    const bakedBindMatrix = child.bindMatrix.clone().multiply(group.matrix)
    child.bind(child.skeleton, bakedBindMatrix)
  }

  group.position.set(0, 0, 0)
  group.quaternion.identity()
  group.scale.set(1, 1, 1)
  group.updateMatrix()
  group.updateMatrixWorld(true)
}

const IDENTITY_MATRIX = new Matrix4()

function isSkinnedWrapperGroup(object: Object3D | null | undefined): object is Object3D {
  if (object == null) {
    return false
  }
  if (object.type !== 'Group') {
    return false
  }
  if ('isBone' in object && object.isBone === true) {
    return false
  }
  if (object.children.length === 0) {
    return false
  }

  return object.children.every(child => child instanceof SkinnedMesh)
}

function isIdentityTranslation(mesh: SkinnedMesh): boolean {
  return (
    mesh.position.x === 0 &&
    mesh.position.y === 0 &&
    mesh.position.z === 0
  )
}

function isIdentityScale(mesh: SkinnedMesh): boolean {
  return (
    Math.abs(mesh.scale.x - 1) < 1e-6 &&
    Math.abs(mesh.scale.y - 1) < 1e-6 &&
    Math.abs(mesh.scale.z - 1) < 1e-6
  )
}

function isIdentityQuaternion(mesh: SkinnedMesh): boolean {
  return (
    Math.abs(mesh.quaternion.x) < 1e-6 &&
    Math.abs(mesh.quaternion.y) < 1e-6 &&
    Math.abs(mesh.quaternion.z) < 1e-6 &&
    Math.abs(mesh.quaternion.w - 1) < 1e-6
  )
}

function matrixApproximatelyEquals(left: Matrix4, right: Matrix4): boolean {
  const leftElements = left.elements
  const rightElements = right.elements
  for (let index = 0; index < 16; index += 1) {
    if (Math.abs(leftElements[index] - rightElements[index]) > 1e-6) {
      return false
    }
  }
  return true
}

function shouldRebindRigidRotationRootMesh(
  root: SkinnedMesh | { traverse(callback: (object: unknown) => void): void },
  mesh: SkinnedMesh
): boolean {
  if (mesh.parent !== root) {
    return false
  }
  if (!isIdentityTranslation(mesh) || !isIdentityScale(mesh)) {
    return false
  }
  if (matrixApproximatelyEquals(mesh.matrix, IDENTITY_MATRIX)) {
    return false
  }
  if (isApproximatelyHalfTurnX(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w, 5e-2)) {
    return false
  }

  return getRigidSingleBoneIndex(mesh) != null
}

function rebindRigidRotationRootMesh(mesh: SkinnedMesh): void {
  const skeleton = mesh.skeleton
  if (skeleton == null) {
    return
  }

  mesh.updateMatrixWorld(true)
  const isolatedSkeleton = new Skeleton(
    skeleton.bones,
    skeleton.bones.map(bone => bone.matrixWorld.clone().invert())
  )
  mesh.bind(isolatedSkeleton, mesh.matrixWorld.clone())
}

function getRigidSingleBoneIndex(mesh: SkinnedMesh): number | null {
  const skinIndex = mesh.geometry.getAttribute('skinIndex')
  const skinWeight = mesh.geometry.getAttribute('skinWeight')
  if (skinIndex == null || skinWeight == null || skinIndex.count === 0) {
    return null
  }

  const dominantBoneIndex = skinIndex.getX(0)
  for (let vertexIndex = 0; vertexIndex < skinIndex.count; vertexIndex += 1) {
    let activeWeightCount = 0
    for (let componentIndex = 0; componentIndex < 4; componentIndex += 1) {
      const weight = getAttributeComponent(skinWeight, vertexIndex, componentIndex)
      if (weight <= 1e-4) {
        continue
      }
      const boneIndex = getAttributeComponent(skinIndex, vertexIndex, componentIndex)
      if (activeWeightCount > 0 || boneIndex !== dominantBoneIndex || Math.abs(weight - 1) > 1e-4) {
        return null
      }
      activeWeightCount += 1
    }
  }

  return dominantBoneIndex
}

function getAttributeComponent(attribute: BufferAttribute, vertexIndex: number, componentIndex: number): number {
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

function isApproximatelyHalfTurnX(x: number, y: number, z: number, w: number, tolerance: number): boolean {
  return (
    Math.abs(Math.abs(x) - 1) < tolerance &&
    Math.abs(y) < tolerance &&
    Math.abs(z) < tolerance &&
    Math.abs(w) < tolerance
  )
}

function normalizeSkinAttributeSizes(
  geometry: SkinnedMesh['geometry'],
  skinIndex: BufferAttribute,
  skinWeight: BufferAttribute
): void {
  if (skinIndex.itemSize !== 4) {
    geometry.setAttribute('skinIndex', expandSkinIndexAttribute(skinIndex))
  }

  if (skinWeight.itemSize !== 4) {
    geometry.setAttribute('skinWeight', expandSkinWeightAttribute(skinWeight))
  }
}

function expandSkinIndexAttribute(attribute: BufferAttribute): BufferAttribute {
  const converted = new Uint16Array(attribute.count * 4)

  for (let index = 0; index < attribute.count; index += 1) {
    const destinationOffset = index * 4
    converted[destinationOffset] = attribute.getX(index)
    converted[destinationOffset + 1] = attribute.itemSize > 1 ? attribute.getY(index) : 0
    converted[destinationOffset + 2] = attribute.itemSize > 2 ? attribute.getZ(index) : 0
    converted[destinationOffset + 3] = attribute.itemSize > 3 ? attribute.getW(index) : 0
  }

  if (attribute.array instanceof Uint8Array) {
    return new Uint8BufferAttribute(new Uint8Array(converted), 4, attribute.normalized)
  }

  return new Uint16BufferAttribute(converted, 4, attribute.normalized)
}

function expandSkinWeightAttribute(attribute: BufferAttribute): Float32BufferAttribute {
  const converted = new Float32Array(attribute.count * 4)

  for (let index = 0; index < attribute.count; index += 1) {
    const destinationOffset = index * 4
    converted[destinationOffset] = attribute.getX(index)
    converted[destinationOffset + 1] = attribute.itemSize > 1 ? attribute.getY(index) : 0
    converted[destinationOffset + 2] = attribute.itemSize > 2 ? attribute.getZ(index) : 0
    converted[destinationOffset + 3] = attribute.itemSize > 3 ? attribute.getW(index) : 0
  }

  return new Float32BufferAttribute(converted, 4, false)
}
