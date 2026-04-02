import type {
  ImportDiagnostic,
  NormalizedPackageImportCache,
  RuntimeEventChannel,
  RuntimeEventReference,
  RuntimeVariableNamespace,
  RuntimeVariableReference
} from '../contracts.ts'

export const COMPILED_BEHAVIOR_PACKAGE_SCHEMA_VERSION = 'msfs.behavior.package.v0'

export type BehaviorBindingKind = 'animation' | 'visibility' | 'interaction' | 'update'
export type BehaviorSourceKind = 'model-document' | 'included-document' | 'external-include'
export type InteractionTrigger =
  | 'left-single'
  | 'right-single'
  | 'mouse-callback'
  | 'onclick'
  | 'increment'
  | 'decrement'
  | 'wheel-up'
  | 'wheel-down'

export interface BehaviorSourceDocument {
  path: string
  kind: BehaviorSourceKind
  includedFrom?: string
  includeDirective?: string
}

export type BehaviorInstruction =
  | { op: 'push_number'; value: number }
  | { op: 'push_string'; value: string }
  | { op: 'read_var'; reference: RuntimeVariableReference }
  | { op: 'write_var'; reference: RuntimeVariableReference }
  | { op: 'emit_event'; event: RuntimeEventReference }
  | { op: 'store_local'; slot: number }
  | { op: 'load_local'; slot: number }
  | { op: 'add' }
  | { op: 'subtract' }
  | { op: 'multiply' }
  | { op: 'divide' }
  | { op: 'negate' }
  | { op: 'not' }
  | { op: 'and' }
  | { op: 'or' }
  | { op: 'equal' }
  | { op: 'not_equal' }
  | { op: 'greater' }
  | { op: 'greater_equal' }
  | { op: 'less' }
  | { op: 'less_equal' }
  | { op: 'max' }
  | { op: 'min' }
  | { op: 'abs' }
  | { op: 'string_compare_ignore_case' }
  | { op: 'range_inclusive' }
  | { op: 'jump_if_false'; target: number }
  | { op: 'jump'; target: number }
  | { op: 'quit' }
  | { op: 'unsupported'; token: string }

export interface CompiledCalculatorProgram {
  source: string
  tokens: string[]
  instructions: BehaviorInstruction[]
  referencedVariables: RuntimeVariableReference[]
  writtenVariables: RuntimeVariableReference[]
  emittedEvents: RuntimeEventReference[]
  unsupportedTokens: string[]
}

export interface BehaviorBindingBase {
  id: string
  kind: BehaviorBindingKind
  sourceDocument: string
  templateName?: string
  componentPath: string[]
  nodeId?: string
}

export interface CompiledAnimationBinding extends BehaviorBindingBase {
  kind: 'animation'
  animName?: string
  animLength?: number
  animLag?: number
  program: CompiledCalculatorProgram
}

export interface CompiledVisibilityBinding extends BehaviorBindingBase {
  kind: 'visibility'
  program: CompiledCalculatorProgram
}

export interface CompiledInteractionBinding extends BehaviorBindingBase {
  kind: 'interaction'
  trigger: InteractionTrigger
  tooltip?: string
  mouseFlags?: string
  target?: string
  program: CompiledCalculatorProgram
}

export interface CompiledUpdateBinding extends BehaviorBindingBase {
  kind: 'update'
  frequency?: number
  program: CompiledCalculatorProgram
}

export interface CompiledBindingSet {
  animations: CompiledAnimationBinding[]
  visibility: CompiledVisibilityBinding[]
  interactions: CompiledInteractionBinding[]
  updates: CompiledUpdateBinding[]
}

export interface BehaviorSymbolTable {
  variables: RuntimeVariableReference[]
  writableVariables: RuntimeVariableReference[]
  events: RuntimeEventReference[]
  eventChannels: RuntimeEventChannel[]
  variableNamespaces: RuntimeVariableNamespace[]
}

export interface CompiledBehaviorVariant {
  variantId: string
  sourceDocuments: BehaviorSourceDocument[]
  bindings: CompiledBindingSet
  symbols: BehaviorSymbolTable
  unresolvedTemplates: string[]
  summary: {
    templateCount: number
    animationCount: number
    visibilityCount: number
    interactionCount: number
    updateCount: number
  }
}

export interface CompiledBehaviorAircraft {
  aircraftId: string
  variants: CompiledBehaviorVariant[]
}

export interface CompiledBehaviorPackage {
  schemaVersion: typeof COMPILED_BEHAVIOR_PACKAGE_SCHEMA_VERSION
  source: {
    import: Pick<NormalizedPackageImportCache['source'], 'backend' | 'packageRoot' | 'cacheKey'>
    importCachePath?: string
  }
  aircraft: CompiledBehaviorAircraft[]
  diagnostics: ImportDiagnostic[]
}

export interface BehaviorVmEvent {
  event: RuntimeEventReference
  payload?: number | string | boolean
}
