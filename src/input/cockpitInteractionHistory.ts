export interface CockpitInteractionHistoryEntry {
  readonly id: number
  readonly timestampMs: number
  readonly source: string
  readonly target: string
  readonly action: string
  readonly result: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export class CockpitInteractionHistory {
  private entries: CockpitInteractionHistoryEntry[]
  constructor(private readonly storage?: Storage, private readonly key = 'flight-sim.interaction-history.v1', private readonly capacity = 300) {
    try { this.entries = JSON.parse(storage?.getItem(key) ?? '[]') } catch { this.entries = [] }
  }
  list(limit = this.capacity): readonly CockpitInteractionHistoryEntry[] { return this.entries.slice(-Math.max(0, limit)) }
  add(entry: Omit<CockpitInteractionHistoryEntry, 'id'>): CockpitInteractionHistoryEntry {
    const value = { ...entry, id: (this.entries.at(-1)?.id ?? 0) + 1 }
    this.entries = [...this.entries, value].slice(-this.capacity)
    this.storage?.setItem(this.key, JSON.stringify(this.entries))
    return value
  }
  clear(): void { this.entries = []; this.storage?.removeItem(this.key) }
}

export class CockpitInteractionTrace {
  private records: unknown[] = []
  enabled = false
  add(record: unknown): void { if (this.enabled) this.records = [...this.records, record].slice(-10_000) }
  snapshot(): readonly unknown[] { return this.records }
  clear(): void { this.records = [] }
}
