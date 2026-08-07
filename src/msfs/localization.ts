import type { MsfsPackageSource } from './packageAssets'
import type { CockpitInteractionOperation } from '../input/cockpitInteraction'

export type MsfsLocalization = ReadonlyMap<string, string>

export async function loadMsfsLocalization(
  source: MsfsPackageSource,
  locale = navigator.language
): Promise<MsfsLocalization> {
  const available = new Map(
    source.layoutEntries
      .filter(entry => entry.path.toLowerCase().endsWith('.locpak'))
      .map(entry => [entry.path.split('/').at(-1)!.slice(0, -'.locPak'.length).toLowerCase(), entry.path] as const)
  )
  const language = locale.split('-')[0]?.toLowerCase() ?? 'en'
  const preferred = [
    'en-us',
    [...available.keys()].find(key => key === language || key.startsWith(`${language}-`)),
    locale.toLowerCase()
  ].filter((value): value is string => value != null)
  const strings = new Map<string, string>()
  for (const key of preferred) {
    const path = available.get(key)
    if (path == null) continue
    try {
      const response = await fetch(source.resolveAssetUrl(path))
      if (!response.ok) continue
      const parsed = await response.json() as {
        readonly LocalisationPackage?: { readonly Strings?: Readonly<Record<string, string>> }
      }
      for (const [id, value] of Object.entries(parsed.LocalisationPackage?.Strings ?? {})) {
        strings.set(id.toUpperCase(), value)
      }
    } catch {
      // Missing or malformed optional localization falls back to the authored key.
    }
  }
  return strings
}

export function resolveMsfsLocalizedString(
  value: string | null,
  localization: MsfsLocalization
): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  const id = trimmed.replace(/^TT:/i, '').toUpperCase()
  return localization.get(id) ?? trimmed
}

export function sanitizeMsfsTooltipText(value: string): string {
  return value.replace(/\s*\(%\(\(.*?\)\)%![^!]*![^)]*\)/gu, '').trim()
}

export interface MsfsInteractionPresentation {
  readonly title: string
  readonly description: string | null
  readonly value: string | null
  readonly actions: readonly {
    readonly operation: CockpitInteractionOperation
    readonly label: string
  }[]
  readonly actionHints: readonly {
    readonly label: string
    readonly cursor: string | null
  }[]
  readonly unavailableMessage: string
}

export interface MsfsInteractionPresentationSource {
  readonly authoredId: string | null
  readonly nodeId: string | null
  readonly tooltipTitle: string | null
  readonly tooltipDescription: string | null
  readonly tooltipStateLabels: readonly { readonly value: number; readonly label: string }[]
  readonly tooltipValueLabel: string | null
  readonly tooltipActionHints: readonly { readonly label: string; readonly cursor: string | null }[]
  readonly tooltipUnavailable: string | null
  readonly routes: readonly { readonly operation: CockpitInteractionOperation }[]
  readonly value: { readonly unit: string | null }
}

export function resolveMsfsInteractionPresentation(
  metadata: MsfsInteractionPresentationSource,
  localization: MsfsLocalization,
  options: {
    readonly value?: number | null
    readonly authoredValue?: string | null
    readonly locale?: string
  } = {}
): MsfsInteractionPresentation {
  const localizedTitle = resolveMsfsLocalizedString(metadata.tooltipTitle, localization)
  const title = sanitizeMsfsTooltipText(localizedTitle ?? '') ||
    metadata.authoredId || metadata.nodeId || 'Cockpit control'
  const localizedDescription = resolveMsfsLocalizedString(metadata.tooltipDescription, localization)
  const stateLabel = options.value == null
    ? null
    : metadata.tooltipStateLabels.find(candidate => Object.is(candidate.value, options.value))?.label ?? null
  const localizedStateLabel = resolveMsfsLocalizedString(
    stateLabel ?? metadata.tooltipValueLabel,
    localization
  )
  const authoredValue = resolveMsfsLocalizedString(options.authoredValue ?? null, localization)
  const value = authoredValue ?? localizedStateLabel ?? formatInteractionNumber(options.value, metadata.value.unit, options.locale)
  const operations = [...new Set(metadata.routes.map(route => route.operation))]
  const unavailable = resolveMsfsLocalizedString(metadata.tooltipUnavailable, localization)
  return {
    title,
    description: localizedDescription == null ? null : sanitizeMsfsTooltipText(localizedDescription) || null,
    value,
    actions: operations.map(operation => ({ operation, label: formatInteractionOperation(operation) })),
    actionHints: metadata.tooltipActionHints.map(hint => ({
      label: sanitizeMsfsTooltipText(resolveMsfsLocalizedString(hint.label, localization) ?? hint.label),
      cursor: hint.cursor
    })),
    unavailableMessage: unavailable == null ? 'Unavailable' : sanitizeMsfsTooltipText(unavailable) || 'Unavailable'
  }
}

function formatInteractionNumber(
  value: number | null | undefined,
  unit: string | null,
  locale?: string
): string | null {
  if (value == null || !Number.isFinite(value)) return null
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value)
  return unit == null || /^(?:bool|enum|number)$/iu.test(unit) ? formatted : `${formatted} ${unit}`
}

function formatInteractionOperation(operation: CockpitInteractionOperation): string {
  return operation.charAt(0).toUpperCase() + operation.slice(1)
}
