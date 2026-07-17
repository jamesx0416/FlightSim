import { expect, test } from 'bun:test'
import { Object3D } from 'three'

import { SimScheduler } from '../sim/engine'
import { MsfsInteractionAdapter, isSameMsfsInteractionTarget, resolveMsfsAxisPercent, resolveMsfsDragPercent, resolveMsfsLockDragPercent, selectDragRoutes } from './interactionAdapter'
import { MsfsInteractionLifecycle } from './interactionLifecycle'
import { AircraftRuntime, SharedMsfsRuntimeHost } from './runtime'
import type { CompiledBehaviorSet, CompiledInteractionBinding, CompiledInteractionRoute } from './types'

test('starts each authored drag lifecycle with its lock route', () => {
  const lock = { operation: 'lock', phase: null } as CompiledInteractionRoute
  const drag = { operation: 'turn', phase: 'drag' } as CompiledInteractionRoute

  expect(selectDragRoutes([drag, lock], true)).toEqual([lock, drag])
  expect(selectDragRoutes([drag, lock], false)).toEqual([drag])
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

test('runs authored single, double, repeat, drag, release, and cancellation lifecycle in simulator time', () => {
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
  const lifecycle = new MsfsInteractionLifecycle(adapter, scheduler)
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
  lifecycle.cancel(target)
  scheduler.tick(2)
  expect(events.at(-1)).toBe('release-feedback')
})

test('bridges captured pointer actions and keeps repeated cancellation idempotent', () => {
  const binding = interactionBinding({}, [
    { channel: 'primary', phase: 'press', operation: 'press', msfsEvent: 'LeftSingle', axis: null, inputTypes: [] },
    { channel: 'primary', phase: 'double', operation: 'press', msfsEvent: 'LeftDouble', axis: null, inputTypes: [] },
    { channel: 'primary', phase: 'drag', operation: 'turn', msfsEvent: 'LeftDrag', axis: 'y', inputTypes: [] },
    { channel: 'secondary', phase: 'release', operation: 'release', msfsEvent: 'RightRelease', axis: null, inputTypes: [] }
  ])
  const events: string[] = []
  let cancellations = 0
  const runtime = {
    getInteractionBindings: () => [binding],
    executeInteractionBindingDirect: (_binding: CompiledInteractionBinding, options: { mouseEvent?: string }) => {
      events.push(options.mouseEvent ?? '')
      return true
    },
    cancelInteractionBinding: () => {
      cancellations += 1
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
  expect(lifecycle.execute(target, {
    source: 'mouse', operation: 'release', phase: 'release', channel: 'secondary', timestampMs: 1
  })).toBe(true)
  expect(lifecycle.execute(target, {
    source: 'mouse', operation: 'turn', phase: 'drag', channel: 'primary', pointerId: 1, axis: 'y', axisValue: 0.5, timestampMs: 2
  })).toBe(true)
  lifecycle.execute(target, {
    source: 'mouse', operation: 'cancel', phase: 'cancel', timestampMs: 3
  })
  adapter.cancel(target)

  expect(events).toEqual(['LeftSingle', 'LeftDouble', 'RightRelease', 'LeftDrag'])
  expect(cancellations).toBe(1)
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

test('bulk cancellation does not release inactive controls', () => {
  const binding = interactionBinding()
  let releases = 0
  const runtime = {
    getInteractionBindings: () => [binding],
    releaseInteractionBinding: () => { releases += 1; return true },
    readInteractionValue: () => null
  } as unknown as AircraftRuntime

  new MsfsInteractionAdapter(runtime).cancelAll()

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

test('schedules minimum hold and spring release in simulator time and cancels it explicitly', () => {
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
  runtime.cancelInteractionBinding(binding)
  runtime.update(1)
  expect(host.readVariable('L:PRESSED')).toBe(0)
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
      inverted: false, dragAnimationName: null, dragMode: 'default', dragAnimationSynced: true,
      dragScalar: 0.025, discreteGate: null, wheelPrimaryToggle: false, cursor: null, tooltipTitle: null,
      tooltipDescription: null, tooltipStateLabels: [], tooltipUnavailable: null,
      tooltipValueLabel: null, tooltipActionHints: [],
      tooltipValueExpression: expression,
      value: {
        variableKey: 'L:TEST', unit: 'number', minimum: 0, maximum: 4, step: 1,
        cyclic: false, settleTimeSeconds: 0, ...valueOverrides
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
