import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { resolvePackageRoot } from '../../scripts/msfs/importer.ts'

test('resolves a direct MSFS 2020 package root', () => {
  const packageRoot = resolve('fixtures/msfs2020/nested-package-parent/example-aircraft')

  expect(resolvePackageRoot(packageRoot)).toBe(packageRoot)
})

test('suggests the nested package root for source-layout parent directories', () => {
  const parentDir = resolve('fixtures/msfs2020/nested-package-parent')
  const packageRoot = resolve('fixtures/msfs2020/nested-package-parent/example-aircraft').replaceAll('\\', '/')

  let thrownError: Error | undefined
  try {
    resolvePackageRoot(parentDir)
  } catch (error) {
    thrownError = error as Error
  }

  expect(thrownError).toBeDefined()
  expect(thrownError?.message).toContain(`Found a nested package root: ${packageRoot}`)
  expect(thrownError?.message).toContain('Pass that path instead.')
})
