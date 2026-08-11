import { expect, test } from 'bun:test'
import {
  DepthFormat,
  HalfFloatType,
  NoColorSpace,
  UnsignedByteType,
  Vector2
} from 'three'

const gpuGlobals = globalThis as typeof globalThis & {
  GPUShaderStage?: { VERTEX: number; FRAGMENT: number; COMPUTE: number }
}
gpuGlobals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }

const {
  AIRCRAFT_GBUFFER_BYTES_PER_SAMPLE,
  createAircraftGBuffer
} = await import('./createAircraftGBuffer')

test('uses the compact mixed-format aircraft G-buffer layout', () => {
  const renderer = {
    samples: 4,
    getDrawingBufferSize(target: Vector2): Vector2 {
      return target.set(640, 360)
    }
  }
  const gBuffer = createAircraftGBuffer(renderer as never)

  expect(AIRCRAFT_GBUFFER_BYTES_PER_SAMPLE).toBe(24)
  expect(gBuffer.renderTarget.samples).toBe(0)
  expect(gBuffer.renderTarget.textures.map(texture => texture.name)).toEqual([
    'aircraftG0',
    'aircraftG1',
    'aircraftG2',
    'aircraftG3',
  ])
  expect(gBuffer.renderTarget.textures.map(texture => texture.type)).toEqual([
    UnsignedByteType,
    HalfFloatType,
    UnsignedByteType,
    HalfFloatType,
  ])
  expect(gBuffer.renderTarget.textures.every(texture => texture.colorSpace === NoColorSpace)).toBe(true)
  expect(gBuffer.depthTexture.format).toBe(DepthFormat)

  gBuffer.resize()
  expect(gBuffer.renderTarget.width).toBe(640)
  expect(gBuffer.renderTarget.height).toBe(360)
  gBuffer.dispose()
})
