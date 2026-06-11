import type {
  SimStateSource,
  SimStateValue,
  SimStateValueType,
} from './state'
import type { SimUnit } from './units'

export interface CanonicalAircraftIdentity {
  readonly id: string
  readonly displayName?: string
  readonly manufacturer?: string
  readonly variant?: string
}

export interface CanonicalStateSeed {
  readonly key: string
  readonly value: SimStateValue
  readonly unit?: SimUnit
  readonly valueType?: SimStateValueType
  readonly source?: Extract<SimStateSource, 'default' | 'subsystem' | 'loaded'>
  readonly description?: string
}

export interface CanonicalSystemDefinition {
  readonly id: string
  readonly kind: string
  readonly config?: Readonly<Record<string, unknown>>
}

export interface CanonicalControlDefinition {
  readonly id: string
  readonly axis?: string
  readonly command?: string
}

export interface CanonicalVisualDefinition {
  readonly id: string
  readonly kind: string
  readonly stateKey?: string
  readonly adapterMetadata?: Readonly<Record<string, unknown>>
}

export interface CanonicalInstrumentDefinition {
  readonly id: string
  readonly kind: string
  readonly adapterMetadata?: Readonly<Record<string, unknown>>
}

export interface CanonicalAircraftDefinition {
  readonly identity: CanonicalAircraftIdentity
  readonly initialState?: readonly CanonicalStateSeed[]
  readonly systems?: readonly CanonicalSystemDefinition[]
  readonly controls?: readonly CanonicalControlDefinition[]
  readonly visuals?: readonly CanonicalVisualDefinition[]
  readonly instruments?: readonly CanonicalInstrumentDefinition[]
  readonly adapterMetadata?: Readonly<Record<string, unknown>>
}
