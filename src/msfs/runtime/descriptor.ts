import type {
  ImportBackend,
  ImportDiagnostic,
  PanelDefinition,
  RuntimeVariableReference,
  SoundDefinition
} from '../contracts.ts'
import type { CompiledBehaviorVariant } from '../behavior/contracts.ts'
import type { RuntimeVariableValue } from './keys.ts'

export const COMPATIBILITY_DESCRIPTOR_SCHEMA_VERSION = 'msfs.compatibility.descriptor.v0'

export interface CompatibilityModelSourceDescriptor {
  role: string
  modelPath: string
  modelUrl: string
  minSize?: number
  normalizeSourceAsset?: boolean
  textureManifestUrl?: string
}

export interface CompatibilityLookupTableDescriptor {
  breakpoints: readonly number[]
  values: readonly number[]
}

export interface CompatibilityVector3Descriptor {
  x: number
  y: number
  z: number
}

export interface CompatibilityAircraftConfigurationDescriptor {
  flapDetents01: readonly number[]
  defaultFlapDetentIndex?: number
  flapRatePerSec: number
  gearRatePerSec: number
  spoilerRatePerSec: number
  flapLiftClMax: number
  flapDragCdMax: number
  flapPitchCmMax: number
  gearDragCdMax: number
  spoilerDragCdMax: number
  spoilerLiftLossMax: number
  spoilerPitchCmMax: number
  flapVisualSchedule?: {
    detents01: readonly number[]
    trailingOutboardDeg: readonly number[]
    trailingInboardDeg: readonly number[]
    leadingDeg: readonly number[]
  }
}

export interface CompatibilityAircraftAeroDescriptor {
  CL0: number
  CLalphaPerRad: number
  CLmax: number
  alphaStallRad: number
  alphaStallBlendRad: number
  CD0: number
  inducedDragFactor: number
  CDbeta: number
  CDStallAdd: number
  CYbetaPerRad: number
  ClbetaPerRad: number
  Clp: number
  Clda: number
  Cm0: number
  CmalphaPerRad: number
  Cmq: number
  Cmde: number
  Cn0: number
  CnbetaPerRad: number
  Cnr: number
  Cndr: number
  lookup?: {
    alphaCl: CompatibilityLookupTableDescriptor
    alphaCd: CompatibilityLookupTableDescriptor
    alphaCm: CompatibilityLookupTableDescriptor
    betaCy: CompatibilityLookupTableDescriptor
    betaCl: CompatibilityLookupTableDescriptor
    betaCn: CompatibilityLookupTableDescriptor
    controlAlphaClDeltaE: CompatibilityLookupTableDescriptor
    controlAlphaCmDeltaE: CompatibilityLookupTableDescriptor
    controlAlphaClDeltaA: CompatibilityLookupTableDescriptor
    controlAlphaCyDeltaR: CompatibilityLookupTableDescriptor
    controlAlphaCnDeltaR: CompatibilityLookupTableDescriptor
  }
}

export interface CompatibilityAircraftPhysicsDescriptor {
  massKg: number
  inertiaKgM2: CompatibilityVector3Descriptor
  wingAreaM2: number
  wingSpanM: number
  meanChordM: number
  maxThrustN: number
  controlLimitsRad: {
    aileron: number
    elevator: number
    rudder: number
  }
  angularDampingPerSec: CompatibilityVector3Descriptor
  throttleToThrustFraction?: CompatibilityLookupTableDescriptor
  configuration?: CompatibilityAircraftConfigurationDescriptor
  aero: CompatibilityAircraftAeroDescriptor
  visualOffsetBodyMeters?: CompatibilityVector3Descriptor
}

export interface PanelSurfaceDescriptor {
  id: string
  section: string
  key: string
  kind: 'htmlgauge' | 'painting'
  resource: string
  resourcePath?: string
  resourceUrl?: string
  rect: number[]
  exists: boolean
  hostUrl: string
}

export interface WasmGaugeDescriptor {
  id: string
  section: string
  resource: string
  moduleName: string
  gaugeName?: string
  hostUrl: string
}

export interface CompatibilityPanelDescriptor {
  configPath?: string
  xmlPath?: string
  surfaces: PanelSurfaceDescriptor[]
  instruments: PanelDefinition['instruments']
}

export interface CompatibilityIndexEntry {
  id: string
  label: string
  cacheKey: string
  backend: ImportBackend
  aircraftId: string
  variantId: string
  title?: string
  uiVariation?: string
}

export interface CompatibilityStartupVariableDescriptor {
  reference: RuntimeVariableReference
  value: RuntimeVariableValue
}

export interface AircraftCompatibilityDescriptor {
  schemaVersion: typeof COMPATIBILITY_DESCRIPTOR_SCHEMA_VERSION
  id: string
  label: string
  source: {
    backend: ImportBackend
    cacheKey: string
    packageRoot: string
    packageRouteRoot: string
  }
  aircraftId: string
  variantId: string
  title?: string
  uiType?: string
  uiVariation?: string
  trackedVariables: RuntimeVariableReference[]
  startupVariables?: CompatibilityStartupVariableDescriptor[]
  modelSources: CompatibilityModelSourceDescriptor[]
  physics?: CompatibilityAircraftPhysicsDescriptor
  panel?: CompatibilityPanelDescriptor
  wasm: {
    gauges: WasmGaugeDescriptor[]
  }
  sound?: SoundDefinition
  compiledBehavior: CompiledBehaviorVariant
  diagnostics: ImportDiagnostic[]
}
