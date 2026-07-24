import { describe, expect, test } from 'bun:test'
import {
  AnimationClip,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  VectorKeyframeTrack,
} from 'three'

import { ControlStateKeys, createSimulatorEngineForAircraft, SurfaceStateKeys } from '../sim/engine'
import { AircraftRuntime, SharedMsfsRuntimeHost } from './runtime'
import type { CompiledBehaviorSet, CompiledInteractionBinding, RuntimeHostServices } from './types'

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
  test('stores alternating update O: mirrors without changing canonical controls', () => {
    const host = new SharedMsfsRuntimeHost([])
    const runtime = new AircraftRuntime({
      ...emptyCompiledBehaviorSet,
      updateBindings: [{
        expression: {
          source: '(L:UPDATE_MIRROR, number) (>O:LEVER_SPEEDBRAKE:POSITION)',
          instructions: [
            { op: 'pushVariable', key: 'L:UPDATE_MIRROR', unit: 'number' },
            { op: 'writeVariable', key: 'O:LEVER_SPEEDBRAKE:POSITION', unit: null },
          ],
          variableKeys: [],
        },
        sourcePath: 'test.xml',
        frequency: 0,
        once: false,
      }],
    }, new Object3D(), host, undefined, host.simulatorEngine.getAircraft(), host.simulatorEngine)

    host.invokeKeyEvent('SPOILERS_ARM_SET', [1])
    for (const position of [1, 0, 2]) {
      host.writeVariable('L:UPDATE_MIRROR', position)
      runtime.update(1 / 60)
    }

    expect(host.readVariable('O:LEVER_SPEEDBRAKE:POSITION')).toBe(2)
    expect(host.simulatorEngine.state.readBoolean(ControlStateKeys.spoilersArmed())).toBe(true)
    expect(host.simulatorEngine.state.readNumber(
      SurfaceStateKeys.targetRatio('spoilers'),
      { unit: 'ratio' }
    )).toBe(0)
  })

  test('keeps an unsynced trajectory engagement until its first drag sample', () => {
    const host = new SharedMsfsRuntimeHost([])
    const interaction = {
      target: 'LEVER',
      feedbackTargets: [],
      feedbackVariableKeys: [],
      soundEvents: [],
      minHeldDurationSeconds: 0,
      animationDurationSeconds: null,
      repeatFrequencyHz: null,
      expression: {
        source: '2 (>O:LEVER:Position)',
        instructions: [
          { op: 'pushNumber' as const, value: 2 },
          { op: 'writeVariable' as const, key: 'O:LEVER:Position', unit: null }
        ],
        variableKeys: []
      },
      releaseExpression: null,
      sourcePath: 'test.xml',
      metadata: {
        authoredId: 'LEVER', qualifiedId: 'test.xml#LEVER', nodeId: 'LEVER', componentId: null,
        inputEventIds: [], routes: [], sourceKind: 'callbackCode' as const, sourcePath: 'test.xml',
        sourceTemplate: null, templateRevision: null, lockable: false, dynamicEventHandling: false,
        disabled: false, disabledInVr: false, prioritizeVCockpits: false, ignoreZTest: false,
        highlightNodeId: 'LEVER', axis: 'y' as const, inverted: false, dragAnimationName: 'Lever',
        dragMode: 'default' as const, dragAnimationSynced: true, dragScalar: 0.025,
        discreteGate: null, wheelPrimaryToggle: false, cursor: null, tooltipTitle: null,
        tooltipDescription: null, tooltipStateLabels: [], tooltipUnavailable: null,
        tooltipValueLabel: null, tooltipActionHints: [], tooltipValueExpression: null,
        value: { variableKey: null, unit: null, minimum: null, maximum: null, step: null,
          increaseStep: null, decreaseStep: null, increaseStepExpression: null, decreaseStepExpression: null,
          cyclic: false, cyclicUpperInclusive: null, settleTimeSeconds: 0, stateExpression: null,
          setStates: [] }
      }
    } satisfies CompiledInteractionBinding
    const trajectory = {
      ...interaction,
      metadata: { ...interaction.metadata, dragMode: 'trajectory' as const, dragAnimationSynced: false }
    }
    const runtime = new AircraftRuntime({
      ...emptyCompiledBehaviorSet,
      interactionBindings: [interaction, trajectory],
      updateBindings: [{
        expression: {
          source: '1 (>O:LEVER:Position)',
          instructions: [
            { op: 'pushNumber', value: 1 },
            { op: 'writeVariable', key: 'O:LEVER:Position', unit: null }
          ],
          variableKeys: []
        },
        sourcePath: 'test.xml', frequency: 30, once: false
      }]
    }, new Object3D(), host)

    runtime.executeInteractionBindingDirect(interaction, { holdFeedback: true, mouseEvent: 'LeftSingle' })
    runtime.update(1 / 30)
    expect(host.readVariable('O:LEVER:Position')).toBe(2)

    runtime.executeInteractionBindingDirect(trajectory, { holdFeedback: true, mouseEvent: 'LeftDrag' })
    runtime.update(1 / 30)
    expect(host.readVariable('O:LEVER:Position')).toBe(1)
  })

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
