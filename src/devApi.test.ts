import { expect, test } from 'bun:test'

import { __devApiInteractionTestHooks, validateDevApiCameraPose } from './devApi'
import { DEFAULT_COCKPIT_INPUT_PROFILE_ID, DEFAULT_COCKPIT_INPUT_STORE } from './input/cockpitInputProfiles'
import type { CanonicalCockpitAction } from './input/cockpitInteraction'
import type { MsfsInteractionTarget } from './msfs/interactionAdapter'
import type { CompiledInteractionBlocker, CompiledInteractionRoute } from './msfs/types'

function interactionTarget(): MsfsInteractionTarget {
  const route: CompiledInteractionRoute = {
    interactionModel: 'default',
    channel: 'primary',
    phase: 'press',
    operation: 'press',
    msfsEvent: 'LeftSingle',
    axis: null,
    inputTypes: [1]
  }
  const binding = {
    target: 'CONTROL_NODE',
    feedbackTargets: ['CONTROL_FEEDBACK'],
    feedbackVariableKeys: ['L:CONTROL'],
    soundEvents: [],
    minHeldDurationSeconds: 0.4,
    animationDurationSeconds: 0.2,
    repeatFrequencyHz: 2,
    expression: { source: '', instructions: [] },
    releaseExpression: null,
    sourcePath: 'controls.xml',
    metadata: {
      authoredId: 'CONTROL',
      qualifiedId: 'controls.xml#CONTROL',
      nodeId: 'CONTROL_NODE',
      componentId: 'CONTROL_COMPONENT',
      inputEventIds: [],
      covers: ['CONTROL_GUARD'],
      routes: [route],
      sourceKind: 'callbackCode',
      sourcePath: 'controls.xml',
      sourceTemplate: 'ASOBO_GT_Interaction_LeftSingle_Code',
      templateRevision: '1',
      lockable: false,
      dynamicEventHandling: false,
      disabled: false,
      disabledInVr: false,
      prioritizeVCockpits: false,
      ignoreZTest: false,
      highlightNodeId: null,
      axis: null,
      inverted: false,
      dragNodeId: null,
      dragAnimationName: null,
      dragMode: 'default',
      dragAnimationSynced: false,
      dragScalar: 1,
      discreteGate: null,
      wheelPrimaryToggle: false,
      cursor: 'pointer',
      tooltipTitle: 'TT:CONTROL_TITLE',
      tooltipDescription: 'Authored description',
      tooltipStateLabels: [{ value: 1, label: 'TT:STATE_ON' }],
      tooltipValueLabel: null,
      tooltipActionHints: [{ label: 'Use control', cursor: 'pointer' }],
      tooltipUnavailable: 'Not available',
      tooltipValueExpression: null,
      value: { variableKey: 'L:CONTROL', unit: 'number', minimum: 0, maximum: 1, step: 1, cyclic: false, settleTimeSeconds: 0.1 }
    }
  }
  return {
    id: 'controls.xml#CONTROL',
    lockable: false,
    operations: ['press', 'hold', 'release', 'adjust'],
    binding,
    bindings: [binding]
  } as unknown as MsfsInteractionTarget
}

test('interaction requests return structured ambiguity and busy envelopes', () => {
  const ambiguous = __devApiInteractionTestHooks.resolveInteractionRequest(
    'SWITCH', { ok: false, code: 'TARGET_AMBIGUOUS', candidates: ['a.xml#SWITCH', 'b.xml#SWITCH'] }, new Set()
  )
  expect(ambiguous.ok ? null : ambiguous.result).toEqual({
    ok: false, code: 'TARGET_AMBIGUOUS', message: 'Interaction target "SWITCH" is ambiguous.',
    data: { target: 'SWITCH', candidates: ['a.xml#SWITCH', 'b.xml#SWITCH'] },
    suggestions: ['a.xml#SWITCH', 'b.xml#SWITCH']
  })

  const target = { id: 'a.xml#SWITCH' } as MsfsInteractionTarget
  const busy = __devApiInteractionTestHooks.resolveInteractionRequest('SWITCH', { ok: true, target }, new Set([target.id]))
  expect(busy.ok ? null : busy.result.code).toBe('TARGET_BUSY')
})

test('input profile API manages v2 profiles and package-scoped selections without implicit selection', () => {
  let store = structuredClone(DEFAULT_COCKPIT_INPUT_STORE)
  let commitCount = 0
  const profiles = __devApiInteractionTestHooks.createCockpitInputProfilesApi({
    getStore: () => store,
    commit: next => {
      store = next
      commitCount += 1
    },
    packageRoot: '/current-package',
    aircraftId: 'current-aircraft'
  })

  const created = profiles.create('Captain')
  expect(created.ok).toBe(true)
  expect(created.data).toEqual({ id: 'captain', name: 'Captain' })
  expect(store.selectedGlobalProfileId).toBe(DEFAULT_COCKPIT_INPUT_PROFILE_ID)

  const duplicated = profiles.duplicate('captain')
  expect(duplicated.data).toEqual({ id: 'captain-copy', name: 'Captain Copy' })
  expect(store.selectedGlobalProfileId).toBe(DEFAULT_COCKPIT_INPUT_PROFILE_ID)
  expect(profiles.rename('captain', 'Pilot').ok).toBe(true)
  expect(profiles.selectGlobal('captain').ok).toBe(true)
  expect(profiles.selectAircraft('/package-a', 'shared', 'captain').ok).toBe(true)
  expect(profiles.selectAircraft('/package-b', 'shared', 'captain-copy').ok).toBe(true)

  expect(profiles.effective(undefined, '/package-a', 'shared').data).toEqual({
    id: 'captain',
    name: 'Pilot',
    interactionMode: 'legacy',
    showHighlights: true,
    showTooltips: true,
    invertDefaultScrollDirection: false,
    bindings: {
      interaction: { Mouse0: 'primary', Mouse1: 'tertiary', Mouse2: 'secondary', WheelUp: 'increase', WheelDown: 'decrease' },
      emptyCockpit: { Mouse0: 'cameraPan', Mouse1: 'cameraPan', Mouse2: 'cameraPan', WheelUp: 'cameraZoomIn', WheelDown: 'cameraZoomOut' },
      shortcuts: { stop: 'Escape' }
    }
  })
  expect((profiles.effective(undefined, '/package-b', 'shared').data as { id: string }).id).toBe('captain-copy')
  expect((profiles.effective().data as { id: string }).id).toBe('captain')

  expect(profiles.reset('captain').ok).toBe(true)
  expect(profiles.delete('captain-copy').ok).toBe(true)
  expect((profiles.effective(undefined, '/package-b', 'shared').data as { id: string }).id).toBe('captain')
  expect(profiles.selectAircraft('/package-a', 'shared', null).ok).toBe(true)
  expect((profiles.effective(undefined, '/package-a', 'shared').data as { id: string }).id).toBe('captain')

  const missing = profiles.get('missing')
  expect([missing.ok, missing.code, missing.suggestions]).toEqual([
    false,
    'PROFILE_NOT_FOUND',
    [DEFAULT_COCKPIT_INPUT_PROFILE_ID, 'captain']
  ])
  expect(profiles.delete(DEFAULT_COCKPIT_INPUT_PROFILE_ID).code).toBe('PROFILE_PROTECTED')
  expect(profiles.effective(undefined, '/package-only').code).toBe('INVALID_ARGUMENT')
  expect(profiles.import({ version: 1 }).code).toBe('INVALID_STORE')

  const exported = profiles.export().data
  expect(profiles.import(exported).ok).toBe(true)
  expect(profiles.list().data).toEqual(store.profiles)
  expect(commitCount).toBe(10)
})

test('semantic variants fail closed without reinterpreting source metadata', () => {
  expect(__devApiInteractionTestHooks.rejectUnauthoredVariant('CONTROL', undefined)).toBe(null)
  expect(__devApiInteractionTestHooks.rejectUnauthoredVariant('CONTROL', 'callbackCode')).toEqual({
    ok: false,
    code: 'VARIANT_NOT_AUTHORED',
    message: 'No authored semantic variant identifiers are available for "CONTROL".',
    data: { target: 'CONTROL', requestedVariant: 'callbackCode', variants: [] },
    suggestions: []
  })
})

test('canonical dispatch starts immediately and preserves every supplied action field', async () => {
  const target = interactionTarget()
  const route = target.binding.metadata.routes[0]!
  const action: CanonicalCockpitAction = {
    source: 'touch',
    operation: 'adjust',
    phase: 'drag',
    pointerId: 42,
    channel: 'tertiary',
    axis: 'z',
    axisValue: 0.4,
    delta: -2,
    dragPercent: 0.75,
    steps: 3,
    direction: 'down',
    value: 17,
    unit: 'knots',
    timestampMs: 123
  }
  let dispatchedAction: CanonicalCockpitAction | null = null
  let tracedAction: CanonicalCockpitAction | null = null
  const promise = __devApiInteractionTestHooks.startCanonicalInteractionDispatch('CONTROL', action, {
    resolve: () => ({ ok: true, target }),
    busyTargetIds: () => new Set(),
    route: (_target, received) => received === action ? route : null,
    dispatch: (_target, received) => { dispatchedAction = received; return 'executed' },
    onExecuted: (_target, received) => { tracedAction = received }
  })

  expect(dispatchedAction).toBe(action)
  expect(tracedAction).toBe(action)
  const result = await promise
  expect((result.data as { action: CanonicalCockpitAction }).action).toBe(action)
  const invalid = await __devApiInteractionTestHooks.startCanonicalInteractionDispatch(
    'CONTROL',
    null as unknown as CanonicalCockpitAction,
    {
      resolve: () => { throw new Error('must not resolve') },
      busyTargetIds: () => new Set(),
      route: () => route,
      dispatch: () => 'executed'
    }
  )
  expect(invalid.code).toBe('INVALID_ACTION')
})

test('interaction summaries expose stable unknown metadata and proven presentation fields', () => {
  const target = interactionTarget()
  const localization = new Map([
    ['CONTROL_TITLE', 'Localized control'],
    ['STATE_ON', 'On']
  ])
  const summary = __devApiInteractionTestHooks.summarizeInteractionTarget(target, 2, 1, null, localization)
  expect({
    controlKind: summary.controlKind,
    title: summary.title,
    formattedValue: summary.formattedValue,
    ambiguous: summary.ambiguous,
    diagnostics: (summary.diagnostics as Array<{ code: string }>).map(diagnostic => diagnostic.code)
  }).toEqual({
    controlKind: 'unknown',
    title: 'Localized control',
    formattedValue: 'On',
    ambiguous: true,
    diagnostics: ['interaction_control_kind_unproven']
  })

  const blockers: CompiledInteractionBlocker[] = [
    { target: 'CONTROL_NODE', feedbackTargets: [], sourcePath: 'controls.xml' },
    { target: 'OTHER_NODE', feedbackTargets: [], sourcePath: 'other.xml' }
  ]
  const description = __devApiInteractionTestHooks.describeInteractionTarget(target, {
    packageId: 'package',
    packageVersion: '1.0',
    currentValue: 1,
    formattedValue: null,
    localization,
    localizationAvailable: true,
    blockers,
    diagnostics: [
      { code: 'source_warning', severity: 'warning', message: 'Source-wide warning.', sourcePath: 'controls.xml' },
      { code: 'other_warning', severity: 'warning', message: 'Other source.', sourcePath: 'other.xml' }
    ]
  })
  expect({
    cursor: description.cursor,
    sourceKind: description.sourceKind,
    value: description.value,
    dragMode: description.dragMode,
    dragAnimationSynced: description.dragAnimationSynced,
    dragNodeId: description.dragNodeId,
    bindingVariants: description.bindingVariants,
    expression: description.expression,
    releaseExpression: description.releaseExpression,
    controlKind: description.controlKind,
    declarationOccurrence: description.declarationOccurrence,
    typedParameters: description.typedParameters,
    variants: description.variants,
    covers: description.covers,
    blockers: description.blockers,
    diagnosticScopes: (description.diagnostics as Array<{ code: string; scope: string }>).map(diagnostic => [diagnostic.code, diagnostic.scope]),
    localization: description.localization,
    timing: description.timing
  }).toEqual({
    cursor: 'pointer',
    sourceKind: 'callbackCode',
    value: { variableKey: 'L:CONTROL', unit: 'number', minimum: 0, maximum: 1, step: 1, cyclic: false, settleTimeSeconds: 0.1 },
    dragMode: 'default',
    dragAnimationSynced: false,
    dragNodeId: null,
    bindingVariants: [{
      sourceKind: 'callbackCode',
      sourceTemplate: 'ASOBO_GT_Interaction_LeftSingle_Code',
      dragMode: 'default',
      dragAnimationSynced: false,
      dragNodeId: null,
      dragAnimationName: null,
      routes: [target.binding.metadata.routes[0]]
    }],
    expression: target.binding.expression,
    releaseExpression: null,
    controlKind: 'unknown',
    declarationOccurrence: null,
    typedParameters: [],
    variants: [],
    covers: ['CONTROL_GUARD'],
    blockers: [blockers[0]],
    diagnosticScopes: [
      ['interaction_control_kind_unproven', 'contract'],
      ['interaction_declaration_occurrence_unproven', 'contract'],
      ['interaction_typed_parameters_unproven', 'contract'],
      ['interaction_variants_unproven', 'contract'],
      ['source_warning', 'source']
    ],
    localization: {
      title: 'Localized control',
      description: 'Authored description',
      value: 'On',
      actions: [{ operation: 'press', label: 'Press' }],
      actionHints: [{ label: 'Use control', cursor: 'pointer' }],
      unavailableMessage: 'Not available'
    },
    timing: [{ sourcePath: 'controls.xml', minHeldDurationSeconds: 0.4, animationDurationSeconds: 0.2, repeatFrequencyHz: 2, settleTimeSeconds: 0.1 }]
  })
})

test('active status is structured and held release falls back to the stored target', () => {
  const target = interactionTarget()
  const active = new Map([[target.id, {
    target,
    operation: 'hold' as const,
    source: 'devapi' as const,
    lifecycle: 'held' as const,
    startedAtMs: 100,
    stopStatus: 'active' as const
  }]])
  const fallback = __devApiInteractionTestHooks.resolveInteractionWithHeldFallback(
    'CONTROL',
    'release',
    { ok: false, code: 'TARGET_AMBIGUOUS', candidates: ['a', 'b'] },
    active
  )
  expect(fallback.ok ? fallback.target : null).toBe(target)
  expect(__devApiInteractionTestHooks.listActiveInteractionStates(active, ['adapter-only'], ['dispatcher-only'])).toEqual([
    { target: target.id, operation: 'hold', source: 'devapi', lifecycle: 'held', startedAtMs: 100, stopStatus: 'active' },
    { target: 'adapter-only', operation: 'unknown', source: 'unknown', lifecycle: 'adapter-active', startedAtMs: null, stopStatus: 'active' },
    { target: 'dispatcher-only', operation: 'unknown', source: 'unknown', lifecycle: 'dispatcher-active', startedAtMs: null, stopStatus: 'active' }
  ])
})

test('camera poses round-trip exactly and malformed fields fail before mutation', () => {
  const pose = {
    position: [1, 2, 3],
    quaternion: [0, 0.5, 0, 0.8660254037844386],
    target: [4, 5, 6],
    cockpitActive: true,
    fov: 50
  } as const
  expect(validateDevApiCameraPose(pose)).toEqual(pose)

  expect(validateDevApiCameraPose({ ...pose, quaterion: pose.quaternion })).toEqual({
    code: 'INVALID_ARGUMENTS',
    path: 'pose.quaterion',
    expected: 'one of position, quaternion, target, cockpitActive, fov',
    received: pose.quaternion,
    suggestion: 'quaternion'
  })
  expect(validateDevApiCameraPose({ ...pose, position: [1, 2] })).toEqual({
    code: 'INVALID_ARGUMENTS',
    path: 'pose.position',
    expected: 'an array of 3 finite numbers',
    received: [1, 2]
  })
  expect(validateDevApiCameraPose({ ...pose, cockpitActive: 'yes' })).toEqual({
    code: 'INVALID_ARGUMENTS',
    path: 'pose.cockpitActive',
    expected: 'a boolean',
    received: 'yes'
  })
  expect(validateDevApiCameraPose({ ...pose, fov: 180 })).toEqual({
    code: 'INVALID_ARGUMENTS',
    path: 'pose.fov',
    expected: 'a finite number greater than 0 and less than 180',
    received: 180
  })
})
