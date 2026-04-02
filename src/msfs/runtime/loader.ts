import type {
  AircraftCompatibilityDescriptor,
  CompatibilityIndexEntry
} from './descriptor.ts'

export async function loadCompatibilityIndex(): Promise<CompatibilityIndexEntry[]> {
  const response = await fetch('/msfs/compatibility/index.json')
  if (!response.ok) {
    throw new Error(`Failed to load compatibility index: ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as CompatibilityIndexEntry[]
}

export async function loadCompatibilityDescriptor(
  descriptorId: string
): Promise<AircraftCompatibilityDescriptor> {
  const response = await fetch(`/msfs/compatibility/descriptors/${encodeURIComponent(descriptorId)}.json`)
  if (!response.ok) {
    throw new Error(`Failed to load compatibility descriptor: ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as AircraftCompatibilityDescriptor
}

export function selectCompatibilityDescriptorId(
  entries: CompatibilityIndexEntry[],
  searchParams: URLSearchParams
): string | undefined {
  const requested =
    searchParams.get('msfsDescriptor') ??
    searchParams.get('msfsVariantId') ??
    searchParams.get('msfsAircraftId')

  if (requested) {
    const match = entries.find(
      (entry) =>
        entry.id === requested ||
        entry.variantId === requested ||
        entry.aircraftId === requested
    )
    if (match) return match.id
  }

  return entries[0]?.id
}
