import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { defineConfig, loadEnv, type Plugin, type PreviewServer, type ViteDevServer } from 'vite'

const execFileAsync = promisify(execFile)

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const aircraftCacheMode = parseAircraftCacheMode(env.FLIGHTSIM_AIRCRAFT_CACHE_MODE)

  return {
    define: {
      __FLIGHTSIM_AIRCRAFT_CACHE_MODE__: JSON.stringify(aircraftCacheMode)
    },
    plugins: [
      packageAssetRevisionPlugin(aircraftCacheMode),
      aircraftsIndexPlugin(),
      devMetadataPlugin(),
      devUrlsPlugin()
    ],
    server: {
      allowedHosts: ['.ts.net'],
      host: true
    }
  }
})

type AircraftCacheMode = 'normal' | 'no-store' | 'no-cache' | 'immutable'

function parseAircraftCacheMode(value: string | undefined): AircraftCacheMode {
  switch (value) {
    case 'no-store':
    case 'no-cache':
    case 'immutable':
      return value
    default:
      return 'normal'
  }
}

function devUrlsPlugin(): Plugin {
  return {
    name: 'dev-urls',
    configureServer(server) {
      const printUrls = server.printUrls

      server.printUrls = () => {
        addUrl(server.resolvedUrls?.local, process.env.PORTLESS_URL)
        addUrl(server.resolvedUrls?.network, process.env.TAILSCALE_URL)
        printUrls()
      }
    }
  }
}

function addUrl(urls: string[] | undefined, url: string | undefined): void {
  if (!urls || !url) return

  const normalizedUrl = url.endsWith('/') ? url : `${url}/`

  if (!urls.includes(normalizedUrl)) {
    urls.push(normalizedUrl)
  }
}

type LocalPackage = {
  readonly rootUrl: string
  readonly directory: string
}

function packageAssetRevisionPlugin(mode: AircraftCacheMode): Plugin {
  const revisions = new Map<string, Promise<string>>()

  const getRevision = (packageSource: LocalPackage): Promise<string> => {
    const revision = revisions.get(packageSource.rootUrl)
    if (revision != null) return revision

    const pendingRevision = readPackageRevision(packageSource.directory)
    revisions.set(packageSource.rootUrl, pendingRevision)
    void pendingRevision.catch(() => {
      if (revisions.get(packageSource.rootUrl) === pendingRevision) {
        revisions.delete(packageSource.rootUrl)
      }
    })
    return pendingRevision
  }

  const initialize = async (root: string): Promise<void> => {
    const aircraftsDirectory = path.resolve(root, 'aircrafts')
    const aircraftPackages = await readdir(aircraftsDirectory, {
      withFileTypes: true
    })
    const packages: LocalPackage[] = aircraftPackages
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        rootUrl: `/aircrafts/${encodeURIComponent(entry.name)}/`,
        directory: path.join(aircraftsDirectory, entry.name)
      }))
    packages.push({
      rootUrl: '/vendor/msfs-stock/',
      directory: path.resolve(root, 'public/vendor/msfs-stock')
    })
    await Promise.all(packages.map(getRevision))
  }

  const install = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use(async (request, response, next) => {
      const requestUrl = parseRequestUrl(request.url)
      const packageSource = requestUrl == null ? null : matchLocalPackage(server.config.root, requestUrl.pathname)
      if (requestUrl == null || packageSource == null) {
        next()
        return
      }

      if (requestUrl.pathname === `${packageSource.rootUrl}__asset-version.json`) {
        try {
          sendJson(response, 200, {
            revision: await getRevision(packageSource)
          })
        } catch {
          sendJson(response, 404, { error: 'Package root not found.' })
        }
        return
      }

      const cacheControl = await getPackageCacheControl(mode, requestUrl, packageSource, getRevision)
      if (cacheControl != null) response.setHeader('Cache-Control', cacheControl)
      next()
    })
  }

  return {
    name: 'package-asset-revisions',
    configureServer(server) {
      void initialize(server.config.root).catch(() => undefined)
      install(server)
      const refresh = (file: string): void => {
        const packageSource = matchLocalPackageFile(server.config.root, file)
        if (packageSource != null) revisions.delete(packageSource.rootUrl)
      }
      server.watcher.on('add', refresh).on('change', refresh).on('unlink', refresh)
    },
    configurePreviewServer(server) {
      void initialize(server.config.root).catch(() => undefined)
      install(server)
    }
  }
}

export const __viteConfigTestHooks = {
  packageAssetRevisionPlugin
}

function parseRequestUrl(requestUrl: string | undefined): URL | null {
  if (requestUrl == null) return null
  try {
    return new URL(requestUrl, 'http://localhost')
  } catch {
    return null
  }
}

function matchLocalPackage(root: string, pathname: string): LocalPackage | null {
  if (pathname.startsWith('/vendor/msfs-stock/')) {
    return {
      rootUrl: '/vendor/msfs-stock/',
      directory: path.resolve(root, 'public/vendor/msfs-stock')
    }
  }

  const match = /^\/aircrafts\/([^/]+)\//u.exec(pathname)
  if (match == null) return null

  const packageName = safeDecodeURIComponent(match[1]!)
  if (packageName === '.' || packageName === '..' || packageName.includes('/') || packageName.includes('\\')) {
    return null
  }

  return {
    rootUrl: `/aircrafts/${match[1]!}/`,
    directory: path.resolve(root, 'aircrafts', packageName)
  }
}

function matchLocalPackageFile(root: string, file: string): LocalPackage | null {
  const absoluteFile = path.resolve(file)
  const stockDirectory = path.resolve(root, 'public/vendor/msfs-stock')
  if (isWithinDirectory(stockDirectory, absoluteFile)) {
    return { rootUrl: '/vendor/msfs-stock/', directory: stockDirectory }
  }

  const aircraftsDirectory = path.resolve(root, 'aircrafts')
  const relativeFile = path.relative(aircraftsDirectory, absoluteFile)
  if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) return null
  const packageName = relativeFile.split(path.sep)[0]
  if (!packageName) return null
  return {
    rootUrl: `/aircrafts/${encodeURIComponent(packageName)}/`,
    directory: path.join(aircraftsDirectory, packageName)
  }
}

function isWithinDirectory(directory: string, file: string): boolean {
  const relativeFile = path.relative(directory, file)
  return relativeFile === '' || (!relativeFile.startsWith('..') && !path.isAbsolute(relativeFile))
}

async function getPackageCacheControl(
  mode: AircraftCacheMode,
  requestUrl: URL,
  packageSource: LocalPackage,
  getRevision: (packageSource: LocalPackage) => Promise<string>
): Promise<string | null> {
  switch (mode) {
    case 'immutable':
      try {
        return requestUrl.searchParams.get('assetVersion') === (await getRevision(packageSource))
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      } catch {
        return 'no-cache'
      }
    case 'no-cache':
      return 'no-cache'
    case 'no-store':
      return 'no-store'
    case 'normal':
      return null
  }
}

async function readPackageRevision(directory: string): Promise<string> {
  const metadata: string[] = []
  await collectPackageMetadata(directory, '', metadata)
  metadata.sort()
  return createHash('sha256').update(metadata.join('\n')).digest('hex').slice(0, 16)
}

async function collectPackageMetadata(directory: string, prefix: string, metadata: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries.map(async (entry) => {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await collectPackageMetadata(entryPath, relativePath, metadata)
      } else if (entry.isFile()) {
        const fileStat = await stat(entryPath)
        metadata.push(`${relativePath}\0${fileStat.size}\0${fileStat.mtimeMs}`)
      }
    })
  )
}

function aircraftsIndexPlugin(): Plugin {
  const route = '/aircrafts/index.json'

  return {
    name: 'aircrafts-index',
    configureServer(server) {
      server.middlewares.use(route, async (_request, response) => {
        await sendAircraftsIndex(server.config.root, response)
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use(route, async (_request, response) => {
        await sendAircraftsIndex(server.config.root, response)
      })
    }
  }
}

function devMetadataPlugin(): Plugin {
  const route = '/__devapi/git.json'

  return {
    name: 'devapi-git-metadata',
    configureServer(server) {
      server.middlewares.use(route, async (_request, response) => {
        await sendGitMetadata(server.config.root, response)
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use(route, async (_request, response) => {
        await sendGitMetadata(server.config.root, response)
      })
    }
  }
}

async function sendGitMetadata(
  root: string,
  response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }
): Promise<void> {
  const metadata = await readGitMetadata(root)
  response.statusCode = 200
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(metadata))
}

async function readGitMetadata(root: string): Promise<Record<string, unknown>> {
  try {
    const [hash, shortHash, branch, status] = await Promise.all([
      execGit(root, ['rev-parse', 'HEAD']),
      execGit(root, ['rev-parse', '--short', 'HEAD']),
      execGit(root, ['branch', '--show-current']),
      execGit(root, ['status', '--porcelain'])
    ])

    return {
      available: true,
      hash,
      shortHash,
      branch: branch || null,
      dirty: status.length > 0
    }
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function execGit(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root })
  return stdout.trim()
}

function sendJson(
  response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void },
  statusCode: number,
  payload: unknown
): void {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(payload))
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function sendAircraftsIndex(
  root: string,
  response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }
): Promise<void> {
  const aircraftsDirectory = path.join(root, 'aircrafts')

  try {
    const entries = await readdir(aircraftsDirectory, { withFileTypes: true })
    const packages = (
      await Promise.all(
        entries
          .filter(entry => entry.isDirectory())
          .map(async entry => {
            const packageDirectory = path.join(aircraftsDirectory, entry.name)
            return (await hasAircraftLayout(packageDirectory)) ? `/aircrafts/${entry.name}/` : null
          })
      )
    )
      .filter((packageRoot): packageRoot is string => packageRoot != null)
      .sort((left, right) => left.localeCompare(right))

    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ packages }))
  } catch {
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ packages: [] }))
  }
}

async function hasAircraftLayout(packageDirectory: string): Promise<boolean> {
  try {
    const text = await readFile(path.join(packageDirectory, 'layout.json'), 'utf8')
    const payload = JSON.parse(text) as {
      readonly content?: readonly {
        readonly path?: string
      }[]
    }
    return (payload.content ?? []).some(entry =>
      /(^|\/)simobjects\/airplanes\/.+\/aircraft\.cfg$/iu.test(entry.path ?? '')
    )
  } catch {
    return false
  }
}
