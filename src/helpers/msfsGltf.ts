import {
  AnimationMixer,
  type AnimationAction,
  Float32BufferAttribute,
  Mesh,
  type Object3D
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import type { WebGLRenderer } from 'three'
import type { WebGPURenderer } from 'three/webgpu'

const EXT_MSFT_TEXTURE_DDS = 'MSFT_texture_dds'
const EXT_ASOBO_NORMAL_MAP_CONVENTION = 'ASOBO_normal_map_convention'
const EXT_ASOBO_MATERIAL_DRAW_ORDER = 'ASOBO_material_draw_order'
const EXT_ASOBO_MATERIAL_INVISIBLE = 'ASOBO_material_invisible'
const EXT_ASOBO_MATERIAL_DETAIL_MAP = 'ASOBO_material_detail_map'
const EXT_ASOBO_MATERIAL_BLEND_GBUFFER = 'ASOBO_material_blend_gbuffer'
const EXT_ASOBO_TAGS = 'ASOBO_tags'

class GLTFMSFTTextureDDSExtension {
  name = EXT_MSFT_TEXTURE_DDS
  private readonly parser: any
  private readonly ddsLoader: DDSLoader
  private readonly availableTextures?: Set<string>

  constructor(parser: any, ddsLoader: DDSLoader, availableTextures?: Set<string>) {
    this.parser = parser
    this.ddsLoader = ddsLoader
    this.availableTextures = availableTextures
  }

  loadTexture(textureIndex: number) {
    const parser = this.parser
    const json = parser.json as any
    const textureDef = json.textures?.[textureIndex]

    if (!textureDef?.extensions?.[this.name]) {
      return null
    }

    const extension = textureDef.extensions[this.name]
    if (!extension || extension.source == null) {
      return null
    }

    const sourceDef = json.images?.[extension.source]
    const uri = sourceDef?.uri
    if (this.availableTextures && uri && !this.availableTextures.has(uri)) {
      return Promise.resolve(null)
    }

    if (parser.options?.path) {
      this.ddsLoader.setPath(parser.options.path)
    }

    return parser
      .loadTextureImage(textureIndex, extension.source, this.ddsLoader)
      .catch(() => null)
  }
}

export interface MsfsAnimationState {
  mixer: AnimationMixer | null
  actions: Map<string, AnimationAction>
}

export function createMsfsGltfLoader(
  renderer: WebGLRenderer | WebGPURenderer,
  options?: {
    availableTextures?: Set<string>
  }
): GLTFLoader {
  const loader = new GLTFLoader()
  const ddsLoader = new DDSLoader()
  const ktx2Loader = new KTX2Loader()
  ktx2Loader.setTranscoderPath('/basis/')
  ktx2Loader.detectSupport(renderer)

  loader.register(
    parser =>
      new GLTFMSFTTextureDDSExtension(
        parser,
        ddsLoader,
        options?.availableTextures
      )
  )
  loader.setKTX2Loader(ktx2Loader)

  return loader
}

export function setupMsfsAnimations(gltf: any): MsfsAnimationState {
  const animations = gltf.animations as any[] | undefined
  if (!animations || animations.length === 0) {
    return { mixer: null, actions: new Map() }
  }

  const mixer = new AnimationMixer(gltf.scene as Object3D)
  const actions = new Map<string, AnimationAction>()

  animations.forEach((clip, index) => {
    const action = mixer.clipAction(clip)
    action.play()
    const name = typeof clip?.name === 'string' && clip.name.length > 0
      ? clip.name
      : `clip_${index}`
    actions.set(name, action)
  })

  mixer.setTime(0)
  mixer.update(0)

  return { mixer, actions }
}

export function applyMsfsExtensions(gltf: any): void {
  const parser = gltf.parser
  if (!parser?.json) return

  const json = parser.json as any
  const materialDefs = (json.materials ?? []) as any[]
  const associations: Map<any, any> = parser.associations

  const normalConvention = json.extensions?.[EXT_ASOBO_NORMAL_MAP_CONVENTION]
  const usesDirectXNormals =
    normalConvention?.tangent_space_convention === 'DirectX'

  gltf.scene.traverse((object: Object3D) => {
    if (!(object as Mesh).isMesh) return

    const mesh = object as Mesh
    const geometry = mesh.geometry
    if (geometry?.attributes) {
      for (const name of Object.keys(geometry.attributes)) {
        if (name.toLowerCase().includes('color')) {
          geometry.deleteAttribute(name)
        }
      }
      for (const name of Object.keys(geometry.attributes)) {
        const attr = geometry.attributes[name]
        const converted = toFloatAttribute(attr)
        if (converted) geometry.setAttribute(name, converted)
      }
    }
    if (geometry?.morphAttributes) {
      for (const name of Object.keys(geometry.morphAttributes)) {
        const attrs = geometry.morphAttributes[name]
        if (!Array.isArray(attrs)) continue
        for (let i = 0; i < attrs.length; i++) {
          const converted = toFloatAttribute(attrs[i])
          if (converted) attrs[i] = converted
        }
      }
    }
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material]

    let drawOrderOffset = 0
    let isInvisible = false

    for (const material of materials) {
      if (!material) continue

      if (usesDirectXNormals && 'normalMap' in material && material.normalMap) {
        if ('normalScale' in material && material.normalScale) {
          material.normalScale.y *= -1
          material.needsUpdate = true
        }
      }

      const association = associations?.get(material)
      const materialIndex = association?.materials
      const materialDef =
        materialIndex != null ? materialDefs[materialIndex] : undefined
      const extensions = materialDef?.extensions
      if (!extensions) continue

      if (extensions[EXT_ASOBO_MATERIAL_DRAW_ORDER]?.drawOrderOffset != null) {
        drawOrderOffset = Math.max(
          drawOrderOffset,
          extensions[EXT_ASOBO_MATERIAL_DRAW_ORDER].drawOrderOffset
        )
      }

      if (extensions[EXT_ASOBO_MATERIAL_INVISIBLE] != null) {
        isInvisible = true
      }

      const tags = extensions[EXT_ASOBO_TAGS]?.tags
      if (Array.isArray(tags)) {
        material.userData.asoboTags = tags
        mesh.userData.asoboTags = tags
      }

      if (extensions[EXT_ASOBO_MATERIAL_DETAIL_MAP]) {
        material.userData.asoboDetailMap =
          extensions[EXT_ASOBO_MATERIAL_DETAIL_MAP]
        mesh.userData.asoboDetailMap =
          extensions[EXT_ASOBO_MATERIAL_DETAIL_MAP]
      }

      if (extensions[EXT_ASOBO_MATERIAL_BLEND_GBUFFER]) {
        material.userData.asoboBlendGBuffer =
          extensions[EXT_ASOBO_MATERIAL_BLEND_GBUFFER]
        mesh.userData.asoboBlendGBuffer =
          extensions[EXT_ASOBO_MATERIAL_BLEND_GBUFFER]
      }
    }

    if (drawOrderOffset !== 0) {
      mesh.renderOrder += drawOrderOffset
    }

    if (isInvisible) {
      mesh.userData.asoboInvisible = true
    }
  })
}

function toFloatAttribute(attr: any): Float32BufferAttribute | null {
  if (!attr) return null

  const array = attr.isInterleavedBufferAttribute
    ? attr.data?.array
    : attr.array
  if (!array) return null

  const isFloat32 =
    array instanceof Float32Array && !attr.normalized && !attr.isInterleavedBufferAttribute
  if (isFloat32) return null

  const itemSize = attr.itemSize
  const count = attr.count
  const out = new Float32Array(count * itemSize)

  const isInt =
    array instanceof Int8Array ||
    array instanceof Uint8Array ||
    array instanceof Int16Array ||
    array instanceof Uint16Array ||
    array instanceof Int32Array ||
    array instanceof Uint32Array

  if (attr.normalized && isInt) {
    const bits = array.BYTES_PER_ELEMENT * 8
    const signed = array instanceof Int8Array || array instanceof Int16Array || array instanceof Int32Array
    const denom = signed ? (2 ** (bits - 1) - 1) : (2 ** bits - 1)
    for (let i = 0; i < count; i++) {
      if (itemSize > 0) out[i * itemSize + 0] = clampNorm(attr.getX(i), denom, signed)
      if (itemSize > 1) out[i * itemSize + 1] = clampNorm(attr.getY(i), denom, signed)
      if (itemSize > 2) out[i * itemSize + 2] = clampNorm(attr.getZ(i), denom, signed)
      if (itemSize > 3) out[i * itemSize + 3] = clampNorm(attr.getW(i), denom, signed)
    }
  } else {
    for (let i = 0; i < count; i++) {
      if (itemSize > 0) out[i * itemSize + 0] = attr.getX(i)
      if (itemSize > 1) out[i * itemSize + 1] = attr.getY(i)
      if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i)
      if (itemSize > 3) out[i * itemSize + 3] = attr.getW(i)
    }
  }

  return new Float32BufferAttribute(out, itemSize)
}

function clampNorm(value: number, denom: number, signed: boolean): number {
  if (signed) {
    const v = value / denom
    if (v > 1) return 1
    if (v < -1) return -1
    return v
  }
  return value / denom
}
