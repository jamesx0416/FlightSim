import { compileRpnExpression, evaluateCompiledExpression } from './rpn'
import type {
  CompiledAnimationBinding,
  CompiledAnimationTriggerBinding,
  CompiledBehaviorSet,
  CompiledInputEventBinding,
  CompiledInteractionBinding,
  CompiledInteractionBlocker,
  CompiledInteractionSoundEvent,
  CompiledMaterialBinding,
  CompiledUpdateBinding,
  CompiledVisibilityBinding,
  ImportDiagnostic,
  ImportedAircraft,
  ImportedPackage
} from './types'

interface LoadedDocument {
  readonly rootUrl: string
  readonly path: string
  readonly document: Document
  readonly rootElement: Element
}

interface BehaviorSourceRoot {
  readonly rootUrl: string
  readonly layoutPathIndex: ReadonlyMap<string, string>
}

const behaviorSourceRootCache = new Map<string, Promise<BehaviorSourceRoot | null>>()
const behaviorDocumentCache = new Map<string, Promise<LoadedDocument | null>>()

interface CompileContext {
  readonly pkg: ImportedPackage
  readonly aircraft: ImportedAircraft
  readonly diagnostics: ImportDiagnostic[]
  readonly templateMap: Map<string, Element>
  readonly parameterFunctionMap: Map<string, Element>
  readonly loadedDocuments: Map<string, LoadedDocument>
  readonly sourceRoots: readonly BehaviorSourceRoot[]
  readonly builtinFallbackHits: Set<string>
  readonly animationTriggerBindings: CompiledAnimationTriggerBinding[]
}

interface CompileBehaviorOptions {
  readonly additionalPackageRoots?: readonly string[]
  readonly includeInteriorModel?: boolean
}

interface TraversalState {
  readonly path: string
  readonly params: ReadonlyMap<string, string>
  readonly currentNode: string | null
  readonly templateTrace: readonly string[]
}

type ParameterBlockKind = 'default' | 'override'

const ANIMATION_TEMPLATE_NAMES = new Set(['ASOBO_GT_ANIM_CODE'])
const NOOP_TEMPLATE_NAMES = new Set([
  'ASOBO_DOOR_INTERACTIVEPOINT_TEMPLATE'
])
const VISIBILITY_TEMPLATE_NAMES = new Set([
  'ASOBO_GT_VISIBILITY',
  'ASOBO_GT_VISIBILITY_CODE'
])
const BEHAVIOR_FETCH_TIMEOUT_MS = 10000
let activeParameterFunctionMap: ReadonlyMap<string, Element> = new Map()

export async function compileMsfs2020Behaviors(
  pkg: ImportedPackage,
  aircraft: ImportedAircraft,
  options: CompileBehaviorOptions = {}
): Promise<CompiledBehaviorSet> {
  const diagnostics = [...pkg.diagnostics]
  const templateMap = new Map<string, Element>()
  const parameterFunctionMap = new Map<string, Element>()
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
      animationTriggerBindings: [],
      visibilityBindings: [],
      materialBindings: [],
      updateBindings: [],
      inputEventBindings: [],
      interactionBindings: [],
      interactionBlockers: [],
      variableKeys: [],
      builtinFallbackHits: [],
      diagnostics: dedupeImportDiagnostics(diagnostics)
    }
  }

  const sourceRoots = await loadBehaviorSourceRoots(pkg, options.additionalPackageRoots ?? [], diagnostics)
  const context: CompileContext = {
    pkg,
    aircraft,
    diagnostics,
    templateMap,
    parameterFunctionMap,
    loadedDocuments,
    sourceRoots,
    builtinFallbackHits: new Set(),
    animationTriggerBindings: []
  }

  const aircraftModels = getAircraftModelDefinitions(aircraft, {
    includeInteriorModel: options.includeInteriorModel !== false
  })
  for (const model of aircraftModels) {
    await loadBehaviorDocument(model.behaviorPath, context, sourceRoots[0] ?? null)
  }

  const animationBindings: CompiledAnimationBinding[] = []
  const visibilityBindings: CompiledVisibilityBinding[] = []
  const materialBindings: CompiledMaterialBinding[] = []
  const updateBindings: CompiledUpdateBinding[] = []
  const inputEventBindings: CompiledInputEventBinding[] = []
  const interactionBindings: CompiledInteractionBinding[] = []
  const interactionBlockers: CompiledInteractionBlocker[] = []
  const rootParams = new Map<string, string>()
  for (const loadedDocument of loadedDocuments.values()) {
    collectDefinitions(loadedDocument.document, templateMap, parameterFunctionMap, rootParams)
  }

  activeParameterFunctionMap = parameterFunctionMap

  const rootDocuments = sourceRoots.length > 0
    ? aircraftModels
        .map(model =>
          loadedDocuments.get(
            `${sourceRoots[0]!.rootUrl}::${normalizePath(model.behaviorPath)}`
          ) ?? null
        )
        .filter((document): document is LoadedDocument => document != null)
    : []
  for (const rootDocument of rootDocuments) {
    traverseElement(
      rootDocument.rootElement,
      {
        path: rootDocument.path,
        params: rootParams,
        currentNode: null,
        templateTrace: []
      },
      context,
      animationBindings,
      visibilityBindings,
      materialBindings,
      updateBindings,
      inputEventBindings,
      interactionBindings,
      interactionBlockers
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
  for (const binding of materialBindings) {
    for (const key of binding.expression.variableKeys) {
      variableKeys.add(key)
    }
  }
  for (const binding of updateBindings) {
    for (const key of binding.expression.variableKeys) {
      variableKeys.add(key)
    }
  }
  for (const binding of inputEventBindings) {
    for (const key of binding.expression.variableKeys) {
      variableKeys.add(key)
    }
  }
  for (const binding of interactionBindings) {
    for (const key of binding.expression.variableKeys) {
      variableKeys.add(key)
    }
  }

  const compiled: CompiledBehaviorSet = {
    irVersion: 'msfs-behavior/v1',
    aircraftId: aircraft.id,
    animationBindings,
    animationTriggerBindings: context.animationTriggerBindings,
    visibilityBindings,
    materialBindings,
    updateBindings,
    inputEventBindings,
    interactionBindings,
    interactionBlockers,
    variableKeys: [...variableKeys].sort(),
    builtinFallbackHits: [...context.builtinFallbackHits].sort(),
    diagnostics: dedupeImportDiagnostics(diagnostics)
  }

  activeParameterFunctionMap = new Map()
  return compiled
}

function dedupeImportDiagnostics(diagnostics: readonly ImportDiagnostic[]): ImportDiagnostic[] {
  const seen = new Set<string>()
  const deduped: ImportDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.sourcePath ?? '',
      diagnostic.message
    ].join('\0')
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(diagnostic)
  }
  return deduped
}

function getAircraftModelDefinitions(
  aircraft: ImportedAircraft,
  options: {
    readonly includeInteriorModel: boolean
  }
) {
  return [
    aircraft.model,
    options.includeInteriorModel ? aircraft.interiorModel : null
  ]
    .filter((model): model is NonNullable<typeof model> => model != null)
}

async function loadBehaviorDocumentShallow(
  path: string,
  context: CompileContext,
  preferredRoot: BehaviorSourceRoot | null = null
): Promise<void> {
  const resolvedDocument = resolveBehaviorDocument(path, context, preferredRoot)
  if (resolvedDocument == null) {
    return
  }

  const documentKey = `${resolvedDocument.root.rootUrl}::${resolvedDocument.path}`
  if (context.loadedDocuments.has(documentKey)) {
    return
  }

  const loadedDocument = await loadBehaviorDocumentFromCache(
    resolvedDocument.root.rootUrl,
    resolvedDocument.path
  )
  if (loadedDocument != null) {
    context.loadedDocuments.set(documentKey, loadedDocument)
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

  const loadedDocument = await loadBehaviorDocumentFromCache(
    resolvedDocument.root.rootUrl,
    resolvedDocument.path
  )
  if (loadedDocument == null) {
    context.diagnostics.push({
      code: 'behavior_document_missing',
      message: `Behavior document ${resolvedDocument.path} could not be loaded.`,
      severity: 'warning',
      sourcePath: resolvedDocument.path
    })
    return
  }

  context.loadedDocuments.set(documentKey, loadedDocument)

  for (const includeNode of loadedDocument.rootElement.querySelectorAll('Include')) {
    const includedPath = resolveIncludePath(resolvedDocument.path, includeNode)
    if (!includedPath) continue
    await loadBehaviorDocument(includedPath, context, resolvedDocument.root)
  }
}

function resolveIncludePath(sourcePath: string, includeNode: Element): string | null {
  const relativeFile = getAttributeValue(includeNode, 'RelativeFile')
  if (relativeFile) {
    return joinPath(dirname(sourcePath), relativeFile)
  }

  const modelBehaviorFile = getAttributeValue(includeNode, 'ModelBehaviorFile')
  if (modelBehaviorFile) {
    return joinPath('ModelBehaviorDefs', modelBehaviorFile)
  }

  const pathAttribute = getAttributeValue(includeNode, 'Path')
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
  const cached = behaviorSourceRootCache.get(rootUrl)
  if (cached != null) {
    return cached
  }

  const pending = tryLoadBehaviorSourceRootUncached(rootUrl, diagnostics)
  behaviorSourceRootCache.set(rootUrl, pending)
  return pending
}

async function tryLoadBehaviorSourceRootUncached(
  rootUrl: string,
  diagnostics: ImportDiagnostic[]
): Promise<BehaviorSourceRoot | null> {
  try {
    const response = await fetchWithTimeout(
      new URL('layout.json', rootUrl).toString(),
      BEHAVIOR_FETCH_TIMEOUT_MS
    )
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

async function loadBehaviorDocumentFromCache(
  rootUrl: string,
  path: string
): Promise<LoadedDocument | null> {
  const cacheKey = `${rootUrl}::${path}`
  const cached = behaviorDocumentCache.get(cacheKey)
  if (cached != null) {
    return cached
  }

  const pending = loadBehaviorDocumentFromCacheUncached(rootUrl, path)
  behaviorDocumentCache.set(cacheKey, pending)
  return pending
}

async function loadBehaviorDocumentFromCacheUncached(
  rootUrl: string,
  path: string
): Promise<LoadedDocument | null> {
  let response: Response
  try {
    response = await fetchWithTimeout(
      new URL(path, rootUrl).toString(),
      BEHAVIOR_FETCH_TIMEOUT_MS
    )
  } catch {
    return null
  }
  if (!response.ok) {
    return null
  }

  const text = await response.text()
  const parsedDocument = parseBehaviorDocument(text)
  if (parsedDocument == null) {
    return null
  }

  return {
    rootUrl,
    path,
    document: parsedDocument.document,
    rootElement: parsedDocument.rootElement
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      signal: controller.signal
    })
  } finally {
    window.clearTimeout(timeoutId)
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

function collectDefinitions(
  document: Document,
  templateMap: Map<string, Element>,
  parameterFunctionMap: Map<string, Element>,
  rootParams: Map<string, string>
): void {
  for (const templateNode of document.querySelectorAll('Template')) {
    const templateName = getAttributeValue(templateNode, 'Name')
    if (!templateName) continue
    templateMap.set(templateName.toUpperCase(), templateNode)
  }

  for (const functionNode of document.querySelectorAll('ParametersFn')) {
    const functionName = getAttributeValue(functionNode, 'Name')
    if (!functionName) continue
    parameterFunctionMap.set(functionName.toUpperCase(), functionNode)
  }

  for (const macroNode of document.querySelectorAll('Macro')) {
    const macroName = getAttributeValue(macroNode, 'Name')
    if (!macroName) continue
    rootParams.set(`@${macroName}`, (macroNode.textContent ?? '').trim())
  }
}

function parseBehaviorDocument(
  source: string
): { readonly document: Document; readonly rootElement: Element } | null {
  const preprocessed = preprocessBehaviorXml(source)
  const xmlDocument = new DOMParser().parseFromString(preprocessed, 'text/xml')
  if (!xmlDocument.querySelector('parsererror') && xmlDocument.documentElement != null) {
    return {
      document: xmlDocument,
      rootElement: xmlDocument.documentElement
    }
  }

  const htmlDocument = new DOMParser().parseFromString(preprocessed, 'text/html')
  const rootElement = htmlDocument.querySelector('modelbehaviors')
  if (rootElement == null) {
    return null
  }

  return {
    document: htmlDocument,
    rootElement
  }
}

function traverseElement(
  element: Element,
  state: TraversalState,
  context: CompileContext,
  animationBindings: CompiledAnimationBinding[],
  visibilityBindings: CompiledVisibilityBinding[],
  materialBindings: CompiledMaterialBinding[],
  updateBindings: CompiledUpdateBinding[],
  inputEventBindings: CompiledInputEventBinding[],
  interactionBindings: CompiledInteractionBinding[],
  interactionBlockers: CompiledInteractionBlocker[]
): void {
  const elementTagName = getElementTagName(element)

  if (elementTagName === 'Template') {
    return
  }

  if (elementTagName === 'Include') {
    return
  }

  const scopedState = applyScopedParameters(element, state)

  if (elementTagName === 'Condition') {
    const branch = selectConditionBranch(element, scopedState.params)
    if (branch != null) {
      for (const child of Array.from(branch.children)) {
        traverseElement(child, scopedState, context, animationBindings, visibilityBindings, materialBindings, updateBindings, inputEventBindings, interactionBindings, interactionBlockers)
      }
    }
    return
  }

  if (elementTagName === 'Switch') {
    const branch = selectSwitchBranch(element, scopedState.params)
    if (branch != null) {
      for (const child of Array.from(branch.children)) {
        traverseElement(child, scopedState, context, animationBindings, visibilityBindings, materialBindings, updateBindings, inputEventBindings, interactionBindings, interactionBlockers)
      }
    }
    return
  }

  if (elementTagName === 'Component') {
    const nodeName = substituteParameters(
      element.getAttribute('Node') ?? '',
      scopedState.params
    ).trim()
    const nextState: TraversalState = {
      ...scopedState,
      currentNode: nodeName || state.currentNode
    }
    for (const child of Array.from(element.children)) {
      if (
        getElementTagName(child) === 'DefaultTemplateParameters' ||
        getElementTagName(child) === 'OverrideTemplateParameters'
      ) {
        continue
      }
      traverseElement(child, nextState, context, animationBindings, visibilityBindings, materialBindings, updateBindings, inputEventBindings, interactionBindings, interactionBlockers)
    }
    return
  }

  if (elementTagName === 'Update') {
    const updateBinding = buildUpdateNodeBinding(
      element,
      scopedState.params,
      scopedState.currentNode,
      state.path,
      context.diagnostics
    )
    if (updateBinding != null) {
      updateBindings.push(updateBinding)
    }
    return
  }

  if (elementTagName === 'Animation') {
    const animationBinding = buildAnimationNodeBinding(
      element,
      scopedState.params,
      scopedState.currentNode,
      state.path,
      context.diagnostics
    )
    if (animationBinding != null) {
      animationBindings.push(animationBinding)
    }
    return
  }

  if (elementTagName === 'AnimationTriggers') {
    context.animationTriggerBindings.push(
      ...buildAnimationTriggerBindings(element, scopedState.params, state.path)
    )
    return
  }

  if (elementTagName === 'Material') {
    const materialBinding = buildMaterialBinding(
      element,
      scopedState.params,
      scopedState.currentNode,
      state.path,
      context.diagnostics
    )
    if (materialBinding != null) {
      pushUniqueMaterialBinding(materialBindings, materialBinding)
    }
    return
  }

  if (elementTagName === 'UseInputEvent') {
    const inputEventParams = new Map(scopedState.params)
    for (const [key, value] of collectImmediateParameters(
      element,
      scopedState.params,
      state.path,
      context.diagnostics
    )) {
      inputEventParams.set(key, value)
    }
    if (!inputEventParams.get('INPUT_EVENT_ID_SOURCE')?.trim()) {
      const useInputEventId = substituteParameters(
        getAttributeValue(element, 'ID') ?? '',
        inputEventParams
      ).trim()
      if (useInputEventId) {
        inputEventParams.set('INPUT_EVENT_ID_SOURCE', useInputEventId)
      }
    }
    for (const binding of collectInteractionInputEventBridgeBindings(
      inputEventParams,
      scopedState.currentNode,
      state.path,
      context.diagnostics
    )) {
      pushUniqueInputEventBinding(inputEventBindings, binding)
    }
    const inputEventSource = getInteractionUseInputEventCodeSource(inputEventParams)
    if (inputEventSource) {
      const interactionBinding = buildInteractionCodeBinding(
        inputEventSource,
        null,
        inputEventParams,
        scopedState.currentNode,
        state.path,
        'callback',
        context.diagnostics
      )
      if (interactionBinding != null) {
        pushUniqueInteractionBinding(interactionBindings, interactionBinding)
      }
    }
  }

  if (elementTagName === 'MouseRect') {
    const blocker = buildInteractionBlocker(scopedState.params, scopedState.currentNode, state.path)
    if (blocker != null) {
      pushUniqueInteractionBlocker(interactionBlockers, blocker)
      return
    }

    const callbackNode =
      getDirectChild(element, 'CallbackCode')
    const callbackSource =
      buildCallbackCodeSource(callbackNode) ??
      buildCallbackDraggingSource(getDirectChild(element, 'CallbackDragging')) ??
      buildCallbackJumpDraggingSource(getDirectChild(element, 'CallbackJumpDragging')) ??
      ''
    if (callbackNode != null) {
      const interactionBinding = buildInteractionCodeBinding(
        callbackSource,
        null,
        scopedState.params,
        scopedState.currentNode,
        state.path,
        'callback',
        context.diagnostics
      )
      if (interactionBinding != null) {
        pushUniqueInteractionBinding(interactionBindings, interactionBinding)
      }
    }
    const eventIdNode = getDirectChild(element, 'EventID')
    const eventId = substituteParameters(eventIdNode?.textContent ?? '', scopedState.params).trim()
    if (eventId) {
      const interactionBinding = buildInteractionEventBinding(
        eventId,
        scopedState.params,
        scopedState.currentNode,
        state.path,
        'callback',
        context.diagnostics
      )
      if (interactionBinding != null) {
        pushUniqueInteractionBinding(interactionBindings, interactionBinding)
      }
    } else if (callbackSource.trim()) {
      const interactionBinding = buildInteractionCodeBinding(
        callbackSource,
        null,
        scopedState.params,
        scopedState.currentNode,
        state.path,
        'callback',
        context.diagnostics
      )
      if (interactionBinding != null) {
        pushUniqueInteractionBinding(interactionBindings, interactionBinding)
      }
    }
  }

  if (isMouseRectPayloadElement(element)) {
    const payloadBinding = buildMouseRectPayloadInteractionBinding(
      element,
      scopedState.params,
      scopedState.currentNode,
      state.path,
      context.diagnostics
    )
    if (payloadBinding != null) {
      pushUniqueInteractionBinding(interactionBindings, payloadBinding)
    }
  }

  if (elementTagName === 'Loop') {
    const doNode = getDirectChild(element, 'Do')
    if (doNode == null) {
      return
    }
    const thenNode = getDirectChild(element, 'Then')
    let loopScopedParams = new Map(scopedState.params)
    executeLoop(
      element,
      scopedState.params,
      state.path,
      context.diagnostics,
      iterationParams => {
        loopScopedParams = applyLoopDoParameterBlocks(
          doNode,
          loopScopedParams,
          iterationParams,
          state.path,
          context.diagnostics
        )

        for (const child of Array.from(doNode.children)) {
          if (getParameterBlockKind(child) != null) {
            continue
          }
          traverseElement(
            child,
            {
              ...scopedState,
              params: loopScopedParams
            },
            context,
            animationBindings,
            visibilityBindings,
            materialBindings,
            updateBindings,
            inputEventBindings,
            interactionBindings,
            interactionBlockers
          )
        }
      }
    )
    if (thenNode != null) {
      for (const child of Array.from(thenNode.children)) {
        traverseElement(
          child,
          {
            ...scopedState,
            params: loopScopedParams
          },
          context,
          animationBindings,
          visibilityBindings,
          materialBindings,
          updateBindings,
          inputEventBindings,
          interactionBindings,
          interactionBlockers
        )
      }
    }
    return
  }

  if (getElementTagName(element) === 'UseTemplate') {
    expandTemplateUse(
      element,
      scopedState,
      context,
      animationBindings,
      visibilityBindings,
      materialBindings,
      updateBindings,
      inputEventBindings,
      interactionBindings,
      interactionBlockers
    )
    return
  }

  for (const child of Array.from(element.children)) {
    if (
      getElementTagName(child) === 'DefaultTemplateParameters' ||
      getElementTagName(child) === 'OverrideTemplateParameters'
    ) {
      continue
    }
    traverseElement(child, scopedState, context, animationBindings, visibilityBindings, materialBindings, updateBindings, inputEventBindings, interactionBindings, interactionBlockers)
  }
}

function buildInteractionBlocker(
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string
): CompiledInteractionBlocker | null {
  if (!parseBoolean(params.get('DISABLE_MOUSERECT') ?? 'False')) {
    return null
  }

  const target =
    params.get('NODE_ID')?.trim() ||
    currentNode?.trim() ||
    params.get('ANIM_NAME')?.trim() ||
    params.get('PART_ID')?.trim() ||
    ''
  if (!target) {
    return null
  }

  return {
    target,
    feedbackTargets: collectInteractionFeedbackTargets(params, currentNode, target),
    sourcePath
  }
}

function buildMouseRectPayloadInteractionBinding(
  element: Element,
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): CompiledInteractionBinding | null {
  const elementTagName = getElementTagName(element)
  if (elementTagName === 'CallbackCode') {
    return buildInteractionCodeBinding(
      buildCallbackCodeSource(element) ?? '',
      null,
      params,
      currentNode,
      sourcePath,
      'callback',
      diagnostics
    )
  }

  if (elementTagName === 'CallbackDragging') {
    return buildInteractionCodeBinding(
      buildCallbackDraggingSource(element) ?? '',
      null,
      params,
      currentNode,
      sourcePath,
      'callback',
      diagnostics
    )
  }

  if (elementTagName === 'CallbackJumpDragging') {
    return buildInteractionCodeBinding(
      buildCallbackJumpDraggingSource(element) ?? '',
      null,
      params,
      currentNode,
      sourcePath,
      'callback',
      diagnostics
    )
  }

  if (elementTagName === 'EventID') {
    const eventId = substituteParameters(element.textContent ?? '', params).trim()
    return eventId
      ? buildInteractionEventBinding(eventId, params, currentNode, sourcePath, 'callback', diagnostics)
      : null
  }

  return null
}

function isMouseRectPayloadElement(element: Element): boolean {
  const elementTagName = getElementTagName(element)
  if (
    elementTagName !== 'CallbackCode' &&
    elementTagName !== 'CallbackDragging' &&
    elementTagName !== 'CallbackJumpDragging' &&
    elementTagName !== 'EventID'
  ) {
    return false
  }

  const parent = element.parentElement
  if (parent == null) {
    return false
  }

  const parentTagName = getElementTagName(parent)
  if (parentTagName === 'MouseRect') {
    return true
  }

  if (parentTagName !== 'Case') {
    return false
  }

  const switchNode = parent.parentElement
  return switchNode != null &&
    getElementTagName(switchNode) === 'Switch' &&
    switchNode.parentElement != null &&
    getElementTagName(switchNode.parentElement) === 'MouseRect'
}

function expandTemplateUse(
  useTemplateNode: Element,
  state: TraversalState,
  context: CompileContext,
  animationBindings: CompiledAnimationBinding[],
  visibilityBindings: CompiledVisibilityBinding[],
  materialBindings: CompiledMaterialBinding[],
  updateBindings: CompiledUpdateBinding[],
  inputEventBindings: CompiledInputEventBinding[],
  interactionBindings: CompiledInteractionBinding[],
  interactionBlockers: CompiledInteractionBlocker[]
): void {
  const templateName = substituteParameters(
    getAttributeValue(useTemplateNode, 'Name') ?? '',
    state.params
  ).trim()
  if (!templateName) return

  const childParams = collectImmediateParameters(
    useTemplateNode,
    state.params,
    state.path,
    context.diagnostics
  )
  const mergedParams = new Map<string, string>(state.params)
  for (const [key, value] of childParams) {
    mergedParams.set(key, value)
  }

  const normalizedTemplateName = templateName.toUpperCase()
  const templateTraceKey = createTemplateTraceKey(normalizedTemplateName, mergedParams)
  if (state.templateTrace.includes(templateTraceKey)) {
    context.diagnostics.push({
      code: 'template_recursion_cycle',
      message: `Template ${templateName} entered a recursive expansion cycle.`,
      severity: 'warning',
      sourcePath: state.path,
      details: state.templateTrace.join(' -> ')
    })
    return
  }

  if (normalizedTemplateName === 'ASOBO_GT_ANIM') {
    if (!hasAnimationTarget(mergedParams)) {
      return
    }
    const animationBinding =
      mergedParams.get('ANIM_CODE')?.trim()
        ? buildAnimationBinding(
            mergedParams,
            state.currentNode,
            state.path,
            context.diagnostics
          )
        : hasAnimationSimSource(mergedParams)
          ? buildAnimationSimBinding(
              mergedParams,
              state.currentNode,
              state.path,
              context.diagnostics
            )
          : null
    if (animationBinding != null) {
      animationBindings.push(animationBinding)
    }
    return
  }

  if (ANIMATION_TEMPLATE_NAMES.has(normalizedTemplateName)) {
    if (!hasAnimationTarget(mergedParams) || !mergedParams.get('ANIM_CODE')?.trim()) {
      return
    }
    const animationBinding = buildAnimationBinding(
      mergedParams,
      state.currentNode,
      state.path,
      context.diagnostics
    )
    if (animationBinding != null) {
      animationBindings.push(animationBinding)
    }
    return
  }

  if (NOOP_TEMPLATE_NAMES.has(normalizedTemplateName)) {
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
  for (const [key, value] of childParams) {
    templateParams.set(key, value)
  }
  applyParameterBlocks(templateNode, 'default', templateParams, state.path, context.diagnostics)
  applyParameterBlocks(templateNode, 'override', templateParams, state.path, context.diagnostics)

  for (const binding of collectInteractionInputEventBridgeBindings(
    templateParams,
    state.currentNode,
    state.path,
    context.diagnostics
  )) {
    pushUniqueInputEventBinding(inputEventBindings, binding)
  }

  const leftSingleSource =
    templateParams.get('LEFT_SINGLE_CODE')?.trim() ||
    templateParams.get('LEFT_SINGLE_CODE_DEFAULT_IM')?.trim() ||
    ''
  const mouseEventCallbackSource = buildMouseEventInteractionCodeSource(templateParams)
  if (mouseEventCallbackSource) {
    const interactionBinding = buildInteractionCodeBinding(
      mouseEventCallbackSource,
      null,
      templateParams,
      state.currentNode,
      state.path,
      'callback',
      context.diagnostics
    )
    if (interactionBinding != null) {
      pushUniqueInteractionBinding(interactionBindings, interactionBinding)
    }
  } else if (leftSingleSource) {
    const leftReleaseSource =
      templateParams.get('LEFT_LEAVE_CODE')?.trim() ||
      templateParams.get('LEFT_RELEASE_CODE')?.trim() ||
      templateParams.get('LEFT_LEAVE_CODE_DEFAULT_IM')?.trim() ||
      templateParams.get('LEFT_RELEASE_CODE_DEFAULT_IM')?.trim() ||
      ''
    const interactionBinding = buildInteractionCodeBinding(
      leftSingleSource,
      leftReleaseSource,
      templateParams,
      state.currentNode,
      state.path,
      'leftSingle',
      context.diagnostics
    )
    if (interactionBinding != null) {
      pushUniqueInteractionBinding(interactionBindings, interactionBinding)
    }
  }
  const eventId = templateParams.get('EVENTID')?.trim() ?? ''
  if (eventId) {
    const interactionBinding = buildInteractionEventBinding(
      eventId,
      templateParams,
      state.currentNode,
      state.path,
      'leftSingle',
      context.diagnostics
    )
    if (interactionBinding != null) {
      pushUniqueInteractionBinding(interactionBindings, interactionBinding)
    }
  }
  if (!leftSingleSource && !eventId) {
    const fallbackCodeSource = getInteractionFallbackCodeSource(templateParams)
    const fallbackEventId = fallbackCodeSource ? '' : getInteractionFallbackEventId(templateParams)
    if (fallbackCodeSource) {
      const interactionBinding = buildInteractionCodeBinding(
        fallbackCodeSource,
        null,
        templateParams,
        state.currentNode,
        state.path,
        'callback',
        context.diagnostics
      )
      if (interactionBinding != null) {
        pushUniqueInteractionBinding(interactionBindings, interactionBinding)
      }
    } else if (fallbackEventId) {
      const interactionBinding = buildInteractionEventBinding(
        fallbackEventId,
        templateParams,
        state.currentNode,
        state.path,
        'callback',
        context.diagnostics
      )
      if (interactionBinding != null) {
        pushUniqueInteractionBinding(interactionBindings, interactionBinding)
      }
    }
  }

  const nextState: TraversalState = {
    ...state,
    params: templateParams,
    templateTrace: [...state.templateTrace, templateTraceKey]
  }

  for (const child of Array.from(templateNode.children)) {
    if (
      getElementTagName(child) === 'DefaultTemplateParameters' ||
      getElementTagName(child) === 'OverrideTemplateParameters'
    ) {
      continue
    }
    traverseElement(child, nextState, context, animationBindings, visibilityBindings, materialBindings, updateBindings, inputEventBindings, interactionBindings, interactionBlockers)
  }
}

function buildCallbackCodeSource(node: Element | null): string | null {
  if (node == null) {
    return null
  }
  const instanceNode = getDirectChild(node, 'IMCodeInstances')
  if (instanceNode == null) {
    return node.textContent ?? ''
  }
  const defaultSource = getDirectChildText(instanceNode, 'IMDefault')
  const dragSource = getDirectChildText(instanceNode, 'IMDrag')
  if (defaultSource && dragSource) {
    return `(M:InputType) 1 == if{ ${dragSource} } els{ ${defaultSource} }`
  }
  return dragSource || defaultSource || ''
}

function buildCallbackDraggingSource(node: Element | null): string | null {
  if (node == null) {
    return null
  }
  const variable = getDirectChildText(node, 'Variable')
  if (!variable) {
    return null
  }
  const units = getDirectChildText(node, 'Units') || 'Number'
  const scale = getDirectChildText(node, 'Scale') || '1'
  const minValue = getDirectChildText(node, 'MinValue') || '0'
  const maxValue = getDirectChildText(node, 'MaxValue') || '16384'
  const eventId = normalizeKeyEventId(getDirectChildText(node, 'EventID'))
  const isRelative = parseBoolean(getDirectChildText(node, 'IsRelative') || 'False')
  const dragValue = `(M:DragPercent) ${scale} * ${maxValue} min ${minValue} max`
  const nextValue = isRelative
    ? `(A:${variable}, ${units}) ${dragValue} +`
    : dragValue
  return eventId
    ? `${nextValue} (>K:${eventId})`
    : `${nextValue} (>A:${variable}, ${units})`
}

function buildCallbackJumpDraggingSource(node: Element | null): string | null {
  if (node == null) {
    return null
  }
  const movementNode = getDirectChild(node, 'XMovement') ?? getDirectChild(node, 'YMovement')
  if (movementNode == null) {
    return null
  }
  const axis = getElementTagName(movementNode) === 'XMovement' ? 'X' : 'Y'
  const delta = getDirectChildText(movementNode, 'Delta') || '0.001'
  const eventIdInc = normalizeKeyEventId(getDirectChildText(movementNode, 'EventIdInc'))
  const eventIdDec = normalizeKeyEventId(getDirectChildText(movementNode, 'EventIdDec'))
  if (!eventIdInc || !eventIdDec) {
    return null
  }
  return `
    (M:Event) 'WheelUp' scmi 0 == if{ (>K:${eventIdInc}) } els{
    (M:Event) 'WheelDown' scmi 0 == if{ (>K:${eventIdDec}) } els{
    (M:Event) 'LeftSingle' scmi 0 == if{ (M:Relative${axis}) (>O:_Last${axis}) } els{
    (M:Event) 'Lock' scmi 0 == if{ (M:Relative${axis}) (>O:_Last${axis}) } els{
    (M:Event) 'LeftDrag' scmi 0 == if{
      (M:Relative${axis}) (O:_Last${axis}) - sp0
      l0 abs ${delta} > if{
        l0 0 > if{ (>K:${eventIdInc}) } els{ (>K:${eventIdDec}) }
        (M:Relative${axis}) (>O:_Last${axis})
      }
    } } } } }
  `
}

function buildAnimationBinding(
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
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

  const expression = compileRpnExpression(source, {
    sourcePath,
    sourceExpression: source,
    diagnostics,
    localVariableScope: resolveLocalVariableScope(params, currentNode, target)
  })
  if (expression == null) return null

  const length = Number.parseFloat(params.get('ANIM_LENGTH') ?? '100') || 100
  const wrap = parseBoolean(params.get('ANIM_WRAP'))

  return {
    target,
    expression,
    length,
    wrap,
    delta: parseBoolean(params.get('ANIM_DELTA')),
    lagFramesPerSecond: Math.max(parseNumber(params.get('ANIM_LAG'), 0), 0),
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

  if (isDisabledEmissiveDrivenVisibility(params, source)) {
    return null
  }

  if (!target || !source) {
    diagnostics.push({
      code: 'visibility_params_missing',
      message: 'Visibility template expansion did not produce a node target and expression.',
      severity: 'warning',
      sourcePath
    })
    return null
  }

  const expression = compileRpnExpression(source, {
    sourcePath,
    sourceExpression: source,
    diagnostics,
    localVariableScope: resolveLocalVariableScope(params, currentNode, target)
  })
  if (expression == null) return null

  return {
    target,
    expression,
    sourcePath
  }
}

function buildMaterialBinding(
  materialNode: Element,
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): CompiledMaterialBinding | null {
  const emissiveFactorNode = getDirectChild(materialNode, 'EmissiveFactor')
  const parameterNode = emissiveFactorNode == null
    ? null
    : getDirectChild(emissiveFactorNode, 'Parameter')
  const codeNode = parameterNode == null ? null : getDirectChild(parameterNode, 'Code')
  const source = substituteParameters(codeNode?.textContent ?? '', params).trim()
  if (!source) {
    return null
  }

  const target =
    currentNode?.trim() ||
    params.get('NODE_ID')?.trim() ||
    params.get('PART_ID')?.trim() ||
    null
  if (!target) {
    diagnostics.push({
      code: 'material_params_missing',
      message: 'Material emissive template expansion did not produce a node target.',
      severity: 'warning',
      sourcePath
    })
    return null
  }

  const expression = compileRpnExpression(source, {
    sourcePath,
    sourceExpression: source,
    diagnostics,
    localVariableScope: target
  })
  if (expression == null) return null

  const overrideBaseEmissiveNode =
    emissiveFactorNode == null ? null : getDirectChild(emissiveFactorNode, 'OverrideBaseEmissive')
  const overrideBaseEmissive = overrideBaseEmissiveNode == null
    ? true
    : parseBoolean(substituteParameters(overrideBaseEmissiveNode.textContent ?? '', params))

  return {
    target,
    property: 'emissive',
    expression,
    overrideBaseEmissive,
    sourcePath
  }
}

function isDisabledEmissiveDrivenVisibility(
  params: ReadonlyMap<string, string>,
  source: string
): boolean {
  if (!source.includes('0 >')) return false

  const drivesVisibility = params.get('EMISSIVE_DRIVES_VISIBILITY')
  if (drivesVisibility != null && !parseBoolean(drivesVisibility)) {
    return true
  }

  for (let index = 1; index <= 4; index += 1) {
    const sequenceDrivesVisibility = params.get(`SEQ${index}_EMISSIVE_DRIVES_VISIBILITY`)
    if (sequenceDrivesVisibility != null && !parseBoolean(sequenceDrivesVisibility)) {
      return true
    }
  }

  return false
}

function hasAnimationTarget(params: ReadonlyMap<string, string>): boolean {
  return Boolean(params.get('ANIM_NAME')?.trim())
}

function hasAnimationSimSource(params: ReadonlyMap<string, string>): boolean {
  return Boolean(params.get('ANIM_SIMVAR')?.trim())
}

function buildInteractionCodeBinding(
  sourceCode: string,
  releaseSourceCode: string | null,
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  kind: CompiledInteractionBinding['kind'],
  diagnostics: ImportDiagnostic[]
): CompiledInteractionBinding | null {
  const target =
    params.get('NODE_ID')?.trim() ||
    currentNode?.trim() ||
    params.get('ANIM_NAME')?.trim() ||
    params.get('PART_ID')?.trim() ||
    ''
  const source = substituteParameters(
    expandInteractionInputEventBridgeWrites(sourceCode, params),
    params
  ).trim()

  if (!target || !source) {
    return null
  }

  const expression = compileRpnExpression(source, {
    sourcePath,
    sourceExpression: source,
    diagnostics,
    localVariableScope: resolveLocalVariableScope(params, currentNode, target)
  })
  if (expression == null) {
    return null
  }

  const releaseSource = substituteParameters(
    expandInteractionInputEventBridgeWrites(releaseSourceCode ?? '', params),
    params
  ).trim()
  const releaseExpression = releaseSource
    ? compileRpnExpression(releaseSource, {
        sourcePath,
        sourceExpression: releaseSource,
        diagnostics,
        localVariableScope: resolveLocalVariableScope(params, currentNode, target)
      })
    : null
  if (releaseSource && releaseExpression == null) {
    return null
  }

  return {
    target,
    feedbackTargets: collectInteractionFeedbackTargets(params, currentNode, target),
    feedbackVariableKeys: collectInteractionFeedbackVariableKeys(params),
    soundEvents: collectInteractionSoundEvents(params),
    minHeldDurationSeconds: Math.max(parseNumber(params.get('MIN_HELD_DURATION'), 0), 0),
    animationDurationSeconds: parseOptionalPositiveNumber(params.get('ANIM_DURATION')),
    expression,
    releaseExpression,
    sourcePath,
    kind
  }
}

function collectInteractionSoundEvents(params: ReadonlyMap<string, string>): readonly CompiledInteractionSoundEvent[] {
  const events: CompiledInteractionSoundEvent[] = []
  const addEvent = (
    parameterName: string,
    phase: CompiledInteractionSoundEvent['phase'],
    normalizedTimeParameterName: string | null
  ): void => {
    const rawName = params.get(parameterName)?.trim() ?? ''
    const name = substituteParameters(rawName, params).trim()
    if (isNoopInteractionParameter(name) || name.includes('#')) {
      return
    }
    const normalizedTime =
      normalizedTimeParameterName == null
        ? null
        : parseOptionalPositiveNumber(
            substituteParameters(params.get(normalizedTimeParameterName) ?? '', params).trim()
          )
    events.push({
      name,
      phase,
      normalizedTime,
      sourceParameter: parameterName
    })
  }

  addEvent('WWISE_EVENT', 'press', 'NORMALIZED_TIME')
  addEvent('WWISE_EVENT_1', 'press', 'NORMALIZED_TIME_1')
  addEvent('WWISE_EVENT_2', 'release', 'NORMALIZED_TIME_2')
  return events
}

function buildInteractionEventBinding(
  eventId: string,
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  kind: CompiledInteractionBinding['kind'],
  diagnostics: ImportDiagnostic[]
): CompiledInteractionBinding | null {
  const normalizedEventId = normalizeKeyEventId(eventId)
  if (!normalizedEventId) {
    return null
  }
  return buildInteractionCodeBinding(
    `(>K:${normalizedEventId})`,
    null,
    params,
    currentNode,
    sourcePath,
    kind,
    diagnostics
  )
}

function getInteractionFallbackCodeSource(params: ReadonlyMap<string, string>): string {
  const directionalAxisSource = buildDirectionalAxisFallbackCodeSource(params)
  if (directionalAxisSource) {
    return directionalAxisSource
  }
  const directionalEventIdSource = buildDirectionalEventIdFallbackCodeSource(params)
  if (directionalEventIdSource) {
    return directionalEventIdSource
  }
  const toggleSimvarSource = buildInteractionToggleSimvarCodeSource(params)
  if (toggleSimvarSource) {
    return toggleSimvarSource
  }
  return getFirstUsableInteractionParameter(params, [
    'CLOCKWISE_CODE_DEFAULT_IM',
    'CLOCKWISE_CODE',
    'CLOCKWISE_CODE_DRAG_IM',
    'POSITIVE_AXIS_CODE_DEFAULT_IM',
    'POSITIVE_AXIS_CODE',
    'POSITIVE_AXIS_CODE_DRAG_IM',
    'WHEEL_UP_CODE',
    'JOYSTICK_X_CODE_RIGHT',
    'JOYSTICK_Y_CODE_UP',
    'CODE_RIGHT',
    'CODE_UP',
    'UP_CODE',
    'RIGHT_CODE_EXTERNAL',
    'UP_CODE_EXTERNAL',
    'ANTICLOCKWISE_CODE_DEFAULT_IM',
    'ANTICLOCKWISE_CODE',
    'ANTICLOCKWISE_CODE_DRAG_IM',
    'NEGATIVE_AXIS_CODE_DEFAULT_IM',
    'NEGATIVE_AXIS_CODE',
    'NEGATIVE_AXIS_CODE_DRAG_IM',
    'WHEEL_DOWN_CODE',
    'JOYSTICK_X_CODE_LEFT',
    'JOYSTICK_Y_CODE_DOWN',
    'CODE_LEFT',
    'CODE_DN',
    'DOWN_CODE',
    'LEFT_CODE_EXTERNAL',
    'DOWN_CODE_EXTERNAL',
    'JOYSTICK_LEFT_SINGLE_CODE',
    'JOYSTICK_RELEASE_CODE',
    'ON_EVENT',
    'ON_PUSH_EVENT',
    'ON_PULL_EVENT',
    'SET_STATE_EXTERNAL',
    'IE_INC_CODE',
    'IE_DEC_CODE',
    'IE_STANDBY_CODE',
    'LEFT_DOWN_CODE',
    'LEFT_UP_CODE'
  ]) || buildInteractionGateCodeSource(params) || buildInteractionSwitchPositionCodeSource(params)
}

function buildMouseEventInteractionCodeSource(params: ReadonlyMap<string, string>): string {
  const leftSingleSource =
    params.get('LEFT_SINGLE_CODE')?.trim() ||
    params.get('LEFT_SINGLE_CODE_DEFAULT_IM')?.trim() ||
    ''
  if (!leftSingleSource) {
    return ''
  }
  const entries: string[] = []
  const addEvent = (eventName: string, source: string): void => {
    const trimmedSource = source.trim()
    if (trimmedSource) {
      entries.push(`(M:Event) '${eventName}' scmi 0 == if{ ${trimmedSource} }`)
    }
  }
  addEvent('LeftSingle', leftSingleSource)
  addEvent('Lock', leftSingleSource)
  addEvent(
    'LeftRelease',
    params.get('LEFT_RELEASE_CODE')?.trim() ||
    params.get('LEFT_LEAVE_CODE')?.trim() ||
    params.get('LEFT_RELEASE_CODE_DEFAULT_IM')?.trim() ||
    params.get('LEFT_LEAVE_CODE_DEFAULT_IM')?.trim() ||
    ''
  )
  addEvent(
    'Unlock',
    params.get('LEFT_LEAVE_CODE')?.trim() ||
    params.get('LEFT_RELEASE_CODE')?.trim() ||
    params.get('LEFT_LEAVE_CODE_DEFAULT_IM')?.trim() ||
    params.get('LEFT_RELEASE_CODE_DEFAULT_IM')?.trim() ||
    ''
  )
  addEvent('WheelUp', params.get('WHEEL_UP_CODE')?.trim() ?? '')
  addEvent('WheelDown', params.get('WHEEL_DOWN_CODE')?.trim() ?? '')
  return entries.length > 2 ? entries.join(' els{ ') + ' }'.repeat(entries.length - 1) : ''
}

function buildInteractionToggleSimvarCodeSource(params: ReadonlyMap<string, string>): string {
  const toggleSimvar = substituteParameters(params.get('TOGGLE_SIMVAR') ?? '', params).trim()
  if (!toggleSimvar || isNoopInteractionParameter(toggleSimvar) || toggleSimvar.includes('#')) {
    return ''
  }
  return `(${toggleSimvar}, Bool) ! (> ${toggleSimvar})`.replace('(> ', '(>')
}

function buildDirectionalAxisFallbackCodeSource(params: ReadonlyMap<string, string>): string {
  const positiveSource = getFirstUsableInteractionParameter(params, [
    'POSITIVE_AXIS_CODE_DEFAULT_IM',
    'POSITIVE_AXIS_CODE',
    'POSITIVE_AXIS_CODE_DRAG_IM',
    'WHEEL_UP_CODE',
    'JOYSTICK_X_CODE_RIGHT',
    'JOYSTICK_Y_CODE_UP',
    'CODE_RIGHT',
    'CODE_UP',
    'UP_CODE',
    'RIGHT_CODE_EXTERNAL',
    'UP_CODE_EXTERNAL'
  ])
  const negativeSource = getFirstUsableInteractionParameter(params, [
    'NEGATIVE_AXIS_CODE_DEFAULT_IM',
    'NEGATIVE_AXIS_CODE',
    'NEGATIVE_AXIS_CODE_DRAG_IM',
    'WHEEL_DOWN_CODE',
    'JOYSTICK_X_CODE_LEFT',
    'JOYSTICK_Y_CODE_DOWN',
    'CODE_LEFT',
    'CODE_DN',
    'DOWN_CODE',
    'LEFT_CODE_EXTERNAL',
    'DOWN_CODE_EXTERNAL'
  ])
  if (!positiveSource || !negativeSource) {
    return ''
  }

  return `(M:Event) 'WheelDown' scmp 0 == if{ ${positiveSource} } els{ ${negativeSource} }`
}

function buildDirectionalEventIdFallbackCodeSource(params: ReadonlyMap<string, string>): string {
  const clockwiseEventId = normalizeKeyEventId(params.get('CLOCKWISE_EVENTID')?.trim() ?? '')
  const anticlockwiseEventId = normalizeKeyEventId(params.get('ANTICLOCKWISE_EVENTID')?.trim() ?? '')
  if (!clockwiseEventId || !anticlockwiseEventId) {
    return ''
  }

  return `(M:Event) 'WheelDown' scmp 0 == if{ (>K:${clockwiseEventId}) } els{ (>K:${anticlockwiseEventId}) }`
}

function getInteractionFallbackEventId(params: ReadonlyMap<string, string>): string {
  return getFirstUsableInteractionParameter(params, [
    'CLOCKWISE_EVENTID',
    'ANTICLOCKWISE_EVENTID',
    'DRAG_EVENTID_SET',
    'EVENTID_SET'
  ])
}

function getInteractionUseInputEventCodeSource(params: ReadonlyMap<string, string>): string {
  const directSource = getFirstUsableInteractionParameter(params, [
    'SET_STATE_EXTERNAL',
    'IE_INC_CODE',
    'IE_DEC_CODE',
    'IE_STANDBY_CODE',
    'ON_EVENT',
    'ON_PUSH_EVENT',
    'ON_PULL_EVENT'
  ])
  if (directSource) {
    return directSource
  }

  for (const [key, value] of params) {
    const normalizedKey = key.trim().toUpperCase()
    if (
      normalizedKey.startsWith('SET_STATE_')
    ) {
      const normalizedValue = value.trim()
      if (!isNoopInteractionParameter(normalizedValue) && !/^[A-Z][A-Z0-9_]*$/u.test(normalizedValue)) {
        return normalizedValue
      }
    }
  }

  return ''
}

function expandInteractionInputEventBridgeWrites(
  source: string,
  params: ReadonlyMap<string, string>
): string {
  if (!source.includes('>B:')) {
    return source
  }

  return source.replace(
    /\(>B:([A-Za-z0-9_.:-]+)(?:,\s*[^)]*)?\)/gu,
    (match, bridgeName: string) =>
      getInteractionInputEventBridgeCodeSource(bridgeName, params) || match
  )
}

function normalizeKeyEventId(eventId: string): string {
  return eventId.replace(/^\s*K:/iu, '').trim()
}

function getInteractionInputEventBridgeCodeSource(
  bridgeName: string,
  params: ReadonlyMap<string, string>
): string {
  const inputEventSource = getInteractionInputEventSource(params)
  const inputEventName =
    params.get('IE_NAME')?.trim() ||
    params.get('BTN_ID')?.trim() ||
    params.get('KNOB_ID')?.trim() ||
    params.get('LEVER_ID')?.trim() ||
    getInteractionInputEventNameFromPresetId(params) ||
    ''
  const bridgePrefix =
    inputEventSource && inputEventName ? `${inputEventSource}_${inputEventName}_` : ''
  const binding = findInteractionInputEventBinding(
    bridgePrefix && bridgeName.startsWith(bridgePrefix)
      ? bridgeName.slice(bridgePrefix.length)
      : bridgeName,
    params
  )
  if (binding == null) {
    if (bridgeName.endsWith('_Toggle')) {
      return buildGeneratedTwoStateInputEventToggleCodeSource(
        bridgeName.slice(0, -'_Toggle'.length),
        params
      )
    }
    const directBinding = getGeneratedDirectInputEventBridgeCodeSource(bridgeName, params)
    if (directBinding) {
      return directBinding
    }
    return ''
  }

  if (!binding.eventSource) {
    return ''
  }

  return [...binding.parameterSources, binding.eventSource].join(' ')
}

function collectInteractionInputEventBridgeBindings(
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): readonly CompiledInputEventBinding[] {
  const inputEventSource = getInteractionInputEventSource(params)
  const inputEventName =
    params.get('IE_NAME')?.trim() ||
    params.get('BTN_ID')?.trim() ||
    params.get('KNOB_ID')?.trim() ||
    params.get('LEVER_ID')?.trim() ||
    getInteractionInputEventNameFromPresetId(params) ||
    ''
  if (!inputEventName) {
    return []
  }

  const bindings: CompiledInputEventBinding[] = []
  const presetNames = getInteractionInputEventPresetNames(inputEventSource, inputEventName)
  for (const kind of ['INC', 'DEC', 'SET'] as const) {
    for (const [key, value] of params) {
      const match = new RegExp(`^BINDING_${kind}_(\\d*)$`, 'iu').exec(key.trim())
      const bindingName = value.trim()
      if (match == null || isNoopInteractionParameter(bindingName)) {
        continue
      }

      const parameterSources = collectInteractionInputEventBindingParameterSources(
        kind,
        match[1],
        params
      )
      const eventSource = getInteractionInputEventBindingEventSource(
        kind,
        match[1],
        parameterSources,
        params
      )
      if (!eventSource) {
        continue
      }

      const source = substituteParameters(
        [...parameterSources, eventSource].join(' '),
        params
      ).trim()
      const expression = compileRpnExpression(source, {
        sourcePath,
        sourceExpression: source,
        diagnostics,
        localVariableScope: resolveLocalVariableScope(params, currentNode, inputEventName)
      })
      if (expression == null) {
        continue
      }

      for (const presetName of presetNames) {
        bindings.push({
          name: `${presetName}_${bindingName}`,
          expression,
          sourcePath
        })
      }
    }
  }

  for (const binding of collectGeneratedInputEventStateBindings(
    inputEventSource,
    inputEventName,
    params,
    currentNode,
    sourcePath,
    diagnostics
  )) {
    bindings.push(binding)
  }
  for (const binding of collectGeneratedDirectInputEventBindings(
    inputEventSource,
    inputEventName,
    params,
    currentNode,
    sourcePath,
    diagnostics
  )) {
    pushUniqueInputEventBinding(bindings, binding)
  }

  return bindings
}

function collectGeneratedDirectInputEventBindings(
  inputEventSource: string,
  inputEventName: string,
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): readonly CompiledInputEventBinding[] {
  const presetNames = getInteractionInputEventPresetNames(inputEventSource, inputEventName)
  const bindings: CompiledInputEventBinding[] = []
  for (const kind of ['INC', 'DEC', 'SET'] as const) {
    const source = getGeneratedDirectInputEventCodeSource(kind, params)
    if (!source) {
      continue
    }

    const expression = compileRpnExpression(source, {
      sourcePath,
      sourceExpression: source,
      diagnostics,
      localVariableScope: resolveLocalVariableScope(params, currentNode, inputEventName)
    })
    if (expression == null) {
      continue
    }

    const suffix = kind === 'INC' ? 'Inc' : kind === 'DEC' ? 'Dec' : 'Set'
    for (const presetName of presetNames) {
      bindings.push({
        name: `${presetName}_${suffix}`,
        expression,
        sourcePath
      })
    }
  }
  return bindings
}

function getGeneratedDirectInputEventBridgeCodeSource(
  bridgeName: string,
  params: ReadonlyMap<string, string>
): string {
  const suffixMatch = /_(Inc|Dec|Set)$/u.exec(bridgeName)
  if (suffixMatch == null) {
    return ''
  }

  const kind = suffixMatch[1] === 'Inc' ? 'INC' : suffixMatch[1] === 'Dec' ? 'DEC' : 'SET'
  return getGeneratedDirectInputEventCodeSource(kind, params)
}

function getGeneratedDirectInputEventCodeSource(
  kind: 'INC' | 'DEC' | 'SET',
  params: ReadonlyMap<string, string>
): string {
  const parameterNames =
    kind === 'INC'
      ? ['IE_INC_CODE', 'INC_CODE', 'INC_EVENT']
      : kind === 'DEC'
        ? ['IE_DEC_CODE', 'DEC_CODE', 'DEC_EVENT']
        : ['SET_CODE', 'SET_EVENT']
  const directSource = getFirstUsableInteractionParameter(params, parameterNames)
  if (directSource) {
    return directSource
  }
  if (kind === 'SET') {
    return getGeneratedSetStateInputEventSetCodeSource(params)
  }
  return getGeneratedSetStateInputEventStepCodeSource(kind, params)
}

function getGeneratedSetStateInputEventSetCodeSource(params: ReadonlyMap<string, string>): string {
  const setStateSource = params.get('SET_STATE_EXTERNAL')?.trim() ?? ''
  if (isNoopInteractionParameter(setStateSource)) {
    return ''
  }
  const source = rpnSourceReadsParameter(setStateSource, 0) ? setStateSource : `p0 ${setStateSource}`
  return [source, getGeneratedInputEventStateChangedSource(params)].join(' ')
}

function getGeneratedSetStateInputEventStepCodeSource(
  kind: 'INC' | 'DEC' | 'SET',
  params: ReadonlyMap<string, string>
): string {
  if (kind === 'SET') {
    return ''
  }

  const setStateSource = params.get('SET_STATE_EXTERNAL')?.trim() ?? ''
  if (isNoopInteractionParameter(setStateSource)) {
    return ''
  }

  const inputEventSource = getInteractionInputEventSource(params)
  const inputEventName =
    params.get('IE_NAME')?.trim() ||
    params.get('BTN_ID')?.trim() ||
    params.get('KNOB_ID')?.trim() ||
    params.get('LEVER_ID')?.trim() ||
    getInteractionInputEventNameFromPresetId(params) ||
    ''
  const presetName = inputEventSource ? `${inputEventSource}_${inputEventName}` : inputEventName
  if (!presetName) {
    return ''
  }

  const parameterSource = params.get(kind === 'INC' ? 'INC_PARAM_0' : 'DEC_PARAM_0')?.trim() || 'p0'
  const getStateSource = params.get('GET_STATE_EXTERNAL')?.trim() ?? ''
  const stateValueSource = getStateSource
    ? `${getStateSource} ${rpnSourcePopsToRegister(getStateSource, 0) ? 'l0' : ''}`.trim()
    : ''
  const setBridgeSource = `(>B:${presetName}_Set)`

  if (!stateValueSource) {
    return kind === 'INC'
      ? `${parameterSource} ${setBridgeSource}`
      : `${parameterSource} -1 * ${setBridgeSource}`
  }

  return kind === 'INC'
    ? `${stateValueSource} ${parameterSource} + ${setBridgeSource}`
    : `${stateValueSource} ${parameterSource} - ${setBridgeSource}`
}

function rpnSourcePopsToRegister(source: string, registerIndex: number): boolean {
  return new RegExp(`(^|\\s)sp${registerIndex}(\\s|$)`, 'iu').test(source)
}

function rpnSourceReadsParameter(source: string, parameterIndex: number): boolean {
  return new RegExp(`(^|\\s)p${parameterIndex}(\\s|$)`, 'iu').test(source)
}

function collectGeneratedInputEventStateBindings(
  inputEventSource: string,
  inputEventName: string,
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): readonly CompiledInputEventBinding[] {
  const bindings: CompiledInputEventBinding[] = []
  bindings.push(
    ...collectGeneratedMultiStateInputEventBindings(
      inputEventSource,
      inputEventName,
      params,
      currentNode,
      sourcePath,
      diagnostics
    )
  )

  const getStateExternal = params.get('GET_STATE_EXTERNAL')?.trim() ?? ''
  const setStateOff = params.get('SET_STATE_OFF')?.trim() || params.get('SET_STATE_0')?.trim() || ''
  const setStateOn = params.get('SET_STATE_ON')?.trim() || params.get('SET_STATE_1')?.trim() || ''
  if (!getStateExternal || !setStateOff || !setStateOn) {
    return bindings
  }

  const presetNames = getInteractionInputEventPresetNames(inputEventSource, inputEventName)
  for (const presetName of presetNames) {
    const source = buildGeneratedTwoStateInputEventToggleCodeSource(presetName, params)
    const expression = compileRpnExpression(source, {
      sourcePath,
      sourceExpression: source,
      diagnostics,
      localVariableScope: resolveLocalVariableScope(params, currentNode, inputEventName)
    })
    if (expression == null) {
      continue
    }
    bindings.push({
      name: `${presetName}_Toggle`,
      expression,
      sourcePath
    })
  }

  return bindings
}

function collectGeneratedMultiStateInputEventBindings(
  inputEventSource: string,
  inputEventName: string,
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): readonly CompiledInputEventBinding[] {
  const presetNames = getInteractionInputEventPresetNames(inputEventSource, inputEventName)
  const bindings: CompiledInputEventBinding[] = []
  for (const [key, labelValue] of params) {
    const match = /^STR_STATE_(\d+)$/iu.exec(key.trim())
    const stateLabel = normalizeGeneratedInputEventStateLabel(labelValue)
    if (match == null || stateLabel === '') {
      continue
    }

    const stateIndex = match[1]
    const setStateSource = params.get(`SET_STATE_${stateIndex}`)?.trim() ?? ''
    if (isNoopInteractionParameter(setStateSource)) {
      continue
    }

    for (const presetName of presetNames) {
      const source = [
        `${stateIndex} (>B:${presetName})`,
        setStateSource,
        getGeneratedInputEventStateChangedSource(params)
      ].join(' ')
      const expression = compileRpnExpression(source, {
        sourcePath,
        sourceExpression: source,
        diagnostics,
        localVariableScope: resolveLocalVariableScope(params, currentNode, inputEventName)
      })
      if (expression == null) {
        continue
      }
      bindings.push({
        name: `${presetName}_${stateLabel}`,
        expression,
        sourcePath
      })
    }
  }
  return bindings
}

function normalizeGeneratedInputEventStateLabel(value: string): string {
  return value.trim()
    .replace(/\s+/gu, '_')
    .replace(/[^A-Za-z0-9_]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
}

function buildGeneratedTwoStateInputEventToggleCodeSource(
  presetName: string,
  params: ReadonlyMap<string, string>
): string {
  const getStateExternal = params.get('GET_STATE_EXTERNAL')?.trim() ?? ''
  const setStateOff = params.get('SET_STATE_OFF')?.trim() || params.get('SET_STATE_0')?.trim() || ''
  const setStateOn = params.get('SET_STATE_ON')?.trim() || params.get('SET_STATE_1')?.trim() || ''
  if (!presetName || !getStateExternal || !setStateOff || !setStateOn) {
    return ''
  }

  const simStateIsOn = params.get('SIM_STATE_IS_ON_EXTERNAL')?.trim() || 'l0'
  return [
    `0 1 ${getStateExternal} ${simStateIsOn} ? s0`,
    `l0 (>B:${presetName})`,
    `l0 if{ ${setStateOn} } els{ ${setStateOff} }`,
    getGeneratedInputEventStateChangedSource(params)
  ].join(' ')
}

function getGeneratedInputEventStateChangedSource(params: ReadonlyMap<string, string>): string {
  const source = params.get('ON_STATE_CHANGED_EXTERNAL_CODE')?.trim() ?? ''
  return isNoopInteractionParameter(source) ? '' : source
}

function getInteractionInputEventPresetNames(
  inputEventSource: string,
  inputEventName: string
): readonly string[] {
  const names = new Set<string>()
  if (inputEventSource) {
    names.add(`${inputEventSource}_${inputEventName}`)
  }
  names.add(inputEventName)
  names.add(`_${inputEventName}`)
  return [...names]
}

function getInteractionInputEventNameFromPresetId(params: ReadonlyMap<string, string>): string {
  const inputEventSource = getInteractionInputEventSource(params)
  const presetId = params.get('IE_PRESET_ID')?.trim() ?? ''
  if (!inputEventSource || !presetId.startsWith(`${inputEventSource}_`)) {
    return ''
  }

  return presetId.slice(inputEventSource.length + 1)
}

function getInteractionInputEventSource(params: ReadonlyMap<string, string>): string {
  return (
    params.get('INPUT_EVENT_ID_SOURCE')?.trim() ||
    params.get('INPUT_EVENT_ID')?.trim() ||
    ''
  )
}

function findInteractionInputEventBinding(
  bindingName: string,
  params: ReadonlyMap<string, string>
): {
  readonly kind: 'INC' | 'DEC' | 'SET'
  readonly parameterSources: readonly string[]
  readonly eventSource: string
} | null {
  const normalizedBindingName = bindingName.trim().toLowerCase()
  for (const kind of ['INC', 'DEC', 'SET'] as const) {
    for (const [key, value] of params) {
      const match = new RegExp(`^BINDING_${kind}_(\\d*)$`, 'iu').exec(key.trim())
      const normalizedValue = value.trim().toLowerCase()
      if (
        match == null ||
        (
          normalizedValue !== normalizedBindingName &&
          !normalizedBindingName.endsWith(`_${normalizedValue}`)
        )
      ) {
        continue
      }

      const parameterSources = collectInteractionInputEventBindingParameterSources(
        kind,
        match[1],
        params
      )
      return {
        kind,
        parameterSources,
        eventSource: getInteractionInputEventBindingEventSource(
          kind,
          match[1],
          parameterSources,
          params
        )
      }
    }
  }

  return null
}

function collectInteractionInputEventBindingParameterSources(
  kind: 'INC' | 'DEC' | 'SET',
  bindingIndex: string,
  params: ReadonlyMap<string, string>
): readonly string[] {
  const parameterSources: string[] = []
  const eventIdOnly = parseBoolean(params.get(`BINDING_${kind}_${bindingIndex}_EVENT_ID_ONLY`)?.trim() ?? '')
  for (let parameterIndex = 0; parameterIndex < 16; parameterIndex += 1) {
    const parameterName = `BINDING_${kind}_${bindingIndex}_PARAM_${parameterIndex}`
    const parameterValue = params.get(parameterName)?.trim()
    if (parameterValue == null || parameterValue === '') {
      if (parameterIndex === 0 && !eventIdOnly) {
        parameterSources.push('1')
      }
      break
    }

    const isDynamic = parseBoolean(params.get(`${parameterName}_IS_DYNAMIC`)?.trim() ?? '')
    parameterSources.push(isDynamic ? parameterValue : formatStaticRpnParameter(parameterValue))
  }
  return parameterSources
}

function formatStaticRpnParameter(value: string): string {
  const trimmed = value.trim()
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(trimmed)) {
    return trimmed
  }
  return `'${trimmed.replace(/'/gu, "\\'")}'`
}

function getInteractionInputEventBindingEventSource(
  kind: 'INC' | 'DEC' | 'SET',
  bindingIndex: string,
  parameterSources: readonly string[],
  params: ReadonlyMap<string, string>
): string {
  const explicitEventId = params.get(`BINDING_${kind}_${bindingIndex}_EVENT_ID`)?.trim() ?? ''
  if (explicitEventId) {
    const normalizedEventId = normalizeKeyEventId(explicitEventId)
    return parameterSources.length > 1
      ? `(>K:${parameterSources.length}:${normalizedEventId})`
      : `(>K:${normalizedEventId})`
  }

  switch (kind) {
    case 'INC':
      return getFirstUsableInteractionParameter(params, [
        'IE_INC_CODE',
        'INC_CODE',
        'INC_EVENT',
        'SET_STATE_EXTERNAL'
      ])
    case 'DEC':
      return getFirstUsableInteractionParameter(params, [
        'IE_DEC_CODE',
        'DEC_CODE',
        'DEC_EVENT',
        'SET_STATE_EXTERNAL'
      ])
    case 'SET':
      return getFirstUsableInteractionParameter(params, [
        'SET_CODE',
        'SET_EVENT',
        'SET_STATE_EXTERNAL'
      ])
  }
}

function buildInteractionGateCodeSource(params: ReadonlyMap<string, string>): string {
  const eventIdSet =
    params.get('EVENTID_SET')?.trim() ||
    params.get('DRAG_EVENTID_SET')?.trim() ||
    ''
  if (eventIdSet) {
    const normalizedEventIdSet = normalizeKeyEventId(eventIdSet)
    const simvar =
      params.get('SIMVAR')?.trim() ||
      params.get('DRAG_SIMVAR')?.trim() ||
      ''
    const simvarUnits =
      params.get('SIMVAR_UNITS')?.trim() ||
      params.get('DRAG_SIMVAR_UNITS')?.trim() ||
      'number'
    const increment =
      params.get('INCREMENT')?.trim() ||
      params.get('DRAG_SPEED')?.trim() ||
      params.get('DRAG_DELTA')?.trim() ||
      '1'
    const eventConversion = params.get('EVENTID_CONVERSION')?.trim() ?? ''
    if (simvar) {
      return `(A:${simvar}, ${simvarUnits}) ${increment} + ${eventConversion} (>K:${normalizedEventIdSet})`
    }
    return `1 (>K:${normalizedEventIdSet})`
  }

  const positionType = params.get('POSITION_TYPE')?.trim() || 'O'
  const positionVar = params.get('POSITION_VAR')?.trim() ?? ''
  if (!positionVar) {
    return ''
  }
  const stepsNumber = params.get('STEPS_NUMBER')?.trim() || '100'
  const dragSpeed = params.get('DRAG_SPEED')?.trim() || '1'
  return `(${positionType}:${positionVar}) ${dragSpeed} + ${stepsNumber} min (>${positionType}:${positionVar})`
}

function buildInteractionSwitchPositionCodeSource(params: ReadonlyMap<string, string>): string {
  const positionType = params.get('SWITCH_POSITION_TYPE')?.trim() || 'O'
  const positionVar = params.get('SWITCH_POSITION_VAR')?.trim() ?? ''
  if (!positionVar) {
    return ''
  }

  const stateCount = getInteractionSwitchStateCount(params)
  if (stateCount < 2) {
    return ''
  }

  const nextStateWrite = `(${positionType}:${positionVar}) 1 + ${stateCount} % s0 l0 (>${positionType}:${positionVar})`
  const positionCodes = Array.from({ length: stateCount }, (_value, index) => {
    const code = params.get(`CODE_POS_${index}`)?.trim() ?? ''
    return code ? `l0 ${index} == if{ ${code} }` : ''
  }).filter(Boolean)

  return [nextStateWrite, ...positionCodes].join(' ')
}

function getInteractionSwitchStateCount(params: ReadonlyMap<string, string>): number {
  const explicitStateCount = parseInteger(
    substituteParameters(params.get('NUM_STATES') ?? params.get('KNOB_NUM_STATE') ?? '', params).trim(),
    0
  )
  if (explicitStateCount >= 2) {
    return explicitStateCount
  }

  let highestCodePosition = -1
  for (const key of params.keys()) {
    const match = /^CODE_POS_(\d+)$/iu.exec(key.trim())
    if (match == null) continue
    highestCodePosition = Math.max(highestCodePosition, parseInteger(match[1], -1))
  }

  return highestCodePosition + 1
}

function getFirstUsableInteractionParameter(
  params: ReadonlyMap<string, string>,
  names: readonly string[]
): string {
  for (const name of names) {
    const value = params.get(name)?.trim() ?? ''
    if (!isNoopInteractionParameter(value)) {
      return value
    }
  }
  return ''
}

function isNoopInteractionParameter(value: string): boolean {
  const normalized = value.trim()
  return normalized === '' || normalized === '0' || normalized.toLowerCase() === 'false'
}

function collectInteractionFeedbackTargets(
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  target: string
): readonly string[] {
  const targets = new Set<string>()
  const addTarget = (candidate: string): void => {
    const trimmed = candidate.trim()
    if (isUsableInteractionFeedbackTarget(trimmed)) {
      targets.add(trimmed)
    }
  }
  const addPartIdTarget = (candidate: string): void => {
    const trimmed = candidate.trim()
    if (!trimmed) {
      return
    }
    addTarget(trimmed)
    const id = params.get('ID')?.trim() ?? ''
    if (id && !parseBoolean(params.get('NO_ID_IN_PARTID'))) {
      addTarget(`${trimmed}${id}`)
    }
  }
  for (const candidate of [
    target,
    params.get('ANIM_NAME')?.trim() ?? '',
    currentNode?.trim() ?? '',
    params.get('NODE_ID')?.trim() ?? '',
    params.get('HIGHLIGHT_NODE_ID')?.trim() ?? '',
    params.get('DRAG_NODE_ID')?.trim() ?? '',
    params.get('HITBOX_UP_NODE_ID')?.trim() ?? '',
    params.get('HITBOX_DOWN_NODE_ID')?.trim() ?? ''
  ]) {
    addTarget(candidate)
  }
  addPartIdTarget(params.get('PART_ID')?.trim() ?? '')
  addPartIdTarget(params.get('OTHER_PART_ID')?.trim() ?? '')
  for (const [key, value] of params) {
    if (isInteractionTargetParameterName(key)) {
      addTarget(value)
    }
  }
  return [...targets]
}

function collectInteractionFeedbackVariableKeys(
  params: ReadonlyMap<string, string>
): readonly string[] {
  const type = params.get('SWITCH_POSITION_TYPE')?.trim() ?? ''
  const variable = params.get('SWITCH_POSITION_VAR')?.trim() ?? ''
  if (
    !type ||
    !variable ||
    type.includes('#') ||
    variable.includes('#') ||
    type.toUpperCase() === 'O'
  ) {
    return []
  }
  return [`${type}:${variable}`]
}

function isUsableInteractionFeedbackTarget(value: string): boolean {
  const normalized = value.trim()
  if (!normalized || normalized.includes('#')) {
    return false
  }
  const upper = normalized.toUpperCase()
  return upper !== 'TRUE' && upper !== 'FALSE' && upper !== '0' && upper !== '1' && upper !== '__NO_HIGHLIGHT__'
}

function isInteractionTargetParameterName(key: string): boolean {
  const normalized = key.trim().toUpperCase()
  if (normalized.startsWith('NO_') || normalized.startsWith('DISABLE_')) {
    return false
  }
  return (
    normalized === 'NODE_ID' ||
    normalized === 'ANIM_NAME' ||
    normalized === 'HIGHLIGHT_NODE_ID' ||
    normalized === 'DRAG_NODE_ID' ||
    normalized.endsWith('_NODE_ID') ||
    normalized.startsWith('NODE_ID_') ||
    normalized.endsWith('_ANIM_NAME') ||
    normalized.startsWith('ANIM_NAME_')
  )
}

function resolveLocalVariableScope(
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  target: string | null
): string | null {
  return (
    params.get('NODE_ID')?.trim() ||
    currentNode?.trim() ||
    target?.trim() ||
    null
  )
}

function pushUniqueInteractionBinding(
  bindings: CompiledInteractionBinding[],
  binding: CompiledInteractionBinding
): void {
  const duplicate = bindings.some(candidate =>
    candidate.target === binding.target &&
    candidate.kind === binding.kind &&
    candidate.expression.source === binding.expression.source &&
    candidate.releaseExpression?.source === binding.releaseExpression?.source
  )
  if (!duplicate) {
    bindings.push(binding)
  }
}

function pushUniqueInteractionBlocker(
  blockers: CompiledInteractionBlocker[],
  blocker: CompiledInteractionBlocker
): void {
  const duplicate = blockers.some(candidate =>
    candidate.target === blocker.target &&
    candidate.sourcePath === blocker.sourcePath
  )
  if (!duplicate) {
    blockers.push(blocker)
  }
}

function pushUniqueInputEventBinding(
  bindings: CompiledInputEventBinding[],
  binding: CompiledInputEventBinding
): void {
  const duplicate = bindings.some(candidate =>
    candidate.name === binding.name &&
    candidate.expression.source === binding.expression.source
  )
  if (!duplicate) {
    bindings.push(binding)
  }
}

function pushUniqueMaterialBinding(
  bindings: CompiledMaterialBinding[],
  binding: CompiledMaterialBinding
): void {
  const duplicate = bindings.some(candidate =>
    candidate.target === binding.target &&
    candidate.property === binding.property &&
    candidate.expression.source === binding.expression.source
  )
  if (!duplicate) {
    bindings.push(binding)
  }
}

function buildAnimationSimBinding(
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): CompiledAnimationBinding | null {
  const animName = params.get('ANIM_NAME')?.trim()
  const simVar = params.get('ANIM_SIMVAR')?.trim()
  if (!animName || !simVar) {
    diagnostics.push({
      code: 'animation_params_missing',
      message: 'Animation sim template expansion did not produce ANIM_NAME and ANIM_SIMVAR.',
      severity: 'warning',
      sourcePath
    })
    return null
  }

  const units = params.get('ANIM_SIMVAR_UNITS')?.trim() || 'percent'
  const scale = params.get('ANIM_SIMVAR_SCALE')?.trim() || '1'
  const bias = params.get('ANIM_SIMVAR_BIAS')?.trim() || '0'
  const lag = params.get('ANIM_LAG')?.trim() || '0'

  return buildAnimationBinding(
    new Map([
      ['ANIM_NAME', animName],
      ['ANIM_CODE', `(A:${simVar}, ${units}) ${scale} * ${bias} +`],
      ['ANIM_LENGTH', params.get('ANIM_LENGTH')?.trim() || '100'],
      ['ANIM_WRAP', params.get('ANIM_WRAP')?.trim() || '0'],
      ['ANIM_DELTA', params.get('ANIM_DELTA')?.trim() || '0'],
      ['ANIM_LAG', lag]
    ]),
    currentNode,
    sourcePath,
    diagnostics
  )
}

function collectImmediateParameters(
  element: Element,
  inheritedParams: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): Map<string, string> {
  const params = new Map<string, string>()
  collectParameterEntries(
    Array.from(element.children),
    inheritedParams,
    params,
    sourcePath,
    diagnostics,
    undefined,
    true
  )
  return params
}

function applyLoopDoParameterBlocks(
  doNode: Element,
  loopScopedParams: ReadonlyMap<string, string>,
  iterationParams: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): Map<string, string> {
  const nextParams = new Map<string, string>(loopScopedParams)
  for (const [key, value] of iterationParams) {
    nextParams.set(key, value)
  }

  for (const child of Array.from(doNode.children)) {
    const kind = getParameterBlockKind(child)
    if (kind == null) {
      continue
    }

    const values = collectParameterBlock(child, nextParams, sourcePath, diagnostics, kind)
    for (const [key, value] of values) {
      if (kind === 'default') {
        if (!nextParams.has(key)) {
          nextParams.set(key, value)
        }
      } else {
        nextParams.set(key, value)
      }
    }
  }

  return nextParams
}

function applyScopedParameters(
  element: Element,
  state: TraversalState
): TraversalState {
  const scopedParams = new Map<string, string>(state.params)
  applyParameterBlocks(element, 'default', scopedParams, state.path, [])
  applyParameterBlocks(element, 'override', scopedParams, state.path, [])

  if (scopedParams.size === state.params.size) {
    let changed = false
    for (const [key, value] of scopedParams) {
      if (state.params.get(key) !== value) {
        changed = true
        break
      }
    }
    if (!changed) {
      return state
    }
  }

  return {
    ...state,
    params: scopedParams
  }
}

function collectParameterBlock(
  blockNode: Element,
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[],
  kind?: ParameterBlockKind
): Map<string, string> {
  const values = new Map<string, string>()
  collectParameterEntries(
    Array.from(blockNode.children),
    params,
    values,
    sourcePath,
    diagnostics,
    kind === 'default' ? new Set(params.keys()) : undefined
  )
  return values
}

function selectConditionBranch(
  conditionNode: Element,
  params: ReadonlyMap<string, string>
): Element | null {
  const notEmpty = getAttributeValue(conditionNode, 'NotEmpty')
  if (notEmpty) {
    const value = resolveNotEmptyValue(notEmpty, params)
    return value ? conditionNode.querySelector(':scope > True') : conditionNode.querySelector(':scope > False')
  }

  const empty = getAttributeValue(conditionNode, 'Empty')
  if (empty) {
    const value = resolveNotEmptyValue(empty, params)
    return value ? conditionNode.querySelector(':scope > False') : conditionNode.querySelector(':scope > True')
  }

  const valid = getAttributeValue(conditionNode, 'Valid')
  if (valid) {
    return isTruthyParameterReference(valid, params)
      ? conditionNode.querySelector(':scope > True')
      : conditionNode.querySelector(':scope > False')
  }

  const check = getAttributeValue(conditionNode, 'Check')
  if (check) {
    const value = resolveParameterReference(check, params)
    const match = getAttributeValue(conditionNode, 'Match')
    const matches = match == null
      ? isTruthyParameterReference(check, params)
      : value === substituteParameters(match, params).trim()
    return matches ? conditionNode.querySelector(':scope > True') : conditionNode.querySelector(':scope > False')
  }

  const testNode = conditionNode.querySelector(':scope > Test')
  if (testNode != null) {
    return evaluateTestElement(testNode, params)
      ? conditionNode.querySelector(':scope > True')
      : conditionNode.querySelector(':scope > False')
  }

  return conditionNode.querySelector(':scope > True')
}

function selectSwitchBranch(
  switchNode: Element,
  params: ReadonlyMap<string, string>
): Element | null {
  const switchParam = getAttributeValue(switchNode, 'Param')
  const switchValue =
    switchParam == null ? '' : resolveParameterReference(switchParam, params)

  for (const child of Array.from(switchNode.children)) {
    if (getElementTagName(child) !== 'Case') {
      continue
    }

    const value = getAttributeValue(child, 'Value')
    if (value != null) {
      if (switchValue === substituteParameters(value, params).trim()) {
        return child
      }
      continue
    }

    const valid = getAttributeValue(child, 'Valid')
    if (valid != null && isTruthyParameterReference(valid, params)) {
      return child
    }

    const check = getAttributeValue(child, 'Check')
    if (check != null) {
      const resolvedValue = resolveParameterReference(check, params)
      const match = getAttributeValue(child, 'Match')
      const matches = match == null
        ? isTruthyParameterReference(check, params)
        : resolvedValue === substituteParameters(match, params).trim()
      if (matches) {
        return child
      }
    }

    const notEmpty = getAttributeValue(child, 'NotEmpty')
    if (notEmpty != null && resolveNotEmptyValue(notEmpty, params)) {
      return child
    }
  }

  return switchNode.querySelector(':scope > Default')
}

function substituteParameters(
  value: string,
  params: ReadonlyMap<string, string>
): string {
  let currentValue = value

  for (let index = 0; index < 8; index += 1) {
    const parameterExpanded = currentValue.replace(/#([A-Za-z0-9_:.]+)#/gu, (_match, key) => {
      return params.get(key) ?? ''
    })
    const nextValue = parameterExpanded.replace(/@([A-Za-z0-9_]+)/gu, (match, key) => {
      return params.get(`@${key}`) ?? match
    })
    if (nextValue === currentValue) break
    currentValue = nextValue
  }

  return currentValue
}

function createTemplateTraceKey(
  templateName: string,
  params: ReadonlyMap<string, string>
): string {
  const stableParams = [...params.entries()]
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')

  return `${templateName}?${stableParams}`
}

function applyParameterBlocks(
  templateNode: Element,
  kind: ParameterBlockKind,
  targetParams: Map<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): void {
  for (const block of Array.from(templateNode.children)) {
    if (getParameterBlockKind(block) !== kind) {
      continue
    }

    const values = collectParameterBlock(block, targetParams, sourcePath, diagnostics, kind)
    for (const [key, value] of values) {
      if (kind === 'default') {
        if (!targetParams.has(key)) {
          targetParams.set(key, value)
        }
      } else {
        targetParams.set(key, value)
      }
    }
  }
}

function getParameterBlockKind(element: Element): ParameterBlockKind | null {
  const tagName = getElementTagName(element)
  if (tagName === 'DefaultTemplateParameters') {
    return 'default'
  }
  if (tagName === 'OverrideTemplateParameters') {
    return 'override'
  }
  if (tagName !== 'Parameters') {
    return null
  }

  const type = (getAttributeValue(element, 'Type') ?? '').trim().toLowerCase()
  if (type === 'default') {
    return 'default'
  }
  if (type === 'override') {
    return 'override'
  }

  return null
}

function collectParameterEntries(
  children: readonly Element[],
  params: ReadonlyMap<string, string>,
  values: Map<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[],
  defaultExistingKeys?: ReadonlySet<string>,
  promoteValuelessMarkers = false
): void {
  const scopedParams = new Map<string, string>(params)
  for (const [key, value] of values) {
    scopedParams.set(key, value)
  }

  for (const child of children) {
    if (getParameterBlockKind(child) != null) {
      continue
    }

    const childTagName = getElementTagName(child)

    if (childTagName === 'Condition') {
      const branch = selectConditionBranch(child, scopedParams)
      if (branch != null) {
        collectParameterEntries(
          Array.from(branch.children),
          scopedParams,
          values,
          sourcePath,
          diagnostics,
          defaultExistingKeys,
          promoteValuelessMarkers
        )
        for (const [key, value] of values) {
          scopedParams.set(key, value)
        }
      }
      continue
    }

    if (childTagName === 'Switch') {
      const branch = selectSwitchBranch(child, scopedParams)
      if (branch != null) {
        collectParameterEntries(
          Array.from(branch.children),
          scopedParams,
          values,
          sourcePath,
          diagnostics,
          defaultExistingKeys,
          promoteValuelessMarkers
        )
        for (const [key, value] of values) {
          scopedParams.set(key, value)
        }
      }
      continue
    }

    if (childTagName === 'UseParametersFn') {
      const returnedValues = executeParameterFunction(
        child,
        scopedParams,
        sourcePath,
        diagnostics
      )
      for (const [key, value] of returnedValues) {
        values.set(key, value)
        scopedParams.set(key, value)
      }
      continue
    }

    if (
      childTagName === 'UseTemplate' ||
      childTagName === 'Template' ||
      childTagName === 'Include' ||
      childTagName === 'Component' ||
      childTagName === 'Update'
    ) {
      continue
    }

    if (childTagName === 'Loop') {
      executeLoop(
        child,
        scopedParams,
        sourcePath,
        diagnostics,
        iterationParams => {
          const doNode = getDirectChild(child, 'Do')
          if (doNode == null) {
            return
          }

          collectParameterEntries(
            Array.from(doNode.children),
            iterationParams,
            values,
            sourcePath,
            diagnostics,
            defaultExistingKeys,
            promoteValuelessMarkers
          )
          for (const [key, value] of values) {
            scopedParams.set(key, value)
          }
        }
      )
      continue
    }

    const key = substituteParameters(getElementTagName(child), scopedParams).trim()
    if (!key) {
      continue
    }
    if (defaultExistingKeys?.has(key) === true && !values.has(key)) {
      continue
    }

    const value = resolveProcessedParameterValue(child, scopedParams, sourcePath, diagnostics, params)
    if (promoteValuelessMarkers && !value && isValuelessMarkerParameterName(key)) {
      values.set(key, 'True')
      scopedParams.set(key, 'True')
      continue
    }
    values.set(key, value)
    scopedParams.set(key, value)
  }
}

function isValuelessMarkerParameterName(key: string): boolean {
  const normalized = key.trim().toUpperCase()
  if (!normalized) {
    return false
  }
  return !/(?:^|_)(?:CODE|ID|NAME|VAR|SIMVAR|EVENT|FREQUENCY|DURATION|LENGTH|TIME|VALUE|STATE|SOURCE|TARGET|INDEX|TYPE|TITLE|TOOLTIP|POTENTIOMETER|CONDITION|EXPRESSION)$/u.test(normalized)
}

function resolveProcessedParameterValue(
  node: Element,
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[],
  inheritedParams?: ReadonlyMap<string, string>
): string {
  const substituted = substituteParameters(node.textContent ?? '', params).trim()
  const process = (getAttributeValue(node, 'Process') ?? '').trim().toLowerCase()
  if (!process) {
    return substituted
  }

  if (process === 'param') {
    if (params.has(substituted)) {
      return params.get(substituted) ?? ''
    }
    if (inheritedParams != null) {
      const inheritedKey = substituteParameters(node.textContent ?? '', inheritedParams).trim()
      if (inheritedKey && params.has(inheritedKey)) {
        return params.get(inheritedKey) ?? ''
      }
    }
    return ''
  }

  if (process === 'int' || process === 'float') {
    const expression = compileRpnExpression(substituted, { sourcePath, sourceExpression: substituted, diagnostics })
    if (expression == null) {
      return substituted
    }

    const value = evaluateCompiledExpression(expression, {
      readVariable: () => 0
    })
    if (!Number.isFinite(value)) {
      return substituted
    }

    return process === 'int' ? String(Math.trunc(value)) : String(value)
  }

  return substituted
}

function buildUpdateNodeBinding(
  updateNode: Element,
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): CompiledUpdateBinding | null {
  const source = substituteParameters(updateNode.textContent ?? '', params).trim()
  if (!source) {
    diagnostics.push({
      code: 'update_params_missing',
      message: 'Update element did not produce UPDATE_CODE.',
      severity: 'warning',
      sourcePath
    })
    return null
  }

  const expression = compileRpnExpression(source, {
    sourcePath,
    sourceExpression: source,
    diagnostics,
    localVariableScope: resolveLocalVariableScope(params, currentNode, null)
  })
  if (expression == null) {
    return null
  }

  const frequency = parseNumber(
    substituteParameters(getAttributeValue(updateNode, 'Frequency') ?? '1', params).trim(),
    1
  )
  const once = parseBoolean(
    substituteParameters(getAttributeValue(updateNode, 'Once') ?? '0', params).trim()
  )

  return {
    expression,
    sourcePath,
    frequency: Math.max(frequency, 0),
    once
  }
}

function buildAnimationNodeBinding(
  animationNode: Element,
  params: ReadonlyMap<string, string>,
  currentNode: string | null,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): CompiledAnimationBinding | null {
  const target = substituteParameters(
    getAttributeValue(animationNode, 'Name') ?? '',
    params
  ).trim()

  if (!target) {
    diagnostics.push({
      code: 'animation_params_missing',
      message: 'Animation node did not produce a target name.',
      severity: 'warning',
      sourcePath
    })
    return null
  }

  const length = parseNumber(
    substituteParameters(getAttributeValue(animationNode, 'Length') ?? '100', params).trim(),
    100
  )
  const parameterNode = getDirectChild(animationNode, 'Parameter')
  if (parameterNode == null) {
    diagnostics.push({
      code: 'animation_params_missing',
      message: `Animation node ${target} did not include a Parameter block.`,
      severity: 'warning',
      sourcePath
    })
    return null
  }

  const wrap = parseBoolean(
    substituteParameters(getDirectChild(parameterNode, 'Wrap')?.textContent ?? '0', params).trim()
  )
  const delta = parseBoolean(
    substituteParameters(getDirectChild(parameterNode, 'Delta')?.textContent ?? '0', params).trim()
  )

  const codeNode = getDirectChild(parameterNode, 'Code')
  if (codeNode != null) {
    const source = substituteParameters(codeNode.textContent ?? '', params).trim()
    if (!source) {
      diagnostics.push({
        code: 'animation_params_missing',
        message: `Animation node ${target} did not produce animation code.`,
        severity: 'warning',
        sourcePath
      })
      return null
    }

    const expression = compileRpnExpression(source, {
      sourcePath,
      sourceExpression: source,
      diagnostics,
      localVariableScope: resolveLocalVariableScope(params, currentNode, target)
    })
    if (expression == null) {
      return null
    }

    return {
      target,
      expression,
      length,
      wrap,
      delta,
      lagFramesPerSecond: Math.max(
        parseNumber(substituteParameters(getDirectChild(parameterNode, 'Lag')?.textContent ?? '0', params).trim(), 0),
        0
      ),
      sourcePath
    }
  }

  const simNode = getDirectChild(parameterNode, 'Sim')
  if (simNode != null) {
    const variable = substituteParameters(getDirectChild(simNode, 'Variable')?.textContent ?? '', params).trim()
    if (!variable) {
      diagnostics.push({
        code: 'animation_params_missing',
        message: `Animation node ${target} did not produce a sim variable.`,
        severity: 'warning',
        sourcePath
      })
      return null
    }

    const units = substituteParameters(getDirectChild(simNode, 'Units')?.textContent ?? 'percent', params).trim() || 'percent'
    const scale = substituteParameters(getDirectChild(simNode, 'Scale')?.textContent ?? '1', params).trim() || '1'
    const bias = substituteParameters(getDirectChild(simNode, 'Bias')?.textContent ?? '0', params).trim() || '0'
    const source = `(A:${variable}, ${units}) ${scale} * ${bias} +`
    const expression = compileRpnExpression(source, {
      sourcePath,
      sourceExpression: source,
      diagnostics,
      localVariableScope: resolveLocalVariableScope(params, currentNode, target)
    })
    if (expression == null) {
      return null
    }

    return {
      target,
      expression,
      length,
      wrap,
      delta,
      lagFramesPerSecond: Math.max(
        parseNumber(substituteParameters(getDirectChild(parameterNode, 'Lag')?.textContent ?? '0', params).trim(), 0),
        0
      ),
      sourcePath
    }
  }

  diagnostics.push({
    code: 'animation_params_missing',
    message: `Animation node ${target} did not include a Code or Sim parameter source.`,
    severity: 'warning',
    sourcePath
  })
  return null
}

function buildAnimationTriggerBindings(
  animationTriggersNode: Element,
  params: ReadonlyMap<string, string>,
  sourcePath: string
): readonly CompiledAnimationTriggerBinding[] {
  const animation = substituteParameters(
    getAttributeValue(animationTriggersNode, 'Animation') ?? '',
    params
  ).trim()
  if (!animation) {
    return []
  }

  const bindings: CompiledAnimationTriggerBinding[] = []
  for (const eventTriggerNode of Array.from(animationTriggersNode.children)) {
    if (getElementTagName(eventTriggerNode) !== 'EventTrigger') {
      continue
    }

    const direction = parseAnimationTriggerDirection(
      substituteParameters(getAttributeValue(eventTriggerNode, 'Direction') ?? 'Both', params)
    )
    const normalizedTime = parseAnimationTriggerNormalizedTime(
      substituteParameters(getAttributeValue(eventTriggerNode, 'NormalizedTime') ?? '', params)
    )
    const count = parseAnimationTriggerCount(
      substituteParameters(getAttributeValue(eventTriggerNode, 'Count') ?? '', params)
    )

    for (const eventNode of Array.from(eventTriggerNode.children)) {
      const eventKind = getElementTagName(eventNode)
      if (eventKind === 'SoundEvent') {
        const eventName = substituteParameters(
          getAttributeValue(eventNode, 'WwiseEvent') ?? '',
          params
        ).trim()
        if (!eventName || eventName.includes('#')) {
          continue
        }
        bindings.push({
          animation,
          eventName,
          eventKind: 'sound',
          action: substituteParameters(getAttributeValue(eventNode, 'Action') ?? 'Play', params).trim() || 'Play',
          direction,
          normalizedTime,
          count,
          sourcePath
        })
      } else if (eventKind === 'EffectEvent') {
        const eventName = substituteParameters(
          getAttributeValue(eventNode, 'Name') ?? '',
          params
        ).trim()
        if (!eventName || eventName.includes('#')) {
          continue
        }
        bindings.push({
          animation,
          eventName,
          eventKind: 'effect',
          action: substituteParameters(getAttributeValue(eventNode, 'Action') ?? 'Play', params).trim() || 'Play',
          direction,
          normalizedTime,
          count,
          sourcePath
        })
      }
    }
  }

  return bindings
}

function parseAnimationTriggerDirection(value: string): CompiledAnimationTriggerBinding['direction'] {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'forward') return 'forward'
  if (normalized === 'backward') return 'backward'
  return 'both'
}

function parseAnimationTriggerNormalizedTime(value: string): number | null {
  if (!value.trim()) {
    return null
  }
  const parsedValue = Number.parseFloat(value)
  if (!Number.isFinite(parsedValue)) {
    return null
  }
  return Math.min(Math.max(parsedValue, 0), 1)
}

function parseAnimationTriggerCount(value: string): number | null {
  if (!value.trim()) {
    return null
  }
  const parsedValue = Number.parseInt(value, 10)
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : null
}

function resolveParameterReference(
  expression: string,
  params: ReadonlyMap<string, string>
): string {
  const substituted = substituteParameters(expression, params).trim()
  return substituted ? (params.get(substituted) ?? '') : ''
}

function isTruthyParameterReference(
  expression: string,
  params: ReadonlyMap<string, string>
): boolean {
  return isTruthyConditionValue(resolveParameterReference(expression, params))
}

function isTruthyConditionValue(value: string): boolean {
  const normalizedValue = value.trim().toLowerCase()
  if (!normalizedValue) {
    return false
  }

  return normalizedValue !== '0' && normalizedValue !== 'false'
}

function resolveNotEmptyValue(
  expression: string,
  params: ReadonlyMap<string, string>
): string {
  const substituted = substituteParameters(expression, params).trim()
  if (!substituted) {
    return ''
  }
  if (params.has(substituted)) {
    return params.get(substituted) ?? ''
  }

  const tokenMatches = [...expression.matchAll(/#([A-Za-z0-9_:.]+)#/gu)]
  const literalRemainder = expression.replace(/#([A-Za-z0-9_:.]+)#/gu, '')
  const isPureTokenConcatenation = tokenMatches.length > 1 && literalRemainder.length === 0
  if (isPureTokenConcatenation) {
    return substituted
  }

  const isDynamicParameterReference = /^[A-Za-z0-9_:.#]+$/u.test(expression) && !/\s/u.test(expression)
  return isDynamicParameterReference ? '' : substituted
}

function evaluateTestElement(
  testNode: Element,
  params: ReadonlyMap<string, string>
): boolean {
  const child = Array.from(testNode.children).find(node => node instanceof Element) ?? null
  if (child == null || !(child instanceof Element)) {
    return false
  }
  return evaluateTestOperator(child, params)
}

function evaluateTestOperator(
  node: Element,
  params: ReadonlyMap<string, string>
): boolean {
  switch (getElementTagName(node)) {
    case 'Lower': {
      const [left, right] = Array.from(node.children)
      return resolveTestNumericValue(left, params) < resolveTestNumericValue(right, params)
    }
    case 'Greater': {
      const [left, right] = Array.from(node.children)
      return resolveTestNumericValue(left, params) > resolveTestNumericValue(right, params)
    }
    case 'Equal': {
      const [left, right] = Array.from(node.children)
      return resolveTestStringValue(left, params) === resolveTestStringValue(right, params)
    }
    case 'Different': {
      const [left, right] = Array.from(node.children)
      return resolveTestStringValue(left, params) !== resolveTestStringValue(right, params)
    }
    case 'And':
      return Array.from(node.children).every(child => evaluateTestOperator(child, params))
    case 'Or':
      return Array.from(node.children).some(child => evaluateTestOperator(child, params))
    case 'Not': {
      const child = Array.from(node.children).find(element => element instanceof Element) ?? null
      return child instanceof Element ? !evaluateTestOperator(child, params) : false
    }
    case 'Arg': {
      const notEmpty = getAttributeValue(node, 'NotEmpty')
      if (notEmpty != null) {
        return resolveNotEmptyValue(notEmpty, params).length > 0
      }
      const empty = getAttributeValue(node, 'Empty')
      if (empty != null) {
        return resolveNotEmptyValue(empty, params).length === 0
      }
      const valid = getAttributeValue(node, 'Valid')
      if (valid != null) {
        return isTruthyParameterReference(valid, params)
      }
      const check = getAttributeValue(node, 'Check')
      if (check != null) {
        const value = resolveParameterReference(check, params)
        const match = getAttributeValue(node, 'Match')
        return match == null
          ? isTruthyParameterReference(check, params)
          : value === substituteParameters(match, params).trim()
      }
      return false
    }
    default:
      return false
  }
}

function resolveTestNumericValue(
  node: Element | undefined,
  params: ReadonlyMap<string, string>
): number {
  if (node == null) {
    return 0
  }

  if (getElementTagName(node) === 'Number') {
    return parseNumber(substituteParameters(node.textContent ?? '', params).trim(), 0)
  }

  return parseNumber(resolveTestStringValue(node, params), 0)
}

function resolveTestStringValue(
  node: Element | undefined,
  params: ReadonlyMap<string, string>
): string {
  if (node == null) {
    return ''
  }

  const substituted = substituteParameters(node.textContent ?? '', params).trim()
  if (getElementTagName(node) === 'Value') {
    return params.get(substituted) ?? substituted
  }

  return substituted
}

function getDirectChild(parent: Element, tagName: string): Element | null {
  return (
    Array.from(parent.children).find(child => getElementTagName(child) === tagName) ?? null
  )
}

function getDirectChildText(parent: Element, tagName: string): string {
  return getDirectChild(parent, tagName)?.textContent?.trim() ?? ''
}

function executeLoop(
  loopNode: Element,
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[],
  callback: (iterationParams: Map<string, string>) => void
): void {
  const setupNode = getDirectChild(loopNode, 'Setup')
  const paramName = substituteParameters(getDirectChild(setupNode ?? loopNode, 'Param')?.textContent ?? '', params).trim()
  if (!paramName) {
    diagnostics.push({
      code: 'loop_setup_missing',
      message: 'Loop is missing a Setup/Param definition.',
      severity: 'warning',
      sourcePath
    })
    return
  }

  const fromNode = getDirectChild(setupNode ?? loopNode, 'From')
  const incNode = getDirectChild(setupNode ?? loopNode, 'Inc')
  const toNode = getDirectChild(setupNode ?? loopNode, 'To')
  const whileNode = getDirectChild(setupNode ?? loopNode, 'While')
  const from = parseInteger(
    fromNode == null ? '0' : resolveProcessedParameterValue(fromNode, params, sourcePath, diagnostics),
    0
  )
  const inc = parseInteger(
    incNode == null ? '1' : resolveProcessedParameterValue(incNode, params, sourcePath, diagnostics),
    1
  )
  const to = toNode == null
    ? null
    : parseInteger(resolveProcessedParameterValue(toNode, params, sourcePath, diagnostics), from)

  if (inc === 0) {
    diagnostics.push({
      code: 'loop_increment_invalid',
      message: 'Loop increment cannot be zero.',
      severity: 'warning',
      sourcePath
    })
    return
  }

  let current = from
  for (let iteration = 0; iteration < 4096; iteration += 1) {
    const iterationParams = new Map<string, string>(params)
    iterationParams.set(paramName, String(current))

    const withinBounds = to == null ? true : inc > 0 ? current <= to : current >= to
    const whileMatches = whileNode == null ? true : Array.from(whileNode.children).every(child =>
      evaluateTestOperator(child, iterationParams)
    )
    if (!withinBounds || !whileMatches) {
      return
    }

    callback(iterationParams)
    current += inc
  }

  diagnostics.push({
    code: 'loop_iteration_limit',
    message: 'Loop iteration limit was reached while expanding stock behavior XML.',
    severity: 'warning',
    sourcePath
  })
}

function executeParameterFunction(
  useFunctionNode: Element,
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): Map<string, string> {
  const functionName = substituteParameters(
    getAttributeValue(useFunctionNode, 'Name') ?? '',
    params
  ).trim()
  if (!functionName) {
    return new Map()
  }

  const functionNode = activeParameterFunctionMap.get(functionName.toUpperCase())
  if (functionNode == null) {
    diagnostics.push({
      code: 'parameter_function_missing',
      message: `ParametersFn ${functionName} is not available in the mounted stock behavior set.`,
      severity: 'warning',
      sourcePath
    })
    return new Map()
  }

  const functionParams = new Map<string, string>(params)
  applyParameterBlocks(functionNode, 'default', functionParams, sourcePath, diagnostics)
  const callParams = collectImmediateParameters(
    useFunctionNode,
    functionParams,
    sourcePath,
    diagnostics
  )
  for (const [key, value] of callParams) {
    functionParams.set(key, value)
  }
  applyParameterBlocks(functionNode, 'override', functionParams, sourcePath, diagnostics)

  const returnedValues = new Map<string, string>()
  const returnNode = getDirectChild(functionNode, 'ReturnParameters')
  if (returnNode == null) {
    return returnedValues
  }

  collectParameterEntries(
    Array.from(returnNode.children),
    functionParams,
    returnedValues,
    sourcePath,
    diagnostics
  )
  return returnedValues
}

function preprocessBehaviorXml(source: string): string {
  return source
    .replace(
      /<\s*([A-Za-z_#][^>\s/]*#[^>\s/]*)((?:\s[^>]*?)?)\/>/gu,
      (_match, tagName: string, attributes: string) =>
        `<MSFSDynamicTag msfsTagName="${tagName.trim()}"${attributes}/>`
    )
    .replace(
      /<\s*([A-Za-z_#][^>\s/]*#[^>\s/]*)((?:\s[^>]*?)?)>/gu,
      (_match, tagName: string, attributes: string) =>
        `<MSFSDynamicTag msfsTagName="${tagName.trim()}"${attributes}>`
    )
    .replace(/<\/\s*([A-Za-z_#][^>\s/]*#[^>\s/]*)\s*>/gu, '</MSFSDynamicTag>')
}

function getElementTagName(element: Element): string {
  return element.getAttribute('msfsTagName') ?? element.tagName
}

function getAttributeValue(element: Element, name: string): string | null {
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.toLowerCase() === name.toLowerCase()) {
      return attribute.value
    }
  }
  return null
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false
  const normalizedValue = value.trim().toLowerCase()
  return normalizedValue === '1' || normalizedValue === 'true'
}

function parseNumber(value: string | undefined, fallbackValue: number): number {
  const parsedValue = Number.parseFloat(value ?? '')
  return Number.isFinite(parsedValue) ? parsedValue : fallbackValue
}

function parseOptionalPositiveNumber(value: string | undefined): number | null {
  const parsedValue = Number.parseFloat(value ?? '')
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : null
}

function parseInteger(value: string | undefined, fallbackValue: number): number {
  const parsedValue = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsedValue) ? parsedValue : fallbackValue
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
