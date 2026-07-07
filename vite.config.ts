import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const execFileAsync = promisify(execFile)

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      localAircraftCachePlugin(env.FLIGHTSIM_AIRCRAFT_CACHE === '1'),
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

function localAircraftCachePlugin(enabled: boolean): Plugin {
  return {
    name: 'local-aircraft-cache',
    configureServer(server) {
      if (!enabled) return

      server.middlewares.use('/aircrafts/', (_request, response, next) => {
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        next()
      })
    }
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
