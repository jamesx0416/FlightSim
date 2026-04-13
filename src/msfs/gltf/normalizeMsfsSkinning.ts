import {
  BufferAttribute,
  Float32BufferAttribute,
  Matrix4,
  SkinnedMesh,
  Uint16BufferAttribute,
  Uint8BufferAttribute,
} from 'three'

export function normalizeMsfsSkinning(root: SkinnedMesh | { traverse(callback: (object: unknown) => void): void }): void {
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

    bakeLocalBindTransform(object)
    bakeParentWrapperBindTransform(object)
  })
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

const IDENTITY_MATRIX = new Matrix4()

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
