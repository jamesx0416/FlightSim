import { SkinnedMesh } from 'three'

export function normalizeMsfsSkinning(root: SkinnedMesh | { traverse(callback: (object: unknown) => void): void }): void {
  root.traverse(object => {
    if (!(object instanceof SkinnedMesh)) {
      return
    }

    const skinIndex = object.geometry.getAttribute('skinIndex')
    const skeleton = object.skeleton
    if (skinIndex == null || skeleton == null) {
      return
    }

    const maxBoneIndex = skeleton.bones.length - 1
    if (maxBoneIndex < 0) {
      return
    }

    let didClamp = false
    const array = skinIndex.array as ArrayLike<number> & { [index: number]: number }
    for (let index = 0; index < array.length; index += 1) {
      const value = array[index]
      if (value <= maxBoneIndex) {
        continue
      }

      array[index] = maxBoneIndex
      didClamp = true
    }

    if (didClamp) {
      skinIndex.needsUpdate = true
    }
  })
}
