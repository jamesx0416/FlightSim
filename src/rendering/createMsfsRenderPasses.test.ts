import { expect, test } from 'bun:test'
import { MeshBasicMaterial } from 'three'

const gpuGlobals = globalThis as typeof globalThis & {
  GPUShaderStage?: { VERTEX: number; FRAGMENT: number; COMPUTE: number }
}
gpuGlobals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }

const {
  canKeepBlendGBufferDecalInForwardScenePass,
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

test('keeps hardware depth testing enabled when using the decal depth mask', () => {
  const material = new MeshBasicMaterial()
  material.depthTest = false
  material.depthWrite = true
  material.polygonOffset = true
  material.userData.msfsBlendGBufferDepthMask = true

  configureBlendGBufferMaterialsForDecalPass([material], new Map(), true)

  expect(material.depthTest).toBe(true)
  expect(material.depthWrite).toBe(false)
  expect(material.polygonOffset).toBe(false)
})
