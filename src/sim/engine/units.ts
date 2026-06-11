export type SimUnit =
  | 'unitless'
  | 'number'
  | 'ratio'
  | 'percent'
  | 'boolean'
  | 'seconds'
  | 'meters'
  | 'feet'
  | 'metersPerSecond'
  | 'knots'
  | 'celsius'
  | 'kelvin'

const NUMBER_UNITS = new Set<SimUnit>(['unitless', 'number'])

export class SimUnitConversionError extends Error {
  constructor(
    readonly value: number,
    readonly fromUnit: SimUnit,
    readonly toUnit: SimUnit
  ) {
    super(`Cannot convert ${value} from ${fromUnit} to ${toUnit}`)
    this.name = 'SimUnitConversionError'
  }
}

export function convertSimUnit(
  value: number,
  fromUnit: SimUnit = 'number',
  toUnit: SimUnit = 'number'
): number {
  if (fromUnit === toUnit) {
    return value
  }

  if (NUMBER_UNITS.has(fromUnit) && NUMBER_UNITS.has(toUnit)) {
    return value
  }

  if (fromUnit === 'ratio' && toUnit === 'percent') {
    return value * 100
  }

  if (fromUnit === 'percent' && toUnit === 'ratio') {
    return value / 100
  }

  if (fromUnit === 'boolean' && toUnit === 'number') {
    return value === 0 ? 0 : 1
  }

  if (fromUnit === 'number' && toUnit === 'boolean') {
    return value === 0 ? 0 : 1
  }

  if ((fromUnit === 'ratio' || fromUnit === 'percent') && toUnit === 'boolean') {
    return value === 0 ? 0 : 1
  }

  if (fromUnit === 'meters' && toUnit === 'feet') {
    return value * 3.280839895013123
  }

  if (fromUnit === 'feet' && toUnit === 'meters') {
    return value / 3.280839895013123
  }

  if (fromUnit === 'metersPerSecond' && toUnit === 'knots') {
    return value * 1.9438444924406046
  }

  if (fromUnit === 'knots' && toUnit === 'metersPerSecond') {
    return value / 1.9438444924406046
  }

  if (fromUnit === 'celsius' && toUnit === 'kelvin') {
    return value + 273.15
  }

  if (fromUnit === 'kelvin' && toUnit === 'celsius') {
    return value - 273.15
  }

  throw new SimUnitConversionError(value, fromUnit, toUnit)
}

export function simUnitsAreCompatible(
  fromUnit: SimUnit,
  toUnit: SimUnit
): boolean {
  try {
    convertSimUnit(1, fromUnit, toUnit)
    return true
  } catch {
    return false
  }
}
