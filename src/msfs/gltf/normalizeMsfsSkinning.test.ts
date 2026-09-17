import { describe, expect, test } from 'bun:test'
import { Bone, BufferGeometry, Float32BufferAttribute, Object3D, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three'
import { normalizeMsfsSkinning } from './normalizeMsfsSkinning'

function fixture() {
  const root = new Object3D()
  const bones = [100, -30, 0, 10].map(x => {
    const bone = new Bone()
    bone.position.x = x
    root.add(bone)
    return bone
  })
  const skeleton = new Skeleton(bones)
  const mesh = (indices: number[], weights = indices.map(() => 1), skin = skeleton) => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(indices.flatMap(() => [0, 0, 0]), 3))
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices.flatMap(index => [index, 65535, 0, 0]), 4))
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights.flatMap(weight => [weight, 0, 0, 0]), 4))
    const object = new SkinnedMesh(geometry)
    object.bind(skin)
    root.add(object)
    return object
  }
  const indices = (mesh: SkinnedMesh) => {
    const a = mesh.geometry.getAttribute('skinIndex')
    return Array.from({ length: a.count }, (_, i) => a.getX(i))
  }
  return { root, bones, skeleton, mesh, indices }
}

describe('normalizeMsfsSkinning joint palettes', () => {
  test('rebases every primitive of an optimized one-based skin exactly once', () => {
    const f = fixture()
    const wing = f.mesh([1, 2, 3])
    const terminal = f.mesh([4])
    const sibling = new SkinnedMesh(wing.geometry)
    sibling.bind(f.skeleton)
    f.root.add(sibling)
    const separate = f.mesh([2], [1], new Skeleton(f.bones))
    normalizeMsfsSkinning(f.root, true)
    expect(f.indices(wing)).toEqual([0, 1, 2])
    expect(f.indices(sibling)).toEqual([0, 1, 2])
    expect(f.indices(terminal)).toEqual([3])
    expect(f.indices(separate)).toEqual([2])
    expect(wing.geometry.getAttribute('skinIndex').getY(0)).toBe(0)
    normalizeMsfsSkinning(f.root, true)
    expect(f.indices(wing)).toEqual([0, 1, 2])
    expect(f.indices(terminal)).toEqual([3])
  })

  test('leaves valid glTF palettes unchanged regardless of bone proximity', () => {
    const f = fixture()
    const mesh = f.mesh([1, 2, 3])
    normalizeMsfsSkinning(f.root, true)
    expect(f.indices(mesh)).toEqual([1, 2, 3])
  })

  test('includes arbitrarily small active weights when validating the palette', () => {
    const f = fixture()
    const first = f.mesh([1])
    f.mesh([4], [1e-8])
    normalizeMsfsSkinning(f.root, true)
    expect(f.indices(first)).toEqual([0])
  })

  for (const { indices, optimized } of [
    { indices: [4], optimized: false },
    { indices: [0, 4], optimized: true },
    { indices: [1, 5], optimized: true },
  ]) {
    test(`rejects invalid palette ${indices} (optimized=${optimized}) instead of guessing`, () => {
      const f = fixture()
      f.mesh(indices)
      let error: unknown
      try { normalizeMsfsSkinning(f.root, optimized) } catch (caught) { error = caught }
      expect(error instanceof Error && error.message.startsWith('Invalid skin joint palette')).toBe(true)
    })
  }
})
