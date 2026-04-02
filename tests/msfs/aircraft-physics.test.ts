import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { compileBehaviorPackage } from '../../src/msfs/behavior/compiler.ts'
import {
  buildCompatibilityAircraftPhysicsDescriptor,
  hydrateCompatibilityAircraftParams
} from '../../src/sim/MsfsAircraftPhysics.ts'
import { importMsfs2020Package } from '../../scripts/msfs/importer.ts'
import { loadCompatibilityDescriptors } from '../../scripts/msfs/compatibility.ts'

test('builds a generic aircraft profile from MSFS package config files', () => {
  const aircraftRoot = resolve(
    'third_party/flybywire-aircraft/fbw-a380x/src/base/flybywire-aircraft-a380-842/SimObjects/AirPlanes/FlyByWire_A380_842'
  )
  const flightModelCfg = readFileSync(join(aircraftRoot, 'flight_model.cfg'), 'utf8')
  const enginesCfg = readFileSync(join(aircraftRoot, 'engines.cfg'), 'utf8')

  const descriptor = buildCompatibilityAircraftPhysicsDescriptor(flightModelCfg, enginesCfg)
  const hydrated = hydrateCompatibilityAircraftParams(descriptor)

  expect(descriptor.wingSpanM).toBeGreaterThan(75)
  expect(descriptor.maxThrustN).toBeGreaterThan(1_000_000)
  expect(descriptor.configuration?.flapDetents01).toHaveLength(6)
  expect(descriptor.aero.lookup?.alphaCl.breakpoints.length).toBeGreaterThan(4)
  expect(hydrated.aircraftParams.massKg).toBeGreaterThan(400_000)
  expect(hydrated.visualOffsetBodyMeters.x).toBeCloseTo(-18 * 0.3048, 5)
})

test('compatibility descriptors report missing model assets and still carry physics', () => {
  const packageRoot = resolve(
    'third_party/flybywire-aircraft/fbw-a380x/src/base/flybywire-aircraft-a380-842'
  )
  const cache = importMsfs2020Package({ packageRoot })
  const compiled = compileBehaviorPackage(cache)
  const cacheRoot = mkdtempSync(join(tmpdir(), 'msfs-compat-'))
  const behaviorRoot = join(cacheRoot, 'behavior')

  mkdirSync(behaviorRoot, { recursive: true })
  writeFileSync(
    join(cacheRoot, 'a380.msfs2020-import.json'),
    `${JSON.stringify(cache, null, 2)}\n`
  )
  writeFileSync(
    join(behaviorRoot, 'a380.msfs2020-behavior.json'),
    `${JSON.stringify(compiled, null, 2)}\n`
  )

  const bundle = loadCompatibilityDescriptors(cacheRoot)
  const a380Descriptor = bundle.descriptors.find(
    (descriptor) => descriptor.aircraftId === 'FlyByWire_A380_842'
  )

  expect(a380Descriptor).toBeDefined()
  expect(a380Descriptor?.physics).toBeDefined()
  expect(a380Descriptor?.modelSources).toHaveLength(0)
  expect(a380Descriptor?.diagnostics.some((diagnostic) => diagnostic.code === 'model_lod_missing')).toBe(true)
  expect(a380Descriptor?.diagnostics.some((diagnostic) => diagnostic.code === 'model_assets_unavailable')).toBe(true)
})

test('compatibility descriptors can fall back to source model assets when the package model is build-generated', () => {
  const packageRoot = resolve('fixtures/msfs2020/source-model-fallback')
  const cache = importMsfs2020Package({ packageRoot })
  const compiled = compileBehaviorPackage(cache)
  const cacheRoot = mkdtempSync(join(tmpdir(), 'msfs-compat-source-model-'))
  const behaviorRoot = join(cacheRoot, 'behavior')

  mkdirSync(behaviorRoot, { recursive: true })
  writeFileSync(
    join(cacheRoot, 'a32.msfs2020-import.json'),
    `${JSON.stringify(cache, null, 2)}\n`
  )
  writeFileSync(
    join(behaviorRoot, 'a32.msfs2020-behavior.json'),
    `${JSON.stringify(compiled, null, 2)}\n`
  )

  const bundle = loadCompatibilityDescriptors(cacheRoot)
  const aircraftDescriptor = bundle.descriptors.find(
    (descriptor) => descriptor.aircraftId === 'Compat_Generic_Aircraft'
  )

  expect(aircraftDescriptor).toBeDefined()
  expect(aircraftDescriptor?.modelSources.length).toBeGreaterThan(0)
  expect(aircraftDescriptor?.modelSources.some((source) => source.role === 'normal')).toBe(true)
  expect(aircraftDescriptor?.modelSources.some((source) => source.role === 'interior')).toBe(true)
  expect(aircraftDescriptor?.modelSources.some((source) => source.normalizeSourceAsset)).toBe(false)
  expect(
    aircraftDescriptor?.modelSources.every((source) =>
      source.textureManifestUrl?.endsWith('/__source_materialized__/texture-manifest.json')
    )
  ).toBe(true)
  expect(aircraftDescriptor?.modelSources[0]?.modelUrl).toContain('/__source_materialized__/')
  expect(
    aircraftDescriptor?.modelSources.some((source) =>
      source.modelUrl.endsWith(
        '/__source_materialized__/SimObjects/AirPlanes/Compat_Generic_Aircraft/model/CompatExterior_LOD01.gltf'
      )
    )
  ).toBe(true)
  expect(
    aircraftDescriptor?.modelSources.some((source) =>
      source.modelUrl.endsWith(
        '/__source_materialized__/SimObjects/AirPlanes/Compat_Generic_Aircraft/model/CompatInterior_LOD01.gltf'
      )
    )
  ).toBe(true)
  expect(
    existsSync(
      join(
        cacheRoot,
        'source-models',
        cache.source.cacheKey,
        'SimObjects/AirPlanes/Compat_Generic_Aircraft/model/CompatExterior_LOD01.gltf'
      )
    )
  ).toBe(true)
})
