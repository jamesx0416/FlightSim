import { expect, test } from 'bun:test'
import { BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute, Mesh } from 'three'

import { repairMsfsSkinnedAttributes } from './repairMsfsSkinnedAttributes'

test('repairs an aligned accessor from a buffer with an incomplete trailing component', async () => {
  const source = new ArrayBuffer(9)
  new Uint16Array(source, 0, 4).set([1, 2, 3, 4])

  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'uv',
    new InterleavedBufferAttribute(new InterleavedBuffer(new Uint16Array(4), 2), 2, 0)
  )
  const mesh = new Mesh(geometry)
  const associations = new Map<object, { readonly meshes?: number; readonly primitives?: number }>([
    [mesh, { meshes: 0, primitives: 0 }],
  ])

  await repairMsfsSkinnedAttributes({
    scene: mesh,
    parser: {
      associations,
      json: {
        accessors: [{ bufferView: 0, componentType: 5123, count: 2, type: 'VEC2' }],
        bufferViews: [{ buffer: 0, byteStride: 4 }],
        meshes: [{ primitives: [{ attributes: { TEXCOORD_0: 0 } }] }],
      },
      getDependency: async () => source,
    },
  } as never)

  expect([...geometry.getAttribute('uv').array]).toEqual([1, 2, 3, 4])
})
