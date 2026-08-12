import { describe, expect, test } from 'bun:test'
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three'

import { normalizeMsfsSkinning } from './normalizeMsfsSkinning'

describe('normalizeMsfsSkinning', () => {
  test('repairs one-based rigid skin indices without rebasing valid rigid meshes', () => {
    const root = new Object3D()
    const bones = [0, 10, -30, -10].map((x, index) => {
      const bone = new Bone()
      bone.name = `bone-${index}`
      bone.position.x = x
      root.add(bone)
      return bone
    })
    const skeleton = new Skeleton(bones)
    const makeMesh = (x: number, boneIndex: number) => {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute([
        x - 0.5, 0, 0,
        x + 0.5, 0, 0,
        x, 1, 0,
      ], 3))
      geometry.setAttribute('skinIndex', new Uint16BufferAttribute([
        boneIndex, 0, 0, 0,
        boneIndex, 0, 0, 0,
        boneIndex, 0, 0, 0,
      ], 4))
      geometry.setAttribute('skinWeight', new Float32BufferAttribute([
        1, 0, 0, 0,
        1, 0, 0, 0,
        1, 0, 0, 0,
      ], 4))
      const mesh = new SkinnedMesh(geometry)
      mesh.bind(skeleton)
      root.add(mesh)
      return mesh
    }

    const validButOneBased = makeMesh(10, 2)
    const overflowingOneBased = makeMesh(-10, 4)
    const alreadyCorrect = makeMesh(-10, 3)

    normalizeMsfsSkinning(root)

    expect(validButOneBased.geometry.getAttribute('skinIndex').getX(0)).toBe(1)
    expect(overflowingOneBased.geometry.getAttribute('skinIndex').getX(0)).toBe(3)
    expect(alreadyCorrect.geometry.getAttribute('skinIndex').getX(0)).toBe(3)
  })
})
