import { expect, test } from 'bun:test'

import { __behaviorTestHooks } from './behavior'
import type { BehaviorSourceRoot, CompiledInteractionBinding, CompiledInteractionRoute, ImportDiagnostic } from './types'

function include(relativeFile: string): Element {
  return {
    attributes: [{ name: 'RelativeFile', value: relativeFile }]
  } as unknown as Element
}

function loadedDocument(path: string, includes: readonly string[]) {
  return {
    rootUrl: 'https://example.test/package/',
    path,
    document: {} as Document,
    rootElement: {
      querySelectorAll: (selector: string) =>
        selector === 'Include' ? includes.map(include) : []
    } as unknown as Element
  }
}

test('behavior documents fetch by level and retain deterministic depth-first order', async () => {
  const paths = ['root.xml', 'a.xml', 'b.xml', 'shared.xml']
  const root: BehaviorSourceRoot = {
    rootUrl: 'https://example.test/package/',
    revision: 'test',
    layoutPathIndex: new Map(paths.map(path => [path, path])),
    resolveAssetUrl: path => new URL(path, 'https://example.test/package/').toString()
  }
  const documents = new Map([
    ['root.xml', loadedDocument('root.xml', ['a.xml', 'b.xml'])],
    ['a.xml', loadedDocument('a.xml', ['shared.xml'])],
    ['b.xml', loadedDocument('b.xml', ['shared.xml', 'root.xml'])],
    ['shared.xml', loadedDocument('shared.xml', [])]
  ])
  const loadedDocuments = new Map()
  const context = {
    pkg: {},
    aircraft: {},
    diagnostics: [],
    templateMap: new Map(),
    parameterFunctionMap: new Map(),
    loadedDocuments,
    sourceRoots: [root],
    builtinFallbackHits: new Set(),
    animationTriggerBindings: []
  }
  const starts: string[] = []
  let releaseA = (): void => {}
  const waitForA = new Promise<void>(resolve => {
    releaseA = resolve
  })
  let markSiblingsStarted = (): void => {}
  const siblingsStarted = new Promise<void>(resolve => {
    markSiblingsStarted = resolve
  })
  const load = async (_root: BehaviorSourceRoot, path: string) => {
    starts.push(path)
    if (path === 'b.xml') markSiblingsStarted()
    if (path === 'a.xml') await waitForA
    return documents.get(path) ?? null
  }

  const pending = __behaviorTestHooks.loadBehaviorDocuments(
    ['root.xml'],
    context as never,
    root,
    load
  )
  await siblingsStarted

  expect(starts).toEqual(['root.xml', 'a.xml', 'b.xml'])
  releaseA()
  await pending

  expect(starts).toEqual(['root.xml', 'a.xml', 'b.xml', 'shared.xml'])
  expect([...loadedDocuments.keys()]).toEqual([
    'https://example.test/package/::test::root.xml',
    'https://example.test/package/::test::a.xml',
    'https://example.test/package/::test::shared.xml',
    'https://example.test/package/::test::b.xml'
  ])
})

test('interaction metadata expands authored flags and value reachability', () => {
  const diagnostics: ImportDiagnostic[] = []
  const metadata = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['ID', 'TEST_KNOB'],
      ['MOUSEFLAGS', 'LeftAll+RightAll+Wheel+DownRepeat+MoveRepeat+Enter+Exit+Lock+Unlock'],
      ['DRAG_SIMVAR', 'L:TEST_VALUE'],
      ['DRAG_SIMVAR_UNITS', 'number'],
      ['DRAG_MIN_VALUE', '0'],
      ['DRAG_MAX_VALUE', '10'],
      ['VALUE_STEP', '0.5'],
      ['DRAG_SCALAR', '0.05'],
      ['DRAG_MODE', 'Trajectory'],
      ['DRAG_ANIM_SYNCED', 'False'],
      ['__SOURCE_TEMPLATE', 'ASOBO_TEST_KNOB'],
      ['PRIORITIZE_VCOCKPITS', 'True'],
      ['IGNORE_Z_TEST', 'True']
    ]),
    'TEST_KNOB',
    'TEST_KNOB',
    'test.xml',
    "(M:Event) 'WheelUp' scmi 0 == if{ 1 (>L:TEST_VALUE) }",
    'callback',
    diagnostics
  )

  expect(metadata.routes.map(route => route.msfsEvent)).toEqual([
    'LeftSingle', 'LeftDouble', 'LeftDrag', 'LeftRelease',
    'RightSingle', 'RightDouble', 'RightDrag', 'RightRelease',
    'WheelUp', 'WheelDown', 'DownRepeat', 'MoveRepeat', 'Enter', 'Exit', 'Lock', 'Unlock'
  ])
  expect(metadata.value).toEqual({
    variableKey: 'L:TEST_VALUE', unit: 'number', minimum: 0, maximum: 10,
    step: 0.5, cyclic: false, settleTimeSeconds: 0
  })
  expect([metadata.prioritizeVCockpits, metadata.ignoreZTest]).toEqual([true, true])
  expect(metadata.sourceTemplate).toBe('ASOBO_TEST_KNOB')
  expect(metadata.dragScalar).toBe(0.05)
  expect([metadata.dragMode, metadata.dragAnimationSynced]).toEqual(['trajectory', false])

  const inverted = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['MOUSEFLAGS', 'Wheel'],
      ['POSITIVE_AXIS_CODE', '(>K:TEST_DECR)'],
      ['NEGATIVE_AXIS_CODE', '(>K:TEST_INCR)']
    ]),
    'TEST',
    'TEST',
    'test.xml',
    "(M:Event) 'WheelUp' scmi 0 == if{ (>K:TEST_DECR) } els{ (>K:TEST_INCR) }",
    'callback',
    diagnostics
  )
  expect(inverted.inverted).toBe(true)
  expect(inverted.routes.map(route => [route.msfsEvent, route.operation])).toEqual([
    ['WheelUp', 'decrease'],
    ['WheelDown', 'increase']
  ])

  const dynamicDiagnostics: ImportDiagnostic[] = []
  const dynamic = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([['ID', 'DYNAMIC']]), 'DYNAMIC', 'DYNAMIC', 'dynamic.xml',
    '(M:Event) (>L:DYNAMIC_EVENT)', 'callback', dynamicDiagnostics
  )
  expect(dynamic.dynamicEventHandling).toBe(true)
  expect(dynamicDiagnostics.map(diagnostic => diagnostic.code)).toEqual(['interaction_dynamic_routes_unproven'])
})

test('compiles only authored repeat timing and diagnoses missing cadence', () => {
  const source = "(M:Event) 'DownRepeat' scmi 0 == if{ 1 (>L:COUNT) }"
  const timedDiagnostics: ImportDiagnostic[] = []
  const timed = __behaviorTestHooks.buildInteractionCodeBinding(
    source,
    null,
    new Map([
      ['NODE_ID', 'REPEATER'],
      ['MOUSEFLAGS', 'LeftSingle+DownRepeat'],
      ['MOMENTARY_REPEAT_FREQUENCY', '5']
    ]),
    'REPEATER',
    'test.xml',
    'callback',
    timedDiagnostics
  )
  expect(timed?.repeatFrequencyHz).toBe(5)
  expect(timedDiagnostics).toEqual([])

  const diagnostics: ImportDiagnostic[] = []
  const unproven = __behaviorTestHooks.buildInteractionCodeBinding(
    source,
    null,
    new Map([
      ['NODE_ID', 'REPEATER'],
      ['MOUSEFLAGS', 'LeftSingle+DownRepeat']
    ]),
    'REPEATER',
    'test.xml',
    'callback',
    diagnostics
  )
  expect(unproven?.repeatFrequencyHz).toBe(null)
  expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(['interaction_repeat_timing_unproven'])
})

test('keeps default and drag interaction-model routes separate', () => {
  const metadata = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['MOUSEFLAGS_DEFAULT_IM', 'LeftSingle'],
      ['MOUSEFLAGS_DRAG_IM', 'LeftAll+Wheel+Lock+Unlock'],
      ['DISABLE_INTERACTION_LOCK', 'True']
    ]),
    'TEST', 'TEST', 'test.xml', '(M:Event)', 'callback', []
  )

  expect(metadata.routes.filter(route => route.interactionModel === 'default').map(route => route.msfsEvent)).toEqual(['LeftSingle'])
  expect(metadata.routes.some(route => route.interactionModel === 'drag' && route.msfsEvent === 'LeftRelease')).toBe(true)
  expect(metadata.lockable).toBe(false)
})

test('keeps distinct callbacks for one interaction target', () => {
  const bindings: CompiledInteractionBinding[] = []
  const binding = (source: string, routes: readonly CompiledInteractionRoute[]) => ({
    target: 'TEST',
    expression: { source },
    releaseExpression: null,
    metadata: { qualifiedId: 'test.xml#TEST', sourceKind: 'callbackCode', routes }
  }) as CompiledInteractionBinding
  const defaultRoute = {
    interactionModel: 'default', channel: 'primary', phase: 'press', operation: 'press',
    msfsEvent: 'LeftSingle', axis: null, inputTypes: [0]
  } as const
  const dragRoutes = [
    { ...defaultRoute, interactionModel: 'drag', inputTypes: [1] },
    { ...defaultRoute, interactionModel: 'drag', phase: 'drag', operation: 'turn', msfsEvent: 'LeftDrag', inputTypes: [1] }
  ] as const

  __behaviorTestHooks.pushUniqueInteractionBinding(bindings, binding('default callback', [defaultRoute]))
  __behaviorTestHooks.pushUniqueInteractionBinding(bindings, binding('drag callback', dragRoutes))

  expect(bindings.map(candidate => candidate.expression.source)).toEqual(['default callback', 'drag callback'])
})

test('uses authored drag lifecycle code instead of a directional click fallback', () => {
  const params = new Map([
    ['DRAG_CODE', '(M:DragPercent) (>L:VALUE)'],
    ['DOWN_CODE', '1 (>O:HELD)'],
    ['RELEASE_CODE', '0 (>O:HELD)'],
    ['POSITIVE_AXIS_CODE', '(>K:DECREASE)'],
    ['NEGATIVE_AXIS_CODE', '(>K:INCREASE)']
  ])
  const source = __behaviorTestHooks.buildMouseEventInteractionCodeSource(params)
  const metadata = __behaviorTestHooks.buildCompiledInteractionMetadata(
    params, 'TEST', 'TEST', 'test.xml', source, 'callback', []
  )

  expect(source.includes("'LeftSingle' scmi 0 == if{ 1 (>O:HELD) }")).toBe(true)
  expect(source.includes("'LeftDrag' scmi 0 == if{ (M:DragPercent) (>L:VALUE) }")).toBe(true)
  expect([metadata.lockable, metadata.routes.some(route => route.operation === 'lock')]).toEqual([true, true])
})
