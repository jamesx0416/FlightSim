import { expect, test } from 'bun:test'

import { resolveMsfsInteractionPresentation, resolveMsfsLocalizedString, sanitizeMsfsTooltipText } from './localization'
import type { MsfsInteractionPresentationSource } from './localization'

test('resolves package tooltip keys and preserves unknown authored text', () => {
  const strings = new Map([['COCKPIT.TOOLTIPS.FLAPS_LEVER_LDG', 'Flaps full']])
  expect(resolveMsfsLocalizedString('TT:COCKPIT.TOOLTIPS.FLAPS_LEVER_LDG', strings)).toBe('Flaps full')
  expect(resolveMsfsLocalizedString('Custom control', strings)).toBe('Custom control')
  expect(sanitizeMsfsTooltipText('Heading (%((A:HEADING,degrees))%!d!°)')).toBe('Heading')
})

test('builds shared localized interaction presentation from authored metadata', () => {
  const strings = new Map([
    ['TEST.TITLE', 'Altitude increment'],
    ['TEST.DESCRIPTION', 'Select the increment'],
    ['TEST.ON', 'One thousand'],
    ['TEST.UNAVAILABLE', 'Not available while managed']
  ])
  const metadata = {
    authoredId: 'ALT_INCREMENT',
    nodeId: 'ALT_INCREMENT_NODE',
    tooltipTitle: 'TT:TEST.TITLE',
    tooltipDescription: 'TT:TEST.DESCRIPTION',
    tooltipStateLabels: [
      { value: 0, label: 'One hundred' },
      { value: 1, label: 'TT:TEST.ON' }
    ],
    tooltipUnavailable: 'TT:TEST.UNAVAILABLE',
    routes: [
      { operation: 'press' },
      { operation: 'increase' },
      { operation: 'increase' }
    ],
    value: { unit: 'number' }
  } satisfies MsfsInteractionPresentationSource

  expect(resolveMsfsInteractionPresentation(metadata, strings, { value: 1, locale: 'en-US' })).toEqual({
    title: 'Altitude increment',
    description: 'Select the increment',
    value: 'One thousand',
    actions: [
      { operation: 'press', label: 'Press' },
      { operation: 'increase', label: 'Increase' }
    ],
    unavailableMessage: 'Not available while managed'
  })
})

test('uses concise viewer fallbacks when authored presentation is absent', () => {
  const metadata = {
    authoredId: 'CABIN_ALTITUDE',
    nodeId: null,
    tooltipTitle: null,
    tooltipDescription: null,
    tooltipStateLabels: [],
    tooltipUnavailable: null,
    routes: [],
    value: { unit: 'feet' }
  } satisfies MsfsInteractionPresentationSource

  expect(resolveMsfsInteractionPresentation(metadata, new Map(), { value: 1250, locale: 'en-US' })).toEqual({
    title: 'CABIN_ALTITUDE',
    description: null,
    value: '1,250 feet',
    actions: [],
    unavailableMessage: 'Unavailable'
  })
})
