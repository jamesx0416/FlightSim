import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import type {
  ImportDiagnostic,
  NormalizedPackageImportCache,
  RuntimeEventReference,
  RuntimeVariableReference
} from '../contracts.ts'
import {
  COMPILED_BEHAVIOR_PACKAGE_SCHEMA_VERSION,
  type BehaviorBindingBase,
  type BehaviorSourceDocument,
  type CompiledBehaviorAircraft,
  type CompiledBehaviorPackage,
  type CompiledBehaviorVariant,
  type CompiledBindingSet,
  type InteractionTrigger
} from './contracts.ts'
import { compileCalculatorCode } from './calculator.ts'
import {
  getElementChildren,
  parseXmlDocument,
  type XmlElementNode,
  type XmlNode
} from './xml.ts'

interface BehaviorDocument {
  absolutePath: string
  relativePath: string
  root: XmlElementNode
  kind: BehaviorSourceDocument['kind']
  includedFrom?: string
  includeDirective?: string
}

interface TemplateDefinition {
  name: string
  sourceDocument: string
  node: XmlElementNode
}

interface TraversalContext {
  sourceDocument: string
  componentPath: string[]
  nodeId?: string
}

interface VariantCompileState {
  bindings: CompiledBindingSet
  diagnostics: ImportDiagnostic[]
  unresolvedTemplates: Set<string>
  templates: Map<string, TemplateDefinition>
  bindingSequence: number
}

const PARAMETER_BLOCK_NAMES = new Set([
  'DefaultTemplateParameters',
  'OverrideTemplateParameters',
  'EditableTemplateParameters',
  'Parameters'
])
const DIRECT_INTERACTION_CODES: Array<{ tag: string; trigger: InteractionTrigger }> = [
  { tag: 'LEFT_SINGLE_CODE', trigger: 'left-single' },
  { tag: 'RIGHT_SINGLE_CODE', trigger: 'right-single' },
  { tag: 'CALLBACKCODE_DEFAULT_IM', trigger: 'mouse-callback' },
  { tag: 'ONCLICK', trigger: 'onclick' },
  { tag: 'INC_VOLUME', trigger: 'increment' },
  { tag: 'DEC_VOLUME', trigger: 'decrement' },
  { tag: 'WHEEL_UP_CODE', trigger: 'wheel-up' },
  { tag: 'WHEEL_DOWN_CODE', trigger: 'wheel-down' }
] as const

export function compileBehaviorPackage(
  cache: NormalizedPackageImportCache,
  options?: { importCachePath?: string }
): CompiledBehaviorPackage {
  const packageRoot = cache.source.packageRoot
  const diagnostics: ImportDiagnostic[] = []
  const aircraft = cache.aircraft.map((aircraftDefinition) =>
    compileAircraftBehavior(aircraftDefinition, packageRoot, diagnostics)
  )

  return {
    schemaVersion: COMPILED_BEHAVIOR_PACKAGE_SCHEMA_VERSION,
    source: {
      import: {
        backend: cache.source.backend,
        packageRoot,
        cacheKey: cache.source.cacheKey
      },
      importCachePath: options?.importCachePath
    },
    aircraft,
    diagnostics
  }
}

function compileAircraftBehavior(
  aircraftDefinition: NormalizedPackageImportCache['aircraft'][number],
  packageRoot: string,
  diagnostics: ImportDiagnostic[]
): CompiledBehaviorAircraft {
  const variants = aircraftDefinition.variants.map((variant) =>
    compileVariantBehavior(variant, aircraftDefinition.directory, packageRoot, diagnostics)
  )

  return {
    aircraftId: aircraftDefinition.aircraftId,
    variants
  }
}

function compileVariantBehavior(
  variant: NormalizedPackageImportCache['aircraft'][number]['variants'][number],
  aircraftDirectory: string,
  packageRoot: string,
  diagnostics: ImportDiagnostic[]
): CompiledBehaviorVariant {
  const state: VariantCompileState = {
    bindings: {
      animations: [],
      visibility: [],
      interactions: [],
      updates: []
    },
    diagnostics,
    unresolvedTemplates: new Set<string>(),
    templates: new Map(),
    bindingSequence: 0
  }

  const documents = collectVariantDocuments(variant, aircraftDirectory, packageRoot, diagnostics)
  for (const document of documents) {
    for (const template of findTemplates(document.root, document.relativePath)) {
      state.templates.set(template.name, template)
    }
  }

  for (const document of documents) {
    traverseNodes(
      getElementChildren(document.root),
      {},
      {
        sourceDocument: document.relativePath,
        componentPath: [],
        nodeId: undefined
      },
      state
    )
  }

  const symbols = buildSymbolTable(state.bindings)

  return {
    variantId: variant.id,
    sourceDocuments: documents.map((document) => ({
      path: document.relativePath,
      kind: document.kind,
      includedFrom: document.includedFrom,
      includeDirective: document.includeDirective
    })),
    bindings: state.bindings,
    symbols,
    unresolvedTemplates: [...state.unresolvedTemplates].sort(),
    summary: {
      templateCount: state.templates.size,
      animationCount: state.bindings.animations.length,
      visibilityCount: state.bindings.visibility.length,
      interactionCount: state.bindings.interactions.length,
      updateCount: state.bindings.updates.length
    }
  }
}

function collectVariantDocuments(
  variant: NormalizedPackageImportCache['aircraft'][number]['variants'][number],
  aircraftDirectory: string,
  packageRoot: string,
  diagnostics: ImportDiagnostic[]
): BehaviorDocument[] {
  const documents: BehaviorDocument[] = []

  for (const modelDocument of variant.resolved.model?.documents ?? []) {
    const absolutePath = resolve(packageRoot, modelDocument.path)
    if (!existsSync(absolutePath)) continue

    documents.push({
      absolutePath,
      relativePath: normalizeRelativePath(packageRoot, absolutePath),
      root: parseXmlDocument(readFileSync(absolutePath, 'utf8')),
      kind: 'model-document'
    })
  }

  return documents
}

function findTemplates(root: XmlElementNode, sourceDocument: string): TemplateDefinition[] {
  const templates: TemplateDefinition[] = []

  visitElements(getElementChildren(root), (element) => {
    if (element.name !== 'Template') return
    const name = element.attributes.Name
    if (!name) return
    templates.push({
      name,
      sourceDocument,
      node: element
    })
  })

  return templates
}

function traverseNodes(
  nodes: XmlElementNode[],
  scope: Record<string, string>,
  context: TraversalContext,
  state: VariantCompileState
): void {
  for (const node of expandControlNodes(nodes, scope)) {
    if (node.name === 'Template' || node.name === 'Include') continue
    if (PARAMETER_BLOCK_NAMES.has(node.name)) continue

    if (node.name === 'Component') {
      const componentId = substitute(node.attributes.ID ?? '', scope) || substitute(node.attributes.Node ?? '', scope)
      const nextContext: TraversalContext = {
        sourceDocument: context.sourceDocument,
        componentPath: componentId ? [...context.componentPath, componentId] : [...context.componentPath],
        nodeId: substitute(node.attributes.Node ?? '', scope) || context.nodeId
      }

      traverseNodes(getElementChildren(node), scope, nextContext, state)
      continue
    }

    if (node.name === 'UseTemplate') {
      const templateName = substitute(node.attributes.Name ?? '', scope)
      const invocationScope = buildInvocationScope(node, scope)
      if (templateName && state.templates.has(templateName)) {
        const definition = state.templates.get(templateName)!
        const templateScope = buildTemplateScope(definition.node, invocationScope)
        const templateContext: TraversalContext = {
          sourceDocument: definition.sourceDocument,
          componentPath: [...context.componentPath],
          nodeId: context.nodeId
        }
        traverseNodes(getBodyChildren(definition.node), templateScope, templateContext, state)
      } else {
        extractBindingsFromTemplateInvocation(templateName, invocationScope, context, state)
        if (templateName && !isExternalTemplate(templateName) && !state.templates.has(templateName)) {
          state.unresolvedTemplates.add(templateName)
        }
      }
      continue
    }

    extractBindingsFromDirectElement(node, scope, context, state)
    traverseNodes(getElementChildren(node), scope, context, state)
  }
}

function buildInvocationScope(
  node: XmlElementNode,
  parentScope: Record<string, string>
): Record<string, string> {
  const scope = { ...parentScope }
  const directChildren = expandControlNodes(getElementChildren(node), parentScope)

  for (const child of directChildren) {
    if (child.name === 'Parameters') {
      applyParameterBlock(scope, child, child.attributes.Type ?? 'Default')
      continue
    }

    if (PARAMETER_BLOCK_NAMES.has(child.name)) continue
    scope[child.name] = resolveParameterValue(child, scope)
  }

  return scope
}

function buildTemplateScope(
  template: XmlElementNode,
  invocationScope: Record<string, string>
): Record<string, string> {
  const scope = { ...invocationScope }
  const children = getElementChildren(template)

  for (const child of children) {
    if (child.name === 'DefaultTemplateParameters') {
      applyParameterBlock(scope, child, 'Default')
    } else if (child.name === 'Parameters' && child.attributes.Type === 'Default') {
      applyParameterBlock(scope, child, 'Default')
    }
  }

  for (const child of children) {
    if (child.name === 'OverrideTemplateParameters') {
      applyParameterBlock(scope, child, 'Override')
    } else if (child.name === 'Parameters' && child.attributes.Type === 'Override') {
      applyParameterBlock(scope, child, 'Override')
    }
  }

  return scope
}

function applyParameterBlock(
  scope: Record<string, string>,
  block: XmlElementNode,
  mode: 'Default' | 'Override' | string
): void {
  for (const node of expandControlNodes(getElementChildren(block), scope)) {
    if (node.name === 'AddParams') {
      for (const child of expandControlNodes(getElementChildren(node), scope)) {
        const key = substitute(child.name, scope)
        if (mode === 'Default' && scope[key] === undefined) {
          scope[key] = ''
        }
      }
      continue
    }

    const key = substitute(node.name, scope)
    const value = resolveParameterValue(node, scope)
    if (mode === 'Default') {
      if (scope[key] === undefined || scope[key] === '') {
        scope[key] = value
      }
    } else {
      scope[key] = value
    }
  }
}

function resolveParameterValue(node: XmlElementNode, scope: Record<string, string>): string {
  if (node.attributes.type?.trim().toLowerCase() === 'rnp') {
    return ''
  }
  return renderNodes(node.children, scope).trim()
}

function renderNodes(nodes: XmlNode[], scope: Record<string, string>): string {
  return nodes
    .map((child) => {
      if (child.type === 'text') {
        return substitute(child.text, scope)
      }

      if (child.name === 'Condition') {
        return renderNodes(expandConditionNode(child, scope).flatMap((entry) => entry.children), scope)
      }

      if (child.name === 'Switch') {
        return renderNodes(expandSwitchNode(child, scope).flatMap((entry) => entry.children), scope)
      }

      return renderNodes(child.children, scope)
    })
    .join('')
}

function expandControlNodes(nodes: XmlElementNode[], scope: Record<string, string>): XmlElementNode[] {
  const expanded: XmlElementNode[] = []

  for (const node of nodes) {
    if (node.name === 'Condition') {
      expanded.push(...expandConditionNode(node, scope))
      continue
    }

    if (node.name === 'Switch') {
      expanded.push(...expandSwitchNode(node, scope))
      continue
    }

    expanded.push(node)
  }

  return expanded
}

function expandConditionNode(node: XmlElementNode, scope: Record<string, string>): XmlElementNode[] {
  const conditionMet = evaluateCondition(node, scope)
  const children = getElementChildren(node)
  const explicitTrue = children.filter((child) => child.name === 'True')
  const explicitFalse = children.filter((child) => child.name === 'False')

  if (conditionMet && explicitTrue.length > 0) {
    return explicitTrue.flatMap((entry) => expandControlNodes(getElementChildren(entry), scope))
  }

  if (!conditionMet && explicitFalse.length > 0) {
    return explicitFalse.flatMap((entry) => expandControlNodes(getElementChildren(entry), scope))
  }

  if (conditionMet) {
    return expandControlNodes(
      children.filter((child) => child.name !== 'True' && child.name !== 'False'),
      scope
    )
  }

  return []
}

function evaluateCondition(node: XmlElementNode, scope: Record<string, string>): boolean {
  const checkKey = substitute(
    node.attributes.Check ?? node.attributes.NotEmpty ?? node.attributes.Valid ?? '',
    scope
  )
  const value = checkKey ? scope[checkKey] ?? '' : ''

  let result = false
  if (node.attributes.Check !== undefined) {
    result = isTruthy(value)
  } else if (node.attributes.NotEmpty !== undefined) {
    result = value.trim().length > 0
  } else if (node.attributes.Valid !== undefined) {
    result = value !== undefined && value.trim().length > 0
  }

  if (node.attributes.Match !== undefined) {
    result = result && value === substitute(node.attributes.Match, scope)
  }
  if (node.attributes.Equal !== undefined) {
    result = value === substitute(node.attributes.Equal, scope)
  }
  if (node.attributes.Different !== undefined) {
    result = value !== substitute(node.attributes.Different, scope)
  }
  if (node.attributes.Contains !== undefined) {
    result = value.includes(substitute(node.attributes.Contains, scope))
  }

  return result
}

function expandSwitchNode(node: XmlElementNode, scope: Record<string, string>): XmlElementNode[] {
  const switchParam = substitute(node.attributes.Param ?? '', scope)
  const switchValue = scope[switchParam] ?? ''
  let fallback: XmlElementNode | undefined

  for (const child of getElementChildren(node)) {
    if (child.name === 'Case' && substitute(child.attributes.Value ?? '', scope) === switchValue) {
      return expandControlNodes(getElementChildren(child), scope)
    }

    if (child.name === 'Default') {
      fallback = child
    }
  }

  return fallback ? expandControlNodes(getElementChildren(fallback), scope) : []
}

function extractBindingsFromDirectElement(
  node: XmlElementNode,
  scope: Record<string, string>,
  context: TraversalContext,
  state: VariantCompileState
): void {
  if (node.name === 'Visibility' || node.name === 'Animation' || node.name === 'Update') {
    const params = buildInvocationScope(node, scope)
    extractBindingsFromTemplateInvocation(node.name, params, context, state)
  }
}

function extractBindingsFromTemplateInvocation(
  templateName: string,
  params: Record<string, string>,
  context: TraversalContext,
  state: VariantCompileState
): void {
  const bindingBase = createBindingBase(templateName, context, state)
  const tooltip = firstDefined(params, ['TOOLTIPID', 'ANIMTIP_0', 'TOOLTIP_HAND'])
  let emittedAnimation = false

  if (params.ANIM_CODE && !params.ANIM_CODE.includes('#')) {
    state.bindings.animations.push({
      ...bindingBase,
      kind: 'animation',
      animName: firstDefined(params, ['ANIM_NAME', 'ANIM_NAME_KNOB', 'ANIM_NAME_SWITCH']) ?? context.nodeId,
      animLength: toOptionalNumber(params.ANIM_LENGTH),
      animLag: toOptionalNumber(params.ANIM_LAG),
      program: compileCalculatorCode(params.ANIM_CODE)
    })
    emittedAnimation = true
  }

  if (params.VISIBILITY_CODE && !params.VISIBILITY_CODE.includes('#')) {
    state.bindings.visibility.push({
      ...bindingBase,
      kind: 'visibility',
      program: compileCalculatorCode(params.VISIBILITY_CODE)
    })
  }

  if (params.UPDATE_CODE && !params.UPDATE_CODE.includes('#')) {
    state.bindings.updates.push({
      ...bindingBase,
      kind: 'update',
      frequency: toOptionalNumber(params.FREQUENCY),
      program: compileCalculatorCode(params.UPDATE_CODE)
    })
  }

  for (const interactionCode of DIRECT_INTERACTION_CODES) {
    const code = params[interactionCode.tag]
    if (!code || code.includes('#')) continue

    state.bindings.interactions.push({
      ...bindingBase,
      kind: 'interaction',
      trigger: interactionCode.trigger,
      tooltip,
      mouseFlags: params.MOUSEFLAGS_DEFAULT_IM,
      target: context.nodeId,
      program: compileCalculatorCode(code)
    })
  }

}

function createBindingBase(
  templateName: string,
  context: TraversalContext,
  state: VariantCompileState
): BehaviorBindingBase {
  state.bindingSequence += 1
  return {
    id: `${context.componentPath.join('.') || 'root'}:${state.bindingSequence}`,
    kind: 'update',
    sourceDocument: context.sourceDocument,
    templateName: templateName || undefined,
    componentPath: [...context.componentPath],
    nodeId: context.nodeId
  }
}

function buildSymbolTable(bindings: CompiledBindingSet): CompiledBehaviorVariant['symbols'] {
  const variables = new Map<string, RuntimeVariableReference>()
  const writableVariables = new Map<string, RuntimeVariableReference>()
  const events = new Map<string, RuntimeEventReference>()

  for (const program of [
    ...bindings.animations.map((binding) => binding.program),
    ...bindings.visibility.map((binding) => binding.program),
    ...bindings.interactions.map((binding) => binding.program),
    ...bindings.updates.map((binding) => binding.program)
  ]) {
    for (const reference of program.referencedVariables) {
      variables.set(variableKey(reference), reference)
    }
    for (const reference of program.writtenVariables) {
      writableVariables.set(variableKey(reference), reference)
    }
    for (const reference of program.emittedEvents) {
      events.set(eventKey(reference), reference)
    }
  }

  return {
    variables: [...variables.values()],
    writableVariables: [...writableVariables.values()],
    events: [...events.values()],
    eventChannels: [...new Set([...events.values()].map((entry) => entry.channel))],
    variableNamespaces: [
      ...new Set(
        [...variables.values(), ...writableVariables.values()].map((entry) => entry.namespace)
      )
    ]
  }
}

function getBodyChildren(templateNode: XmlElementNode): XmlElementNode[] {
  return getElementChildren(templateNode).filter((child) => !PARAMETER_BLOCK_NAMES.has(child.name))
}

function visitElements(nodes: XmlElementNode[], visit: (node: XmlElementNode) => void): void {
  for (const node of nodes) {
    visit(node)
    visitElements(getElementChildren(node), visit)
  }
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  return relative(resolve(root), absolutePath).replaceAll('\\', '/')
}

function substitute(source: string, scope: Record<string, string>): string {
  return source.replaceAll(/#([^#]+)#/g, (_match, key: string) => scope[key] ?? '')
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  return !['0', 'false', 'False', 'FALSE'].includes(value)
}

function isExternalTemplate(templateName: string): boolean {
  return templateName.startsWith('ASOBO_') || templateName.startsWith('Asobo')
}

function toOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function firstDefined(record: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (value && value.trim().length > 0) return value
  }
  return undefined
}

function variableKey(reference: RuntimeVariableReference): string {
  return `${reference.namespace}:${reference.name}:${reference.unit ?? ''}:${reference.index ?? ''}`
}

function eventKey(reference: RuntimeEventReference): string {
  return `${reference.channel}:${reference.name}:${reference.payloadShape ?? ''}`
}
