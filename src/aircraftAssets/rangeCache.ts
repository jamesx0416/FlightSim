import {
  lookupMsfsPackageAsset,
  type MsfsPackageAssetLookup
} from '../msfs/packageAssets'
import { getAircraftCacheMode, type AircraftCacheMode } from './cachePolicy'

export type AircraftRangeCacheEntry = {
  readonly key: string
  readonly packageRoot: string
  readonly path: string
  readonly revision: string
  readonly start: number
  readonly end: number
  readonly byteLength: number
  readonly storedAt: number
  readonly buffer: ArrayBuffer
}

export type AircraftRangeCacheStorage = {
  readonly read: (key: string) => Promise<AircraftRangeCacheEntry | undefined>
  readonly write: (entry: AircraftRangeCacheEntry) => Promise<void>
  readonly delete: (key: string) => Promise<void>
  readonly deleteStalePackageEntries: (packageRoot: string, revision: string) => Promise<void>
  readonly clear: () => Promise<void>
}

export type AircraftRangeFetch = (
  url: string,
  start: number,
  end: number,
  requestHeader: Record<string, string>
) => Promise<ArrayBuffer | null>

export type ReadAircraftRangeOptions = {
  readonly url: string
  readonly start: number
  readonly end: number
  readonly requestHeader: Record<string, string>
  readonly fetchRange: AircraftRangeFetch
  readonly mode?: AircraftCacheMode
  readonly storage?: AircraftRangeCacheStorage
  readonly assetLookup?: (url: string) => Promise<MsfsPackageAssetLookup | null>
}

export type AircraftRangeCacheKeyParts = {
  readonly packageRoot: string
  readonly path: string
  readonly revision: string
  readonly start: number
  readonly end: number
}

export type AircraftAssetCacheSnapshot = {
  readonly mode: AircraftCacheMode
  readonly ddsRangeHits: number
  readonly ddsRangeMisses: number
  readonly ddsRangeNetworkBytes: number
  readonly ddsRangeCachedReadBytes: number
  readonly ddsRangeStoredBytes: number
  readonly invalidEntries: number
  readonly stalePackagePrunes: number
  readonly failures: number
}

const DATABASE_NAME = 'aircraft-assets-v1'
const DATABASE_VERSION = 2
const RANGE_STORE_NAME = 'ranges'
const PACKAGE_ROOT_INDEX_NAME = 'packageRoot'
const CACHE_KEY_PREFIX = 'aircraft-assets-v2'

const inFlightRangeReads = new Map<string, Promise<ArrayBuffer | null>>()
const prunedPackageRevisions = new Map<string, string>()
const inFlightPackagePrunes = new Map<string, Promise<void>>()
let cacheGeneration = 0

const metrics = {
  ddsRangeHits: 0,
  ddsRangeMisses: 0,
  ddsRangeNetworkBytes: 0,
  ddsRangeCachedReadBytes: 0,
  ddsRangeStoredBytes: 0,
  invalidEntries: 0,
  stalePackagePrunes: 0,
  failures: 0
}

export async function readAircraftRangeFromCacheOrFetch(
  options: ReadAircraftRangeOptions
): Promise<ArrayBuffer | null> {
  if ((options.mode ?? getAircraftCacheMode()) !== 'immutable') {
    return options.fetchRange(options.url, options.start, options.end, options.requestHeader)
  }

  let asset: MsfsPackageAssetLookup | null
  try {
    asset = await (options.assetLookup ?? lookupMsfsPackageAsset)(options.url)
  } catch {
    metrics.failures += 1
    return fetchRangeAndCount(options, options.url)
  }

  const revision = asset?.source.revision
  if (asset == null || revision == null) {
    return fetchRangeAndCount(options, options.url)
  }

  const storage = options.storage ?? indexedDbRangeCacheStorage
  await pruneStalePackageEntries(storage, asset.source.rootUrl, revision)

  const key = createAircraftRangeCacheKey({
    packageRoot: asset.source.rootUrl,
    path: asset.path,
    revision,
    start: options.start,
    end: options.end
  })
  const existing = inFlightRangeReads.get(key)
  if (existing != null) return existing

  const generation = cacheGeneration
  const request = readCachedRangeOrFetch(options, storage, asset, revision, key, generation).finally(() => {
    if (inFlightRangeReads.get(key) === request) inFlightRangeReads.delete(key)
  })
  inFlightRangeReads.set(key, request)
  return request
}

export function createAircraftRangeCacheKey(parts: AircraftRangeCacheKeyParts): string {
  return [
    CACHE_KEY_PREFIX,
    parts.packageRoot,
    parts.path,
    parts.revision,
    `${parts.start}-${parts.end}`
  ].join(':')
}

export async function clearAircraftRangeCache(
  storage: AircraftRangeCacheStorage = indexedDbRangeCacheStorage
): Promise<void> {
  cacheGeneration += 1
  inFlightRangeReads.clear()
  prunedPackageRevisions.clear()
  inFlightPackagePrunes.clear()
  await storage.clear()
  resetMetrics()
}

export function getAircraftAssetCacheSnapshot(): AircraftAssetCacheSnapshot {
  return {
    mode: getAircraftCacheMode(),
    ...metrics
  }
}

async function pruneStalePackageEntries(
  storage: AircraftRangeCacheStorage,
  packageRoot: string,
  revision: string
): Promise<void> {
  if (prunedPackageRevisions.get(packageRoot) === revision) return

  const pruneKey = `${packageRoot}\0${revision}`
  const existing = inFlightPackagePrunes.get(pruneKey)
  if (existing != null) return existing

  const generation = cacheGeneration
  const request = storage.deleteStalePackageEntries(packageRoot, revision)
    .then(() => {
      if (generation !== cacheGeneration) return
      prunedPackageRevisions.set(packageRoot, revision)
      metrics.stalePackagePrunes += 1
    })
    .catch(() => {
      metrics.failures += 1
    })
    .finally(() => {
      if (inFlightPackagePrunes.get(pruneKey) === request) {
        inFlightPackagePrunes.delete(pruneKey)
      }
    })
  inFlightPackagePrunes.set(pruneKey, request)
  return request
}

async function readCachedRangeOrFetch(
  options: ReadAircraftRangeOptions,
  storage: AircraftRangeCacheStorage,
  asset: MsfsPackageAssetLookup,
  revision: string,
  key: string,
  generation: number
): Promise<ArrayBuffer | null> {
  const expectedByteLength = options.end - options.start + 1

  try {
    const cached = await storage.read(key)
    if (cached != null) {
      if (isValidCachedRangeEntry(cached, asset, revision, options, expectedByteLength)) {
        metrics.ddsRangeHits += 1
        metrics.ddsRangeCachedReadBytes += cached.buffer.byteLength
        return cached.buffer
      }

      metrics.invalidEntries += 1
      await storage.delete(key).catch(() => {
        metrics.failures += 1
      })
    }
  } catch {
    metrics.failures += 1
    return fetchRangeAndCount(options, asset.url)
  }

  const buffer = await fetchRangeAndCount(options, asset.url)
  if (buffer == null || buffer.byteLength !== expectedByteLength) return buffer
  if (generation !== cacheGeneration) return buffer

  try {
    await storage.write({
      key,
      packageRoot: asset.source.rootUrl,
      path: asset.path,
      revision,
      start: options.start,
      end: options.end,
      byteLength: buffer.byteLength,
      storedAt: Date.now(),
      buffer
    })
    metrics.ddsRangeStoredBytes += buffer.byteLength
  } catch {
    metrics.failures += 1
  }

  return buffer
}

async function fetchRangeAndCount(
  options: ReadAircraftRangeOptions,
  url: string
): Promise<ArrayBuffer | null> {
  metrics.ddsRangeMisses += 1
  const buffer = await options.fetchRange(url, options.start, options.end, options.requestHeader)
  if (buffer != null) metrics.ddsRangeNetworkBytes += buffer.byteLength
  return buffer
}

function isValidCachedRangeEntry(
  entry: AircraftRangeCacheEntry,
  asset: MsfsPackageAssetLookup,
  revision: string,
  options: ReadAircraftRangeOptions,
  expectedByteLength: number
): boolean {
  return (
    entry.packageRoot === asset.source.rootUrl &&
    entry.path === asset.path &&
    entry.revision === revision &&
    entry.start === options.start &&
    entry.end === options.end &&
    entry.byteLength === expectedByteLength &&
    entry.buffer.byteLength === expectedByteLength
  )
}

const indexedDbRangeCacheStorage: AircraftRangeCacheStorage = {
  async read(key) {
    const database = await openRangeCacheDatabase()
    return transactionRequest<AircraftRangeCacheEntry | undefined>(
      database.transaction(RANGE_STORE_NAME, 'readonly').objectStore(RANGE_STORE_NAME).get(key)
    )
  },

  async write(entry) {
    const database = await openRangeCacheDatabase()
    const transaction = database.transaction(RANGE_STORE_NAME, 'readwrite')
    transaction.objectStore(RANGE_STORE_NAME).put(entry)
    await waitForTransaction(transaction)
  },

  async delete(key) {
    const database = await openRangeCacheDatabase()
    const transaction = database.transaction(RANGE_STORE_NAME, 'readwrite')
    transaction.objectStore(RANGE_STORE_NAME).delete(key)
    await waitForTransaction(transaction)
  },

  async deleteStalePackageEntries(packageRoot, revision) {
    const database = await openRangeCacheDatabase()
    const transaction = database.transaction(RANGE_STORE_NAME, 'readwrite')
    const index = transaction.objectStore(RANGE_STORE_NAME).index(PACKAGE_ROOT_INDEX_NAME)
    const request = index.openCursor(IDBKeyRange.only(packageRoot))
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor == null) return
      const entry = cursor.value as Partial<AircraftRangeCacheEntry>
      if (entry.revision !== revision) cursor.delete()
      cursor.continue()
    }
    await waitForTransaction(transaction)
  },

  async clear() {
    if (getIndexedDB() == null) return
    const database = await openRangeCacheDatabase()
    const transaction = database.transaction(RANGE_STORE_NAME, 'readwrite')
    transaction.objectStore(RANGE_STORE_NAME).clear()
    await waitForTransaction(transaction)
  }
}

let rangeCacheDatabase: Promise<IDBDatabase> | null = null

function openRangeCacheDatabase(): Promise<IDBDatabase> {
  if (rangeCacheDatabase != null) return rangeCacheDatabase

  const indexedDB = getIndexedDB()
  if (indexedDB == null) throw new Error('IndexedDB is unavailable.')

  const request = new Promise<IDBDatabase>((resolve, reject) => {
    const openRequest = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    openRequest.onupgradeneeded = () => {
      const database = openRequest.result
      const store = database.objectStoreNames.contains(RANGE_STORE_NAME)
        ? openRequest.transaction!.objectStore(RANGE_STORE_NAME)
        : database.createObjectStore(RANGE_STORE_NAME, { keyPath: 'key' })
      if (!store.indexNames.contains(PACKAGE_ROOT_INDEX_NAME)) {
        store.createIndex(PACKAGE_ROOT_INDEX_NAME, 'packageRoot')
      }
    }
    openRequest.onsuccess = () => resolve(openRequest.result)
    openRequest.onerror = () =>
      reject(openRequest.error ?? new Error('Failed to open aircraft range cache.'))
    openRequest.onblocked = () => reject(new Error('Aircraft range cache open was blocked.'))
  }).catch(error => {
    rangeCacheDatabase = null
    throw error
  })
  rangeCacheDatabase = request
  return request
}

function getIndexedDB(): IDBFactory | undefined {
  return globalThis.indexedDB
}

function transactionRequest<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
  })
}

function resetMetrics(): void {
  metrics.ddsRangeHits = 0
  metrics.ddsRangeMisses = 0
  metrics.ddsRangeNetworkBytes = 0
  metrics.ddsRangeCachedReadBytes = 0
  metrics.ddsRangeStoredBytes = 0
  metrics.invalidEntries = 0
  metrics.stalePackagePrunes = 0
  metrics.failures = 0
}
