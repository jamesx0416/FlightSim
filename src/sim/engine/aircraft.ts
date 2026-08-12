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
  readonly capacityKg?: number
  readonly positionBodyM?: readonly [number, number, number]
  readonly priority?: number
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
  readonly highN1Percent?: number
  readonly n1NormalIntegrationRate?: number
  readonly staticThrustN?: number
  readonly thrustScalar?: number
  readonly machInfluenceOnN1?: number
  readonly useCommandedNeTable?: boolean
  readonly commandedNeLowMach?: CanonicalMachLookupTable2D
  readonly commandedNeHighMach?: CanonicalMachLookupTable2D
  readonly useN2ToN1Table?: boolean
  readonly n2ToN1ByCorrectedN2AndMach?: CanonicalLookupTable2D
  readonly starterN1RatePercentPerSecond?: number
  readonly minN1ForCombustionPercent?: number
  readonly thrustByCorrectedN1AndMach?: CanonicalLookupTable2D
  readonly correctedAirflowByCorrectedN1AndMach?: CanonicalLookupTable2D
  readonly inletAreaM2?: number
  readonly supersonicRamDrag?: boolean
  readonly variableInlet?: boolean
  readonly supersonicInlet?: boolean
  readonly supersonicInletDesignMach?: number
  readonly positionBodyM?: readonly [number, number, number]
  readonly thrustDirectionBody?: readonly [number, number, number]
  readonly idleFuelFlowKgPerSecond?: number
  readonly highFuelFlowKgPerSecond?: number
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


export interface CanonicalLookupTable1D {
  readonly breakpoints: readonly number[]
  readonly values: readonly number[]
}

export interface CanonicalLookupTable2D {
  readonly breakpointsX: readonly number[]
  readonly breakpointsY: readonly number[]
  readonly values: readonly number[]
}

export interface CanonicalMachLookupTable2D {
  readonly mach: number
  readonly table: CanonicalLookupTable2D
}

export interface CanonicalAirPhysicsGeometry {
  readonly wingAreaM2: number
  readonly wingSpanM: number
  readonly wingRootChordM: number
  readonly wingTipChordM: number
  readonly meanChordM: number
  readonly wingIncidenceRad: number
  readonly wingDihedralRad: number
  readonly wingSweepRad: number
  readonly wingTwistRad: number
  readonly aerodynamicCenterBodyM: readonly [number, number, number]
  readonly centerOfMassFromModelOriginBodyM?: readonly [number, number, number]
  readonly oswaldEfficiency: number
  readonly aileronAreaM2?: number
  readonly horizontalTailAreaM2?: number
  readonly horizontalTailSpanM?: number
  readonly horizontalTailPositionBodyM?: readonly [number, number, number]
  readonly horizontalTailIncidenceRad?: number
  readonly elevatorAreaM2?: number
  readonly verticalTailAreaM2?: number
  readonly verticalTailSpanM?: number
  readonly verticalTailPositionBodyM?: readonly [number, number, number]
  readonly rudderAreaM2?: number
  readonly fuselageLengthM?: number
  readonly fuselageDiameterM?: number
  readonly fuselageCenterBodyM?: readonly [number, number, number]
  readonly bladeElementCount?: number
}

export interface CanonicalAirPhysicsAerodynamics {
  readonly liftCoefficientByAlphaRad: CanonicalLookupTable1D
  readonly liftScalar: number
  readonly pitchMomentByAlphaRad?: CanonicalLookupTable1D
  readonly zeroLiftDragCoefficient: number
  readonly liftCoefficientAtDragZero: number
  readonly parasiteDragScalar: number
  readonly inducedDragScalar: number
  readonly flapInducedDragScalar: number
  readonly machDragCoefficientAdd?: CanonicalLookupTable1D
  readonly liftCoefficientMultiplierByMach?: CanonicalLookupTable1D
  readonly groundEffectLiftMultiplierByMach?: CanonicalLookupTable1D
  readonly flapLiftCoefficient: number
  readonly flapDragCoefficient: number
  readonly gearDragCoefficient: number
  readonly spoilerLiftCoefficient: number
  readonly spoilerDragCoefficient: number
  readonly sideForceSlipAngleCoefficient: number
  readonly sideForceRudderCoefficient: number
  readonly fuselageLateralDragCoefficient?: number
  readonly pitchMomentZero: number
  readonly pitchMomentAlphaCoefficient: number
  readonly pitchDampingCoefficient: number
  readonly pitchElevatorCoefficient: number
  readonly pitchFlapCoefficient: number
  readonly pitchGearCoefficient: number
  readonly pitchSpoilerCoefficient: number
  readonly rollSlipAngleCoefficient: number
  readonly rollDampingCoefficient: number
  readonly rollAileronCoefficient: number
  readonly yawSlipAngleCoefficient: number
  readonly yawDampingCoefficient: number
  readonly yawRudderCoefficient: number
}

export interface CanonicalAirPhysicsControls {
  readonly aileronLimitRad: number
  readonly elevatorLimitRad: number
  readonly rudderLimitRad: number
  readonly aileronEffectiveness: number
  readonly elevatorEffectiveness: number
  readonly rudderEffectiveness: number
  readonly elevatorLiftCoefficientSlopePerRad?: number
  readonly elevatorDeflectionSign?: -1 | 1
  readonly elevatorTrimUpLimitRad?: number
  readonly elevatorTrimDownLimitRad?: number
  readonly elevatorTrimEffectiveness?: number
  readonly rudderLiftCoefficientSlopePerRad?: number
  readonly rudderTrimLimitRad?: number
  readonly rudderTrimEffectiveness?: number
  readonly aileronTrimEffectiveness?: number
  readonly flapSpanOutboardRatio?: number
}

export interface CanonicalWingFlexConfig {
  readonly scalar: number
  readonly offset: number
  readonly surfaceScalar?: number
}

export interface CanonicalAirPhysicsSystemConfig {
  readonly emptyMassKg: number
  readonly maxGrossMassKg: number
  readonly inertiaKgM2: readonly [number, number, number]
  readonly geometry: CanonicalAirPhysicsGeometry
  readonly aerodynamics: CanonicalAirPhysicsAerodynamics
  readonly controls: CanonicalAirPhysicsControls
  readonly wingFlex?: CanonicalWingFlexConfig
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
  | CanonicalSystemDefinitionBase<'air-physics', CanonicalAirPhysicsSystemConfig>

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
