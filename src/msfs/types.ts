export type DiagnosticSeverity = 'info' | 'warning' | 'error'

export interface ImportDiagnostic {
  readonly code: string
  readonly message: string
  readonly severity: DiagnosticSeverity
  readonly sourcePath?: string
  readonly details?: string
}

export interface PackageLayoutEntry {
  readonly path: string
  readonly size?: number
  readonly date?: number
}

export interface PackageManifest {
  readonly title?: string
  readonly packageVersion?: string
  readonly creator?: string
}

export interface ModelLodEntry {
  readonly minSize: number
  readonly path: string
  readonly url: string
  readonly modelFileSize?: number
  readonly siblingBufferFileSize?: number
  readonly mergeModels: readonly string[]
  readonly attachModelIds: readonly string[]
}

export interface ModelBehaviorReference {
  readonly kind: 'ModelBehaviorFile' | 'Path' | 'RelativeFile'
  readonly value: string
  readonly resolvedPath: string
  readonly resolvedUrl: string
}

export interface BehaviorSourceRoot {
  readonly rootUrl: string
  readonly revision: string | null
  readonly layoutPathIndex: ReadonlyMap<string, string>
  readonly resolveAssetUrl: (path: string) => string
}

export interface ImportedModelDefinition {
  readonly cfgPath: string
  readonly cfgUrl: string
  readonly behaviorPath: string
  readonly behaviorUrl: string
  readonly lods: readonly ModelLodEntry[]
  readonly behaviorIncludes: readonly ModelBehaviorReference[]
  readonly nodeAnimations: readonly ModelNodeAnimation[]
  readonly modelAttachments: readonly ImportedModelAttachment[]
  readonly modelOptions: ImportedModelOptions
}

export interface ImportedModelOptions {
  readonly withExteriorShowInterior: boolean
  readonly withExteriorShowInteriorHideFirstLod: boolean
  readonly withInteriorForceFirstLod: boolean
  readonly withInteriorShowExterior: boolean
}

export interface ModelNodeAnimation {
  readonly type: string
  readonly nodes: readonly string[]
}

export interface ImportedModelAttachment {
  readonly id: string
  readonly attachToNode?: string
  readonly modelPath?: string
  readonly modelUrl?: string
}

export interface ImportedCfgSection {
  readonly name: string
  readonly values: ReadonlyMap<string, string>
}

export interface ImportedCfgFile {
  readonly kind: string
  readonly path: string
  readonly url: string
  readonly sourceAircraftCfgPath: string
  readonly sections: readonly ImportedCfgSection[]
}

export interface ImportedFlightState {
  readonly path: string
  readonly url: string
  readonly sections: readonly ImportedCfgSection[]
}

export interface ImportedSoundDefinition {
  readonly path: string
  readonly url: string
  readonly wwisePackages: readonly ImportedWwisePackage[]
  readonly simVarSounds: readonly ImportedSimVarSound[]
}

export interface ImportedWwisePackage {
  readonly name: string
  readonly kind: 'main' | 'additional'
  readonly packagePath?: string
  readonly packageUrl?: string
}

export interface ImportedSoundRange {
  readonly lowerBound: number | null
  readonly upperBound: number | null
}

export interface ImportedSoundVariable {
  readonly kind: 'simvar' | 'localvar'
  readonly name: string
  readonly unit: string | null
  readonly index: number | null
}

export interface ImportedSimVarSound {
  readonly id: string
  readonly eventName: string
  readonly nodeName: string | null
  readonly viewpoint: string | null
  readonly continuous: boolean
  readonly variable: ImportedSoundVariable
  readonly ranges: readonly ImportedSoundRange[]
  readonly requires: readonly {
    readonly variable: ImportedSoundVariable
    readonly ranges: readonly ImportedSoundRange[]
  }[]
  readonly sourcePath: string
}

export interface ImportedAircraft {
  readonly id: string
  readonly title: string
  readonly sectionName: string
  readonly uiType?: string
  readonly variationName?: string
  readonly sourcePath: string
  readonly sourceUrl: string
  readonly inheritedFromPaths: readonly string[]
  readonly textureDirectories: readonly string[]
  readonly baseContainer?: string
  readonly isUserSelectable: boolean
  readonly isFlyable: boolean
  readonly model: ImportedModelDefinition | null
  readonly interiorModel: ImportedModelDefinition | null
  readonly cfgFiles: readonly ImportedCfgFile[]
  readonly previewFlightState: ImportedFlightState | null
  readonly soundDefinition: ImportedSoundDefinition | null
}

export interface ImportedPackage {
  readonly irVersion: 'msfs-package/v1'
  readonly rootUrl: string
  readonly manifest: PackageManifest | null
  readonly packageName: string
  readonly layoutEntries: readonly PackageLayoutEntry[]
  readonly aircraft: readonly ImportedAircraft[]
  readonly diagnostics: readonly ImportDiagnostic[]
}

export interface CompiledExpression {
  readonly source: string
  readonly instructions: readonly Instruction[]
  readonly variableKeys: readonly string[]
}

export interface CompiledAnimationBinding {
  readonly target: string
  readonly expression: CompiledExpression
  readonly length: number
  readonly wrap: boolean
  readonly delta: boolean
  readonly lagFramesPerSecond: number
  readonly sourcePath: string
}

export interface CompiledAnimationTriggerBinding {
  readonly animation: string
  readonly eventName: string
  readonly eventKind: 'sound' | 'effect'
  readonly action: string
  readonly direction: 'both' | 'forward' | 'backward'
  readonly normalizedTime: number | null
  readonly count: number | null
  readonly sourcePath: string
}

export interface CompiledVisibilityBinding {
  readonly target: string
  readonly expression: CompiledExpression
  readonly sourcePath: string
}

export interface CompiledMaterialBinding {
  readonly target: string
  readonly property: 'emissive'
  readonly expression: CompiledExpression
  readonly overrideBaseEmissive: boolean
  readonly sourcePath: string
}

export interface CompiledUpdateBinding {
  readonly expression: CompiledExpression
  readonly sourcePath: string
  readonly frequency: number
  readonly once: boolean
}

export interface CompiledInputEventBinding {
  readonly name: string
  readonly expression: CompiledExpression
  readonly sourcePath: string
}

export type CockpitInteractionChannel = 'primary' | 'secondary' | 'tertiary'
export type CockpitInteractionPhase = 'press' | 'double' | 'hold' | 'drag' | 'repeat' | 'release' | 'cancel'
export type CompiledInteractionSourceKind =
  | 'callbackCode'
  | 'callbackDragging'
  | 'callbackJumpDragging'
  | 'eventId'
  | 'inputEvent'

export interface CompiledInteractionRoute {
  readonly channel: CockpitInteractionChannel | null
  readonly phase: CockpitInteractionPhase | null
  readonly operation: 'press' | 'hold' | 'release' | 'turn' | 'increase' | 'decrease' | 'adjust' | 'set' | 'on' | 'off' | 'toggle' | 'hover' | 'leave' | 'lock' | 'unlock'
  readonly msfsEvent: string | null
  readonly axis: 'x' | 'y' | 'z' | null
  readonly inputTypes: readonly number[]
}

export interface CompiledInteractionMetadata {
  readonly authoredId: string | null
  readonly qualifiedId: string
  readonly nodeId: string | null
  readonly componentId: string | null
  readonly inputEventIds: readonly string[]
  readonly routes: readonly CompiledInteractionRoute[]
  readonly sourceKind: CompiledInteractionSourceKind
  readonly sourcePath: string
  readonly sourceTemplate: string | null
  readonly templateRevision: string | null
  readonly lockable: boolean
  readonly dynamicEventHandling: boolean
  readonly disabled: boolean
  readonly disabledInVr: boolean
  readonly prioritizeVCockpits: boolean
  readonly ignoreZTest: boolean
  readonly highlightNodeId: string | null
  readonly axis: 'x' | 'y' | 'z' | null
  readonly inverted: boolean
  readonly cursor: string | null
  readonly tooltipTitle: string | null
  readonly tooltipDescription: string | null
  readonly tooltipValueExpression: CompiledExpression | null
}

export interface CompiledInteractionBinding {
  readonly target: string
  readonly feedbackTargets: readonly string[]
  readonly feedbackVariableKeys: readonly string[]
  readonly soundEvents: readonly CompiledInteractionSoundEvent[]
  readonly minHeldDurationSeconds: number
  readonly animationDurationSeconds: number | null
  readonly expression: CompiledExpression
  readonly releaseExpression: CompiledExpression | null
  readonly sourcePath: string
  readonly metadata: CompiledInteractionMetadata
}

export interface CompiledInteractionBlocker {
  readonly target: string
  readonly feedbackTargets: readonly string[]
  readonly sourcePath: string
}

export interface CompiledInteractionSoundEvent {
  readonly name: string
  readonly phase: 'press' | 'release'
  readonly normalizedTime: number | null
  readonly sourceParameter: string
}

export interface CompiledBehaviorSet {
  readonly irVersion: 'msfs-behavior/v1'
  readonly aircraftId: string
  readonly animationBindings: readonly CompiledAnimationBinding[]
  readonly animationTriggerBindings: readonly CompiledAnimationTriggerBinding[]
  readonly visibilityBindings: readonly CompiledVisibilityBinding[]
  readonly materialBindings: readonly CompiledMaterialBinding[]
  readonly updateBindings: readonly CompiledUpdateBinding[]
  readonly inputEventBindings: readonly CompiledInputEventBinding[]
  readonly interactionBindings: readonly CompiledInteractionBinding[]
  readonly interactionBlockers: readonly CompiledInteractionBlocker[]
  readonly variableKeys: readonly string[]
  readonly builtinFallbackHits: readonly string[]
  readonly diagnostics: readonly ImportDiagnostic[]
}

export interface RuntimeState {
  readonly irVersion: 'msfs-runtime/v1'
  readonly animationValues: ReadonlyMap<string, number>
  readonly nodeVisibilities: ReadonlyMap<string, boolean>
  readonly materialValues: ReadonlyMap<string, number>
  readonly canonicalVisualBindings: readonly RuntimeCanonicalVisualBindingState[]
  readonly diagnostics: readonly ImportDiagnostic[]
}

export interface RuntimeCanonicalVisualBindingState {
  readonly id: string
  readonly kind: string
  readonly channel: 'animation' | 'visibility' | 'material'
  readonly target: string
  readonly stateKey: string
}

export type Instruction =
  | { readonly op: 'pushNumber'; readonly value: number }
  | { readonly op: 'pushString'; readonly value: string }
  | { readonly op: 'pushVariable'; readonly key: string; readonly unit: string | null }
  | { readonly op: 'pushStringVariable'; readonly key: string; readonly unit: string | null }
  | { readonly op: 'pushParameter'; readonly index: number }
  | { readonly op: 'writeVariable'; readonly key: string; readonly unit: string | null }
  | { readonly op: 'invokeKeyEvent'; readonly name: string; readonly argCount: number }
  | { readonly op: 'invokeHtmlEvent'; readonly name: string }
  | { readonly op: 'duplicate' | 'popDiscard' | 'swap' | 'increment' | 'decrement' | 'quit' }
  | { readonly op: 'storeRegister'; readonly index: number; readonly pop: boolean }
  | { readonly op: 'loadRegister'; readonly index: number }
  | { readonly op: 'label'; readonly index: number }
  | { readonly op: 'gotoLabel'; readonly index: number }
  | {
      readonly op: 'if'
      readonly thenInstructions: readonly Instruction[]
      readonly elseInstructions: readonly Instruction[]
    }
  | { readonly op: 'ternary' | 'case' }
  | { readonly op: 'pushPi' }
  | { readonly op: 'add' | 'sub' | 'mul' | 'div' | 'integerDiv' | 'mod' | 'pow' }
  | { readonly op: 'min' | 'max' }
  | { readonly op: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' }
  | { readonly op: 'and' | 'or' }
  | { readonly op: 'neg' | 'not' | 'abs' | 'ceil' | 'floor' | 'roundNearest' | 'sign' }
  | { readonly op: 'sqrt' | 'sin' | 'cos' | 'degreesToRadians' | 'radiansToDegrees' }
  | { readonly op: 'normalizeDegrees' | 'normalizeRadians' }
  | { readonly op: 'stringCompare' | 'stringCompareCaseInsensitive' }

export interface RuntimeHostServices {
  tick(dtSeconds: number): void
  readVariable(key: string, unit?: string | null): number
  writeVariable(key: string, value: number, unit?: string | null): void
  setInputEventBindings?(bindings: readonly CompiledInputEventBinding[]): void
  invokeKeyEvent?(name: string, args: readonly number[]): void
  invokeHtmlEvent?(name: string, args: readonly (number | string)[]): void
  invokeSoundEvent?(
    name: string,
    event: {
      readonly phase: 'press' | 'release'
      readonly target: string
      readonly normalizedTime: number | null
      readonly sourcePath: string
      readonly sourceParameter: string
    }
  ): void
  invokeEffectEvent?(
    name: string,
    event: {
      readonly action: string
      readonly direction: 'forward' | 'backward'
      readonly target: string
      readonly normalizedTime: number | null
      readonly sourcePath: string
    }
  ): void
}
