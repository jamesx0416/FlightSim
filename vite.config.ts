import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'

const FBW_MODEL_DIR = resolve(
  'third_party/flybywire-aircraft/fbw-a32nx/src/model/a320-exterior'
)
const FBW_TEXTURE_DIRS = [
  resolve(
    'third_party/flybywire-aircraft/fbw-a32nx/src/base/flybywire-aircraft-a320-neo/SimObjects/AirPlanes/_FlyByWire_A320_NEO-LIVERY/TEXTURE.FBW'
  ),
  resolve(
    'third_party/flybywire-aircraft/fbw-a32nx/src/base/flybywire-aircraft-a320-neo/SimObjects/AirPlanes/FlyByWire_A320_NEO/TEXTURE'
  )
] as const
const FBW_VENDOR_ROOT = '/vendor/fbw-a32nx'
const FBW_MODEL_ROUTE = `${FBW_VENDOR_ROOT}/model/`
const FBW_TEXTURE_ROUTE = `${FBW_VENDOR_ROOT}/textures/`
const FBW_MANIFEST_ROUTE = `${FBW_VENDOR_ROOT}/texture-manifest.json`

function fbwA32nxAssetsPlugin(): Plugin {
  const textureFiles = collectTextureFiles()
  const availableTextures = [...textureFiles.keys()].sort()
  const manifestJson = JSON.stringify({ available: availableTextures }, null, 2)

  return {
    name: 'fbw-a32nx-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!serveFbwAsset(req, res, textureFiles, manifestJson)) {
          next()
        }
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!serveFbwAsset(req, res, textureFiles, manifestJson)) {
          next()
        }
      })
    },
    closeBundle() {
      const vendorRoot = resolve('dist', 'vendor', 'fbw-a32nx')
      const modelOutDir = join(vendorRoot, 'model')
      const texturesOutDir = join(vendorRoot, 'textures')
      mkdirSync(modelOutDir, { recursive: true })
      mkdirSync(texturesOutDir, { recursive: true })

      for (const fileName of ['A320_NEO_LOD00.gltf', 'A320_NEO_LOD00.bin']) {
        const src = join(FBW_MODEL_DIR, fileName)
        if (existsSync(src)) {
          copyFileSync(src, join(modelOutDir, fileName))
        }
      }

      for (const [fileName, sourcePath] of textureFiles) {
        copyFileSync(sourcePath, join(texturesOutDir, fileName))
      }

      writeFileSync(join(vendorRoot, 'texture-manifest.json'), manifestJson)
    }
  }
}

function collectTextureFiles(): Map<string, string> {
  const files = new Map<string, string>()

  for (const directory of FBW_TEXTURE_DIRS) {
    if (!existsSync(directory)) continue

    for (const entry of readdirSync(directory)) {
      const absolutePath = join(directory, entry)
      if (!statSync(absolutePath).isFile()) continue
      if (!entry.toUpperCase().endsWith('.DDS')) continue
      if (!files.has(entry)) {
        files.set(entry, absolutePath)
      }
    }
  }

  return files
}

function serveFbwAsset(
  req: IncomingMessage,
  res: ServerResponse,
  textureFiles: Map<string, string>,
  manifestJson: string
): boolean {
  const rawUrl = req.url
  if (!rawUrl) return false

  const pathname = new URL(rawUrl, 'http://localhost').pathname
  if (pathname === FBW_MANIFEST_ROUTE) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(manifestJson)
    return true
  }

  if (pathname.startsWith(FBW_MODEL_ROUTE)) {
    const fileName = pathname.slice(FBW_MODEL_ROUTE.length)
    if (fileName.includes('/')) {
      res.statusCode = 404
      res.end()
      return true
    }

    const filePath = join(FBW_MODEL_DIR, fileName)
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.statusCode = 404
      res.end()
      return true
    }

    streamFile(res, filePath)
    return true
  }

  if (pathname.startsWith(FBW_TEXTURE_ROUTE)) {
    const fileName = pathname.slice(FBW_TEXTURE_ROUTE.length)
    if (fileName.includes('/')) {
      res.statusCode = 404
      res.end()
      return true
    }

    const filePath = textureFiles.get(fileName)
    if (!filePath) {
      res.statusCode = 404
      res.end()
      return true
    }

    streamFile(res, filePath)
    return true
  }

  return false
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
    case '.dds':
      return 'image/vnd-ms.dds'
    case '.json':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

export default defineConfig({
  plugins: [fbwA32nxAssetsPlugin()]
})
