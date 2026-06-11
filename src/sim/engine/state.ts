import { convertSimUnit, type SimUnit } from './units'

export type SimStateValue = number | string | boolean
export type SimStateValueType = 'number' | 'string' | 'boolean'
export type SimStateSource = 'default' | 'subsystem' | 'loaded' | 'runtime'

export const SIM_STATE_SOURCE_PRIORITY: Record<SimStateSource, number> = {
  default: 0,
  subsystem: 10,
  loaded: 20,
  runtime: 30,
}

export interface SimStateDefinition {
  readonly key: string
  readonly unit?: SimUnit
  readonly valueType?: SimStateValueType
  readonly defaultValue?: SimStateValue
  readonly description?: string
}

export interface SimStateWriteOptions {
  readonly source: SimStateSource
  readonly unit?: SimUnit
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SimStateEntry {
  readonly key: string
  readonly value: SimStateValue
  readonly unit?: SimUnit
  readonly source: SimStateSource
  readonly priority: number
  readonly revision: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SimStateChangeEvent {
  readonly key: string
  readonly previous: SimStateEntry | undefined
  readonly current: SimStateEntry | undefined
}

export type SimStateListener = (event: SimStateChangeEvent) => void

export class SimStateStore {
  private readonly definitions = new Map<string, SimStateDefinition>()
  private readonly valuesBySource = new Map<
    string,
    Map<SimStateSource, SimStateEntry>
  >()
  private readonly listeners = new Set<SimStateListener>()
  private revision = 0

  define(definition: SimStateDefinition): void {
    const existing = this.definitions.get(definition.key)
    this.definitions.set(definition.key, {
      ...existing,
      ...definition,
    })

    if ('defaultValue' in definition) {
      this.set(definition.key, definition.defaultValue as SimStateValue, {
        source: 'default',
        unit: definition.unit,
      })
    }
  }

  defineMany(definitions: readonly SimStateDefinition[]): void {
    for (const definition of definitions) {
      this.define(definition)
    }
  }

  set(key: string, value: SimStateValue, options: SimStateWriteOptions): void {
    const previous = this.getEntry(key)
    const definition = this.definitions.get(key)
    const storedUnit = definition?.unit ?? options.unit
    const storedValue = coerceStateValue(value, definition, options.unit)
    const sourceValues = getOrCreateSourceValues(this.valuesBySource, key)

    this.revision += 1
    sourceValues.set(options.source, {
      key,
      value: storedValue,
      unit: storedUnit,
      source: options.source,
      priority: SIM_STATE_SOURCE_PRIORITY[options.source],
      revision: this.revision,
      metadata: options.metadata,
    })

    this.emitIfChanged(key, previous, this.getEntry(key))
  }

  clearSource(key: string, source: SimStateSource): void {
    const previous = this.getEntry(key)
    const sourceValues = this.valuesBySource.get(key)

    if (sourceValues == null || !sourceValues.delete(source)) {
      return
    }

    if (sourceValues.size === 0) {
      this.valuesBySource.delete(key)
    }

    this.emitIfChanged(key, previous, this.getEntry(key))
  }

  clearSourceValues(source: SimStateSource): void {
    const keys = [...this.valuesBySource.keys()]

    for (const key of keys) {
      this.clearSource(key, source)
    }
  }

  read<T extends SimStateValue = SimStateValue>(key: string): T | undefined {
    return this.getEntry(key)?.value as T | undefined
  }

  readNumber(
    key: string,
    options: { readonly unit?: SimUnit; readonly fallback?: number } = {}
  ): number | undefined {
    const entry = this.getEntry(key)

    if (entry == null) {
      return options.fallback
    }

    if (typeof entry.value === 'boolean') {
      return entry.value ? 1 : 0
    }

    if (typeof entry.value !== 'number') {
      return options.fallback
    }

    if (options.unit != null && entry.unit != null) {
      return convertSimUnit(entry.value, entry.unit, options.unit)
    }

    return entry.value
  }

  readBoolean(
    key: string,
    options: { readonly fallback?: boolean } = {}
  ): boolean | undefined {
    const value = this.read(key)

    if (typeof value === 'boolean') {
      return value
    }

    if (typeof value === 'number') {
      return value !== 0
    }

    return options.fallback
  }

  getEntry(key: string): SimStateEntry | undefined {
    const sourceValues = this.valuesBySource.get(key)

    if (sourceValues == null) {
      return undefined
    }

    let selected: SimStateEntry | undefined

    for (const entry of sourceValues.values()) {
      if (
        selected == null ||
        entry.priority > selected.priority ||
        (entry.priority === selected.priority && entry.revision > selected.revision)
      ) {
        selected = entry
      }
    }

    return selected
  }

  getDefinition(key: string): SimStateDefinition | undefined {
    return this.definitions.get(key)
  }

  listDefinitions(): readonly SimStateDefinition[] {
    return [...this.definitions.values()]
  }

  subscribe(listener: SimStateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitIfChanged(
    key: string,
    previous: SimStateEntry | undefined,
    current: SimStateEntry | undefined
  ): void {
    if (stateEntriesAreEquivalent(previous, current)) {
      return
    }

    for (const listener of this.listeners) {
      listener({ key, previous, current })
    }
  }
}

function getOrCreateSourceValues(
  valuesBySource: Map<string, Map<SimStateSource, SimStateEntry>>,
  key: string
): Map<SimStateSource, SimStateEntry> {
  const existing = valuesBySource.get(key)

  if (existing != null) {
    return existing
  }

  const created = new Map<SimStateSource, SimStateEntry>()
  valuesBySource.set(key, created)
  return created
}

function coerceStateValue(
  value: SimStateValue,
  definition: SimStateDefinition | undefined,
  incomingUnit: SimUnit | undefined
): SimStateValue {
  const expectedType = definition?.valueType ?? inferValueType(definition, value)

  if (typeof value !== expectedType) {
    throw new TypeError(
      `State value for ${definition?.key ?? 'unregistered key'} must be ${expectedType}`
    )
  }

  if (
    typeof value === 'number' &&
    definition?.unit != null &&
    incomingUnit != null
  ) {
    return convertSimUnit(value, incomingUnit, definition.unit)
  }

  return value
}

function inferValueType(
  definition: SimStateDefinition | undefined,
  value: SimStateValue
): SimStateValueType {
  if (definition?.unit === 'boolean') {
    return 'boolean'
  }

  if (definition?.unit != null) {
    return 'number'
  }

  if (typeof value === 'number') {
    return 'number'
  }

  if (typeof value === 'boolean') {
    return 'boolean'
  }

  return 'string'
}

function stateEntriesAreEquivalent(
  left: SimStateEntry | undefined,
  right: SimStateEntry | undefined
): boolean {
  return (
    left?.key === right?.key &&
    left?.value === right?.value &&
    left?.unit === right?.unit &&
    left?.source === right?.source
  )
}
