import type { CanonicalAircraftDefinition } from './aircraft'
import type { SimCommand } from './commands'
import type { SimStateValue } from './state'
import type { SimUnit } from './units'

export interface AdapterBridge {
  readonly id: string
  loadAircraft?(aircraft: CanonicalAircraftDefinition): void
  readState?(key: string, unit?: SimUnit): SimStateValue | undefined
  writeState?(key: string, value: SimStateValue, unit?: SimUnit): void
  dispatchCommand?(command: SimCommand): void
}
