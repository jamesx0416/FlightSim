import { expect, test } from 'bun:test'
import { BufferGeometry, LOD, Mesh, MeshBasicMaterial } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { positionLocal } from 'three/tsl'

import { isSafeStaticMeshBatchCandidate } from './staticMeshBatchingEligibility'

test('allows built-in normalized node materials with the default vertex path', () => {
  const material = new MeshBasicNodeMaterial()
  const mesh = new Mesh(new BufferGeometry(), material)

  expect(isSafeStaticMeshBatchCandidate(mesh, material)).toBe(true)
})

test('rejects custom mesh render callbacks', () => {
  const material = new MeshBasicMaterial()
  const mesh = new Mesh(new BufferGeometry(), material)
  mesh.onBeforeRender = () => {}

  expect(isSafeStaticMeshBatchCandidate(mesh, material)).toBe(false)
})

test('rejects meshes whose visibility also controls child objects', () => {
  const material = new MeshBasicMaterial()
  const mesh = new Mesh(new BufferGeometry(), material)
  mesh.add(new Mesh(new BufferGeometry(), material))

  expect(isSafeStaticMeshBatchCandidate(mesh, material)).toBe(false)
})

test('rejects meshes that are direct LOD level objects', () => {
  const material = new MeshBasicMaterial()
  const mesh = new Mesh(new BufferGeometry(), material)
  const lod = new LOD()
  lod.addLevel(mesh, 0)

  expect(mesh.parent).toBe(lod)
  expect(isSafeStaticMeshBatchCandidate(mesh, material)).toBe(false)
})

test('rejects custom material shader hooks', () => {
  const material = new MeshBasicMaterial()
  const mesh = new Mesh(new BufferGeometry(), material)
  material.onBeforeCompile = () => {}

  expect(isSafeStaticMeshBatchCandidate(mesh, material)).toBe(false)
})

test('rejects node materials with a custom vertex position', () => {
  const material = new MeshBasicNodeMaterial()
  const mesh = new Mesh(new BufferGeometry(), material)
  material.positionNode = positionLocal

  expect(isSafeStaticMeshBatchCandidate(mesh, material)).toBe(false)
})

test('rejects alternate vertex and geometry node paths', () => {
  const vertexMaterial = new MeshBasicNodeMaterial()
  vertexMaterial.vertexNode = positionLocal
  expect(isSafeStaticMeshBatchCandidate(
    new Mesh(new BufferGeometry(), vertexMaterial), vertexMaterial
  )).toBe(false)

  const geometryMaterial = new MeshBasicNodeMaterial()
  geometryMaterial.geometryNode = () => positionLocal
  expect(isSafeStaticMeshBatchCandidate(
    new Mesh(new BufferGeometry(), geometryMaterial), geometryMaterial
  )).toBe(false)
})
