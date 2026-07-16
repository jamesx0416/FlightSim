import { expect, test } from 'bun:test'

import { MsfsInteractionAdapter, resolveMsfsAxisPercent, resolveMsfsDragPercent, resolveMsfsLockDragPercent, selectDragRoutes } from './interactionAdapter'
import type { AircraftRuntime } from './runtime'
import type { CompiledInteractionBinding, CompiledInteractionRoute } from './types'

test('starts each authored drag lifecycle with its lock route', () => {
  const lock = { operation: 'lock', phase: null } as CompiledInteractionRoute
  const drag = { operation: 'turn', phase: 'drag' } as CompiledInteractionRoute

  expect(selectDragRoutes([drag, lock], true)).toEqual([lock, drag])
  expect(selectDragRoutes([drag, lock], false)).toEqual([drag])
})

test('projects pointer movement onto the authored drag trajectory', () => {
  const trajectory = [
    { relativeX: 0.2, relativeY: 0.8, dragPercent: 0 },
    { relativeX: 0.8, relativeY: 0.2, dragPercent: 1 }
  ]

  expect(resolveMsfsDragPercent(trajectory, 0.2, 0.8, 0.5)).toBe(0)
  expect(resolveMsfsDragPercent(trajectory, 0.8, 0.2, 0.5)).toBe(1)
  expect(resolveMsfsDragPercent(trajectory, 0.5, 0.5, 0, 0.25)).toBe(0.75)
  expect(resolveMsfsDragPercent(trajectory, 0.05, 0.95, 0, 0.25)).toBe(0)
  expect(resolveMsfsDragPercent(trajectory, 0.95, 0.05, 0, -0.25)).toBe(1)
  expect(resolveMsfsDragPercent([], 0.8, 0.2, 0.25)).toBe(0.25)
  expect(resolveMsfsDragPercent([], 0.8, 0.3, resolveMsfsAxisPercent('y', 0.8, 0.3, 0), 0.2)).toBe(0.5)
  expect(resolveMsfsLockDragPercent(0.5, 'y', 0, -20, 0.025, false)).toBe(1)
  expect(resolveMsfsLockDragPercent(0.5, 'y', 0, 20, 0.025, false)).toBe(0)
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
  const binding = interactionBinding(
    { unit: 'degree' },
    [{ channel: null, phase: null, operation: 'set', msfsEvent: null, axis: null, inputTypes: [] }]
  )
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
  adapter.cancel(target)
  resume()
  expect((await pending).code).toBe('CANCELLED')
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

function interactionBinding(
  valueOverrides: Partial<CompiledInteractionBinding['metadata']['value']> = {},
  routes: readonly CompiledInteractionRoute[] = [
    { channel: null, phase: null, operation: 'increase', msfsEvent: 'WheelUp', axis: null, inputTypes: [] },
    { channel: null, phase: null, operation: 'decrease', msfsEvent: 'WheelDown', axis: null, inputTypes: [] }
  ],
  sourcePath = 'test.xml'
): CompiledInteractionBinding {
  const expression = { source: '', instructions: [], variableKeys: [] }
  return {
    target: 'TEST',
    feedbackTargets: [],
    feedbackVariableKeys: [],
    soundEvents: [],
    minHeldDurationSeconds: 0,
    animationDurationSeconds: null,
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
      inverted: false, dragAnimationName: null, dragMode: 'default', dragAnimationSynced: true,
      dragScalar: 0.025, discreteGate: null, wheelPrimaryToggle: false, cursor: null, tooltipTitle: null,
      tooltipDescription: null, tooltipValueExpression: expression,
      value: {
        variableKey: 'L:TEST', unit: 'number', minimum: 0, maximum: 4, step: 1,
        cyclic: false, settleTimeSeconds: 0, ...valueOverrides
      }
    }
  }
}
