import { compileRpnExpression, evaluateCompiledExpression } from './rpn'
import type {
  CompiledAnimationBinding,
  CompiledBehaviorSet,
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

type ParameterBlockKind = 'default' | 'override'

const ANIMATION_TEMPLATE_NAMES = new Set(['ASOBO_GT_ANIM_CODE'])
const NOOP_TEMPLATE_NAMES = new Set([
  'ASOBO_DOOR_INTERACTIVEPOINT_TEMPLATE',
  'ASOBO_GT_ANIMTRIGGERS_2SOUNDEVENTS'
])
const VISIBILITY_TEMPLATE_NAMES = new Set([
  'ASOBO_GT_VISIBILITY',
  'ASOBO_GT_VISIBILITY_CODE'
])
const BUILTIN_PREFERRED_TEMPLATE_NAMES = new Set([
  'ASOBO_GT_HELPER_RECURSIVE_ID',
  'ASOBO_HANDLING_LEFTRIGHTANIM_TEMPLATE',
  'ASOBO_HANDLING_TRIM_BASE_TEMPLATE',
  'ASOBO_HANDLING_AILERON_TEMPLATE',
  'ASOBO_HANDLING_RUDDER_TEMPLATE',
  'ASOBO_HANDLING_ELEVATOR_TEMPLATE',
  'ASOBO_HANDLING_SLATS_TEMPLATE',
  'ASOBO_HANDLING_FLAPS_TEMPLATE'
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
      updateBindings: [],
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
  const updateBindings: CompiledUpdateBinding[] = []
  for (const loadedDocument of loadedDocuments.values()) {
    collectTemplates(loadedDocument.document, templateMap)
  }

  const rootDocument = sourceRoots.length > 0
    ? loadedDocuments.get(`${sourceRoots[0]!.rootUrl}::${normalizePath(aircraft.model.behaviorPath)}`)
    : null
  if (rootDocument != null) {
    traverseElement(
      rootDocument.rootElement,
      {
        path: rootDocument.path,
        params: new Map<string, string>(),
        currentNode: null
      },
      context,
      animationBindings,
      visibilityBindings,
      updateBindings
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
  for (const binding of updateBindings) {
    for (const key of binding.expression.variableKeys) {
      variableKeys.add(key)
    }
  }

  return {
    irVersion: 'msfs-behavior/v1',
    aircraftId: aircraft.id,
    animationBindings,
    visibilityBindings,
    updateBindings,
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
  const parsedDocument = parseBehaviorDocument(text)
  if (parsedDocument == null) {
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
    document: parsedDocument.document,
    rootElement: parsedDocument.rootElement
  })

  for (const includeNode of parsedDocument.rootElement.querySelectorAll('Include')) {
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
  updateBindings: CompiledUpdateBinding[]
): void {
  if (element.tagName === 'Template') {
    return
  }

  if (element.tagName === 'Include') {
    return
  }

  const scopedState = applyScopedParameters(element, state)

  if (element.tagName === 'Condition') {
    const branch = selectConditionBranch(element, scopedState.params)
    if (branch != null) {
      for (const child of Array.from(branch.children)) {
        traverseElement(child, scopedState, context, animationBindings, visibilityBindings, updateBindings)
      }
    }
    return
  }

  if (element.tagName === 'Switch') {
    const branch = selectSwitchBranch(element, scopedState.params)
    if (branch != null) {
      for (const child of Array.from(branch.children)) {
        traverseElement(child, scopedState, context, animationBindings, visibilityBindings, updateBindings)
      }
    }
    return
  }

  if (element.tagName === 'Component') {
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
      traverseElement(child, nextState, context, animationBindings, visibilityBindings, updateBindings)
    }
    return
  }

  if (element.tagName === 'Update') {
    const updateBinding = buildUpdateNodeBinding(element, scopedState.params, state.path, context.diagnostics)
    if (updateBinding != null) {
      updateBindings.push(updateBinding)
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
      updateBindings
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
    traverseElement(child, scopedState, context, animationBindings, visibilityBindings, updateBindings)
  }
}

function expandTemplateUse(
  useTemplateNode: Element,
  state: TraversalState,
  context: CompileContext,
  animationBindings: CompiledAnimationBinding[],
  visibilityBindings: CompiledVisibilityBinding[],
  updateBindings: CompiledUpdateBinding[]
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
  if (normalizedTemplateName === 'ASOBO_GT_ANIM') {
    const animationBinding =
      mergedParams.get('ANIM_CODE')?.trim()
        ? buildAnimationBinding(
            mergedParams,
            state.path,
            context.diagnostics
          )
        : buildAnimationSimBinding(
            mergedParams,
            state.path,
            context.diagnostics
          )
    if (animationBinding != null) {
      animationBindings.push(animationBinding)
    }
    return
  }

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

  if (
    BUILTIN_PREFERRED_TEMPLATE_NAMES.has(normalizedTemplateName) &&
    handleBuiltInTemplate(
      normalizedTemplateName,
      templateName,
      mergedParams,
      state,
      context,
      animationBindings,
      visibilityBindings,
      updateBindings
    )
  ) {
    return
  }

  const templateNode = context.templateMap.get(normalizedTemplateName)
  if (templateNode == null) {
    if (
      handleBuiltInTemplate(
        normalizedTemplateName,
        templateName,
        mergedParams,
        state,
        context,
        animationBindings,
        visibilityBindings,
        updateBindings
      )
    ) {
      return
    }

    context.diagnostics.push({
      code: 'template_missing',
      message: `Template ${templateName} is not available in the imported package.`,
      severity: 'warning',
      sourcePath: state.path
    })
    return
  }

  const templateParams = new Map<string, string>(state.params)
  applyParameterBlocks(templateNode, 'default', templateParams, state.path, context.diagnostics)
  for (const [key, value] of childParams) {
    templateParams.set(key, value)
  }
  applyParameterBlocks(templateNode, 'override', templateParams, state.path, context.diagnostics)

  const nextState: TraversalState = {
    ...state,
    params: templateParams
  }

  for (const child of Array.from(templateNode.children)) {
    if (
      getElementTagName(child) === 'DefaultTemplateParameters' ||
      getElementTagName(child) === 'OverrideTemplateParameters'
    ) {
      continue
    }
    traverseElement(child, nextState, context, animationBindings, visibilityBindings, updateBindings)
  }
}

function handleBuiltInTemplate(
  normalizedTemplateName: string,
  templateName: string,
  params: Map<string, string>,
  state: TraversalState,
  context: CompileContext,
  animationBindings: CompiledAnimationBinding[],
  visibilityBindings: CompiledVisibilityBinding[],
  updateBindings: CompiledUpdateBinding[]
): boolean {
  switch (normalizedTemplateName) {
    case 'ASOBO_GT_ANIM_SIM': {
      const animationBinding = buildAnimationSimBinding(params, state.path, context.diagnostics)
      if (animationBinding != null) {
        animationBindings.push(animationBinding)
      }
      return true
    }
    case 'ASOBO_GT_UPDATE': {
      const updateBinding = buildUpdateBinding(params, state.path, context.diagnostics)
      if (updateBinding != null) {
        updateBindings.push(updateBinding)
      }
      return true
    }
    case 'ASOBO_GT_HELPER_RECURSIVE_ID':
      expandRecursiveTemplateIds(
        params,
        state,
        context,
        animationBindings,
        visibilityBindings,
        updateBindings
      )
      return true
    case 'ASOBO_FUELHOSE_INTERACTIVEPOINT_TEMPLATE': {
      const visibilityBinding = buildFuelHoseVisibilityBinding(params, state.path, context.diagnostics)
      if (visibilityBinding != null) {
        visibilityBindings.push(visibilityBinding)
      }
      return true
    }
    case 'ASOBO_HANDLING_LEFTRIGHTANIM_TEMPLATE':
      expandHandlingLeftRightTemplate(params, state.path, context.diagnostics, animationBindings)
      return true
    case 'ASOBO_HANDLING_TRIM_BASE_TEMPLATE':
      expandHandlingTrimBaseTemplate(params, state.path, context.diagnostics, animationBindings)
      return true
    case 'ASOBO_HANDLING_AILERON_TEMPLATE':
      expandHandlingTrimBaseTemplate(
        withFallbackParams(params, [
          ['USE_DIFFERENT_ANIM_FOR_L_R', 'True'],
          ['ANIM_SIMVAR_LEFT', 'AILERON LEFT DEFLECTION PCT'],
          ['ANIM_SIMVAR_RIGHT', 'AILERON RIGHT DEFLECTION PCT'],
          ['ANIM_SIMVAR_TRIM', 'AILERON TRIM PCT'],
        ]),
        state.path,
        context.diagnostics,
        animationBindings
      )
      return true
    case 'ASOBO_HANDLING_RUDDER_TEMPLATE':
      expandHandlingTrimBaseTemplate(
        withFallbackParams(params, [
          ['ANIM_NAME', 'HANDLING_Rudder'],
          ['ANIM_SIMVAR', 'RUDDER DEFLECTION PCT'],
          ['ANIM_SIMVAR_TRIM', 'RUDDER TRIM PCT'],
        ]),
        state.path,
        context.diagnostics,
        animationBindings
      )
      return true
    case 'ASOBO_HANDLING_ELEVATOR_TEMPLATE':
      if ((params.get('TYPE') ?? '').trim() === 'AS04F' || (params.get('TYPE') ?? '').trim() === 'AS05P') {
        expandHandlingSeparatedElevatorTemplate(params, state.path, context.diagnostics, animationBindings)
        return true
      }
      expandHandlingTrimBaseTemplate(
        withFallbackParams(params, [
          ['ANIM_NAME', 'HANDLING_Elevator'],
          ['ANIM_SIMVAR', 'ELEVATOR DEFLECTION PCT'],
          ['ANIM_SIMVAR_TRIM', 'ELEVATOR TRIM PCT'],
        ]),
        state.path,
        context.diagnostics,
        animationBindings
      )
      return true
    case 'ASOBO_HANDLING_SLATS_TEMPLATE':
      expandHandlingTrimBaseTemplate(
        withFallbackParams(params, [
          ['USE_DIFFERENT_ANIM_FOR_L_R', 'True'],
          ['USE_INTEGRATED_TRIM', 'False'],
          ['TRIM_ONLY', 'False'],
          ['ANIM_SIMVAR_LEFT', 'LEADING EDGE FLAPS LEFT PERCENT'],
          ['ANIM_SIMVAR_RIGHT', 'LEADING EDGE FLAPS RIGHT PERCENT'],
        ]),
        state.path,
        context.diagnostics,
        animationBindings
      )
      return true
    case 'ASOBO_HANDLING_FLAPS_TEMPLATE': {
      const expandedParams = withFallbackParams(params, [
        ['USE_DIFFERENT_ANIM_FOR_L_R', 'True'],
        ['USE_INTEGRATED_TRIM', 'False'],
        ['TRIM_ONLY', 'False'],
        ['MIN_FLAPS_VALUE', '0'],
        ['MAX_FLAPS_VALUE', '0'],
        ['ANIM_LENGTH', '100'],
        ['ANIM_SIMVAR_LEFT', 'TRAILING EDGE FLAPS LEFT PERCENT'],
        ['ANIM_SIMVAR_RIGHT', 'TRAILING EDGE FLAPS RIGHT PERCENT'],
      ])

      const minFlapsValue = parseNumber(expandedParams.get('MIN_FLAPS_VALUE'), 0)
      const maxFlapsValue = parseNumber(expandedParams.get('MAX_FLAPS_VALUE'), 0)
      if (minFlapsValue < 0 && maxFlapsValue !== 0) {
        expandedParams.set(
          'ANIM_SIMVAR_SCALE',
          String(1 / (1 + Math.abs(minFlapsValue) / maxFlapsValue))
        )
      } else if (!expandedParams.has('ANIM_SIMVAR_SCALE')) {
        expandedParams.set('ANIM_SIMVAR_SCALE', '1')
      }

      const scale = parseNumber(expandedParams.get('ANIM_SIMVAR_SCALE'), 1)
      const animLength = parseNumber(expandedParams.get('ANIM_LENGTH'), 100)
      if (scale < 1) {
        expandedParams.set('ANIM_SIMVAR_BIAS', String((1 - scale) * animLength))
      }

      expandHandlingTrimBaseTemplate(expandedParams, state.path, context.diagnostics, animationBindings)
      return true
    }
    default:
      return false
  }
}

function expandHandlingSeparatedElevatorTemplate(
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[],
  animationBindings: CompiledAnimationBinding[]
): void {
  const expandedParams = withFallbackParams(params, [
    ['ANIM_NAME', 'HANDLING_Elevator'],
    ['ANIM_SIMVAR_SCALE', '0.5'],
    ['ANIM_SIMVAR_BIAS', '50'],
    ['AILERON_DEFLECTION_SCALE', '0.2'],
    ['ANIM_LENGTH', '100']
  ])
  const type = (expandedParams.get('TYPE') ?? '').trim()
  const leftMultiplier = type === 'AS04F' ? '-1 *' : ''
  const rightMultiplier = type === 'AS05P' ? '-1 *' : ''
  const leftParams = withOverrideParams(expandedParams, [
    ['ANIM_NAME', expandedParams.get('ANIM_NAME_LEFT') ?? `${expandedParams.get('ANIM_NAME') ?? 'HANDLING_Elevator'}_L`],
    ['ANIM_CODE', `(A:ELEVATOR DEFLECTION PCT, Percent) ${expandedParams.get('ANIM_SIMVAR_SCALE') ?? '0.5'} * ${expandedParams.get('ANIM_SIMVAR_BIAS') ?? '50'} + (A:AILERON LEFT DEFLECTION PCT, Percent) ${leftMultiplier} ${expandedParams.get('AILERON_DEFLECTION_SCALE') ?? '0.2'} * + 0 max ${expandedParams.get('ANIM_LENGTH') ?? '100'} min`]
  ])
  const rightParams = withOverrideParams(expandedParams, [
    ['ANIM_NAME', expandedParams.get('ANIM_NAME_RIGHT') ?? `${expandedParams.get('ANIM_NAME') ?? 'HANDLING_Elevator'}_R`],
    ['ANIM_CODE', `(A:ELEVATOR DEFLECTION PCT, Percent) ${expandedParams.get('ANIM_SIMVAR_SCALE') ?? '0.5'} * ${expandedParams.get('ANIM_SIMVAR_BIAS') ?? '50'} + (A:AILERON RIGHT DEFLECTION PCT, Percent) ${rightMultiplier} ${expandedParams.get('AILERON_DEFLECTION_SCALE') ?? '0.2'} * + 0 max ${expandedParams.get('ANIM_LENGTH') ?? '100'} min`]
  ])

  for (const sideParams of [leftParams, rightParams]) {
    const binding = buildAnimationBinding(sideParams, sourcePath, diagnostics)
    if (binding != null) {
      animationBindings.push(binding)
    }
  }
}

function expandRecursiveTemplateIds(
  params: ReadonlyMap<string, string>,
  state: TraversalState,
  context: CompileContext,
  animationBindings: CompiledAnimationBinding[],
  visibilityBindings: CompiledVisibilityBinding[],
  updateBindings: CompiledUpdateBinding[]
): void {
  const exitTemplate = params.get('EXIT_TEMPLATE')?.trim()
  if (!exitTemplate) {
    context.diagnostics.push({
      code: 'template_params_missing',
      message: 'ASOBO_GT_Helper_Recursive_ID requires EXIT_TEMPLATE.',
      severity: 'warning',
      sourcePath: state.path
    })
    return
  }

  const firstId = parseInteger(params.get('FIRST_ID'), 1)
  const maxId = parseInteger(params.get('MAX_ID'), 0)
  if (!Number.isFinite(maxId) || maxId < firstId) {
    return
  }

  for (let currentId = firstId; currentId <= maxId; currentId += 1) {
    const iterationParams = new Map<string, string>(params)
    iterationParams.set('CURRENT_ID', String(currentId))
    iterationParams.set('RECURSIVE_ID', String(currentId))

    for (let paramIndex = 1; paramIndex <= 256; paramIndex += 1) {
      const targetParam = params.get(`PARAM${paramIndex}`)?.trim()
      if (!targetParam) {
        if (
          params.get(`PARAM${paramIndex}_PREFIX`) == null &&
          params.get(`PARAM${paramIndex}_SUFFIX`) == null &&
          params.get(`PROCESS_PARAM${paramIndex}`) == null
        ) {
          break
        }
        continue
      }

      const generatedValue = [
        params.get(`PARAM${paramIndex}_PREFIX`) ?? '',
        String(currentId),
        params.get(`PARAM${paramIndex}_SUFFIX`) ?? '',
      ].join('')

      const shouldProcess = parseBoolean(params.get(`PROCESS_PARAM${paramIndex}`))
      iterationParams.set(
        targetParam,
        shouldProcess ? (params.get(generatedValue) ?? '') : generatedValue
      )
    }

    handleBuiltInTemplate(
      exitTemplate.toUpperCase(),
      exitTemplate,
      iterationParams,
      {
        ...state,
        params: iterationParams
      },
      context,
      animationBindings,
      visibilityBindings,
      updateBindings
    ) || expandReferencedTemplate(
      exitTemplate,
      iterationParams,
      state,
      context,
      animationBindings,
      visibilityBindings,
      updateBindings
    )
  }
}

function expandReferencedTemplate(
  templateName: string,
  params: Map<string, string>,
  state: TraversalState,
  context: CompileContext,
  animationBindings: CompiledAnimationBinding[],
  visibilityBindings: CompiledVisibilityBinding[],
  updateBindings: CompiledUpdateBinding[]
): boolean {
  const templateNode = context.templateMap.get(templateName.toUpperCase())
  if (templateNode == null) {
    return false
  }

  const nextState: TraversalState = {
    ...state,
    params
  }
  for (const child of Array.from(templateNode.children)) {
    if (
      getElementTagName(child) === 'DefaultTemplateParameters' ||
      getElementTagName(child) === 'OverrideTemplateParameters'
    ) {
      continue
    }
    traverseElement(child, nextState, context, animationBindings, visibilityBindings, updateBindings)
  }
  return true
}

function expandHandlingLeftRightTemplate(
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[],
  animationBindings: CompiledAnimationBinding[]
): void {
  const maxValue = params.get('MAX_VALUE')?.trim() ?? ''
  const minValue = params.get('MIN_VALUE')?.trim() || '0'
  const leftParams = new Map<string, string>(params)
  leftParams.set('ANIM_NAME', params.get('ANIM_NAME_LEFT') ?? '')
  leftParams.set('ANIM_SIMVAR', params.get('ANIM_SIMVAR_LEFT') ?? '')
  if (maxValue) {
    leftParams.set(
      'ANIM_CODE',
      `(A:${params.get('ANIM_SIMVAR_LEFT') ?? ''}, ${params.get('ANIM_SIMVAR_UNITS') ?? 'percent'}) ${minValue} - ${maxValue} ${minValue} - / 100 *`
    )
  } else if (params.get('ANIM_CODE_LEFT') != null) {
    leftParams.set('ANIM_CODE', params.get('ANIM_CODE_LEFT') ?? '')
  }

  const rightParams = new Map<string, string>(params)
  rightParams.set('ANIM_NAME', params.get('ANIM_NAME_RIGHT') ?? '')
  rightParams.set('ANIM_SIMVAR', params.get('ANIM_SIMVAR_RIGHT') ?? '')
  if (maxValue) {
    rightParams.set(
      'ANIM_CODE',
      `(A:${params.get('ANIM_SIMVAR_RIGHT') ?? ''}, ${params.get('ANIM_SIMVAR_UNITS') ?? 'percent'}) ${minValue} - ${maxValue} ${minValue} - / 100 *`
    )
  } else if (params.get('ANIM_CODE_RIGHT') != null) {
    rightParams.set('ANIM_CODE', params.get('ANIM_CODE_RIGHT') ?? '')
  }

  for (const sideParams of [leftParams, rightParams]) {
    const binding =
      sideParams.get('ANIM_CODE')?.trim()
        ? buildAnimationBinding(sideParams, sourcePath, diagnostics)
        : buildAnimationSimBinding(sideParams, sourcePath, diagnostics)
    if (binding != null) {
      animationBindings.push(binding)
    }
  }
}

function expandHandlingTrimBaseTemplate(
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[],
  animationBindings: CompiledAnimationBinding[]
): void {
  const normalizedParams = withFallbackParams(params, [
    ['DEFAULT_TRIM_IMPACT_ON_DEFLECTION', '0.25'],
    ['ANIM_SIMVAR_UNITS', 'percent']
  ])
  if (
    parseBoolean(normalizedParams.get('USE_DIFFERENT_ANIM_FOR_L_R')) &&
    !normalizedParams.has('ANIM_NAME_TRIM')
  ) {
    normalizedParams.set('ANIM_NAME_TRIM', normalizedParams.get('ANIM_NAME') ?? '')
  }

  const trimImpact = Math.min(
    1,
    Math.max(0, parseNumber(normalizedParams.get('DEFAULT_TRIM_IMPACT_ON_DEFLECTION'), 0.25))
  )
  const impactOfDeflection = 1 - trimImpact

  if (parseBoolean(normalizedParams.get('USE_INTEGRATED_TRIM'))) {
    if (parseBoolean(normalizedParams.get('USE_DIFFERENT_ANIM_FOR_L_R'))) {
      const leftParams = new Map<string, string>(normalizedParams)
      leftParams.set('ANIM_NAME', normalizedParams.get('ANIM_NAME_LEFT') ?? '')
      leftParams.set(
        'ANIM_CODE',
        `(A:${normalizedParams.get('ANIM_SIMVAR_TRIM') ?? ''}, percent) ${trimImpact} * (A:${normalizedParams.get('ANIM_SIMVAR_LEFT') ?? ''}, percent) ${impactOfDeflection} * + 0.5 * 50 +`
      )
      const rightParams = new Map<string, string>(normalizedParams)
      rightParams.set('ANIM_NAME', normalizedParams.get('ANIM_NAME_RIGHT') ?? '')
      rightParams.set(
        'ANIM_CODE',
        `(A:${normalizedParams.get('ANIM_SIMVAR_TRIM') ?? ''}, percent) ${trimImpact} * (A:${normalizedParams.get('ANIM_SIMVAR_RIGHT') ?? ''}, percent) ${impactOfDeflection} * + 0.5 * 50 +`
      )

      for (const sideParams of [leftParams, rightParams]) {
        const binding = buildAnimationBinding(sideParams, sourcePath, diagnostics)
        if (binding != null) {
          animationBindings.push(binding)
        }
      }
      return
    }

    const integratedParams = new Map<string, string>(normalizedParams)
    integratedParams.set(
      'ANIM_CODE',
      `(A:${normalizedParams.get('ANIM_SIMVAR_TRIM') ?? ''}, percent) ${trimImpact} * (A:${normalizedParams.get('ANIM_SIMVAR') ?? ''}, percent) ${impactOfDeflection} * + 0.5 * 50 +`
    )
    const binding = buildAnimationBinding(integratedParams, sourcePath, diagnostics)
    if (binding != null) {
      animationBindings.push(binding)
    }
    return
  }

  if (parseBoolean(normalizedParams.get('MERGED_TRIM'))) {
    const mergedParams = new Map<string, string>(normalizedParams)
    mergedParams.set(
      'ANIM_CODE',
      `(A:${normalizedParams.get('ANIM_SIMVAR_TRIM') ?? ''}, percent over 100) (A:${normalizedParams.get('ANIM_SIMVAR') ?? ''}, percent over 100) + 1 min -1 max 50 * 50 +`
    )
    const binding = buildAnimationBinding(mergedParams, sourcePath, diagnostics)
    if (binding != null) {
      animationBindings.push(binding)
    }
    return
  }

  if (parseBoolean(params.get('TRIM_ONLY'))) {
    const trimOnlyParams = new Map<string, string>(normalizedParams)
    trimOnlyParams.set('ANIM_NAME', normalizedParams.get('ANIM_NAME_TRIM') ?? normalizedParams.get('ANIM_NAME') ?? '')
    trimOnlyParams.set('ANIM_SIMVAR', normalizedParams.get('ANIM_SIMVAR_TRIM') ?? '')
    const binding = buildAnimationSimBinding(trimOnlyParams, sourcePath, diagnostics)
    if (binding != null) {
      animationBindings.push(binding)
    }
    return
  }

  if (parseBoolean(normalizedParams.get('USE_DIFFERENT_ANIM_FOR_L_R'))) {
    expandHandlingLeftRightTemplate(normalizedParams, sourcePath, diagnostics, animationBindings)
    return
  }

  const singleParams = new Map<string, string>(normalizedParams)
  if (!singleParams.has('ANIM_SIMVAR')) {
    singleParams.set('ANIM_SIMVAR', normalizedParams.get('ANIM_SIMVAR_LEFT') ?? '')
  }
  const binding = buildAnimationSimBinding(singleParams, sourcePath, diagnostics)
  if (binding != null) {
    animationBindings.push(binding)
  }
}

function withFallbackParams(
  params: ReadonlyMap<string, string>,
  fallbackEntries: readonly (readonly [string, string])[]
): Map<string, string> {
  const nextParams = new Map<string, string>(params)
  for (const [key, value] of fallbackEntries) {
    if (!nextParams.has(key)) {
      nextParams.set(key, value)
    }
  }
  return nextParams
}

function withOverrideParams(
  params: ReadonlyMap<string, string>,
  overrideEntries: readonly (readonly [string, string])[]
): Map<string, string> {
  const nextParams = new Map<string, string>(params)
  for (const [key, value] of overrideEntries) {
    nextParams.set(key, value)
  }
  return nextParams
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
    delta: parseBoolean(params.get('ANIM_DELTA')),
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

function buildAnimationSimBinding(
  params: ReadonlyMap<string, string>,
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

  return buildAnimationBinding(
    new Map([
      ['ANIM_NAME', animName],
      ['ANIM_CODE', `(A:${simVar}, ${units}) ${scale} * ${bias} +`],
      ['ANIM_LENGTH', params.get('ANIM_LENGTH')?.trim() || '100'],
      ['ANIM_WRAP', params.get('ANIM_WRAP')?.trim() || '0']
    ]),
    sourcePath,
    diagnostics
  )
}

function buildUpdateBinding(
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): CompiledUpdateBinding | null {
  const source = params.get('UPDATE_CODE')?.trim() ?? ''
  if (!source) {
    diagnostics.push({
      code: 'update_params_missing',
      message: 'Update template expansion did not produce UPDATE_CODE.',
      severity: 'warning',
      sourcePath
    })
    return null
  }

  const expression = compileRpnExpression(source, { sourcePath, diagnostics })
  if (expression == null) {
    return null
  }

  return {
    expression,
    sourcePath,
    frequency: Math.max(parseNumber(params.get('FREQUENCY'), 1), 0),
    once: parseBoolean(params.get('UPDATE_ONCE'))
  }
}

function buildFuelHoseVisibilityBinding(
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): CompiledVisibilityBinding | null {
  const bindingParams = new Map<string, string>(params)
  bindingParams.set(
    'VISIBILITY_CODE',
    `(A:INTERACTIVE POINT OPEN:${params.get('ID')?.trim() || '1'}, percent) 0 > if{ 1 } els{ 0 }`
  )
  return buildVisibilityBinding(bindingParams, params.get('NODE_ID')?.trim() ?? null, sourcePath, diagnostics)
}

function collectImmediateParameters(
  element: Element,
  inheritedParams: ReadonlyMap<string, string>
): Map<string, string> {
  const params = new Map<string, string>()
  for (const child of Array.from(element.children)) {
    if (child.children.length > 0) continue
    const value = substituteParameters(child.textContent ?? '', inheritedParams).trim()
    params.set(getElementTagName(child), value)
  }
  return params
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
  diagnostics: ImportDiagnostic[]
): Map<string, string> {
  const values = new Map<string, string>()
  collectParameterEntries(
    Array.from(blockNode.children),
    params,
    values,
    sourcePath,
    diagnostics
  )
  return values
}

function selectConditionBranch(
  conditionNode: Element,
  params: ReadonlyMap<string, string>
): Element | null {
  const notEmpty = conditionNode.getAttribute('NotEmpty')
  if (notEmpty) {
    const value = resolveNotEmptyValue(notEmpty, params)
    return value ? conditionNode.querySelector(':scope > True') : conditionNode.querySelector(':scope > False')
  }

  const empty = conditionNode.getAttribute('Empty')
  if (empty) {
    const value = resolveNotEmptyValue(empty, params)
    return value ? conditionNode.querySelector(':scope > False') : conditionNode.querySelector(':scope > True')
  }

  const valid = conditionNode.getAttribute('Valid')
  if (valid) {
    const value = resolveParameterReference(valid, params)
    return value ? conditionNode.querySelector(':scope > True') : conditionNode.querySelector(':scope > False')
  }

  const check = conditionNode.getAttribute('Check')
  if (check) {
    const value = resolveParameterReference(check, params)
    const match = conditionNode.getAttribute('Match')
    const matches = match == null
      ? value.length > 0
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
  const switchParam = switchNode.getAttribute('Param')
  const switchValue =
    switchParam == null ? '' : resolveParameterReference(switchParam, params)

  for (const child of Array.from(switchNode.children)) {
    if (child.tagName !== 'Case') {
      continue
    }

    const value = child.getAttribute('Value')
    if (value != null) {
      if (switchValue === substituteParameters(value, params).trim()) {
        return child
      }
      continue
    }

    const valid = child.getAttribute('Valid')
    if (valid != null && resolveParameterReference(valid, params)) {
      return child
    }

    const check = child.getAttribute('Check')
    if (check != null) {
      const resolvedValue = resolveParameterReference(check, params)
      const match = child.getAttribute('Match')
      const matches = match == null
        ? resolvedValue.length > 0
        : resolvedValue === substituteParameters(match, params).trim()
      if (matches) {
        return child
      }
    }

    const notEmpty = child.getAttribute('NotEmpty')
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
    const nextValue = currentValue.replace(/#([A-Za-z0-9_:.]+)#/gu, (_match, key) => {
      return params.get(key) ?? ''
    })
    if (nextValue === currentValue) break
    currentValue = nextValue
  }

  return currentValue
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

    const values = collectParameterBlock(block, targetParams, sourcePath, diagnostics)
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

  const type = (element.getAttribute('Type') ?? '').trim().toLowerCase()
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
  diagnostics: ImportDiagnostic[]
): void {
  const scopedParams = new Map<string, string>(params)
  for (const [key, value] of values) {
    scopedParams.set(key, value)
  }

  for (const child of children) {
    if (getParameterBlockKind(child) != null) {
      continue
    }

    if (child.tagName === 'Condition') {
      const branch = selectConditionBranch(child, scopedParams)
      if (branch != null) {
        collectParameterEntries(
          Array.from(branch.children),
          scopedParams,
          values,
          sourcePath,
          diagnostics
        )
        for (const [key, value] of values) {
          scopedParams.set(key, value)
        }
      }
      continue
    }

    if (child.tagName === 'Switch') {
      const branch = selectSwitchBranch(child, scopedParams)
      if (branch != null) {
        collectParameterEntries(
          Array.from(branch.children),
          scopedParams,
          values,
          sourcePath,
          diagnostics
        )
        for (const [key, value] of values) {
          scopedParams.set(key, value)
        }
      }
      continue
    }

    const key = substituteParameters(getElementTagName(child), scopedParams).trim()
    if (!key) {
      continue
    }

    const value = resolveProcessedParameterValue(child, scopedParams, sourcePath, diagnostics)
    values.set(key, value)
    scopedParams.set(key, value)
  }
}

function resolveProcessedParameterValue(
  node: Element,
  params: ReadonlyMap<string, string>,
  sourcePath: string,
  diagnostics: ImportDiagnostic[]
): string {
  const substituted = substituteParameters(node.textContent ?? '', params).trim()
  const process = (node.getAttribute('Process') ?? '').trim().toLowerCase()
  if (!process) {
    return substituted
  }

  if (process === 'param') {
    return params.get(substituted) ?? ''
  }

  if (process === 'int' || process === 'float') {
    const expression = compileRpnExpression(substituted, { sourcePath, diagnostics })
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

  const expression = compileRpnExpression(source, { sourcePath, diagnostics })
  if (expression == null) {
    return null
  }

  const frequency = parseNumber(
    substituteParameters(updateNode.getAttribute('Frequency') ?? '1', params).trim(),
    1
  )
  const once = parseBoolean(
    substituteParameters(updateNode.getAttribute('Once') ?? '0', params).trim()
  )

  return {
    expression,
    sourcePath,
    frequency: Math.max(frequency, 0),
    once
  }
}

function resolveParameterReference(
  expression: string,
  params: ReadonlyMap<string, string>
): string {
  const substituted = substituteParameters(expression, params).trim()
  return substituted ? (params.get(substituted) ?? '') : ''
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
  return expression.includes('#') ? substituted : ''
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
  switch (node.tagName) {
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
      const notEmpty = node.getAttribute('NotEmpty')
      if (notEmpty != null) {
        return resolveNotEmptyValue(notEmpty, params).length > 0
      }
      const empty = node.getAttribute('Empty')
      if (empty != null) {
        return resolveNotEmptyValue(empty, params).length === 0
      }
      const valid = node.getAttribute('Valid')
      if (valid != null) {
        return resolveParameterReference(valid, params).length > 0
      }
      const check = node.getAttribute('Check')
      if (check != null) {
        const value = resolveParameterReference(check, params)
        const match = node.getAttribute('Match')
        return match == null
          ? value.length > 0
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

  if (node.tagName === 'Number') {
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
  if (node.tagName === 'Value') {
    return params.get(substituted) ?? substituted
  }

  return substituted
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

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false
  const normalizedValue = value.trim().toLowerCase()
  return normalizedValue === '1' || normalizedValue === 'true'
}

function parseNumber(value: string | undefined, fallbackValue: number): number {
  const parsedValue = Number.parseFloat(value ?? '')
  return Number.isFinite(parsedValue) ? parsedValue : fallbackValue
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
