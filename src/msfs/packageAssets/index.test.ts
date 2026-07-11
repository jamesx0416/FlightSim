import { describe, expect, test } from 'bun:test'

import {
  clearMsfsPackageSourceCache,
  getMsfsPackageSourceCacheSnapshot,
  loadMsfsPackageSource,
  lookupMsfsPackageAsset,
  normalizeMsfsPackageRootUrl,
  refreshMsfsPackageSourceVersions
} from './index'

const originalFetch = globalThis.fetch

async function withMockFetch(mockFetch: typeof fetch, run: () => Promise<void>): Promise<void> {
  clearMsfsPackageSourceCache()
  globalThis.fetch = mockFetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe('MSFS package assets', () => {
  test('normalizes roots and preserves asset query parameters', async () => {
    const calls: string[] = []
    await withMockFetch((async input => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('__asset-version.json')) {
        return Response.json({ revision: 'rev 1' })
      }
      return Response.json({
        content: [{ path: 'Model\\Texture.DDS', size: 12, date: 34 }]
      })
    }) as typeof fetch, async () => {
      expect(normalizeMsfsPackageRootUrl('/packages/test', 'https://viewer.test/app/'))
        .toBe('https://viewer.test/packages/test/')

      const [first, second] = await Promise.all([
        loadMsfsPackageSource('https://viewer.test/packages/test', 'immutable'),
        loadMsfsPackageSource('https://viewer.test/packages/test/', 'immutable')
      ])

      expect(first).toBe(second)
      expect(calls).toEqual([
        'https://viewer.test/packages/test/__asset-version.json',
        'https://viewer.test/packages/test/layout.json?assetVersion=rev+1'
      ])
      expect(first.layoutEntries).toEqual([{ path: 'Model/Texture.DDS', size: 12, date: 34 }])
      expect(first.layoutPathIndex.get('model/texture.dds')).toBe('Model/Texture.DDS')
      expect(first.resolveAssetUrl('Model/Texture.DDS?quality=high#texture')).toBe(
        'https://viewer.test/packages/test/Model/Texture.DDS?quality=high&assetVersion=rev+1#texture'
      )
    })
  })

  test('falls back to an ordinary layout request when the version endpoint is missing', async () => {
    const calls: { url: string; cache?: RequestCache }[] = []
    await withMockFetch((async (input, init) => {
      const url = String(input)
      calls.push({ url, cache: init?.cache })
      return url.endsWith('__asset-version.json')
        ? new Response(null, { status: 404 })
        : Response.json({ content: [] })
    }) as typeof fetch, async () => {
      const source = await loadMsfsPackageSource('https://cdn.test/external/', 'immutable')

      expect(source.revision).toBe(null)
      expect(calls).toEqual([
        { url: 'https://cdn.test/external/__asset-version.json', cache: 'no-store' },
        { url: 'https://cdn.test/external/layout.json', cache: undefined }
      ])
    })
  })

  test('does not request a version outside immutable mode', async () => {
    const calls: string[] = []
    await withMockFetch((async input => {
      calls.push(String(input))
      return Response.json({ content: [] })
    }) as typeof fetch, async () => {
      await Promise.all([
        loadMsfsPackageSource('https://viewer.test/normal/', 'normal'),
        loadMsfsPackageSource('https://viewer.test/normal/', 'normal')
      ])

      expect(calls).toEqual(['https://viewer.test/normal/layout.json'])
    })
  })

  test('refreshes the layout only when the immutable revision changes', async () => {
    let revision = 'one'
    const calls: string[] = []
    await withMockFetch((async input => {
      const url = String(input)
      calls.push(url)
      return url.endsWith('__asset-version.json')
        ? Response.json({ revision })
        : Response.json({ content: [{ path: `${revision}.xml` }] })
    }) as typeof fetch, async () => {
      const initial = await loadMsfsPackageSource('https://viewer.test/package/', 'immutable')
      const [unchanged] = await refreshMsfsPackageSourceVersions()
      revision = 'two'
      const [changed] = await refreshMsfsPackageSourceVersions(['https://viewer.test/package'])

      expect(unchanged).toBe(initial)
      expect(changed === initial).toBe(false)
      expect(changed?.revision).toBe('two')
      expect(changed?.resolveAssetUrl('file.xml').endsWith('file.xml?assetVersion=two')).toBe(true)
      expect(calls.filter(url => url.includes('layout.json'))).toEqual([
        'https://viewer.test/package/layout.json?assetVersion=one',
        'https://viewer.test/package/layout.json?assetVersion=two'
      ])
      expect(getMsfsPackageSourceCacheSnapshot().packages[0]).toEqual({
        rootUrl: 'https://viewer.test/package/',
        cacheMode: 'immutable',
        revision: 'two',
        versionChecks: 3,
        layoutFetches: 2,
        versionEndpointAvailable: true,
        loaded: true
      })
    })
  })

  test('looks up known assets case-insensitively under the longest package root', async () => {
    await withMockFetch((async input => {
      const url = String(input)
      if (url.endsWith('__asset-version.json')) {
        return Response.json({ revision: url.includes('/nested/') ? 'nested' : 'parent' })
      }
      return Response.json({
        content: url.includes('/nested/')
          ? [{ path: 'Texture/FILE.DDS' }]
          : [{ path: 'nested/Texture/FILE.DDS' }]
      })
    }) as typeof fetch, async () => {
      await Promise.all([
        loadMsfsPackageSource('https://viewer.test/package/', 'immutable'),
        loadMsfsPackageSource('https://viewer.test/package/nested/', 'immutable')
      ])

      const result = await lookupMsfsPackageAsset(
        'https://viewer.test/package/nested/texture/file.dds?lod=2'
      )

      expect(result?.source.rootUrl).toBe('https://viewer.test/package/nested/')
      expect(result?.path).toBe('Texture/FILE.DDS')
      expect(result?.url).toBe(
        'https://viewer.test/package/nested/Texture/FILE.DDS?lod=2&assetVersion=nested'
      )
      expect(await lookupMsfsPackageAsset('https://viewer.test/package/missing.dds')).toBe(null)
    })
  })
})
