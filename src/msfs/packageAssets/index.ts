import {
  getAircraftCacheMode,
  type AircraftCacheMode
} from '../../aircraftAssets/cachePolicy'
import type { PackageLayoutEntry } from '../types'

export interface MsfsPackageSource {
  readonly rootUrl: string
  readonly revision: string | null
  readonly layoutEntries: readonly PackageLayoutEntry[]
  readonly layoutPathIndex: ReadonlyMap<string, string>
  readonly resolveAssetUrl: (path: string) => string
}

export interface MsfsPackageAssetLookup {
  readonly source: MsfsPackageSource
  readonly path: string
  readonly url: string
}

export interface MsfsPackageSourceCacheSnapshot {
  readonly packages: readonly {
    readonly rootUrl: string
    readonly cacheMode: AircraftCacheMode
    readonly revision: string | null
    readonly versionChecks: number
    readonly layoutFetches: number
    readonly versionEndpointAvailable: boolean | null
    readonly loaded: boolean
  }[]
}

type CacheEntry = {
  readonly rootUrl: string
  readonly cacheMode: AircraftCacheMode
  versionChecks: number
  layoutFetches: number
  versionEndpointAvailable: boolean | null
  source?: MsfsPackageSource
  request?: Promise<MsfsPackageSource>
}

const sourceCache = new Map<string, CacheEntry>()

export function normalizeMsfsPackageRootUrl(
  rootUrl: string,
  baseHref = getDefaultBaseHref()
): string {
  const url = new URL(rootUrl, baseHref)
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/'
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function loadMsfsPackageSource(
  rootUrl: string,
  cacheMode = getAircraftCacheMode()
): Promise<MsfsPackageSource> {
  const normalizedRootUrl = normalizeMsfsPackageRootUrl(rootUrl)
  const key = cacheKey(normalizedRootUrl, cacheMode)
  let entry = sourceCache.get(key)
  if (entry == null) {
    entry = {
      rootUrl: normalizedRootUrl,
      cacheMode,
      versionChecks: 0,
      layoutFetches: 0,
      versionEndpointAvailable: null
    }
    sourceCache.set(key, entry)
  }

  if (entry.source != null) {
    return Promise.resolve(entry.source)
  }
  if (entry.request != null) {
    return entry.request
  }

  entry.request = loadSource(entry).then(
    source => {
      entry.source = source
      entry.request = undefined
      return source
    },
    error => {
      entry.request = undefined
      throw error
    }
  )
  return entry.request
}

export async function refreshMsfsPackageSourceVersions(
  rootUrls?: readonly string[]
): Promise<readonly MsfsPackageSource[]> {
  const roots = rootUrls == null
    ? null
    : new Set(rootUrls.map(rootUrl => normalizeMsfsPackageRootUrl(rootUrl)))
  const entries = [...sourceCache.values()].filter(entry => roots == null || roots.has(entry.rootUrl))
  return Promise.all(entries.map(refreshCachedSource))
}

export async function lookupMsfsPackageAsset(
  assetUrl: string
): Promise<MsfsPackageAssetLookup | null> {
  let url: URL
  try {
    url = new URL(assetUrl, getDefaultBaseHref())
  } catch {
    return null
  }

  const candidates = [...sourceCache.values()]
    .filter(entry => isUrlUnderRoot(url, entry.rootUrl))
    .sort((left, right) => right.rootUrl.length - left.rootUrl.length)

  for (const entry of candidates) {
    const source = entry.source ?? await entry.request?.catch(() => undefined)
    if (source == null) continue

    const root = new URL(source.rootUrl)
    const candidatePath = normalizePackagePath(
      safeDecodeURIComponent(url.pathname.slice(root.pathname.length))
    )
    const path = source.layoutPathIndex.get(candidatePath.toLowerCase())
    if (path == null) continue

    return {
      source,
      path,
      url: source.resolveAssetUrl(`${path}${url.search}${url.hash}`)
    }
  }

  return null
}

export function getMsfsPackageSourceCacheSnapshot(): MsfsPackageSourceCacheSnapshot {
  return {
    packages: [...sourceCache.values()].map(entry => ({
      rootUrl: entry.rootUrl,
      cacheMode: entry.cacheMode,
      revision: entry.source?.revision ?? null,
      versionChecks: entry.versionChecks,
      layoutFetches: entry.layoutFetches,
      versionEndpointAvailable: entry.versionEndpointAvailable,
      loaded: entry.source != null
    }))
  }
}

export function getCachedMsfsPackageSource(rootUrl: string): MsfsPackageSource | null {
  const normalizedRootUrl = normalizeMsfsPackageRootUrl(rootUrl)
  for (const entry of sourceCache.values()) {
    if (entry.rootUrl === normalizedRootUrl && entry.source != null) return entry.source
  }
  return null
}

export function clearMsfsPackageSourceCache(): void {
  sourceCache.clear()
}

async function loadSource(entry: CacheEntry): Promise<MsfsPackageSource> {
  const revision = entry.cacheMode === 'immutable' ? await fetchRevision(entry) : null
  return fetchSourceLayout(entry, revision)
}

async function refreshSource(entry: CacheEntry): Promise<MsfsPackageSource> {
  const revision = entry.cacheMode === 'immutable' ? await fetchRevision(entry) : null
  if (entry.source != null && revision != null && revision === entry.source.revision) {
    return entry.source
  }

  const source = await fetchSourceLayout(entry, revision)
  entry.source = source
  return source
}

function refreshCachedSource(entry: CacheEntry): Promise<MsfsPackageSource> {
  if (entry.request != null) {
    return entry.request
  }

  entry.request = refreshSource(entry).then(
    source => {
      entry.request = undefined
      return source
    },
    error => {
      entry.request = undefined
      throw error
    }
  )
  return entry.request
}

async function fetchRevision(entry: CacheEntry): Promise<string | null> {
  entry.versionChecks += 1
  try {
    const response = await fetch(new URL('__asset-version.json', entry.rootUrl), {
      cache: 'no-store'
    })
    if (!response.ok) {
      await response.body?.cancel()
      entry.versionEndpointAvailable = false
      return null
    }

    const payload = (await response.json()) as { readonly revision?: unknown }
    if (typeof payload.revision !== 'string' || payload.revision === '') {
      entry.versionEndpointAvailable = false
      return null
    }

    entry.versionEndpointAvailable = true
    return payload.revision
  } catch {
    entry.versionEndpointAvailable = false
    return null
  }
}

async function fetchSourceLayout(
  entry: CacheEntry,
  revision: string | null
): Promise<MsfsPackageSource> {
  entry.layoutFetches += 1
  const layoutUrl = resolveAssetUrl(entry.rootUrl, 'layout.json', revision)
  const response = await fetch(layoutUrl)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`layout.json was not found at ${entry.rootUrl} (${response.status})`)
  }

  const payload = (await response.json()) as { readonly content?: unknown }
  const content = Array.isArray(payload.content) ? payload.content : []
  const layoutEntries = content.flatMap(rawEntry => {
    if (rawEntry == null || typeof rawEntry !== 'object') return []
    const { path, size, date } = rawEntry as Record<string, unknown>
    if (typeof path !== 'string') return []
    const entry: PackageLayoutEntry = {
      path: normalizePackagePath(path),
      ...(typeof size === 'number' ? { size } : {}),
      ...(typeof date === 'number' ? { date } : {})
    }
    return [entry]
  })
  const layoutPathIndex = new Map(
    layoutEntries.map(({ path }) => [path.toLowerCase(), path])
  )

  return {
    rootUrl: entry.rootUrl,
    revision,
    layoutEntries,
    layoutPathIndex,
    resolveAssetUrl: path => resolveAssetUrl(entry.rootUrl, path, revision)
  }
}

function resolveAssetUrl(rootUrl: string, path: string, revision: string | null): string {
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\/+/, '')
  const url = new URL(normalizedPath, rootUrl)
  if (revision != null) {
    url.searchParams.set('assetVersion', revision)
  }
  return url.toString()
}

function normalizePackagePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

function isUrlUnderRoot(url: URL, rootUrl: string): boolean {
  const root = new URL(rootUrl)
  return url.origin === root.origin && url.pathname.startsWith(root.pathname)
}

function cacheKey(rootUrl: string, cacheMode: AircraftCacheMode): string {
  return `${cacheMode}\0${rootUrl}`
}

function getDefaultBaseHref(): string {
  return globalThis.location?.href ?? 'http://localhost/'
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
