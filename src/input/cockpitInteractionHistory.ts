export const COCKPIT_INTERACTION_HISTORY_VERSION = 1 as const

export interface CockpitInteractionHistoryEntry {
  readonly id: number
  readonly timestampMs: number
  readonly source: string
  readonly target: string
  readonly action: string
  readonly result: string
  readonly detail?: Readonly<Record<string, unknown>>
  readonly formatted: string
}

export interface CockpitInteractionHistoryStore {
  readonly version: typeof COCKPIT_INTERACTION_HISTORY_VERSION
  readonly nextId: number
  readonly entries: readonly CockpitInteractionHistoryEntry[]
}

export interface CockpitInteractionHistoryAddOptions {
  readonly coalesce?: {
    readonly key: string
    readonly withinMs?: number
    readonly accumulateDetail?: readonly string[]
  }
}

type NewHistoryEntry = Omit<CockpitInteractionHistoryEntry, 'id' | 'formatted'>

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim() || '-'
}

function formatDetailValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(oneLine(value))
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return oneLine(JSON.stringify(value, (_key, item) => item != null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item))
  } catch {
    return oneLine(String(value))
  }
}

export function formatCockpitInteractionHistoryEntry(entry: Omit<CockpitInteractionHistoryEntry, 'formatted'>): string {
  const date = new Date(entry.timestampMs)
  const time = Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 23) : 'invalid-time'
  const detail = Object.entries(entry.detail ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${oneLine(key)}=${formatDetailValue(value)}`)
    .join(' ')
  return `#${entry.id} ${time} ${oneLine(entry.source)} ${oneLine(entry.action)} ${oneLine(entry.target)}${detail ? ` ${detail}` : ''} ${oneLine(entry.result)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeEntries(value: unknown): CockpitInteractionHistoryEntry[] {
  if (!Array.isArray(value)) return []
  let nextId = 1
  const entries: CockpitInteractionHistoryEntry[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)
      || !Number.isFinite(candidate.timestampMs)
      || !Number.isFinite(new Date(Number(candidate.timestampMs)).getTime())
      || typeof candidate.source !== 'string'
      || typeof candidate.target !== 'string'
      || typeof candidate.action !== 'string'
      || typeof candidate.result !== 'string') continue
    const id = Number.isInteger(candidate.id) && Number(candidate.id) >= nextId ? Number(candidate.id) : nextId
    const detail = isRecord(candidate.detail) ? candidate.detail : undefined
    const entry = { id, timestampMs: Number(candidate.timestampMs), source: candidate.source, target: candidate.target, action: candidate.action, result: candidate.result, detail }
    entries.push({ ...entry, formatted: formatCockpitInteractionHistoryEntry(entry) })
    nextId = id + 1
  }
  return entries
}

export class CockpitInteractionHistory {
  private entries: CockpitInteractionHistoryEntry[]
  private nextId: number
  private pendingCoalescing?: { readonly key: string; readonly id: number; readonly timestampMs: number }
  private readonly capacity: number

  constructor(private readonly storage?: Storage, private readonly key = 'flight-sim.interaction-history.v1', capacity = 300) {
    this.capacity = Math.max(0, Math.floor(capacity))
    let parsed: unknown
    try { parsed = JSON.parse(storage?.getItem(key) ?? 'null') } catch { parsed = null }
    const storedEntries = Array.isArray(parsed) ? parsed : isRecord(parsed) && parsed.version === COCKPIT_INTERACTION_HISTORY_VERSION ? parsed.entries : []
    const normalizedEntries = normalizeEntries(storedEntries)
    this.entries = this.capacity === 0 ? [] : normalizedEntries.slice(-this.capacity)
    const storedNextId = isRecord(parsed) && Number.isInteger(parsed.nextId) ? Number(parsed.nextId) : 1
    this.nextId = Math.max(storedNextId, (this.entries.at(-1)?.id ?? 0) + 1)
    if (Array.isArray(parsed)) this.persist()
  }

  list(limit = this.capacity): readonly CockpitInteractionHistoryEntry[] {
    const count = Math.max(0, Math.floor(limit))
    return count === 0 ? [] : this.entries.slice(-count)
  }

  add(entry: NewHistoryEntry, options: CockpitInteractionHistoryAddOptions = {}): CockpitInteractionHistoryEntry {
    const coalesce = options.coalesce
    const last = this.entries.at(-1)
    const withinMs = coalesce?.withinMs ?? Number.POSITIVE_INFINITY
    if (coalesce != null && last != null && this.pendingCoalescing?.key === coalesce.key
      && this.pendingCoalescing.id === last.id && entry.timestampMs - this.pendingCoalescing.timestampMs >= 0
      && entry.timestampMs - this.pendingCoalescing.timestampMs <= withinMs) {
      const detail: Record<string, unknown> = { ...last.detail, ...entry.detail }
      for (const key of coalesce.accumulateDetail ?? []) {
        const previous = last.detail?.[key]
        const current = entry.detail?.[key]
        if (typeof previous === 'number' && typeof current === 'number') detail[key] = previous + current
      }
      const merged = { ...entry, id: last.id, timestampMs: last.timestampMs, detail }
      const value = { ...merged, formatted: formatCockpitInteractionHistoryEntry(merged) }
      this.entries[this.entries.length - 1] = value
      this.pendingCoalescing = { key: coalesce.key, id: value.id, timestampMs: entry.timestampMs }
      this.persist()
      return value
    }

    const value = { ...entry, id: this.nextId++ }
    const stored = { ...value, formatted: formatCockpitInteractionHistoryEntry(value) }
    this.entries = this.capacity === 0 ? [] : [...this.entries, stored].slice(-this.capacity)
    this.pendingCoalescing = coalesce == null ? undefined : { key: coalesce.key, id: stored.id, timestampMs: entry.timestampMs }
    this.persist()
    return stored
  }

  clear(): void {
    this.entries = []
    this.nextId = 1
    this.pendingCoalescing = undefined
    try { this.storage?.removeItem(this.key) } catch { /* history must not interrupt input */ }
  }

  private persist(): void {
    const store: CockpitInteractionHistoryStore = { version: COCKPIT_INTERACTION_HISTORY_VERSION, nextId: this.nextId, entries: this.entries }
    try { this.storage?.setItem(this.key, JSON.stringify(store)) } catch { /* history must not interrupt input */ }
  }
}

export class CockpitInteractionTrace {
  private records: unknown[] = []
  enabled = false
  add(record: unknown): void { if (this.enabled) this.records = [...this.records, record].slice(-10_000) }
  snapshot(): readonly unknown[] { return this.records }
  clear(): void { this.records = [] }
}
