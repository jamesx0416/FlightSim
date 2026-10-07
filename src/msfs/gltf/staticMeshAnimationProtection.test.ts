import { expect, test } from 'bun:test'
import {
  AnimationClip,
  BoxGeometry,
  Group,
  InstancedMesh,
  LOD,
  Mesh,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  VectorKeyframeTrack
} from 'three'

import type { CompiledBehaviorSet } from '../types'
import { instanceStaticMsfsMeshes } from './instanceStaticMsfsMeshes'
import { mergeStaticMsfsMeshes } from './mergeStaticMsfsMeshes'

const emptyBehaviorSet: CompiledBehaviorSet = {
  irVersion: 'msfs-behavior/v1',
  aircraftId: 'test',
  animationBindings: [],
  animationTriggerBindings: [],
  visibilityBindings: [],
  materialBindings: [],
  updateBindings: [],
  inputEventBindings: [],
  interactionBindings: [],
  interactionBlockers: [],
  interactionCompilerTotals: {
    candidates: 0,
    compiledBindings: 0,
    rejectedBindings: 0,
    rejectionReasons: {}
  },
  variableKeys: [],
  builtinFallbackHits: [],
  diagnostics: []
}

function createAnimatedScene() {
  const root = new Group()
  const animatedGroup = new Group()
  const material = new MeshBasicMaterial()
  const geometry = new BoxGeometry(1, 1, 1)
  geometry.clearGroups()
  const meshes = [new Mesh(geometry, material), new Mesh(geometry, material), new Mesh(geometry, material)]
  meshes[1]!.position.x = 0.05
  meshes[2]!.position.x = 0.1
  animatedGroup.add(...meshes)
  root.add(animatedGroup)

  const animation = new AnimationClip('move-group', -1, [
    new VectorKeyframeTrack(
      `${animatedGroup.uuid}.position`,
      [0, 1],
      [0, 0, 0, 1, 0, 0]
    )
  ])

  return { root, animatedGroup, meshes, animation }
}

function createLodScene() {
  const root = new Group()
  const lod = new LOD()
  const material = new MeshBasicMaterial()
  const geometry = new BoxGeometry(1, 1, 1)
  geometry.clearGroups()
  const meshes = [new Mesh(geometry, material), new Mesh(geometry, material)]
  lod.addLevel(meshes[0]!, 0)
  lod.addLevel(meshes[1]!, 20)
  root.add(lod)
  return { root, lod, meshes }
}

test('merged meshes stay under their animated ancestor', () => {
  const { root, animatedGroup, meshes, animation } = createAnimatedScene()

  const stats = mergeStaticMsfsMeshes(root, emptyBehaviorSet, [animation])
  const batch = animatedGroup.children.find(child => child.name.startsWith('__MSFS_STATIC_MERGE_BATCH_'))

  expect(stats.mergedBatchCount).toBe(1)
  expect(stats.animationTargetResolutionFailed).toBe(false)
  expect(batch instanceof Mesh).toBe(true)
  expect(batch?.parent).toBe(animatedGroup)
  expect(meshes.every(mesh => !mesh.visible)).toBe(true)
})

test('instanced meshes stay under their animated ancestor', () => {
  const { root, animatedGroup, animation } = createAnimatedScene()

  const stats = instanceStaticMsfsMeshes(root, emptyBehaviorSet, [animation])
  const batch = animatedGroup.children.find(child => child.name.startsWith('__MSFS_STATIC_INSTANCE_BATCH_'))

  expect(stats.instancedBatchCount).toBe(1)
  expect(stats.animationTargetResolutionFailed).toBe(false)
  expect(batch instanceof InstancedMesh).toBe(true)
  expect(batch?.parent).toBe(animatedGroup)
})

test('unresolved animation targets leave geometry and visibility untouched', () => {
  const { root, meshes } = createAnimatedScene()
  const unresolvedAnimation = new AnimationClip('missing', -1, [
    new VectorKeyframeTrack('missing-node.position[x]', [0, 1], [0, 1])
  ])

  const mergeStats = mergeStaticMsfsMeshes(root, emptyBehaviorSet, [unresolvedAnimation])
  const instanceStats = instanceStaticMsfsMeshes(root, emptyBehaviorSet, [unresolvedAnimation])

  expect(mergeStats.animationTargetResolutionFailed).toBe(true)
  expect(instanceStats.animationTargetResolutionFailed).toBe(true)
  expect(meshes.every(mesh => mesh.visible && mesh.geometry instanceof BoxGeometry)).toBe(true)
})

test('compiled behavior targets remain intact while static siblings batch', () => {
  const { root, meshes } = createAnimatedScene()
  meshes[0]!.name = 'CONTROL'
  const behaviorSet: CompiledBehaviorSet = {
    ...emptyBehaviorSet,
    animationBindings: [{
      target: 'CONTROL',
      expression: { source: '0', instructions: [], variableKeys: [] },
      length: 1,
      wrap: false,
      delta: false,
      lagFramesPerSecond: 0,
      sourcePath: 'test'
    }]
  }

  const stats = mergeStaticMsfsMeshes(root, behaviorSet, [])

  expect(stats.skippedProtectedMeshCount).toBe(1)
  expect(stats.mergedMeshCount).toBe(2)
  expect(meshes[0]!.visible).toBe(true)
})

test('shared animated materials protect every mesh that references them', () => {
  const mergedScene = createAnimatedScene()
  const sharedMaterialAnimation = new AnimationClip('shared-material', -1, [
    new NumberKeyframeTrack(
      `${mergedScene.meshes[0]!.uuid}.material.color[r]`,
      [0, 1],
      [0, 1]
    )
  ])
  const mergeStats = mergeStaticMsfsMeshes(
    mergedScene.root,
    emptyBehaviorSet,
    [sharedMaterialAnimation]
  )

  const instancedScene = createAnimatedScene()
  const instancedMaterialAnimation = new AnimationClip('shared-material', -1, [
    new NumberKeyframeTrack(
      `${instancedScene.meshes[0]!.uuid}.material.color[r]`,
      [0, 1],
      [0, 1]
    )
  ])
  const instanceStats = instanceStaticMsfsMeshes(
    instancedScene.root,
    emptyBehaviorSet,
    [instancedMaterialAnimation]
  )

  expect(mergeStats.mergedBatchCount).toBe(0)
  expect(mergeStats.skippedProtectedMeshCount).toBe(3)
  expect(instanceStats.instancedBatchCount).toBe(0)
  expect(instanceStats.skippedProtectedMeshCount).toBe(3)
  expect(mergedScene.meshes.every(mesh => mesh.visible)).toBe(true)
  expect(instancedScene.meshes.every(mesh => mesh.visible)).toBe(true)
})

test('does not merge projected blend-g-buffer decals without preserving their bindings', () => {
  const root = new Group()
  const material = new MeshBasicMaterial({ transparent: true })
  material.userData.gltfExtensions = {
    ASOBO_material_blend_gbuffer: { baseColorBlendFactor: 1 }
  }
  const geometry = new BoxGeometry(1, 1, 1)
  const decals = [new Mesh(geometry, material), new Mesh(geometry, material)]
  const receiver = new Mesh(new BoxGeometry(), new MeshBasicMaterial())
  for (const decal of decals) {
    decal.userData.msfsBlendGBufferProjectedToReceiver = true
    decal.userData.msfsBlendGBufferReceiver = receiver
  }
  root.add(receiver, ...decals)

  const stats = mergeStaticMsfsMeshes(root, emptyBehaviorSet, [])

  expect(stats.mergedBatchCount).toBe(0)
  expect(decals.every(decal => decal.visible)).toBe(true)
  expect(decals.every(decal => decal.userData.msfsBlendGBufferReceiver === receiver)).toBe(true)
})

test('keeps batches under hidden and render-order groups', () => {
  const { root, animatedGroup } = createAnimatedScene()
  animatedGroup.visible = false
  animatedGroup.renderOrder = 4

  const stats = mergeStaticMsfsMeshes(root, emptyBehaviorSet, [])
  const batch = animatedGroup.children.find(child => child.name.startsWith('__MSFS_STATIC_MERGE_BATCH_'))

  expect(stats.mergedBatchCount).toBe(1)
  expect(batch?.parent).toBe(animatedGroup)
  expect(animatedGroup.visible).toBe(false)
  expect(animatedGroup.renderOrder).toBe(4)
})

test('keeps batches inside the nearest nested group at default render order', () => {
  const root = new Group()
  const outerGroup = new Group()
  const innerGroup = new Group()
  const material = new MeshBasicMaterial()
  const geometry = new BoxGeometry(1, 1, 1)
  geometry.clearGroups()
  innerGroup.add(
    new Mesh(geometry, material),
    new Mesh(geometry, material),
    new Mesh(geometry, material)
  )
  outerGroup.add(innerGroup)
  root.add(outerGroup)

  const stats = mergeStaticMsfsMeshes(root, emptyBehaviorSet, [])
  const batch = innerGroup.children.find(child => child.name.startsWith('__MSFS_STATIC_MERGE_BATCH_'))

  const instancedRoot = new Group()
  const instancedOuterGroup = new Group()
  const instancedInnerGroup = new Group()
  const instancedMaterial = new MeshBasicMaterial()
  const instancedGeometry = new BoxGeometry(1, 1, 1)
  instancedGeometry.clearGroups()
  instancedInnerGroup.add(
    new Mesh(instancedGeometry, instancedMaterial),
    new Mesh(instancedGeometry, instancedMaterial),
    new Mesh(instancedGeometry, instancedMaterial)
  )
  instancedOuterGroup.add(instancedInnerGroup)
  instancedRoot.add(instancedOuterGroup)

  const instanceStats = instanceStaticMsfsMeshes(instancedRoot, emptyBehaviorSet, [])
  const instancedBatch = instancedInnerGroup.children.find(child =>
    child.name.startsWith('__MSFS_STATIC_INSTANCE_BATCH_')
  )

  expect(stats.mergedBatchCount).toBe(1)
  expect(batch?.parent).toBe(innerGroup)
  expect(instanceStats.instancedBatchCount).toBe(1)
  expect(instancedBatch?.parent).toBe(instancedInnerGroup)
})

test('leaves direct LOD level meshes in place for merge and instancing', () => {
  const mergedScene = createLodScene()
  const mergeStats = mergeStaticMsfsMeshes(mergedScene.root, emptyBehaviorSet, [])
  const instancedScene = createLodScene()
  const instanceStats = instanceStaticMsfsMeshes(instancedScene.root, emptyBehaviorSet, [])

  expect(mergeStats.mergedBatchCount).toBe(0)
  expect(instanceStats.instancedBatchCount).toBe(0)
  expect(mergedScene.lod.levels.map(level => level.object)).toEqual(mergedScene.meshes)
  expect(instancedScene.lod.levels.map(level => level.object)).toEqual(instancedScene.meshes)
  expect(mergedScene.meshes.every(mesh => mesh.visible)).toBe(true)
  expect(instancedScene.meshes.every(mesh => mesh.visible)).toBe(true)
})
