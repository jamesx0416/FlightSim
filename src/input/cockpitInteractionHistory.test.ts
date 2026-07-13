import { expect, test } from 'bun:test'
import { CockpitInteractionHistory } from './cockpitInteractionHistory'

test('history is a bounded persistent logical-action ring', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } as unknown as Storage
  const history = new CockpitInteractionHistory(storage, 'test', 2)
  for (const target of ['a', 'b', 'c']) history.add({ timestampMs: 1, source: 'mouse', target, action: 'press', result: 'executed' })
  expect(history.list().map(entry => entry.target)).toEqual(['b', 'c'])
  expect(new CockpitInteractionHistory(storage, 'test', 2).list().length).toBe(2)
})
