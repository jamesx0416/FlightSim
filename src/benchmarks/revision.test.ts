import { expect, test } from 'bun:test'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { startRevisionServer, type RevisionWorkspace } from './revision'

test('revision Vite server isolates its optimizer cache', async () => {
  const root = process.cwd()
  const cwd = path.join(root, '.tmp', `revision-server-test-${crypto.randomUUID()}`)
  await mkdir(cwd, { recursive: true })
  await writeFile(path.join(cwd, 'vite.config.ts'), 'export default {}\n')
  await writeFile(path.join(cwd, 'index.html'), '<script type="module" src="/main.js"></script>\n')
  await writeFile(path.join(cwd, 'main.js'), "import { Vector3 } from 'three'; globalThis.testVector = new Vector3()\n")
  const workspace: RevisionWorkspace = {
    selector: 'test',
    revision: 'test',
    cwd,
    isCurrentWorktree: false,
    cleanup: async () => {}
  }
  const parentMetadataPath = path.join(root, 'node_modules', '.vite', 'deps', '_metadata.json')
  const parentMetadataBefore = await readFile(parentMetadataPath, 'utf8').catch(() => null)
  const server = await startRevisionServer(workspace)
  try {
    const optimizedFiles = await readdir(path.join(cwd, '.benchmarks', 'vite-cache', 'deps'))
    expect(optimizedFiles.includes('three.js')).toBe(true)
    expect((await fetch(server.url)).ok).toBe(true)
    const main = await fetch(`${server.url}/main.js`)
    expect(main.ok).toBe(true)
    const source = await main.text()
    const dependencyPath = /from "([^"]*\/vite-cache\/deps\/three\.js\?v=[^"]+)"/u.exec(source)?.[1]
    expect(dependencyPath == null).toBe(false)
    expect(dependencyPath!.includes('/.benchmarks/vite-cache/')).toBe(true)
    expect((await fetch(new URL(dependencyPath!, server.url))).ok).toBe(true)
    const identity = await (await fetch(`${server.url}/__benchmark/revision.json`, { cache: 'no-store' })).json()
    expect(identity).toEqual({ selector: 'test', revision: 'test' })
    const parentMetadataAfter = await readFile(parentMetadataPath, 'utf8').catch(() => null)
    expect(parentMetadataAfter).toBe(parentMetadataBefore)
  } finally {
    await server.stop()
    await rm(cwd, { recursive: true, force: true })
  }
})
