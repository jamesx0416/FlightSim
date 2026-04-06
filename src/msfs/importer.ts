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
  readonly diagnostics: ImportDiagnostic[]
  readonly textCache: Map<string, Promise<string>>
}

export async function importBuiltMsfs2020Package(
  rootUrl: string
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
  const context: ImportContext = {
    rootUrl: normalizedRootUrl,
    layoutEntries,
    layoutPaths,
    layoutPathIndex,
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
    if (importedAircraft != null) {
      aircraft.push(importedAircraft)
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

async function fetchText(
  path: string,
  context: ImportContext
): Promise<string | null> {
  const normalizedPath = normalizePath(path)
  const cached = context.textCache.get(normalizedPath)
  if (cached != null) {
    try {
      return await cached
    } catch {
      return null
    }
  }

  const pending = (async () => {
    const response = await fetch(resolvePackageUrl(context.rootUrl, normalizedPath))
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.text()
  })()

  context.textCache.set(normalizedPath, pending)

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
): Promise<ImportedAircraft | null> {
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

  const fltsimSection =
    getCfgSectionsByPrefix(record.sections, 'fltsim.')[0] ??
    getCfgSectionsByPrefix(chain.at(-1)?.sections ?? [], 'fltsim.')[0] ??
    null

  if (fltsimSection == null) {
    context.diagnostics.push({
      code: 'aircraft_fltsim_missing',
      message: `No [FLTSIM.x] section was found in ${record.path}.`,
      severity: 'warning',
      sourcePath: record.path
    })
    return null
  }

  const resolvedSource = chain.at(-1) ?? record
  const model = await importModelDefinition(
    resolvedSource,
    fltsimSection.values.get('model') ?? '',
    context
  )

  const title =
    fltsimSection.values.get('title') ||
    fltsimSection.values.get('ui_type') ||
    dirname(record.path).split('/').at(-1) ||
    record.path

  return {
    id: normalizePath(dirname(record.path)),
    title,
    sourcePath: record.path,
    sourceUrl: record.url,
    inheritedFromPaths: chain.slice(1).map(item => item.path),
    baseContainer,
    isUserSelectable: parseBoolean(fltsimSection.values.get('isuserselectable')),
    isFlyable: parseBoolean(fltsimSection.values.get('isflyable')),
    model
  }
}

async function importModelDefinition(
  aircraftRecord: AircraftCfgRecord,
  modelSuffix: string,
  context: ImportContext
): Promise<ImportedModelDefinition | null> {
  const aircraftDirectory = dirname(aircraftRecord.path)
  const modelDirectory = modelSuffix
    ? joinPath(aircraftDirectory, `model.${modelSuffix}`)
    : joinPath(aircraftDirectory, 'model')
  const modelCfgPath = resolveLayoutPath(joinPath(modelDirectory, 'model.cfg'), context)

  if (modelCfgPath == null) {
    context.diagnostics.push({
      code: 'model_cfg_missing',
      message: `Model configuration ${joinPath(modelDirectory, 'model.cfg')} was not found.`,
      severity: 'warning',
      sourcePath: aircraftRecord.path
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

  const behaviorPath = resolveLayoutPath(joinPath(modelDirectory, behaviorFile), context)
  if (behaviorPath == null) {
    context.diagnostics.push({
      code: 'model_behavior_missing_file',
      message: `Behavior XML ${behaviorFile} could not be resolved from ${modelCfgPath}.`,
      severity: 'warning',
      sourcePath: modelCfgPath
    })
    return null
  }
  const behaviorText = await fetchText(behaviorPath, context)
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
        path: joinPath(modelDirectory, modelFile),
        url: resolvePackageUrl(context.rootUrl, joinPath(modelDirectory, modelFile))
      }
    })
    .filter((lod): lod is NonNullable<typeof lod> => lod != null)

  const behaviorIncludes = Array.from(
    behaviorDocument.querySelectorAll('Behaviors > Include')
  )
    .map(includeNode => {
      const relativeFile = includeNode.getAttribute('RelativeFile')
      if (relativeFile) {
        const resolvedPath =
          resolveLayoutPath(joinPath(dirname(behaviorPath), relativeFile), context) ??
          joinPath(dirname(behaviorPath), relativeFile)
        return {
          kind: 'RelativeFile' as const,
          value: relativeFile,
          resolvedPath,
          resolvedUrl: resolvePackageUrl(context.rootUrl, resolvedPath)
        }
      }

      const modelBehaviorFile = includeNode.getAttribute('ModelBehaviorFile')
      if (modelBehaviorFile) {
        const resolvedPath =
          resolveLayoutPath(joinPath('ModelBehaviorDefs', modelBehaviorFile), context) ??
          joinPath('ModelBehaviorDefs', modelBehaviorFile)
        return {
          kind: 'ModelBehaviorFile' as const,
          value: modelBehaviorFile,
          resolvedPath,
          resolvedUrl: resolvePackageUrl(context.rootUrl, resolvedPath)
        }
      }

      const pathAttribute = includeNode.getAttribute('Path')
      if (pathAttribute) {
        const resolvedPath =
          resolveLayoutPath(joinPath('ModelBehaviorDefs', pathAttribute), context) ??
          joinPath('ModelBehaviorDefs', pathAttribute)
        return {
          kind: 'Path' as const,
          value: pathAttribute,
          resolvedPath,
          resolvedUrl: resolvePackageUrl(context.rootUrl, resolvedPath)
        }
      }

      return null
    })
    .filter(
      (reference): reference is ModelBehaviorReference => reference != null
    )

  for (const reference of behaviorIncludes) {
    if (!context.layoutPaths.has(normalizePath(reference.resolvedPath))) {
      context.diagnostics.push({
        code: 'behavior_include_missing',
        message: `Behavior include ${reference.value} could not be resolved within the package.`,
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
    behaviorUrl: resolvePackageUrl(context.rootUrl, behaviorPath),
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
