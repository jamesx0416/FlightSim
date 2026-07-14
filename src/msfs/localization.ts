import type { MsfsPackageSource } from './packageAssets'

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
