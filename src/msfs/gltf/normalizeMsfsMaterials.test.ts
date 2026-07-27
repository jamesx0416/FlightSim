import { expect, test } from 'bun:test'
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

const gpuGlobals = globalThis as typeof globalThis & {
  GPUShaderStage?: { VERTEX: number; FRAGMENT: number; COMPUTE: number }
}
gpuGlobals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
const { normalizeMsfsMaterials } = await import('./normalizeMsfsMaterials')

function triangleGeometry(vertices: readonly number[]): BufferGeometry {
  return new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3))
}

function blendGBufferMaterial(): MeshBasicMaterial {
  const material = new MeshBasicMaterial()
  material.userData.gltfExtensions = {
    ASOBO_material_blend_gbuffer: { baseColorBlendFactor: 1 }
  }
  return material
}

test('projects planar blend-gbuffer decals without extra triangles', async () => {
  const root = new Group()
  const receiver = new Mesh(
    triangleGeometry([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0]),
    new MeshBasicMaterial()
  )
  const decal = new Mesh(
    triangleGeometry([0, 0, 0.01, 0.2, 0, 0.01, 0, 0.2, 0.01]),
    blendGBufferMaterial()
  )
  const parent = new Group()
  parent.add(receiver, decal)
  root.add(parent)

  await normalizeMsfsMaterials({ scene: root } as GLTF)

  const position = decal.geometry.getAttribute('position')
  expect(position.count === 3).toBe(true)
  expect(Math.max(...Array.from(
    { length: position.count },
    (_, index) => Math.abs(position.getZ(index))
  )) < 1e-6).toBe(true)
})

test('keeps curved projected decals flat while recording their local depth allowance', async () => {
  const root = new Group()
  const receiver = new Mesh(
    triangleGeometry([
      -0.2, 0, 0, 0, 0, 0, 0, 0.2, 0,
      0, 0, 0, 0, 0, 0.2, 0, 0.2, 0
    ]),
    new MeshBasicMaterial()
  )
  const decal = new Mesh(
    triangleGeometry([-0.1, 0.02, 0.01, 0.01, 0.02, 0.1, 0, 0.18, 0.01]),
    blendGBufferMaterial()
  )
  const parent = new Group()
  parent.add(receiver, decal)
  root.add(parent)

  await normalizeMsfsMaterials({ scene: root } as GLTF)

  expect(decal.geometry.getAttribute('position').count).toBe(3)
  const allowance = decal.geometry.getAttribute('msfsBlendGBufferDepthAllowance')
  expect(Math.max(...Array.from({ length: allowance.count }, (_, index) => allowance.getX(index))) > 0).toBe(true)
})
