import {
  BufferAttribute,
  Float32BufferAttribute,
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
    if (normalizedSkinIndex == null) {
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
  })
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
