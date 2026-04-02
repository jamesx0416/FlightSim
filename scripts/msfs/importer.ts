import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import {
  DEFAULT_BEHAVIOR_CONTRACT,
  DEFAULT_RUNTIME_CONTRACTS,
  PACKAGE_IMPORT_SCHEMA_VERSION,
  PHASE_0_TEST_MATRIX,
  type AircraftConfigSnapshot,
  type AircraftDefinition,
  type AircraftVariantConfigSnapshot,
  type AircraftVariantDefinition,
  type AssetKind,
  type ImportBackend,
  type ImportDiagnostic,
  type ModelDefinition,
  type ModelDocumentDescriptor,
  type NormalizedPackageImportCache,
  type PackageAssetFile,
  type PackageAssetManifest,
  type PackageMetadata,
  type PanelDefinition,
  type ResolvedDirectoryReference,
  type SoundConditionDescriptor,
  type SoundDefinition,
  type SoundEntryDescriptor,
  type SoundRangeDescriptor,
  type SoundRtpcDescriptor,
  type SoundVariableDescriptor
} from '../../src/msfs/contracts.ts'
import {
  getElementChildren,
  parseXmlDocument,
  type XmlElementNode
} from '../../src/msfs/behavior/xml.ts'

interface ParsedIniSection {
  name: string
  normalizedName: string
  values: Record<string, string>
}

interface ParsedIniFile {
  path: string
  sections: ParsedIniSection[]
}

interface DiscoveredAssetFile extends PackageAssetFile {
  mtimeMs: number
}

interface AircraftSource {
  absoluteDir: string
  relativeDir: string
  configPath: string
  parsedConfig: ParsedIniFile
  baseContainerDir?: string
  containerChain: string[]
}

interface ModularAttachmentDefinition {
  alias: string
  absoluteDir: string
  relativeDir: string
  parameters: Record<string, string>
}

interface ImportOptions {
  packageRoot: string
}

interface CliWriteResult {
  outputPath: string
  cache: NormalizedPackageImportCache
}

export function importMsfs2020Package(options: ImportOptions): NormalizedPackageImportCache {
  const packageRoot = resolve(options.packageRoot)
  const diagnostics: ImportDiagnostic[] = []
  const assetFiles = collectAssetFiles(packageRoot)
  const aircraftSources = discoverAircraftSources(packageRoot, diagnostics)
  const modelCache = new Map<string, ModelDefinition>()
  const panelCache = new Map<string, PanelDefinition>()
  const soundCache = new Map<string, SoundDefinition>()

  const aircraft = aircraftSources.map((source) =>
    buildAircraftDefinition(source, packageRoot, diagnostics, modelCache, panelCache, soundCache)
  )

  return {
    schemaVersion: PACKAGE_IMPORT_SCHEMA_VERSION,
    source: {
      backend: 'msfs2020-monolithic',
      packageRoot,
      cacheKey: buildCacheKey(assetFiles),
      generatedAt: new Date().toISOString(),
      fileCount: assetFiles.length,
      totalBytes: assetFiles.reduce((sum, file) => sum + file.byteLength, 0)
    },
    packageMetadata: readPackageMetadata(packageRoot, diagnostics),
    aircraft,
    assetManifest: toAssetManifest(assetFiles),
    compiledBehaviorContract: DEFAULT_BEHAVIOR_CONTRACT,
    runtimeContracts: DEFAULT_RUNTIME_CONTRACTS,
    testMatrix: PHASE_0_TEST_MATRIX,
    diagnostics
  }
}

export function importMsfs2024Package(options: ImportOptions): NormalizedPackageImportCache {
  const packageRoot = resolve(options.packageRoot)
  const diagnostics: ImportDiagnostic[] = []
  const assetFiles = collectAssetFiles(packageRoot)
  const aircraft = discoverModularAircraft(packageRoot, diagnostics)

  return {
    schemaVersion: PACKAGE_IMPORT_SCHEMA_VERSION,
    source: {
      backend: 'msfs2024-modular',
      packageRoot,
      cacheKey: buildCacheKey(assetFiles),
      generatedAt: new Date().toISOString(),
      fileCount: assetFiles.length,
      totalBytes: assetFiles.reduce((sum, file) => sum + file.byteLength, 0)
    },
    packageMetadata: readPackageMetadata(packageRoot, diagnostics),
    aircraft,
    assetManifest: toAssetManifest(assetFiles),
    compiledBehaviorContract: DEFAULT_BEHAVIOR_CONTRACT,
    runtimeContracts: DEFAULT_RUNTIME_CONTRACTS,
    testMatrix: PHASE_0_TEST_MATRIX,
    diagnostics
  }
}

export function importMsfsPackage(
  options: ImportOptions & { backend?: ImportBackend }
): NormalizedPackageImportCache {
  const backend = options.backend ?? detectImportBackend(options.packageRoot)
  if (backend === 'msfs2024-modular') {
    return importMsfs2024Package(options)
  }
  return importMsfs2020Package(options)
}

export function writeImportCache(cache: NormalizedPackageImportCache, outDir: string): CliWriteResult {
  const outputDir = resolve(outDir)
  mkdirSync(outputDir, { recursive: true })

  const packageSlug = slugify(basename(cache.source.packageRoot) || 'package')
  const suffix =
    cache.source.backend === 'msfs2024-modular'
      ? 'msfs2024-import.json'
      : 'msfs2020-import.json'
  const outputPath = join(outputDir, `${packageSlug}.${suffix}`)
  writeFileSync(outputPath, `${JSON.stringify(cache, null, 2)}\n`)

  return { outputPath, cache }
}

export function resolvePackageRoot(inputPath: string): string {
  const absoluteInput = resolve(inputPath)
  if (!existsSync(absoluteInput) || !statSync(absoluteInput).isDirectory()) {
    throw new Error(`Path does not exist or is not a directory: ${inputPath}`)
  }

  if (detectImportBackend(absoluteInput) === 'msfs2024-modular') {
    return absoluteInput
  }

  const aircraftCfgPath = findCaseInsensitiveChild(absoluteInput, 'aircraft.cfg')
  if (aircraftCfgPath) {
    const airPlanesDir = dirname(absoluteInput)
    const simObjectsDir = dirname(airPlanesDir)
    if (basename(airPlanesDir).toLowerCase() !== 'airplanes') {
      throw new Error(`Aircraft directory is not under SimObjects/AirPlanes: ${inputPath}`)
    }
    if (basename(simObjectsDir).toLowerCase() !== 'simobjects') {
      throw new Error(`Aircraft directory is not under SimObjects/AirPlanes: ${inputPath}`)
    }
    return dirname(simObjectsDir)
  }

  const airPlanesPath = resolveCaseInsensitivePath(absoluteInput, 'SimObjects/AirPlanes')
  if (airPlanesPath && statSync(airPlanesPath).isDirectory()) {
    return absoluteInput
  }

  const nestedPackageRoots = findNestedPackageRoots(absoluteInput)
  if (nestedPackageRoots.length === 1) {
    throw new Error(
      `Could not resolve an MSFS package root under: ${inputPath}. Found a nested package root: ${toPortablePath(
        nestedPackageRoots[0]
      )}. Pass that path instead.`
    )
  }
  if (nestedPackageRoots.length > 1) {
    throw new Error(
      `Could not resolve an MSFS package root under: ${inputPath}. Found nested package roots: ${nestedPackageRoots
        .map((candidate) => toPortablePath(candidate))
        .join(', ')}. Pass one of those package roots instead.`
    )
  }

  throw new Error(
    `Could not resolve an MSFS package root under: ${inputPath}. Expected SimObjects/AirPlanes or an MSFS 2024 common/presets layout.`
  )
}

export function detectImportBackend(inputPath: string): ImportBackend {
  const absoluteInput = resolve(inputPath)
  const commonPath = resolveCaseInsensitivePath(absoluteInput, 'common')
  const presetsPath = resolveCaseInsensitivePath(absoluteInput, 'presets')
  if (
    commonPath &&
    presetsPath &&
    existsSync(commonPath) &&
    existsSync(presetsPath) &&
    statSync(commonPath).isDirectory() &&
    statSync(presetsPath).isDirectory()
  ) {
    return 'msfs2024-modular'
  }

  return 'msfs2020-monolithic'
}

function findNestedPackageRoots(rootDir: string): string[] {
  const candidates = new Set<string>()

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const candidate = join(rootDir, entry.name)
    if (detectImportBackend(candidate) === 'msfs2024-modular') {
      candidates.add(candidate)
      continue
    }

    const airPlanesPath = resolveCaseInsensitivePath(candidate, 'SimObjects/AirPlanes')
    if (airPlanesPath && statSync(airPlanesPath).isDirectory()) {
      candidates.add(candidate)
    }
  }

  return [...candidates].sort((left, right) => left.localeCompare(right))
}

function buildAircraftDefinition(
  source: AircraftSource,
  packageRoot: string,
  diagnostics: ImportDiagnostic[],
  modelCache: Map<string, ModelDefinition>,
  panelCache: Map<string, PanelDefinition>,
  soundCache: Map<string, SoundDefinition>
): AircraftDefinition {
  const general = getSection(source.parsedConfig, 'general')?.values ?? {}
  const configSnapshot = buildAircraftConfigSnapshot(source, packageRoot)
  const variantSections = getVariantSections(source.parsedConfig)

  const variants = variantSections.map((variant) =>
    buildAircraftVariantDefinition(
      source,
      variant,
      packageRoot,
      diagnostics,
      modelCache,
      panelCache,
      soundCache
    )
  )

  return {
    aircraftId: basename(source.absoluteDir),
    directory: source.relativeDir,
    baseContainer: source.baseContainerDir ? toPortableRelativePath(packageRoot, source.baseContainerDir) : undefined,
    category: general.category,
    config: configSnapshot,
    variants
  }
}

function buildAircraftVariantDefinition(
  source: AircraftSource,
  variant: AircraftVariantConfigSnapshot,
  packageRoot: string,
  diagnostics: ImportDiagnostic[],
  modelCache: Map<string, ModelDefinition>,
  panelCache: Map<string, PanelDefinition>,
  soundCache: Map<string, SoundDefinition>
): AircraftVariantDefinition {
  const rawConfig = variant.raw
  const modelReference = resolveReferenceDirectory('model', rawConfig.model, source, packageRoot, diagnostics)
  const panelReference = resolveReferenceDirectory('panel', rawConfig.panel, source, packageRoot, diagnostics)
  const soundReference = resolveReferenceDirectory('sound', rawConfig.sound, source, packageRoot, diagnostics)
  const textureReference = resolveReferenceDirectory('texture', rawConfig.texture, source, packageRoot, diagnostics)

  return {
    id: `${basename(source.absoluteDir)}:${variant.section.toLowerCase()}`,
    order: variant.order,
    title: rawConfig.title,
    uiType: rawConfig.ui_type,
    uiVariation: rawConfig.ui_variation,
    isUserSelectable: parseIniBoolean(rawConfig.isuserselectable),
    isFlyable: parseIniBoolean(rawConfig.isflyable),
    rawConfig,
    references: {
      model: modelReference,
      panel: panelReference,
      sound: soundReference,
      texture: textureReference
    },
    resolved: {
      model: modelReference
        ? getOrParseModelDefinition(
            resolve(packageRoot, modelReference.directory),
            packageRoot,
            diagnostics,
            modelCache
          )
        : undefined,
      panel: panelReference
        ? getOrParsePanelDefinition(
            resolve(packageRoot, panelReference.directory),
            packageRoot,
            diagnostics,
            panelCache
          )
        : undefined,
      sound: soundReference
        ? getOrParseSoundDefinition(
            resolve(packageRoot, soundReference.directory),
            packageRoot,
            diagnostics,
            soundCache
          )
        : undefined
    }
  }
}

function buildAircraftConfigSnapshot(source: AircraftSource, packageRoot: string): AircraftConfigSnapshot {
  return {
    path: toPortableRelativePath(packageRoot, source.configPath),
    version: getSection(source.parsedConfig, 'version')?.values ?? {},
    general: getSection(source.parsedConfig, 'general')?.values ?? {},
    variation: getSection(source.parsedConfig, 'variation')?.values ?? {},
    variants: getVariantSections(source.parsedConfig)
  }
}

function discoverModularAircraft(
  packageRoot: string,
  diagnostics: ImportDiagnostic[]
): AircraftDefinition[] {
  const commonDir = resolveCaseInsensitivePath(packageRoot, 'common')
  const presetsRoot = resolveCaseInsensitivePath(packageRoot, 'presets')

  if (!commonDir || !presetsRoot) {
    throw new Error(`Missing common/ or presets/ under modular package root: ${packageRoot}`)
  }

  const commonAircraftCfgPath = resolveCaseInsensitivePath(commonDir, 'config/aircraft.cfg')
  const commonAircraftCfg = commonAircraftCfgPath ? parseIniFile(commonAircraftCfgPath) : createEmptyIniFile(join(commonDir, 'config', 'aircraft.cfg'))

  const commonGeneral = getSection(commonAircraftCfg, 'general')?.values ?? {}
  const aircraft: AircraftDefinition[] = []

  for (const presetDir of discoverPresetDirectories(presetsRoot)) {
    const presetAircraftCfgPath = resolveCaseInsensitivePath(presetDir, 'config/aircraft.cfg')
    const presetAircraftCfg = presetAircraftCfgPath ? parseIniFile(presetAircraftCfgPath) : createEmptyIniFile(join(presetDir, 'config', 'aircraft.cfg'))
    const attachedObjectsPath = resolveCaseInsensitivePath(presetDir, 'config/attached_objects.cfg')
    const attachedObjects = attachedObjectsPath ? parseIniFile(attachedObjectsPath) : undefined
    const attachments = attachedObjects
      ? resolveModularAttachments(packageRoot, presetDir, attachedObjects, diagnostics)
      : []

    const mergedAircraftCfg = mergeIniFiles([
      commonAircraftCfg,
      ...attachments
        .map((attachment) => resolveCaseInsensitivePath(attachment.absoluteDir, 'config/aircraft.cfg'))
        .filter((path): path is string => path != null)
        .map((path) => parseIniFile(path)),
      presetAircraftCfg
    ])

    const variantSections = getVariantSections(mergedAircraftCfg)
    const effectiveVariants =
      variantSections.length > 0
        ? variantSections
        : [
            {
              section: 'FLTSIM.0',
              order: 0,
              raw: {}
            }
          ]

    const variants = effectiveVariants.map((variant) =>
      buildModularAircraftVariantDefinition(
        packageRoot,
        commonDir,
        presetDir,
        mergedAircraftCfg,
        variant,
        attachments,
        diagnostics
      )
    )

    aircraft.push({
      aircraftId: basename(presetDir),
      directory: toPortableRelativePath(packageRoot, presetDir),
      category: commonGeneral.category,
      config: buildAircraftConfigSnapshotFromParsed(mergedAircraftCfg, packageRoot),
      variants
    })
  }

  return aircraft.sort((left, right) => left.directory.localeCompare(right.directory))
}

function discoverPresetDirectories(presetsRoot: string): string[] {
  const presetDirs: string[] = []

  for (const companyDir of readdirSync(presetsRoot, { withFileTypes: true })) {
    if (!companyDir.isDirectory()) continue
    const companyPath = join(presetsRoot, companyDir.name)
    for (const presetDir of readdirSync(companyPath, { withFileTypes: true })) {
      if (!presetDir.isDirectory()) continue
      presetDirs.push(join(companyPath, presetDir.name))
    }
  }

  return presetDirs.sort((left, right) => left.localeCompare(right))
}

function resolveModularAttachments(
  packageRoot: string,
  presetDir: string,
  attachedObjects: ParsedIniFile,
  diagnostics: ImportDiagnostic[]
): ModularAttachmentDefinition[] {
  const sections = attachedObjects.sections.filter((section) =>
    section.normalizedName.startsWith('sim_attachment.')
  )
  const attachments: ModularAttachmentDefinition[] = []

  for (const section of sections) {
    const absoluteDir = resolveModularAttachmentDirectory(packageRoot, presetDir, section.values)
    if (!absoluteDir || !existsSync(absoluteDir) || !statSync(absoluteDir).isDirectory()) {
      diagnostics.push({
        severity: 'warning',
        code: 'modular_attachment_missing',
        message: `Could not resolve modular attachment for alias "${section.values.alias ?? section.name}".`,
        file: toPortableRelativePath(packageRoot, presetDir)
      })
      continue
    }

    attachments.push({
      alias: section.values.alias ?? basename(absoluteDir),
      absoluteDir,
      relativeDir: toPortableRelativePath(packageRoot, absoluteDir),
      parameters: extractAttachmentParameterMap(section.values)
    })
  }

  return attachments
}

function resolveModularAttachmentDirectory(
  packageRoot: string,
  presetDir: string,
  values: Record<string, string>
): string | undefined {
  if (values.attachment_root) {
    return resolve(packageRoot, values.attachment_root.replaceAll('\\', '/'))
  }

  if (values.attachment) {
    const absoluteAttachmentPath = resolve(
      packageRoot,
      values.attachment.replaceAll('\\', '/')
    )
    return dirname(dirname(absoluteAttachmentPath))
  }

  if (values.attachment_file && values.attachment_root) {
    return resolve(packageRoot, values.attachment_root.replaceAll('\\', '/'))
  }

  if (values.attachment_file) {
    return dirname(resolve(presetDir, values.attachment_file.replaceAll('\\', '/')))
  }

  return undefined
}

function extractAttachmentParameterMap(values: Record<string, string>): Record<string, string> {
  const parameters: Record<string, string> = {}

  for (const [key, rawValue] of Object.entries(values)) {
    if (!key.startsWith('vcockpit_parameter.') && !key.startsWith('vpainting_parameter.')) {
      continue
    }

    const separatorIndex = rawValue.indexOf(',')
    if (separatorIndex < 0) continue
    const parameterName = rawValue.slice(0, separatorIndex).trim()
    const parameterValue = rawValue.slice(separatorIndex + 1).trim()
    if (!parameterName) continue
    parameters[parameterName] = parameterValue
  }

  return parameters
}

function buildModularAircraftVariantDefinition(
  packageRoot: string,
  commonDir: string,
  presetDir: string,
  mergedAircraftCfg: ParsedIniFile,
  variant: AircraftVariantConfigSnapshot,
  attachments: ModularAttachmentDefinition[],
  diagnostics: ImportDiagnostic[]
): AircraftVariantDefinition {
  const rawConfig = variant.raw
  const modelSuffix = rawConfig.model
  const panelSuffix = rawConfig.panel
  const soundSuffix = rawConfig.sound
  const textureSuffix = rawConfig.texture
  const parameterMap = Object.assign({}, ...attachments.map((attachment) => attachment.parameters))

  const commonModelDir = findModularPartDirectory(commonDir, 'model', modelSuffix)
  const presetModelDir = findModularPartDirectory(presetDir, 'model', modelSuffix)
  const attachmentModelDirs = attachments
    .map((attachment) => findModularPartDirectory(attachment.absoluteDir, 'model', modelSuffix))
    .filter((path): path is string => path != null)
  const modelDefinitions = [
    commonModelDir,
    ...attachmentModelDirs,
    presetModelDir
  ]
    .filter((path): path is string => path != null)
    .map((path) => parseModularModelDefinition(path, packageRoot, diagnostics))
    .filter((definition): definition is ModelDefinition => definition != null)

  const commonPanelDir = findModularPartDirectory(commonDir, 'panel', panelSuffix)
  const presetPanelDir = findModularPartDirectory(presetDir, 'panel', panelSuffix)
  const attachmentPanelDirs = attachments
    .map((attachment) => findModularPartDirectory(attachment.absoluteDir, 'panel', panelSuffix))
    .filter((path): path is string => path != null)
  const panelDefinition = mergeModularPanelDefinitions(
    [commonPanelDir, ...attachmentPanelDirs, presetPanelDir].filter((path): path is string => path != null),
    packageRoot,
    parameterMap,
    diagnostics
  )

  const commonSoundDir = findModularPartDirectory(commonDir, 'sound', soundSuffix)
  const presetSoundDir = findModularPartDirectory(presetDir, 'sound', soundSuffix)
  const attachmentSoundDirs = attachments
    .map((attachment) => findModularPartDirectory(attachment.absoluteDir, 'sound', soundSuffix))
    .filter((path): path is string => path != null)
  const soundDefinition = mergeSoundDefinitions(
    [commonSoundDir, ...attachmentSoundDirs, presetSoundDir]
      .filter((path): path is string => path != null)
      .map((path) => parseModularSoundDefinition(path, packageRoot, diagnostics))
      .filter((definition): definition is SoundDefinition => definition != null)
  )

  const textureDir =
    findModularPartDirectory(presetDir, 'texture', textureSuffix) ??
    findModularPartDirectory(commonDir, 'texture', textureSuffix)

  return {
    id: `${basename(presetDir)}:${variant.section.toLowerCase()}`,
    order: variant.order,
    title: rawConfig.title,
    uiType: rawConfig.ui_type,
    uiVariation: rawConfig.ui_variation,
    isUserSelectable: parseIniBoolean(rawConfig.isuserselectable),
    isFlyable: parseIniBoolean(rawConfig.isflyable),
    rawConfig,
    references: {
      model: modelDefinitions.at(-1)
        ? {
            directory: modelDefinitions.at(-1)!.directory,
            sourceAircraft: toPortableRelativePath(packageRoot, presetDir)
          }
        : undefined,
      panel: panelDefinition
        ? {
            directory: panelDefinition.directory,
            sourceAircraft: toPortableRelativePath(packageRoot, presetDir)
          }
        : undefined,
      sound: soundDefinition
        ? {
            directory: soundDefinition.directory,
            sourceAircraft: toPortableRelativePath(packageRoot, presetDir)
          }
        : undefined,
      texture: textureDir
        ? {
            directory: toPortableRelativePath(packageRoot, textureDir),
            sourceAircraft: toPortableRelativePath(packageRoot, presetDir)
          }
        : undefined
    },
    resolved: {
      model: mergeModelDefinitions(modelDefinitions),
      panel: panelDefinition,
      sound: soundDefinition
    }
  }
}

function buildAircraftConfigSnapshotFromParsed(
  parsedConfig: ParsedIniFile,
  packageRoot: string
): AircraftConfigSnapshot {
  return {
    path: toPortableRelativePath(packageRoot, parsedConfig.path),
    version: getSection(parsedConfig, 'version')?.values ?? {},
    general: getSection(parsedConfig, 'general')?.values ?? {},
    variation: getSection(parsedConfig, 'variation')?.values ?? {},
    variants: getVariantSections(parsedConfig)
  }
}

function findModularPartDirectory(
  rootDir: string,
  kind: 'model' | 'panel' | 'sound' | 'texture',
  suffix: string | undefined
): string | undefined {
  const normalizedSuffix = suffix?.trim()
  const candidates = normalizedSuffix ? [`${kind}.${normalizedSuffix}`, kind] : [kind]
  for (const candidate of candidates) {
    const resolved = findCaseInsensitiveChild(rootDir, candidate)
    if (resolved && statSync(resolved).isDirectory()) {
      return resolved
    }
  }
  return undefined
}

function parseModularModelDefinition(
  directory: string,
  packageRoot: string,
  diagnostics: ImportDiagnostic[]
): ModelDefinition | undefined {
  return getOrParseModelDefinition(directory, packageRoot, diagnostics, new Map())
}

function mergeModelDefinitions(definitions: ModelDefinition[]): ModelDefinition | undefined {
  if (definitions.length === 0) return undefined

  const mergedDocuments = new Map<string, ModelDocumentDescriptor>()
  const mergedOptions: Record<string, string> = {}
  const mergedEntries: Record<string, string> = {}

  for (const definition of definitions) {
    Object.assign(mergedOptions, definition.options)
    Object.assign(mergedEntries, definition.entries)
    for (const document of definition.documents) {
      mergedDocuments.set(`${document.role}:${document.path}`, document)
    }
  }

  const tail = definitions.at(-1)!
  return {
    directory: tail.directory,
    configPath: tail.configPath,
    options: mergedOptions,
    entries: mergedEntries,
    documents: [...mergedDocuments.values()]
  }
}

function mergeModularPanelDefinitions(
  directories: string[],
  packageRoot: string,
  parameterMap: Record<string, string>,
  diagnostics: ImportDiagnostic[]
): PanelDefinition | undefined {
  if (directories.length === 0) return undefined

  const panelCfgFiles = directories
    .map((directory) => findCaseInsensitiveChild(directory, 'panel.cfg'))
    .filter((path): path is string => path != null)
    .map((path) => parseIniFile(path))
  const mergedPanelCfg = panelCfgFiles.length > 0 ? mergeIniFiles(panelCfgFiles) : undefined
  const panelXmlStrings = directories
    .map((directory) => findCaseInsensitiveChild(directory, 'panel.xml'))
    .filter((path): path is string => path != null)
    .map((path) => readFileSync(path, 'utf8'))

  if (!mergedPanelCfg && panelXmlStrings.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'modular_panel_missing',
      message: 'Could not resolve any modular panel definitions.',
      file: toPortableRelativePath(packageRoot, directories.at(-1)!)
    })
    return undefined
  }

  return {
    directory: toPortableRelativePath(packageRoot, directories.at(-1)!),
    configPath: mergedPanelCfg ? toPortableRelativePath(packageRoot, mergedPanelCfg.path) : undefined,
    xmlPath: panelXmlStrings.length > 0
      ? toPortableRelativePath(
          packageRoot,
          findCaseInsensitiveChild(directories.at(-1)!, 'panel.xml') ?? join(directories.at(-1)!, 'panel.xml')
        )
      : undefined,
    gauges: mergedPanelCfg ? parsePanelConfigFromParsed(mergedPanelCfg, parameterMap) : [],
    instruments: panelXmlStrings.flatMap((xml) => parsePanelInstruments(xml)),
    soundSourceNode: panelXmlStrings
      .map((xml) => readFirstTagText(xml, 'SoundSourceNode'))
      .findLast((value) => value != null)
  }
}

function parseModularSoundDefinition(
  directory: string,
  packageRoot: string,
  diagnostics: ImportDiagnostic[]
): SoundDefinition | undefined {
  return getOrParseSoundDefinition(directory, packageRoot, diagnostics, new Map())
}

function mergeSoundDefinitions(definitions: SoundDefinition[]): SoundDefinition | undefined {
  if (definitions.length === 0) return undefined

  const tail = definitions.at(-1)!
  const packages = new Map<string, SoundDefinition['packages'][number]>()
  const variables = new Map<string, SoundVariableDescriptor>()
  const entries = new Map<string, SoundEntryDescriptor>()
  const triggerCounts: Record<string, number> = {}

  for (const definition of definitions) {
    for (const pkg of definition.packages) {
      packages.set(`${pkg.kind}:${pkg.name}`, pkg)
    }
    for (const variable of definition.variables) {
      variables.set(`${variable.source}:${variable.name}:${variable.unit ?? ''}:${variable.index ?? ''}`, variable)
    }
    for (const entry of definition.entries) {
      entries.set(`${entry.category}:${entry.eventName ?? ''}:${entry.nodeName ?? ''}`, entry)
    }
    for (const [category, count] of Object.entries(definition.triggerCounts)) {
      triggerCounts[category] = (triggerCounts[category] ?? 0) + count
    }
  }

  return {
    directory: tail.directory,
    xmlPath: tail.xmlPath,
    packages: [...packages.values()],
    triggerCounts,
    variables: [...variables.values()],
    entries: [...entries.values()]
  }
}

function discoverAircraftSources(packageRoot: string, diagnostics: ImportDiagnostic[]): AircraftSource[] {
  const airPlanesDir = resolveCaseInsensitivePath(packageRoot, 'SimObjects/AirPlanes')
  if (!airPlanesDir || !statSync(airPlanesDir).isDirectory()) {
    throw new Error(`Missing SimObjects/AirPlanes under package root: ${packageRoot}`)
  }

  const discovered = new Map<string, AircraftSource>()
  for (const entry of readdirSync(airPlanesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const aircraftDir = join(airPlanesDir, entry.name)
    const aircraftCfgPath = findCaseInsensitiveChild(aircraftDir, 'aircraft.cfg')
    if (!aircraftCfgPath) continue

    const parsedConfig = parseIniFile(aircraftCfgPath)
    discovered.set(aircraftDir, {
      absoluteDir: aircraftDir,
      relativeDir: toPortableRelativePath(packageRoot, aircraftDir),
      configPath: aircraftCfgPath,
      parsedConfig,
      containerChain: [aircraftDir]
    })
  }

  for (const source of discovered.values()) {
    const baseContainer = getSection(source.parsedConfig, 'variation')?.values.base_container
    if (!baseContainer) continue

    const resolvedBase = resolveCaseInsensitivePath(source.absoluteDir, baseContainer)
    if (!resolvedBase || !existsSync(resolvedBase) || !statSync(resolvedBase).isDirectory()) {
      diagnostics.push({
        severity: 'warning',
        code: 'base_container_missing',
        message: `Could not resolve base_container "${baseContainer}".`,
        file: source.relativeDir,
        aircraftId: basename(source.absoluteDir)
      })
      continue
    }

    source.baseContainerDir = resolvedBase
  }

  for (const source of discovered.values()) {
    source.containerChain = buildContainerChain(source, discovered, diagnostics)
  }

  return [...discovered.values()].sort((left, right) => left.relativeDir.localeCompare(right.relativeDir))
}

function buildContainerChain(
  source: AircraftSource,
  discovered: Map<string, AircraftSource>,
  diagnostics: ImportDiagnostic[]
): string[] {
  const chain: string[] = []
  const visited = new Set<string>()
  let cursor: AircraftSource | undefined = source

  while (cursor) {
    if (visited.has(cursor.absoluteDir)) {
      diagnostics.push({
        severity: 'error',
        code: 'base_container_cycle',
        message: `Detected a base_container cycle while resolving ${basename(source.absoluteDir)}.`,
        aircraftId: basename(source.absoluteDir)
      })
      break
    }

    visited.add(cursor.absoluteDir)
    chain.push(cursor.absoluteDir)

    if (!cursor.baseContainerDir) break
    const nextBaseDir = cursor.baseContainerDir
    const nextSource = discovered.get(nextBaseDir)
    if (!nextSource) {
      diagnostics.push({
        severity: 'warning',
        code: 'base_container_external',
        message: 'base_container resolves outside the imported package and cannot be normalized yet.',
        aircraftId: basename(source.absoluteDir),
        file: toPortablePath(nextBaseDir)
      })
      break
    }

    cursor = nextSource
  }

  return chain
}

function getOrParseModelDefinition(
  directory: string,
  packageRoot: string,
  diagnostics: ImportDiagnostic[],
  cache: Map<string, ModelDefinition>
): ModelDefinition | undefined {
  const cached = cache.get(directory)
  if (cached) return cached

  const configPath = findCaseInsensitiveChild(directory, 'model.cfg')
  if (!configPath) {
    diagnostics.push({
      severity: 'warning',
      code: 'model_cfg_missing',
      message: 'Resolved model directory is missing model.cfg.',
      file: toPortableRelativePath(packageRoot, directory)
    })
    return undefined
  }

  const parsed = parseIniFile(configPath)
  const modelEntries = getSection(parsed, 'models')?.values ?? {}
  const modelOptions = getSection(parsed, 'model.options')?.values ?? {}
  const documents: ModelDocumentDescriptor[] = []

  for (const [role, relativePath] of Object.entries(modelEntries)) {
    if (!relativePath) continue

    const modelDocumentPath = resolveCaseInsensitivePath(directory, relativePath)
    if (!modelDocumentPath || !existsSync(modelDocumentPath)) {
      diagnostics.push({
        severity: 'warning',
        code: 'model_document_missing',
        message: `Model document "${relativePath}" could not be resolved.`,
        file: toPortableRelativePath(packageRoot, configPath)
      })
      continue
    }

    documents.push(parseModelDocument(modelDocumentPath, role, packageRoot))
  }

  const definition: ModelDefinition = {
    directory: toPortableRelativePath(packageRoot, directory),
    configPath: toPortableRelativePath(packageRoot, configPath),
    options: modelOptions,
    entries: modelEntries,
    documents
  }

  cache.set(directory, definition)
  return definition
}

function getOrParsePanelDefinition(
  directory: string,
  packageRoot: string,
  diagnostics: ImportDiagnostic[],
  cache: Map<string, PanelDefinition>
): PanelDefinition | undefined {
  const cached = cache.get(directory)
  if (cached) return cached

  const panelCfgPath = findCaseInsensitiveChild(directory, 'panel.cfg')
  const panelXmlPath = findCaseInsensitiveChild(directory, 'panel.xml')

  if (!panelCfgPath && !panelXmlPath) {
    diagnostics.push({
      severity: 'warning',
      code: 'panel_definition_missing',
      message: 'Resolved panel directory is missing panel.cfg and panel.xml.',
      file: toPortableRelativePath(packageRoot, directory)
    })
    return undefined
  }

  const gauges = panelCfgPath ? parsePanelConfig(panelCfgPath) : []
  const panelXml = panelXmlPath ? readFileSync(panelXmlPath, 'utf8') : ''

  const definition: PanelDefinition = {
    directory: toPortableRelativePath(packageRoot, directory),
    configPath: panelCfgPath ? toPortableRelativePath(packageRoot, panelCfgPath) : undefined,
    xmlPath: panelXmlPath ? toPortableRelativePath(packageRoot, panelXmlPath) : undefined,
    gauges,
    instruments: panelXml ? parsePanelInstruments(panelXml) : [],
    soundSourceNode: panelXml ? readFirstTagText(panelXml, 'SoundSourceNode') : undefined
  }

  cache.set(directory, definition)
  return definition
}

function getOrParseSoundDefinition(
  directory: string,
  packageRoot: string,
  diagnostics: ImportDiagnostic[],
  cache: Map<string, SoundDefinition>
): SoundDefinition | undefined {
  const cached = cache.get(directory)
  if (cached) return cached

  const soundXmlPath = findCaseInsensitiveChild(directory, 'sound.xml')
  if (!soundXmlPath) {
    diagnostics.push({
      severity: 'warning',
      code: 'sound_xml_missing',
      message: 'Resolved sound directory is missing sound.xml.',
      file: toPortableRelativePath(packageRoot, directory)
    })
    return undefined
  }

  const soundXml = readFileSync(soundXmlPath, 'utf8')
  const definition: SoundDefinition = {
    directory: toPortableRelativePath(packageRoot, directory),
    xmlPath: toPortableRelativePath(packageRoot, soundXmlPath),
    packages: parseSoundPackages(soundXml),
    triggerCounts: parseSoundTriggerCounts(soundXml),
    variables: parseSoundVariables(soundXml),
    entries: parseSoundEntries(soundXml)
  }

  cache.set(directory, definition)
  return definition
}

function resolveReferenceDirectory(
  kind: 'model' | 'panel' | 'sound' | 'texture',
  suffix: string | undefined,
  source: AircraftSource,
  packageRoot: string,
  diagnostics: ImportDiagnostic[]
): ResolvedDirectoryReference | undefined {
  const normalizedSuffix = suffix?.trim()
  const directoryName = normalizedSuffix ? `${kind}.${normalizedSuffix}` : kind

  for (const containerDir of source.containerChain) {
    const candidate = resolveCaseInsensitivePath(containerDir, directoryName)
    if (candidate && existsSync(candidate) && statSync(candidate).isDirectory()) {
      return {
        directory: toPortableRelativePath(packageRoot, candidate),
        sourceAircraft: toPortableRelativePath(packageRoot, containerDir)
      }
    }
  }

  if (kind === 'texture' && !normalizedSuffix) {
    return undefined
  }

  diagnostics.push({
    severity: 'warning',
    code: `${kind}_directory_missing`,
    message: `Could not resolve ${kind} directory "${directoryName}".`,
    aircraftId: basename(source.absoluteDir),
    file: source.relativeDir
  })

  return undefined
}

function collectAssetFiles(packageRoot: string): DiscoveredAssetFile[] {
  const files: DiscoveredAssetFile[] = []
  const stack = [packageRoot]

  while (stack.length > 0) {
    const currentDir = stack.pop()
    if (!currentDir) continue

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        stack.push(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      const stats = statSync(absolutePath)
      files.push({
        path: toPortableRelativePath(packageRoot, absolutePath),
        kind: classifyAsset(absolutePath, packageRoot),
        extension: extname(entry.name).toLowerCase(),
        byteLength: stats.size,
        mtimeMs: stats.mtimeMs
      })
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path))
  return files
}

function classifyAsset(absolutePath: string, packageRoot: string): AssetKind {
  const portablePath = toPortableRelativePath(packageRoot, absolutePath).toLowerCase()
  const extension = extname(absolutePath).toLowerCase()

  if (portablePath.startsWith('modelbehaviordefs/')) return 'behavior'
  if (portablePath.startsWith('html_ui/')) return 'instrument'
  if (portablePath.startsWith('effects/')) return 'effect'
  if (portablePath.includes('/panel/')) return 'panel'
  if (portablePath.includes('/sound/')) return 'sound'
  if (portablePath.includes('/texture') || ['.dds', '.png', '.jpg', '.jpeg', '.ktx2', '.bmp', '.svg'].includes(extension)) {
    return 'texture'
  }
  if (['.gltf', '.glb', '.bin'].includes(extension)) return 'model'
  if (['.xml', '.cfg', '.json', '.flt', '.loc'].includes(extension)) return 'config'
  return 'other'
}

function toAssetManifest(files: DiscoveredAssetFile[]): PackageAssetManifest {
  const countsByKind: Partial<Record<AssetKind, number>> = {}
  for (const file of files) {
    countsByKind[file.kind] = (countsByKind[file.kind] ?? 0) + 1
  }

  return {
    files: files.map(({ mtimeMs: _mtimeMs, ...file }) => file),
    countsByKind
  }
}

function buildCacheKey(files: DiscoveredAssetFile[]): string {
  const hash = createHash('sha256')
  hash.update(PACKAGE_IMPORT_SCHEMA_VERSION)
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(String(file.byteLength))
    hash.update('\0')
    hash.update(String(Math.trunc(file.mtimeMs)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function readPackageMetadata(packageRoot: string, diagnostics: ImportDiagnostic[]): PackageMetadata | undefined {
  const manifestPath =
    findCaseInsensitiveChild(packageRoot, 'manifest.json') ??
    findCaseInsensitiveChild(packageRoot, 'manifest-base.json')
  const layoutPath = findCaseInsensitiveChild(packageRoot, 'layout.json')

  if (!manifestPath && !layoutPath) return undefined

  let manifest: Record<string, unknown> | undefined
  if (manifestPath) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'manifest_parse_failed',
        message: `Could not parse package manifest: ${(error as Error).message}`,
        file: toPortableRelativePath(packageRoot, manifestPath)
      })
    }
  }

  return {
    manifestPath: manifestPath ? toPortableRelativePath(packageRoot, manifestPath) : undefined,
    layoutPath: layoutPath ? toPortableRelativePath(packageRoot, layoutPath) : undefined,
    title: toOptionalString(manifest?.title),
    creator: toOptionalString(manifest?.creator),
    contentType: toOptionalString(manifest?.content_type),
    manufacturer: toOptionalString(manifest?.manufacturer),
    minimumGameVersion: toOptionalString(manifest?.minimum_game_version),
    dependencies: Array.isArray(manifest?.dependencies)
      ? manifest.dependencies
          .map((dependency) => toDependencyRecord(dependency))
          .filter((dependency): dependency is { name: string; version?: string } => dependency !== undefined)
      : []
  }
}

function parseModelDocument(modelDocumentPath: string, role: string, packageRoot: string): ModelDocumentDescriptor {
  const xml = readFileSync(modelDocumentPath, 'utf8')
  const lods = [...xml.matchAll(/<LOD\b([^>]*)\/?>/gi)].map((match) => {
    const attributes = parseXmlAttributes(match[1] ?? '')
    return {
      modelFile: attributes.ModelFile ?? '',
      minSize: parseOptionalNumber(attributes.minSize)
    }
  })

  const behaviorIncludes = [...xml.matchAll(/<Include\b([^>]*)\/?>/gi)]
    .map((match) => parseXmlAttributes(match[1] ?? ''))
    .flatMap((attributes) => {
      const includes: ModelDocumentDescriptor['behaviorIncludes'] = []
      if (attributes.ModelBehaviorFile) {
        includes.push({ attribute: 'ModelBehaviorFile', target: attributes.ModelBehaviorFile })
      }
      if (attributes.Path) {
        includes.push({ attribute: 'Path', target: attributes.Path })
      }
      return includes
    })

  const nodeAnimations = [...xml.matchAll(/<NodeAnimation\b([^>]*)>([\s\S]*?)<\/NodeAnimation>/gi)].map((match) => {
    const attributes = parseXmlAttributes(match[1] ?? '')
    const nodeCount = [...(match[2] ?? '').matchAll(/<Node(?:\s[^>]*)?>/gi)].length
    return {
      type: attributes.type ?? 'Unknown',
      nodeCount
    }
  })

  return {
    role,
    path: toPortableRelativePath(packageRoot, modelDocumentPath),
    lods: lods.filter((lod) => lod.modelFile.length > 0),
    behaviorIncludes,
    nodeAnimations
  }
}

function parsePanelConfig(panelCfgPath: string): PanelDefinition['gauges'] {
  const parsed = parseIniFile(panelCfgPath)
  return parsePanelConfigFromParsed(parsed, {})
}

function parsePanelConfigFromParsed(
  parsed: ParsedIniFile,
  parameterMap: Record<string, string>
): PanelDefinition['gauges'] {
  const gauges: PanelDefinition['gauges'] = []

  for (const section of parsed.sections) {
    const normalizedSection = section.normalizedName
    const isVcockpit = normalizedSection.startsWith('vcockpit')
    const isPainting = normalizedSection.startsWith('vpainting')
    if (!isVcockpit && !isPainting) continue

    const kind = isPainting ? 'painting' : 'htmlgauge'
    for (const [key, rawValue] of Object.entries(section.values)) {
      if (kind === 'htmlgauge' && !key.startsWith('htmlgauge')) continue
      if (kind === 'painting' && !key.startsWith('painting')) continue

      const substitutedValue = substitutePanelParameters(rawValue, parameterMap)
      const parts = substitutedValue.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
      const resource = parts.shift() ?? ''
      const rect = parts.map((part) => Number.parseFloat(part)).filter((value) => Number.isFinite(value))

      gauges.push({
        section: section.name,
        key,
        kind,
        resource,
        rect,
        raw: substitutedValue
      })
    }
  }

  return gauges
}

function parsePanelInstruments(panelXml: string): PanelDefinition['instruments'] {
  return [...panelXml.matchAll(/<Instrument\b[^>]*>([\s\S]*?)<\/Instrument>/gi)].map((match) => {
    const instrumentXml = match[1] ?? ''
    const electricSimvars: PanelDefinition['instruments'][number]['electricSimvars'] = []

    for (const simvarMatch of instrumentXml.matchAll(/<Simvar\b([^>]*)\/?>/gi)) {
      const attributes = parseXmlAttributes(simvarMatch[1] ?? '')
      electricSimvars.push({
        namespace: 'simvar',
        name: attributes.name ?? '',
        unit: attributes.unit
      })
    }

    return {
      name: readFirstTagText(instrumentXml, 'Name') ?? 'UnknownInstrument',
      alwaysUpdate: parseTruthyText(readFirstTagText(instrumentXml, 'AlwaysUpdate')),
      electricSimvars: electricSimvars.filter((reference) => reference.name.length > 0)
    }
  })
}

function parseSoundPackages(soundXml: string): SoundDefinition['packages'] {
  const packages: SoundDefinition['packages'] = []

  for (const match of soundXml.matchAll(/<MainPackage\b([^>]*)\/?>/gi)) {
    const attributes = parseXmlAttributes(match[1] ?? '')
    if (attributes.Name) {
      packages.push({ kind: 'main', name: attributes.Name })
    }
  }

  for (const match of soundXml.matchAll(/<AdditionalPackage\b([^>]*)\/?>/gi)) {
    const attributes = parseXmlAttributes(match[1] ?? '')
    if (attributes.Name) {
      packages.push({ kind: 'additional', name: attributes.Name })
    }
  }

  return packages
}

function parseSoundTriggerCounts(soundXml: string): Record<string, number> {
  const triggerCounts: Record<string, number> = {}

  for (const match of soundXml.matchAll(/<([A-Za-z0-9_]+Sounds)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const category = match[1] ?? 'UnknownSounds'
    const block = match[2] ?? ''
    triggerCounts[category] = [...block.matchAll(/<Sound\b/gi)].length
  }

  return triggerCounts
}

function parseSoundVariables(soundXml: string): SoundVariableDescriptor[] {
  const variables = new Map<string, SoundVariableDescriptor>()
  for (const entry of parseSoundEntries(soundXml)) {
    if (entry.sourceVariable) {
      const descriptor = entry.sourceVariable
      variables.set(`source:${descriptor.source}:${descriptor.name}:${descriptor.unit ?? ''}:${descriptor.index ?? ''}`, descriptor)
    }
    for (const requirement of entry.requires) {
      variables.set(
        `require:${requirement.source}:${requirement.name}:${requirement.unit ?? ''}:${requirement.index ?? ''}`,
        {
          source: requirement.source,
          name: requirement.name,
          unit: requirement.unit,
          index: requirement.index
        }
      )
    }
    for (const rtpc of entry.rtpcs) {
      variables.set(`rtpc:${rtpc.source}:${rtpc.name}:${rtpc.unit ?? ''}:${rtpc.index ?? ''}`, {
        source: rtpc.source,
        name: rtpc.name,
        unit: rtpc.unit,
        index: rtpc.index
      })
    }
  }

  return [...variables.values()]
}

function parseSoundEntries(soundXml: string): SoundEntryDescriptor[] {
  const document = parseXmlDocument(soundXml)
  const root = getElementChildren(document)[0] ?? document
  const entries: SoundEntryDescriptor[] = []

  for (const categoryNode of getElementChildren(root)) {
    if (!categoryNode.name.endsWith('Sounds')) continue
    for (const soundNode of getElementChildren(categoryNode)) {
      if (soundNode.name !== 'Sound') continue

      entries.push({
        category: categoryNode.name,
        eventName: soundNode.attributes.WwiseEvent,
        continuous: parseTruthyText(soundNode.attributes.Continuous) ?? false,
        viewpoint: soundNode.attributes.ViewPoint,
        nodeName: soundNode.attributes.NodeName,
        coneHeading: parseOptionalNumber(soundNode.attributes.ConeHeading),
        sourceVariable: readSoundVariableFromAttributes(soundNode.attributes),
        range: readSoundRange(soundNode),
        requires: getElementChildren(soundNode)
          .filter((child) => child.name === 'Requires')
          .map((child) => readSoundCondition(child))
          .filter((condition): condition is SoundConditionDescriptor => condition != null),
        rtpcs: getElementChildren(soundNode)
          .filter((child) => child.name === 'WwiseRTPC')
          .map((child) => readSoundRtpc(child))
          .filter((rtpc): rtpc is SoundRtpcDescriptor => rtpc != null)
      })
    }
  }

  return entries
}

function readSoundVariableFromAttributes(
  attributes: Record<string, string>
): SoundVariableDescriptor | undefined {
  if (attributes.SimVar) {
    return {
      source: 'SimVar',
      name: attributes.SimVar,
      unit: attributes.Units,
      index: parseOptionalNumber(attributes.Index)
    }
  }
  if (attributes.LocalVar) {
    return {
      source: 'LocalVar',
      name: attributes.LocalVar,
      unit: attributes.Units,
      index: parseOptionalNumber(attributes.Index)
    }
  }
  return undefined
}

function readSoundRange(node: XmlElementNode): SoundRangeDescriptor | undefined {
  const rangeNode = getElementChildren(node).find((child) => child.name === 'Range')
  if (!rangeNode) return undefined

  return {
    lowerBound: parseOptionalNumber(rangeNode.attributes.LowerBound),
    upperBound: parseOptionalNumber(rangeNode.attributes.UpperBound)
  }
}

function readSoundCondition(node: XmlElementNode): SoundConditionDescriptor | undefined {
  const variable = readSoundVariableFromAttributes(node.attributes)
  if (!variable) return undefined
  return {
    ...variable,
    range: readSoundRange(node)
  }
}

function readSoundRtpc(node: XmlElementNode): SoundRtpcDescriptor | undefined {
  const variable = readSoundVariableFromAttributes(node.attributes)
  if (!variable || !node.attributes.RTPCName) return undefined
  return {
    ...variable,
    rtpcName: node.attributes.RTPCName,
    derived: parseTruthyText(node.attributes.Derived),
    attackTime: parseOptionalNumber(node.attributes.RTPCAttackTime),
    releaseTime: parseOptionalNumber(node.attributes.RTPCReleaseTime)
  }
}

function substitutePanelParameters(
  source: string,
  parameterMap: Record<string, string>
): string {
  return source.replaceAll(/\[([^\]]+)\]/g, (_match, key: string) => parameterMap[key] ?? `[${key}]`)
}

function parseIniFile(filePath: string): ParsedIniFile {
  const text = readFileSync(filePath, 'utf8')
  const sections: ParsedIniSection[] = []
  let currentSection: ParsedIniSection | undefined

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripIniComment(rawLine).trim()
    if (!line) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = {
        name: line.slice(1, -1).trim(),
        normalizedName: line.slice(1, -1).trim().toLowerCase(),
        values: {}
      }
      sections.push(currentSection)
      continue
    }

    const separatorIndex = line.indexOf('=')
    if (separatorIndex < 0 || !currentSection) continue

    const key = line.slice(0, separatorIndex).trim().toLowerCase()
    const value = normalizeIniValue(line.slice(separatorIndex + 1))
    currentSection.values[key] = value
  }

  return { path: filePath, sections }
}

function createEmptyIniFile(filePath: string): ParsedIniFile {
  return {
    path: filePath,
    sections: []
  }
}

function mergeIniFiles(files: ParsedIniFile[]): ParsedIniFile {
  if (files.length === 0) {
    return createEmptyIniFile('merged.cfg')
  }

  const mergedSectionMap = new Map<string, ParsedIniSection>()

  for (const file of files) {
    for (const section of file.sections) {
      const existing = mergedSectionMap.get(section.normalizedName)
      if (!existing) {
        mergedSectionMap.set(section.normalizedName, {
          name: section.name,
          normalizedName: section.normalizedName,
          values: { ...section.values }
        })
        continue
      }

      for (const [key, value] of Object.entries(section.values)) {
        const indexedMatch = key.match(/^(.+)\.([0-9]+)$/)
        if (!indexedMatch) {
          existing.values[key] = value
          continue
        }

        let nextIndex = 0
        while (existing.values[`${indexedMatch[1]}.${nextIndex}`] !== undefined) {
          nextIndex += 1
        }
        existing.values[`${indexedMatch[1]}.${nextIndex}`] = value
      }
    }
  }

  return {
    path: files.at(-1)!.path,
    sections: [...mergedSectionMap.values()]
  }
}

function stripIniComment(line: string): string {
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (character === ';' && !inQuotes) {
      return line.slice(0, index)
    }
  }

  return line
}

function normalizeIniValue(rawValue: string): string {
  const trimmed = rawValue.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function getSection(parsed: ParsedIniFile, sectionName: string): ParsedIniSection | undefined {
  const normalizedName = sectionName.toLowerCase()
  return parsed.sections.find((section) => section.normalizedName === normalizedName)
}

function getVariantSections(parsed: ParsedIniFile): AircraftVariantConfigSnapshot[] {
  return parsed.sections
    .filter((section) => section.normalizedName.startsWith('fltsim.'))
    .map((section) => ({
      section: section.name,
      order: parseVariantOrder(section.name),
      raw: section.values
    }))
    .sort((left, right) => left.order - right.order)
}

function parseVariantOrder(sectionName: string): number {
  const match = sectionName.match(/\.([0-9]+)$/)
  if (!match) return Number.MAX_SAFE_INTEGER
  return Number.parseInt(match[1], 10)
}

function resolveCaseInsensitivePath(rootDir: string, relativePath: string): string | undefined {
  let currentPath = rootDir
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0)

  for (const segment of segments) {
    if (segment === '.') continue
    if (segment === '..') {
      currentPath = dirname(currentPath)
      continue
    }

    if (!existsSync(currentPath) || !statSync(currentPath).isDirectory()) return undefined
    const directPath = join(currentPath, segment)
    if (existsSync(directPath)) {
      currentPath = directPath
      continue
    }

    const matchedEntry = readdirSync(currentPath).find(
      (entry) => entry.toLowerCase() === segment.toLowerCase()
    )
    if (!matchedEntry) return undefined

    currentPath = join(currentPath, matchedEntry)
  }

  return currentPath
}

function findCaseInsensitiveChild(rootDir: string, fileName: string): string | undefined {
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) return undefined

  const directPath = join(rootDir, fileName)
  if (existsSync(directPath)) return directPath

  const matchedEntry = readdirSync(rootDir).find((entry) => entry.toLowerCase() === fileName.toLowerCase())
  return matchedEntry ? join(rootDir, matchedEntry) : undefined
}

function parseXmlAttributes(attributeSource: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of attributeSource.matchAll(/([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? '')
  }
  return attributes
}

function readFirstTagText(xml: string, tagName: string): string | undefined {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'i'))
  return match?.[1]?.trim()
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseIniBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  return undefined
}

function parseTruthyText(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function toDependencyRecord(value: unknown): { name: string; version?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name.length === 0) return undefined
  return {
    name: record.name,
    version: typeof record.package_version === 'string' ? record.package_version : undefined
  }
}

function toPortableRelativePath(rootDir: string, absolutePath: string): string {
  return toPortablePath(relative(rootDir, absolutePath))
}

function toPortablePath(value: string): string {
  return value.replaceAll('\\', '/')
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}
