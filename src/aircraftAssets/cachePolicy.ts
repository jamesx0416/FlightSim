export type AircraftCacheMode = 'normal' | 'no-store' | 'no-cache' | 'immutable'

export const AIRCRAFT_CACHE_MODES: readonly AircraftCacheMode[] = [
  'normal',
  'no-store',
  'no-cache',
  'immutable'
]

declare const __FLIGHTSIM_AIRCRAFT_CACHE_MODE__: string | undefined

export function parseAircraftCacheMode(value: unknown): AircraftCacheMode {
  return typeof value === 'string' && isAircraftCacheMode(value) ? value : 'normal'
}

export function getAircraftCacheMode(): AircraftCacheMode {
  const mode =
    typeof __FLIGHTSIM_AIRCRAFT_CACHE_MODE__ === 'undefined'
      ? undefined
      : __FLIGHTSIM_AIRCRAFT_CACHE_MODE__
  return parseAircraftCacheMode(mode)
}

export function isAircraftImmutableCacheMode(): boolean {
  return getAircraftCacheMode() === 'immutable'
}

function isAircraftCacheMode(value: string): value is AircraftCacheMode {
  return (AIRCRAFT_CACHE_MODES as readonly string[]).includes(value)
}
