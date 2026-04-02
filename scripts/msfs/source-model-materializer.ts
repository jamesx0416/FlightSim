import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, resolve } from 'node:path'

interface ModelsJsonAddition {
  gltf?: string
  bin?: string
  nodes?: Array<Record<string, unknown>>
  combineFiles?: unknown
  lods?: unknown
}

interface ModelsJsonModification {
  accessors?: string[]
  data?: number[][]
  node?: string
  mods?: Record<string, unknown>
  outputSamplers?: Array<number[][] | null>
  lods?: unknown
}

interface ModelsJsonSplitAnimation {
  animation?: string
  newAnimations?: Array<{
    name: string
    indices: number[]
    targetNode?: string
  }>
  lods?: unknown
}

interface ModelsJsonParentNode {
  parent?: string
  name?: string
  lods?: unknown
}

export interface ModelsJsonEntry {
  gltf?: unknown
  bin?: unknown
  output?: {
    gltf?: unknown
    bin?: unknown
  }
  additions?: ModelsJsonAddition[]
  modifications?: ModelsJsonModification[]
  splitAnimations?: ModelsJsonSplitAnimation[]
  addParentNodes?: ModelsJsonParentNode[]
}

const COMPONENT_TYPE_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4
}

const COMPONENT_COUNT_BY_TYPE: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4
}

export function materializeModelsJsonOutput(options: {
  sourceModelRoot: string
  entry: ModelsJsonEntry
  outputIndex: number
  materializedRoot: string
}): string | undefined {
  const sourceGltfs = asStringArray(options.entry.gltf)
  const sourceBins = asStringArray(options.entry.bin)
  const outputGltfs = asStringArray(options.entry.output?.gltf)
  const outputBins = asStringArray(options.entry.output?.bin)

  const sourceGltfPath = sourceGltfs[options.outputIndex]
  const outputGltfPath = outputGltfs[options.outputIndex]
  if (!sourceGltfPath || !outputGltfPath) {
    return undefined
  }

  const sourceGltfAbsolutePath = resolve(options.sourceModelRoot, sourceGltfPath)
  if (!existsSync(sourceGltfAbsolutePath)) {
    return undefined
  }

  const sourceBinAbsolutePath = sourceBins[options.outputIndex]
    ? resolve(options.sourceModelRoot, sourceBins[options.outputIndex]!)
    : undefined
  const outputGltfAbsolutePath = resolveMaterializedOutputPath(
    options.sourceModelRoot,
    options.materializedRoot,
    outputGltfPath
  )
  const outputBinAbsolutePath =
    outputBins[options.outputIndex]
      ? resolveMaterializedOutputPath(
          options.sourceModelRoot,
          options.materializedRoot,
          outputBins[options.outputIndex]!
        )
      : undefined

  if (!outputGltfAbsolutePath) {
    return undefined
  }

  if (
    existsSync(outputGltfAbsolutePath) &&
    statSync(outputGltfAbsolutePath).isFile() &&
    (!outputBinAbsolutePath ||
      (existsSync(outputBinAbsolutePath) && statSync(outputBinAbsolutePath).isFile()))
  ) {
    return outputGltfAbsolutePath
  }

  mkdirSync(dirname(outputGltfAbsolutePath), { recursive: true })
  copyFileSync(sourceGltfAbsolutePath, outputGltfAbsolutePath)

  const lod = parseLodNumber(sourceGltfPath)
  const modifications = (options.entry.modifications ?? []).filter(entry =>
    includesLod(entry.lods, lod)
  )

  if (sourceBinAbsolutePath && outputBinAbsolutePath) {
    mkdirSync(dirname(outputBinAbsolutePath), { recursive: true })

    if (modifications.length > 0) {
      applyNodeModifications(outputGltfAbsolutePath, modifications)
      let modifiedBin = new Uint8Array(readFileSync(sourceBinAbsolutePath))
      modifiedBin = applyAccessorModifications(
        modifiedBin,
        sourceGltfAbsolutePath,
        modifications
      )
      modifiedBin = applyOutputSamplerModifications(
        modifiedBin,
        sourceGltfAbsolutePath,
        modifications
      )
      writeFileSync(outputBinAbsolutePath, modifiedBin)
    } else {
      copyFileSync(sourceBinAbsolutePath, outputBinAbsolutePath)
    }
  }

  for (const addition of (options.entry.additions ?? []).filter(entry =>
    includesLod(entry.lods, lod)
  )) {
    if (addition.nodes?.length) {
      const combineFiles = asStringArray(addition.combineFiles)
      const matchesCurrentSource = combineFiles.some(
        filePath => resolve(options.sourceModelRoot, filePath) === sourceGltfAbsolutePath
      )
      if (matchesCurrentSource) {
        addNodes(outputGltfAbsolutePath, addition.nodes)
      }
      continue
    }

    if (!addition.gltf) {
      continue
    }

    combineGltf(
      outputGltfAbsolutePath,
      resolve(options.sourceModelRoot, addition.gltf),
      outputGltfAbsolutePath
    )

    if (addition.bin && outputBinAbsolutePath) {
      appendFileSync(
        outputBinAbsolutePath,
        Buffer.alloc((4 - (statSync(outputBinAbsolutePath).size % 4)) % 4)
      )
      appendFileSync(
        outputBinAbsolutePath,
        readFileSync(resolve(options.sourceModelRoot, addition.bin))
      )
    }
  }

  for (const splitAnimation of (options.entry.splitAnimations ?? []).filter(entry =>
    includesLod(entry.lods, lod)
  )) {
    splitAnimations(outputGltfAbsolutePath, splitAnimation)
  }

  for (const parentNode of (options.entry.addParentNodes ?? []).filter(entry =>
    includesLod(entry.lods, lod)
  )) {
    addParentNode(outputGltfAbsolutePath, parentNode)
  }

  return outputGltfAbsolutePath
}

function addNodes(gltfPath: string, nodes: Array<Record<string, unknown>>): void {
  const gltf = readJson(gltfPath)
  const nodesToAdd = cloneJson(nodes) as Array<Record<string, unknown>>
  const rootSceneNodes = ensureRootSceneNodes(gltf)

  for (const node of nodesToAdd) {
    const meshValue = node.mesh
    if (!Number.isFinite(meshValue)) {
      node.mesh = findMeshIndexByName(gltf, meshValue)
    }

    const insertedNodeIndex = gltf.nodes.length
    const parentNodeName = typeof node.parentNode === 'string' ? node.parentNode : undefined
    delete node.parentNode

    gltf.nodes.push(node)

    if (parentNodeName) {
      const parentNode = gltf.nodes.find(
        (candidate: Record<string, unknown>) => candidate.name === parentNodeName
      )
      if (parentNode) {
        const children = Array.isArray(parentNode.children)
          ? (parentNode.children as number[])
          : []
        children.push(insertedNodeIndex)
        parentNode.children = children
      }
    } else {
      rootSceneNodes.push(insertedNodeIndex)
    }
  }

  writeJson(gltfPath, gltf)
}

function combineGltf(pathA: string, pathB: string, outputPath: string): void {
  const gltfA = readJson(pathA)
  const gltfB = readJson(pathB)

  gltfA.accessors ??= []
  gltfA.bufferViews ??= []
  gltfA.materials ??= []
  gltfA.meshes ??= []
  gltfA.nodes ??= []
  gltfA.images ??= []
  gltfA.textures ??= []
  gltfA.extensionsUsed ??= []
  gltfA.buffers ??= [{ byteLength: 0 }]
  gltfA.scenes ??= [{ nodes: [] }]
  gltfB.accessors ??= []
  gltfB.bufferViews ??= []
  gltfB.materials ??= []
  gltfB.meshes ??= []
  gltfB.nodes ??= []
  gltfB.images ??= []
  gltfB.textures ??= []
  gltfB.scenes ??= [{ nodes: [] }]
  gltfB.buffers ??= [{ byteLength: 0 }]

  const accessorsCount = gltfA.accessors.length
  const bufferViewsCount = gltfA.bufferViews.length
  const materialsCount = gltfA.materials.length
  const meshesCount = gltfA.meshes.length
  const nodesCount = gltfA.nodes.length
  const imagesCount = gltfA.images.length
  const texturesCount = gltfA.textures.length
  const bufferSize = gltfA.buffers[0]?.byteLength ?? 0

  for (const bufferView of gltfB.bufferViews) {
    const nextBufferView = cloneJson(bufferView)
    nextBufferView.byteOffset =
      (typeof nextBufferView.byteOffset === 'number' ? nextBufferView.byteOffset : 0) +
      bufferSize +
      ((4 - (bufferSize % 4)) % 4)
    gltfA.bufferViews.push(nextBufferView)
  }

  for (const accessor of gltfB.accessors) {
    const nextAccessor = cloneJson(accessor)
    nextAccessor.bufferView += bufferViewsCount
    gltfA.accessors.push(nextAccessor)
  }

  for (const texture of gltfB.textures) {
    const nextTexture = cloneJson(texture)
    if (typeof nextTexture.source === 'number') {
      nextTexture.source += imagesCount
    }
    if (
      nextTexture.extensions?.MSFT_texture_dds &&
      typeof nextTexture.extensions.MSFT_texture_dds.source === 'number'
    ) {
      nextTexture.extensions.MSFT_texture_dds.source += imagesCount
    }
    gltfA.textures.push(nextTexture)
  }

  for (const image of gltfB.images) {
    gltfA.images.push(cloneJson(image))
  }

  for (const material of gltfB.materials) {
    const nextMaterial = cloneJson(material)
    for (const value of Object.values(nextMaterial)) {
      if (!value || Array.isArray(value) || typeof value !== 'object') {
        continue
      }
      if (typeof value.index === 'number') {
        value.index += texturesCount
      }
      if (value.baseColorTexture && typeof value.baseColorTexture.index === 'number') {
        value.baseColorTexture.index += texturesCount
      }
      if (
        value.metallicRoughnessTexture &&
        typeof value.metallicRoughnessTexture.index === 'number'
      ) {
        value.metallicRoughnessTexture.index += texturesCount
      }
    }
    for (const extension of Object.keys(nextMaterial.extensions ?? {})) {
      if (!gltfA.extensionsUsed.includes(extension)) {
        gltfA.extensionsUsed.push(extension)
      }
    }
    gltfA.materials.push(nextMaterial)
  }

  for (const mesh of gltfB.meshes) {
    const nextMesh = cloneJson(mesh)
    for (const primitive of nextMesh.primitives ?? []) {
      for (const attributeName of Object.keys(primitive.attributes ?? {})) {
        primitive.attributes[attributeName] += accessorsCount
      }
      primitive.indices += accessorsCount
      if (!Number.isFinite(primitive.material)) {
        primitive.material = findMaterialIndexByName(gltfA, primitive.material)
      } else {
        primitive.material += materialsCount
      }
    }
    gltfA.meshes.push(nextMesh)
  }

  const skippedSceneNodes = new Set<number>()

  gltfB.nodes.forEach((node: Record<string, unknown>, nodeIndex: number) => {
    const nextNode = cloneJson(node)
    if (Number.isFinite(nextNode.mesh)) {
      nextNode.mesh += meshesCount
    }
    if (Array.isArray(nextNode.children)) {
      nextNode.children = nextNode.children.map((child: number) => child + nodesCount)
    }
    const parentNodeName = typeof nextNode.parentNode === 'string' ? nextNode.parentNode : undefined
    if (parentNodeName) {
      const parentNode = gltfA.nodes.find(
        (candidate: Record<string, unknown>) => candidate.name === parentNodeName
      )
      if (parentNode) {
        const children = Array.isArray(parentNode.children)
          ? (parentNode.children as number[])
          : []
        children.push(gltfA.nodes.length)
        parentNode.children = children
      }
      skippedSceneNodes.add(nodeIndex)
      delete nextNode.parentNode
    }
    gltfA.nodes.push(nextNode)
  })

  const rootSceneNodes = ensureRootSceneNodes(gltfA)
  for (const nodeIndex of ensureRootSceneNodes(gltfB)) {
    if (!skippedSceneNodes.has(nodeIndex)) {
      rootSceneNodes.push(nodeIndex + nodesCount)
    }
  }

  if (gltfB.animations?.length) {
    gltfA.animations ??= []
    for (const animation of gltfB.animations) {
      const nextAnimation = cloneJson(animation)
      for (const channel of nextAnimation.channels ?? []) {
        channel.target.node += nodesCount
      }
      for (const sampler of nextAnimation.samplers ?? []) {
        sampler.input += accessorsCount
        sampler.output += accessorsCount
      }
      gltfA.animations.push(nextAnimation)
    }
  }

  if (gltfA.buffers[0] && gltfB.buffers[0]) {
    gltfA.buffers[0].byteLength +=
      gltfB.buffers[0].byteLength + ((4 - (bufferSize % 4)) % 4)
  }

  writeJson(outputPath, gltfA)
}

function applyAccessorModifications(
  buffer: Uint8Array,
  gltfPath: string,
  modifications: ModelsJsonModification[]
): Uint8Array {
  const gltf = readJson(gltfPath)
  for (const modification of modifications) {
    if (!modification.accessors?.length || !modification.data?.length) {
      continue
    }
    for (const accessorName of modification.accessors) {
      for (const accessor of gltf.accessors ?? []) {
        if (accessor.name === accessorName) {
          buffer = replaceAccessorData(buffer, gltf, accessor, modification.data)
        }
      }
    }
  }
  return buffer
}

function replaceAccessorData(
  buffer: Uint8Array,
  gltf: Record<string, any>,
  accessor: Record<string, any>,
  data: number[][]
): Uint8Array {
  const accessorByteOffset = accessor.byteOffset ?? 0
  const bufferView = gltf.bufferViews?.[accessor.bufferView]
  if (!bufferView) {
    return buffer
  }
  const bufferViewByteOffset = bufferView.byteOffset ?? 0
  const componentCount = COMPONENT_COUNT_BY_TYPE[accessor.type]
  const componentSize = COMPONENT_TYPE_SIZE[accessor.componentType]
  if (!componentCount || !componentSize) {
    return buffer
  }

  let byteStride = bufferView.byteStride
  if (byteStride === undefined) {
    byteStride = componentCount * componentSize
  }

  const byteOffset = accessorByteOffset + bufferViewByteOffset

  for (let rowIndex = 0; rowIndex < data.length; rowIndex += 1) {
    const row = data[rowIndex]
    for (let componentIndex = 0; componentIndex < componentCount; componentIndex += 1) {
      const index =
        byteOffset +
        componentIndex * componentSize +
        rowIndex * byteStride
      writeAccessorComponent(
        buffer,
        index,
        accessor.componentType,
        row[componentIndex] ?? 0
      )
    }
  }

  return buffer
}

function writeAccessorComponent(
  buffer: Uint8Array,
  byteOffset: number,
  componentType: number,
  value: number
): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  switch (componentType) {
    case 5120:
      view.setInt8(byteOffset, value)
      return
    case 5121:
      view.setUint8(byteOffset, value)
      return
    case 5122:
    case 5123:
      view.setUint16(byteOffset, floatToHalfBits(value), true)
      return
    case 5125:
      view.setUint32(byteOffset, value >>> 0, true)
      return
    case 5126:
      view.setFloat32(byteOffset, value, true)
      return
  }
}

function floatToHalfBits(value: number): number {
  if (!Number.isFinite(value)) {
    return value < 0 ? 0xfc00 : 0x7c00
  }

  const floatView = new Float32Array(1)
  const intView = new Uint32Array(floatView.buffer)
  floatView[0] = value

  const bits = intView[0]
  const sign = (bits >> 16) & 0x8000
  let exponent = ((bits >> 23) & 0xff) - 127 + 15
  let mantissa = bits & 0x7fffff

  if (exponent <= 0) {
    if (exponent < -10) {
      return sign
    }
    mantissa = (mantissa | 0x800000) >> (1 - exponent)
    return sign | ((mantissa + 0x1000) >> 13)
  }

  if (exponent >= 0x1f) {
    return sign | 0x7c00
  }

  return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13)
}

function applyNodeModifications(
  gltfPath: string,
  modifications: ModelsJsonModification[]
): void {
  const gltf = readJson(gltfPath)
  for (const modification of modifications) {
    if (!modification.node || !modification.mods) {
      continue
    }
    for (const node of gltf.nodes ?? []) {
      if (node.name === modification.node) {
        Object.assign(node, modification.mods)
      }
    }
  }
  writeJson(gltfPath, gltf)
}

function applyOutputSamplerModifications(
  buffer: Uint8Array,
  gltfPath: string,
  modifications: ModelsJsonModification[]
): Uint8Array {
  const gltf = readJson(gltfPath)
  for (const modification of modifications) {
    if (!modification.node || !modification.outputSamplers?.length) {
      continue
    }

    const nodeIndex = (gltf.nodes ?? []).findIndex(
      (node: Record<string, unknown>) => node.name === modification.node
    )
    if (nodeIndex < 0) {
      continue
    }

    const samplers = findSamplersForNode(gltf, nodeIndex)
    if (samplers.length !== modification.outputSamplers.length) {
      continue
    }

    for (let index = 0; index < samplers.length; index += 1) {
      const samplerData = modification.outputSamplers[index]
      if (!samplerData) {
        continue
      }
      const outputAccessor = gltf.accessors?.[samplers[index].output]
      if (!outputAccessor) {
        continue
      }
      buffer = replaceAccessorData(buffer, gltf, outputAccessor, samplerData)
    }
  }

  return buffer
}

function findSamplersForNode(gltf: Record<string, any>, nodeIndex: number): Record<string, any>[] {
  const samplers: Record<string, any>[] = []
  for (const animation of gltf.animations ?? []) {
    for (const channel of animation.channels ?? []) {
      if (channel.target?.node === nodeIndex) {
        samplers.push(animation.samplers[channel.sampler])
      }
    }
  }
  return samplers
}

function splitAnimations(gltfPath: string, splitData: ModelsJsonSplitAnimation): void {
  if (!splitData.animation || !splitData.newAnimations?.length) {
    return
  }

  const gltf = readJson(gltfPath)
  const animations = gltf.animations ?? []

  for (let index = 0; index < animations.length; index += 1) {
    const animation = animations[index]
    if (animation.name !== splitData.animation) {
      continue
    }

    animations.splice(index, 1)
    for (const newAnimationData of splitData.newAnimations) {
      const newAnimation = {
        name: newAnimationData.name,
        channels: newAnimationData.indices.map((oldIndex, newIndex) => ({
          ...cloneJson(animation.channels[oldIndex]),
          sampler: newIndex
        })),
        samplers: newAnimationData.indices.map(oldIndex =>
          cloneJson(animation.samplers[oldIndex])
        )
      }
      if (newAnimationData.targetNode) {
        const nodeIndex = (gltf.nodes ?? []).findIndex(
          (node: Record<string, unknown>) => node.name === newAnimationData.targetNode
        )
        if (nodeIndex >= 0) {
          for (const channel of newAnimation.channels) {
            channel.target = { ...channel.target, node: nodeIndex }
          }
        }
      }
      animations.push(newAnimation)
    }
    break
  }

  writeJson(gltfPath, gltf)
}

function addParentNode(gltfPath: string, node: ModelsJsonParentNode): void {
  if (!node.parent || !node.name) {
    return
  }

  const gltf = readJson(gltfPath)
  const parentIndex = (gltf.nodes ?? []).findIndex(
    (candidate: Record<string, unknown>) => candidate.name === node.parent
  )
  const childIndex = (gltf.nodes ?? []).findIndex(
    (candidate: Record<string, unknown>) => candidate.name === node.name
  )

  if (parentIndex < 0 || childIndex < 0) {
    return
  }

  const parentNode = gltf.nodes[parentIndex]
  parentNode.children ??= []
  parentNode.children.push(childIndex)

  writeJson(gltfPath, gltf)
}

function resolveMaterializedOutputPath(
  sourceModelRoot: string,
  materializedRoot: string,
  outputPath: string
): string | undefined {
  const absoluteOutputPath = resolve(sourceModelRoot, outputPath)
  const packagePath = extractPackageAssetPath(absoluteOutputPath)
  return packagePath ? resolve(materializedRoot, packagePath) : undefined
}

function extractPackageAssetPath(absolutePath: string): string | undefined {
  const portablePath = toPortablePath(absolutePath)
  const markerIndex = portablePath.indexOf('/SimObjects/')
  if (markerIndex < 0) {
    return undefined
  }
  return portablePath.slice(markerIndex + 1)
}

function parseLodNumber(filePath: string): number {
  const match = filePath.match(/LOD(\d\d?)/i)
  return match ? Number.parseInt(match[1], 10) : 0
}

function includesLod(value: unknown, lod: number): boolean {
  if (!Array.isArray(value)) {
    return true
  }
  return value.some(entry => Number(entry) === lod)
}

function findMeshIndexByName(gltf: Record<string, any>, meshName: unknown): number {
  if (typeof meshName === 'number') {
    return meshName
  }
  const meshIndex = (gltf.meshes ?? []).findIndex(
    (mesh: Record<string, unknown>) => mesh.name === meshName
  )
  return meshIndex >= 0 ? meshIndex : 0
}

function findMaterialIndexByName(gltf: Record<string, any>, materialName: unknown): number {
  if (typeof materialName === 'number') {
    return materialName
  }
  const materialIndex = (gltf.materials ?? []).findIndex(
    (material: Record<string, unknown>) => material.name === materialName
  )
  return materialIndex >= 0 ? materialIndex : 0
}

function ensureRootSceneNodes(gltf: Record<string, any>): number[] {
  gltf.scenes ??= [{ nodes: [] }]
  gltf.scenes[0] ??= { nodes: [] }
  gltf.scenes[0].nodes ??= []
  return gltf.scenes[0].nodes
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, any>
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value))
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function toPortablePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/')
}
