import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { compileBehaviorPackage } from '../../src/msfs/behavior/compiler.ts'
import { importMsfs2024Package } from '../../scripts/msfs/importer.ts'

test('imports and compiles the modular MSFS 2024 fixture', () => {
  const packageRoot = resolve('fixtures/msfs2024/modular-aircraft')
  const cache = importMsfs2024Package({ packageRoot })

  expect(cache.source.backend).toBe('msfs2024-modular')
  expect(cache.aircraft).toHaveLength(1)

  const aircraft = cache.aircraft[0]
  const variant = aircraft.variants[0]

  expect(variant.resolved.model?.documents.length).toBe(2)
  expect(variant.resolved.panel?.gauges[0]?.resource).toBe('Compat/Passenger/panel.html?Page=1')
  expect(variant.resolved.panel?.instruments.length).toBe(2)
  expect(variant.resolved.sound?.entries.length).toBe(1)

  const compiled = compileBehaviorPackage(cache)
  const compiledVariant = compiled.aircraft[0]?.variants[0]

  expect(compiledVariant?.summary.animationCount).toBeGreaterThan(0)
  expect(compiledVariant?.summary.visibilityCount).toBeGreaterThan(0)
})
