import {
  AnimationClip,
  Bone,
  BufferGeometry,
  Group,
  InterpolateDiscrete,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Object3D,
  PropertyBinding,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
  type KeyframeTrack
} from 'three'
import { compileMsfs2020Behaviors } from '../../msfs/behavior'
import { importBuiltMsfs2020Package } from '../../msfs/importer'
import { AircraftRuntime, SharedMsfsRuntimeHost } from '../../msfs/runtime'
import type { CompiledBehaviorSet, ImportedAircraft, ModelLodEntry } from '../../msfs/types'
import {
  runAircraftRuntimeBenchmark,
  type AircraftRuntimeBenchmarkOptions,
  type AircraftRuntimeBenchmarkResult
} from './aircraftRuntimeBenchmark'
import { selectBenchmarkAircraft } from './selectBenchmarkAircraft'

type GltfAccessor = {
  readonly bufferView?: number
  readonly byteOffset?: number
  readonly componentType: number
  readonly count: number
  readonly type: string
}

type GltfDocument = {
  readonly accessors?: readonly GltfAccessor[]
  readonly animations?: readonly {
    readonly name?: string
    readonly channels: readonly {
      readonly sampler: number
      readonly target: { readonly node?: number; readonly path: string }
    }[]
    readonly samplers: readonly {
      readonly input: number
      readonly output: number
      readonly interpolation?: string
    }[]
  }[]
  readonly buffers?: readonly { readonly uri?: string; readonly byteLength: number }[]
  readonly bufferViews?: readonly {
    readonly buffer: number
    readonly byteOffset?: number
    readonly byteLength: number
    readonly byteStride?: number
  }[]
  readonly materials?: readonly {
    readonly name?: string
    readonly emissiveFactor?: readonly [number, number, number]
  }[]
  readonly meshes?: readonly {
    readonly primitives: readonly { readonly material?: number }[]
  }[]
  readonly nodes?: readonly {
    readonly name?: string
    readonly children?: readonly number[]
    readonly mesh?: number
    readonly matrix?: readonly number[]
    readonly rotation?: readonly [number, number, number, number]
    readonly scale?: readonly [number, number, number]
    readonly translation?: readonly [number, number, number]
  }[]
  readonly scenes?: readonly { readonly nodes?: readonly number[] }[]
  readonly scene?: number
  readonly skins?: readonly { readonly joints: readonly number[] }[]
}

export type BunAircraftRuntimeBenchmarkOptions = AircraftRuntimeBenchmarkOptions & {
  readonly packageRoot: string
  readonly additionalPackageRoots?: readonly string[]
  readonly aircraftId?: string
  readonly compiledBehaviors?: CompiledBehaviorSet
}

export type BunAircraftRuntimeBenchmarkResult = {
  readonly aircraftId: string
  readonly setupMs: number
  readonly model: {
    readonly nodeCount: number
    readonly clipCount: number
  }
  readonly benchmark: AircraftRuntimeBenchmarkResult
}

const COMPONENT_ARRAYS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array
} as const

const TYPE_COMPONENT_COUNTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16
}

type ComponentType = keyof typeof COMPONENT_ARRAYS

function firstLod(model: ImportedAircraft['model']): ModelLodEntry | null {
  return model?.lods[0] ?? null
}

async function readBuffer(uri: string | undefined, byteLength: number, modelUrl: string): Promise<ArrayBuffer> {
  if (uri == null) {
    throw new Error(`Binary GLB buffers are not supported by the no-render adapter: ${modelUrl}`)
  }
  const response = await fetch(new URL(uri, modelUrl))
  if (!response.ok) {
    throw new Error(`Could not load glTF buffer ${uri}: ${response.status} ${response.statusText}`)
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength < byteLength) {
    throw new Error(`glTF buffer ${uri} is shorter than declared.`)
  }
  return buffer
}

function readAccessor(document: GltfDocument, buffers: readonly ArrayBuffer[], accessorIndex: number): Float32Array {
  const accessor = document.accessors?.[accessorIndex]
  const view = accessor?.bufferView == null ? null : document.bufferViews?.[accessor.bufferView]
  if (accessor == null || view == null) {
    throw new Error(`Animation accessor ${accessorIndex} has no buffer view.`)
  }
  const componentType = accessor.componentType as ComponentType
  const ArrayType = COMPONENT_ARRAYS[componentType]
  const componentCount = TYPE_COMPONENT_COUNTS[accessor.type]
  const source = buffers[view.buffer]
  if (ArrayType == null || componentCount == null || source == null) {
    throw new Error(`Animation accessor ${accessorIndex} uses an unsupported format.`)
  }

  const componentBytes = ArrayType.BYTES_PER_ELEMENT
  const packedStride = componentCount * componentBytes
  const stride = view.byteStride ?? packedStride
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const values = new Float32Array(accessor.count * componentCount)
  const data = new DataView(source)
  const readers: Readonly<Record<ComponentType, (offset: number) => number>> = {
    5120: offset => data.getInt8(offset),
    5121: offset => data.getUint8(offset),
    5122: offset => data.getInt16(offset, true),
    5123: offset => data.getUint16(offset, true),
    5125: offset => data.getUint32(offset, true),
    5126: offset => data.getFloat32(offset, true)
  }
  const read = readers[componentType]
  for (let item = 0; item < accessor.count; item += 1) {
    for (let component = 0; component < componentCount; component += 1) {
      values[item * componentCount + component] = read(byteOffset + item * stride + component * componentBytes)
    }
  }
  return values
}

function createTrack(
  name: string,
  path: string,
  times: Float32Array,
  values: Float32Array,
  interpolation: string | undefined
): KeyframeTrack | null {
  const discrete = interpolation === 'STEP' ? InterpolateDiscrete : undefined
  if (path === 'rotation') return new QuaternionKeyframeTrack(`${name}.quaternion`, times, values, discrete)
  if (path === 'translation') return new VectorKeyframeTrack(`${name}.position`, times, values, discrete)
  if (path === 'scale') return new VectorKeyframeTrack(`${name}.scale`, times, values, discrete)
  if (path === 'weights') return new NumberKeyframeTrack(`${name}.morphTargetInfluences`, times, values, discrete)
  return null
}

async function loadRuntimeModel(url: string): Promise<{ readonly scene: Object3D; readonly clips: readonly AnimationClip[] }> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load glTF ${url}: ${response.status} ${response.statusText}`)
  const document = await response.json() as GltfDocument
  const buffers = await Promise.all((document.buffers ?? []).map(buffer => readBuffer(buffer.uri, buffer.byteLength, url)))
  const jointIndices = new Set((document.skins ?? []).flatMap(skin => skin.joints))
  const nodes = (document.nodes ?? []).map((definition, index) => {
    const meshDefinition = definition.mesh == null ? null : document.meshes?.[definition.mesh]
    const primitive = meshDefinition?.primitives[0]
    const materialDefinition = primitive?.material == null ? null : document.materials?.[primitive.material]
    const material = new MeshStandardMaterial({ name: materialDefinition?.name ?? '' })
    if (materialDefinition?.emissiveFactor != null) {
      material.emissive.fromArray(materialDefinition.emissiveFactor)
    }
    const node = meshDefinition == null || meshDefinition.primitives.length !== 1
      ? jointIndices.has(index) ? new Bone() : new Object3D()
      : new Mesh(new BufferGeometry(), material)
    if (meshDefinition != null && meshDefinition.primitives.length > 1) {
      for (const meshPrimitive of meshDefinition.primitives) {
        const primitiveMaterialDefinition = meshPrimitive.material == null
          ? null
          : document.materials?.[meshPrimitive.material]
        const primitiveMaterial = new MeshStandardMaterial({ name: primitiveMaterialDefinition?.name ?? '' })
        if (primitiveMaterialDefinition?.emissiveFactor != null) {
          primitiveMaterial.emissive.fromArray(primitiveMaterialDefinition.emissiveFactor)
        }
        node.add(new Mesh(new BufferGeometry(), primitiveMaterial))
      }
    }
    node.name = PropertyBinding.sanitizeNodeName(definition.name ?? `node_${index}`)
    if (definition.matrix != null) {
      node.matrix.fromArray(definition.matrix)
      node.matrix.decompose(node.position, node.quaternion, node.scale)
    } else {
      if (definition.translation != null) node.position.fromArray(definition.translation)
      if (definition.rotation != null) node.quaternion.fromArray(definition.rotation)
      if (definition.scale != null) node.scale.fromArray(definition.scale)
    }
    return node
  })

  for (const [index, definition] of (document.nodes ?? []).entries()) {
    for (const child of definition.children ?? []) nodes[index]?.add(nodes[child]!)
  }
  const root = new Group()
  const scene = document.scenes?.[document.scene ?? 0]
  for (const index of scene?.nodes ?? []) root.add(nodes[index]!)

  const clips = (document.animations ?? []).map((animation, animationIndex) => {
    const tracks = animation.channels.flatMap(channel => {
      const sampler = animation.samplers[channel.sampler]
      const node = channel.target.node == null ? null : nodes[channel.target.node]
      if (sampler == null || node == null) return []
      const track = createTrack(
        node.name,
        channel.target.path,
        readAccessor(document, buffers, sampler.input),
        readAccessor(document, buffers, sampler.output),
        sampler.interpolation
      )
      return track == null ? [] : [track]
    })
    return new AnimationClip(animation.name ?? `animation_${animationIndex}`, -1, tracks)
  })
  return { scene: root, clips }
}

/** Builds the normal package/runtime stack, but replaces renderable glTF assets with transform-only equivalents. */
export async function runBunAircraftRuntimeBenchmark(
  options: BunAircraftRuntimeBenchmarkOptions
): Promise<BunAircraftRuntimeBenchmarkResult> {
  const startedAt = performance.now()
  const pkg = await importBuiltMsfs2020Package(options.packageRoot, {
    requestedAircraftId: options.aircraftId,
    additionalPackageRoots: options.additionalPackageRoots
  })
  const aircraft = selectBenchmarkAircraft(pkg.aircraft, options.aircraftId)
  const compiled = options.compiledBehaviors == null
    ? await compileMsfs2020Behaviors(pkg, aircraft, {
        includeInteriorModel: true,
        additionalPackageRoots: options.additionalPackageRoots
      })
    : options.compiledBehaviors
  if (compiled.aircraftId !== aircraft.id) {
    throw new Error(`Compiled behavior aircraft ${compiled.aircraftId} does not match ${aircraft.id}.`)
  }
  const lods = [firstLod(aircraft.model), firstLod(aircraft.interiorModel)].filter(
    (lod): lod is ModelLodEntry => lod != null
  )
  const models = await Promise.all(lods.map(lod => loadRuntimeModel(lod.url)))
  const scene = new Group()
  for (const model of models) scene.add(model.scene)
  const clips = models.flatMap(model => model.clips)
  const host = new SharedMsfsRuntimeHost([...compiled.diagnostics], aircraft)
  const runtime = new AircraftRuntime(
    compiled,
    scene,
    host,
    aircraft,
    host.simulatorEngine.getAircraft(),
    host.simulatorEngine
  )
  runtime.bindAnimations(clips)

  let nodeCount = 0
  scene.traverse(() => { nodeCount += 1 })
  const setupMs = performance.now() - startedAt
  const benchmark = runAircraftRuntimeBenchmark(runtime, options, {
    additionalChecksumState: () => host.getSnapshot()
  })
  return {
    aircraftId: aircraft.id,
    setupMs,
    model: { nodeCount, clipCount: clips.length },
    benchmark
  }
}
