import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

export default defineConfig({
  plugins: [aircraftsIndexPlugin()],
  server: {
    host: true
  }
})

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
