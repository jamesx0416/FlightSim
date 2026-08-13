import { describe, expect, test } from 'bun:test'
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  VectorKeyframeTrack,
} from 'three'

import {
  AirPhysicsStateKeys,
  ControlStateKeys,
  createSimulatorEngineForAircraft,
  SurfaceStateKeys,
} from '../sim/engine'
import { __behaviorTestHooks } from './behavior'
import { AircraftRuntime, SharedMsfsRuntimeHost } from './runtime'
import type { CompiledBehaviorSet, ImportedAircraft, RuntimeHostServices } from './types'

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
  interactionCompilerTotals: { candidates: 0, compiledBindings: 0, rejectedBindings: 0, rejectionReasons: {} },
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
  test('exposes physics-driven left and right WingFlex through MSFS simvars', () => {
    const host = new SharedMsfsRuntimeHost([])
    for (const [key, value] of [
      [AirPhysicsStateKeys.wingLeftFlexRatio(), 0.25],
      [AirPhysicsStateKeys.wingRightFlexRatio(), -0.1],
    ] as const) {
      host.simulatorEngine.state.define({ key, unit: 'ratio', valueType: 'number' })
      host.simulatorEngine.state.set(key, value, { source: 'runtime', unit: 'ratio' })
    }

    expect(host.readVariable('A:WING FLEX PCT:1', 'percent over 100')).toBe(0.25)
    expect(host.readVariable('A:WING FLEX PCT:2', 'percent over 100')).toBe(-0.1)
    expect(host.readVariable('A:WING FLEX PCT', 'percent over 100')).toBe(0.075)
  })

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

  test('samples and restores an authored animation trajectory', () => {
    const scene = new Object3D()
    const lever = new Object3D()
    lever.name = 'Lever'
    const grip = new Object3D()
    grip.position.x = 1
    lever.add(grip)
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
    const anchoredTrajectory = runtime.sampleAnimationObjectTrajectory(
      'LeverAnimation',
      grip,
      new Vector3()
    )

    expect(trajectory.map(point => [point.dragPercent, point.position.x])).toEqual([[0, 0], [1, 2]])
    expect(anchoredTrajectory.map(point => [point.dragPercent, point.position.x])).toEqual([[0, 1], [1, 3]])
    expect(lever.position.x).toBe(1)

    const resolvedTrajectory = runtime.sampleAnimationObjectTrajectory('LeverAnimation')
    expect(resolvedTrajectory.map(point => [point.dragPercent, point.position.x])).toEqual([[0, 0], [1, 2]])
  })

  test('initializes lagged animations at their authoritative value', () => {
    let authoritativeValue = 80
    const scene = new Object3D()
    const lever = new Object3D()
    lever.name = 'Lever'
    scene.add(lever)
    const runtime = new AircraftRuntime({
      ...emptyCompiledBehaviorSet,
      animationBindings: [{
        target: 'LeverAnimation',
        expression: {
          source: '(A:LEVER POSITION, percent)',
          instructions: [{ op: 'pushVariable', key: 'A:LEVER POSITION', unit: 'percent' }],
          variableKeys: ['A:LEVER POSITION'],
        },
        length: 100,
        wrap: false,
        delta: false,
        lagFramesPerSecond: 10,
        sourcePath: 'test.xml'
      }]
    }, scene, {
      ...hostServices,
      readVariable: () => authoritativeValue,
    })
    runtime.bindAnimations([new AnimationClip('LeverAnimation', 1, [
      new VectorKeyframeTrack('Lever.position', [0, 1], [0, 0, 0, 10, 0, 0])
    ])])

    expect(runtime.update(0.1).animationValues.get('LeverAnimation')).toBe(80)
    expect(lever.position.x).toBe(8)

    authoritativeValue = 100
    expect(runtime.update(0.1).animationValues.get('LeverAnimation')).toBe(81)
  })

  test('reuses stable animation dependencies and observes changes on the next frame', () => {
    let value = 25
    const scene = new Object3D()
    const runtime = new AircraftRuntime({
      ...emptyCompiledBehaviorSet,
      animationBindings: [{
        target: 'CachedAnimation',
        expression: {
          source: '(L:CACHED_VALUE, number)',
          instructions: [{ op: 'pushVariable', key: 'L:CACHED_VALUE', unit: 'number' }],
          variableKeys: ['L:CACHED_VALUE']
        },
        length: 100,
        wrap: false,
        delta: false,
        lagFramesPerSecond: 0,
        sourcePath: 'test.xml'
      }]
    }, scene, { ...hostServices, readVariable: () => value })
    runtime.bindAnimations([new AnimationClip('CachedAnimation', 1, [])])

    expect(runtime.update(1 / 60).animationValues.get('CachedAnimation')).toBe(25)
    expect(runtime.update(1 / 60).animationValues.get('CachedAnimation')).toBe(25)
    value = 75
    expect(runtime.update(1 / 60).animationValues.get('CachedAnimation')).toBe(75)
  })

  test('bypasses authored animation lag only while DragUseAnimLag is false', () => {
    const createRuntime = (useAnimLag: boolean) => {
      let value = 0
      const params = new Map([
        ['NODE_ID', 'Lever'],
        ['MOUSEFLAGS', 'LeftDrag'],
        ['DRAG_ANIM_NAME', 'LeverAnimation'],
        ['DRAG_USE_ANIM_LAG', useAnimLag ? 'True' : 'False']
      ])
      const interaction = __behaviorTestHooks.buildInteractionCodeBinding(
        '100 (>L:LEVER_VALUE)', null, params, 'Lever', 'test.xml', 'callback', []
      )!
      const scene = new Object3D()
      const lever = new Object3D()
      lever.name = 'Lever'
      scene.add(lever)
      const runtime = new AircraftRuntime({
        ...emptyCompiledBehaviorSet,
        animationBindings: [{
          target: 'LeverAnimation',
          expression: {
            source: '(L:LEVER_VALUE, number)',
            instructions: [{ op: 'pushVariable', key: 'L:LEVER_VALUE', unit: 'number' }],
            variableKeys: ['L:LEVER_VALUE']
          },
          length: 100,
          wrap: false,
          delta: false,
          lagFramesPerSecond: 10,
          sourcePath: 'test.xml'
        }],
        interactionBindings: [interaction]
      }, scene, {
        ...hostServices,
        readVariable: () => value,
        writeVariable: (_key, nextValue) => { value = nextValue }
      })
      runtime.bindAnimations([new AnimationClip('LeverAnimation', 1, [
        new VectorKeyframeTrack('Lever.position', [0, 1], [0, 0, 0, 10, 0, 0])
      ])])
      runtime.update(0.1)
      return { runtime, interaction, getValue: () => value, setValue: (next: number) => { value = next } }
    }

    const direct = createRuntime(false)
    expect(direct.runtime.executeInteractionBindingDirect(direct.interaction, { mouseEvent: 'LeftDrag' })).toBe(true)
    expect(direct.getValue()).toBe(100)
    expect(direct.runtime.update(0.1).animationValues.get('LeverAnimation')).toBe(100)
    direct.runtime.releaseInteractionBinding(direct.interaction)
    direct.setValue(0)
    expect(direct.runtime.update(0.1).animationValues.get('LeverAnimation')).toBe(99)

    const lagged = createRuntime(true)
    expect(lagged.runtime.executeInteractionBindingDirect(lagged.interaction, { mouseEvent: 'LeftDrag' })).toBe(true)
    expect(lagged.runtime.update(0.1).animationValues.get('LeverAnimation')).toBe(1)
  })

  test('evaluates a read-only dynamic tooltip label for the current authored state', () => {
    const params = new Map([
      ['NODE_ID', 'TEST_FORMAT'],
      ['MOUSEFLAGS', 'LeftSingle'],
      ['SWITCH_POSITION_TYPE', 'L'],
      ['SWITCH_POSITION_VAR', 'TEST_STATE'],
      ['TT_VALUE_0', "(L:LABEL_MODE, number) if{ 'Armed' } els{ 'Off' }"],
      ['TT_VALUE_0_IS_DYNAMIC', 'True'],
      ['TT_VALUE_1', "'On'"]
    ])
    const interaction = __behaviorTestHooks.buildInteractionCodeBinding(
      "(M:Event) 'LeftSingle' scmi 0 == if{ 1 (>L:TEST_STATE, number) }",
      null,
      params,
      'TEST_FORMAT',
      'test.xml',
      'callback',
      []
    )!
    const host = new SharedMsfsRuntimeHost([])
    const runtime = new AircraftRuntime({
      ...emptyCompiledBehaviorSet,
      interactionBindings: [interaction]
    }, new Object3D(), host, undefined, host.simulatorEngine.getAircraft(), host.simulatorEngine)

    host.writeVariable('L:TEST_STATE', 0, 'number')
    host.writeVariable('L:LABEL_MODE', 1, 'number')
    expect(runtime.evaluateInteractionFormattedValue(interaction)).toBe('Armed')

    host.writeVariable('L:TEST_STATE', 1, 'number')
    expect(runtime.evaluateInteractionFormattedValue(interaction)).toBe(null)
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

  test('standard WingFlex follows one smooth curve and linked surfaces inherit its tangent', () => {
    const scene = new Object3D()
    const makeChain = (side: 'LEFT' | 'RIGHT', rootZ: number) => {
      const root = new Bone()
      root.name = `WING_BONE_00_${side}`
      root.position.z = rootZ
      scene.add(root)
      const sideSign = side === 'LEFT' ? 1 : -1
      const bones = Array.from({ length: 4 }, (_, index) => {
        const bone = new Bone()
        bone.name = `WING_BONE_0${index + 1}_${side}`
        bone.position.set(sideSign, 0, -0.25)
        return bone
      })
      root.add(bones[0])
      for (let index = 1; index < bones.length; index += 1) bones[index - 1].add(bones[index])
      return bones
    }
    const leftBones = makeChain('LEFT', 0)
    const rightBones = makeChain('RIGHT', 2)
    const leftRoot = leftBones[0].parent!

    const innerSlat = new Bone()
    innerSlat.name = 'WING_BONE_SLATE_00_LEFT'
    innerSlat.position.set(0.45, 0, 0.1)
    leftRoot.add(innerSlat)
    const outerSlat = new Bone()
    outerSlat.name = 'WING_BONE_SLATE_02_LEFT'
    outerSlat.position.set(0.1, 0, 0.1)
    leftBones[1].add(outerSlat)

    const innerFlap = new Bone()
    innerFlap.name = 'WING_BONE_FLAPS_00_LEFT'
    innerFlap.position.set(0.7, -0.05, -0.1)
    leftRoot.add(innerFlap)
    const outerFlap = new Bone()
    outerFlap.name = 'WING_BONE_FLAPS_01_LEFT'
    outerFlap.position.set(0.1, -0.05, -0.1)
    leftBones[1].add(outerFlap)

    const wingGeometry = new BufferGeometry()
    wingGeometry.setAttribute('position', new Float32BufferAttribute([1.5, 0, -0.375, 1.2, 0, 0], 3))
    wingGeometry.setAttribute('skinIndex', new Uint16BufferAttribute([1, 0, 0, 0, 6, 0, 0, 0], 4))
    wingGeometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0], 4))
    const wingMesh = Object.assign(new Object3D(), {
      isSkinnedMesh: true,
      geometry: wingGeometry,
      skeleton: { bones: [leftRoot, ...leftBones, innerSlat, outerSlat] },
    })
    scene.add(wingMesh)

    const rigidFlapGeometry = new BufferGeometry()
    rigidFlapGeometry.setAttribute('position', new Float32BufferAttribute([
      0.8, -0.05, -0.1,
      1.4, -0.05, -0.1,
      2.0, -0.05, -0.1,
      2.6, -0.05, -0.1,
    ], 3))
    rigidFlapGeometry.setAttribute('skinIndex', new Uint16BufferAttribute([
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ], 4))
    rigidFlapGeometry.setAttribute('skinWeight', new Float32BufferAttribute([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ], 4))
    const rigidFlapMesh = new SkinnedMesh(rigidFlapGeometry, new MeshStandardMaterial())
    scene.add(rigidFlapMesh)
    scene.updateMatrixWorld(true)
    rigidFlapMesh.bind(new Skeleton([outerFlap]))

    const leftPivot = new Object3D()
    leftPivot.name = 'Engine_PIVOT_1_LEFT'
    leftPivot.position.set(0.8, 0, -0.05)
    leftPivot.rotation.set(0.1, -0.2, 0.3)
    const neutralLeftPivotQuaternion = leftPivot.quaternion.clone()
    scene.add(leftPivot)
    const rightPivot = new Object3D()
    rightPivot.name = 'Engine_PIVOT_1_RIGHT'
    rightPivot.position.set(-0.8, 0, 1.95)
    scene.add(rightPivot)

    let leftFlex = 0
    let rightFlex = 0
    const aircraft = {
      model: {
        nodeAnimations: [{
          type: 'WingFlex',
          nodes: [
            ...leftBones.map(node => node.name),
            ...rightBones.map(node => node.name),
            leftPivot.name,
            rightPivot.name,
          ],
        }],
      },
    } as unknown as ImportedAircraft
    const runtime = new AircraftRuntime(emptyCompiledBehaviorSet, scene, {
      ...hostServices,
      readVariable: key => key.endsWith(':1') ? leftFlex : key.endsWith(':2') ? rightFlex : 0,
    }, aircraft)
    const smoothedWeights = wingGeometry.getAttribute('skinWeight')
    expect(smoothedWeights.getX(0) > 0 && smoothedWeights.getX(0) < 1).toBe(true)
    expect(smoothedWeights.getY(0) > 0 && smoothedWeights.getY(0) < 1).toBe(true)
    expect(smoothedWeights.getX(1) > 0 && smoothedWeights.getX(1) < 1).toBe(true)
    expect(smoothedWeights.getY(1) > 0 && smoothedWeights.getY(1) < 1).toBe(true)
    expect(rigidFlapMesh.skeleton.bones.length).toBe(5)
    const rigidFlapWeights = rigidFlapGeometry.getAttribute('skinWeight')
    expect(rigidFlapWeights.getX(1) > 0 && rigidFlapWeights.getX(1) < 1).toBe(true)
    expect(rigidFlapWeights.getY(1) > 0 && rigidFlapWeights.getY(1) < 1).toBe(true)

    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    const neutralLeftStations = leftBones.map(node => node.getWorldPosition(new Vector3()))
    const neutralRightTip = rightBones.at(-1)!.getWorldPosition(new Vector3())
    const neutralInnerSlat = innerSlat.getWorldPosition(new Vector3())
    const neutralOuterSlat = outerSlat.getWorldPosition(new Vector3())
    const neutralInnerFlap = innerFlap.getWorldPosition(new Vector3())
    const neutralOuterFlap = outerFlap.getWorldPosition(new Vector3())
    const neutralLeftPivot = leftPivot.getWorldPosition(new Vector3())
    const neutralBoneWorldQuaternions = leftBones.map(node => node.getWorldQuaternion(new Quaternion()))
    const neutralRigidFlapBones = rigidFlapMesh.skeleton.bones.map(node => node.getWorldPosition(new Vector3()))

    leftFlex = 0.5
    rightFlex = 0.5
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    const flexedLeftStations = leftBones.map(node => node.getWorldPosition(new Vector3()))
    const flexedRightTip = rightBones.at(-1)!.getWorldPosition(new Vector3())
    const deflections = flexedLeftStations.map((point, index) => point.y - neutralLeftStations[index]!.y)
    expect(deflections.every((value, index) => index === 0 || value > deflections[index - 1]!)).toBe(true)
    expect(flexedRightTip.y > neutralRightTip.y).toBe(true)
    expect(innerSlat.getWorldPosition(new Vector3()).y > neutralInnerSlat.y).toBe(true)
    expect(innerFlap.getWorldPosition(new Vector3()).y > neutralInnerFlap.y).toBe(true)
    expect(outerSlat.getWorldPosition(new Vector3()).y > neutralOuterSlat.y).toBe(true)
    expect(outerFlap.getWorldPosition(new Vector3()).y > neutralOuterFlap.y).toBe(true)
    expect(leftPivot.getWorldPosition(new Vector3()).y > neutralLeftPivot.y).toBe(true)
    expect(leftPivot.quaternion.angleTo(neutralLeftPivotQuaternion) < 1e-9).toBe(true)
    const rigidFlapDeflections = rigidFlapMesh.skeleton.bones.map((node, index) =>
      node.getWorldPosition(new Vector3()).y - neutralRigidFlapBones[index]!.y
    )
    expect(rigidFlapDeflections.every((value, index) =>
      index === 0 || value > rigidFlapDeflections[index - 1]!
    )).toBe(true)
    const tangentRotations = leftBones.map((node, index) =>
      node.getWorldQuaternion(new Quaternion()).angleTo(neutralBoneWorldQuaternions[index]!)
    )
    expect(tangentRotations.every((value, index) =>
      index === 0 || value > tangentRotations[index - 1]!
    )).toBe(true)

    leftFlex = 0
    rightFlex = 0
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    expect(leftBones.at(-1)!.getWorldPosition(new Vector3()).distanceTo(neutralLeftStations.at(-1)!) < 1e-9).toBe(true)
    expect(rightBones.at(-1)!.getWorldPosition(new Vector3()).distanceTo(neutralRightTip) < 1e-9).toBe(true)
    expect(outerSlat.getWorldPosition(new Vector3()).distanceTo(neutralOuterSlat) < 1e-9).toBe(true)
    expect(outerFlap.getWorldPosition(new Vector3()).distanceTo(neutralOuterFlap) < 1e-9).toBe(true)
    expect(leftPivot.getWorldPosition(new Vector3()).distanceTo(neutralLeftPivot) < 1e-9).toBe(true)
  })
})
