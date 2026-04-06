import { compileRpnExpression } from './rpn'
import type {
  CompiledAnimationBinding,
  CompiledBehaviorSet,
  CompiledVisibilityBinding,
  ImportDiagnostic,
  ImportedAircraft,
  ImportedPackage
} from './types'

interface LoadedDocument {
  readonly path: string
  readonly document: Document
}

interface CompileContext {
  readonly pkg: ImportedPackage
  readonly aircraft: ImportedAircraft
  readonly diagnostics: ImportDiagnostic[]
  readonly templateMap: Map<string, Element>
  readonly loadedDocuments: Map<string, LoadedDocument>
  readonly layoutPathIndex: ReadonlyMap<string, string>
}

interface TraversalState {
  readonly path: string
  readonly params: ReadonlyMap<string, string>
  readonly currentNode: string | null
}

const ANIMATION_TEMPLATE_NAMES = new Set(['ASOBO_GT_ANIM', 'ASOBO_GT_ANIM_CODE'])
const VISIBILITY_TEMPLATE_NAMES = new Set([
  'ASOBO_GT_VISIBILITY',
  'ASOBO_GT_VISIBILITY_CODE'
])

export async function compileMsfs2020Behaviors(
  pkg: ImportedPackage,
  aircraft: ImportedAircraft
): Promise<CompiledBehaviorSet> {
  const diagnostics = [...pkg.diagnostics]
  const templateMap = new Map<string, Element>()
  const loadedDocuments = new Map<string, LoadedDocument>()

  if (aircraft.model == null) {
    diagnostics.push({
      code: 'compile_model_missing',
      message: `Aircraft ${aircraft.id} does not have a resolved model definition.`,
      severity: 'error',
      sourcePath: aircraft.sourcePath
    })
    return {
      irVersion: 'msfs-behavior/v1',
      aircraftId: aircraft.id,
      animationBindings: [],
      visibilityBindings: [],
      variableKeys: [],
      diagnostics
    }
  }

  const context: CompileContext = {
    pkg,
    aircraft,
    diagnostics,
    templateMap,
    loadedDocuments,
    layoutPathIndex: new Map(
      pkg.layoutEntries.map(entry => [normalizePath(entry.path).toLowerCase(), normalizePath(entry.path)])
    )
  }

  await loadBehaviorDocument(aircraft.model.behaviorPath, context)

  const animationBindings: CompiledAnimationBinding[] = []
  const visibilityBindings: CompiledVisibilityBinding[] = []
  for (const loadedDocument of loadedDocuments.values()) {
    collectTemplates(loadedDocument.document, templateMap)
  }

  const rootDocument = loadedDocuments.get(aircraft.model.behaviorPath)
  if (rootDocument != null) {
    traverseElement(
      rootDocument.document.documentElement,
      {
        path: rootDocument.path,
        params: new Map<string, string>(),
        currentNode: null
      },
      context,
      animationBindings,
      visibilityBindings
    )
  }

  const variableKeys = new Set<string>()
  for (const binding of animationBindings) {
    for (const key of binding.expression.variableKeys) {
      variableKeys.add(key)
    }
  }
  for (const binding of visibilityBindings) {
    for (const key of binding.expression.variableKeys) {
      variableKeys.add(key)
    }
  }

  return {
    irVersion: 'msfs-behavior/v1',
    aircraftId: aircraft.id,
    animationBindings,
    visibilityBindings,
    variableKeys: [...variableKeys].sort(),
    diagnostics
  }
}

async function loadBehaviorDocument(
  path: string,
  context: CompileContext
): Promise<void> {
  const resolvedPath = resolveLayoutPath(path, context)
  if (resolvedPath == null) {
    context.diagnostics.push({
      code: 'behavior_document_missing',
      message: `Behavior document ${path} could not be resolved in the imported package.`,
      severity: 'warning',
      sourcePath: path
    })
    return
  }

  if (context.loadedDocuments.has(resolvedPath)) return

  const response = await fetch(new URL(resolvedPath, context.pkg.rootUrl))
  if (!response.ok) {
    context.diagnostics.push({
      code: 'behavior_document_missing',
      message: `Behavior document ${resolvedPath} could not be loaded.`,
      severity: 'warning',
      sourcePath: resolvedPath
    })
    return
  }

  const text = await response.text()
  const document = new DOMParser().parseFromString(text, 'text/xml')
  if (document.querySelector('parsererror')) {
    context.diagnostics.push({
      code: 'behavior_document_invalid_xml',
      message: `Behavior document ${resolvedPath} could not be parsed.`,
      severity: 'warning',
      sourcePath: resolvedPath
    })
    return
  }

  context.loadedDocuments.set(resolvedPath, { path: resolvedPath, document })

  for (const includeNode of document.querySelectorAll('Include')) {
    const includedPath = resolveIncludePath(resolvedPath, includeNode)
    if (!includedPath) continue
    await loadBehaviorDocument(includedPath, context)
  }
}

function resolveIncludePath(sourcePath: string, includeNode: Element): string | null {
  const relativeFile = includeNode.getAttribute('RelativeFile')
  if (relativeFile) {
    return joinPath(dirname(sourcePath), relativeFile)
  }

  const modelBehaviorFile = includeNode.getAttribute('ModelBehaviorFile')
  if (modelBehaviorFile) {
    return joinPath('ModelBehaviorDefs', modelBehaviorFile)
  }

  const pathAttribute = includeNode.getAttribute('Path')
  if (pathAttribute) {
    return joinPath('ModelBehaviorDefs', pathAttribute)
  }

  return null
}

function collectTemplates(document: Document, templateMap: Map<string, Element>): void {
  for (const templateNode of document.querySelectorAll('Template[Name]')) {
    const templateName = templateNode.getAttribute('Name')
    if (!templateName) continue
    templateMap.set(templateName.toUpperCase(), templateNode)
  }
}

function traverseElement(
  element: Element,
  state: TraversalState,
  context: CompileContext,
  animationBindings: CompiledAnimationBinding[],
  visibilityBindings: CompiledVisibilityBinding[]
): void {
  if (element.tagName === 'Template') {
    return
  }

  if (element.tagName === 'Include') {
    return
  }

  if (element.tagName === 'Condition') {
    const branch = selectConditionBranch(element, state.params)
    if (branch != null) {
      for (const child of Array.from(branch.children)) {
        traverseElement(child, state, context, animationBindings, visibilityBindings)
      }
    }
    return
  }

  if (element.tagName === 'Component') {
    const nodeName = substituteParameters(
      element.getAttribute('Node') ?? '',
      state.params
    ).trim()
    const nextState: TraversalState = {
      ...state,
      currentNode: nodeName || state.currentNode
    }
    for (const child of Array.from(element.children)) {
      traverseElement(child, nextState, context, animationBindings, visibilityBindings)
    }
    return
  }

  if (element.tagName === 'UseTemplate') {
    expandTemplateUse(
      element,
      state,
      context,
      animationBindings,
      visibilityBindings
    )
    return
  }

  for (const child of Array.from(element.children)) {
    traverseElement(child, state, context, animationBindings, visibilityBindings)
  }
}

function expandTemplateUse(
  useTemplateNode: Element,
  state: TraversalState,
  context: CompileContext,
  animationBindings: CompiledAnimationBinding[],
  visibilityBindings: CompiledVisibilityBinding[]
): void {
  const templateName = substituteParameters(
    useTemplateNode.getAttribute('Name') ?? '',
    state.params
  ).trim()
  if (!templateName) return

  const childParams = collectImmediateParameters(useTemplateNode, state.params)
  const mergedParams = new Map<string, string>(state.params)
  for (const [key, value] of childParams) {
    mergedParams.set(key, value)
  }

  const normalizedTemplateName = templateName.toUpperCase()
  if (ANIMATION_TEMPLATE_NAMES.has(normalizedTemplateName)) {
    const animationBinding = buildAnimationBinding(
      mergedParams,
      state.path,
      context.diagnostics
    )
    if (animationBinding != null) {
      animationBindings.push(animationBinding)
    }
    return
  }

  if (VISIBILITY_TEMPLATE_NAMES.has(normalizedTemplateName)) {
    const visibilityBinding = buildVisibilityBinding(
      mergedParams,
      state.currentNode,
      state.path,
      context.diagnostics
    )
    if (visibilityBinding != null) {
      visibilityBindings.push(visibilityBinding)
    }
    return
  }

  const templateNode = context.templateMap.get(normalizedTemplateName)
  if (templateNode == null) {
    context.diagnostics.push({
      code: 'template_missing',
      message: `Template ${templateName} is not available in the imported package.`,
      severity: 'warning',
      sourcePath: state.path
    })
    return
  }

  const templateParams = new Map<string, string>(state.params)
  for (const [key, value] of collectParameterBlock(
    templateNode,
    'DefaultTemplateParameters',
    templateParams
  )) {
    if (!templateParams.has(key)) {
      templateParams.set(key, value)
    }
  }
  for (const [key, value] of childParams) {
    templateParams.set(key, value)
  }
  for (const [key, value] of collectParameterBlock(
    templateNode,
    'OverrideTemplateParameters',
    templateParams
  )) {
    templateParams.set(key, value)
  }

  const nextState: TraversalState = {
    ...state,
    params: templateParams
  }

  for (const child of Array.from(templateNode.children)) {
    if (
      child.tagName === 'DefaultTemplateParameters' ||
      child.tagName === 'OverrideTemplateParameters'
    ) {
      continue
    }
    traverseElement(child, nextState, context, animationBindings, visibilityBindings)
  }
}

function buildAnimationBinding(
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): CompiledAnimationBinding | null {
  const target = params.get('ANIM_NAME')?.trim()
  const source = params.get('ANIM_CODE')?.trim()
  if (!target || !source) {
    diagnostics.push({
      code: 'animation_params_missing',
      message: 'Animation template expansion did not produce ANIM_NAME and ANIM_CODE.',
      severity: 'warning',
      sourcePath
    })
    return null
  }

  const expression = compileRpnExpression(source, { sourcePath, diagnostics })
  if (expression == null) return null

  const length = Number.parseFloat(params.get('ANIM_LENGTH') ?? '100') || 100
  const wrap = parseBoolean(params.get('ANIM_WRAP'))

  return {
    target,
    expression,
    length,
    wrap,
    sourcePath
  }
}

function buildVisibilityBinding(
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): CompiledVisibilityBinding | null {
  const target = params.get('NODE_ID')?.trim() || currentNode?.trim()
  const source =
    params.get('VISIBILITY_CODE')?.trim() ?? params.get('CODE')?.trim() ?? ''

  if (!target || !source) {
    diagnostics.push({
      code: 'visibility_params_missing',
      message: 'Visibility template expansion did not produce a node target and expression.',
      severity: 'warning',
      sourcePath
    })
    return null
  }

  const expression = compileRpnExpression(source, { sourcePath, diagnostics })
  if (expression == null) return null

  return {
    target,
    expression,
    sourcePath
  }
}

function collectImmediateParameters(
  element: Element,
  inheritedParams: ReadonlyMap<string, string>
): Map<string, string> {
  const params = new Map<string, string>()
  for (const child of Array.from(element.children)) {
    if (child.children.length > 0) continue
    const value = substituteParameters(child.textContent ?? '', inheritedParams).trim()
    params.set(child.tagName, value)
  }
  return params
}

function collectParameterBlock(
  templateNode: Element,
  tagName: 'DefaultTemplateParameters' | 'OverrideTemplateParameters',
  params: ReadonlyMap<string, string>
): Map<string, string> {
  const values = new Map<string, string>()
  const block = Array.from(templateNode.children).find(child => child.tagName === tagName)
  if (!block) return values

  for (const child of Array.from(block.children)) {
    if (child.children.length > 0) continue
    const value = substituteParameters(child.textContent ?? '', params).trim()
    values.set(child.tagName, value)
  }

  return values
}

function selectConditionBranch(
  conditionNode: Element,
  params: ReadonlyMap<string, string>
): Element | null {
  const notEmpty = conditionNode.getAttribute('NotEmpty')
  if (notEmpty) {
    const value = substituteParameters(`#${notEmpty}#`, params).trim()
    return value ? conditionNode.querySelector(':scope > True') : conditionNode.querySelector(':scope > False')
  }

  const empty = conditionNode.getAttribute('Empty')
  if (empty) {
    const value = substituteParameters(`#${empty}#`, params).trim()
    return value ? conditionNode.querySelector(':scope > False') : conditionNode.querySelector(':scope > True')
  }

  return conditionNode.querySelector(':scope > True')
}

function substituteParameters(
  value: string,
  params: ReadonlyMap<string, string>
): string {
  let currentValue = value

  for (let index = 0; index < 8; index += 1) {
    const nextValue = currentValue.replace(/#([A-Za-z0-9_:.]+)#/gu, (_match, key) => {
      return params.get(key) ?? ''
    })
    if (nextValue === currentValue) break
    currentValue = nextValue
  }

  return currentValue
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false
  const normalizedValue = value.trim().toLowerCase()
  return normalizedValue === '1' || normalizedValue === 'true'
}

function dirname(path: string): string {
  const normalizedPath = normalizePath(path)
  const lastSlashIndex = normalizedPath.lastIndexOf('/')
  if (lastSlashIndex < 0) return ''
  return normalizedPath.slice(0, lastSlashIndex)
}

function joinPath(basePath: string, nextPath: string): string {
  const parts = normalizePath(`${basePath}/${nextPath}`).split('/')
  const normalizedParts: string[] = []

  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      normalizedParts.pop()
      continue
    }
    normalizedParts.push(part)
  }

  return normalizedParts.join('/')
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+/gu, '/')
}

function resolveLayoutPath(path: string, context: CompileContext): string | null {
  return context.layoutPathIndex.get(normalizePath(path).toLowerCase()) ?? null
}
