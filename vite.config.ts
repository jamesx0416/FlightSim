import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import { loadCompatibilityDescriptors } from './scripts/msfs/compatibility'
import { findClosestAncestorSubdirectory } from './scripts/msfs/source-models'

const MSFS_COMPATIBILITY_INDEX_ROUTE = '/msfs/compatibility/index.json'
const MSFS_COMPATIBILITY_DESCRIPTOR_ROUTE = '/msfs/compatibility/descriptors/'
const MSFS_PACKAGE_ROUTE = '/msfs/packages/'
const MSFS_SOURCE_ROUTE_PREFIX = '__source__/'
const MSFS_MATERIALIZED_SOURCE_ROUTE_PREFIX = '__source_materialized__/'

interface SourceAssetRoots {
  sourceModelRoot?: string
  textureFilesByName: Map<string, string>
  textureManifestJson: string
}

const sourceAssetRootsCache = new Map<string, SourceAssetRoots>()

function msfsCompatibilityPlugin(): Plugin {
  const bundle = loadCompatibilityDescriptors()
  const indexJson = JSON.stringify(bundle.index, null, 2)
  const descriptorJsonById = new Map(
    bundle.descriptors.map((descriptor) => [descriptor.id, JSON.stringify(descriptor, null, 2)])
  )

  return {
    name: 'msfs-compatibility-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!serveCompatibilityAsset(
          req,
          res,
          bundle.packageRootsByCacheKey,
          bundle.materializedSourceRootsByCacheKey,
          descriptorJsonById,
          indexJson
        )) {
          next()
        }
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!serveCompatibilityAsset(
          req,
          res,
          bundle.packageRootsByCacheKey,
          bundle.materializedSourceRootsByCacheKey,
          descriptorJsonById,
          indexJson
        )) {
          next()
        }
      })
    },
    closeBundle() {
      const compatibilityRoot = resolve('dist', 'msfs', 'compatibility')
      const descriptorRoot = join(compatibilityRoot, 'descriptors')
      mkdirSync(descriptorRoot, { recursive: true })
      writeFileSync(join(compatibilityRoot, 'index.json'), `${indexJson}\n`)
      for (const [descriptorId, json] of descriptorJsonById) {
        writeFileSync(join(descriptorRoot, `${descriptorId}.json`), `${json}\n`)
      }
    }
  }
}

function serveCompatibilityAsset(
  req: IncomingMessage,
  res: ServerResponse,
  packageRootsByCacheKey: Map<string, string>,
  materializedSourceRootsByCacheKey: Map<string, string>,
  descriptorJsonById: Map<string, string>,
  indexJson: string
): boolean {
  const rawUrl = req.url
  if (!rawUrl) return false

  const pathname = new URL(rawUrl, 'http://localhost').pathname
  if (pathname === MSFS_COMPATIBILITY_INDEX_ROUTE) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(indexJson)
    return true
  }

  if (pathname.startsWith(MSFS_COMPATIBILITY_DESCRIPTOR_ROUTE)) {
    const descriptorId = pathname
      .slice(MSFS_COMPATIBILITY_DESCRIPTOR_ROUTE.length)
      .replace(/\.json$/i, '')
    const descriptorJson = descriptorJsonById.get(descriptorId)
    if (!descriptorJson) {
      res.statusCode = 404
      res.end()
      return true
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(descriptorJson)
    return true
  }

  if (pathname.startsWith(MSFS_PACKAGE_ROUTE)) {
    const remainder = pathname.slice(MSFS_PACKAGE_ROUTE.length)
    const separatorIndex = remainder.indexOf('/')
    if (separatorIndex <= 0) {
      res.statusCode = 404
      res.end()
      return true
    }

    const cacheKey = remainder.slice(0, separatorIndex)
    const relativePath = remainder.slice(separatorIndex + 1)
    const packageRoot = packageRootsByCacheKey.get(cacheKey)
    if (!packageRoot) {
      res.statusCode = 404
      res.end()
      return true
    }

    if (relativePath.startsWith(MSFS_SOURCE_ROUTE_PREFIX)) {
      const sourceRelativePath = relativePath.slice(MSFS_SOURCE_ROUTE_PREFIX.length)
      if (sourceRelativePath === 'texture-manifest.json') {
        const roots = getSourceAssetRoots(packageRoot)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(roots.textureManifestJson)
        return true
      }

      const sourceAssetPath = resolveSourceAssetPath(packageRoot, sourceRelativePath)
      if (!sourceAssetPath) {
        res.statusCode = 404
        res.end()
        return true
      }

      streamFile(res, sourceAssetPath)
      return true
    }

    if (relativePath.startsWith(MSFS_MATERIALIZED_SOURCE_ROUTE_PREFIX)) {
      const sourceRelativePath = relativePath.slice(
        MSFS_MATERIALIZED_SOURCE_ROUTE_PREFIX.length
      )
      if (sourceRelativePath === 'texture-manifest.json') {
        const roots = getSourceAssetRoots(packageRoot)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(roots.textureManifestJson)
        return true
      }

      const materializedRoot = materializedSourceRootsByCacheKey.get(cacheKey)
      if (!materializedRoot) {
        res.statusCode = 404
        res.end()
        return true
      }

      const absolutePath = resolve(materializedRoot, sourceRelativePath)
      const relativeToRoot = relative(materializedRoot, absolutePath)
      if (
        !relativeToRoot.startsWith('..') &&
        !relativeToRoot.includes('/../') &&
        existsSync(absolutePath) &&
        statSync(absolutePath).isFile()
      ) {
        streamFile(res, absolutePath)
        return true
      }

      const sourceAssetPath = resolveSourceAssetPath(packageRoot, sourceRelativePath)
      if (!sourceAssetPath) {
        res.statusCode = 404
        res.end()
        return true
      }

      streamFile(res, sourceAssetPath)
      return true
    }

    const absolutePath = resolve(packageRoot, relativePath)
    const relativeToRoot = relative(packageRoot, absolutePath)
    if (
      relativeToRoot.startsWith('..') ||
      relativeToRoot.includes('/../') ||
      !existsSync(absolutePath) ||
      !statSync(absolutePath).isFile()
    ) {
      res.statusCode = 404
      res.end()
      return true
    }

    streamFile(res, absolutePath)
    return true
  }

  return false
}

function resolveSourceAssetPath(packageRoot: string, sourceRelativePath: string): string | undefined {
  const roots = getSourceAssetRoots(packageRoot)

  if (roots.sourceModelRoot) {
    const absolutePath = resolve(roots.sourceModelRoot, sourceRelativePath)
    const relativeToRoot = relative(roots.sourceModelRoot, absolutePath)
    if (
      !relativeToRoot.startsWith('..') &&
      !relativeToRoot.includes('/../') &&
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile()
    ) {
      return absolutePath
    }
  }

  return roots.textureFilesByName.get(basename(sourceRelativePath).toLowerCase())
}

function getSourceAssetRoots(packageRoot: string): SourceAssetRoots {
  const cached = sourceAssetRootsCache.get(packageRoot)
  if (cached) return cached

  const sourceModelRoot = findClosestAncestorSubdirectory(packageRoot, join('src', 'model'))
  const textureDirs = new Set<string>()

  const sourceTexturesRoot = findClosestAncestorSubdirectory(packageRoot, join('src', 'textures'))
  if (sourceTexturesRoot) {
    textureDirs.add(sourceTexturesRoot)
  }

  for (const textureDir of findPackageTextureDirs(packageRoot)) {
    textureDirs.add(textureDir)
  }

  const roots = {
    sourceModelRoot,
    textureFilesByName: collectRecursiveTextureFiles([...textureDirs]),
    textureManifestJson: ''
  } satisfies SourceAssetRoots

  roots.textureManifestJson = `${JSON.stringify(
    { available: [...roots.textureFilesByName.keys()].sort() },
    null,
    2
  )}\n`

  sourceAssetRootsCache.set(packageRoot, roots)
  return roots
}

function findPackageTextureDirs(rootDir: string): string[] {
  const directories: string[] = []
  const queue = [resolve(rootDir)]

  while (queue.length > 0) {
    const currentDir = queue.shift()
    if (!currentDir || !existsSync(currentDir) || !statSync(currentDir).isDirectory()) {
      continue
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = join(currentDir, entry.name)
      if (!entry.isDirectory()) continue

      if (entry.name.toLowerCase().startsWith('texture')) {
        directories.push(absolutePath)
        continue
      }

      queue.push(absolutePath)
    }
  }

  return directories
}

function collectRecursiveTextureFiles(rootDirs: readonly string[]): Map<string, string> {
  const files = new Map<string, string>()
  const queue = [...rootDirs]

  while (queue.length > 0) {
    const currentDir = queue.shift()
    if (!currentDir || !existsSync(currentDir) || !statSync(currentDir).isDirectory()) {
      continue
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        queue.push(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      const extension = extname(entry.name).toLowerCase()
      if (!['.dds', '.png', '.jpg', '.jpeg'].includes(extension)) continue

      const key = entry.name.toLowerCase()
      if (!files.has(key)) {
        files.set(key, absolutePath)
      }
    }
  }

  return files
}

function streamFile(res: ServerResponse, filePath: string): void {
  res.statusCode = 200
  res.setHeader('Content-Type', contentTypeFor(filePath))
  createReadStream(filePath).pipe(res)
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.gltf':
      return 'model/gltf+json'
    case '.bin':
      return 'application/octet-stream'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.xml':
      return 'application/xml; charset=utf-8'
    case '.dds':
      return 'image/vnd-ms.dds'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.svg':
      return 'image/svg+xml'
    case '.ttf':
      return 'font/ttf'
    case '.otf':
      return 'font/otf'
    case '.json':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

export default defineConfig({
  plugins: [msfsCompatibilityPlugin()]
})
