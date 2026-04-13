import {
  BufferAttribute,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  SkinnedMesh,
  Uint16BufferAttribute,
  Uint8BufferAttribute,
} from 'three'

export function normalizeMsfsSkinning(root: SkinnedMesh | { traverse(callback: (object: unknown) => void): void }): void {
  const rigidAttachments: Array<{ mesh: SkinnedMesh, boneIndex: number }> = []

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

    const rigidBoneIndex = getRigidAttachmentBoneIndex(object, getRigidSkinBoneIndex(normalizedSkinIndex, normalizedSkinWeight))
    if (rigidBoneIndex != null) {
      rigidAttachments.push({ mesh: object, boneIndex: rigidBoneIndex })
      return
    }

    bakeLocalBindTransform(object)
    bakeParentWrapperBindTransform(object)
  })

  for (const attachment of rigidAttachments) {
    convertRigidAttachmentToBoneChild(attachment.mesh, attachment.boneIndex)
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

function bakeParentWrapperBindTransform(mesh: SkinnedMesh): void {
  if (mesh.skeleton == null) {
    return
  }
  mesh.updateMatrix()
  if (!isIdentityTranslation(mesh) || !isIdentityScale(mesh) || !isIdentityQuaternion(mesh)) {
    return
  }

  const parent = mesh.parent
  if (parent == null || parent instanceof SkinnedMesh) {
    return
  }
  if ('isBone' in parent && parent.isBone === true) {
    return
  }
  if (parent.children.some(child => 'isBone' in child && child.isBone === true)) {
    return
  }
  parent.updateMatrix()
  if (matrixApproximatelyEquals(parent.matrix, IDENTITY_MATRIX)) {
    return
  }

  const bakedBindMatrix = mesh.bindMatrix.clone().multiply(parent.matrix)
  mesh.bind(mesh.skeleton, bakedBindMatrix)
}

function getRigidAttachmentBoneIndex(
  mesh: SkinnedMesh,
  rigidBoneIndex: number | null
): number | null {
  const skeleton = mesh.skeleton
  if (skeleton == null) {
    return null
  }

  if (rigidBoneIndex == null) {
    return null
  }
  if (rigidBoneIndex < 0 || rigidBoneIndex >= skeleton.bones.length) {
    return null
  }

  return rigidBoneIndex
}

function convertRigidAttachmentToBoneChild(mesh: SkinnedMesh, boneIndex: number): void {
  const skeleton = mesh.skeleton
  const parent = mesh.parent
  if (skeleton == null || parent == null) {
    return
  }

  const bone = skeleton.bones[boneIndex]
  if (bone == null) {
    return
  }

  mesh.updateWorldMatrix(true, false)
  bone.updateWorldMatrix(true, false)
  const relativeToBone = bone.matrixWorld.clone().invert().multiply(mesh.matrixWorld.clone())

  const geometry = mesh.geometry.clone()
  geometry.deleteAttribute('skinIndex')
  geometry.deleteAttribute('skinWeight')
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()

  const replacement = new Mesh(geometry, mesh.material)
  replacement.name = mesh.name
  replacement.castShadow = mesh.castShadow
  replacement.receiveShadow = mesh.receiveShadow
  replacement.frustumCulled = mesh.frustumCulled
  replacement.renderOrder = mesh.renderOrder
  replacement.visible = mesh.visible
  replacement.userData = { ...mesh.userData }
  replacement.layers.mask = mesh.layers.mask
  relativeToBone.decompose(replacement.position, replacement.quaternion, replacement.scale)
  replacement.updateMatrix()

  while (mesh.children.length > 0) {
    replacement.add(mesh.children[0])
  }

  bone.add(replacement)
  parent.remove(mesh)
}

const IDENTITY_MATRIX = new Matrix4()

function getRigidSkinBoneIndex(skinIndex: BufferAttribute, skinWeight: BufferAttribute): number | null {
  let rigidBoneIndex: number | null = null

  for (let index = 0; index < skinIndex.count; index += 1) {
    let vertexBoneIndex: number | null = null

    for (let component = 0; component < skinIndex.itemSize; component += 1) {
      const weight = getAttributeComponent(skinWeight, index, component)
      if (Math.abs(weight) <= 1e-6) {
        continue
      }

      const boneIndex = getAttributeComponent(skinIndex, index, component)
      if (vertexBoneIndex == null) {
        vertexBoneIndex = boneIndex
        continue
      }
      if (vertexBoneIndex !== boneIndex) {
        return null
      }
    }

    if (vertexBoneIndex == null) {
      continue
    }
    if (rigidBoneIndex == null) {
      rigidBoneIndex = vertexBoneIndex
      continue
    }
    if (rigidBoneIndex !== vertexBoneIndex) {
      return null
    }
  }

  return rigidBoneIndex
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

function getAttributeComponent(attribute: BufferAttribute, index: number, component: number): number {
  if (component >= attribute.itemSize) {
    return 0
  }
  switch (component) {
    case 0:
      return attribute.getX(index)
    case 1:
      return attribute.getY(index)
    case 2:
      return attribute.getZ(index)
    case 3:
      return attribute.getW(index)
    default:
      return 0
  }
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
