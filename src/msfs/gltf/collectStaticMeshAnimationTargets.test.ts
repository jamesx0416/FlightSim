import { expect, test } from 'bun:test'
import {
  AnimationClip,
  Bone,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  Object3D,
  Skeleton,
  SkinnedMesh,
  Texture
} from 'three'

import { collectStaticMeshAnimationTargets } from './collectStaticMeshAnimationTargets'

test('resolves static-mesh animation protection with Three property bindings', () => {
  const root = new Group()
  const target = new Group()
  root.add(target)
  const animation = new AnimationClip('transform', -1, [
    new NumberKeyframeTrack(`${target.uuid}.position[x]`, [0, 1], [0, 1])
  ])

  const targets = collectStaticMeshAnimationTargets(root, [animation])

  expect(targets != null).toBe(true)
  expect(targets?.nodes.has(target)).toBe(true)
})

test('collects shared material animation targets', () => {
  const root = new Group()
  const material = new MeshBasicMaterial()
  const mesh = new Mesh(new BoxGeometry(), material)
  root.add(mesh)
  const animation = new AnimationClip('material', -1, [
    new NumberKeyframeTrack(`${mesh.uuid}.material.color[r]`, [0, 1], [0, 1])
  ])

  const targets = collectStaticMeshAnimationTargets(root, [animation])

  expect(targets?.materials.has(material)).toBe(true)
  expect(targets?.nodes.size).toBe(0)
})

test('resolves named animated bones to their hierarchy node', () => {
  const root = new Group()
  const bone = new Bone()
  bone.name = 'animated-bone'
  const skinnedMesh = new SkinnedMesh(new BoxGeometry(), new MeshBasicMaterial())
  skinnedMesh.skeleton = new Skeleton([bone])
  root.add(skinnedMesh, bone)
  const animation = new AnimationClip('bone', -1, [
    new NumberKeyframeTrack(`${skinnedMesh.uuid}.bones[${bone.name}].position[x]`, [0, 1], [0, 1])
  ])

  const targets = collectStaticMeshAnimationTargets(root, [animation])

  expect(targets?.nodes.has(bone)).toBe(true)
})

test('fails closed when an animation target is not present in the glTF scene', () => {
  const animation = new AnimationClip('missing', -1, [
    new NumberKeyframeTrack('missing-node.position[x]', [0, 1], [0, 1])
  ])

  expect(collectStaticMeshAnimationTargets(new Object3D(), [animation]) === null).toBe(true)
})

test('fails closed when an animation track cannot be parsed', () => {
  const animation = new AnimationClip('invalid', -1, [
    new NumberKeyframeTrack('not-a-binding', [0, 1], [0, 1])
  ])

  expect(collectStaticMeshAnimationTargets(new Object3D(), [animation]) === null).toBe(true)
})

test('fails closed when a track resolves to texture state outside the scene graph', () => {
  const root = new Group()
  const material = new MeshBasicMaterial({ map: new Texture() })
  const mesh = new Mesh(new BoxGeometry(), material)
  root.add(mesh)
  const animation = new AnimationClip('texture', -1, [
    new NumberKeyframeTrack(`${mesh.uuid}.map.offset[x]`, [0, 1], [0, 1])
  ])

  expect(collectStaticMeshAnimationTargets(root, [animation]) === null).toBe(true)
})
