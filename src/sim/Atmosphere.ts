const T0 = 288.15 // K
const P0 = 101_325 // Pa
const L = 0.0065 // K/m
const R = 287.05 // J/(kg*K)
const G0 = 9.80665 // m/s^2

// ISA-ish density model (fast, good enough up to ~20 km).
export function airDensityKgPerM3AtAltitudeMeters(altitudeMeters: number): number {
  const h = Math.max(altitudeMeters, 0)
  if (h < 11_000) {
    const t = T0 - L * h
    const p = P0 * Math.pow(t / T0, G0 / (R * L))
    return p / (R * t)
  }

  const t = 216.65
  const p11 = 22_632.06
  const p = p11 * Math.exp((-G0 * (h - 11_000)) / (R * t))
  return p / (R * t)
}

