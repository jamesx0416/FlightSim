import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  NumberKeyframeTrack,
  RGBA_BPTC_Format,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute
} from 'three'

import {
  applyMsfsExtensions,
  applyMsfsBindingAnimationValue,
  parseMsfsDdsBuffer,
  setupMsfsAnimations
} from '../../src/helpers/msfsGltf.ts'
import { normalizeMsfsSourceScene } from '../../src/helpers/msfsSourceGltf.ts'

test('parses BC7/DX10 DDS textures used by MSFS source assets', () => {
  const parsed = parseMsfsDdsBuffer(buildBc7TestDdsBuffer())

  expect(parsed.format).toBe(RGBA_BPTC_Format)
  expect(parsed.width).toBeGreaterThan(0)
  expect(parsed.height).toBeGreaterThan(0)
  expect(parsed.mipmaps.length).toBeGreaterThan(0)
})

test('setupMsfsAnimations leaves authored transforms untouched until a clip is driven', () => {
  const scene = new Group()
  const animatedNode = new Group()
  animatedNode.name = 'Animated'
  scene.add(animatedNode)

  const clip = new AnimationClip('move_clip', 1, [
    new NumberKeyframeTrack('Animated.position[x]', [0, 1], [0, 10])
  ])

  const state = setupMsfsAnimations({
    scene,
    animations: [clip]
  })

  expect(animatedNode.position.x).toBe(0)

  applyMsfsBindingAnimationValue(state, 'move_clip', 1, 1)
  state.mixer?.update(0)

  expect(animatedNode.position.x).toBeCloseTo(10, 5)
})

test('normalizeMsfsSourceScene preserves skinned meshes used by control surfaces', () => {
  const scene = new Group()
  const rootBone = new Bone()
  rootBone.name = 'RootBone'
  const childBone = new Bone()
  childBone.name = 'AnimatedBone'
  rootBone.add(childBone)
  scene.add(rootBone)

  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0
    ], 3)
  )
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([
    0, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0
  ], 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0
  ], 4))

  const mesh = new SkinnedMesh(geometry)
  mesh.name = 'SkinnedSurface'
  mesh.add(rootBone)
  mesh.bind(new Skeleton([rootBone, childBone]))
  scene.add(mesh)

  normalizeMsfsSourceScene(scene)

  const skinnedMeshes: SkinnedMesh[] = []
  scene.traverse(object => {
    if ((object as SkinnedMesh).isSkinnedMesh) {
      skinnedMeshes.push(object as SkinnedMesh)
    }
  })

  expect(skinnedMeshes).toHaveLength(1)
  expect(skinnedMeshes[0].name).toBe('SkinnedSurface')
  expect(skinnedMeshes[0].geometry.getAttribute('skinIndex')).toBeDefined()
  expect(skinnedMeshes[0].geometry.getAttribute('skinWeight')).toBeDefined()
})

function buildBc7TestDdsBuffer(): ArrayBuffer {
  const DDS_MAGIC = 0x20534444
  const DDSD_MIPMAPCOUNT = 0x20000
  const FOURCC_DX10 = fourCCToInt32('DX10')
  const DXGI_FORMAT_BC7_UNORM = 98
  const headerLengthInt = 31
  const extendedHeaderLengthInt = 5
  const width = 4
  const height = 4
  const dataLength = 16
  const buffer = new ArrayBuffer(148 + dataLength)
  const header = new Int32Array(buffer, 0, headerLengthInt)
  const extendedHeader = new Int32Array(buffer, (headerLengthInt + 1) * 4, extendedHeaderLengthInt)

  header[0] = DDS_MAGIC
  header[1] = 124
  header[2] = DDSD_MIPMAPCOUNT
  header[3] = height
  header[4] = width
  header[7] = 1
  header[21] = FOURCC_DX10

  extendedHeader[0] = DXGI_FORMAT_BC7_UNORM

  return buffer
}

function fourCCToInt32(value: string): number {
  return (
    value.charCodeAt(0) +
    (value.charCodeAt(1) << 8) +
    (value.charCodeAt(2) << 16) +
    (value.charCodeAt(3) << 24)
  )
}
