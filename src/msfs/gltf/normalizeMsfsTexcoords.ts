import { BufferGeometry, Float32BufferAttribute, Mesh, Object3D } from 'three'

const TEXCOORD_ATTRIBUTE_NAMES = ['uv', 'uv1', 'uv2', 'uv3'] as const
const MSFS_FIXED_POINT_TEXCOORD_SCALE = 16384
const FLOAT16_BUFFER = new ArrayBuffer(2)
const FLOAT16_VIEW = new DataView(FLOAT16_BUFFER)
const TEXCOORD_SAMPLE_LIMIT = 512
const FLOAT16_SANITY_LIMIT = 2
const FLOAT16_REQUIRED_SANITY_RATIO = 0.98
const FLOAT16_MINIMUM_AREA = 0.1
const FLOAT16_AREA_MULTIPLIER = 2
const FIXED_POINT_COLLAPSED_AREA_LIMIT = 0.2
const FIXED_POINT_COLLAPSED_MIN = 0.5
const FIXED_POINT_COLLAPSED_MAX = 1.05

export function normalizeMsfsTexcoords(root: Object3D): void {
  const normalizedGeometries = new WeakSet<BufferGeometry>()

  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const geometry = object.geometry
    if (geometry == null || normalizedGeometries.has(geometry)) {
      return
    }

    normalizeGeometryTexcoords(geometry)
    normalizedGeometries.add(geometry)
  })
}

function normalizeGeometryTexcoords(geometry: BufferGeometry): void {
  for (const attributeName of TEXCOORD_ATTRIBUTE_NAMES) {
    const attribute = geometry.getAttribute(attributeName)
    if (
      attribute == null ||
      !(attribute.array instanceof Int16Array) ||
      attribute.itemSize !== 2 ||
      attribute.normalized
    ) {
      continue
    }

    const decodeMode = chooseTexcoordDecodeMode(attribute)
    const converted = new Float32Array(attribute.count * attribute.itemSize)
    for (let index = 0; index < attribute.count; index += 1) {
      const destinationOffset = index * attribute.itemSize
      converted[destinationOffset] = decodeTexcoordComponent(attribute.getX(index), decodeMode)
      converted[destinationOffset + 1] = decodeTexcoordComponent(
        attribute.getY(index),
        decodeMode
      )
    }

    geometry.setAttribute(
      attributeName,
      new Float32BufferAttribute(converted, attribute.itemSize, false)
    )
  }
}

type TexcoordDecodeMode = 'fixed14' | 'float16'

type TexcoordDecodeStats = {
  area: number
  maxX: number
  maxY: number
  minX: number
  minY: number
  saneRatio: number
}

function chooseTexcoordDecodeMode(
  attribute: ReturnType<BufferGeometry['getAttribute']>
): TexcoordDecodeMode {
  const sampleCount = Math.min(attribute.count, TEXCOORD_SAMPLE_LIMIT)
  const fixedStats = createEmptyTexcoordDecodeStats()
  const float16Stats = createEmptyTexcoordDecodeStats()

  for (let index = 0; index < sampleCount; index += 1) {
    const xBits = attribute.getX(index)
    const yBits = attribute.getY(index)

    updateTexcoordDecodeStats(
      fixedStats,
      xBits / MSFS_FIXED_POINT_TEXCOORD_SCALE,
      yBits / MSFS_FIXED_POINT_TEXCOORD_SCALE
    )
    updateTexcoordDecodeStats(
      float16Stats,
      decodeFloat16Bits(xBits),
      decodeFloat16Bits(yBits)
    )
  }

  finalizeTexcoordDecodeStats(fixedStats, sampleCount)
  finalizeTexcoordDecodeStats(float16Stats, sampleCount)

  if (!shouldPreferFloat16Texcoords(fixedStats, float16Stats)) {
    return 'fixed14'
  }

  return 'float16'
}

function createEmptyTexcoordDecodeStats(): TexcoordDecodeStats {
  return {
    area: 0,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    saneRatio: 0,
  }
}

function updateTexcoordDecodeStats(
  stats: TexcoordDecodeStats,
  x: number,
  y: number
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return
  }

  stats.minX = Math.min(stats.minX, x)
  stats.maxX = Math.max(stats.maxX, x)
  stats.minY = Math.min(stats.minY, y)
  stats.maxY = Math.max(stats.maxY, y)

  if (
    Math.abs(x) <= FLOAT16_SANITY_LIMIT &&
    Math.abs(y) <= FLOAT16_SANITY_LIMIT
  ) {
    stats.saneRatio += 1
  }
}

function finalizeTexcoordDecodeStats(
  stats: TexcoordDecodeStats,
  sampleCount: number
): void {
  stats.saneRatio /= Math.max(sampleCount, 1)

  if (
    !Number.isFinite(stats.minX) ||
    !Number.isFinite(stats.maxX) ||
    !Number.isFinite(stats.minY) ||
    !Number.isFinite(stats.maxY)
  ) {
    stats.area = Number.POSITIVE_INFINITY
    return
  }

  stats.area = Math.max(0, stats.maxX - stats.minX) * Math.max(0, stats.maxY - stats.minY)
}

function shouldPreferFloat16Texcoords(
  fixedStats: TexcoordDecodeStats,
  float16Stats: TexcoordDecodeStats
): boolean {
  return (
    float16Stats.saneRatio >= FLOAT16_REQUIRED_SANITY_RATIO &&
    float16Stats.area >= FLOAT16_MINIMUM_AREA &&
    float16Stats.area > fixedStats.area * FLOAT16_AREA_MULTIPLIER &&
    fixedStats.area <= FIXED_POINT_COLLAPSED_AREA_LIMIT &&
    fixedStats.minX >= FIXED_POINT_COLLAPSED_MIN &&
    fixedStats.minY >= FIXED_POINT_COLLAPSED_MIN &&
    fixedStats.maxX <= FIXED_POINT_COLLAPSED_MAX &&
    fixedStats.maxY <= FIXED_POINT_COLLAPSED_MAX
  )
}

function decodeTexcoordComponent(value: number, mode: TexcoordDecodeMode): number {
  return mode === 'float16'
    ? decodeFloat16Bits(value)
    : value / MSFS_FIXED_POINT_TEXCOORD_SCALE
}

function decodeFloat16Bits(value: number): number {
  FLOAT16_VIEW.setUint16(0, value, true)
  return FLOAT16_VIEW.getFloat16(0, true)
}
