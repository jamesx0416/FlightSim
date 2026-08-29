import type { ImportedAircraft } from '../../msfs/types'

/** Mirrors viewer selection priorities without naming or special-casing a package. */
export function selectBenchmarkAircraft(
  aircraft: readonly ImportedAircraft[],
  requestedId?: string
): ImportedAircraft {
  if (requestedId != null) {
    const requested = aircraft.find(candidate => candidate.id === requestedId)
    if (requested == null) throw new Error(`Aircraft ${requestedId} was not found in the package.`)
    return requested
  }

  const selected = [...aircraft]
    .filter(candidate => candidate.model != null)
    .sort((left, right) => selectionScore(right) - selectionScore(left))[0]
  if (selected == null) throw new Error('The package contains no benchmarkable aircraft.')
  return selected
}

function selectionScore(aircraft: ImportedAircraft): number {
  let score = aircraft.model == null ? 0 : 100
  if (aircraft.isUserSelectable) score += 20
  if (aircraft.isFlyable) score += 20
  score += aircraft.inheritedFromPaths.length * 5
  return score
}
