import { expect, test } from 'bun:test'

import { clearMsfsPackageSourceCache, loadMsfsPackageSource } from '../packageAssets'
import { __ddsLoaderTestHooks, MSFSDDSLoader } from './MSFSDDSLoader'

test('missing DDS FLAGS is decided from the package layout without a network probe', async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async input => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('__asset-version.json')) {
      return Response.json({ revision: 'revision-1' })
    }
    return Response.json({
      content: [{ path: 'texture/test.DDS' }]
    })
  }) as typeof fetch

  try {
    clearMsfsPackageSourceCache()
    await loadMsfsPackageSource('https://viewer.test/aircrafts/example/', 'immutable')
    const flagsUrl = await __ddsLoaderTestHooks.resolveAircraftDdsFlagsUrl(
      'https://viewer.test/aircrafts/example/texture/test.DDS'
    )

    expect(flagsUrl).toBe(null)
    expect(calls).toEqual([
      'https://viewer.test/aircrafts/example/__asset-version.json',
      'https://viewer.test/aircrafts/example/layout.json?assetVersion=revision-1'
    ])
  } finally {
    clearMsfsPackageSourceCache()
    globalThis.fetch = originalFetch
  }
})


test('compressed DDS mip data keeps a zero-copy view of the source buffer', () => {
  const buffer = new ArrayBuffer(136)
  const header = new Int32Array(buffer, 0, 31)
  header[0] = 0x20534444
  header[1] = 124
  header[3] = 4
  header[4] = 4
  header[21] = 'D'.charCodeAt(0) + ('X'.charCodeAt(0) << 8) + ('T'.charCodeAt(0) << 16) + ('1'.charCodeAt(0) << 24)
  const payload = new Uint8Array(buffer, 128, 8)
  payload.set([1, 2, 3, 4, 5, 6, 7, 8])

  const parsed = new MSFSDDSLoader().parse(buffer, { loadMipmaps: true })

  expect(parsed.mipmaps.length).toBe(1)
  expect(parsed.mipmaps[0]?.data.buffer).toBe(buffer)
  expect(parsed.mipmaps[0]?.data.byteOffset).toBe(128)
  expect(Array.from(parsed.mipmaps[0]?.data ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
})
