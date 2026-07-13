import { describe, expect, test } from 'bun:test'
import {
  AnimationClip,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  VectorKeyframeTrack,
} from 'three'

import { createSimulatorEngineForAircraft } from '../sim/engine'
import { AircraftRuntime } from './runtime'
import type { CompiledBehaviorSet, RuntimeHostServices } from './types'

const emptyCompiledBehaviorSet: CompiledBehaviorSet = {
  irVersion: 'msfs-behavior/v1',
  aircraftId: 'canonical-visual-test',
  animationBindings: [],
  animationTriggerBindings: [],
  visibilityBindings: [],
  materialBindings: [],
  updateBindings: [],
  inputEventBindings: [],
  interactionBindings: [],
  interactionBlockers: [],
  variableKeys: [],
  builtinFallbackHits: [],
  diagnostics: [],
}

const hostServices: RuntimeHostServices = {
  tick: () => {},
  readVariable: () => 0,
  writeVariable: () => {},
}

describe('AircraftRuntime canonical visual bindings', () => {
  test('samples and restores an authored animation trajectory', () => {
    const scene = new Object3D()
    const lever = new Object3D()
    lever.name = 'Lever'
    scene.add(lever)
    const runtime = new AircraftRuntime({
      ...emptyCompiledBehaviorSet,
      animationBindings: [{
        target: 'LeverAnimation',
        expression: { source: '50', instructions: [{ op: 'pushNumber', value: 50 }], variableKeys: [] },
        length: 100,
        wrap: false,
        delta: false,
        lagFramesPerSecond: 0,
        sourcePath: 'test.xml'
      }]
    }, scene, hostServices)
    runtime.bindAnimations([new AnimationClip('LeverAnimation', 1, [
      new VectorKeyframeTrack('Lever.position', [0, 1], [0, 0, 0, 2, 0, 0])
    ])])
    runtime.update(1 / 60)

    const trajectory = runtime.sampleAnimationObjectTrajectory('LeverAnimation', lever)

    expect(trajectory.map(point => [point.dragPercent, point.position.x])).toEqual([[0, 0], [1, 2]])
    expect(lever.position.x).toBe(1)
  })

  test('maps normalized values across the authored animation key range', () => {
    const scene = new Object3D()
    const lever = new Object3D()
    lever.name = 'Lever'
    scene.add(lever)
    const engine = createSimulatorEngineForAircraft({
      identity: { id: 'detented-aircraft', displayName: 'Detented Aircraft' },
      visuals: [{
        id: 'detented-lever',
        kind: 'control',
        channel: 'animation',
        target: 'detentedlever',
        stateKey: 'visual.detented.ratio',
      }],
    })
    const runtime = new AircraftRuntime(
      emptyCompiledBehaviorSet,
      scene,
      hostServices,
      undefined,
      engine.getAircraft(),
      engine
    )
    runtime.bindAnimations([new AnimationClip('DetentedLever', -1, [
      new VectorKeyframeTrack(
        'Lever.position',
        [1 / 30, 2 / 30, 3 / 30, 4 / 30, 5 / 30],
        [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]
      ),
    ])])

    engine.state.set('visual.detented.ratio', 0.25, {
      source: 'runtime',
      unit: 'ratio',
    })
    runtime.update(1 / 60)
    runtime.update(1 / 60)

    expect(Math.abs(lever.position.x - 1) < 1e-6).toBe(true)
  })

  test('drives animation visibility and material outputs from canonical state', () => {
    const scene = new Object3D()
    const visibilityNode = new Object3D()
    visibilityNode.name = 'DoorNode'
    scene.add(visibilityNode)

    const material = new MeshStandardMaterial({ emissiveIntensity: 1 })
    const materialNode = new Mesh(undefined, material)
    materialNode.name = 'PanelLight'
    scene.add(materialNode)

    const engine = createSimulatorEngineForAircraft({
      identity: { id: 'visual-aircraft', displayName: 'Visual Aircraft' },
      visuals: [
        {
          id: 'flap-animation',
          kind: 'surface',
          channel: 'animation',
          target: 'FlapAnimation',
          stateKey: 'visual.flap.ratio',
        },
        {
          id: 'door-visibility',
          kind: 'door',
          channel: 'visibility',
          target: 'DoorNode',
          stateKey: 'visual.door.visible',
        },
        {
          id: 'panel-material',
          kind: 'light',
          channel: 'material',
          target: 'PanelLight',
          stateKey: 'visual.panel.intensity',
        },
      ],
    })

    const runtime = new AircraftRuntime(
      emptyCompiledBehaviorSet,
      scene,
      hostServices,
      undefined,
      engine.getAircraft(),
      engine
    )
    runtime.bindAnimations([new AnimationClip('FlapAnimation', 2, [])])

    engine.state.set('visual.flap.ratio', 0.4, {
      source: 'runtime',
      unit: 'ratio',
    })
    engine.state.set('visual.door.visible', true, {
      source: 'runtime',
      unit: 'boolean',
    })
    engine.state.set('visual.panel.intensity', 0.75, {
      source: 'runtime',
      unit: 'ratio',
    })

    const state = runtime.update(1 / 60)

    expect(state.canonicalVisualBindings).toEqual([
      {
        id: 'flap-animation',
        kind: 'surface',
        channel: 'animation',
        target: 'FlapAnimation',
        stateKey: 'visual.flap.ratio',
      },
      {
        id: 'door-visibility',
        kind: 'door',
        channel: 'visibility',
        target: 'DoorNode',
        stateKey: 'visual.door.visible',
      },
      {
        id: 'panel-material',
        kind: 'light',
        channel: 'material',
        target: 'PanelLight',
        stateKey: 'visual.panel.intensity',
      },
    ])
    expect(state.animationValues.get('FlapAnimation')).toBe(0.4)
    expect(state.nodeVisibilities.get('DoorNode')).toBe(true)
    expect(visibilityNode.visible).toBe(true)
    expect(state.materialValues.get('PanelLight')).toBe(0.75)
    expect((materialNode.material as MeshStandardMaterial).emissiveIntensity).toBe(
      0.75
    )
  })
})
