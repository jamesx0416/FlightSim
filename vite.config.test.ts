import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { __viteConfigTestHooks } from './vite.config'

test('package revision middleware versions immutable assets and invalidates on change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'flightsim-vite-cache-'))
  const aircraftRoot = path.join(root, 'aircrafts/example')
  const stockRoot = path.join(root, 'public/vendor/msfs-stock')
  await Promise.all([
    mkdir(aircraftRoot, { recursive: true }),
    mkdir(stockRoot, { recursive: true })
  ])
  const aircraftXml = path.join(aircraftRoot, 'model.xml')
  await Promise.all([
    writeFile(path.join(aircraftRoot, 'layout.json'), '{"content":[{"path":"model.xml"}]}'),
    writeFile(aircraftXml, '<ModelInfo/>'),
    writeFile(path.join(stockRoot, 'layout.json'), '{"content":[]}')
  ])

  try {
    let middleware: ((request: { url?: string }, response: TestResponse, next: () => void) => Promise<void>) | null = null
    const watcher = new EventEmitter()
    const plugin = __viteConfigTestHooks.packageAssetRevisionPlugin('immutable')
    plugin.configureServer?.({
      config: { root },
      middlewares: {
        use(handler: typeof middleware) {
          middleware = handler
        }
      },
      watcher
    } as never)
    expect(middleware == null).toBe(false)

    const firstVersion = await invoke(middleware!, '/aircrafts/example/__asset-version.json')
    const firstRevision = (JSON.parse(firstVersion.body) as { revision: string }).revision
    expect(firstVersion.headers.get('cache-control')).toBe('no-store')

    const versioned = await invoke(
      middleware!,
      `/aircrafts/example/model.xml?assetVersion=${firstRevision}`
    )
    expect(versioned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    const unversioned = await invoke(middleware!, '/aircrafts/example/model.xml')
    expect(unversioned.headers.get('cache-control')).toBe('no-cache')

    await writeFile(aircraftXml, '<ModelInfo><Changed/></ModelInfo>')
    watcher.emit('change', aircraftXml)
    const changedVersion = await invoke(middleware!, '/aircrafts/example/__asset-version.json')
    const changedRevision = (JSON.parse(changedVersion.body) as { revision: string }).revision
    expect(changedRevision === firstRevision).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

class TestResponse {
  statusCode = 0
  readonly headers = new Map<string, string>()
  body = ''

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value)
  }

  end(body: string): void {
    this.body = body
  }
}

async function invoke(
  middleware: (request: { url?: string }, response: TestResponse, next: () => void) => Promise<void>,
  url: string
): Promise<TestResponse> {
  const response = new TestResponse()
  await middleware({ url }, response, () => undefined)
  return response
}
