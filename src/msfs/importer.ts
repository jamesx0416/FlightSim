import { getCfgSection, getCfgSectionsByPrefix, parseCfg } from './config'
import type {
  ImportDiagnostic,
  ImportedAircraft,
  ImportedModelDefinition,
  ImportedPackage,
  ModelBehaviorReference,
  PackageLayoutEntry,
  PackageManifest
} from './types'

interface AircraftCfgRecord {
  readonly path: string
  readonly url: string
  readonly sections: ReturnType<typeof parseCfg>
}

interface ImportContext {
  readonly rootUrl: string
  readonly layoutEntries: readonly PackageLayoutEntry[]
  readonly layoutPaths: ReadonlySet<string>
  readonly layoutPathIndex: ReadonlyMap<string, string>
  readonly behaviorSourceRoots: readonly BehaviorSourceRoot[]
  readonly diagnostics: ImportDiagnostic[]
  readonly textCache: Map<string, Promise<string>>
}

interface BehaviorSourceRoot {
  readonly rootUrl: string
  readonly layoutPaths: ReadonlySet<string>
  readonly layoutPathIndex: ReadonlyMap<string, string>
}

interface ImportPackageOptions {
  readonly additionalPackageRoots?: readonly string[]
}

interface FltsimSectionRef {
  readonly record: AircraftCfgRecord
  readonly section: ReturnType<typeof parseCfg>[number]
}

export async function importBuiltMsfs2020Package(
  rootUrl: string,
  options: ImportPackageOptions = {}
): Promise<ImportedPackage> {
  const normalizedRootUrl = toAbsolutePackageRoot(rootUrl)
  const diagnostics: ImportDiagnostic[] = []
  const textCache = new Map<string, Promise<string>>()

  const manifest = await tryLoadManifest(normalizedRootUrl, diagnostics)
  const layoutEntries = await loadLayoutEntries(normalizedRootUrl, diagnostics)
  const layoutPaths = new Set(layoutEntries.map(entry => normalizePath(entry.path)))
  const layoutPathIndex = new Map(
    layoutEntries.map(entry => [normalizePath(entry.path).toLowerCase(), normalizePath(entry.path)])
  )
  const behaviorSourceRoots = await loadBehaviorSourceRoots(
    normalizedRootUrl,
    layoutEntries,
    options.additionalPackageRoots ?? [],
    diagnostics
  )
  const context: ImportContext = {
    rootUrl: normalizedRootUrl,
    layoutEntries,
    layoutPaths,
    layoutPathIndex,
    behaviorSourceRoots,
    diagnostics,
    textCache
  }

  const aircraftCfgPaths = layoutEntries
    .map(entry => normalizePath(entry.path))
    .filter(path => /simobjects\/airplanes\/.+\/aircraft\.cfg$/iu.test(path))
    .sort()

  const aircraftCfgRecords = new Map<string, AircraftCfgRecord>()
  for (const path of aircraftCfgPaths) {
    const cfgText = await fetchText(path, context)
    if (cfgText == null) continue

    aircraftCfgRecords.set(path, {
      path,
      url: resolvePackageUrl(normalizedRootUrl, path),
      sections: parseCfg(cfgText)
    })
  }

  const aircraft: ImportedAircraft[] = []
  for (const record of aircraftCfgRecords.values()) {
    const importedAircraft = await importAircraftRecord(
      record,
      aircraftCfgRecords,
      context
    )
    if (importedAircraft.length > 0) {
      aircraft.push(...importedAircraft)
    }
  }

  return {
    irVersion: 'msfs-package/v1',
    rootUrl: normalizedRootUrl,
    manifest,
    packageName:
      manifest?.title?.trim() || normalizePath(rootUrl).replace(/\/$/u, ''),
    layoutEntries,
    aircraft,
    diagnostics
  }
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

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/u, '').replace(/\/+/gu, '/')
}

function dirname(path: string): string {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf('/')
  if (index < 0) return ''
  return normalized.slice(0, index)
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

function resolvePackageUrl(rootUrl: string, relativePath: string): string {
  return new URL(normalizePath(relativePath), rootUrl).toString()
}

function resolveLayoutPath(path: string, context: ImportContext): string | null {
  return context.layoutPathIndex.get(normalizePath(path).toLowerCase()) ?? null
}

function resolveBehaviorLayoutPath(
  path: string,
  context: ImportContext,
  preferredRootUrl?: string
): { readonly rootUrl: string; readonly path: string } | null {
  const normalizedPath = normalizePath(path).toLowerCase()
  const roots =
    preferredRootUrl == null
      ? context.behaviorSourceRoots
      : [
          ...context.behaviorSourceRoots.filter(root => root.rootUrl === preferredRootUrl),
          ...context.behaviorSourceRoots.filter(root => root.rootUrl !== preferredRootUrl)
        ]

  for (const root of roots) {
    const resolvedPath = root.layoutPathIndex.get(normalizedPath)
    if (resolvedPath != null) {
      return {
        rootUrl: root.rootUrl,
        path: resolvedPath
      }
    }
  }

  return null
}

async function tryLoadManifest(
  rootUrl: string,
  diagnostics: ImportDiagnostic[]
): Promise<PackageManifest | null> {
  try {
    const response = await fetch(new URL('manifest.json', rootUrl))
    if (!response.ok) {
      diagnostics.push({
        code: 'manifest_missing',
        message: `manifest.json was not found at ${rootUrl}`,
        severity: 'warning',
        sourcePath: 'manifest.json'
      })
      return null
    }

    const payload = (await response.json()) as Record<string, unknown>
    return {
      title: asString(payload.title),
      packageVersion: asString(payload.package_version),
      creator: asString(payload.creator)
    }
  } catch (error) {
    diagnostics.push({
      code: 'manifest_failed',
      message: 'Failed to load manifest.json.',
      severity: 'warning',
      sourcePath: 'manifest.json',
      details: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

async function loadLayoutEntries(
  rootUrl: string,
  diagnostics: ImportDiagnostic[]
): Promise<PackageLayoutEntry[]> {
  try {
    const response = await fetch(new URL('layout.json', rootUrl))
    if (!response.ok) {
      diagnostics.push({
        code: 'layout_missing',
        message: `layout.json was not found at ${rootUrl}`,
        severity: 'error',
        sourcePath: 'layout.json'
      })
      return []
    }

    const payload = (await response.json()) as {
      readonly content?: readonly {
        readonly path?: string
        readonly size?: number
        readonly date?: number
      }[]
    }

    return (payload.content ?? [])
      .filter(entry => typeof entry.path === 'string')
      .map(entry => ({
        path: normalizePath(entry.path ?? ''),
        size: entry.size,
        date: entry.date
      }))
  } catch (error) {
    diagnostics.push({
      code: 'layout_failed',
      message: 'Failed to parse layout.json.',
      severity: 'error',
      sourcePath: 'layout.json',
      details: error instanceof Error ? error.message : String(error)
    })
    return []
  }
}

async function loadBehaviorSourceRoots(
  primaryRootUrl: string,
  primaryLayoutEntries: readonly PackageLayoutEntry[],
  additionalPackageRoots: readonly string[],
  diagnostics: ImportDiagnostic[]
): Promise<readonly BehaviorSourceRoot[]> {
  const roots: BehaviorSourceRoot[] = [
    createBehaviorSourceRoot(primaryRootUrl, primaryLayoutEntries)
  ]

  const seenRoots = new Set<string>([primaryRootUrl.toLowerCase()])
  for (const rootCandidate of additionalPackageRoots) {
    const normalizedRoot = toAbsolutePackageRoot(rootCandidate)
    if (seenRoots.has(normalizedRoot.toLowerCase())) {
      continue
    }

    seenRoots.add(normalizedRoot.toLowerCase())
    const layoutEntries = await loadLayoutEntries(normalizedRoot, diagnostics)
    if (layoutEntries.length === 0) {
      continue
    }

    roots.push(createBehaviorSourceRoot(normalizedRoot, layoutEntries))
  }

  return roots
}

function createBehaviorSourceRoot(
  rootUrl: string,
  layoutEntries: readonly PackageLayoutEntry[]
): BehaviorSourceRoot {
  const normalizedPaths = layoutEntries.map(entry => normalizePath(entry.path))

  return {
    rootUrl,
    layoutPaths: new Set(normalizedPaths),
    layoutPathIndex: new Map(
      normalizedPaths.map(path => [path.toLowerCase(), path])
    )
  }
}

async function fetchText(
  path: string,
  context: ImportContext
): Promise<string | null> {
  return fetchTextFromRoot(path, context.rootUrl, context)
}

async function fetchTextFromRoot(
  path: string,
  rootUrl: string,
  context: ImportContext
): Promise<string | null> {
  const normalizedPath = normalizePath(path)
  const cacheKey = `${rootUrl}::${normalizedPath}`
  const cached = context.textCache.get(cacheKey)
  if (cached != null) {
    try {
      return await cached
    } catch {
      return null
    }
  }

  const pending = (async () => {
    const response = await fetch(resolvePackageUrl(rootUrl, normalizedPath))
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.text()
  })()

  context.textCache.set(cacheKey, pending)

  try {
    return await pending
  } catch (error) {
    context.diagnostics.push({
      code: 'asset_missing',
      message: `Failed to load ${normalizedPath}.`,
      severity: 'warning',
      sourcePath: normalizedPath,
      details: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

async function importAircraftRecord(
  record: AircraftCfgRecord,
  aircraftCfgRecords: ReadonlyMap<string, AircraftCfgRecord>,
  context: ImportContext
): Promise<ImportedAircraft[]> {
  const visitedPaths = new Set<string>()
  const chain: AircraftCfgRecord[] = []
  let currentRecord: AircraftCfgRecord | undefined = record
  let baseContainer: string | undefined

  while (currentRecord != null && !visitedPaths.has(currentRecord.path)) {
    visitedPaths.add(currentRecord.path)
    chain.push(currentRecord)
    const variationSection = getCfgSection(currentRecord.sections, 'variation')
    const nextBaseContainer = variationSection?.values.get('base_container')
    if (!nextBaseContainer) break

    baseContainer = nextBaseContainer
    const nextPath = normalizePath(
      `${joinPath(dirname(currentRecord.path), nextBaseContainer)}/aircraft.cfg`
    )
    currentRecord = aircraftCfgRecords.get(resolveLayoutPath(nextPath, context) ?? nextPath)
    if (currentRecord == null) {
      context.diagnostics.push({
        code: 'base_container_missing',
        message: `Base container ${nextBaseContainer} could not be resolved for ${record.path}.`,
        severity: 'warning',
        sourcePath: record.path
      })
    }
  }

  const fltsimSections = resolveFltsimSections(record, chain)
  if (fltsimSections.length === 0) {
    context.diagnostics.push({
      code: 'aircraft_fltsim_missing',
      message: `No [FLTSIM.x] section was found in ${record.path}.`,
      severity: 'warning',
      sourcePath: record.path
    })
    return []
  }

  const inheritedFromPaths = chain.slice(1).map(item => item.path)
  const aircraftDirectoryName = dirname(record.path).split('/').at(-1) || record.path
  const importedAircraft: ImportedAircraft[] = []

  for (const fltsim of fltsimSections) {
    const section = fltsim.section
    const model = await importModelDefinition(
      [fltsim.record, ...chain],
      section.values.get('model') ?? '',
      context
    )

    const title =
      section.values.get('title') ||
      section.values.get('ui_type') ||
      aircraftDirectoryName
    const variationName = section.values.get('ui_variation') || undefined
    const uiType = section.values.get('ui_type') || undefined
    const textureDirectories = await resolveTextureDirectories(chain, fltsim, context)

    importedAircraft.push({
      id: `${normalizePath(dirname(record.path))}#${section.name.toLowerCase()}`,
      title,
      sectionName: section.name,
      uiType,
      variationName,
      sourcePath: record.path,
      sourceUrl: record.url,
      inheritedFromPaths,
      textureDirectories,
      baseContainer,
      isUserSelectable: parseBoolean(section.values.get('isuserselectable')),
      isFlyable: parseBoolean(section.values.get('isflyable')),
      model
    })
  }

  return importedAircraft
}

async function importModelDefinition(
  aircraftRecords: readonly AircraftCfgRecord[],
  modelSuffix: string,
  context: ImportContext
): Promise<ImportedModelDefinition | null> {
  const candidateModelDirectories = getModelDirectoryCandidates(
    aircraftRecords,
    modelSuffix
  )
  const modelCfgPath = candidateModelDirectories
    .map(modelDirectory =>
      resolveLayoutPath(joinPath(modelDirectory, 'model.cfg'), context)
    )
    .find((path): path is string => path != null)

  if (modelCfgPath == null) {
    const attemptedModelDirectory =
      candidateModelDirectories[0] ??
      joinPath(dirname(aircraftRecords[0]?.path ?? ''), modelSuffix ? `model.${modelSuffix}` : 'model')
    context.diagnostics.push({
      code: 'model_cfg_missing',
      message: `Model configuration ${joinPath(attemptedModelDirectory, 'model.cfg')} was not found.`,
      severity: 'warning',
      sourcePath: aircraftRecords[0]?.path
    })
    return null
  }

  const modelCfgText = await fetchText(modelCfgPath, context)
  if (modelCfgText == null) return null

  const modelCfgSections = parseCfg(modelCfgText)
  const modelsSection = getCfgSection(modelCfgSections, 'models')
  const behaviorFile = modelsSection?.values.get('normal')
  if (!behaviorFile) {
    context.diagnostics.push({
      code: 'model_behavior_missing',
      message: `No [models].normal entry was found in ${modelCfgPath}.`,
      severity: 'warning',
      sourcePath: modelCfgPath
    })
    return null
  }

  const modelCfgDirectory = dirname(modelCfgPath)
  const resolvedBehavior = resolveBehaviorLayoutPath(
    joinPath(modelCfgDirectory, behaviorFile),
    context,
    context.rootUrl
  )
  if (resolvedBehavior == null) {
    context.diagnostics.push({
      code: 'model_behavior_missing_file',
      message: `Behavior XML ${behaviorFile} could not be resolved from ${modelCfgPath}.`,
      severity: 'warning',
      sourcePath: modelCfgPath
    })
    return null
  }
  const behaviorPath = resolvedBehavior.path
  const behaviorText = await fetchTextFromRoot(behaviorPath, resolvedBehavior.rootUrl, context)
  if (behaviorText == null) return null

  const behaviorDocument = new DOMParser().parseFromString(behaviorText, 'text/xml')
  if (behaviorDocument.querySelector('parsererror')) {
    context.diagnostics.push({
      code: 'model_behavior_invalid_xml',
      message: `Model behavior XML could not be parsed: ${behaviorPath}.`,
      severity: 'warning',
      sourcePath: behaviorPath
    })
    return null
  }

  const lods = Array.from(behaviorDocument.querySelectorAll('LODS > LOD'))
    .map(lodNode => {
      const modelFile = lodNode.getAttribute('ModelFile')
      if (!modelFile) return null
      return {
        minSize: Number.parseFloat(lodNode.getAttribute('minSize') ?? '0') || 0,
        path: joinPath(dirname(behaviorPath), modelFile),
        url: resolvePackageUrl(
          context.rootUrl,
          joinPath(dirname(behaviorPath), modelFile)
        )
      }
    })
    .filter((lod): lod is NonNullable<typeof lod> => lod != null)

  const behaviorIncludes = Array.from(
    behaviorDocument.querySelectorAll('Behaviors > Include')
  )
    .map(includeNode => {
      const relativeFile = includeNode.getAttribute('RelativeFile')
      if (relativeFile) {
        const resolvedBehaviorPath =
          resolveBehaviorLayoutPath(
            joinPath(dirname(behaviorPath), relativeFile),
            context,
            resolvedBehavior.rootUrl
          )
        return {
          kind: 'RelativeFile' as const,
          value: relativeFile,
          resolvedPath:
            resolvedBehaviorPath?.path ?? joinPath(dirname(behaviorPath), relativeFile),
          resolvedUrl: resolvePackageUrl(
            resolvedBehaviorPath?.rootUrl ?? resolvedBehavior.rootUrl,
            resolvedBehaviorPath?.path ?? joinPath(dirname(behaviorPath), relativeFile)
          )
        }
      }

      const modelBehaviorFile = includeNode.getAttribute('ModelBehaviorFile')
      if (modelBehaviorFile) {
        const resolvedBehaviorPath =
          resolveBehaviorLayoutPath(
            joinPath('ModelBehaviorDefs', modelBehaviorFile),
            context
          )
        return {
          kind: 'ModelBehaviorFile' as const,
          value: modelBehaviorFile,
          resolvedPath:
            resolvedBehaviorPath?.path ?? joinPath('ModelBehaviorDefs', modelBehaviorFile),
          resolvedUrl: resolvePackageUrl(
            resolvedBehaviorPath?.rootUrl ?? context.rootUrl,
            resolvedBehaviorPath?.path ?? joinPath('ModelBehaviorDefs', modelBehaviorFile)
          )
        }
      }

      const pathAttribute = includeNode.getAttribute('Path')
      if (pathAttribute) {
        const resolvedBehaviorPath =
          resolveBehaviorLayoutPath(joinPath('ModelBehaviorDefs', pathAttribute), context)
        return {
          kind: 'Path' as const,
          value: pathAttribute,
          resolvedPath:
            resolvedBehaviorPath?.path ?? joinPath('ModelBehaviorDefs', pathAttribute),
          resolvedUrl: resolvePackageUrl(
            resolvedBehaviorPath?.rootUrl ?? context.rootUrl,
            resolvedBehaviorPath?.path ?? joinPath('ModelBehaviorDefs', pathAttribute)
          )
        }
      }

      return null
    })
    .filter(
      (reference): reference is ModelBehaviorReference => reference != null
    )

  for (const reference of behaviorIncludes) {
    const resolvedInclude = resolveBehaviorLayoutPath(reference.resolvedPath, context)
    if (resolvedInclude == null) {
      context.diagnostics.push({
        code: 'behavior_include_missing',
        message: `Behavior include ${reference.value} could not be resolved within the available behavior roots.`,
        severity: 'warning',
        sourcePath: behaviorPath,
        details: reference.resolvedPath
      })
    }
  }

  return {
    cfgPath: modelCfgPath,
    cfgUrl: resolvePackageUrl(context.rootUrl, modelCfgPath),
    behaviorPath,
    behaviorUrl: resolvePackageUrl(resolvedBehavior.rootUrl, behaviorPath),
    lods,
    behaviorIncludes
  }
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false
  return value.trim() === '1' || value.trim().toLowerCase() === 'true'
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function resolveFltsimSections(
  record: AircraftCfgRecord,
  chain: readonly AircraftCfgRecord[]
): FltsimSectionRef[] {
  const localSections = getCfgSectionsByPrefix(record.sections, 'fltsim.')
  if (localSections.length > 0) {
    return localSections.map(section => ({ record, section }))
  }

  const inheritedRecord = chain.at(-1)
  if (inheritedRecord == null) {
    return []
  }

  return getCfgSectionsByPrefix(inheritedRecord.sections, 'fltsim.')
    .map(section => ({ record: inheritedRecord, section }))
}

async function resolveTextureDirectories(
  chain: readonly AircraftCfgRecord[],
  primaryFltsim: FltsimSectionRef,
  context: ImportContext
): Promise<string[]> {
  const textureDirectories: string[] = []
  const visitedDirectories = new Set<string>()

  const addTextureDirectory = async (directoryCandidate: string): Promise<void> => {
    const resolvedTextureDirectory =
      resolveExistingDirectory(directoryCandidate, context) ??
      normalizePath(directoryCandidate)

    if (visitedDirectories.has(resolvedTextureDirectory.toLowerCase())) {
      return
    }

    visitedDirectories.add(resolvedTextureDirectory.toLowerCase())
    textureDirectories.push(resolvedTextureDirectory)

    await addTextureFallbackDirectories(
      resolvedTextureDirectory,
      context,
      textureDirectories,
      visitedDirectories
    )
  }

  const primaryTextureValue = primaryFltsim.section.values.get('texture')?.trim() ?? ''
  const primaryDirectoryCandidate = primaryTextureValue
    ? joinPath(dirname(primaryFltsim.record.path), `texture.${primaryTextureValue}`)
    : joinPath(dirname(primaryFltsim.record.path), 'texture')
  await addTextureDirectory(primaryDirectoryCandidate)

  for (const record of chain) {
    for (const directoryCandidate of getTextureDirectoryCandidates(record)) {
      await addTextureDirectory(directoryCandidate)
    }
  }

  return textureDirectories
}

async function addTextureFallbackDirectories(
  directoryPath: string,
  context: ImportContext,
  textureDirectories: string[],
  visitedDirectories: Set<string>
): Promise<void> {
  const textureCfgPath = resolveLayoutPath(joinPath(directoryPath, 'texture.cfg'), context)
  if (textureCfgPath == null) {
    return
  }

  const textureCfgText = await fetchText(textureCfgPath, context)
  if (textureCfgText == null) {
    return
  }

  const fltsimSection = getCfgSection(parseCfg(textureCfgText), 'fltsim')
  if (fltsimSection == null) {
    return
  }

  const fallbackDirectories = [...fltsimSection.values.entries()]
    .filter(([key, value]) => /^fallback\.\d+$/iu.test(key) && value.trim() !== '')
    .sort((left, right) => {
      const leftIndex = Number.parseInt(left[0].split('.').at(-1) ?? '0', 10)
      const rightIndex = Number.parseInt(right[0].split('.').at(-1) ?? '0', 10)
      return leftIndex - rightIndex
    })

  for (const [, fallbackValue] of fallbackDirectories) {
    const fallbackDirectory =
      resolveExistingDirectory(joinPath(dirname(textureCfgPath), fallbackValue), context) ??
      joinPath(dirname(textureCfgPath), fallbackValue)
    const normalizedFallbackDirectory = normalizePath(fallbackDirectory)

    if (visitedDirectories.has(normalizedFallbackDirectory.toLowerCase())) {
      continue
    }

    visitedDirectories.add(normalizedFallbackDirectory.toLowerCase())
    textureDirectories.push(normalizedFallbackDirectory)
    await addTextureFallbackDirectories(
      normalizedFallbackDirectory,
      context,
      textureDirectories,
      visitedDirectories
    )
  }
}

function getModelDirectoryCandidates(
  aircraftRecords: readonly AircraftCfgRecord[],
  modelSuffix: string
): string[] {
  const modelDirectories: string[] = []

  for (const record of aircraftRecords) {
    const aircraftDirectory = dirname(record.path)
    const modelDirectory = modelSuffix
      ? joinPath(aircraftDirectory, `model.${modelSuffix}`)
      : joinPath(aircraftDirectory, 'model')

    if (!modelDirectories.includes(modelDirectory)) {
      modelDirectories.push(modelDirectory)
    }
  }

  return modelDirectories
}

function getTextureDirectoryCandidates(record: AircraftCfgRecord): string[] {
  const aircraftDirectory = dirname(record.path)
  const sections = getCfgSectionsByPrefix(record.sections, 'fltsim.')
  const rankedTextureValues = sections
    .map(section => {
      const textureValue = section.values.get('texture')?.trim() ?? ''
      const textureValueUpper = textureValue.toUpperCase()
      let score = 0

      if (parseBoolean(section.values.get('isuserselectable'))) score += 20
      if (parseBoolean(section.values.get('isflyable'))) score += 20
      if (!textureValueUpper.includes('AIB')) score += 10
      if (textureValue !== '') score += 1

      return { textureValue, score }
    })
    .sort((left, right) => right.score - left.score)

  const candidates: string[] = []
  for (const { textureValue } of rankedTextureValues) {
    const directoryCandidate = textureValue
      ? joinPath(aircraftDirectory, `texture.${textureValue}`)
      : joinPath(aircraftDirectory, 'texture')
    if (!candidates.includes(directoryCandidate)) {
      candidates.push(directoryCandidate)
    }
  }

  const defaultTextureDirectory = joinPath(aircraftDirectory, 'texture')
  if (!candidates.includes(defaultTextureDirectory)) {
    candidates.push(defaultTextureDirectory)
  }

  return candidates
}

function resolveExistingDirectory(
  directoryPath: string,
  context: ImportContext
): string | null {
  const normalizedDirectoryPath = normalizePath(directoryPath)
  const lowerDirectoryPath = `${normalizedDirectoryPath.toLowerCase()}/`

  for (const [lowerPath, actualPath] of context.layoutPathIndex) {
    if (lowerPath.startsWith(lowerDirectoryPath)) {
      return dirname(actualPath)
    }
  }

  return null
}
