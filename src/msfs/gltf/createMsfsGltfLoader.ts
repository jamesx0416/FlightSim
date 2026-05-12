import { LoadingManager } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { createMsftTextureDdsExtension } from './MSFTTextureDDSExtension'
import { MSFSDDSLoader, type MSFSDDSLoadOptions } from './MSFSDDSLoader'

type GltfLoadingManagerStats = {
  readonly createdAtMs: number
  started: number
  ended: number
  errored: number
  activeCount: number
  active: Array<{
    readonly url: string
    readonly count: number
    readonly ageMs: number
  }>
}

export function createMsfsGltfLoader(
  options: {
    readonly urlResolver?: (url: string) => string
    readonly decodeNormalSources?: boolean
    readonly textureLoadOptions?: MSFSDDSLoadOptions
  } = {}
): GLTFLoader {
  const loadingManager = new LoadingManager()
  installLoadingManagerDiagnostics(loadingManager)
  loadingManager.addHandler(
    /\.dds$/iu,
    new MSFSDDSLoader(loadingManager, options.textureLoadOptions)
  )
  if (options.urlResolver != null) {
    loadingManager.setURLModifier(url => options.urlResolver!(url))
  }

  const loader = new GLTFLoader(loadingManager)
  loader.register(parser =>
    createMsftTextureDdsExtension(parser as never, {
      decodeNormalSources: options.decodeNormalSources,
      textureLoadOptions: options.textureLoadOptions
    }) as never
  )

  return loader
}

function installLoadingManagerDiagnostics(loadingManager: LoadingManager): void {
  const active = new Map<string, { count: number; startedAtMs: number }>()
  const stats: GltfLoadingManagerStats = {
    createdAtMs: performance.now(),
    started: 0,
    ended: 0,
    errored: 0,
    activeCount: 0,
    active: []
  }
  const updateActiveStats = (): void => {
    stats.activeCount = 0
    stats.active = [...active.entries()]
      .map(([url, entry]) => {
        stats.activeCount += entry.count
        return {
          url,
          count: entry.count,
          ageMs: performance.now() - entry.startedAtMs
        }
      })
      .sort((left, right) => right.ageMs - left.ageMs)
      .slice(0, 20)
  }
  const originalItemStart = loadingManager.itemStart.bind(loadingManager)
  const originalItemEnd = loadingManager.itemEnd.bind(loadingManager)
  const originalItemError = loadingManager.itemError.bind(loadingManager)

  loadingManager.itemStart = (url: string): void => {
    stats.started += 1
    const entry = active.get(url)
    if (entry == null) {
      active.set(url, { count: 1, startedAtMs: performance.now() })
    } else {
      entry.count += 1
    }
    updateActiveStats()
    originalItemStart(url)
  }

  loadingManager.itemEnd = (url: string): void => {
    stats.ended += 1
    const entry = active.get(url)
    if (entry == null || entry.count <= 1) {
      active.delete(url)
    } else {
      entry.count -= 1
    }
    updateActiveStats()
    originalItemEnd(url)
  }

  loadingManager.itemError = (url: string): void => {
    stats.errored += 1
    originalItemError(url)
  }

  ;(globalThis as Record<string, unknown>).__msfsGltfLoadingManagerStats = stats
}
