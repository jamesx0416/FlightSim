import { describe, expect, test } from 'bun:test'
import {
  AnimationClip,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Uint16BufferAttribute,
  Vector3,
  VectorKeyframeTrack,
  Skeleton,
  SkinnedMesh,
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


  test('WingFlex shares authored local joint blends across wing primitives', () => {
    const scene = new Object3D()
    const root = new Bone()
    root.name = 'WING_BONE_00_LEFT'
    scene.add(root)
    const bones = Array.from({ length: 4 }, (_, index) => {
      const bone = new Bone()
      bone.name = `WING_BONE_0${index + 1}_LEFT`
      bone.position.x = 1
      return bone
    })
    root.add(bones[0])
    for (let index = 1; index < bones.length; index += 1) bones[index - 1].add(bones[index])

    const makeWingMesh = (
      positions: number[],
      indices: number[]
    ): Object3D => {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
      geometry.setAttribute('skinIndex', new Uint16BufferAttribute(
        indices.flatMap(index => [index, 0, 0, 0]),
        4
      ))
      geometry.setAttribute('skinWeight', new Float32BufferAttribute(
        indices.flatMap(() => [1, 0, 0, 0]),
        4
      ))
      const mesh = Object.assign(new Object3D(), {
        isSkinnedMesh: true,
        geometry,
        skeleton: { bones: [root, ...bones] },
      })
      scene.add(mesh)
      return mesh
    }

    makeWingMesh([
      0.4, 0, 0, 0.6, 0, 0,
      1.4, 0, 0, 1.6, 0, 0,
      2.4, 0, 0, 2.6, 0, 0,
      3.4, 0, 0, 3.6, 0, 0,
    ], [1, 1, 2, 2, 3, 3, 4, 4])
    const blendGeometry = new BufferGeometry()
    blendGeometry.setAttribute('position', new Float32BufferAttribute([
      1.4, 0, 0,
      1.6, 0, 0,
    ], 3))
    blendGeometry.setAttribute('skinIndex', new Uint16BufferAttribute([
      1, 2, 0, 0,
      1, 2, 0, 0,
    ], 4))
    blendGeometry.setAttribute('skinWeight', new Float32BufferAttribute([
      0.75, 0.25, 0, 0,
      0.25, 0.75, 0, 0,
    ], 4))
    scene.add(Object.assign(new Object3D(), {
      isSkinnedMesh: true,
      geometry: blendGeometry,
      skeleton: { bones: [root, ...bones] },
    }))
    const target = makeWingMesh([
      0.7, 0, 0,
      1.45, 0, 0,
    ], [1, 1]) as Object3D & { geometry: BufferGeometry }

    const targetIndicesBefore = Array.from(target.geometry.getAttribute('skinIndex').array)
    const targetWeightsBefore = Array.from(target.geometry.getAttribute('skinWeight').array)
    const blendIndicesBefore = Array.from(blendGeometry.getAttribute('skinIndex').array)
    const blendWeightsBefore = Array.from(blendGeometry.getAttribute('skinWeight').array)

    const aircraft = {
      model: {
        nodeAnimations: [{
          type: 'WingFlex',
          nodes: bones.map(node => node.name),
        }],
      },
    } as unknown as ImportedAircraft
    let flex = 0
    const wingFlexHostServices = {
      ...hostServices,
      readVariable: (key: string) => key.endsWith(':1') ? flex : 0,
    }
    scene.updateMatrixWorld(true)
    const restBoneWorldMatrices = bones.map(bone => bone.matrixWorld.clone())
    const runtime = new AircraftRuntime(
      emptyCompiledBehaviorSet,
      scene,
      wingFlexHostServices,
      aircraft
    )

    const targetIndices = target.geometry.getAttribute('skinIndex')
    const targetWeights = target.geometry.getAttribute('skinWeight')
    expect(targetIndices.getX(0)).toBe(1)
    expect(targetWeights.getX(0)).toBe(1)
    expect(targetWeights.getY(0)).toBe(0)
    expect(targetIndices.getX(1)).toBe(1)
    expect(targetIndices.getY(1)).toBe(2)
    expect(targetWeights.getX(1) > 0 && targetWeights.getX(1) < 1).toBe(true)
    expect(targetWeights.getY(1) > 0 && targetWeights.getY(1) < 1).toBe(true)
    expect(Array.from(blendGeometry.getAttribute('skinIndex').array)).toEqual(blendIndicesBefore)
    expect(JSON.stringify(Array.from(blendGeometry.getAttribute('skinWeight').array)) !== JSON.stringify(blendWeightsBefore)).toBe(true)
    expect(JSON.stringify(Array.from(target.geometry.getAttribute('skinIndex').array)) !== JSON.stringify(targetIndicesBefore)).toBe(true)
    expect(JSON.stringify(Array.from(target.geometry.getAttribute('skinWeight').array)) !== JSON.stringify(targetWeightsBefore)).toBe(true)

    // Each rigid section is fitted to the chord between the same authored joint
    // boundaries. Two adjacent bone transforms must therefore agree on their
    // shared boundary instead of producing a small downward step there.
    flex = 0.5
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    const boundaryPoint = new Vector3(1.5, 0, 0)
    const deformByBone = (boneIndex: number): Vector3 => boundaryPoint.clone().applyMatrix4(
      bones[boneIndex]!.matrixWorld.clone().multiply(
        restBoneWorldMatrices[boneIndex]!.clone().invert()
      )
    )
    const inboardBoundary = deformByBone(0)
    const outboardBoundary = deformByBone(1)
    expect(Math.abs(inboardBoundary.y - outboardBoundary.y) < 5e-4).toBe(true)
    expect(inboardBoundary.distanceTo(outboardBoundary) < 5e-3).toBe(true)
  })

  test('standard WingFlex bends smoothly and preserves authored wing-mounted hierarchy', () => {
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
    const leftRoot = leftBones[0].parent! as Bone
    const slat = new Bone()
    slat.name = 'WING_BONE_SLATE_00_LEFT'
    slat.position.set(0.45, 0, 0.1)
    leftBones[0].add(slat)
    const outboardSlat = new Bone()
    outboardSlat.name = 'WING_BONE_SLATE_02_LEFT'
    outboardSlat.position.set(0.45, 0, 0.1)
    leftBones[0].add(outboardSlat)
    const flapCarrier = new Object3D()
    leftBones[0].add(flapCarrier)
    const flap = new Bone()
    flap.name = 'WING_BONE_FLAPS_00_LEFT'
    flap.position.set(0.7, -0.05, -0.1)
    flapCarrier.add(flap)
    const leftPivot = new Bone()
    leftPivot.name = 'Engine_PIVOT_1_LEFT'
    leftPivot.position.set(0.8, 0, -0.05)
    leftPivot.rotation.set(0.1, -0.2, 0.3)
    const neutralLeftPivotQuaternion = leftPivot.quaternion.clone()
    scene.add(leftPivot)
    const rightPivot = new Bone()
    rightPivot.name = 'Engine_PIVOT_1_RIGHT'
    rightPivot.position.set(-0.8, 0, 1.95)
    scene.add(rightPivot)

    const wingGeometry = new BufferGeometry()
    wingGeometry.setAttribute('position', new Float32BufferAttribute([
      1.5, 0, -0.375,
      0.45, 0, 0.1,
      0.95, 0, 0,
      1.45, 0, -0.15,
      0.7, -0.05, -0.1,
      1.2, -0.05, -0.1,
    ], 3))
    wingGeometry.setAttribute('skinIndex', new Uint16BufferAttribute([
      1, 0, 0, 0,
      5, 0, 0, 0,
      5, 0, 0, 0,
      6, 0, 0, 0,
      7, 0, 0, 0,
      7, 0, 0, 0,
    ], 4))
    wingGeometry.setAttribute('skinWeight', new Float32BufferAttribute([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ], 4))
    const wingMesh = Object.assign(new Object3D(), {
      isSkinnedMesh: true,
      geometry: wingGeometry,
      skeleton: { bones: [leftRoot, ...leftBones, slat, outboardSlat, flap] },
    })
    scene.add(wingMesh)

    const seamMainGeometry = new BufferGeometry()
    seamMainGeometry.setAttribute('position', new Float32BufferAttribute([
      0.5, 0, 0,
      1.5, 0, -0.2,
      1.5, 0, 0.2,
    ], 3))
    seamMainGeometry.setAttribute('skinIndex', new Uint16BufferAttribute([
      0, 0, 0, 0,
      1, 0, 0, 0,
      2, 0, 0, 0,
    ], 4))
    seamMainGeometry.setAttribute('skinWeight', new Float32BufferAttribute([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ], 4))
    const seamMain = new SkinnedMesh(seamMainGeometry, new MeshStandardMaterial())
    scene.add(seamMain)
    scene.updateMatrixWorld(true)
    seamMain.bind(new Skeleton([leftRoot, ...leftBones]), new Matrix4())

    const seamFollowerGeometry = new BufferGeometry()
    seamFollowerGeometry.setAttribute('position', new Float32BufferAttribute([
      7 / 6, 0, 0,
    ], 3))
    seamFollowerGeometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0], 4))
    seamFollowerGeometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0], 4))
    const seamFollower = new SkinnedMesh(seamFollowerGeometry, new MeshStandardMaterial())
    scene.add(seamFollower)
    scene.updateMatrixWorld(true)
    seamFollower.bind(new Skeleton([leftPivot]), new Matrix4())

    const skinnedPoint = (mesh: SkinnedMesh, vertexIndex: number): Vector3 => {
      const position = mesh.geometry.getAttribute('position')
      const point = new Vector3().fromBufferAttribute(position, vertexIndex)
      mesh.applyBoneTransform(vertexIndex, point)
      return mesh.localToWorld(point)
    }
    const seamMainAnchor = (): Vector3 => skinnedPoint(seamMain, 0)
      .add(skinnedPoint(seamMain, 1))
      .add(skinnedPoint(seamMain, 2))
      .multiplyScalar(1 / 3)
    const seamFollowerPoint = (): Vector3 => skinnedPoint(seamFollower, 0)

    let leftFlex = 0
    let rightFlex = 0
    let slatAnimationValue = 0
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
    const wingFlexHostServices = {
      ...hostServices,
      readVariable: (key: string) => key === 'A:SLAT TEST'
        ? slatAnimationValue
        : key.endsWith(':1')
          ? leftFlex
          : key.endsWith(':2') ? rightFlex : 0,
    }
    const wingFlexCompiledBehaviorSet: CompiledBehaviorSet = {
      ...emptyCompiledBehaviorSet,
      animationBindings: [{
        target: 'SlatAnimation',
        expression: {
          source: '(A:SLAT TEST, percent)',
          instructions: [{ op: 'pushVariable', key: 'A:SLAT TEST', unit: 'percent' }],
          variableKeys: ['A:SLAT TEST'],
        },
        length: 100,
        wrap: false,
        delta: false,
        lagFramesPerSecond: 0,
        sourcePath: 'test.xml',
      }],
    }
    const slatStart = slat.position.toArray()
    const outboardSlatStart = outboardSlat.position.toArray()
    const slatClip = new AnimationClip('SlatAnimation', 1, [
      new VectorKeyframeTrack(`${slat.name}.position`, [0, 1], [
        ...slatStart, slatStart[0]!, slatStart[1]!, slatStart[2]! + 0.3,
      ]),
      new VectorKeyframeTrack(`${outboardSlat.name}.position`, [0, 1], [
        ...outboardSlatStart, outboardSlatStart[0]!, outboardSlatStart[1]!, outboardSlatStart[2]! + 0.3,
      ]),
    ])
    let runtime = new AircraftRuntime(wingFlexCompiledBehaviorSet, scene, wingFlexHostServices, aircraft)
    runtime.bindAnimations([slatClip])
    const smoothedWeights = wingGeometry.getAttribute('skinWeight')
    // This synthetic wing has no authored mixed-weight exemplar, so the local
    // transition smoother intentionally leaves its rigid source weights alone.
    expect(smoothedWeights.getX(0)).toBe(1)
    expect(smoothedWeights.getY(0)).toBe(0)
    expect(smoothedWeights.getX(2)).toBe(1)
    expect(smoothedWeights.getY(2)).toBe(0)
    const firstIndices = Array.from(wingGeometry.getAttribute('skinIndex').array)
    const firstWeights = Array.from(smoothedWeights.array)

    runtime = new AircraftRuntime(wingFlexCompiledBehaviorSet, scene, wingFlexHostServices, aircraft)
    runtime.bindAnimations([slatClip])
    expect(Array.from(wingGeometry.getAttribute('skinIndex').array)).toEqual(firstIndices)
    expect(Array.from(wingGeometry.getAttribute('skinWeight').array)).toEqual(firstWeights)

    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    const neutralLeftStations = leftBones.map(node => node.getWorldPosition(new Vector3()))
    const neutralLeftRoot = leftRoot.getWorldPosition(new Vector3())
    const neutralLeftSegmentLengths = neutralLeftStations.map((point, index) => point.distanceTo(
      index === 0 ? neutralLeftRoot : neutralLeftStations[index - 1]!
    ))
    const neutralLeftTip = neutralLeftStations.at(-1)!
    const neutralRightTip = rightBones.at(-1)!.getWorldPosition(new Vector3())
    const neutralLeftPivot = leftPivot.getWorldPosition(new Vector3())
    const neutralSlat = slat.getWorldPosition(new Vector3())
    const neutralOutboardSlat = outboardSlat.getWorldPosition(new Vector3())
    const neutralFlap = flap.getWorldPosition(new Vector3())
    const neutralBoneQuaternions = leftBones.map(node => node.quaternion.clone())
    const neutralSeamFollower = seamFollowerPoint()
    const neutralSeamDistance = seamMainAnchor().distanceTo(neutralSeamFollower)
    expect(neutralSeamDistance < 1e-6).toBe(true)

    leftFlex = 0.5
    rightFlex = 0.5
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    const flexedLeftStations = leftBones.map(node => node.getWorldPosition(new Vector3()))
    const flexedLeftTip = flexedLeftStations.at(-1)!
    const flexedRightTip = rightBones.at(-1)!.getWorldPosition(new Vector3())
    const firstFlexedSection = flexedLeftStations[1]!.clone().sub(flexedLeftStations[0]!)
    const expectedTipAngle = 0.5 * (5 * Math.PI / 180) * leftBones.length
    const deflectionFactor = (s: number): number =>
      s * s - 0.5 * s * s * s + 0.125 * s * s * s * s
    const expectedFirstSectionAngle = Math.atan2(
      4 * expectedTipAngle * (deflectionFactor(0.5) - deflectionFactor(0.25)),
      1
    )
    expect(Math.abs(
      Math.atan2(firstFlexedSection.y, firstFlexedSection.x) - expectedFirstSectionAngle
    ) < 1e-6).toBe(true)
    expect(flexedLeftTip.y > neutralLeftTip.y).toBe(true)
    expect(flexedRightTip.y > neutralRightTip.y).toBe(true)
    // Section-centred WingFlex is allowed to translate helper pivots. The visible
    // rigid section, not the arbitrary helper location, is the deformation anchor.
    expect(flexedLeftStations[0]!.distanceTo(neutralLeftStations[0]!) > 1e-6).toBe(true)
    expect(Math.abs(flexedLeftTip.z - neutralLeftTip.z) < 1e-9).toBe(true)
    expect(Math.abs(flexedRightTip.z - neutralRightTip.z) < 1e-9).toBe(true)
    expect(slat.getWorldPosition(new Vector3()).distanceTo(neutralSlat) > 1e-6).toBe(true)
    expect(flap.getWorldPosition(new Vector3()).distanceTo(neutralFlap) > 1e-6).toBe(true)
    expect(outboardSlat.getWorldPosition(new Vector3()).distanceTo(neutralOutboardSlat) > 1e-6).toBe(true)
    expect(leftPivot.getWorldPosition(new Vector3()).distanceTo(neutralLeftPivot) > 1e-6).toBe(true)
    expect(leftPivot.quaternion.angleTo(neutralLeftPivotQuaternion) < 1e-9).toBe(true)
    const inboardIncrement = leftBones[0].quaternion.angleTo(neutralBoneQuaternions[0])
    const tipIncrement = leftBones.at(-1)!.quaternion.angleTo(neutralBoneQuaternions.at(-1)!)
    expect(inboardIncrement > 1e-6).toBe(true)
    expect(tipIncrement > 1e-6).toBe(true)
    expect(seamFollowerPoint().distanceTo(neutralSeamFollower) > 1e-6).toBe(true)

    const flexedSlat = slat.getWorldPosition(new Vector3())
    slatAnimationValue = 100
    runtime.update(1 / 60)
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    expect(slat.getWorldPosition(new Vector3()).distanceTo(flexedSlat) > 0.1).toBe(true)
    slatAnimationValue = 0
    runtime.update(1 / 60)
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    expect(slat.getWorldPosition(new Vector3()).distanceTo(flexedSlat) < 1e-6).toBe(true)

    leftFlex = 0
    rightFlex = 0
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    expect(leftBones.at(-1)!.getWorldPosition(new Vector3()).distanceTo(neutralLeftTip) < 1e-9).toBe(true)
    expect(rightBones.at(-1)!.getWorldPosition(new Vector3()).distanceTo(neutralRightTip) < 1e-9).toBe(true)
    expect(slat.getWorldPosition(new Vector3()).distanceTo(neutralSlat) < 1e-6).toBe(true)
    expect(outboardSlat.getWorldPosition(new Vector3()).distanceTo(neutralOutboardSlat) < 1e-6).toBe(true)
    expect(flap.getWorldPosition(new Vector3()).distanceTo(neutralFlap) < 1e-6).toBe(true)
    expect(leftPivot.getWorldPosition(new Vector3()).distanceTo(neutralLeftPivot) < 1e-9).toBe(true)

    const overlappingSurfaceGeometry = new BufferGeometry()
    overlappingSurfaceGeometry.setAttribute('position', new Float32BufferAttribute([
      0.7, 0, 0.1,
      0.9, 0, 0.1,
    ], 3))
    overlappingSurfaceGeometry.setAttribute('skinIndex', new Uint16BufferAttribute([
      0, 1, 0, 0,
      0, 1, 0, 0,
    ], 4))
    overlappingSurfaceGeometry.setAttribute('skinWeight', new Uint16BufferAttribute([
      26214, 39314, 0, 0,
      39314, 26214, 0, 0,
    ], 4, true))
    const overlappingSurface = new SkinnedMesh(
      overlappingSurfaceGeometry,
      new MeshStandardMaterial()
    )
    scene.add(overlappingSurface)
    scene.updateMatrixWorld(true)
    overlappingSurface.bind(
      new Skeleton([slat, outboardSlat]),
      new Matrix4()
    )
    // A surface can inherit the wing hierarchy as well as being skinned to animated surface bones.
    // WingFlex must use the authored skinned pose, not apply that inherited flex a second time.
    leftBones[0].attach(overlappingSurface)
    scene.updateMatrixWorld(true)
    const aircraftTransform = new Object3D()
    aircraftTransform.position.set(10, -3, 4000)
    aircraftTransform.add(scene)
    aircraftTransform.updateMatrixWorld(true)
    const overlappingSlatClip = new AnimationClip('SlatAnimation', 1, [
      new VectorKeyframeTrack(`${slat.name}.position`, [0, 1], [
        ...slatStart, slatStart[0]!, slatStart[1]!, slatStart[2]! + 0.3,
      ]),
      new QuaternionKeyframeTrack(`${slat.name}.quaternion`, [0, 1], [
        0, 0, 0, 1,
        0, 0, Math.sin(0.4), Math.cos(0.4),
      ]),
      new VectorKeyframeTrack(`${outboardSlat.name}.position`, [0, 1], [
        ...outboardSlatStart, outboardSlatStart[0]!, outboardSlatStart[1]!, outboardSlatStart[2]! + 0.3,
      ]),
      new QuaternionKeyframeTrack(`${outboardSlat.name}.quaternion`, [0, 1], [
        0, 0, 0, 1,
        0, 0, Math.sin(0.4), Math.cos(0.4),
      ]),
    ])
    runtime = new AircraftRuntime(wingFlexCompiledBehaviorSet, scene, wingFlexHostServices, aircraft)
    runtime.bindAnimations([overlappingSlatClip])
    const normalizedSurfaceWeights = overlappingSurface.geometry.getAttribute('skinWeight')
    for (let index = 0; index < normalizedSurfaceWeights.count; index += 1) {
      expect(Math.abs(
        normalizedSurfaceWeights.getX(index) +
        normalizedSurfaceWeights.getY(index) +
        normalizedSurfaceWeights.getZ(index) +
        normalizedSurfaceWeights.getW(index) -
        65528 / 65535
      ) < 1e-9).toBe(true)
    }
    const overlappingSurfacePoint = (vertexIndex: number): Vector3 => {
      const position = overlappingSurface.geometry.getAttribute('position')
      const point = new Vector3().fromBufferAttribute(position, vertexIndex)
      overlappingSurface.applyBoneTransform(vertexIndex, point)
      return overlappingSurface.localToWorld(point)
    }
    slatAnimationValue = 100
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    const overlappingSurfaceNeutral = [0, 1].map(overlappingSurfacePoint)
    leftFlex = 0.5
    rightFlex = 0.5
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    const overlappingSurfaceFlex = [0, 1].map(overlappingSurfacePoint)
    for (let index = 0; index < overlappingSurfaceNeutral.length; index += 1) {
      expect(overlappingSurfaceFlex[index]!.distanceTo(overlappingSurfaceNeutral[index]!) > 1e-5).toBe(true)
    }
    const neutralSurfaceSpan = overlappingSurfaceNeutral[1]!.clone().sub(overlappingSurfaceNeutral[0]!)
    const flexedSurfaceSpan = overlappingSurfaceFlex[1]!.clone().sub(overlappingSurfaceFlex[0]!)
    expect(flexedSurfaceSpan.distanceTo(neutralSurfaceSpan) > 1e-6).toBe(true)
    leftFlex = 0
    rightFlex = 0
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    for (let index = 0; index < overlappingSurfaceNeutral.length; index += 1) {
      expect(overlappingSurfacePoint(index).distanceTo(overlappingSurfaceNeutral[index]!) < 1e-6).toBe(true)
    }

    runtime = new AircraftRuntime(wingFlexCompiledBehaviorSet, scene, wingFlexHostServices, aircraft)
    runtime.bindAnimations([overlappingSlatClip])
    runtime.update(1 / 60)
    leftFlex = 0.5
    rightFlex = 0.5
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    for (let index = 0; index < overlappingSurfaceFlex.length; index += 1) {
      expect(overlappingSurfacePoint(index).distanceTo(overlappingSurfaceFlex[index]!) < 2e-3).toBe(true)
    }
  })

  test('WingFlex preserves rigid one-bone animated surfaces through authored hierarchy', () => {
    const scene = new Object3D()
    const root = new Bone()
    root.name = 'WING_BONE_00_LEFT'
    scene.add(root)
    const bones = Array.from({ length: 4 }, (_, index) => {
      const bone = new Bone()
      bone.name = `WING_BONE_0${index + 1}_LEFT`
      bone.position.x = 1
      return bone
    })
    root.add(bones[0])
    for (let index = 1; index < bones.length; index += 1) bones[index - 1].add(bones[index])

    const makeMainSurface = (positions: number[]): SkinnedMesh => {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
      geometry.setAttribute('skinIndex', new Uint16BufferAttribute([
        2, 0, 0, 0,
        3, 0, 0, 0,
        3, 0, 0, 0,
      ], 4))
      geometry.setAttribute('skinWeight', new Float32BufferAttribute([
        1, 0, 0, 0,
        1, 0, 0, 0,
        1, 0, 0, 0,
      ], 4))
      const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial())
      scene.add(mesh)
      scene.updateMatrixWorld(true)
      mesh.bind(new Skeleton([root, ...bones]), new Matrix4())
      return mesh
    }

    const wingSurface = makeMainSurface([
      1.8, 0, -0.2,
      2.2, 0, -0.2,
      2.0, 0, 0.2,
    ])
    makeMainSurface([
      2.001, -0.1, -0.2,
      2.001, 0.1, -0.2,
      2.001, 0.01, 0.2,
    ])

    const flapArmature = new Object3D()
    bones[0].add(flapArmature)
    const flap = new Bone()
    flap.name = 'WING_BONE_FLAPS_00_LEFT'
    flap.position.x = 2
    flapArmature.add(flap)

    const followerGeometry = new BufferGeometry()
    followerGeometry.setAttribute('position', new Float32BufferAttribute([
      1.9, 0.3, -0.2,
      2.1, 0.3, -0.2,
      2.0, 0.3, 0.2,
    ], 3))
    followerGeometry.setAttribute('skinIndex', new Uint16BufferAttribute([
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ], 4))
    followerGeometry.setAttribute('skinWeight', new Float32BufferAttribute([
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ], 4))
    const follower = new SkinnedMesh(followerGeometry, new MeshStandardMaterial())
    const followerWrapper = new Object3D()
    flapArmature.add(followerWrapper)
    followerWrapper.add(follower)
    scene.updateMatrixWorld(true)
    follower.bind(new Skeleton([flap]), new Matrix4())

    let flex = 0
    const aircraft = {
      model: {
        nodeAnimations: [{ type: 'WingFlex', nodes: bones.map(node => node.name) }],
      },
    } as unknown as ImportedAircraft
    const services = {
      ...hostServices,
      readVariable: (key: string) => key.startsWith('A:WING FLEX PCT') ? flex : 0,
    }
    const compiled: CompiledBehaviorSet = {
      ...emptyCompiledBehaviorSet,
      animationBindings: [{
        target: 'FlapAnimation',
        expression: { source: '0', instructions: [{ op: 'pushNumber', value: 0 }], variableKeys: [] },
        length: 100,
        wrap: false,
        delta: false,
        lagFramesPerSecond: 0,
        sourcePath: 'test.xml',
      }],
    }
    const flapStart = flap.position.toArray()
    const clip = new AnimationClip('FlapAnimation', 1, [
      new VectorKeyframeTrack(`${flap.name}.position`, [0, 1], [
        ...flapStart, flapStart[0]!, flapStart[1]!, flapStart[2]! + 0.2,
      ]),
    ])
    const runtime = new AircraftRuntime(compiled, scene, services, aircraft)
    runtime.bindAnimations([clip])

    const skinnedPoint = (mesh: SkinnedMesh, vertexIndex: number): Vector3 => {
      const point = new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), vertexIndex)
      mesh.applyBoneTransform(vertexIndex, point)
      return mesh.localToWorld(point)
    }
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    const neutral = skinnedPoint(follower, 2)
    const neutralSpan = skinnedPoint(follower, 0).distanceTo(skinnedPoint(follower, 1))

    flex = 0.5
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    expect(skinnedPoint(follower, 2).distanceTo(neutral) > 1e-4).toBe(true)
    expect(Math.abs(
      skinnedPoint(follower, 0).distanceTo(skinnedPoint(follower, 1)) - neutralSpan
    ) < 1e-6).toBe(true)
  })

  test('WingFlex leaves subdivision disabled for authored one-bone animated surfaces', () => {
    const scene = new Object3D()
    const root = new Bone()
    root.name = 'WING_BONE_00_LEFT'
    scene.add(root)
    const bones = Array.from({ length: 4 }, (_, index) => {
      const bone = new Bone()
      bone.name = `WING_BONE_0${index + 1}_LEFT`
      bone.position.x = 1
      return bone
    })
    root.add(bones[0])
    for (let index = 1; index < bones.length; index += 1) bones[index - 1].add(bones[index])

    const armature = new Object3D()
    bones[0].add(armature)
    const flap = new Bone()
    flap.name = 'WING_BONE_FLAPS_00_LEFT'
    flap.position.x = 1
    armature.add(flap)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0, 2.5, 0, 0, 0, 0, 0.2,
    ], 3))
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ], 4))
    geometry.setAttribute('skinWeight', new Float32BufferAttribute([
      1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
    ], 4))
    const surface = new SkinnedMesh(geometry, new MeshStandardMaterial())
    const meshWrapper = new Object3D()
    armature.add(meshWrapper)
    meshWrapper.add(surface)
    scene.updateMatrixWorld(true)
    surface.bind(new Skeleton([flap]), new Matrix4())

    let flex = 0
    const aircraft = { model: { nodeAnimations: [{
      type: 'WingFlex', nodes: bones.map(node => node.name),
    }] } } as unknown as ImportedAircraft
    const compiled = {
      ...emptyCompiledBehaviorSet,
      animationBindings: [{
        target: 'FlapAnimation',
        expression: { source: '0', instructions: [{ op: 'pushNumber', value: 0 }], variableKeys: [] },
        length: 100, wrap: false, delta: false, lagFramesPerSecond: 0, sourcePath: 'test.xml',
      }],
    } satisfies CompiledBehaviorSet
    const runtime = new AircraftRuntime(compiled, scene, {
      ...hostServices,
      readVariable: (key: string) => key.startsWith('A:WING FLEX PCT') ? flex : 0,
    }, aircraft)
    runtime.bindAnimations([new AnimationClip('FlapAnimation', 1, [
      new QuaternionKeyframeTrack(`${flap.name}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    ])])
    expect(surface.geometry.getAttribute('position').count).toBe(3)

    const point = (index: number): Vector3 => {
      const value = new Vector3().fromBufferAttribute(surface.geometry.getAttribute('position'), index)
      surface.applyBoneTransform(index, value)
      return surface.localToWorld(value)
    }
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    const neutralSpan = point(0).distanceTo(point(1))
    const neutralRise = point(1).y - point(0).y
    const neutralFlap = flap.getWorldPosition(new Vector3())
    flex = 0.5
    runtime.update(1 / 60)
    scene.updateMatrixWorld(true)
    expect(Math.abs(point(0).distanceTo(point(1)) - neutralSpan) < 1e-6).toBe(true)
    expect(point(1).y - point(0).y > neutralRise + 1e-4).toBe(true)
    expect(flap.getWorldPosition(new Vector3()).distanceTo(neutralFlap) > 1e-4).toBe(true)
  })

})
