import { expect, test } from 'bun:test'

import { __behaviorTestHooks } from './behavior'
import { evaluateCompiledExpressionValue } from './rpn'
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

function testElement(tagName: string, textContent = '', children: readonly Element[] = []): Element {
  return { tagName, textContent, children, getAttribute: () => null } as unknown as Element
}

test('evaluates inclusive stock template comparisons', () => {
  const params = new Map([['NEXT_ID', '0']])
  expect(__behaviorTestHooks.evaluateTestOperator(
    testElement('GreaterOrEqual', '', [testElement('Value', 'NEXT_ID'), testElement('Number', '0')]),
    params
  )).toBe(true)
  expect(__behaviorTestHooks.evaluateTestOperator(
    testElement('LowerOrEqual', '', [testElement('Value', 'NEXT_ID'), testElement('Number', '-1')]),
    params
  )).toBe(false)
})

test('selects enabled condition content without a True wrapper', () => {
  const directChild = testElement('UseTemplate')
  const condition = {
    attributes: [{ name: 'Check', value: 'ENABLED' }],
    children: [directChild],
    getAttribute: (name: string) => name === 'Check' ? 'ENABLED' : null,
    querySelector: () => null
  } as unknown as Element

  expect(__behaviorTestHooks.selectConditionBranch(condition, new Map([['ENABLED', 'True']]))).toBe(condition)
  expect(__behaviorTestHooks.selectConditionBranch(condition, new Map([['ENABLED', 'False']]))).toBe(null)

  const falseBranch = testElement('False')
  const wrappedCondition = {
    attributes: [{ name: 'Check', value: 'ENABLED' }],
    getAttribute: (name: string) => name === 'Check' ? 'ENABLED' : null,
    querySelector: (selector: string) => selector === ':scope > False' ? falseBranch : null
  } as unknown as Element
  expect(__behaviorTestHooks.selectConditionBranch(wrappedCondition, new Map([['ENABLED', 'True']]))).toBe(null)
  expect(__behaviorTestHooks.selectConditionBranch(wrappedCondition, new Map([['ENABLED', 'False']]))).toBe(falseBranch)
})

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
      ['DRAG_AXIS_X_SCALE', '2'],
      ['DRAG_AXIS_Y_SCALE', '-3'],
      ['DRAG_AXIS_Z_SCALE', '4'],
      ['DRAG_USE_ANIM_LAG', 'True'],
      ['DRAG_MOUSEFLAGS_LOCKABLE', 'LeftDrag+RightDrag'],
      ['TEMPORARY_LOCK_FLAGS', 'LeftSingle+Wheel'],
      ['INTERACTABLE_GROUP_ID', 'TEST_GROUP'],
      ['CURSOR_DEFAULT_IM', 'Grab'],
      ['LEFTARROW_DEFAULT_IM', 'TurnLeft'],
      ['RIGHTARROW_DEFAULT_IM', 'TurnRight'],
      ['UPARROW_DEFAULT_IM', 'TurnUp'],
      ['DOWNARROW_DEFAULT_IM', 'TurnDown'],
      ['CENTER_CURSOR_DEFAULT_IM', 'Hand'],
      ['CENTER_RADIUS_DEFAULT_IM', '0.25'],
      ['CURSOR_DRAG_IM', 'Move'],
      ['DRAG_MODE', 'Trajectory'],
      ['DRAG_NODE_ID', 'TEST_KNOB_DRAG_NODE'],
      ['ANIM_NAME', 'TEST_KNOB_ANIMATION'],
      ['DRAG_ANIM_SYNCED', 'False'],
      ['__SOURCE_TEMPLATE', 'ASOBO_TEST_KNOB'],
      ['PRIORITIZE_VCOCKPITS', 'True'],
      ['IGNORE_Z_TEST', 'True'],
      ['TOOLTIP_TITLE', 'TT:TEST.TITLE'],
      ['TT_DESCRIPTION_ID', 'TT:TEST.DESCRIPTION'],
      ['TT_VALUE_OFF', "'TT:TEST.OFF'"],
      ['TT_VALUE_ON', "'TT:TEST.ON'"],
      ['TT_VALUE', "'TT:TEST.VALUE'"],
      ['ANIMTIP_0', 'TT:TEST.INCREASE'],
      ['ANIMTIP_0_ON_CURSOR', 'TurnRight'],
      ['TOOLTIP_UNAVAILABLE', 'TT:TEST.UNAVAILABLE']
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
    step: 0.5, increaseStep: 0.5, decreaseStep: 0.5,
    increaseStepExpression: null, decreaseStepExpression: null,
    cyclic: false, cyclicUpperInclusive: null, settleTimeSeconds: 0, setStates: [],
    stateExpression: {
      source: '(L:TEST_VALUE, number)',
      instructions: [{ op: 'pushVariable', key: 'L:TEST_VALUE', unit: 'number' }],
      variableKeys: ['L:TEST_VALUE, number']
    }
  })
  expect([metadata.prioritizeVCockpits, metadata.ignoreZTest]).toEqual([true, true])
  expect(metadata.sourceTemplate).toBe('ASOBO_TEST_KNOB')
  expect(metadata.dragScalar).toBe(0.05)
  expect(metadata.dragScales).toEqual({ x: 2, y: -3, z: 4 })
  expect(metadata.dragUseAnimLag).toBe(true)
  expect(metadata.dragFlagsLockable).toEqual(['LeftDrag', 'RightDrag'])
  expect(metadata.lockFlagsTemporary).toEqual(['LeftSingle', 'Wheel'])
  expect(metadata.groupId).toBe('TEST_GROUP')
  expect(metadata.cursors).toEqual({
    default: {
      cursor: 'Grab', left: 'TurnLeft', right: 'TurnRight', up: 'TurnUp', down: 'TurnDown',
      center: 'Hand', centerRadius: 0.25
    },
    drag: {
      cursor: 'Move', left: null, right: null, up: null, down: null, center: null, centerRadius: null
    }
  })
  expect([metadata.dragMode, metadata.dragAnimationSynced]).toEqual(['trajectory', false])
  expect(metadata.dragNodeId).toBe('TEST_KNOB_DRAG_NODE')
  expect(metadata.dragAnimationName).toBe('TEST_KNOB_ANIMATION')
  expect([metadata.tooltipTitle, metadata.tooltipDescription, metadata.tooltipUnavailable]).toEqual([
    'TT:TEST.TITLE', 'TT:TEST.DESCRIPTION', 'TT:TEST.UNAVAILABLE'
  ])
  expect(metadata.tooltipStateLabels).toEqual([
    { value: 0, label: 'TT:TEST.OFF' },
    { value: 1, label: 'TT:TEST.ON' }
  ])
  expect(metadata.tooltipValueLabel).toBe('TT:TEST.VALUE')
  expect(metadata.tooltipActionHints).toEqual([
    { label: 'TT:TEST.INCREASE', cursor: 'TurnRight' }
  ])

  const authoredState = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['ID', 'TEST_STATE'],
      ['GET_STATE_EXTERNAL', '(L:TEST_STATE, number) sp0'],
      ['STR_STATE_OFF', 'Off'],
      ['SET_STATE_OFF', '0 (>L:TEST_STATE, number)'],
      ['STR_STATE_ON', 'On'],
      ['SET_STATE_ON', '1 (>L:TEST_STATE, number)'],
      ['INCREMENT', '2'],
      ['DECREMENT', '1']
    ]),
    'TEST_STATE',
    'TEST_STATE',
    'test.xml',
    "(M:Event) 'WheelUp' scmi 0 == if{ 1 (>L:TEST_STATE) }",
    'callback',
    diagnostics
  )
  expect(authoredState.value.stateExpression?.source).toBe('(L:TEST_STATE, number) sp0 l0')
  expect(authoredState.value.setStates?.map(state => [state.value, state.label])).toEqual([
    [0, 'Off'], [1, 'On']
  ])
  expect([authoredState.value.increaseStep, authoredState.value.decreaseStep]).toEqual([2, 1])

  const incrementDiagnostics: ImportDiagnostic[] = []
  __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([['INCREMENT', 'p0 2 *']]),
    'TEST_DYNAMIC',
    'TEST_DYNAMIC',
    'test.xml',
    "(M:Event) 'WheelUp' scmi 0 == if{ 1 (>L:TEST_STATE) }",
    'callback',
    incrementDiagnostics
  )
  expect(incrementDiagnostics.some(diagnostic => diagnostic.code === 'interaction_dynamic_increment_unproven')).toBe(true)

  const pureSetterDiagnostics: ImportDiagnostic[] = []
  const pureSetter = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['STR_STATE_0', 'Zero'],
      ['SET_STATE_0', '1 2 +']
    ]),
    'TEST_PURE_SETTER',
    'TEST_PURE_SETTER',
    'test.xml',
    "(M:Event) 'LeftSingle' scmi 0 == if{ 1 }",
    'callback',
    pureSetterDiagnostics
  )
  expect(pureSetter.value.setStates).toEqual([])
  expect(pureSetterDiagnostics.some(diagnostic => diagnostic.code === 'interaction_static_setter_ir_unproven')).toBe(true)

  const bounded = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['NUM_STATES', '5'],
      ['VALUE_UNITS', 'Enum'],
      ['WRAPS', 'True'],
      ['WHEEL_INCREMENT', 's0 2 0.1 l0 0 == ?'],
      ['INCREMENT', '1']
    ]),
    'TEST_BOUNDED',
    'TEST_BOUNDED',
    'test.xml',
    "(M:Event) 'WheelUp' scmi 0 == if{ 1 }",
    'callback',
    incrementDiagnostics
  )
  expect([bounded.value.minimum, bounded.value.maximum, bounded.value.unit]).toEqual([0, 4, 'Enum'])
  expect(bounded.value.cyclicUpperInclusive).toBe(true)
  expect(bounded.value.increaseStep).toBe(null)
  expect(bounded.value.increaseStepExpression?.source).toBe('p15 s0 2 0.1 l0 0 == ?')

  const typed = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['IE_NAME', 'TEST_KNOB'],
      ['BINDING_INC_0', 'Increase'],
      ['BINDING_INC_0_PARAM_0', 'p0 2 *'],
      ['BINDING_INC_0_PARAM_0_IS_DYNAMIC', 'True'],
      ['INC_PARAM_0_TYPE', 'Float'],
      ['BINDING_SET_1', 'Set'],
      ['BINDING_SET_1_PARAM_0', 'p0'],
      ['BINDING_SET_1_PARAM_0_IS_DYNAMIC', 'True'],
      ['SET_PARAM_0_TYPE', 'Integer']
    ]),
    'TEST_TYPED',
    'TEST_TYPED',
    'test.xml',
    'p0 (>L:TEST_TYPED)',
    'callback',
    diagnostics
  )
  expect(typed.typedParameters?.map(parameter => [
    parameter.operation,
    parameter.bindingName,
    parameter.parameterIndex,
    parameter.type,
    parameter.dynamic,
    parameter.expression?.source
  ])).toEqual([
    ['increase', 'Increase', 0, 'number', true, 'p0 2 *'],
    ['set', 'Set', 0, 'number', true, 'p0']
  ])

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

  const fallback = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([['MOUSEFLAGS', 'Wheel']]),
    'TEST',
    'TEST',
    'test.xml',
    "(M:Event) 'LeftSingle' scmi 0 == if{ 1 (>L:TEST) }",
    'callback',
    diagnostics
  )
  expect(fallback.routes.map(route => [route.msfsEvent, route.operation])).toEqual([
    ['WheelUp', 'increase'],
    ['WheelDown', 'decrease']
  ])
  expect(fallback.routes.every(route => route.defaultWheelDirection)).toBe(true)

  const dynamicDiagnostics: ImportDiagnostic[] = []
  const dynamic = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([['ID', 'DYNAMIC']]), 'DYNAMIC', 'DYNAMIC', 'dynamic.xml',
    '(M:Event) (>L:DYNAMIC_EVENT)', 'callback', dynamicDiagnostics
  )
  expect(dynamic.dynamicEventHandling).toBe(true)
  expect(dynamicDiagnostics.map(diagnostic => diagnostic.code)).toEqual(['interaction_dynamic_routes_unproven'])
})



test('diagnoses unknown interaction model instances', () => {
  const diagnostics: ImportDiagnostic[] = []
  const container = { tagName: 'IMMouseFlagsInstances', getAttribute: () => null } as unknown as Element
  const futureModel = {
    tagName: 'IMFuture',
    textContent: 'LeftSingle',
    parentElement: container,
    getAttribute: () => null
  } as unknown as Element
  const mouseRect = {
    querySelectorAll: () => [futureModel]
  } as unknown as Element

  __behaviorTestHooks.collectMouseRectMetadata(mouseRect, new Map(), diagnostics, 'future.xml')
  expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(['interaction_model_unsupported'])
})

test('fails interaction candidates closed with structured rejection totals', () => {
  const diagnostics: ImportDiagnostic[] = []
  const base = new Map([['NODE_ID', 'TEST']])

  expect(__behaviorTestHooks.buildInteractionCodeBinding(
    '1 (>L:TEST)', null, base, 'TEST', 'test.xml', 'callback', diagnostics
  )).toBe(null)
  expect(__behaviorTestHooks.buildInteractionCodeBinding(
    '', null, new Map([...base, ['MOUSEFLAGS', 'LeftSingle']]), 'TEST', 'test.xml', 'callback', diagnostics
  )).toBe(null)
  expect(__behaviorTestHooks.buildInteractionCodeBinding(
    'if{', null, new Map([...base, ['MOUSEFLAGS', 'LeftSingle']]), 'TEST', 'test.xml', 'callback', diagnostics
  )).toBe(null)
  expect(__behaviorTestHooks.buildInteractionCodeBinding(
    '1 (>L:TEST)', null, new Map([...base, ['MOUSEFLAGS', 'FutureGesture']]), 'TEST', 'test.xml', 'callback', diagnostics
  )).toBe(null)
  expect(__behaviorTestHooks.buildInteractionCodeBinding(
    '(M:Event) (>L:TEST)', null, base, 'TEST', 'test.xml', 'callback', diagnostics
  )).toBe(null)
  expect(__behaviorTestHooks.buildInteractionCodeBinding(
    '1 (>L:TEST)', null, new Map([['MOUSEFLAGS', 'LeftSingle']]), null, 'test.xml', 'callback', diagnostics
  )).toBe(null)

  expect(diagnostics.some(diagnostic => diagnostic.code === 'interaction_event_unsupported')).toBe(true)
  expect(diagnostics.some(diagnostic => diagnostic.code === 'interaction_dynamic_routes_unproven')).toBe(true)
  expect(__behaviorTestHooks.interactionCompilerTotals(diagnostics, 2)).toEqual({
    candidates: 8,
    compiledBindings: 2,
    rejectedBindings: 6,
    rejectionReasons: {
      'route-unproven': 1,
      'missing-callback': 1,
      'invalid-expression': 1,
      'unsupported-event': 1,
      'dynamic-route-unproven': 1,
      'missing-target': 1
    }
  })
})

test('compiles mutable runtime variables as exact step expressions', () => {
  const diagnostics: ImportDiagnostic[] = []
  const metadata = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['INCREMENT', '(L:XMLVAR_Autopilot_Altitude_Increment)'],
      ['DECREMENT', '(L:XMLVAR_Autopilot_Altitude_Increment)'],
      ['MIN_VALUE', '0'],
      ['MAX_VALUE', '50000'],
      ['VALUE_UNIT', 'feet']
    ]),
    'AUTOPILOT_Knob_Altitude',
    'AUTOPILOT_Knob_Altitude',
    'Autopilot_Subtemplates.xml',
    '1 (>L:TEST)',
    'callback',
    diagnostics
  )

  expect(metadata.value.increaseStepExpression?.variableKeys).toEqual([
    'L:XMLVAR_Autopilot_Altitude_Increment'
  ])
  expect(metadata.value.decreaseStepExpression?.variableKeys).toEqual([
    'L:XMLVAR_Autopilot_Altitude_Increment'
  ])
  expect(diagnostics.some(diagnostic => diagnostic.code === 'interaction_dynamic_increment_unproven')).toBe(false)
})

test('compiles CallbackDragging axis scales from anchor-relative mouse movement', () => {
  const callback = testElement('CallbackDragging', '', [
    testElement('Variable', '#DRAG_SIMVAR#'),
    testElement('Units', 'number'),
    testElement('Scale', '10'),
    testElement('XScale', '2'),
    testElement('YScale', '-3'),
    testElement('ZScale', '4'),
    testElement('MinValue', '0'),
    testElement('MaxValue', '100'),
    testElement('IsRelative', 'True')
  ])
  const source = __behaviorTestHooks.buildCallbackDraggingSource(callback, new Map([
    ['DRAG_SIMVAR', 'TEST_VALUE']
  ]))

  expect(source).toBe(
    '(A:TEST_VALUE, number) (M:RelativeX) 2 * (M:RelativeY) -3 * + (M:RelativeZ) 4 * + 10 * + 100 min 0 max (>A:TEST_VALUE, number)'
  )
})

test('compiles authored gated-drag metadata', () => {
  const metadata = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['GATE_TOLERANCE', '0.2'],
      ['POSITION_VAR', 'Position'],
      ['STEPS_NUMBER', '3'],
      ['DRAG_SPEED', '10'],
      ['GATE_DIRECTION', '0'],
      ['IGNORE_GATE', '2']
    ]),
    'TEST_GATE', 'TEST_GATE', 'test.xml', '(M:Event)', 'callback', []
  )

  expect(metadata.discreteGate).toEqual({
    steps: 3, dragSpeed: 10, tolerance: 0.2, direction: 0, ignoredGate: 2
  })
  const invalid = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['GATE_TOLERANCE', 'invalid'],
      ['POSITION_VAR', 'Position'],
      ['STEPS_NUMBER', '3'],
      ['DRAG_SPEED', '10'],
      ['GATE_DIRECTION', '2'],
      ['IGNORE_GATE', '3']
    ]),
    'TEST_GATE', 'TEST_GATE', 'test.xml', '(M:Event)', 'callback', []
  )
  expect(invalid.discreteGate).toEqual({
    steps: 3, dragSpeed: 10, tolerance: null, direction: null, ignoredGate: null
  })
})

test('compiles dynamic formatted values and rich tooltip metadata', () => {
  const diagnostics: ImportDiagnostic[] = []
  const metadata = __behaviorTestHooks.buildCompiledInteractionMetadata(
    new Map([
      ['ID', 'DYNAMIC_TOOLTIP'],
      ['TOOLTIPID', '%((L:AVAILABLE, Bool))%{if}TT:TEST.READY%{else}TT:TEST.UNAVAILABLE%{end}'],
      ['TT_DESCRIPTION', 'TT:TEST.ACTION'],
      ['TT_VALUE', "(L:VALUE, number) '%.1f' (F:Format)"],
      ['TT_VALUE_IS_DYNAMIC', 'True'],
      ['ANIMTIP_0', '%((L:VALUE, number))%!d!'],
      ['TOOLTIP_ENTRY_1', 'opaque rich entry']
    ]),
    'DYNAMIC_TOOLTIP',
    'DYNAMIC_TOOLTIP',
    'test.xml',
    '1 (>L:TEST)',
    'callback',
    diagnostics
  )

  expect(metadata.tooltipTitle).toBe(null)
  expect(metadata.tooltipDescription).toBe('TT:TEST.ACTION')
  expect(metadata.tooltipValueLabel).toBe(null)
  expect(metadata.tooltipUnavailable).toBe(null)
  expect(metadata.tooltipEntries).toEqual([{ id: 'opaque rich entry' }])
  expect(metadata.tooltipAnimated?.entries).toEqual([{
    label: '%((L:VALUE, number))%!d!', percent: null, cursor: null, hitbox: null
  }])
  expect(metadata.tooltipFormattedValueExpression != null).toBe(true)
  expect(evaluateCompiledExpressionValue(metadata.tooltipFormattedValueExpression!, {
    readVariable: key => key === 'L:VALUE' ? 12.34 : 0
  })).toBe('12.3')
  expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual([
    'interaction_tooltip_title_ir_unsupported',
    'interaction_tooltip_action_hint_ir_unsupported'
  ])
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

test('compiles generic three-state switch wheel callbacks as canonical adjustments', () => {
  const binding = __behaviorTestHooks.buildInteractionCodeBinding(
    "(M:Event) 'WheelUp' scmi 0 == if{ 1 (>L:TEST_SWITCH) } els{ " +
      "(M:Event) 'WheelDown' scmi 0 == if{ -1 (>L:TEST_SWITCH) } }",
    null,
    new Map([
      ['NUM_STATES', '3'],
      ['SWITCH_POSITION_TYPE', 'L'],
      ['SWITCH_POSITION_VAR', 'TEST_SWITCH'],
      ['ADDITIONAL_MOUSEFLAGS', ''],
      ['DRAG_MOUSEFLAGS_LOCKABLE', 'LeftDrag+RightDrag+MiddleDrag']
    ]),
    'TEST_SWITCH',
    'test.xml',
    'callback',
    []
  )

  expect(binding?.metadata.routes.map(route => [route.msfsEvent, route.operation])).toEqual([
    ['WheelUp', 'increase'],
    ['WheelDown', 'decrease']
  ])
  expect(binding?.feedbackVariableKeys).toEqual([])
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

test('uses authored drag lifecycle code without inventing lock callbacks', () => {
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
  expect([metadata.lockable, metadata.routes.some(route => route.operation === 'lock')]).toEqual([false, false])
})

test('does not invent a click action from drag gate metadata', () => {
  const source = __behaviorTestHooks.getInteractionFallbackCodeSource(new Map([
    ['POSITION_TYPE', 'O'],
    ['POSITION_VAR', 'Position'],
    ['DRAG_SPEED', '30'],
    ['STEPS_NUMBER', '2']
  ]))

  expect(source).toBe('')
})
