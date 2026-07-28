import { expect, test } from 'bun:test'
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Texture,
  type Material
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

const gpuGlobals = globalThis as typeof globalThis & {
  GPUShaderStage?: { VERTEX: number; FRAGMENT: number; COMPUTE: number }
}
gpuGlobals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
const { MeshStandardNodeMaterial } = await import('three/webgpu')
const {
  getMsfsBlendFactors,
  getMsfsGBufferWriter,
  normalizeMsfsMaterials
} = await import('./normalizeMsfsMaterials')

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
  expect(decal.userData.msfsBlendGBufferProjectedToReceiver).toBe(true)
  expect(decal.userData.msfsBlendGBufferReceivers).toEqual([receiver])
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

test('parses every blend-gbuffer component factor', () => {
  const material = new MeshBasicMaterial()
  material.userData.gltfExtensions = {
    ASOBO_material_blend_gbuffer: {
      baseColorBlendFactor: 0.1,
      metallicBlendFactor: 0.2,
      roughnessBlendFactor: 0.3,
      normalBlendFactor: 0.4,
      emissiveBlendFactor: 0.5,
      occlusionBlendFactor: 0.6,
    }
  }

  expect(getMsfsBlendFactors(material)).toEqual({
    baseColor: 0.1,
    metallic: 0.2,
    roughness: 0.3,
    normal: 0.4,
    emissive: 0.5,
    occlusion: 0.6,
  })
})

test('builds G-buffer writers only for node-compatible materials', async () => {
  const root = new Group()
  const baseMap = new Texture()
  const normalMap = new Texture()
  const ormMap = new Texture()
  const receiverMaterial = new MeshStandardMaterial({
    map: baseMap,
    normalMap,
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    aoMap: ormMap,
    roughness: 0.25,
    metalness: 0.75,
  })
  const receiver = new Mesh(
    triangleGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    receiverMaterial
  )
  const decalMaterial = new MeshStandardMaterial()
  decalMaterial.userData.gltfExtensions = {
    ASOBO_material_blend_gbuffer: { baseColorBlendFactor: 1 }
  }
  const decal = new Mesh(
    triangleGeometry([0, 0, 0.01, 1, 0, 0.01, 0, 1, 0.01]),
    decalMaterial
  )
  const unsupported = new Mesh(
    triangleGeometry([0, 0, 1, 1, 0, 1, 0, 1, 1]),
    new MeshBasicMaterial()
  )
  const parent = new Group()
  parent.add(receiver, decal, unsupported)
  root.add(parent)

  await normalizeMsfsMaterials({ scene: root } as GLTF, {
    createNodeMaterial: material => {
      if (!(material instanceof MeshStandardMaterial)) {
        return null
      }
      const nodeMaterial = new MeshStandardNodeMaterial()
      nodeMaterial.copy(material as never)
      nodeMaterial.map = material.map
      nodeMaterial.normalMap = material.normalMap
      nodeMaterial.roughness = material.roughness
      nodeMaterial.roughnessMap = material.roughnessMap
      nodeMaterial.metalness = material.metalness
      nodeMaterial.metalnessMap = material.metalnessMap
      nodeMaterial.aoMap = material.aoMap
      nodeMaterial.userData = { ...material.userData }
      return nodeMaterial
    }
  })

  const receiverWriter = getMsfsGBufferWriter(receiver.material) as MeshBasicMaterial & {
    normalMap?: Texture | null
    roughnessMap?: Texture | null
    metalnessMap?: Texture | null
    aoMap?: Texture | null
  }
  expect(receiverWriter.type).toBe('MeshBasicNodeMaterial')
  expect(receiverWriter.map).toBe(baseMap)
  expect(receiverWriter.normalMap).toBe(normalMap)
  expect(receiverWriter.roughnessMap).toBe(ormMap)
  expect(receiverWriter.metalnessMap).toBe(ormMap)
  expect(receiverWriter.aoMap).toBe(ormMap)
  expect((receiverWriter as typeof receiverWriter & { depthNode?: unknown }).depthNode ?? null).toBe(null)
  const decalWriter = getMsfsGBufferWriter(decal.material) as Material & {
    depthNode?: unknown
  }
  expect(decalWriter.depthNode == null).toBe(false)
  expect(decalWriter.depthTest).toBe(true)
  expect(decalWriter.depthWrite).toBe(false)
  expect((decal.material as typeof decalMaterial & { lights?: boolean }).lights).toBe(false)
  expect(getMsfsGBufferWriter(unsupported.material)).toBe(null)
})

test('preserves primitive draw order for overlapping decals', async () => {
  const root = new Group()
  const parent = new Group()
  const receiver = new Mesh(
    triangleGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    new MeshBasicMaterial()
  )
  const first = new Mesh(
    triangleGeometry([0, 0, 0.01, 1, 0, 0.01, 0, 1, 0.01]),
    blendGBufferMaterial()
  )
  const second = new Mesh(
    triangleGeometry([0, 0, 0.02, 1, 0, 0.02, 0, 1, 0.02]),
    blendGBufferMaterial()
  )
  parent.add(receiver, first, second)
  root.add(parent)
  const associations = new Map<object, { meshes?: number; primitives?: number }>([
    [receiver, { meshes: 0, primitives: 0 }],
    [first, { meshes: 0, primitives: 1 }],
    [second, { meshes: 0, primitives: 2 }],
  ])

  await normalizeMsfsMaterials({
    scene: root,
    parser: {
      associations,
      json: { meshes: [{ primitives: [{}, {}, {}] }] },
      getDependency: async () => { throw new Error('unexpected texture load') }
    }
  } as unknown as GLTF)

  expect(first.renderOrder < second.renderOrder).toBe(true)
})

test('transfers projected normal tangent and skin attributes from receivers', async () => {
  const root = new Group()
  const receiverGeometry = triangleGeometry([0, 0, 0, 1, 0, 0, 0, 1, 0])
  receiverGeometry.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1
  ]), 3))
  receiverGeometry.setAttribute('tangent', new BufferAttribute(new Float32Array([
    1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1
  ]), 4))
  receiverGeometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array([
    2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0
  ]), 4))
  receiverGeometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array([
    1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0
  ]), 4))
  const receiver = new Mesh(receiverGeometry, new MeshBasicMaterial())
  const decalGeometry = triangleGeometry([0, 0, 0.01, 1, 0, 0.01, 0, 1, 0.01])
  decalGeometry.setAttribute('normal', new BufferAttribute(new Float32Array(9), 3))
  decalGeometry.setAttribute('tangent', new BufferAttribute(new Float32Array(12), 4))
  const decal = new Mesh(decalGeometry, blendGBufferMaterial())
  const parent = new Group()
  parent.add(receiver, decal)
  root.add(parent)

  await normalizeMsfsMaterials({ scene: root } as GLTF)

  expect(Math.abs(decal.geometry.getAttribute('normal').getZ(0) - 1) < 1e-6).toBe(true)
  expect(Math.abs(decal.geometry.getAttribute('tangent').getX(0) - 1) < 1e-6).toBe(true)
  expect(decal.geometry.getAttribute('skinIndex').getX(0)).toBe(2)
  expect(Math.abs(decal.geometry.getAttribute('skinWeight').getX(0) - 1) < 1e-6).toBe(true)
})
