import { describe, expect, test } from 'bun:test'

import type { MsfsPackageAssetLookup, MsfsPackageSource } from '../msfs/packageAssets'
import {
  clearAircraftRangeCache,
  createAircraftRangeCacheKey,
  readAircraftRangeFromCacheOrFetch,
  type AircraftRangeCacheEntry,
  type AircraftRangeCacheStorage
} from './rangeCache'

class MemoryRangeCacheStorage implements AircraftRangeCacheStorage {
  readonly entries = new Map<string, AircraftRangeCacheEntry>()

  async read(key: string): Promise<AircraftRangeCacheEntry | undefined> {
    return this.entries.get(key)
  }

  async write(entry: AircraftRangeCacheEntry): Promise<void> {
    this.entries.set(entry.key, entry)
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async deleteStalePackageEntries(packageRoot: string, revision: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.packageRoot === packageRoot && entry.revision !== revision) {
        this.entries.delete(key)
      }
    }
  }

  async clear(): Promise<void> {
    this.entries.clear()
  }
}

function assetLookup(revision = 'revision-1'): Promise<MsfsPackageAssetLookup> {
  const rootUrl = 'https://viewer.localhost/aircrafts/example-package/'
  const path = 'SimObjects/Airplanes/Test/texture.DDS'
  const source: MsfsPackageSource = {
    rootUrl,
    revision,
    layoutEntries: [{ path }],
    layoutPathIndex: new Map([[path.toLowerCase(), path]]),
    resolveAssetUrl: assetPath => {
      const url = new URL(assetPath, rootUrl)
      url.searchParams.set('assetVersion', revision)
      return url.toString()
    }
  }
  return Promise.resolve({ source, path, url: source.resolveAssetUrl(path) })
}

function testCacheKey(revision = 'revision-1', start = 0, end = 3): string {
  return createAircraftRangeCacheKey({
    packageRoot: 'https://viewer.localhost/aircrafts/example-package/',
    path: 'SimObjects/Airplanes/Test/texture.DDS',
    revision,
    start,
    end
  })
}

describe('aircraft DDS range cache', () => {
  test('cache key includes package revision', () => {
    expect(testCacheKey('revision-1') === testCacheKey('revision-2')).toBe(false)
  })

  test('corrupt cached range length is rejected', async () => {
    const storage = new MemoryRangeCacheStorage()
    const key = testCacheKey()
    await storage.write({
      key,
      packageRoot: 'https://viewer.localhost/aircrafts/example-package/',
      path: 'SimObjects/Airplanes/Test/texture.DDS',
      revision: 'revision-1',
      start: 0,
      end: 3,
      byteLength: 2,
      storedAt: 1,
      buffer: new ArrayBuffer(2)
    })

    let fetches = 0
    const buffer = await readAircraftRangeFromCacheOrFetch({
      url: 'https://viewer.localhost/aircrafts/example-package/SimObjects/Airplanes/Test/texture.DDS',
      start: 0,
      end: 3,
      requestHeader: {},
      mode: 'immutable',
      storage,
      assetLookup: () => assetLookup(),
      fetchRange: async url => {
        fetches += 1
        expect(url.includes('assetVersion=revision-1')).toBe(true)
        return new ArrayBuffer(4)
      }
    })

    expect(buffer?.byteLength).toBe(4)
    expect(fetches).toBe(1)
    expect(storage.entries.get(key)?.byteLength).toBe(4)
  })

  test('in-flight dedupe shares one fetch', async () => {
    const storage = new MemoryRangeCacheStorage()
    let fetches = 0
    const options = {
      url: 'https://viewer.localhost/aircrafts/example-package/SimObjects/Airplanes/Test/texture.DDS',
      start: 0,
      end: 3,
      requestHeader: {},
      mode: 'immutable' as const,
      storage,
      assetLookup: () => assetLookup(),
      fetchRange: async () => {
        fetches += 1
        await Promise.resolve()
        return new ArrayBuffer(4)
      }
    }

    const [left, right] = await Promise.all([
      readAircraftRangeFromCacheOrFetch(options),
      readAircraftRangeFromCacheOrFetch(options)
    ])

    expect(fetches).toBe(1)
    expect(left).toBe(right)
  })

  test('concurrent ranges share one stale-package prune', async () => {
    const storage = new MemoryRangeCacheStorage()
    await clearAircraftRangeCache(storage)
    let prunes = 0
    const deleteStalePackageEntries = storage.deleteStalePackageEntries.bind(storage)
    storage.deleteStalePackageEntries = async (packageRoot, revision) => {
      prunes += 1
      await Promise.resolve()
      return deleteStalePackageEntries(packageRoot, revision)
    }

    await Promise.all([0, 4, 8].map(start => readAircraftRangeFromCacheOrFetch({
      url: 'https://viewer.localhost/aircrafts/example-package/SimObjects/Airplanes/Test/texture.DDS',
      start,
      end: start + 3,
      requestHeader: {},
      mode: 'immutable',
      storage,
      assetLookup: () => assetLookup(),
      fetchRange: async () => new ArrayBuffer(4)
    })))

    expect(prunes).toBe(1)
  })

  test('package revision change purges stale ranges', async () => {
    const storage = new MemoryRangeCacheStorage()
    await clearAircraftRangeCache(storage)
    await storage.write({
      key: testCacheKey('old'),
      packageRoot: 'https://viewer.localhost/aircrafts/example-package/',
      path: 'SimObjects/Airplanes/Test/texture.DDS',
      revision: 'old',
      start: 0,
      end: 3,
      byteLength: 4,
      storedAt: 1,
      buffer: new ArrayBuffer(4)
    })

    await readAircraftRangeFromCacheOrFetch({
      url: 'https://viewer.localhost/aircrafts/example-package/SimObjects/Airplanes/Test/texture.DDS',
      start: 0,
      end: 3,
      requestHeader: {},
      mode: 'immutable',
      storage,
      assetLookup: () => assetLookup('new'),
      fetchRange: async () => new ArrayBuffer(4)
    })

    expect(storage.entries.has(testCacheKey('old'))).toBe(false)
    expect(storage.entries.has(testCacheKey('new'))).toBe(true)
  })

  test('cache failure falls back to versioned network URL', async () => {
    let fetchedUrl = ''
    const failingStorage: AircraftRangeCacheStorage = {
      read: async () => { throw new Error('read failed') },
      write: async () => undefined,
      delete: async () => undefined,
      deleteStalePackageEntries: async () => undefined,
      clear: async () => undefined
    }

    const buffer = await readAircraftRangeFromCacheOrFetch({
      url: 'https://viewer.localhost/aircrafts/example-package/SimObjects/Airplanes/Test/texture.DDS',
      start: 0,
      end: 3,
      requestHeader: {},
      mode: 'immutable',
      storage: failingStorage,
      assetLookup: () => assetLookup(),
      fetchRange: async url => {
        fetchedUrl = url
        return new ArrayBuffer(4)
      }
    })

    expect(buffer?.byteLength).toBe(4)
    expect(fetchedUrl.includes('assetVersion=revision-1')).toBe(true)
  })

  test('clear prevents an older in-flight miss from repopulating storage', async () => {
    const storage = new MemoryRangeCacheStorage()
    await clearAircraftRangeCache(storage)
    let releaseFetch = (_buffer: ArrayBuffer): void => undefined
    const fetchResult = new Promise<ArrayBuffer>(resolve => {
      releaseFetch = resolve
    })
    let markFetchStarted = (): void => undefined
    const fetchStarted = new Promise<void>(resolve => {
      markFetchStarted = resolve
    })

    const pending = readAircraftRangeFromCacheOrFetch({
      url: 'https://viewer.localhost/aircrafts/example-package/SimObjects/Airplanes/Test/texture.DDS',
      start: 0,
      end: 3,
      requestHeader: {},
      mode: 'immutable',
      storage,
      assetLookup: () => assetLookup(),
      fetchRange: async () => {
        markFetchStarted()
        return fetchResult
      }
    })
    await fetchStarted
    await clearAircraftRangeCache(storage)
    releaseFetch(new ArrayBuffer(4))
    await pending

    expect(storage.entries.size).toBe(0)
  })
})
