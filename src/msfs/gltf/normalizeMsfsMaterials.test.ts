import { expect, test } from 'bun:test'
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
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

function unwrapNode(node: any): any {
  return node?.isVarNode === true ? node.node : node
}

function collectMaterialNodeScopes(root: any): string[] {
  const scopes: string[] = []
  const visited = new Set<object>()
  const pending = [root]

  while (pending.length > 0) {
    const node = unwrapNode(pending.pop())
    if (node == null || typeof node !== 'object' || visited.has(node)) {
      continue
    }
    visited.add(node)
    if (node.scope === 'color' || node.scope === 'opacity') {
      scopes.push(node.scope)
    } else if (
      node.isMaterialReferenceNode === true &&
      (node.property === 'color' || node.property === 'opacity')
    ) {
      scopes.push(node.property)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value.filter(item => item?.isNode === true))
      } else if ((value as { isNode?: boolean } | null)?.isNode === true) {
        pending.push(value)
      }
    }
  }

  return scopes.sort()
}

function nodeGraphHasConstructor(root: any, constructorName: string): boolean {
  const visited = new Set<object>()
  const pending = [root]

  while (pending.length > 0) {
    const node = unwrapNode(pending.pop())
    if (node == null || typeof node !== 'object' || visited.has(node)) {
      continue
    }
    visited.add(node)
    if (node.constructor?.name === constructorName) {
      return true
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        pending.push(...value.filter(item => item?.isNode === true))
      } else if ((value as { isNode?: boolean } | null)?.isNode === true) {
        pending.push(value)
      }
    }
  }

  return false
}

function evaluateCoverageNode(
  input: any,
  values: {
    readonly colorAlpha: number
    readonly opacity: number
    readonly textureAlpha: number
    readonly vertexAlpha: number
  }
): number | readonly number[] {
  const node = unwrapNode(input)
  if (node?.isConstNode === true) {
    return node.value
  }
  if (node?.scope === 'color') {
    return [1, 1, 1, values.colorAlpha]
  }
  if (node?.scope === 'opacity') {
    return values.opacity
  }
  if (node?.isMaterialReferenceNode === true) {
    if (node.property === 'color') {
      return [1, 1, 1]
    }
    if (node.property === 'opacity') {
      return values.opacity
    }
  }
  if (node?.constructor?.name === 'JoinNode') {
    const joined: number[] = []
    for (const child of node.nodes ?? []) {
      const value = evaluateCoverageNode(child, values)
      joined.push(...(Array.isArray(value) ? value : [Number(value)]))
    }
    return joined
  }
  if (node?.constructor?.name === 'TextureNode') {
    return [1, 1, 1, values.textureAlpha]
  }
  if (node?.constructor?.name === 'VertexColorNode') {
    return [1, 1, 1, values.vertexAlpha]
  }
  if (typeof node?.components === 'string') {
    const source = evaluateCoverageNode(node.node, values)
    if (!Array.isArray(source)) {
      throw new Error('Expected vector source for split node')
    }
    const index = 'xyzw'.indexOf(node.components)
    return source[index]
  }
  if (node?.convertTo != null) {
    return evaluateCoverageNode(node.node, values)
  }
  if (node?.op === '*') {
    const left = evaluateCoverageNode(node.aNode, values)
    const right = evaluateCoverageNode(node.bNode, values)
    if (Array.isArray(left) || Array.isArray(right)) {
      const length = Array.isArray(left) ? left.length : (right as readonly number[]).length
      return Array.from({ length }, (_, index) =>
        Number(Array.isArray(left) ? left[index] : left) *
        Number(Array.isArray(right) ? right[index] : right)
      )
    }
    return Number(left) * Number(right)
  }
  if (node?.method === 'clamp') {
    const value = Number(evaluateCoverageNode(node.aNode, values))
    const minimum = Number(evaluateCoverageNode(node.bNode, values))
    const maximum = Number(evaluateCoverageNode(node.cNode, values))
    return Math.min(maximum, Math.max(minimum, value))
  }
  throw new Error(`Unsupported coverage node: ${node?.constructor?.name ?? typeof node}`)
}

test('subdivides blend-gbuffer decals before projection', async () => {
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
  expect(position.count === 48).toBe(true)
  expect(Math.max(...Array.from(
    { length: position.count },
    (_, index) => Math.abs(position.getZ(index))
  )) < 1e-6).toBe(true)
  expect(decal.userData.msfsBlendGBufferProjectedToReceiver).toBe(true)
  expect(decal.userData.msfsBlendGBufferReceivers).toEqual([receiver])
})

test('keeps planar decal triangle joins shared', async () => {
  const root = new Group()
  const receiverGeometry = triangleGeometry([
    -0.2, -0.2, 0, 0.2, -0.2, 0, 0.2, 0.2, 0, -0.2, 0.2, 0,
  ])
  receiverGeometry.setIndex([0, 1, 2, 0, 2, 3])
  const decalGeometry = triangleGeometry([
    -0.2, -0.2, 0.01, 0.2, -0.2, 0.01, 0.2, 0.2, 0.01, -0.2, 0.2, 0.01,
  ])
  decalGeometry.setIndex([0, 1, 2, 0, 2, 3])
  const receiver = new Mesh(receiverGeometry, new MeshBasicMaterial())
  const decal = new Mesh(decalGeometry, blendGBufferMaterial())
  const parent = new Group()
  parent.add(receiver, decal)
  root.add(parent)

  await normalizeMsfsMaterials({ scene: root } as GLTF)

  expect(decal.geometry.getAttribute('position').count).toBe(4)
  expect(decal.geometry.index?.count).toBe(6)
})

test('projects decals only onto receiver faces matching their authored normal', async () => {
  const root = new Group()
  const parent = new Group()
  parent.add(new Mesh(triangleGeometry([0, 0, 0, 0.2, 0, 0, 0.2, 0]), new MeshBasicMaterial()))
  parent.add(
    new Mesh(
      triangleGeometry([0, 0, -0.1, 0, 0.2, -0.1, 0.2, 0, -0.1]),
      new MeshBasicMaterial()
    )
  )
  const decalGeometry = triangleGeometry([0, 0, 0.01, 0, 0.2, 0.01, 0.2, 0, 0.01])
  const decal = new Mesh(decalGeometry, blendGBufferMaterial())
  parent.add(decal)
  root.add(parent)

  await normalizeMsfsMaterials({ scene: root } as GLTF)

  expect(Math.abs(decal.geometry.getAttribute('position').getZ(0) + 0.1) < 1e-6).toBe(true)
})

test('projects decals along their authored normal before snapping to nearby surfaces', async () => {
  const root = new Group()
  const parent = new Group()
  const receiverGeometry = triangleGeometry([
    -0.2, -0.2, 0, 0.2, -0.2, 0, 0.2, 0.2, 0, -0.2, 0.2, 0,
  ])
  receiverGeometry.setIndex([0, 1, 2, 0, 2, 3])
  const receiver = new Mesh(receiverGeometry, new MeshBasicMaterial())
  const nearbySurface = new Mesh(
    triangleGeometry([
      0.02, -0.01, 0.09, 0.03, -0.01, 0.09, 0.02, 0.01, 0.09,
    ]),
    new MeshBasicMaterial()
  )
  const decalGeometry = triangleGeometry([
    0, 0, 0.1, 0.1, 0, 0.1, 0.1, 0.1, 0.1, 0, 0.1, 0.1,
  ])
  decalGeometry.setIndex([0, 1, 2, 0, 2, 3])
  const decal = new Mesh(decalGeometry, blendGBufferMaterial())
  parent.add(receiver, nearbySurface, decal)
  root.add(parent)

  await normalizeMsfsMaterials({ scene: root } as GLTF)

  expect(Math.abs(decal.geometry.getAttribute('position').getZ(0)) < 1e-6).toBe(true)
})

test('does not project a decal through a solid receiver descendant', async () => {
  const root = new Group()
  const parent = new Group()
  const receiver = new Mesh(
    triangleGeometry([0, 0, 0, 0.2, 0, 0, 0, 0.2, 0]),
    new MeshBasicMaterial()
  )
  receiver.add(
    new Mesh(
      triangleGeometry([0, 0, 0.005, 0.2, 0, 0.005, 0, 0.2, 0.005]),
      new MeshBasicMaterial()
    )
  )
  const decal = new Mesh(
    triangleGeometry([0, 0, 0.01, 0.2, 0, 0.01, 0, 0.2, 0.01]),
    blendGBufferMaterial()
  )
  parent.add(receiver, decal)
  root.add(parent)

  await normalizeMsfsMaterials({ scene: root } as GLTF)

  expect(decal.geometry.getAttribute('position').getZ(0) > 0.009).toBe(true)
  expect(decal.userData.msfsBlendGBufferProjectedToReceiver).toBeUndefined()
})

test('splits curved projected decals across receiver faces', async () => {
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

  expect(decal.geometry.getAttribute('position').count > 3).toBe(true)
  expect(Array.from(
    { length: decal.geometry.getAttribute('position').count },
    (_, index) => Math.abs(decal.geometry.getAttribute('position').getX(index))
  ).some(value => value < 1e-10)).toBe(true)
  expect(decal.geometry.getAttribute('msfsBlendGBufferDepthAllowance') == null).toBe(false)
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
  const decalMap = new Texture()
  const decalMaterial = new MeshStandardMaterial({
    map: decalMap,
    opacity: 0.5,
    transparent: true,
    vertexColors: true,
    alphaTest: 0.35,
  })
  decalMaterial.userData.gltfExtensions = {
    ASOBO_material_blend_gbuffer: { baseColorBlendFactor: 1 }
  }
  const decal = new Mesh(
    triangleGeometry([0, 0, 0.01, 1, 0, 0.01, 0, 1, 0.01]),
    decalMaterial
  )
  decal.geometry.setAttribute(
    'color',
    new BufferAttribute(new Float32Array([
      1, 1, 1, 1,
      1, 1, 1, 1,
      1, 1, 1, 1,
    ]), 4)
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
    fragmentNode?: unknown
    mrtNode?: unknown
  }
  expect(receiverWriter.type).toBe('MeshBasicNodeMaterial')
  expect(receiverWriter.map).toBe(baseMap)
  expect(receiverWriter.normalMap).toBe(normalMap)
  expect(receiverWriter.roughnessMap).toBe(ormMap)
  expect(receiverWriter.metalnessMap).toBe(ormMap)
  expect(receiverWriter.aoMap).toBe(ormMap)
  expect((receiverWriter as typeof receiverWriter & { depthNode?: unknown }).depthNode ?? null).toBe(null)
  const normalizedDecal = decal.material as Material & {
    colorNode?: any
    opacityNode?: any
    lights?: boolean
  }
  const decalWriter = getMsfsGBufferWriter(decal.material) as Material & {
    depthNode?: unknown
    fragmentNode?: unknown
    maskNode?: unknown
    mrtNode?: any
  }
  const decalColorNode = unwrapNode(normalizedDecal.colorNode)
  const decalColorAlpha = unwrapNode(decalColorNode.nodes.at(-1))
  const decalG0 = unwrapNode(decalWriter.mrtNode.outputNodes.aircraftG0)
  const decalCoverage = decalG0.nodes.at(-1)

  expect(decalColorAlpha.value).toBe(1)
  expect(normalizedDecal.opacity).toBe(0.5)
  expect(normalizedDecal.alphaTest).toBe(0.35)
  expect(collectMaterialNodeScopes(decalCoverage)).toEqual(['color', 'opacity'])
  expect(nodeGraphHasConstructor(decalG0.nodes.at(0), 'TextureNode')).toBe(true)
  expect(nodeGraphHasConstructor(decalG0.nodes.at(0), 'VertexColorNode')).toBe(true)
  expect(nodeGraphHasConstructor(normalizedDecal.colorNode, 'TextureNode')).toBe(true)
  expect(nodeGraphHasConstructor(normalizedDecal.colorNode, 'VertexColorNode')).toBe(true)
  expect(nodeGraphHasConstructor(normalizedDecal.opacityNode, 'TextureNode')).toBe(true)
  expect(nodeGraphHasConstructor(normalizedDecal.opacityNode, 'VertexColorNode')).toBe(true)
  for (const alpha of [0, 0.1, 0.5, 1]) {
    expect(evaluateCoverageNode(decalCoverage, {
      colorAlpha: 1,
      opacity: 1,
      textureAlpha: alpha,
      vertexAlpha: 1,
    })).toBe(alpha)
  }
  expect(evaluateCoverageNode(decalCoverage, {
    colorAlpha: 1,
    opacity: 0.5,
    textureAlpha: 0.5,
    vertexAlpha: 1,
  })).toBe(0.25)
  expect(evaluateCoverageNode(decalCoverage, {
    colorAlpha: 1,
    opacity: 0.5,
    textureAlpha: 0.5,
    vertexAlpha: 0.5,
  })).toBe(0.125)
  expect(receiverWriter.fragmentNode).toBe(receiverWriter.mrtNode)
  expect(decalWriter.fragmentNode).toBe(decalWriter.mrtNode)
  expect(decalWriter.maskNode == null).toBe(false)
  expect(nodeGraphHasConstructor(decalWriter.maskNode, 'TextureNode')).toBe(true)
  expect(nodeGraphHasConstructor(decalWriter.maskNode, 'VertexColorNode')).toBe(true)
  expect(decalWriter.alphaTest).toBe(0)
  expect(decalWriter.transparent).toBe(true)
  expect(decalWriter.blending).toBe(NormalBlending)
  expect(decalWriter.premultipliedAlpha).toBe(false)
  expect(decalWriter.depthNode == null).toBe(false)
  expect(decalWriter.depthTest).toBe(true)
  expect(decalWriter.depthWrite).toBe(false)
  expect(normalizedDecal.lights).toBe(true)
  expect(getMsfsGBufferWriter(unsupported.material)).toBe(null)
  expect((unsupported.material as { isNodeMaterial?: boolean }).isNodeMaterial === true).toBe(false)
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
