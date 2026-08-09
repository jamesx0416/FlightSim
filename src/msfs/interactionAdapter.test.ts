import { expect, test } from 'bun:test'
import { Object3D } from 'three'

import { SimScheduler } from '../sim/engine'
import { MsfsInteractionAdapter, clampMsfsGateDragPercent, isSameMsfsInteractionTarget, msfsInteractionTargetKey, resolveMsfsAxisPercent, resolveMsfsDragPercent, resolveMsfsGateDragRange, resolveMsfsLockDragPercent, selectDragRoutes } from './interactionAdapter'
import { MsfsInteractionLifecycle } from './interactionLifecycle'
import { AircraftRuntime, SharedMsfsRuntimeHost } from './runtime'
import type { CompiledBehaviorSet, CompiledInteractionBinding, CompiledInteractionRoute } from './types'

test('starts each authored drag lifecycle with its lock route', () => {
  const lock = { operation: 'lock', phase: null } as CompiledInteractionRoute
  const drag = { operation: 'turn', phase: 'drag' } as CompiledInteractionRoute

  expect(selectDragRoutes([drag, lock], true)).toEqual([lock, drag])
  expect(selectDragRoutes([drag, lock], false)).toEqual([drag])
})

test('traces canonical actions with selected routes and stop provenance', () => {
  const binding = interactionBinding()
  const records: Readonly<Record<string, unknown>>[] = []
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => 0,
    executeInteractionBindingDirect: () => true,
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(
    runtime,
    undefined,
    factory => records.push(factory())
  )
  const target = adapter.fromBinding(binding)

  expect(adapter.execute(target, {
    source: 'devapi', operation: 'increase', phase: 'press', timestampMs: 1
  })).toBe(true)
  adapter.stop(target)

  expect(records.map(record => record.kind)).toEqual(['canonical-action', 'interaction-stop'])
  expect(records[0]).toEqual({
    kind: 'canonical-action',
    action: { source: 'devapi', operation: 'increase', phase: 'press', timestampMs: 1 },
    target: 'test.xml#TEST',
    executed: true,
    path: 'route',
    route: binding.metadata.routes[0],
    provenance: { sourcePath: 'test.xml', sourceKind: 'callbackCode', sourceTemplate: null }
  })
})

test('groups sibling bindings by authoritative interaction identity', () => {
  const click = interactionBinding()
  const drag = { ...click, metadata: { ...click.metadata } }
  const otherTarget = { ...drag, target: 'OTHER' }
  const otherQualifiedId = {
    ...drag,
    metadata: { ...drag.metadata, qualifiedId: 'other.xml#TEST' }
  }

  expect(isSameMsfsInteractionTarget(click, drag)).toBe(true)
  expect(isSameMsfsInteractionTarget(click, otherTarget)).toBe(false)
  expect(isSameMsfsInteractionTarget(click, otherQualifiedId)).toBe(false)
})

test('groups distinct authored targets only when GroupID matches', () => {
  const leftBase = interactionBinding({}, [
    { channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [] }
  ])
  const rightBase = interactionBinding({}, [
    { channel: null, phase: null, operation: 'increase', msfsEvent: 'WheelUp', axis: null, inputTypes: [] }
  ])
  const left = {
    ...leftBase,
    target: 'LEFT_NODE',
    metadata: { ...leftBase.metadata, qualifiedId: 'LEFT_NODE@1', authoredId: 'LEFT', groupId: 'DUAL_KNOB' }
  }
  const right = {
    ...rightBase,
    target: 'RIGHT_NODE',
    metadata: { ...rightBase.metadata, qualifiedId: 'RIGHT_NODE@1', authoredId: 'RIGHT', groupId: 'DUAL_KNOB' }
  }
  const unrelated = {
    ...right,
    metadata: { ...right.metadata, qualifiedId: 'RIGHT_NODE@2', groupId: 'OTHER' }
  }
  const runtime = { getInteractionBindings: () => [left, right, unrelated] } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime)
  const target = adapter.fromBinding(left)

  expect(isSameMsfsInteractionTarget(left, right)).toBe(true)
  expect(isSameMsfsInteractionTarget(left, unrelated)).toBe(false)
  expect(target.id).toBe('LEFT_NODE@1')
  expect(target.arbitrationId).toBe('group:test.xml#DUAL_KNOB')
  expect(target.bindings).toEqual([left, right])
  expect(target.operations).toEqual(['press', 'increase'])

  const physicalRight = adapter.fromBinding(right)
  expect(physicalRight.id).toBe(target.id)
  expect(adapter.resolve(physicalRight.id).ok).toBe(true)
  expect(adapter.resolve('RIGHT')).toEqual({
    ok: false,
    code: 'TARGET_AMBIGUOUS',
    candidates: ['LEFT_NODE@1', 'RIGHT_NODE@2']
  })
  expect(adapter.list().map(candidate => candidate.id)).toEqual(['LEFT_NODE@1', 'RIGHT_NODE@2'])
})

test('canonical target keys make GroupID membership transitive and order independent', () => {
  const first = interactionBinding()
  const groupedA = {
    ...first,
    target: 'A',
    metadata: { ...first.metadata, qualifiedId: 'shared', groupId: 'PAIR' }
  }
  const groupedB = {
    ...first,
    target: 'B',
    metadata: { ...first.metadata, qualifiedId: 'shared', groupId: 'PAIR' }
  }
  const ungrouped = {
    ...first,
    target: 'B',
    metadata: { ...first.metadata, qualifiedId: 'shared', groupId: null }
  }
  const runtime = { getInteractionBindings: () => [groupedA, ungrouped, groupedB] } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime)

  expect(msfsInteractionTargetKey(groupedA)).toBe(msfsInteractionTargetKey(groupedB))
  expect(msfsInteractionTargetKey(groupedB) === msfsInteractionTargetKey(ungrouped)).toBe(false)
  expect(adapter.list().length).toBe(2)
  expect(adapter.fromBinding(groupedB).bindings).toEqual([groupedA, groupedB])
})

test('projects pointer movement onto the authored drag trajectory', () => {
  const trajectory = [
    { relativeX: 0.2, relativeY: 0.8, dragPercent: 0 },
    { relativeX: 0.8, relativeY: 0.2, dragPercent: 1 }
  ]

  expect(resolveMsfsDragPercent(trajectory, 0.2, 0.8, 0.5)).toBe(0)
  expect(resolveMsfsDragPercent(trajectory, 0.8, 0.2, 0.5)).toBe(1)
  expect(Math.abs(resolveMsfsDragPercent(trajectory, 0.5, 0.5, 0) - 0.5) < 1e-10).toBe(true)
  expect(resolveMsfsDragPercent(trajectory, 0.05, 0.95, 0)).toBe(0)
  expect(resolveMsfsDragPercent(trajectory, 0.95, 0.05, 0)).toBe(1)
  const horizontalTrajectory = [
    { relativeX: 0.2, relativeY: 0.5, dragPercent: 0 },
    { relativeX: 0.8, relativeY: 0.5, dragPercent: 1 }
  ]
  expect(resolveMsfsDragPercent(horizontalTrajectory, 0.8, 0.1, 0.5)).toBe(1)
  expect(resolveMsfsDragPercent(horizontalTrajectory, 0.8, 0.9, 0.5)).toBe(1)
  expect(Math.abs(resolveMsfsDragPercent(horizontalTrajectory, 0.5, 0.1, 0.5) - 0.5) < 1e-10).toBe(true)
  expect(Math.abs(resolveMsfsDragPercent(horizontalTrajectory, 0.5, 0.9, 0.5) - 0.5) < 1e-10).toBe(true)
  expect(resolveMsfsDragPercent([], 0.8, 0.2, 0.25)).toBe(0.25)
  expect(resolveMsfsDragPercent([], 0.8, 0.3, resolveMsfsAxisPercent('y', 0.8, 0.3, 0))).toBe(0.3)
  expect(resolveMsfsLockDragPercent(0.5, 'y', 0, -20, 0.025, false)).toBe(1)
  expect(resolveMsfsLockDragPercent(0.5, 'y', 0, 20, 0.025, false)).toBe(0)
})

test('matches MSFS gated drag ranges without constraining invalid gate metadata', () => {
  const bothDirections = { steps: 3, dragSpeed: 10, tolerance: 0.2, direction: 0 as const, ignoredGate: 2 }
  const forwardOnly = { ...bothDirections, direction: -1 as const, ignoredGate: null }
  const backwardOnly = { ...bothDirections, direction: 1 as const, ignoredGate: null }

  expect(resolveMsfsGateDragRange(0, bothDirections)).toEqual({ minimum: 0, maximum: 1 })
  expect(resolveMsfsGateDragRange(1, bothDirections)).toEqual({ minimum: 0, maximum: 3 })
  expect(resolveMsfsGateDragRange(3, bothDirections)).toEqual({ minimum: 1, maximum: 3 })
  expect(resolveMsfsGateDragRange(1.5, bothDirections)).toEqual({ minimum: 1, maximum: 3 })
  expect(resolveMsfsGateDragRange(2, forwardOnly)).toEqual({ minimum: 1, maximum: 3 })
  expect(resolveMsfsGateDragRange(2, backwardOnly)).toEqual({ minimum: 0, maximum: 3 })
  expect(resolveMsfsGateDragRange(1, { ...bothDirections, direction: null })).toBe(null)
  expect(resolveMsfsGateDragRange(1, { ...bothDirections, tolerance: null })).toBe(null)
  expect(resolveMsfsGateDragRange(1, { ...bothDirections, steps: 2.5 })).toBe(null)

  const initialCapture = { minimum: 0, maximum: 1, gate: bothDirections }
  const partialUpperBranch = clampMsfsGateDragPercent(2.5 / 3, 1 / 3, initialCapture)
  expect(partialUpperBranch.capture).toEqual(initialCapture)
  const returnedFromPartialUpperBranch = clampMsfsGateDragPercent(0, 2.5 / 3, partialUpperBranch.capture)
  expect(returnedFromPartialUpperBranch.dragPercent).toBe(1 / 3)
  expect(returnedFromPartialUpperBranch.capture.minimum).toBe(1 / 3)

  const shallowUpperMove = clampMsfsGateDragPercent(0, 1.1 / 3, initialCapture)
  expect(shallowUpperMove.dragPercent).toBe(0)

  const lowerBranch = clampMsfsGateDragPercent(0, 1 / 3, initialCapture)
  const returnedFromLowerBranch = clampMsfsGateDragPercent(1, 0, lowerBranch.capture)
  expect(returnedFromLowerBranch.dragPercent).toBe(1 / 3)
  expect(returnedFromLowerBranch.capture.maximum).toBe(1 / 3)
})

test('preflights and verifies exact convergence and detects no progress', async () => {
  let value = 1
  let move = true
  let available = true
  const binding = interactionBinding()
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { mouseEvent?: string }) => {
      if (!available) return false
      if (move) value += options.mouseEvent === 'WheelUp' ? 1 : -1
      return true
    },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})
  const target = adapter.fromBinding(binding)

  const success = await adapter.setExact(target, 4)
  expect([success.ok, success.previous, success.actual, success.steps]).toEqual([true, 1, 4, 3])
  const adjustment = await adapter.adjustExact(target, -2)
  expect([
    adjustment.ok,
    adjustment.code,
    adjustment.previous,
    adjustment.requested,
    adjustment.actual,
    adjustment.steps
  ]).toEqual([true, 'OK', 4, 2, 2, 2])
  expect((await adapter.setExact(target, 4.5)).code).toBe('VALUE_NOT_REACHABLE')
  value = 2
  move = false
  expect((await adapter.setExact(target, 3)).code).toBe('NO_PROGRESS')
  move = true
  available = false
  expect((await adapter.setExact(target, 3)).code).toBe('TARGET_LOST')
})

test('detects a repeated settled state during cyclic convergence', async () => {
  let value = 0
  const events: string[] = []
  const binding = interactionBinding({ maximum: 4, cyclic: true })
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { mouseEvent?: string }) => {
      events.push(options.mouseEvent ?? '')
      value = value === 0 ? 1 : 0
      return true
    },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})

  expect((await adapter.setExact(adapter.fromBinding(binding), 2)).code).toBe('VALUE_CYCLE')
  expect(events).toEqual(['WheelUp', 'WheelUp'])
})

test('uses authored Set, rejects incompatible units, and observes cancellation', async () => {
  let value = 0
  let wait = false
  let resume = (): void => {}
  const base = interactionBinding(
    { unit: 'degree' },
    [{ channel: null, phase: null, operation: 'set', msfsEvent: null, axis: null, inputTypes: [] }]
  )
  const binding: CompiledInteractionBinding = {
    ...base,
    expression: {
      source: 'p0 (>L:TEST, degree)',
      instructions: [
        { op: 'pushParameter', index: 0 },
        { op: 'writeVariable', key: 'L:TEST', unit: 'degree' }
      ],
      variableKeys: ['L:TEST, degree']
    }
  }
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { parameterValues?: number[] }) => {
      value = options.parameterValues?.[0] ?? value
      return true
    },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {
    if (wait) await new Promise<void>(resolve => { resume = resolve })
  })
  const target = adapter.fromBinding(binding)

  expect((await adapter.setExact(target, 1, 'percent')).code).toBe('UNIT_INCOMPATIBLE')
  expect((await adapter.setExact(target, 1, 'degree')).executionPath).toBe('direct-set')
  wait = true
  const pending = adapter.setExact(target, 2, 'degree')
  adapter.stop(target)
  resume()
  expect((await pending).code).toBe('CANCELLED')
})

test('converts only authoritative compatible exact units', async () => {
  let value = 0.25
  const base = interactionBinding(
    { unit: 'ratio', minimum: 0, maximum: 1 },
    [{ channel: null, phase: null, operation: 'set', msfsEvent: null, axis: null, inputTypes: [] }]
  )
  const binding: CompiledInteractionBinding = {
    ...base,
    expression: {
      source: 'p0 (>L:TEST, ratio)',
      instructions: [
        { op: 'pushParameter', index: 0 },
        { op: 'writeVariable', key: 'L:TEST', unit: 'ratio' }
      ],
      variableKeys: ['L:TEST, ratio']
    }
  }
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { parameterValues?: number[] }) => {
      value = options.parameterValues?.[0] ?? value
      return true
    },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})
  const target = adapter.fromBinding(binding)

  const set = await adapter.setExact(target, 50, 'percent')
  expect([set.code, set.requested, set.actual, set.unit]).toEqual(['OK', 0.5, 0.5, 'ratio'])
  const adjust = await adapter.adjustExact(target, 25, 'percent')
  expect([adjust.code, adjust.requested, adjust.actual]).toEqual(['OK', 0.75, 0.75])
  expect((await adapter.setExact(target, 1, 'feet')).code).toBe('UNIT_INCOMPATIBLE')
})

test('preflights a pure current-state dynamic increment', async () => {
  let value = 0
  const binding = interactionBinding({
    step: null,
    increaseStep: null,
    increaseStepExpression: {
      source: 'p15 2 < if{ 1 } els{ 2 }',
      instructions: [
        { op: 'pushParameter', index: 15 },
        { op: 'pushNumber', value: 2 },
        { op: 'lt' },
        {
          op: 'if',
          thenInstructions: [{ op: 'pushNumber', value: 1 }],
          elseInstructions: [{ op: 'pushNumber', value: 2 }]
        }
      ],
      variableKeys: []
    }
  })
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    executeInteractionBindingDirect: () => {
      value += value < 2 ? 1 : 2
      return true
    },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})
  const result = await adapter.setExact(adapter.fromBinding(binding), 4)

  expect([result.code, result.actual, result.steps]).toEqual(['OK', 4, 3])
})

test('preflights a mutable runtime-variable increment without guessing', async () => {
  let value = 0
  let increment = 100
  let executions = 0
  const binding = interactionBinding({
    maximum: 1000,
    step: null,
    increaseStep: null,
    decreaseStep: null,
    increaseStepExpression: {
      source: 'p15 (L:STEP, number)',
      instructions: [
        { op: 'pushParameter', index: 15 },
        { op: 'pushVariable', key: 'L:STEP', unit: 'number' }
      ],
      variableKeys: ['L:STEP, number']
    }
  })
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    evaluateInteractionReadOnlyExpression: () => increment,
    executeInteractionBindingDirect: () => {
      executions += 1
      value += increment
      return true
    },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})
  const target = adapter.fromBinding(binding)

  expect((await adapter.setExact(target, 300)).code).toBe('OK')
  expect([value, executions]).toEqual([300, 3])

  value = 0
  executions = 0
  increment = 400
  const unreachable = await adapter.setExact(target, 300)
  expect([unreachable.code, value, executions]).toEqual(['VALUE_NOT_REACHABLE', 0, 0])
})

test('shadow preflights stock mutable counter acceleration before exact mutation', async () => {
  const stepExpression = {
    source: '(O:XMLVAR_IncrementCount) 10 > if{ (O:XMLVAR_IncrementCount) 25 > if{ 5 } els{ 2 } } els{ 1 }',
    instructions: [
      { op: 'pushVariable' as const, key: 'O:XMLVAR_IncrementCount', unit: null },
      { op: 'pushNumber' as const, value: 10 },
      { op: 'gt' as const },
      {
        op: 'if' as const,
        thenInstructions: [
          { op: 'pushVariable' as const, key: 'O:XMLVAR_IncrementCount', unit: null },
          { op: 'pushNumber' as const, value: 25 },
          { op: 'gt' as const },
          { op: 'if' as const, thenInstructions: [{ op: 'pushNumber' as const, value: 5 }], elseInstructions: [{ op: 'pushNumber' as const, value: 2 }] }
        ],
        elseInstructions: [{ op: 'pushNumber' as const, value: 1 }]
      }
    ],
    variableKeys: ['O:XMLVAR_IncrementCount']
  }
  const base = interactionBinding({
    maximum: 100,
    step: null,
    increaseStep: null,
    decreaseStep: null,
    increaseStepExpression: stepExpression
  })
  const binding: CompiledInteractionBinding = {
    ...base,
    expression: {
      source: '(L:TEST, number) #INCREMENT_VALUE# + (>L:TEST, number) (O:XMLVAR_IncrementCount) 1 + (>O:XMLVAR_IncrementCount)',
      instructions: [
        { op: 'pushVariable', key: 'L:TEST', unit: 'number' },
        ...stepExpression.instructions,
        { op: 'add' },
        { op: 'writeVariable', key: 'L:TEST', unit: 'number' },
        { op: 'pushVariable', key: 'O:XMLVAR_IncrementCount', unit: null },
        { op: 'pushNumber', value: 1 },
        { op: 'add' },
        { op: 'writeVariable', key: 'O:XMLVAR_IncrementCount', unit: null }
      ],
      variableKeys: ['L:TEST, number', 'O:XMLVAR_IncrementCount']
    }
  }
  const { runtime, host } = interactionRuntime(binding)
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})
  const target = adapter.fromBinding(binding)
  host.writeVariable('L:TEST', 0, 'number')
  host.writeVariable('O:XMLVAR_IncrementCount', 0)

  const success = await adapter.setExact(target, 13)
  expect([success.code, success.steps, host.readVariable('L:TEST'), host.readVariable('O:XMLVAR_IncrementCount')])
    .toEqual(['OK', 12, 13, 12])

  host.writeVariable('L:TEST', 0, 'number')
  host.writeVariable('O:XMLVAR_IncrementCount', 0)
  const unreachable = await adapter.setExact(target, 12)
  expect([unreachable.code, host.readVariable('L:TEST'), host.readVariable('O:XMLVAR_IncrementCount')])
    .toEqual(['VALUE_NOT_REACHABLE', 0, 0])
})

test('shadow exact preflight fails closed when a mutable step escapes through an event', async () => {
  const base = interactionBinding({
    maximum: 1000,
    step: null,
    increaseStep: null,
    decreaseStep: null,
    increaseStepExpression: {
      source: 'p15 (L:STEP, number)',
      instructions: [
        { op: 'pushParameter', index: 15 },
        { op: 'pushVariable', key: 'L:STEP', unit: 'number' }
      ],
      variableKeys: ['L:STEP, number']
    }
  })
  const binding: CompiledInteractionBinding = {
    ...base,
    expression: {
      source: '(>K:TEST_EVENT)',
      instructions: [{ op: 'invokeKeyEvent', name: 'TEST_EVENT', argCount: 0 }],
      variableKeys: []
    }
  }
  const { runtime, host } = interactionRuntime(binding)
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})
  host.writeVariable('L:TEST', 0, 'number')
  host.writeVariable('L:STEP', 100, 'number')

  const result = await adapter.setExact(adapter.fromBinding(binding), 300)
  expect([result.code, host.readVariable('L:TEST'), host.readVariable('L:STEP')])
    .toEqual(['VALUE_REACHABILITY_UNKNOWN', 0, 100])
})

test('accepts a numeric Set parameter through a deterministic transform', async () => {
  let value = 0
  const base = interactionBinding(
    { step: null, increaseStep: null, decreaseStep: null },
    [{ channel: null, phase: null, operation: 'set', msfsEvent: null, axis: null, inputTypes: [] }]
  )
  const binding: CompiledInteractionBinding = {
    ...base,
    expression: {
      source: 'p0 2 * 2 / (>L:TEST)',
      instructions: [
        { op: 'pushParameter', index: 0 },
        { op: 'pushNumber', value: 2 },
        { op: 'mul' },
        { op: 'pushNumber', value: 2 },
        { op: 'div' },
        { op: 'writeVariable', key: 'L:TEST', unit: 'number' }
      ],
      variableKeys: ['L:TEST']
    }
  }
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { parameterValues?: number[] }) => {
      value = (options.parameterValues?.[0] ?? value) * 2 / 2
      return true
    },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})

  expect((await adapter.setExact(adapter.fromBinding(binding), 3)).code).toBe('OK')
})

test('does not mutate through an unproven Set route', async () => {
  let executions = 0
  const binding = interactionBinding(
    { step: null, increaseStep: null, decreaseStep: null },
    [{ channel: null, phase: null, operation: 'set', msfsEvent: null, axis: null, inputTypes: [] }]
  )
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => 0,
    executeInteractionBindingDirect: () => { executions += 1; return true },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})

  expect((await adapter.setExact(adapter.fromBinding(binding), 1)).code).toBe('VALUE_REACHABILITY_UNKNOWN')
  expect(executions).toBe(0)
})

test('does not mistake an unrelated Set parameter branch for an exact mutation', async () => {
  let executions = 0
  const base = interactionBinding(
    { step: null, increaseStep: null, decreaseStep: null },
    [{ channel: null, phase: null, operation: 'set', msfsEvent: null, axis: null, inputTypes: [] }]
  )
  const binding: CompiledInteractionBinding = {
    ...base,
    expression: {
      source: 'p0 0 > if{ 1 (>L:TEST) }',
      instructions: [
        { op: 'pushParameter', index: 0 },
        { op: 'pushNumber', value: 0 },
        { op: 'gt' },
        {
          op: 'if',
          thenInstructions: [
            { op: 'pushNumber', value: 1 },
            { op: 'writeVariable', key: 'L:TEST', unit: 'number' }
          ],
          elseInstructions: []
        }
      ],
      variableKeys: ['L:TEST']
    }
  }
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => 0,
    executeInteractionBindingDirect: () => { executions += 1; return true },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})

  expect((await adapter.setExact(adapter.fromBinding(binding), 2)).code).toBe('VALUE_REACHABILITY_UNKNOWN')
  expect(executions).toBe(0)
})

test('fails exact mutation closed without authoritative state bounds or units', async () => {
  let executions = 0
  const setRoute: CompiledInteractionRoute = {
    channel: null, phase: null, operation: 'set', msfsEvent: null, axis: null, inputTypes: []
  }
  const makeRuntime = (binding: CompiledInteractionBinding) => ({
    getInteractionBindings: () => [binding],
    readInteractionValue: () => 0,
    executeInteractionBindingDirect: () => { executions += 1; return true },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime)
  const directExpression = {
    source: 'p0 (>L:TEST)',
    instructions: [
      { op: 'pushParameter' as const, index: 0 },
      { op: 'writeVariable' as const, key: 'L:TEST', unit: 'number' }
    ],
    variableKeys: ['L:TEST']
  }
  const tooltipOnlyBase = interactionBinding({ stateExpression: null }, [setRoute])
  const tooltipOnly = { ...tooltipOnlyBase, expression: directExpression }
  const tooltipAdapter = new MsfsInteractionAdapter(makeRuntime(tooltipOnly), async () => {})
  expect((await tooltipAdapter.setExact(tooltipAdapter.fromBinding(tooltipOnly), 1)).code).toBe('VALUE_REACHABILITY_UNKNOWN')

  const unboundedBase = interactionBinding({ minimum: null, maximum: null }, [setRoute])
  const unbounded = { ...unboundedBase, expression: directExpression }
  const unboundedAdapter = new MsfsInteractionAdapter(makeRuntime(unbounded), async () => {})
  expect((await unboundedAdapter.setExact(unboundedAdapter.fromBinding(unbounded), 1)).code).toBe('VALUE_REACHABILITY_UNKNOWN')

  const unitlessBase = interactionBinding({ unit: null }, [setRoute])
  const unitless = { ...unitlessBase, expression: directExpression }
  const unitlessAdapter = new MsfsInteractionAdapter(makeRuntime(unitless), async () => {})
  expect((await unitlessAdapter.setExact(unitlessAdapter.fromBinding(unitless), 1, 'number')).code).toBe('VALUE_REACHABILITY_UNKNOWN')
  expect(executions).toBe(0)
})

test('reads independent authored state and executes a static state setter', async () => {
  const stateExpression = {
    source: '(L:TEST_STATE, number)',
    instructions: [{ op: 'pushVariable' as const, key: 'L:TEST_STATE', unit: 'number' }],
    variableKeys: ['L:TEST_STATE, number']
  }
  const binding = interactionBinding({
    stateExpression,
    setStates: [{
      value: 2,
      label: 'Two',
      expression: {
        source: '2 (>L:TEST_STATE, number)',
        instructions: [
          { op: 'pushNumber' as const, value: 2 },
          { op: 'writeVariable' as const, key: 'L:TEST_STATE', unit: 'number' }
        ],
        variableKeys: ['L:TEST_STATE, number']
      }
    }]
  }, [])
  const { runtime, host } = interactionRuntime(binding)
  host.writeVariable('L:TEST_STATE', 0, 'number')
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})
  const result = await adapter.setExact(adapter.fromBinding(binding), 2)

  expect([result.code, result.executionPath, result.actual]).toEqual(['OK', 'direct-set', 2])
  expect(runtime.readInteractionValue(binding)).toBe(2)
})

test('preflights asymmetric directional steps and chooses the shorter cyclic path', async () => {
  let value = 0
  const events: string[] = []
  const binding = interactionBinding({
    maximum: 4,
    cyclic: true,
    step: null,
    increaseStep: 2,
    decreaseStep: 1
  })
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { mouseEvent?: string }) => {
      events.push(options.mouseEvent ?? '')
      value = options.mouseEvent === 'WheelUp'
        ? (value + 2) % 4
        : (value + 3) % 4
      return true
    },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})

  expect((await adapter.setExact(adapter.fromBinding(binding), 2)).code).toBe('OK')
  expect(events).toEqual(['WheelUp'])
  events.length = 0
  expect((await adapter.setExact(adapter.fromBinding(binding), 1)).code).toBe('OK')
  expect(events).toEqual(['WheelDown'])
})

test('treats an authored cyclic upper bound as a reachable state', async () => {
  let value = 0
  const events: string[] = []
  const binding = interactionBinding({ maximum: 4, cyclic: true, cyclicUpperInclusive: true })
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { mouseEvent?: string }) => {
      events.push(options.mouseEvent ?? '')
      value = options.mouseEvent === 'WheelDown'
        ? (value === 0 ? 4 : value - 1)
        : (value === 4 ? 0 : value + 1)
      return true
    },
    releaseInteractionBinding: () => true
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime, async () => {})
  const result = await adapter.setExact(adapter.fromBinding(binding), 4)

  expect([result.code, result.executionPath, result.steps]).toEqual(['OK', 'decrease', 1])
  expect(events).toEqual(['WheelDown'])
})

test('resolves duplicate authored IDs strictly and requires an unambiguous channel', () => {
  const routes: CompiledInteractionRoute[] = [
    { channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [] },
    { channel: 'secondary', phase: 'press', operation: 'press', msfsEvent: 'RightSingle', axis: null, inputTypes: [] }
  ]
  const bindings = [interactionBinding({}, routes, 'a.xml'), interactionBinding({}, routes, 'b.xml')]
  const adapter = new MsfsInteractionAdapter({ getInteractionBindings: () => bindings } as unknown as AircraftRuntime)
  const ambiguous = adapter.resolve('TEST')
  expect(ambiguous).toEqual({ ok: false, code: 'TARGET_AMBIGUOUS', candidates: ['a.xml#TEST', 'b.xml#TEST'] })
  const qualified = adapter.resolve('a.xml#TEST')
  if (!qualified.ok) throw new Error('qualified target did not resolve')
  expect(adapter.route(qualified.target, { source: 'devapi', operation: 'press', phase: 'press', timestampMs: 0 })).toBe(null)
  expect(adapter.route(qualified.target, { source: 'devapi', operation: 'press', phase: 'press', channel: 'secondary', timestampMs: 0 })?.msfsEvent).toBe('RightSingle')
})

test('preserves distinct controls when one source reuses an authored ID', () => {
  const first = interactionBinding()
  const secondBase = interactionBinding()
  const second = {
    ...secondBase,
    target: 'BARO_KNOB',
    metadata: { ...secondBase.metadata, nodeId: 'BARO_KNOB' }
  }
  const adapter = new MsfsInteractionAdapter({
    getInteractionBindings: () => [first, second]
  } as unknown as AircraftRuntime)

  expect(adapter.list().map(target => target.id)).toEqual([
    'test.xml#TEST',
    'test.xml#BARO_KNOB'
  ])
  expect(adapter.resolve('TEST')).toEqual({
    ok: false,
    code: 'TARGET_AMBIGUOUS',
    candidates: ['test.xml#TEST', 'test.xml#BARO_KNOB']
  })
  const qualified = adapter.resolve('test.xml#BARO_KNOB')
  expect(qualified.ok && qualified.target.binding.target).toBe('BARO_KNOB')
})

test('uses an authored drag-model wheel route in Legacy when no default wheel route exists', () => {
  const binding = interactionBinding({}, [
    { interactionModel: 'default', channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [0] },
    { interactionModel: 'drag', channel: null, phase: null, operation: 'increase', msfsEvent: 'WheelUp', axis: null, inputTypes: [1] }
  ])
  const adapter = new MsfsInteractionAdapter({ getInteractionBindings: () => [binding] } as unknown as AircraftRuntime)
  const route = adapter.route(adapter.fromBinding(binding), {
    source: 'mouse', operation: 'increase', phase: 'press', timestampMs: 0
  })
  expect([route?.msfsEvent, route?.inputTypes[0]]).toEqual(['WheelUp', 1])
})

test('separates single from double press routes', () => {
  const binding = interactionBinding({}, [
    { interactionModel: 'default', channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [0] },
    { interactionModel: 'default', channel: 'primary', phase: 'double', operation: 'press', msfsEvent: 'LeftDouble', axis: null, inputTypes: [0] }
  ])
  const adapter = new MsfsInteractionAdapter({ getInteractionBindings: () => [binding] } as unknown as AircraftRuntime)
  const target = adapter.fromBinding(binding)

  expect(adapter.route(target, { source: 'mouse', operation: 'press', phase: 'press', channel: 'primary', timestampMs: 0 })?.msfsEvent).toBe('LeftSingle')
  expect(adapter.route(target, { source: 'mouse', operation: 'press', phase: 'double', channel: 'primary', timestampMs: 0 })?.msfsEvent).toBe('LeftDouble')
})

test('uses a default-model tap in Lock when no drag-model press is authored', () => {
  const base = interactionBinding({}, [
    { interactionModel: 'default', channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [0] },
    { interactionModel: 'drag', channel: null, phase: null, operation: 'lock', msfsEvent: 'Lock', axis: null, inputTypes: [1] }
  ])
  const binding = { ...base, metadata: { ...base.metadata, lockable: true } }
  const adapter = new MsfsInteractionAdapter({ getInteractionBindings: () => [binding] } as unknown as AircraftRuntime)
  adapter.setMode('lock')

  expect(adapter.route(adapter.fromBinding(binding), {
    source: 'mouse', operation: 'hold', phase: 'hold', channel: 'primary', timestampMs: 0
  })?.msfsEvent).toBe('LeftSingle')
})

test('keeps a specifically selected same-target wheel binding first', () => {
  const click = interactionBinding({}, [
    { channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [] }
  ])
  const wheel = interactionBinding({}, [
    { channel: null, phase: null, operation: 'increase', msfsEvent: 'WheelUp', axis: null, inputTypes: [] }
  ])
  const executed: CompiledInteractionBinding[] = []
  const runtime = {
    getInteractionBindings: () => [click, wheel],
    executeInteractionBindingDirect: (binding: CompiledInteractionBinding) => { executed.push(binding); return true },
    readInteractionValue: () => null
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime)

  expect(adapter.execute(adapter.fromBinding(wheel), {
    source: 'mouse', operation: 'increase', phase: 'press', timestampMs: 0
  })).toBe(true)
  expect(executed).toEqual([wheel])
})

test('uses Primary as a directional wheel fallback only for compiled two-state switches', () => {
  let value = 0
  const base = interactionBinding({}, [
    { interactionModel: 'default', channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [0] }
  ])
  const binding = { ...base, metadata: { ...base.metadata, wheelPrimaryToggle: true } }
  const events: string[] = []
  const runtime = {
    getInteractionBindings: () => [binding],
    readInteractionValue: () => value,
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { mouseEvent?: string }) => {
      events.push(options.mouseEvent ?? '')
      value = value === 0 ? 1 : 0
      return true
    }
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime)
  const target = adapter.fromBinding(binding)

  expect([target.operations.includes('increase'), target.operations.includes('decrease')]).toEqual([true, true])
  expect(adapter.execute(target, { source: 'mouse', operation: 'increase', phase: 'press', timestampMs: 0 })).toBe(true)
  expect(adapter.execute(target, { source: 'mouse', operation: 'increase', phase: 'press', timestampMs: 1 })).toBe(true)
  expect(adapter.execute(target, { source: 'mouse', operation: 'decrease', phase: 'press', timestampMs: 2 })).toBe(true)
  expect(events).toEqual(['LeftSingle', 'LeftSingle'])
})

test('emits lock-model drag routes only for authored lockable drag flags', () => {
  const base = interactionBinding({}, [
    { interactionModel: 'drag', channel: 'primary', phase: 'drag', operation: 'turn', msfsEvent: 'LeftDrag', axis: 'y', inputTypes: [1] },
    { interactionModel: 'drag', channel: 'secondary', phase: 'drag', operation: 'turn', msfsEvent: 'RightDrag', axis: 'y', inputTypes: [1] }
  ])
  const binding = {
    ...base,
    metadata: {
      ...base.metadata,
      lockable: true,
      dragFlagsLockable: ['RightDrag'],
      lockFlagsTemporary: ['RightSingle']
    }
  }
  const adapter = new MsfsInteractionAdapter({ getInteractionBindings: () => [binding] } as unknown as AircraftRuntime)
  adapter.setMode('lock')
  const target = adapter.fromBinding(binding)

  expect(target.temporaryLockChannels).toEqual(['secondary'])
  expect(adapter.route(target, {
    source: 'mouse', operation: 'turn', phase: 'drag', channel: 'primary', axis: 'y', axisValue: 0.5, timestampMs: 0
  })).toBe(null)
  expect(adapter.route(target, {
    source: 'mouse', operation: 'turn', phase: 'drag', channel: 'secondary', axis: 'y', axisValue: 0.5, timestampMs: 0
  })?.msfsEvent).toBe('RightDrag')
})

test('selects release callbacks from the active authored interaction model', () => {
  const routes: CompiledInteractionRoute[] = [
    { interactionModel: 'default', channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [0] },
    { interactionModel: 'drag', channel: 'primary', phase: 'release', operation: 'release', msfsEvent: 'LeftRelease', axis: null, inputTypes: [1] }
  ]
  const simpleBinding = interactionBinding({}, routes)
  const complexBinding = { ...simpleBinding, metadata: { ...simpleBinding.metadata, lockable: true } }
  const adapter = new MsfsInteractionAdapter({ getInteractionBindings: () => [] } as unknown as AircraftRuntime)
  const release = { source: 'mouse', operation: 'release', phase: 'release', channel: 'primary', timestampMs: 0 } as const

  expect(adapter.route(adapter.fromBinding(simpleBinding), release)).toBe(null)
  adapter.setMode('lock')
  expect(adapter.route(adapter.fromBinding(simpleBinding), release)).toBe(null)
  expect(adapter.route(adapter.fromBinding(complexBinding), release)?.msfsEvent).toBe('LeftRelease')
})

test('routes one captured target across its authored click and drag bindings', () => {
  const click = interactionBinding({}, [
    { channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [] }
  ])
  const drag = interactionBinding({}, [
    { channel: 'primary', phase: 'drag', operation: 'turn', msfsEvent: 'LeftDrag', axis: 'y', inputTypes: [] }
  ])
  const executed: CompiledInteractionBinding[] = []
  const runtime = {
    getInteractionBindings: () => [click, drag],
    executeInteractionBindingDirect: (binding: CompiledInteractionBinding) => { executed.push(binding); return true },
    releaseInteractionBinding: () => true,
    readInteractionValue: () => null
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime)
  const target = adapter.fromBinding(click)

  expect(adapter.list().length).toBe(1)
  expect(adapter.execute(target, { source: 'mouse', operation: 'press', phase: 'press', channel: 'primary', timestampMs: 0 })).toBe(true)
  expect(adapter.execute(target, { source: 'mouse', operation: 'turn', phase: 'drag', channel: 'primary', axis: 'y', axisValue: 1, timestampMs: 1 })).toBe(true)
  expect(executed).toEqual([click, drag])
})

test('preserves all anchor-relative axes for CallbackDragging execution', () => {
  const drag = interactionBinding({}, [
    { channel: 'primary', phase: 'drag', operation: 'turn', msfsEvent: 'LeftDrag', axis: 'y', inputTypes: [] }
  ])
  const samples: Array<{ relativeX?: number; relativeY?: number; relativeZ?: number }> = []
  const runtime = {
    getInteractionBindings: () => [drag],
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { relativeX?: number; relativeY?: number; relativeZ?: number }) => {
      samples.push(options)
      return true
    },
    readInteractionValue: () => null
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime)

  expect(adapter.execute(adapter.fromBinding(drag), {
    source: 'mouse', operation: 'turn', phase: 'drag', channel: 'primary', axis: 'y', axisValue: 0.8,
    relativeX: 0.1, relativeY: -0.2, relativeZ: 0.3, timestampMs: 0
  })).toBe(true)
  expect(samples).toEqual([{ relativeX: 0.1, relativeY: -0.2, relativeZ: 0.3, holdFeedback: true, mouseEvent: 'LeftDrag', inputType: undefined, dragPercent: undefined, parameterValues: undefined }])
})

test('runs authored single, double, repeat, drag, release, and stop lifecycle in simulator time', () => {
  const binding = {
    ...interactionBinding({}, [
      { channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [] },
      { channel: 'primary', phase: 'double', operation: 'press', msfsEvent: 'LeftDouble', axis: null, inputTypes: [] },
      { channel: 'primary', phase: 'drag', operation: 'turn', msfsEvent: 'LeftDrag', axis: 'y', inputTypes: [] },
      { channel: 'primary', phase: 'release', operation: 'release', msfsEvent: 'LeftRelease', axis: null, inputTypes: [] },
      { channel: 'primary', phase: 'repeat', operation: 'hold', msfsEvent: 'DownRepeat', axis: null, inputTypes: [] },
      { channel: null, phase: 'repeat', operation: 'turn', msfsEvent: 'MoveRepeat', axis: null, inputTypes: [] }
    ]),
    minHeldDurationSeconds: 1,
    repeatFrequencyHz: 2
  }
  const events: string[] = []
  const runtime = {
    getInteractionBindings: () => [binding],
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { mouseEvent?: string }) => {
      events.push(options.mouseEvent ?? '')
      return true
    },
    releaseInteractionBinding: () => { events.push('release-feedback'); return true },
    readInteractionValue: () => null
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime)
  const scheduler = new SimScheduler()
  const trace: Readonly<Record<string, unknown>>[] = []
  const lifecycle = new MsfsInteractionLifecycle(
    adapter,
    scheduler,
    undefined,
    factory => trace.push(factory())
  )
  const target = adapter.fromBinding(binding)
  const base = { source: 'mouse', operation: 'press', phase: 'press', channel: 'primary', timestampMs: 0 } as const

  expect(lifecycle.press(target, base, 1)).toBe(true)
  scheduler.tick(0.5)
  expect(events).toEqual(['LeftSingle'])
  scheduler.tick(0.5)
  expect(events).toEqual(['LeftSingle', 'DownRepeat'])
  expect(lifecycle.move(target, { ...base, operation: 'turn', phase: 'drag', axis: 'y', axisValue: 0.4 })).toBe(true)
  scheduler.tick(0.5)
  expect(events.slice(-2)).toEqual(['DownRepeat', 'MoveRepeat'])
  expect(lifecycle.release(target, base)).toBe(true)
  scheduler.tick(1)
  expect(events.slice(-2)).toEqual(['LeftRelease', 'release-feedback'])

  lifecycle.press(target, base, 2)
  expect(events.slice(-2)).toEqual(['LeftSingle', 'LeftDouble'])
  lifecycle.stop(target, base, { release: true, unlock: false })
  scheduler.tick(2)
  expect(events.at(-1)).toBe('LeftRelease')
  expect(trace.some(record => record.phase === 'repeat-scheduled')).toBe(true)
  expect(trace.some(record => record.phase === 'repeat-fired')).toBe(true)
  expect(trace.some(record => record.phase === 'scope-cancelled')).toBe(true)
})

test('stops captured pointer actions through release and keeps repeated stops idempotent', () => {
  const binding = interactionBinding({}, [
    { channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [] },
    { channel: 'primary', phase: 'double', operation: 'press', msfsEvent: 'LeftDouble', axis: null, inputTypes: [] },
    { channel: 'primary', phase: 'drag', operation: 'turn', msfsEvent: 'LeftDrag', axis: 'y', inputTypes: [] },
    { channel: 'secondary', phase: 'release', operation: 'release', msfsEvent: 'RightRelease', axis: null, inputTypes: [] }
  ])
  const events: string[] = []
  let stops = 0
  const runtime = {
    getInteractionBindings: () => [binding],
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { mouseEvent?: string }) => {
      events.push(options.mouseEvent ?? '')
      return true
    },
    stopInteractionBinding: () => {
      stops += 1
      return true
    },
    readInteractionValue: () => null
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime)
  const lifecycle = new MsfsInteractionLifecycle(adapter, new SimScheduler())
  const target = adapter.fromBinding(binding)

  expect(lifecycle.execute(target, {
    source: 'mouse', operation: 'hold', phase: 'hold', channel: 'primary', pointerId: 1, clickCount: 2, timestampMs: 0
  })).toBe(true)
  expect(lifecycle.stop(target, {
    source: 'mouse', operation: 'release', phase: 'release', channel: 'secondary', timestampMs: 1
  }, { release: true, unlock: false })).toBe(true)
  adapter.stop(target)

  expect(events).toEqual(['LeftSingle', 'LeftDouble', 'RightRelease'])
  expect(stops).toBe(1)
})

test('fails repeat closed when authored routes do not prove timing', () => {
  const binding = interactionBinding({}, [
    { channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [] },
    { channel: 'primary', phase: 'repeat', operation: 'hold', msfsEvent: 'DownRepeat', axis: null, inputTypes: [] }
  ])
  const events: string[] = []
  const diagnostics: string[] = []
  const runtime = {
    getInteractionBindings: () => [binding],
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { mouseEvent?: string }) => {
      events.push(options.mouseEvent ?? '')
      return true
    },
    readInteractionValue: () => null
  } as unknown as AircraftRuntime
  const adapter = new MsfsInteractionAdapter(runtime)
  const scheduler = new SimScheduler()
  const lifecycle = new MsfsInteractionLifecycle(adapter, scheduler, diagnostic => diagnostics.push(diagnostic.code))

  lifecycle.press(adapter.fromBinding(binding), {
    source: 'mouse', operation: 'press', phase: 'press', channel: 'primary', timestampMs: 0
  })
  scheduler.tick(10)

  expect(events).toEqual(['LeftSingle'])
  expect(diagnostics).toEqual(['interaction_repeat_timing_unproven'])
})

test('bulk stopping does not release inactive controls', () => {
  const binding = interactionBinding()
  let releases = 0
  const runtime = {
    getInteractionBindings: () => [binding],
    releaseInteractionBinding: () => { releases += 1; return true },
    readInteractionValue: () => null
  } as unknown as AircraftRuntime

  new MsfsInteractionAdapter(runtime).stopAll()

  expect(releases).toBe(0)
})

test('settles exact Set after a watched value change and two completed simulator ticks', async () => {
  const base = interactionBinding({}, [
    { channel: null, phase: null, operation: 'set', msfsEvent: null, axis: null, inputTypes: [] }
  ])
  const binding: CompiledInteractionBinding = {
    ...base,
    expression: {
      source: '(M:Param:0) (>L:TEST)',
      instructions: [
        { op: 'pushParameter', index: 0 },
        { op: 'writeVariable', key: 'L:TEST', unit: 'number' }
      ],
      variableKeys: ['L:TEST']
    },
    metadata: {
      ...base.metadata,
      tooltipValueExpression: {
        source: '(L:TEST, number)',
        instructions: [{ op: 'pushVariable', key: 'L:TEST', unit: 'number' }],
        variableKeys: ['L:TEST']
      }
    }
  }
  const { runtime, host } = interactionRuntime(binding)
  const adapter = new MsfsInteractionAdapter(runtime)
  let completed = false
  const pending = adapter.setExact(adapter.fromBinding(binding), 3).then(result => {
    completed = true
    return result
  })

  runtime.update(0.1)
  await Promise.resolve()
  expect(completed).toBe(false)
  runtime.update(0.1)

  const result = await pending
  expect([result.code, result.actual, host.readVariable('L:TEST')]).toEqual(['OK', 3, 3])
})

test('waits authored settle time before counting two completed simulator ticks', async () => {
  const base = interactionBinding({ settleTimeSeconds: 0.5 }, [
    { channel: null, phase: null, operation: 'set', msfsEvent: null, axis: null, inputTypes: [] }
  ])
  const binding: CompiledInteractionBinding = {
    ...base,
    expression: {
      source: '(M:Param:0) (>L:TEST)',
      instructions: [
        { op: 'pushParameter', index: 0 },
        { op: 'writeVariable', key: 'L:TEST', unit: 'number' }
      ],
      variableKeys: ['L:TEST']
    },
    metadata: {
      ...base.metadata,
      tooltipValueExpression: {
        source: '(L:TEST, number)',
        instructions: [{ op: 'pushVariable', key: 'L:TEST', unit: 'number' }],
        variableKeys: ['L:TEST']
      }
    }
  }
  const { runtime } = interactionRuntime(binding)
  const adapter = new MsfsInteractionAdapter(runtime)
  let completed = false
  const pending = adapter.setExact(adapter.fromBinding(binding), 2).then(result => {
    completed = true
    return result
  })

  runtime.update(0.25)
  runtime.update(0.25)
  await Promise.resolve()
  runtime.update(0.1)
  await Promise.resolve()
  expect(completed).toBe(false)
  runtime.update(0.1)

  expect((await pending).code).toBe('OK')
})

test('stopping pending interaction feedback does not replay a release expression', () => {
  const base = interactionBinding()
  const binding: CompiledInteractionBinding = {
    ...base,
    minHeldDurationSeconds: 1,
    expression: {
      source: '1 (>L:PRESSED)',
      instructions: [
        { op: 'pushNumber', value: 1 },
        { op: 'writeVariable', key: 'L:PRESSED', unit: 'number' }
      ],
      variableKeys: ['L:PRESSED']
    },
    releaseExpression: {
      source: '0 (>L:PRESSED)',
      instructions: [
        { op: 'pushNumber', value: 0 },
        { op: 'writeVariable', key: 'L:PRESSED', unit: 'number' }
      ],
      variableKeys: ['L:PRESSED']
    }
  }
  const { runtime, host } = interactionRuntime(binding)

  runtime.executeInteractionBindingDirect(binding, { holdFeedback: true })
  runtime.releaseInteractionBinding(binding)
  runtime.update(0.5)
  expect(host.readVariable('L:PRESSED')).toBe(1)
  expect(host.readVariable('O:TEST:_ButtonAnimVar')).toBe(1)
  runtime.update(0.5)
  expect(host.readVariable('L:PRESSED')).toBe(0)
  expect(host.readVariable('O:TEST:_ButtonAnimVar')).toBe(0)

  runtime.executeInteractionBindingDirect(binding, { holdFeedback: true })
  runtime.releaseInteractionBinding(binding)
  runtime.update(0.25)
  runtime.stopInteractionBinding(binding)
  runtime.update(1)
  expect(host.readVariable('L:PRESSED')).toBe(1)
  expect(host.readVariable('O:TEST:_ButtonAnimVar')).toBe(0)
})

function interactionBinding(
  valueOverrides: Partial<CompiledInteractionBinding['metadata']['value']> = {},
  routes: readonly CompiledInteractionRoute[] = [
    { channel: null, phase: null, operation: 'increase', msfsEvent: 'WheelUp', axis: null, inputTypes: [] },
    { channel: null, phase: null, operation: 'decrease', msfsEvent: 'WheelDown', axis: null, inputTypes: [] }
  ],
  sourcePath = 'test.xml'
): CompiledInteractionBinding {
  const expression = { source: '', instructions: [], variableKeys: [] }
  const valueExpression = {
    source: '(L:TEST, number)',
    instructions: [{ op: 'pushVariable' as const, key: 'L:TEST', unit: 'number' }],
    variableKeys: ['L:TEST, number']
  }
  const cyclic = valueOverrides.cyclic ?? false
  return {
    target: 'TEST',
    feedbackTargets: [],
    feedbackVariableKeys: [],
    soundEvents: [],
    minHeldDurationSeconds: 0,
    animationDurationSeconds: null,
    repeatFrequencyHz: null,
    expression,
    releaseExpression: null,
    sourcePath,
    metadata: {
      authoredId: 'TEST', qualifiedId: `${sourcePath}#TEST`, nodeId: 'TEST', componentId: null,
      inputEventIds: [],
      routes,
      sourceKind: 'callbackCode', sourcePath, sourceTemplate: null, templateRevision: null,
      lockable: false, dynamicEventHandling: false, disabled: false, disabledInVr: false,
      prioritizeVCockpits: false, ignoreZTest: false, highlightNodeId: 'TEST', axis: null,
      inverted: false, dragNodeId: null, dragAnimationName: null, dragMode: 'default', dragAnimationSynced: true,
      dragUseAnimLag: false, dragScalar: 0.025, dragScales: { x: 0, y: 0, z: 0 },
      dragFlagsLockable: ['LeftDrag', 'RightDrag', 'MiddleDrag'], lockFlagsTemporary: ['LeftSingle'], groupId: null,
      discreteGate: null, wheelPrimaryToggle: false, cursor: null,
      cursors: {
        default: { cursor: null, left: null, right: null, up: null, down: null, center: null, centerRadius: null },
        drag: { cursor: null, left: null, right: null, up: null, down: null, center: null, centerRadius: null }
      },
      tooltipTitle: null,
      tooltipDescription: null, tooltipStateLabels: [], tooltipUnavailable: null,
      tooltipValueLabel: null, tooltipActionHints: [],
      tooltipValueExpression: valueExpression,
      tooltipFormattedValueExpression: null,
      tooltipEntries: [],
      tooltipAnimated: null,
      value: {
        variableKey: 'L:TEST', unit: 'number', minimum: 0, maximum: 4, step: 1,
        cyclic, cyclicUpperInclusive: cyclic ? true : null, settleTimeSeconds: 0,
        stateExpression: valueExpression, ...valueOverrides
      }
    }
  }
}

function interactionRuntime(binding: CompiledInteractionBinding): {
  readonly runtime: AircraftRuntime
  readonly host: SharedMsfsRuntimeHost
} {
  const compiled: CompiledBehaviorSet = {
    irVersion: 'msfs-behavior/v1',
    aircraftId: 'test',
    animationBindings: [],
    animationTriggerBindings: [],
    visibilityBindings: [],
    materialBindings: [],
    updateBindings: [],
    inputEventBindings: [],
    interactionBindings: [binding],
    interactionBlockers: [],
    interactionCompilerTotals: { candidates: 0, compiledBindings: 0, rejectedBindings: 0, rejectionReasons: {} },
    variableKeys: [],
    builtinFallbackHits: [],
    diagnostics: []
  }
  const host = new SharedMsfsRuntimeHost([])
  return {
    host,
    runtime: new AircraftRuntime(
      compiled,
      new Object3D(),
      host,
      undefined,
      host.simulatorEngine.getAircraft(),
      host.simulatorEngine
    )
  }
}
