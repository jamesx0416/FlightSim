import { expect, test } from 'bun:test'

import { clearMsfsPackageSourceCache, loadMsfsPackageSource } from '../packageAssets'
import { __ddsLoaderTestHooks } from './MSFSDDSLoader'

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
