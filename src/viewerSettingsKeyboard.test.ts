import { expect, test } from 'bun:test'

import { handleViewerSettingsKeyDown } from './viewerSettingsKeyboard'

test('Escape closes open settings when no binding capture is active', () => {
  const calls: string[] = []
  const handled = handleViewerSettingsKeyDown(
    {
      key: 'Escape',
      preventDefault: () => calls.push('prevent'),
      stopPropagation: () => calls.push('stop')
    },
    true,
    () => false,
    () => calls.push('close')
  )

  expect(handled).toBe(true)
  expect(calls).toEqual(['prevent', 'stop', 'close'])
})

test('Escape cancels an active binding capture without closing settings', () => {
  const calls: string[] = []
  handleViewerSettingsKeyDown(
    {
      key: 'Escape',
      preventDefault: () => calls.push('prevent'),
      stopPropagation: () => calls.push('stop')
    },
    true,
    () => {
      calls.push('cancel')
      return true
    },
    () => calls.push('close')
  )

  expect(calls).toEqual(['prevent', 'stop', 'cancel'])
})
