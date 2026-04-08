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
  readonly rootUrl: string
  readonly path: string
  readonly document: Document
}

interface BehaviorSourceRoot {
  readonly rootUrl: string
  readonly layoutPathIndex: ReadonlyMap<string, string>
}

interface CompileContext {
  readonly pkg: ImportedPackage
  readonly aircraft: ImportedAircraft
  readonly diagnostics: ImportDiagnostic[]
  readonly templateMap: Map<string, Element>
  readonly loadedDocuments: Map<string, LoadedDocument>
  readonly sourceRoots: readonly BehaviorSourceRoot[]
}

interface CompileBehaviorOptions {
  readonly additionalPackageRoots?: readonly string[]
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
  aircraft: ImportedAircraft,
  options: CompileBehaviorOptions = {}
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

  const sourceRoots = await loadBehaviorSourceRoots(pkg, options.additionalPackageRoots ?? [], diagnostics)
  const context: CompileContext = {
    pkg,
    aircraft,
    diagnostics,
    templateMap,
    loadedDocuments,
    sourceRoots
  }

  await loadBehaviorDocument(aircraft.model.behaviorPath, context, sourceRoots[0] ?? null)

  const animationBindings: CompiledAnimationBinding[] = []
  const visibilityBindings: CompiledVisibilityBinding[] = []
  for (const loadedDocument of loadedDocuments.values()) {
    collectTemplates(loadedDocument.document, templateMap)
  }

  const rootDocument = sourceRoots.length > 0
    ? loadedDocuments.get(`${sourceRoots[0]!.rootUrl}::${normalizePath(aircraft.model.behaviorPath)}`)
    : null
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
  context: CompileContext,
  preferredRoot: BehaviorSourceRoot | null = null
): Promise<void> {
  const resolvedDocument = resolveBehaviorDocument(path, context, preferredRoot)
  if (resolvedDocument == null) {
    context.diagnostics.push({
      code: 'behavior_document_missing',
      message: `Behavior document ${path} could not be resolved in the imported package.`,
      severity: 'warning',
      sourcePath: path
    })
    return
  }

  const documentKey = `${resolvedDocument.root.rootUrl}::${resolvedDocument.path}`
  if (context.loadedDocuments.has(documentKey)) return

  const response = await fetch(new URL(resolvedDocument.path, resolvedDocument.root.rootUrl))
  if (!response.ok) {
    context.diagnostics.push({
      code: 'behavior_document_missing',
      message: `Behavior document ${resolvedDocument.path} could not be loaded.`,
      severity: 'warning',
      sourcePath: resolvedDocument.path
    })
    return
  }

  const text = await response.text()
  const document = new DOMParser().parseFromString(text, 'text/xml')
  if (document.querySelector('parsererror')) {
    context.diagnostics.push({
      code: 'behavior_document_invalid_xml',
      message: `Behavior document ${resolvedDocument.path} could not be parsed.`,
      severity: 'warning',
      sourcePath: resolvedDocument.path
    })
    return
  }

  context.loadedDocuments.set(documentKey, {
    rootUrl: resolvedDocument.root.rootUrl,
    path: resolvedDocument.path,
    document
  })

  for (const includeNode of document.querySelectorAll('Include')) {
    const includedPath = resolveIncludePath(resolvedDocument.path, includeNode)
    if (!includedPath) continue
    await loadBehaviorDocument(includedPath, context, resolvedDocument.root)
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

async function loadBehaviorSourceRoots(
  pkg: ImportedPackage,
  additionalPackageRoots: readonly string[],
  diagnostics: ImportDiagnostic[]
): Promise<readonly BehaviorSourceRoot[]> {
  const roots: BehaviorSourceRoot[] = [
    {
      rootUrl: pkg.rootUrl,
      layoutPathIndex: new Map(
        pkg.layoutEntries.map(entry => [normalizePath(entry.path).toLowerCase(), normalizePath(entry.path)])
      )
    }
  ]

  const seenRoots = new Set<string>([pkg.rootUrl.toLowerCase()])
  for (const rootCandidate of additionalPackageRoots) {
    const normalizedRoot = toAbsolutePackageRoot(rootCandidate)
    if (seenRoots.has(normalizedRoot.toLowerCase())) {
      continue
    }

    seenRoots.add(normalizedRoot.toLowerCase())
    const root = await tryLoadBehaviorSourceRoot(normalizedRoot, diagnostics)
    if (root != null) {
      roots.push(root)
    }
  }

  return roots
}

async function tryLoadBehaviorSourceRoot(
  rootUrl: string,
  diagnostics: ImportDiagnostic[]
): Promise<BehaviorSourceRoot | null> {
  try {
    const response = await fetch(new URL('layout.json', rootUrl))
    if (!response.ok) {
      diagnostics.push({
        code: 'behavior_root_layout_missing',
        message: `Additional behavior root ${rootUrl} is missing layout.json.`,
        severity: 'info',
        sourcePath: rootUrl
      })
      return null
    }

    const payload = (await response.json()) as {
      readonly content?: readonly {
        readonly path?: string
      }[]
    }

    const layoutPathIndex = new Map<string, string>()
    for (const entry of payload.content ?? []) {
      if (typeof entry.path !== 'string') {
        continue
      }

      const normalizedPath = normalizePath(entry.path)
      layoutPathIndex.set(normalizedPath.toLowerCase(), normalizedPath)
    }

    return {
      rootUrl,
      layoutPathIndex
    }
  } catch (error) {
    diagnostics.push({
      code: 'behavior_root_layout_failed',
      message: `Failed to load additional behavior root ${rootUrl}.`,
      severity: 'info',
      sourcePath: rootUrl,
      details: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

function resolveBehaviorDocument(
  path: string,
  context: CompileContext,
  preferredRoot: BehaviorSourceRoot | null
): { readonly root: BehaviorSourceRoot; readonly path: string } | null {
  const normalizedPath = normalizePath(path).toLowerCase()
  const candidateRoots =
    preferredRoot == null
      ? context.sourceRoots
      : [preferredRoot, ...context.sourceRoots.filter(root => root !== preferredRoot)]

  for (const root of candidateRoots) {
    const resolvedPath = root.layoutPathIndex.get(normalizedPath)
    if (resolvedPath != null) {
      return {
        root,
        path: resolvedPath
      }
    }
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

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

function toAbsolutePackageRoot(rootUrl: string): string {
  const normalizedRootUrl = ensureTrailingSlash(rootUrl)
  try {
    return new URL(normalizedRootUrl).toString()
  } catch {
    return new URL(normalizedRootUrl, window.location.href).toString()
  }
}
