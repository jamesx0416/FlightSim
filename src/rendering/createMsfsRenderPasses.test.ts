import { expect, test } from 'bun:test'
import { MeshBasicMaterial } from 'three'

const gpuGlobals = globalThis as typeof globalThis & {
  GPUShaderStage?: { VERTEX: number; FRAGMENT: number; COMPUTE: number }
}
gpuGlobals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }

const {
  canKeepBlendGBufferDecalInForwardScenePass,
  canKeepReceiverlessBlendGBufferMaterialInBasePass,
  configureBlendGBufferMaterialsForDecalPass,
  hasBlendGBufferReceiver,
  selectMsfsDecalRenderPath
} = await import('./createMsfsRenderPasses')

test('selects regular, deferred, and compatibility decal paths', () => {
  expect(selectMsfsDecalRenderPath(false, false, true)).toBe('regular')
  expect(selectMsfsDecalRenderPath(true, true, true)).toBe('deferred')
  expect(selectMsfsDecalRenderPath(true, true, false)).toBe('forward')
  expect(selectMsfsDecalRenderPath(true, false, true)).toBe('forward')
})

test('uses deferred rendering for every projected receiver set', () => {
  expect(hasBlendGBufferReceiver(0)).toBe(false)
  expect(hasBlendGBufferReceiver(1)).toBe(true)
  expect(hasBlendGBufferReceiver(3)).toBe(true)
})

test('keeps only transparent colour decals in the normal scene pass', () => {
  const transparentColour = new MeshBasicMaterial({ transparent: true })
  transparentColour.userData.gltfExtensions = {
    ASOBO_material_blend_gbuffer: { baseColorBlendFactor: 1 }
  }
  const opaqueColour = transparentColour.clone()
  opaqueColour.transparent = false
  const transparentComponent = new MeshBasicMaterial({ transparent: true })
  transparentComponent.userData.gltfExtensions = {
    ASOBO_material_blend_gbuffer: {
      baseColorBlendFactor: 0,
      emissiveBlendFactor: 0,
    }
  }

  expect(canKeepBlendGBufferDecalInForwardScenePass([transparentColour])).toBe(true)
  expect(canKeepBlendGBufferDecalInForwardScenePass([opaqueColour])).toBe(false)
  expect(canKeepBlendGBufferDecalInForwardScenePass([transparentComponent])).toBe(false)
})

test('keeps receiverless colour decals in the base pass unless draw order requires projection', () => {
  const colour = new MeshBasicMaterial({ transparent: true })
  colour.userData.gltfExtensions = {
    ASOBO_material_blend_gbuffer: { baseColorBlendFactor: 1 }
  }
  const ordered = colour.clone()
  ordered.userData.gltfExtensions = {
    ...colour.userData.gltfExtensions,
    ASOBO_material_draw_order: { drawOrderOffset: 1 }
  }
  const componentOnly = new MeshBasicMaterial({ transparent: true })
  componentOnly.userData.gltfExtensions = {
    ASOBO_material_blend_gbuffer: {
      baseColorBlendFactor: 0,
      emissiveBlendFactor: 0,
    }
  }

  expect(canKeepReceiverlessBlendGBufferMaterialInBasePass(colour)).toBe(true)
  expect(canKeepReceiverlessBlendGBufferMaterialInBasePass(ordered)).toBe(false)
  expect(canKeepReceiverlessBlendGBufferMaterialInBasePass(componentOnly)).toBe(false)
})

test('keeps native depth testing for decal occlusion', () => {
  const material = new MeshBasicMaterial()
  material.depthTest = false
  material.depthWrite = true
  material.polygonOffset = true
  configureBlendGBufferMaterialsForDecalPass([material], new Map())

  expect(material.depthTest).toBe(true)
  expect(material.depthWrite).toBe(false)
  expect(material.polygonOffset).toBe(true)
})
