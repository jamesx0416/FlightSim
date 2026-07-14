import { expect, test } from 'bun:test'

import { resolveMsfsLocalizedString, sanitizeMsfsTooltipText } from './localization'

test('resolves package tooltip keys and preserves unknown authored text', () => {
  const strings = new Map([['COCKPIT.TOOLTIPS.FLAPS_LEVER_LDG', 'Flaps full']])
  expect(resolveMsfsLocalizedString('TT:COCKPIT.TOOLTIPS.FLAPS_LEVER_LDG', strings)).toBe('Flaps full')
  expect(resolveMsfsLocalizedString('Custom control', strings)).toBe('Custom control')
  expect(sanitizeMsfsTooltipText('Heading (%((A:HEADING,degrees))%!d!°)')).toBe('Heading')
})
