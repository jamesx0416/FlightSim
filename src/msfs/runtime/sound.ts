import type {
  SoundConditionDescriptor,
  SoundDefinition,
  SoundEntryDescriptor,
  SoundRtpcDescriptor,
  SoundVariableDescriptor
} from '../contracts.ts'
import { runtimeVariableKey } from './keys.ts'

export interface SoundValueReader {
  readSoundVariable(reference: SoundVariableDescriptor): number
}

export interface ActiveSoundEntry {
  category: string
  eventName?: string
  nodeName?: string
  active: boolean
  rtpcs: Record<string, number>
}

export class SoundCompatibilityHost {
  private readonly definition?: SoundDefinition
  private readonly previousValues = new Map<string, number>()

  constructor(definition?: SoundDefinition) {
    this.definition = definition
  }

  update(reader: SoundValueReader, dtSeconds: number): ActiveSoundEntry[] {
    if (!this.definition) return []

    return (this.definition.entries ?? []).map((entry) => ({
      category: entry.category,
      eventName: entry.eventName,
      nodeName: entry.nodeName,
      active: isSoundEntryActive(entry, reader),
      rtpcs: buildRtpcSnapshot(entry, reader, this.previousValues, dtSeconds)
    }))
  }
}

function isSoundEntryActive(entry: SoundEntryDescriptor, reader: SoundValueReader): boolean {
  const sourceActive = entry.sourceVariable
    ? matchesRange(reader.readSoundVariable(entry.sourceVariable), entry.range)
    : true

  if (!sourceActive) return false

  return entry.requires.every((condition) =>
    matchesRange(reader.readSoundVariable(condition), condition.range)
  )
}

function buildRtpcSnapshot(
  entry: SoundEntryDescriptor,
  reader: SoundValueReader,
  previousValues: Map<string, number>,
  dtSeconds: number
): Record<string, number> {
  const snapshot: Record<string, number> = {}

  for (const rtpc of entry.rtpcs) {
    const value = resolveRtpcValue(rtpc, reader, previousValues, dtSeconds)
    snapshot[rtpc.rtpcName] = value
    previousValues.set(runtimeVariableKey(soundVariableToRuntimeReference(rtpc)), reader.readSoundVariable(rtpc))
  }

  return snapshot
}

function resolveRtpcValue(
  rtpc: SoundRtpcDescriptor,
  reader: SoundValueReader,
  previousValues: Map<string, number>,
  dtSeconds: number
): number {
  const current = reader.readSoundVariable(rtpc)
  if (!rtpc.derived) return current

  const key = runtimeVariableKey(soundVariableToRuntimeReference(rtpc))
  const previous = previousValues.get(key) ?? current
  if (dtSeconds <= 0) return 0
  return (current - previous) / dtSeconds
}

function matchesRange(value: number, range: SoundConditionDescriptor['range']): boolean {
  if (range?.lowerBound != null && value < range.lowerBound) return false
  if (range?.upperBound != null && value > range.upperBound) return false
  return true
}

function soundVariableToRuntimeReference(reference: SoundVariableDescriptor): {
  namespace: 'simvar' | 'lvar'
  name: string
  unit?: string
  index?: number
} {
  return {
    namespace: reference.source === 'SimVar' ? 'simvar' : 'lvar',
    name: reference.name,
    unit: reference.unit,
    index: reference.index
  }
}
