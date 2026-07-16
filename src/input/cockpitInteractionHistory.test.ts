import { expect, test } from 'bun:test'
import {
  CockpitInteractionHistory,
  formatCockpitInteractionHistoryEntry
} from './cockpitInteractionHistory'

function memoryStorage(initial?: string): { readonly storage: Storage; readonly values: Map<string, string> } {
  const values = new Map<string, string>(initial == null ? [] : [['test', initial]])
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) }
    } as unknown as Storage
  }
}

test('history persists a bounded versioned logical-action store', () => {
  const { storage, values } = memoryStorage()
  const history = new CockpitInteractionHistory(storage, 'test', 2)
  for (const target of ['a', 'b', 'c']) history.add({ timestampMs: 1, source: 'mouse', target, action: 'press', result: 'executed' })

  expect(history.list().map(entry => entry.target)).toEqual(['b', 'c'])
  expect(new CockpitInteractionHistory(storage, 'test', 2).list().map(entry => entry.target)).toEqual(['b', 'c'])
  const stored = JSON.parse(values.get('test')!)
  expect({ version: stored.version, nextId: stored.nextId, ids: stored.entries.map((entry: { id: number }) => entry.id) }).toEqual({ version: 1, nextId: 4, ids: [2, 3] })
})

test('history safely migrates the existing raw array', () => {
  const { storage, values } = memoryStorage(JSON.stringify([
    { id: 7, timestampMs: 1, source: 'mouse', target: 'BARO', action: 'primary', result: 'executed', detail: { route: 'LeftSingle' } },
    { id: 8, timestampMs: 9e15, source: 'mouse', target: 'INVALID_DATE', action: 'primary', result: 'executed' },
    { id: 8, source: 'invalid' }
  ]))
  const history = new CockpitInteractionHistory(storage, 'test')

  expect(history.list().length).toBe(1)
  expect({ id: history.list()[0]?.id, target: history.list()[0]?.target, formatted: history.list()[0]?.formatted }).toEqual({
    id: 7,
    target: 'BARO',
    formatted: '#7 00:00:00.001 mouse primary BARO route="LeftSingle" executed'
  })
  const stored = JSON.parse(values.get('test')!)
  expect({ version: stored.version, nextId: stored.nextId, ids: stored.entries.map((entry: { id: number }) => entry.id) }).toEqual({ version: 1, nextId: 8, ids: [7] })
})

test('history honors a zero capacity when loading stored entries', () => {
  const { storage } = memoryStorage(JSON.stringify([
    { id: 1, timestampMs: 1, source: 'mouse', target: 'BARO', action: 'primary', result: 'executed' }
  ]))
  const history = new CockpitInteractionHistory(storage, 'test', 0)
  history.add({ timestampMs: 2, source: 'mouse', target: 'BARO', action: 'primary', result: 'executed' })
  expect(history.list()).toEqual([])
})

test('history formatting is stable and always one line', () => {
  const formatted = formatCockpitInteractionHistoryEntry({
    id: 3,
    timestampMs: 3,
    source: 'mouse\nwheel',
    target: 'camera.zoom',
    action: 'decrease',
    result: 'completed',
    detail: { zeta: { b: 2, a: 1 }, alpha: 'two\nlines' }
  })
  expect(formatted).toBe('#3 00:00:00.003 mouse wheel decrease camera.zoom alpha="two lines" zeta={"a":1,"b":2} completed')
  expect(formatted.includes('\n')).toBe(false)
})

test('history coalesces contiguous gestures and 120 ms wheel bursts', () => {
  const history = new CockpitInteractionHistory(undefined, 'test')
  const firstDrag = history.add({ timestampMs: 0, source: 'mouse', target: 'camera.pan', action: 'drag', result: 'active', detail: { dx: 10, dy: -2 } }, {
    coalesce: { key: 'camera-pan:1', accumulateDetail: ['dx', 'dy'] }
  })
  const lastDrag = history.add({ timestampMs: 500, source: 'mouse', target: 'camera.pan', action: 'drag', result: 'completed', detail: { dx: 5, dy: -3, durationMs: 500 } }, {
    coalesce: { key: 'camera-pan:1', accumulateDetail: ['dx', 'dy'] }
  })
  expect(lastDrag.id).toBe(firstDrag.id)
  expect(lastDrag.detail).toEqual({ dx: 15, dy: -5, durationMs: 500 })

  history.add({ timestampMs: 600, source: 'mouse', target: 'BARO', action: 'wheel', result: 'executed', detail: { delta: -120, steps: 1 } }, {
    coalesce: { key: 'wheel:BARO:increase', withinMs: 120, accumulateDetail: ['delta', 'steps'] }
  })
  history.add({ timestampMs: 710, source: 'mouse', target: 'BARO', action: 'wheel', result: 'executed', detail: { delta: -120, steps: 1 } }, {
    coalesce: { key: 'wheel:BARO:increase', withinMs: 120, accumulateDetail: ['delta', 'steps'] }
  })
  history.add({ timestampMs: 831, source: 'mouse', target: 'BARO', action: 'wheel', result: 'executed', detail: { delta: -120, steps: 1 } }, {
    coalesce: { key: 'wheel:BARO:increase', withinMs: 120, accumulateDetail: ['delta', 'steps'] }
  })

  expect(history.list().map(entry => entry.id)).toEqual([1, 2, 3])
  expect(history.list()[1]?.detail).toEqual({ delta: -240, steps: 2 })
})

test('click and exact Set/Adjust summaries remain one logical entry each', () => {
  const history = new CockpitInteractionHistory()
  history.add({ timestampMs: 1, source: 'mouse', target: 'LIGHT', action: 'click', result: 'executed' })
  history.add({ timestampMs: 2, source: 'devapi', target: 'BARO', action: 'set', result: 'executed', detail: { requested: 1013, steps: 4 } })
  history.add({ timestampMs: 3, source: 'devapi', target: 'BARO', action: 'adjust', result: 'executed', detail: { delta: 2, steps: 2 } })
  expect(history.list().length).toBe(3)
})
