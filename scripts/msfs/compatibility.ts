import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import type {
  AircraftDefinition,
  ImportDiagnostic,
  NormalizedPackageImportCache,
  RuntimeVariableReference
} from '../../src/msfs/contracts.ts'
import type { CompiledBehaviorPackage } from '../../src/msfs/behavior/contracts.ts'
import { buildCompatibilityAircraftPhysicsDescriptor } from '../../src/sim/MsfsAircraftPhysics.ts'
import {
  getSourceModelFallbackIndex,
  type SourceModelFallbackIndex
} from './source-models.ts'
import {
  COMPATIBILITY_DESCRIPTOR_SCHEMA_VERSION,
  type AircraftCompatibilityDescriptor,
  type CompatibilityIndexEntry,
  type PanelSurfaceDescriptor,
  type WasmGaugeDescriptor
} from '../../src/msfs/runtime/descriptor.ts'

export interface CompatibilityDescriptorBundle {
  index: CompatibilityIndexEntry[]
  descriptors: AircraftCompatibilityDescriptor[]
  packageRootsByCacheKey: Map<string, string>
  materializedSourceRootsByCacheKey: Map<string, string>
}

export function loadCompatibilityDescriptors(
  cacheRoot = '.msfs-cache'
): CompatibilityDescriptorBundle {
  const absoluteCacheRoot = resolve(cacheRoot)
  const importCaches = loadImportCaches(absoluteCacheRoot)
  const behaviorByCacheKey = loadBehaviorPackages(absoluteCacheRoot)
  const descriptors: AircraftCompatibilityDescriptor[] = []
  const packageRootsByCacheKey = new Map<string, string>()
  const materializedSourceRootsByCacheKey = new Map<string, string>()

  for (const cache of importCaches) {
    packageRootsByCacheKey.set(cache.source.cacheKey, cache.source.packageRoot)
    const behavior = behaviorByCacheKey.get(cache.source.cacheKey)
    const sourceModelFallbackIndex = getSourceModelFallbackIndex({
      packageRoot: cache.source.packageRoot,
      cacheKey: cache.source.cacheKey,
      cacheRoot: absoluteCacheRoot
    })
    if (sourceModelFallbackIndex?.materializedRoot) {
      materializedSourceRootsByCacheKey.set(
        cache.source.cacheKey,
        sourceModelFallbackIndex.materializedRoot
      )
    }

    for (const aircraft of cache.aircraft) {
      const compiledAircraft = behavior?.aircraft.find((entry) => entry.aircraftId === aircraft.aircraftId)

      for (const variant of aircraft.variants) {
        const compiledVariant = compiledAircraft?.variants.find(
          (entry) => entry.variantId === variant.id
        )
        if (!compiledVariant) continue

        const descriptorId = `${cache.source.cacheKey}-${slugify(variant.id)}`
        const assetPaths = new Set(cache.assetManifest.files.map((file) => file.path))
        const panelSurfaces = buildPanelSurfaceDescriptors(descriptorId, cache, variant, assetPaths)
        const wasmGauges = buildWasmGaugeDescriptors(descriptorId, variant)
        const physics = buildAircraftPhysicsDescriptorForCache(cache, aircraft)
        const { modelSources, diagnostics: modelDiagnostics } = buildModelSourceDescriptors(
          cache,
          aircraft,
          variant,
          sourceModelFallbackIndex
        )
        const trackedVariables = uniqueRuntimeVariables([
          ...compiledVariant.symbols.variables,
          ...compiledVariant.symbols.writableVariables,
          ...(variant.resolved.panel?.instruments ?? []).flatMap((instrument) => instrument.electricSimvars),
          ...(variant.resolved.sound?.variables ?? []).map((variable) => ({
            namespace: variable.source === 'SimVar' ? 'simvar' : 'lvar',
            name: variable.name,
            unit: variable.unit,
            index: variable.index
          }))
        ])
        const startupVariables = buildStartupVariableDescriptors(cache, aircraft, trackedVariables)

        descriptors.push({
          schemaVersion: COMPATIBILITY_DESCRIPTOR_SCHEMA_VERSION,
          id: descriptorId,
          label: variant.title ?? variant.uiVariation ?? `${aircraft.aircraftId} ${variant.id}`,
          source: {
            backend: cache.source.backend,
            cacheKey: cache.source.cacheKey,
            packageRoot: cache.source.packageRoot,
            packageRouteRoot: `/msfs/packages/${cache.source.cacheKey}`
          },
          aircraftId: aircraft.aircraftId,
          variantId: variant.id,
          title: variant.title,
          uiType: variant.uiType,
          uiVariation: variant.uiVariation,
          trackedVariables,
          startupVariables,
          modelSources,
          physics,
          panel: variant.resolved.panel
            ? {
                configPath: variant.resolved.panel.configPath,
                xmlPath: variant.resolved.panel.xmlPath,
                surfaces: panelSurfaces,
                instruments: variant.resolved.panel.instruments
              }
            : undefined,
          wasm: {
            gauges: wasmGauges
          },
          sound: variant.resolved.sound,
          compiledBehavior: compiledVariant,
          diagnostics: collectVariantDiagnostics(
            cache.diagnostics,
            behavior?.diagnostics ?? [],
            modelDiagnostics,
            aircraft.aircraftId
          )
        })
      }
    }
  }

  descriptors.sort((left, right) => left.label.localeCompare(right.label))

  return {
    index: descriptors.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      cacheKey: descriptor.source.cacheKey,
      backend: descriptor.source.backend,
      aircraftId: descriptor.aircraftId,
      variantId: descriptor.variantId,
      title: descriptor.title,
      uiVariation: descriptor.uiVariation
    })),
    descriptors,
    packageRootsByCacheKey,
    materializedSourceRootsByCacheKey
  }
}

function loadImportCaches(cacheRoot: string): NormalizedPackageImportCache[] {
  if (!existsSync(cacheRoot)) return []
  return readdirSync(cacheRoot)
    .filter((entry) => entry.endsWith('-import.json') || entry.includes('.msfs2020-import.json') || entry.includes('.msfs2024-import.json'))
    .map((entry) => join(cacheRoot, entry))
    .filter((entry) => existsSync(entry))
    .map((filePath) =>
      JSON.parse(readFileSync(filePath, 'utf8')) as NormalizedPackageImportCache
    )
}

function loadBehaviorPackages(cacheRoot: string): Map<string, CompiledBehaviorPackage> {
  const behaviorRoot = join(cacheRoot, 'behavior')
  const packages = new Map<string, CompiledBehaviorPackage>()
  if (!existsSync(behaviorRoot)) return packages

  for (const entry of readdirSync(behaviorRoot)) {
    if (!entry.endsWith('-behavior.json') && !entry.includes('.msfs2020-behavior.json') && !entry.includes('.msfs2024-behavior.json')) {
      continue
    }

    const behaviorPackage = JSON.parse(
      readFileSync(join(behaviorRoot, entry), 'utf8')
    ) as CompiledBehaviorPackage
    packages.set(behaviorPackage.source.import.cacheKey, behaviorPackage)
  }

  return packages
}

function buildAircraftPhysicsDescriptorForCache(
  cache: NormalizedPackageImportCache,
  aircraft: AircraftDefinition
): AircraftCompatibilityDescriptor['physics'] {
  const rootsToCheck = [
    join(cache.source.packageRoot, aircraft.directory),
    ...(aircraft.baseContainer ? [join(cache.source.packageRoot, aircraft.baseContainer)] : [])
  ]

  for (const aircraftRoot of rootsToCheck) {
    const flightModelPath = join(aircraftRoot, 'flight_model.cfg')
    if (!existsSync(flightModelPath)) continue

    const enginesPath = join(aircraftRoot, 'engines.cfg')
    return buildCompatibilityAircraftPhysicsDescriptor(
      readFileSync(flightModelPath, 'utf8'),
      existsSync(enginesPath) ? readFileSync(enginesPath, 'utf8') : undefined
    )
  }

  return undefined
}

function buildStartupVariableDescriptors(
  cache: NormalizedPackageImportCache,
  aircraft: AircraftDefinition,
  trackedVariables: RuntimeVariableReference[]
): AircraftCompatibilityDescriptor['startupVariables'] {
  const aircraftRoot = join(cache.source.packageRoot, aircraft.directory)
  if (!existsSync(aircraftRoot)) return []

  const startupLocalVariables = readPreferredStartupLocalVariables(aircraftRoot)
  if (!startupLocalVariables) return []

  const descriptors: NonNullable<AircraftCompatibilityDescriptor['startupVariables']> = []
  const seenKeys = new Set<string>()

  for (const reference of trackedVariables) {
    if (reference.namespace !== 'lvar') continue
    const lookupName = normalizeStartupLocalVariableName(reference.name)
    if (!lookupName) continue

    const value = startupLocalVariables.get(lookupName)
    if (value === undefined) continue

    const key = `${reference.namespace}:${reference.name}:${reference.unit ?? ''}:${reference.index ?? ''}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    descriptors.push({ reference, value })
  }

  return descriptors
}

function buildModelSourceDescriptors(
  cache: NormalizedPackageImportCache,
  aircraft: AircraftDefinition,
  variant: AircraftDefinition['variants'][number],
  sourceModelFallbackIndex: SourceModelFallbackIndex | null
): {
  modelSources: AircraftCompatibilityDescriptor['modelSources']
  diagnostics: ImportDiagnostic[]
} {
  const modelSources: AircraftCompatibilityDescriptor['modelSources'] = []
  const diagnostics: ImportDiagnostic[] = []
  const missingModelHint = buildMissingModelHint(cache.source.packageRoot)
  const seenMissingModelPaths = new Set<string>()

  for (const document of variant.resolved.model?.documents ?? []) {
    for (const lod of document.lods) {
      const modelPath = joinPath(dirnamePortable(document.path), lod.modelFile)
      if (isPackageAssetPath(cache.source.packageRoot, modelPath)) {
        modelSources.push({
          role: document.role,
          modelPath,
          modelUrl: `/msfs/packages/${cache.source.cacheKey}/${modelPath}`,
          minSize: lod.minSize
        })
        continue
      }

      const sourceFallback = resolveSourceModelFallback(sourceModelFallbackIndex, modelPath)
      if (sourceFallback) {
        const sourceRoutePrefix = sourceFallback.materializedPath
          ? '__source_materialized__'
          : '__source__'

        modelSources.push(
          sourceFallback.materializedPath
            ? {
                role: document.role,
                modelPath,
                modelUrl: `/msfs/packages/${cache.source.cacheKey}/${sourceRoutePrefix}/${sourceFallback.materializedPath}`,
                minSize: lod.minSize,
                textureManifestUrl: `/msfs/packages/${cache.source.cacheKey}/${sourceRoutePrefix}/texture-manifest.json`
              }
            : {
                role: document.role,
                modelPath,
                modelUrl: `/msfs/packages/${cache.source.cacheKey}/${sourceRoutePrefix}/${sourceFallback.sourcePath}`,
                minSize: lod.minSize,
                normalizeSourceAsset: true,
                textureManifestUrl: `/msfs/packages/${cache.source.cacheKey}/${sourceRoutePrefix}/texture-manifest.json`
              }
        )
        continue
      }

      if (!seenMissingModelPaths.has(modelPath)) {
        seenMissingModelPaths.add(modelPath)
        diagnostics.push({
          severity: 'warning',
          code: 'model_lod_missing',
          message: `Model LOD "${modelPath}" is declared but the asset file is missing from the imported package.${missingModelHint}`,
          aircraftId: aircraft.aircraftId,
          file: modelPath,
          details: {
            modelDocument: document.path,
            role: document.role,
            minSize: lod.minSize ?? null
          }
        })
      }
    }
  }

  if ((variant.resolved.model?.documents.length ?? 0) > 0 && modelSources.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'model_assets_unavailable',
      message: `No loadable model assets were found for ${aircraft.aircraftId} in the imported package. Behavior, panel, and physics compatibility data are still available, but 3D model loading requires a built package with model assets.${missingModelHint}`,
      aircraftId: aircraft.aircraftId,
      file: aircraft.directory
    })
  }

  return { modelSources, diagnostics }
}

function resolveSourceModelFallback(
  index: SourceModelFallbackIndex | null,
  modelPath: string
): { sourcePath: string; materializedPath?: string } | undefined {
  if (!index) return undefined

  const entry = index.entriesByPackagePath.get(toPortablePath(modelPath).toLowerCase())
  if (!entry) return undefined

  if (entry.materializedPath && entry.ensureMaterialized?.()) {
    return {
      sourcePath: entry.sourcePath,
      materializedPath: entry.materializedPath
    }
  }

  return {
    sourcePath: entry.sourcePath
  }
}

function buildMissingModelHint(packageRoot: string): string {
  const portablePackageRoot = toPortablePath(packageRoot)
  const looksLikeSourceCheckout =
    portablePackageRoot.includes('/src/base/') &&
    !existsSync(join(packageRoot, 'layout.json'))

  return looksLikeSourceCheckout
    ? ' This looks like a source checkout under src/base; import the built aircraft package (for example the aircraft out directory or installed Community package) to render the 3D model.'
    : ''
}

function isPackageAssetPath(packageRoot: string, assetPath: string): boolean {
  const absolutePath = resolve(packageRoot, assetPath)
  const relativeToRoot = toPortablePath(relative(packageRoot, absolutePath))
  return (
    relativeToRoot.length > 0 &&
    !relativeToRoot.startsWith('..') &&
    !relativeToRoot.includes('/../') &&
    existsSync(absolutePath)
  )
}

function buildPanelSurfaceDescriptors(
  descriptorId: string,
  cache: NormalizedPackageImportCache,
  variant: NormalizedPackageImportCache['aircraft'][number]['variants'][number],
  assetPaths: Set<string>
): PanelSurfaceDescriptor[] {
  return (variant.resolved.panel?.gauges ?? []).map((gauge, index) => {
    const resourcePath = resolveGaugeResourcePath(gauge.resource, assetPaths)
    return {
      id: `${descriptorId}-surface-${index}`,
      section: gauge.section,
      key: gauge.key,
      kind: gauge.kind,
      resource: gauge.resource,
      resourcePath,
      resourceUrl: resourcePath
        ? `/msfs/packages/${cache.source.cacheKey}/${resourcePath}`
        : undefined,
      rect: gauge.rect,
      exists: resourcePath != null,
      hostUrl: `/panel-host.html?descriptor=${encodeURIComponent(descriptorId)}&surface=${encodeURIComponent(`${descriptorId}-surface-${index}`)}`
    }
  })
}

function buildWasmGaugeDescriptors(
  descriptorId: string,
  variant: NormalizedPackageImportCache['aircraft'][number]['variants'][number]
): WasmGaugeDescriptor[] {
  const gauges = variant.resolved.panel?.gauges ?? []
  return gauges
    .map((gauge, index) => {
      if (!gauge.resource.startsWith('WasmInstrument/')) return undefined
      const query = gauge.resource.split('?')[1] ?? ''
      const params = new URLSearchParams(query)
      const moduleName = params.get('wasm_module')
      if (!moduleName) return undefined
      const gaugeName = params.get('wasm_gauge') ?? undefined
      const id = `${descriptorId}-wasm-${index}`

      return {
        id,
        section: gauge.section,
        resource: gauge.resource,
        moduleName,
        gaugeName,
        hostUrl: `/wasm-host.html?descriptor=${encodeURIComponent(descriptorId)}&surface=${encodeURIComponent(id)}`
      }
    })
    .filter((entry): entry is WasmGaugeDescriptor => entry != null)
}

function resolveGaugeResourcePath(
  resource: string,
  assetPaths: Set<string>
): string | undefined {
  const filePart = resource.split('?')[0].replaceAll('\\', '/')
  const directCandidates = [
    `html_ui/Pages/VCockpit/Instruments/${filePart}`,
    `html_ui/Pages/${filePart}`,
    `html_ui/${filePart}`,
    filePart
  ]

  for (const candidate of directCandidates) {
    if (assetPaths.has(candidate)) {
      return candidate
    }
  }

  return [...assetPaths].find((assetPath) => assetPath.endsWith(`/${filePart}`))
}

function collectVariantDiagnostics(
  importDiagnostics: ImportDiagnostic[],
  behaviorDiagnostics: ImportDiagnostic[],
  modelDiagnostics: ImportDiagnostic[],
  aircraftId: string
): ImportDiagnostic[] {
  const unique = new Map<string, ImportDiagnostic>()

  for (const diagnostic of [...importDiagnostics, ...behaviorDiagnostics, ...modelDiagnostics]) {
    if (diagnostic.aircraftId && diagnostic.aircraftId !== aircraftId) continue
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
      diagnostic.file ?? '',
      diagnostic.aircraftId ?? ''
    ].join('::')
    if (!unique.has(key)) {
      unique.set(key, diagnostic)
    }
  }

  return [...unique.values()]
}

function uniqueRuntimeVariables(
  references: RuntimeVariableReference[]
): RuntimeVariableReference[] {
  const unique = new Map<string, RuntimeVariableReference>()
  for (const reference of references) {
    unique.set(
      `${reference.namespace}:${reference.name}:${reference.unit ?? ''}:${reference.index ?? ''}`,
      reference
    )
  }
  return [...unique.values()]
}

function readPreferredStartupLocalVariables(aircraftRoot: string): Map<string, string | number | boolean> | null {
  if (!existsSync(aircraftRoot)) return null

  const candidates = readdirSync(aircraftRoot)
    .filter((entry) => entry.toLowerCase().endsWith('.flt'))
    .sort(compareStartupFlightFiles)

  for (const entry of candidates) {
    const variables = readStartupLocalVariablesFromFlightFile(join(aircraftRoot, entry))
    if (variables.size > 0) {
      return variables
    }
  }

  return null
}

function compareStartupFlightFiles(left: string, right: string): number {
  const leftPriority = startupFlightFilePriority(left)
  const rightPriority = startupFlightFilePriority(right)
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority
  }
  return left.localeCompare(right)
}

function startupFlightFilePriority(fileName: string): number {
  const normalized = fileName.trim().toLowerCase()
  const priority = [
    'apron.flt',
    'taxi.flt',
    'runway.flt',
    'hangar.flt',
    'coldanddark.flt',
    'readytaxi.flt',
    'climb.flt',
    'cruise.flt',
    'approach.flt',
    'final.flt'
  ]
  const index = priority.indexOf(normalized)
  return index >= 0 ? index : priority.length
}

function readStartupLocalVariablesFromFlightFile(
  filePath: string
): Map<string, string | number | boolean> {
  const variables = new Map<string, string | number | boolean>()
  const text = readFileSync(filePath, 'utf8')
  let inLocalVarSection = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripFlightFileComment(rawLine).trim()
    if (!line) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      const sectionName = line.slice(1, -1).trim().toLowerCase()
      inLocalVarSection = sectionName.startsWith('localvars.')
      continue
    }

    if (!inLocalVarSection) continue

    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) continue

    const name = line.slice(0, separatorIndex).trim()
    if (!name) continue

    const value = parseStartupVariableValue(line.slice(separatorIndex + 1))
    if (value === undefined) continue

    variables.set(normalizeStartupLocalVariableName(name), value)
  }

  return variables
}

function stripFlightFileComment(line: string): string {
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

function parseStartupVariableValue(rawValue: string): string | number | boolean | undefined {
  const value = rawValue.trim()
  if (value.length === 0) return undefined

  const normalized = value.toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  if (/^-?(?:\d+|\d*\.\d+)$/.test(value)) {
    return Number.parseFloat(value)
  }

  return value
}

function normalizeStartupLocalVariableName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0) return ''
  return trimmed.replace(/^L:/i, '').toLowerCase()
}

function dirnamePortable(path: string): string {
  const portable = path.replaceAll('\\', '/')
  const index = portable.lastIndexOf('/')
  return index >= 0 ? portable.slice(0, index) : ''
}

function joinPath(left: string, right: string): string {
  return [left, right].filter((segment) => segment.length > 0).join('/')
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

function toPortablePath(value: string): string {
  return value.replaceAll('\\', '/')
}
