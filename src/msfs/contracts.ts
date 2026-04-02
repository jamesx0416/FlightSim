export const PACKAGE_IMPORT_SCHEMA_VERSION = 'msfs.package.import.v0'
export const BEHAVIOR_CONTRACT_SCHEMA_VERSION = 'msfs.behavior.contract.v0'
export const RUNTIME_CONTRACT_SCHEMA_VERSION = 'msfs.runtime.contract.v0'

export const COMPATIBILITY_CATEGORIES = [
  'package-import',
  'behavior-compile',
  'runtime-vars-events',
  'model-behaviors',
  'panels',
  'wasm-host',
  'sound',
  'overrides'
] as const

export type CompatibilityCategory = (typeof COMPATIBILITY_CATEGORIES)[number]
export type ImportBackend = 'msfs2020-monolithic' | 'msfs2024-modular'
export type DiagnosticSeverity = 'info' | 'warning' | 'error'
export type AssetKind =
  | 'behavior'
  | 'config'
  | 'effect'
  | 'instrument'
  | 'model'
  | 'panel'
  | 'sound'
  | 'texture'
  | 'other'

export interface ImportDiagnostic {
  severity: DiagnosticSeverity
  code: string
  message: string
  file?: string
  aircraftId?: string
  details?: Record<string, string | number | boolean | null>
}

export interface PackageDependency {
  name: string
  version?: string
}

export interface PackageMetadata {
  manifestPath?: string
  layoutPath?: string
  title?: string
  creator?: string
  contentType?: string
  manufacturer?: string
  minimumGameVersion?: string
  dependencies: PackageDependency[]
}

export interface PackageSourceFingerprint {
  backend: ImportBackend
  packageRoot: string
  cacheKey: string
  generatedAt: string
  fileCount: number
  totalBytes: number
}

export interface PackageAssetFile {
  path: string
  kind: AssetKind
  extension: string
  byteLength: number
}

export interface PackageAssetManifest {
  files: PackageAssetFile[]
  countsByKind: Partial<Record<AssetKind, number>>
}

export interface AircraftVariantConfigSnapshot {
  section: string
  order: number
  raw: Record<string, string>
}

export interface AircraftConfigSnapshot {
  path: string
  version: Record<string, string>
  general: Record<string, string>
  variation: Record<string, string>
  variants: AircraftVariantConfigSnapshot[]
}

export interface ResolvedDirectoryReference {
  directory: string
  sourceAircraft: string
}

export interface ModelLodDescriptor {
  modelFile: string
  minSize?: number
}

export interface BehaviorIncludeDescriptor {
  attribute: 'ModelBehaviorFile' | 'Path'
  target: string
}

export interface NodeAnimationSummary {
  type: string
  nodeCount: number
}

export interface ModelDocumentDescriptor {
  role: string
  path: string
  lods: ModelLodDescriptor[]
  behaviorIncludes: BehaviorIncludeDescriptor[]
  nodeAnimations: NodeAnimationSummary[]
}

export interface ModelDefinition {
  directory: string
  configPath: string
  options: Record<string, string>
  entries: Record<string, string>
  documents: ModelDocumentDescriptor[]
}

export interface PanelGaugeDescriptor {
  section: string
  key: string
  kind: 'htmlgauge' | 'painting'
  resource: string
  rect: number[]
  raw: string
}

export type RuntimeVariableNamespace = 'simvar' | 'lvar' | 'bvar' | 'token' | 'custom'

export interface RuntimeVariableReference {
  namespace: RuntimeVariableNamespace
  name: string
  unit?: string
  index?: number
}

export interface PanelInstrumentDescriptor {
  name: string
  alwaysUpdate: boolean
  electricSimvars: RuntimeVariableReference[]
}

export interface PanelDefinition {
  directory: string
  configPath?: string
  xmlPath?: string
  gauges: PanelGaugeDescriptor[]
  instruments: PanelInstrumentDescriptor[]
  soundSourceNode?: string
}

export interface SoundPackageDescriptor {
  kind: 'main' | 'additional'
  name: string
}

export interface SoundVariableDescriptor {
  source: 'SimVar' | 'LocalVar'
  name: string
  unit?: string
  index?: number
}

export interface SoundRangeDescriptor {
  lowerBound?: number
  upperBound?: number
}

export interface SoundConditionDescriptor extends SoundVariableDescriptor {
  range?: SoundRangeDescriptor
}

export interface SoundRtpcDescriptor extends SoundVariableDescriptor {
  rtpcName: string
  derived?: boolean
  attackTime?: number
  releaseTime?: number
}

export interface SoundEntryDescriptor {
  category: string
  eventName?: string
  continuous: boolean
  viewpoint?: string
  nodeName?: string
  coneHeading?: number
  sourceVariable?: SoundVariableDescriptor
  range?: SoundRangeDescriptor
  requires: SoundConditionDescriptor[]
  rtpcs: SoundRtpcDescriptor[]
}

export interface SoundDefinition {
  directory: string
  xmlPath: string
  packages: SoundPackageDescriptor[]
  triggerCounts: Record<string, number>
  variables: SoundVariableDescriptor[]
  entries: SoundEntryDescriptor[]
}

export interface AircraftVariantDefinition {
  id: string
  order: number
  title?: string
  uiType?: string
  uiVariation?: string
  isUserSelectable?: boolean
  isFlyable?: boolean
  rawConfig: Record<string, string>
  references: {
    model?: ResolvedDirectoryReference
    panel?: ResolvedDirectoryReference
    sound?: ResolvedDirectoryReference
    texture?: ResolvedDirectoryReference
  }
  resolved: {
    model?: ModelDefinition
    panel?: PanelDefinition
    sound?: SoundDefinition
  }
}

export interface AircraftDefinition {
  aircraftId: string
  directory: string
  baseContainer?: string
  category?: string
  config: AircraftConfigSnapshot
  variants: AircraftVariantDefinition[]
}

export type RuntimeEventChannel = 'key-event' | 'input-event' | 'b-event' | 'h-event' | 'custom'

export interface RuntimeEventReference {
  channel: RuntimeEventChannel
  name: string
  payloadShape?: 'none' | 'number' | 'string' | 'boolean' | 'opaque'
}

export interface VariableServiceContract {
  supportedNamespaces: RuntimeVariableNamespace[]
  writableNamespaces: RuntimeVariableNamespace[]
  accessPattern: 'synchronous-snapshot'
}

export interface EventServiceContract {
  supportedChannels: RuntimeEventChannel[]
  dispatchPattern: 'queued-dispatch'
}

export interface AnimationServiceContract {
  supportsValueBindings: boolean
  supportsLag: boolean
  supportsEvents: boolean
}

export interface NodeServiceContract {
  supportsVisibility: boolean
  supportsAttachments: boolean
}

export interface PanelServiceContract {
  supportsHtmlInstruments: boolean
  supportsWasmSurfaces: boolean
  supportsSimulatorBridge: boolean
}

export interface SoundServiceContract {
  supportsConditionalRouting: boolean
  supportsRtpcBindings: boolean
  supportsNativeWwiseParity: boolean
}

export interface LifecycleServiceContract {
  updateModel: 'deterministic-fixed-step'
  timeSources: string[]
}

export interface RuntimeContracts {
  schemaVersion: typeof RUNTIME_CONTRACT_SCHEMA_VERSION
  variables: VariableServiceContract
  events: EventServiceContract
  animations: AnimationServiceContract
  nodes: NodeServiceContract
  panels: PanelServiceContract
  sound: SoundServiceContract
  lifecycle: LifecycleServiceContract
}

export interface CompiledBehaviorContract {
  schemaVersion: typeof BEHAVIOR_CONTRACT_SCHEMA_VERSION
  graphKinds: Array<'animation' | 'visibility' | 'interaction' | 'update'>
  symbolTables: Array<'variables' | 'events' | 'animations' | 'nodes' | 'parameters'>
  supportedVariableNamespaces: RuntimeVariableNamespace[]
  supportedEventChannels: RuntimeEventChannel[]
}

export type CompatibilityStatus = 'planned' | 'in-progress' | 'supported'

export interface CompatibilityMatrixEntry {
  category: CompatibilityCategory
  fixtureClass: string
  requirement: string
  exitSignal: string
  status: CompatibilityStatus
}

export interface CompatibilityTestMatrix {
  entries: CompatibilityMatrixEntry[]
}

export interface NormalizedPackageImportCache {
  schemaVersion: typeof PACKAGE_IMPORT_SCHEMA_VERSION
  source: PackageSourceFingerprint
  packageMetadata?: PackageMetadata
  aircraft: AircraftDefinition[]
  assetManifest: PackageAssetManifest
  compiledBehaviorContract: CompiledBehaviorContract
  runtimeContracts: RuntimeContracts
  testMatrix: CompatibilityTestMatrix
  diagnostics: ImportDiagnostic[]
}

export const DEFAULT_BEHAVIOR_CONTRACT: CompiledBehaviorContract = {
  schemaVersion: BEHAVIOR_CONTRACT_SCHEMA_VERSION,
  graphKinds: ['animation', 'visibility', 'interaction', 'update'],
  symbolTables: ['variables', 'events', 'animations', 'nodes', 'parameters'],
  supportedVariableNamespaces: ['simvar', 'lvar', 'bvar', 'token', 'custom'],
  supportedEventChannels: ['key-event', 'input-event', 'b-event', 'h-event', 'custom']
}

export const DEFAULT_RUNTIME_CONTRACTS: RuntimeContracts = {
  schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
  variables: {
    supportedNamespaces: ['simvar', 'lvar', 'bvar', 'token', 'custom'],
    writableNamespaces: ['lvar', 'bvar', 'custom'],
    accessPattern: 'synchronous-snapshot'
  },
  events: {
    supportedChannels: ['key-event', 'input-event', 'b-event', 'h-event', 'custom'],
    dispatchPattern: 'queued-dispatch'
  },
  animations: {
    supportsValueBindings: true,
    supportsLag: true,
    supportsEvents: true
  },
  nodes: {
    supportsVisibility: true,
    supportsAttachments: true
  },
  panels: {
    supportsHtmlInstruments: true,
    supportsWasmSurfaces: true,
    supportsSimulatorBridge: true
  },
  sound: {
    supportsConditionalRouting: true,
    supportsRtpcBindings: true,
    supportsNativeWwiseParity: false
  },
  lifecycle: {
    updateModel: 'deterministic-fixed-step',
    timeSources: ['sim-time', 'frame-time', 'wall-clock']
  }
}

export const PHASE_0_TEST_MATRIX: CompatibilityTestMatrix = {
  entries: [
    {
      category: 'package-import',
      fixtureClass: 'single-aircraft package',
      requirement: 'Discover every aircraft under SimObjects/AirPlanes and normalize its config graph.',
      exitSignal: 'Importer emits a cache with aircraft.cfg, model.cfg, panel.cfg, and sound references resolved.',
      status: 'in-progress'
    },
    {
      category: 'package-import',
      fixtureClass: 'base-container variant package',
      requirement: 'Resolve base_container inheritance without aircraft-specific overrides.',
      exitSignal: 'Variant references fall back to parent aircraft content when local folders are absent.',
      status: 'in-progress'
    },
    {
      category: 'behavior-compile',
      fixtureClass: 'XML behavior package',
      requirement: 'Compile template-driven model behavior XML into an internal graph.',
      exitSignal: 'Compiled behavior graph drives animation, visibility, and interactions via runtime symbols.',
      status: 'planned'
    },
    {
      category: 'runtime-vars-events',
      fixtureClass: 'panel + model behavior aircraft',
      requirement: 'Expose SimVars, local vars, B-vars, and key/input events through a stable host API.',
      exitSignal: 'Behavior VM and panel host exchange state through shared runtime services.',
      status: 'planned'
    },
    {
      category: 'panels',
      fixtureClass: 'HTML instrument aircraft',
      requirement: 'Mount HTML/JS instruments with simulator bridge shims.',
      exitSignal: 'Representative HTML gauges render and receive bound state from the runtime host.',
      status: 'planned'
    },
    {
      category: 'wasm-host',
      fixtureClass: 'WASM-assisted aircraft',
      requirement: 'Provide a documented subset of aircraft-facing WASM APIs.',
      exitSignal: 'Representative gauges can call the supported host shim without package edits.',
      status: 'planned'
    },
    {
      category: 'sound',
      fixtureClass: 'sound XML package',
      requirement: 'Interpret sound trigger conditions and RTPC routing.',
      exitSignal: 'Sound events react to runtime variable changes through the audio host.',
      status: 'planned'
    },
    {
      category: 'overrides',
      fixtureClass: 'edge-case aircraft',
      requirement: 'Allow isolated compatibility overrides without breaking the generic path.',
      exitSignal: 'Overrides remain explicit, versioned, and opt-in.',
      status: 'planned'
    }
  ]
}
