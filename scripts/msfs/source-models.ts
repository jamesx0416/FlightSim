import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  materializeModelsJsonOutput,
  type ModelsJsonEntry
} from './source-model-materializer.ts'

export interface SourceModelFallbackEntry {
  sourcePath: string
  materializedPath?: string
  ensureMaterialized?: () => string | undefined
}

export interface SourceModelFallbackIndex {
  sourceModelRoot: string
  materializedRoot?: string
  entriesByPackagePath: Map<string, SourceModelFallbackEntry>
}

interface SourceModelFallbackOptions {
  packageRoot: string
  cacheKey?: string
  cacheRoot?: string
}

const sourceModelFallbackCache = new Map<string, SourceModelFallbackIndex | null>()

export function getSourceModelFallbackIndex(
  options: SourceModelFallbackOptions
): SourceModelFallbackIndex | null {
  const packageRoot = resolve(options.packageRoot)
  const cacheKey = `${packageRoot}::${options.cacheRoot ?? ''}::${options.cacheKey ?? ''}`
  const cached = sourceModelFallbackCache.get(cacheKey)
  if (cached !== undefined) return cached

  const index = buildSourceModelFallbackIndex(packageRoot, options)
  sourceModelFallbackCache.set(cacheKey, index)
  return index
}

export function findClosestAncestorSubdirectory(
  rootDir: string,
  relativePath: string
): string | undefined {
  let cursor = resolve(rootDir)

  while (true) {
    const candidate = join(cursor, relativePath)
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate
    }

    const parent = resolve(cursor, '..')
    if (parent === cursor) {
      return undefined
    }
    cursor = parent
  }
}

function buildSourceModelFallbackIndex(
  packageRoot: string,
  options: SourceModelFallbackOptions
): SourceModelFallbackIndex | null {
  const sourceModelRoot = findClosestAncestorSubdirectory(packageRoot, join('src', 'model'))
  if (!sourceModelRoot) return null

  const manifestPath = join(sourceModelRoot, 'models.json')
  if (!existsSync(manifestPath)) return null

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ModelsJsonEntry[]
  const entriesByPackagePath = new Map<string, SourceModelFallbackEntry>()
  const materializedRoot =
    options.cacheRoot && options.cacheKey
      ? resolve(options.cacheRoot, 'source-models', options.cacheKey)
      : undefined

  manifest.forEach((entry, entryIndex) => {
    const sourceGltfs = asStringArray(entry.gltf)
    const outputGltfs = asStringArray(entry.output?.gltf)
    const pairCount = Math.min(sourceGltfs.length, outputGltfs.length)

    for (let outputIndex = 0; outputIndex < pairCount; outputIndex += 1) {
      const sourceAbsolutePath = resolve(sourceModelRoot, sourceGltfs[outputIndex])
      if (!existsSync(sourceAbsolutePath)) {
        continue
      }

      const outputAbsolutePath = resolve(sourceModelRoot, outputGltfs[outputIndex])
      const packageModelPath = extractPackageModelPath(outputAbsolutePath)
      if (!packageModelPath) continue

      entriesByPackagePath.set(packageModelPath.toLowerCase(), {
        sourcePath: toPortablePath(relative(sourceModelRoot, sourceAbsolutePath)),
        materializedPath: materializedRoot ? packageModelPath : undefined,
        ensureMaterialized: materializedRoot
          ? () =>
              materializeModelsJsonOutput({
                sourceModelRoot,
                entry: manifest[entryIndex],
                outputIndex,
                materializedRoot
              })
          : undefined
      })
    }
  })

  return entriesByPackagePath.size > 0
    ? {
        sourceModelRoot,
        materializedRoot,
        entriesByPackagePath
      }
    : null
}

function extractPackageModelPath(absolutePath: string): string | undefined {
  const portablePath = toPortablePath(absolutePath)
  const marker = '/SimObjects/'
  const markerIndex = portablePath.indexOf(marker)
  if (markerIndex < 0) return undefined
  return portablePath.slice(markerIndex + 1)
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function toPortablePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/')
}
