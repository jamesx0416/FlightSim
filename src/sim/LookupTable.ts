export interface LookupTable1D {
  breakpoints: readonly number[]
  values: readonly number[]
}

export interface LookupTable2D {
  breakpointsX: readonly number[]
  breakpointsY: readonly number[]
  values: readonly number[]
}

// The search/extrapolation behavior here mirrors FlyByWire's generated lookup helpers
// in third_party/flybywire-aircraft so the runtime TS model behaves like the source tables.
function findSegment(value: number, breakpoints: readonly number[]): [number, number] {
  const maxIndex = breakpoints.length - 1
  if (maxIndex < 1) {
    throw new Error('lookup table requires at least two breakpoints')
  }

  if (value <= breakpoints[0]) {
    const denom = breakpoints[1] - breakpoints[0]
    return [0, denom !== 0 ? (value - breakpoints[0]) / denom : 0]
  }

  if (value >= breakpoints[maxIndex]) {
    const left = maxIndex - 1
    const denom = breakpoints[maxIndex] - breakpoints[left]
    return [left, denom !== 0 ? (value - breakpoints[left]) / denom : 0]
  }

  let left = 0
  let right = maxIndex
  let index = maxIndex >> 1

  while (right - left > 1) {
    if (value < breakpoints[index]) {
      right = index
    } else {
      left = index
    }
    index = (left + right) >> 1
  }

  const denom = breakpoints[left + 1] - breakpoints[left]
  return [left, denom !== 0 ? (value - breakpoints[left]) / denom : 0]
}

export function lookup1D(value: number, table: LookupTable1D): number {
  const { breakpoints, values } = table
  if (breakpoints.length !== values.length) {
    throw new Error('1D lookup table breakpoint/value length mismatch')
  }

  const [left, fraction] = findSegment(value, breakpoints)
  const y0 = values[left]
  return (values[left + 1] - y0) * fraction + y0
}

export function lookup2D(x: number, y: number, table: LookupTable2D): number {
  const { breakpointsX, breakpointsY, values } = table
  const width = breakpointsX.length
  const height = breakpointsY.length
  if (width < 2 || height < 2) {
    throw new Error('2D lookup table requires at least two breakpoints per axis')
  }
  if (values.length !== width * height) {
    throw new Error('2D lookup table breakpoint/value size mismatch')
  }

  const [leftX, fracX] = findSegment(x, breakpointsX)
  const [leftY, fracY] = findSegment(y, breakpointsY)
  const row0 = leftY * width + leftX
  const row1 = row0 + width

  const y00 = values[row0]
  const y01 = values[row0 + 1]
  const y10 = values[row1]
  const y11 = values[row1 + 1]

  const interp0 = (y01 - y00) * fracX + y00
  const interp1 = (y11 - y10) * fracX + y10
  return (interp1 - interp0) * fracY + interp0
}
