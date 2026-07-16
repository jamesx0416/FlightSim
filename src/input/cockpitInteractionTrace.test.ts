import { expect, test } from 'bun:test'
import { CockpitInteractionTrace } from './cockpitInteractionHistory'

const encoder = new TextEncoder()

function serializedBytes(records: readonly unknown[]): number {
  return records.reduce<number>((total, record) => total + encoder.encode(JSON.stringify(record)).byteLength, 0)
}

test('trace stays disabled and does not build lazy payloads by default', () => {
  let calls = 0
  const trace = new CockpitInteractionTrace()
  expect(trace.add(() => { calls += 1; return { kind: 'event' } })).toBe(false)
  expect(calls).toBe(0)
  expect(trace.snapshot()).toEqual([])

  trace.enabled = true
  expect(trace.add(() => { calls += 1; return { kind: 'event' } })).toBe(true)
  expect(calls).toBe(1)
  expect(trace.snapshot()).toEqual([{ kind: 'event' }])
})

test('trace count cap drops oldest records into one overflow marker', () => {
  let now = 100
  const trace = new CockpitInteractionTrace({ maxRecords: 3, maxBytes: 10_000, now: () => now++ })
  trace.enabled = true
  for (let id = 1; id <= 5; id += 1) trace.add({ kind: 'event', id })

  expect(trace.snapshot()).toEqual([
    { kind: 'trace-overflow', timestampMs: 102, droppedRecords: 3, droppedBytes: 69 },
    { kind: 'event', id: 4 },
    { kind: 'event', id: 5 }
  ])
})

test('trace UTF-8 byte cap includes the coalesced overflow marker', () => {
  const maxBytes = 240
  const trace = new CockpitInteractionTrace({ maxRecords: 100, maxBytes, now: () => 10 })
  trace.enabled = true
  for (let id = 1; id <= 8; id += 1) trace.add({ kind: 'sample', id, payload: '£'.repeat(40) })

  const snapshot = trace.snapshot()
  expect((snapshot[0] as { kind: string }).kind).toBe('trace-overflow')
  expect(serializedBytes(snapshot) <= maxBytes).toBe(true)
  expect(snapshot.at(-1)).toEqual({ kind: 'sample', id: 8, payload: '£'.repeat(40) })
})

test('trace clear removes retained records and overflow accounting', () => {
  const trace = new CockpitInteractionTrace({ maxRecords: 2 })
  trace.enabled = true
  trace.add({ id: 1 })
  trace.add({ id: 2 })
  trace.clear()
  expect(trace.snapshot()).toEqual([])
})

test('trace exports timestamped JSON text with matching metadata', () => {
  const timestampMs = Date.UTC(2026, 6, 16, 2, 3, 4, 5)
  const trace = new CockpitInteractionTrace({ now: () => timestampMs })
  trace.enabled = true
  trace.add({ kind: 'canonical-action', target: 'BARO' })
  const exported = trace.export()
  const payload = JSON.parse(exported.text)

  expect(exported.filename).toBe('flight-sim-interaction-trace-2026-07-16T02-03-04-005Z.json')
  expect(exported.mimeType).toBe('application/json')
  const record = { kind: 'canonical-action', target: 'BARO' }
  expect(exported.metadata).toEqual({
    version: 1,
    exportedAt: '2026-07-16T02:03:04.005Z',
    recordCount: 1,
    retainedBytes: encoder.encode(JSON.stringify(record)).byteLength,
    droppedRecords: 0,
    droppedBytes: 0,
    maxRecords: 10_000,
    maxBytes: 16 * 1024 * 1024
  })
  expect(payload).toEqual({ metadata: exported.metadata, records: [record] })
})
