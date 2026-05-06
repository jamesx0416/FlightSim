import type { ImportedAircraft, ImportedCfgSection, ImportDiagnostic } from './types'

export type VCockpitGaugeKind = 'htmlgauge' | 'gauge' | 'wasmInstrument'

export interface PanelDimension {
  readonly width: number
  readonly height: number
  readonly raw: string
}

export interface PanelColor {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly raw: string
}

export interface VCockpitGaugeEntry {
  readonly kind: VCockpitGaugeKind
  readonly index: number
  readonly key: string
  readonly rawValue: string
  readonly source: string
  readonly x: number | null
  readonly y: number | null
  readonly width: number | null
  readonly height: number | null
  readonly extraArgs: readonly string[]
}

export interface VCockpitSurface {
  readonly panelPath: string
  readonly sectionName: string
  readonly sectionIndex: number | null
  readonly textureName: string
  readonly normalizedTextureName: string
  readonly sizeMm: PanelDimension | null
  readonly pixelSize: PanelDimension | null
  readonly backgroundColor: PanelColor | null
  readonly htmlGauges: readonly VCockpitGaugeEntry[]
  readonly gauges: readonly VCockpitGaugeEntry[]
  readonly wasmInstruments: readonly VCockpitGaugeEntry[]
}

export interface ParsedVCockpitSurfaces {
  readonly surfaces: readonly VCockpitSurface[]
  readonly diagnostics: readonly ImportDiagnostic[]
}

export function parseVCockpitSurfaces(aircraft: ImportedAircraft): ParsedVCockpitSurfaces {
  const surfaces: VCockpitSurface[] = []
  const diagnostics: ImportDiagnostic[] = []
  const panelFiles = aircraft.cfgFiles.filter(file => file.kind === 'panel')

  for (const panelFile of panelFiles) {
    for (const section of panelFile.sections) {
      const sectionMatch = /^vcockpit(\d+)$/iu.exec(section.name)
      if (sectionMatch == null) {
        continue
      }

      const textureName = normalizePanelTextureName(section.values.get('texture') ?? '')
      const sectionIndex = Number.parseInt(sectionMatch[1]!, 10)
      const sizeMm = parsePanelDimension(section.values.get('size_mm') ?? '')
      const pixelSize = parsePanelDimension(section.values.get('pixel_size') ?? '')
      const backgroundColor = parsePanelColor(section.values.get('background_color') ?? '')

      if (textureName === '') {
        diagnostics.push({
          code: 'vcockpit-missing-texture',
          severity: 'warning',
          sourcePath: panelFile.path,
          message: `${section.name} does not declare a texture target.`
        })
      }

      if (textureName !== '' && textureName !== 'NO_TEXTURE' && pixelSize == null) {
        diagnostics.push({
          code: 'vcockpit-invalid-pixel-size',
          severity: 'warning',
          sourcePath: panelFile.path,
          message: `${section.name} declares texture ${textureName} without a valid pixel_size.`
        })
      }

      surfaces.push({
        panelPath: panelFile.path,
        sectionName: section.name,
        sectionIndex: Number.isFinite(sectionIndex) ? sectionIndex : null,
        textureName,
        normalizedTextureName: normalizeSurfaceLookupName(textureName),
        sizeMm,
        pixelSize,
        backgroundColor,
        htmlGauges: collectGaugeEntries(section, 'htmlgauge'),
        gauges: collectGaugeEntries(section, 'gauge'),
        wasmInstruments: collectGaugeEntries(section, 'wasmInstrument')
      })
    }
  }

  const seenTextures = new Map<string, VCockpitSurface>()
  for (const surface of surfaces) {
    if (
      surface.normalizedTextureName === '' ||
      surface.normalizedTextureName === 'notexture'
    ) {
      continue
    }

    const previous = seenTextures.get(surface.normalizedTextureName)
    if (previous != null) {
      diagnostics.push({
        code: 'vcockpit-duplicate-texture',
        severity: 'warning',
        sourcePath: surface.panelPath,
        message: `${surface.sectionName} and ${previous.sectionName} both target ${surface.textureName}.`
      })
      continue
    }
    seenTextures.set(surface.normalizedTextureName, surface)
  }

  for (const surface of surfaces) {
    for (const gauge of surface.gauges) {
      diagnostics.push({
        code: 'vcockpit-legacy-gauge-deferred',
        severity: 'info',
        sourcePath: surface.panelPath,
        message: `${surface.sectionName} ${gauge.key} is parsed but legacy gauge hosting is not implemented yet.`
      })
    }
  }

  return { surfaces, diagnostics }
}

export function normalizeSurfaceLookupName(value: string): string {
  return value.trim().replace(/^\$/u, '').replace(/[^a-z0-9]+/giu, '').toLowerCase()
}

function collectGaugeEntries(
  section: ImportedCfgSection,
  kind: VCockpitGaugeKind
): VCockpitGaugeEntry[] {
  const prefix = kind.toLowerCase()
  const entries = [...section.values.entries()]
    .map(([key, value]) => {
      const match = new RegExp(`^${prefix}(\\d+)$`, 'iu').exec(key)
      return match == null
        ? null
        : {
            key,
            value,
            index: Number.parseInt(match[1]!, 10)
          }
    })
    .filter(entry => entry != null)
    .sort((left, right) => left.index - right.index)

  return entries.map(entry => parseGaugeEntry(kind, entry.key, entry.index, entry.value))
}

function parseGaugeEntry(
  kind: VCockpitGaugeKind,
  key: string,
  index: number,
  rawValue: string
): VCockpitGaugeEntry {
  const parts = rawValue.split(',').map(part => part.trim())
  const source = parts[0] ?? ''
  const x = parsePanelNumber(parts[1])
  const y = parsePanelNumber(parts[2])
  const width = parsePanelNumber(parts[3])
  const height = parsePanelNumber(parts[4])

  return {
    kind,
    index,
    key,
    rawValue,
    source,
    x,
    y,
    width,
    height,
    extraArgs: parts.slice(5)
  }
}

function parsePanelDimension(value: string): PanelDimension | null {
  const parts = value.split(',').map(part => Number.parseFloat(part.trim()))
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return null
  }

  return {
    width: parts[0]!,
    height: parts[1]!,
    raw: value
  }
}

function parsePanelColor(value: string): PanelColor | null {
  const parts = value.split(',').map(part => Number.parseFloat(part.trim()))
  if (parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(part))) {
    return null
  }

  return {
    r: parts[0]!,
    g: parts[1]!,
    b: parts[2]!,
    raw: value
  }
}

function parsePanelNumber(value: string | undefined): number | null {
  if (value == null || value === '') {
    return null
  }

  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizePanelTextureName(value: string): string {
  return value.trim()
}
