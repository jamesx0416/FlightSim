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
}

export interface ModelBehaviorReference {
  readonly kind: 'ModelBehaviorFile' | 'Path' | 'RelativeFile'
  readonly value: string
  readonly resolvedPath: string
  readonly resolvedUrl: string
}

export interface ImportedModelDefinition {
  readonly cfgPath: string
  readonly cfgUrl: string
  readonly behaviorPath: string
  readonly behaviorUrl: string
  readonly lods: readonly ModelLodEntry[]
  readonly behaviorIncludes: readonly ModelBehaviorReference[]
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
  readonly sourcePath: string
}

export interface CompiledVisibilityBinding {
  readonly target: string
  readonly expression: CompiledExpression
  readonly sourcePath: string
}

export interface CompiledUpdateBinding {
  readonly expression: CompiledExpression
  readonly sourcePath: string
  readonly frequency: number
  readonly once: boolean
}

export interface CompiledBehaviorSet {
  readonly irVersion: 'msfs-behavior/v1'
  readonly aircraftId: string
  readonly animationBindings: readonly CompiledAnimationBinding[]
  readonly visibilityBindings: readonly CompiledVisibilityBinding[]
  readonly updateBindings: readonly CompiledUpdateBinding[]
  readonly variableKeys: readonly string[]
  readonly diagnostics: readonly ImportDiagnostic[]
}

export interface RuntimeState {
  readonly irVersion: 'msfs-runtime/v1'
  readonly animationValues: ReadonlyMap<string, number>
  readonly nodeVisibilities: ReadonlyMap<string, boolean>
  readonly diagnostics: readonly ImportDiagnostic[]
}

export type Instruction =
  | { readonly op: 'pushNumber'; readonly value: number }
  | { readonly op: 'pushVariable'; readonly key: string }
  | { readonly op: 'pushParameter'; readonly index: number }
  | { readonly op: 'writeVariable'; readonly key: string }
  | { readonly op: 'invokeKeyEvent'; readonly name: string; readonly argCount: number }
  | { readonly op: 'duplicate' | 'popDiscard' | 'swap' | 'increment' | 'decrement' | 'quit' }
  | { readonly op: 'storeRegister'; readonly index: number; readonly pop: boolean }
  | { readonly op: 'loadRegister'; readonly index: number }
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

export interface RuntimeHostServices {
  tick(dtSeconds: number): void
  readVariable(key: string): number
  writeVariable(key: string, value: number): void
}
