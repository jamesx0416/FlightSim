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

export type CanonicalElectricalSourceKind =
  | 'battery'
  | 'external'
  | 'apuGenerator'
  | 'engineGenerator'

export interface CanonicalElectricalBusConfig {
  readonly id: string
  readonly nominalVolts?: number
  readonly defaultPowered?: boolean
}

export interface CanonicalElectricalSourceConfig {
  readonly id: string
  readonly kind: CanonicalElectricalSourceKind
  readonly busId: string
  readonly engineIndex?: number
  readonly defaultAvailable?: boolean
  readonly defaultConnected?: boolean
  readonly nominalVolts?: number
}

export interface CanonicalElectricalConsumerConfig {
  readonly id: string
  readonly busId: string
  readonly defaultSwitchEnabled?: boolean
}

export interface CanonicalElectricalSystemConfig {
  readonly buses?: readonly CanonicalElectricalBusConfig[]
  readonly sources?: readonly CanonicalElectricalSourceConfig[]
  readonly consumers?: readonly CanonicalElectricalConsumerConfig[]
}

export interface CanonicalFuelTankConfig {
  readonly id: string
  readonly defaultQuantityRatio?: number
}

export interface CanonicalFuelPumpConfig {
  readonly id: string
  readonly index?: number
  readonly busConsumerId?: string
  readonly tankId?: string
  readonly defaultSwitchEnabled?: boolean
}

export interface CanonicalFuelValveConfig {
  readonly id: string
  readonly index?: number
  readonly defaultSwitchOpen?: boolean
}

export interface CanonicalFuelEngineFeedConfig {
  readonly engineIndex: number
  readonly tankId?: string
  readonly pumpIds?: readonly string[]
  readonly valveIds?: readonly string[]
}

export interface CanonicalFuelSystemConfig {
  readonly tanks?: readonly CanonicalFuelTankConfig[]
  readonly pumps?: readonly CanonicalFuelPumpConfig[]
  readonly valves?: readonly CanonicalFuelValveConfig[]
  readonly engineFeeds?: readonly CanonicalFuelEngineFeedConfig[]
}

export interface CanonicalPropulsionEngineConfig {
  readonly index: number
  readonly starterConsumerId?: string
  readonly ignitionConsumerId?: string
  readonly fuelFeedIndex?: number
  readonly generatorSourceId?: string
  readonly idleN1Percent?: number
  readonly starterN1Percent?: number
  readonly spoolUpPercentPerSecond?: number
  readonly spoolDownPercentPerSecond?: number
}

export interface CanonicalApuConfig {
  readonly starterConsumerId?: string
  readonly generatorSourceId?: string
  readonly runningRpmPercent?: number
  readonly spoolUpPercentPerSecond?: number
  readonly spoolDownPercentPerSecond?: number
}

export interface CanonicalPropulsionSystemConfig {
  readonly engines?: readonly CanonicalPropulsionEngineConfig[]
  readonly apu?: CanonicalApuConfig
}

export interface CanonicalSurfaceConfig {
  readonly id: string
  readonly controlStateKey?: string
  readonly defaultTargetRatio?: number
  readonly extensionRatePerSecond?: number
  readonly retractionRatePerSecond?: number
}

export interface CanonicalSurfaceSystemConfig {
  readonly surfaces?: readonly CanonicalSurfaceConfig[]
}

interface CanonicalSystemDefinitionBase<
  TKind extends string,
  TConfig
> {
  readonly id: string
  readonly kind: TKind
  readonly config?: TConfig
}

export type CanonicalSystemDefinition =
  | CanonicalSystemDefinitionBase<'electrical', CanonicalElectricalSystemConfig>
  | CanonicalSystemDefinitionBase<'fuel', CanonicalFuelSystemConfig>
  | CanonicalSystemDefinitionBase<'propulsion', CanonicalPropulsionSystemConfig>
  | CanonicalSystemDefinitionBase<'surfaces', CanonicalSurfaceSystemConfig>
  | CanonicalSystemDefinitionBase<'surface-animation', CanonicalSurfaceSystemConfig>

export interface CanonicalControlDefinition {
  readonly id: string
  readonly axis?: string
  readonly command?: string
}

export interface CanonicalVisualDefinition {
  readonly id: string
  readonly kind: string
  readonly stateKey?: string
  readonly channel?: 'animation' | 'visibility' | 'material'
  readonly target?: string
  readonly adapterMetadata?: Readonly<Record<string, unknown>>
}

export interface CanonicalInstrumentDefinition {
  readonly id: string
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
