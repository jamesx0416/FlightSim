import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { compileBehaviorPackage } from '../../src/msfs/behavior/compiler.ts'
import { AircraftCompatibilityRuntime } from '../../src/msfs/runtime/host.ts'
import type { AircraftCompatibilityDescriptor } from '../../src/msfs/runtime/descriptor.ts'
import { importMsfs2024Package } from '../../scripts/msfs/importer.ts'

function createFixtureDescriptor(): AircraftCompatibilityDescriptor {
  const packageRoot = resolve('fixtures/msfs2024/modular-aircraft')
  const cache = importMsfs2024Package({ packageRoot })
  const compiled = compileBehaviorPackage(cache)
  const aircraft = cache.aircraft[0]
  const variant = aircraft.variants[0]
  const compiledVariant = compiled.aircraft[0].variants[0]

  return {
    schemaVersion: 'msfs.compatibility.descriptor.v0',
    id: 'fixture-runtime',
    label: 'Fixture Runtime',
    source: {
      backend: cache.source.backend,
      cacheKey: cache.source.cacheKey,
      packageRoot: cache.source.packageRoot,
      packageRouteRoot: '/msfs/packages/fixture'
    },
    aircraftId: aircraft.aircraftId,
    variantId: variant.id,
    title: variant.title,
    uiType: variant.uiType,
    uiVariation: variant.uiVariation,
    trackedVariables: compiledVariant.symbols.variables,
    modelSources: [],
    panel: variant.resolved.panel
      ? {
          configPath: variant.resolved.panel.configPath,
          xmlPath: variant.resolved.panel.xmlPath,
          surfaces: [],
          instruments: variant.resolved.panel.instruments
        }
      : undefined,
    wasm: {
      gauges: []
    },
    sound: variant.resolved.sound,
    compiledBehavior: compiledVariant,
    diagnostics: []
  }
}

test('runtime evaluates compiled behavior, visibility, and sound state', () => {
  const descriptor = createFixtureDescriptor()

  const runtime = new AircraftCompatibilityRuntime(descriptor)
  runtime.setVariable(
    {
      namespace: 'lvar',
      name: 'L:COMPAT_AUDIO',
      unit: 'number'
    },
    1
  )
  runtime.tick({
    dtSeconds: 0.1,
    elapsedSeconds: 1,
    wheelCycle01: 0.25,
    visualState: {
      aileron: 0,
      elevator: 0,
      rudder: 0,
      flaps01: 0.3,
      gear01: 0.2,
      spoiler01: 0
    },
    telemetry: {
      airspeedMps: 120,
      altitudeMeters: 1000
    },
    angularRatesBodyRadPerSec: {
      x: 0,
      y: 0,
      z: 0
    }
  })

  const flapAnimation = runtime.getAnimationOutputs().find(
    (entry) => entry.binding.animName === 'compat_common_flap'
  )
  const wingletVisibility = runtime.getVisibilityOutputs().find(
    (entry) => entry.binding.nodeId === 'WINGLET_NODE'
  )
  const activeSound = runtime.getActiveSounds().find(
    (entry) => entry.eventName === 'compat_hum'
  )

  expect(flapAnimation?.value).toBeCloseTo(30, 5)
  expect(wingletVisibility?.visible).toBe(true)
  expect(activeSound?.active).toBe(true)
})

test('runtime seeds startup variables from the compatibility descriptor', () => {
  const descriptor = createFixtureDescriptor()
  descriptor.startupVariables = [
    {
      reference: {
        namespace: 'lvar',
        name: 'L:COMPAT_AUDIO',
        unit: 'number'
      },
      value: 1
    }
  ]

  const runtime = new AircraftCompatibilityRuntime(descriptor)
  runtime.tick({
    dtSeconds: 0.1,
    elapsedSeconds: 1,
    wheelCycle01: 0.25,
    visualState: {
      aileron: 0,
      elevator: 0,
      rudder: 0,
      flaps01: 0,
      gear01: 1,
      spoiler01: 0
    },
    telemetry: {
      airspeedMps: 0,
      altitudeMeters: 0
    },
    angularRatesBodyRadPerSec: {
      x: 0,
      y: 0,
      z: 0
    }
  })

  const activeSound = runtime.getActiveSounds().find(
    (entry) => entry.eventName === 'compat_hum'
  )

  expect(
    runtime.getVariable({
      namespace: 'lvar',
      name: 'L:COMPAT_AUDIO',
      unit: 'number'
    })
  ).toBe(1)
  expect(activeSound?.active).toBe(true)
})
