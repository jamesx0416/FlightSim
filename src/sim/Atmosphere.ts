const T0 = 288.15 // K
const P0 = 101_325 // Pa
const L = 0.0065 // K/m
const R = 287.05 // J/(kg*K)
const G0 = 9.80665 // m/s^2
const GAMMA = 1.4

export interface AtmosphereState {
  readonly temperatureK: number
  readonly pressurePa: number
  readonly densityKgPerM3: number
  readonly speedOfSoundMps: number
}

export function standardAtmosphereAtAltitudeMeters(
  altitudeMeters: number,
  options: {
    readonly temperatureOffsetCelsius?: number
    readonly seaLevelPressurePa?: number
  } = {}
): AtmosphereState {
  const h = Math.max(altitudeMeters, 0)
  const pressureScale = Math.max(options.seaLevelPressurePa ?? P0, 1) / P0
  const isaTemperatureK = h < 11_000 ? T0 - L * h : 216.65
  const temperatureK = Math.max(
    1,
    isaTemperatureK + (options.temperatureOffsetCelsius ?? 0)
  )
  const pressurePa = pressureScale * (
    h < 11_000
      ? P0 * Math.pow((T0 - L * h) / T0, G0 / (R * L))
      : 22_632.06 * Math.exp((-G0 * (h - 11_000)) / (R * 216.65))
  )
  const densityKgPerM3 = pressurePa / (R * temperatureK)

  return {
    temperatureK,
    pressurePa,
    densityKgPerM3,
    speedOfSoundMps: Math.sqrt(GAMMA * R * temperatureK),
  }
}

export function airDensityKgPerM3AtAltitudeMeters(altitudeMeters: number): number {
  return standardAtmosphereAtAltitudeMeters(altitudeMeters).densityKgPerM3
}
