import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import {
  AnimationMixer,
  BufferAttribute,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  Scene,
  SkinnedMesh,
  Vector3,
  Vector4,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

// three.js FileLoader expects ProgressEvent in browser-like environments.
if (typeof (globalThis as typeof globalThis & { ProgressEvent?: typeof ProgressEvent }).ProgressEvent === 'undefined') {
  class NodeProgressEvent<T = unknown> {
    type: string
    lengthComputable: boolean
    loaded: number
    total: number
    target: T | null

    constructor(type: string, init?: { lengthComputable?: boolean; loaded?: number; total?: number }) {
      this.type = type
      this.lengthComputable = init?.lengthComputable ?? false
      this.loaded = init?.loaded ?? 0
      this.total = init?.total ?? 0
      this.target = null
    }
  }

  ;(globalThis as typeof globalThis & { ProgressEvent?: unknown }).ProgressEvent = NodeProgressEvent as any
}

if (typeof (globalThis as typeof globalThis & { FileReader?: typeof FileReader }).FileReader === 'undefined') {
  class NodeFileReader {
    result: string | ArrayBuffer | null = null
    onloadend: ((event: unknown) => void) | null = null

    async readAsDataURL(blob: Blob) {
      const buffer = Buffer.from(await blob.arrayBuffer())
      const mime = blob.type || 'application/octet-stream'
      this.result = `data:${mime};base64,${buffer.toString('base64')}`
      if (this.onloadend) {
        this.onloadend(new (globalThis as any).ProgressEvent('loadend', {
          lengthComputable: false,
          loaded: buffer.byteLength,
          total: buffer.byteLength,
        }))
      }
    }

    async readAsArrayBuffer(blob: Blob) {
      const arrayBuffer = await blob.arrayBuffer()
      this.result = arrayBuffer
      if (this.onloadend) {
        this.onloadend(new (globalThis as any).ProgressEvent('loadend', {
          lengthComputable: false,
          loaded: arrayBuffer.byteLength,
          total: arrayBuffer.byteLength,
        }))
      }
    }
  }

  ;(globalThis as typeof globalThis & { FileReader?: unknown }).FileReader = NodeFileReader as any
}

const INPUT_GLTF = 'src/model/a320-exterior/A320_NEO_LOD00.gltf'
const INPUT_BIN = 'src/model/a320-exterior/A320_NEO_LOD00.bin'
const FALLBACK_GLTF =
  'third_party/flybywire-aircraft/fbw-a32nx/src/model/a320-exterior/A320_NEO_LOD00.gltf'
const FALLBACK_BIN =
  'third_party/flybywire-aircraft/fbw-a32nx/src/model/a320-exterior/A320_NEO_LOD00.bin'
const OUTPUT_DIR = 'public/aircraft/a32nx/exterior/LOD00'
const OUTPUT_GLTF = resolve(OUTPUT_DIR, 'scene.gltf')
const OUTPUT_BIN = resolve(OUTPUT_DIR, 'scene.bin')

const EXT_PREFIXES = ['ASOBO_', 'MSFT_']

function stripPrefixedExtensions(obj: Record<string, unknown> | undefined) {
  if (!obj) return undefined
  for (const key of Object.keys(obj)) {
    if (EXT_PREFIXES.some(prefix => key.startsWith(prefix))) {
      delete obj[key]
    }
  }
  return Object.keys(obj).length > 0 ? obj : undefined
}

function filterExtensions(arr: string[] | undefined) {
  if (!arr) return undefined
  const filtered = arr.filter(name => !EXT_PREFIXES.some(prefix => name.startsWith(prefix)))
  return filtered.length > 0 ? filtered : undefined
}

function cleanMaterials(materials: Array<Record<string, unknown>> | undefined) {
  if (!materials) return
  for (const material of materials) {
    delete (material as Record<string, unknown>).normalTexture
    delete (material as Record<string, unknown>).occlusionTexture
    delete (material as Record<string, unknown>).emissiveTexture

    const pbr = (material as Record<string, unknown>).pbrMetallicRoughness as
      | Record<string, unknown>
      | undefined
    if (pbr) {
      delete pbr.baseColorTexture
      delete pbr.metallicRoughnessTexture
      if (Object.keys(pbr).length === 0) {
        delete (material as Record<string, unknown>).pbrMetallicRoughness
      }
    }

    delete (material as Record<string, unknown>).extensions
  }
}

function cleanGltfJson(rawJson: string, binData: Uint8Array) {
  const json = JSON.parse(rawJson)

  delete json.images
  delete json.textures
  delete json.samplers

  cleanMaterials(json.materials)

  json.extensionsUsed = filterExtensions(json.extensionsUsed)
  json.extensionsRequired = filterExtensions(json.extensionsRequired)
  json.extensions = stripPrefixedExtensions(json.extensions)

  if (Array.isArray(json.nodes)) {
    for (const node of json.nodes) {
      if (node && typeof node === 'object') {
        node.extensions = stripPrefixedExtensions(node.extensions)
        if (!node.extensions) delete node.extensions
      }
    }
  }

  if (!Array.isArray(json.buffers) || json.buffers.length === 0) {
    throw new Error('No buffers found in source glTF JSON')
  }

  const base64 = Buffer.from(binData).toString('base64')
  json.buffers[0].uri = `data:application/octet-stream;base64,${base64}`
  json.buffers[0].byteLength = binData.byteLength

  return json
}

function bakeSkinnedMesh(
  skinned: SkinnedMesh,
  options: { applyPose: boolean; recomputeInverses: boolean }
) {
  const geometry = skinned.geometry
  const position = geometry.attributes.position
  const skinIndex = geometry.attributes.skinIndex
  const skinWeight = geometry.attributes.skinWeight

  if (!position || !skinIndex || !skinWeight) {
    throw new Error(`SkinnedMesh ${skinned.name || '(unnamed)'} missing skin attributes`)
  }

  if (options.applyPose) {
    skinned.pose()
  }

  skinned.updateMatrixWorld(true)
  if (options.recomputeInverses) {
    skinned.skeleton.calculateInverses()
  }
  skinned.skeleton.update()
  skinned.normalizeSkinWeights()

  const bakedPositions = new Float32Array(position.count * 3)

  const basePosition = new Vector3()
  const fallbackPosition = new Vector3()
  const skinnedPosition = new Vector3()
  const temp = new Vector3()
  const skinIndices = new Vector4()
  const skinWeights = new Vector4()
  const boneMatrix = new Matrix4()
  const boneCount = skinned.skeleton.bones.length

  const bindMatrix = skinned.bindMatrix
  const bindMatrixInverse = skinned.bindMatrixInverse
  const boneMatrices = skinned.skeleton.boneMatrices

  for (let i = 0; i < position.count; i++) {
    basePosition.fromBufferAttribute(position, i)
    if (!Number.isFinite(basePosition.x) || !Number.isFinite(basePosition.y) || !Number.isFinite(basePosition.z)) {
      basePosition.set(0, 0, 0)
    }
    fallbackPosition.copy(basePosition)
    basePosition.applyMatrix4(bindMatrix)

    skinIndices.fromBufferAttribute(skinIndex, i)
    skinWeights.fromBufferAttribute(skinWeight, i)

    skinnedPosition.set(0, 0, 0)

    for (let j = 0; j < 4; j++) {
      const weight = skinWeights.getComponent(j)
      if (!Number.isFinite(weight) || weight === 0) continue
      const boneIndex = Math.round(skinIndices.getComponent(j))
      if (!Number.isFinite(boneIndex) || boneIndex < 0 || boneIndex >= boneCount) continue
      boneMatrix.fromArray(boneMatrices, boneIndex * 16)
      temp.copy(basePosition).applyMatrix4(boneMatrix).multiplyScalar(weight)
      skinnedPosition.add(temp)
    }

    skinnedPosition.applyMatrix4(bindMatrixInverse)

    if (!Number.isFinite(skinnedPosition.x) || !Number.isFinite(skinnedPosition.y) || !Number.isFinite(skinnedPosition.z)) {
      skinnedPosition.copy(fallbackPosition)
    }

    const offset = i * 3
    bakedPositions[offset + 0] = skinnedPosition.x
    bakedPositions[offset + 1] = skinnedPosition.y
    bakedPositions[offset + 2] = skinnedPosition.z
  }

  const bakedGeometry = geometry.clone()
  bakedGeometry.setAttribute('position', new BufferAttribute(bakedPositions, 3))

  for (const name of Object.keys(bakedGeometry.attributes)) {
    if (name === 'skinIndex' || name === 'skinWeight') {
      bakedGeometry.deleteAttribute(name)
      continue
    }
    if (name.toLowerCase().includes('color')) {
      bakedGeometry.deleteAttribute(name)
    }
  }

  bakedGeometry.computeVertexNormals()
  bakedGeometry.computeBoundingBox()
  bakedGeometry.computeBoundingSphere()

  const bakedMesh = new Mesh(bakedGeometry, skinned.material)
  bakedMesh.name = skinned.name
  bakedMesh.position.copy(skinned.position)
  bakedMesh.quaternion.copy(skinned.quaternion)
  bakedMesh.scale.copy(skinned.scale)
  bakedMesh.matrix.copy(skinned.matrix)
  bakedMesh.matrixWorld.copy(skinned.matrixWorld)
  bakedMesh.matrixAutoUpdate = skinned.matrixAutoUpdate
  bakedMesh.visible = skinned.visible
  bakedMesh.castShadow = skinned.castShadow
  bakedMesh.receiveShadow = skinned.receiveShadow
  bakedMesh.renderOrder = skinned.renderOrder
  bakedMesh.userData = { ...skinned.userData }

  return bakedMesh
}

function deinterleaveAttribute(attr: BufferAttribute | InterleavedBufferAttribute) {
  if (!(attr as InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    return attr as BufferAttribute
  }

  const arr = new Float32Array(attr.count * attr.itemSize)
  for (let i = 0; i < attr.count; i++) {
    if (attr.itemSize > 0) arr[i * attr.itemSize + 0] = attr.getX(i)
    if (attr.itemSize > 1) arr[i * attr.itemSize + 1] = attr.getY(i)
    if (attr.itemSize > 2) arr[i * attr.itemSize + 2] = attr.getZ(i)
    if (attr.itemSize > 3) arr[i * attr.itemSize + 3] = attr.getW(i)
  }

  const result = new BufferAttribute(arr, attr.itemSize, attr.normalized)
  result.setUsage(attr.usage)
  result.name = attr.name
  return result
}

async function exportScene(scene: Scene) {
  const exporter = new GLTFExporter()

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    exporter.parse(
      scene,
      output => resolve(output as Record<string, unknown>),
      error => reject(error),
      {
        binary: false,
        onlyVisible: false,
        includeCustomExtensions: false,
      }
    )
  })

  const buffers = result.buffers as Array<{ uri?: string; byteLength?: number }> | undefined
  if (!buffers || buffers.length === 0 || typeof buffers[0].uri !== 'string') {
    throw new Error('Exporter did not produce a buffer URI')
  }

  const uri = buffers[0].uri
  if (!uri.startsWith('data:')) {
    throw new Error('Expected embedded data URI from GLTFExporter')
  }

  const base64 = uri.split(',')[1]
  if (!base64) {
    throw new Error('Missing base64 payload from buffer URI')
  }

  const bin = Buffer.from(base64, 'base64')
  buffers[0].uri = 'scene.bin'
  buffers[0].byteLength = bin.byteLength

  await mkdir(dirname(OUTPUT_GLTF), { recursive: true })
  await writeFile(OUTPUT_BIN, bin)
  await writeFile(OUTPUT_GLTF, JSON.stringify(result, null, 2))
}

async function resolveInputPath(primary: string, fallback: string) {
  try {
    await readFile(primary)
    return primary
  } catch {
    await readFile(fallback)
    return fallback
  }
}

async function main() {
  const [gltfPath, binPath] = await Promise.all([
    resolveInputPath(INPUT_GLTF, FALLBACK_GLTF),
    resolveInputPath(INPUT_BIN, FALLBACK_BIN),
  ])

  const [gltfRaw, binRaw] = await Promise.all([readFile(gltfPath, 'utf8'), readFile(binPath)])

  const cleanedJson = cleanGltfJson(gltfRaw, binRaw)

  const loader = new GLTFLoader()
  const { scene, animations } = await new Promise<{ scene: Scene; animations: unknown[] }>(
    (resolve, reject) => {
    loader.parse(JSON.stringify(cleanedJson), '', gltf => resolve(gltf), reject)
  })

  if (animations && animations.length > 0) {
    const mixer = new AnimationMixer(scene)
    for (const clip of animations as any[]) {
      const action = mixer.clipAction(clip)
      action.play()
    }
    mixer.setTime(0)
    mixer.update(0)
  }

  scene.updateMatrixWorld(true)

  const skinnedMeshes: SkinnedMesh[] = []
  scene.traverse(object => {
    if ((object as SkinnedMesh).isSkinnedMesh) {
      skinnedMeshes.push(object as SkinnedMesh)
    }
  })

  for (const skinned of skinnedMeshes) {
    const baked = bakeSkinnedMesh(skinned, { applyPose: false, recomputeInverses: false })
    const parent = skinned.parent ?? scene
    parent.add(baked)
    parent.remove(skinned)
  }

  scene.updateMatrixWorld(true)

  scene.traverse(object => {
    if ((object as Mesh).isMesh) {
      const mesh = object as Mesh
      const geometry = mesh.geometry
      for (const name of Object.keys(geometry.attributes)) {
        const attr = geometry.attributes[name] as BufferAttribute | InterleavedBufferAttribute
        const deinterleaved = deinterleaveAttribute(attr)
        if (deinterleaved !== attr) {
          geometry.setAttribute(name, deinterleaved)
        }
      }

      if (geometry.morphAttributes) {
        for (const key of Object.keys(geometry.morphAttributes)) {
          const attrs = geometry.morphAttributes[key]
          if (!attrs) continue
          geometry.morphAttributes[key] = attrs.map(attr =>
            deinterleaveAttribute(attr as BufferAttribute | InterleavedBufferAttribute)
          )
        }
      }
    }
  })

  scene.updateMatrixWorld(true)
  await exportScene(scene)

  console.log('Export complete:', OUTPUT_GLTF)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
