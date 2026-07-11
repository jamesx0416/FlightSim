import { expect, test } from 'bun:test'

import { __behaviorTestHooks } from './behavior'
import type { BehaviorSourceRoot } from './types'

function include(relativeFile: string): Element {
  return {
    attributes: [{ name: 'RelativeFile', value: relativeFile }]
  } as unknown as Element
}

function loadedDocument(path: string, includes: readonly string[]) {
  return {
    rootUrl: 'https://example.test/package/',
    path,
    document: {} as Document,
    rootElement: {
      querySelectorAll: (selector: string) =>
        selector === 'Include' ? includes.map(include) : []
    } as unknown as Element
  }
}

test('behavior documents fetch by level and retain deterministic depth-first order', async () => {
  const paths = ['root.xml', 'a.xml', 'b.xml', 'shared.xml']
  const root: BehaviorSourceRoot = {
    rootUrl: 'https://example.test/package/',
    revision: 'test',
    layoutPathIndex: new Map(paths.map(path => [path, path])),
    resolveAssetUrl: path => new URL(path, 'https://example.test/package/').toString()
  }
  const documents = new Map([
    ['root.xml', loadedDocument('root.xml', ['a.xml', 'b.xml'])],
    ['a.xml', loadedDocument('a.xml', ['shared.xml'])],
    ['b.xml', loadedDocument('b.xml', ['shared.xml', 'root.xml'])],
    ['shared.xml', loadedDocument('shared.xml', [])]
  ])
  const loadedDocuments = new Map()
  const context = {
    pkg: {},
    aircraft: {},
    diagnostics: [],
    templateMap: new Map(),
    parameterFunctionMap: new Map(),
    loadedDocuments,
    sourceRoots: [root],
    builtinFallbackHits: new Set(),
    animationTriggerBindings: []
  }
  const starts: string[] = []
  let releaseA = (): void => {}
  const waitForA = new Promise<void>(resolve => {
    releaseA = resolve
  })
  let markSiblingsStarted = (): void => {}
  const siblingsStarted = new Promise<void>(resolve => {
    markSiblingsStarted = resolve
  })
  const load = async (_root: BehaviorSourceRoot, path: string) => {
    starts.push(path)
    if (path === 'b.xml') markSiblingsStarted()
    if (path === 'a.xml') await waitForA
    return documents.get(path) ?? null
  }

  const pending = __behaviorTestHooks.loadBehaviorDocuments(
    ['root.xml'],
    context as never,
    root,
    load
  )
  await siblingsStarted

  expect(starts).toEqual(['root.xml', 'a.xml', 'b.xml'])
  releaseA()
  await pending

  expect(starts).toEqual(['root.xml', 'a.xml', 'b.xml', 'shared.xml'])
  expect([...loadedDocuments.keys()]).toEqual([
    'https://example.test/package/::test::root.xml',
    'https://example.test/package/::test::a.xml',
    'https://example.test/package/::test::shared.xml',
    'https://example.test/package/::test::b.xml'
  ])
})
