import {
  AnimationMixer,
  DataUtils,
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
import type { AircraftVisualState } from '../entities/Plane'

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
    action.paused = true
    action.setEffectiveTimeScale(0)
    action.setEffectiveWeight(1)
    const name = typeof clip?.name === 'string' && clip.name.length > 0
      ? clip.name
      : `clip_${index}`
    actions.set(name, action)
  })

  mixer.setTime(0)
  mixer.update(0)

  return { mixer, actions }
}

export function hasNativeAircraftAnimations(state: MsfsAnimationState): boolean {
  return state.actions.has('l_aileron_percent_key') || state.actions.has('elevator_percent_key')
}

export function applyMsfsAircraftAnimationState(
  state: MsfsAnimationState,
  visualState: AircraftVisualState,
  wheelCycle01: number
): void {
  if (!state.mixer) return

  setSignedClipValue(state.actions.get('elevator_percent_key'), visualState.elevator)
  setSignedClipValue(state.actions.get('rudder_percent_key'), visualState.rudder)
  setSignedClipValue(state.actions.get('l_aileron_percent_key'), -visualState.aileron)
  setSignedClipValue(state.actions.get('r_aileron_percent_key'), visualState.aileron)

  setUnsignedClipValue(state.actions.get('l_flap_percent_key'), visualState.flaps01)
  setUnsignedClipValue(state.actions.get('r_flap_percent_key'), visualState.flaps01)
  setUnsignedClipValue(state.actions.get('l_slat_percent_key'), visualState.flaps01)
  setUnsignedClipValue(state.actions.get('r_slat_percent_key'), visualState.flaps01)

  const leftRollSpoiler = Math.max(0, -visualState.aileron) * 0.45
  const rightRollSpoiler = Math.max(0, visualState.aileron) * 0.45
  setUnsignedClipValue(
    state.actions.get('l_spoiler_key'),
    Math.max(visualState.spoiler01, leftRollSpoiler)
  )
  setUnsignedClipValue(
    state.actions.get('r_spoiler_key'),
    Math.max(visualState.spoiler01, rightRollSpoiler)
  )

  const gearValue = clamp01(visualState.gear01)
  setUnsignedClipValue(state.actions.get('c_gear'), gearValue)
  setUnsignedClipValue(state.actions.get('l_gear'), gearValue)
  setUnsignedClipValue(state.actions.get('r_gear'), gearValue)
  setUnsignedClipValue(state.actions.get('c_gear_door1'), gearValue)
  setUnsignedClipValue(state.actions.get('c_gear_door2'), gearValue)
  setUnsignedClipValue(state.actions.get('l_gear_door'), gearValue)
  setUnsignedClipValue(state.actions.get('r_gear_door'), gearValue)

  const tireValue = clamp01(wheelCycle01)
  setUnsignedClipValue(state.actions.get('c_tire_anim'), tireValue)
  setUnsignedClipValue(state.actions.get('l_tire_anim'), tireValue)
  setUnsignedClipValue(state.actions.get('r_tire_anim'), tireValue)
  setUnsignedClipValue(state.actions.get('c_wheel'), tireValue)
  setUnsignedClipValue(state.actions.get('l_wheel'), tireValue)
  setUnsignedClipValue(state.actions.get('r_wheel'), tireValue)

  state.mixer.update(0)
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
        const converted = toFloatAttribute(attr, name)
        if (converted) geometry.setAttribute(name, converted)
      }
    }
    if (geometry?.morphAttributes) {
      for (const name of Object.keys(geometry.morphAttributes)) {
        const attrs = geometry.morphAttributes[name]
        if (!Array.isArray(attrs)) continue
        for (let i = 0; i < attrs.length; i++) {
          const converted = toFloatAttribute(attrs[i], name)
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
      const materialCode =
        typeof materialDef?.extras?.ASOBO_material_code === 'string'
          ? materialDef.extras.ASOBO_material_code
          : undefined

      if (materialCode) {
        material.userData.asoboMaterialCode = materialCode
        mesh.userData.asoboMaterialCode = materialCode
      }

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

function toFloatAttribute(attr: any, semanticName = ''): Float32BufferAttribute | null {
  if (!attr) return null

  const array = attr.isInterleavedBufferAttribute
    ? attr.data?.array
    : attr.array
  if (!array) return null

  const isTexcoord = semanticName.toLowerCase().includes('uv')
  const needsTexcoordDecode = isTexcoord && texcoordNeedsHalfFloatDecode(attr)

  const isFloat32 =
    array instanceof Float32Array && !attr.normalized && !attr.isInterleavedBufferAttribute
  if (isFloat32 && !needsTexcoordDecode) return null

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
  } else if (needsTexcoordDecode) {
    for (let i = 0; i < count; i++) {
      if (itemSize > 0) out[i * itemSize + 0] = DataUtils.fromHalfFloat(attr.getX(i) & 0xffff)
      if (itemSize > 1) out[i * itemSize + 1] = DataUtils.fromHalfFloat(attr.getY(i) & 0xffff)
      if (itemSize > 2) out[i * itemSize + 2] = DataUtils.fromHalfFloat(attr.getZ(i) & 0xffff)
      if (itemSize > 3) out[i * itemSize + 3] = DataUtils.fromHalfFloat(attr.getW(i) & 0xffff)
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

function setSignedClipValue(action: AnimationAction | undefined, value: number): void {
  if (!action) return
  const normalized = clamp01(value * 0.5 + 0.5)
  setActionTime(action, normalized)
}

function setUnsignedClipValue(action: AnimationAction | undefined, value: number): void {
  if (!action) return
  setActionTime(action, clamp01(value))
}

function setActionTime(action: AnimationAction, normalized: number): void {
  const duration = action.getClip().duration
  action.time = duration * normalized
  action.paused = true
}

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function texcoordNeedsHalfFloatDecode(attr: any): boolean {
  const sampleCount = Math.min(attr.count ?? 0, 8)
  for (let i = 0; i < sampleCount; i++) {
    const x = attr.getX(i)
    const y = attr.getY(i)
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      (Math.abs(x) > 1 || Math.abs(y) > 1)
    ) {
      return true
    }
  }
  return false
}
