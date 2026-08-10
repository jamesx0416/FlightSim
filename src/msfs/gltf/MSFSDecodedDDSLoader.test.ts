import { expect, test } from 'bun:test'

import { __msfsDecodedDdsTestHooks } from './MSFSDecodedDDSLoader'

function writeBc4Selectors(view: DataView, offset: number, selectors: readonly number[]): void {
  let bits = 0n
  for (let index = 0; index < selectors.length; index += 1) {
    bits |= BigInt(selectors[index]!) << BigInt(index * 3)
  }
  for (let byte = 0; byte < 6; byte += 1) {
    view.setUint8(offset + byte, Number((bits >> BigInt(byte * 8)) & 0xffn))
  }
}

test('decodes a partial DXT1 block without per-pixel callback allocation', () => {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setUint16(0, 0xf800, true)
  view.setUint16(2, 0x001f, true)
  view.setUint32(4, 0xe4e4e4e4, true)

  expect([...__msfsDecodedDdsTestHooks.decodeDxt1(buffer, 0, 3, 2)]).toEqual([
    255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255,
    255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255,
  ])
})

test('decodes a partial DXT5 block without shifting skipped selectors', () => {
  const buffer = new ArrayBuffer(16)
  const view = new DataView(buffer)
  view.setUint8(0, 255)
  view.setUint8(1, 0)
  writeBc4Selectors(view, 2, [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7])
  view.setUint16(8, 0xf800, true)
  view.setUint16(10, 0x001f, true)
  view.setUint32(12, 0xe4e4e4e4, true)

  expect([...__msfsDecodedDdsTestHooks.decodeDxt5(buffer, 0, 3, 2)]).toEqual([
    255, 0, 0, 255, 0, 0, 255, 0, 170, 0, 85, 218,
    255, 0, 0, 145, 0, 0, 255, 109, 170, 0, 85, 72,
  ])
})

test('decodes one BC5 block without repeating BC4 selector work per pixel', () => {
  const buffer = new ArrayBuffer(16)
  const view = new DataView(buffer)
  view.setUint8(0, 255)
  view.setUint8(1, 0)
  view.setUint8(8, 0)
  view.setUint8(9, 255)
  writeBc4Selectors(view, 2, [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7])
  writeBc4Selectors(view, 10, [7, 6, 5, 4, 3, 2, 1, 0, 7, 6, 5, 4, 3, 2, 1, 0])

  expect([...__msfsDecodedDdsTestHooks.decodeBc5Rg(buffer, 0, 4, 4, false)]).toEqual([
    255, 255, 0, 0, 219, 204, 182, 153, 146, 102, 109, 51, 73, 255, 36, 0,
    255, 255, 0, 0, 219, 204, 182, 153, 146, 102, 109, 51, 73, 255, 36, 0,
  ])
})
