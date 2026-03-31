export interface MsfsFlapPosition {
  index: number
  angleDeg: number
  speedKts: number | null
  label: string | null
}

export interface MsfsFlapSection {
  index: number
  type: number | null
  positions: MsfsFlapPosition[]
}

export function parseMsfsFlapSections(source: string): MsfsFlapSection[] {
  const sections = new Map<number, MsfsFlapSection>()
  let currentSectionIndex: number | null = null

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const sectionMatch = line.match(/^\[FLAPS\.(\d+)\]$/i)
    if (sectionMatch) {
      currentSectionIndex = Number(sectionMatch[1])
      sections.set(currentSectionIndex, {
        index: currentSectionIndex,
        type: null,
        positions: []
      })
      continue
    }

    if (currentSectionIndex == null) continue

    const currentSection = sections.get(currentSectionIndex)
    if (!currentSection) continue

    const typeMatch = line.match(/^type\s*=\s*(-?\d+)/i)
    if (typeMatch) {
      currentSection.type = Number(typeMatch[1])
      continue
    }

    const positionMatch = line.match(
      /^flaps-position\.(\d+)\s*=\s*([^;]+?)(?:\s*;\s*(.*))?$/i
    )
    if (!positionMatch) continue

    const positionIndex = Number(positionMatch[1])
    const values = positionMatch[2]
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    const angleDeg = Number(values[0])
    const speedValue = Number(values[1])
    const speedKts = Number.isFinite(speedValue) && speedValue >= 0 ? speedValue : null
    const label = positionMatch[3]?.trim() || null

    currentSection.positions.push({
      index: positionIndex,
      angleDeg,
      speedKts,
      label
    })
  }

  return [...sections.values()]
    .map(section => ({
      ...section,
      positions: [...section.positions].sort((a, b) => a.index - b.index)
    }))
    .sort((a, b) => a.index - b.index)
}

export function buildEvenDetents01(count: number): readonly number[] {
  if (count <= 1) return [0]
  return Array.from({ length: count }, (_, index) => index / (count - 1))
}

export function parseSourceConstantNumber(source: string, name: string): number {
  const match = source.match(
    new RegExp(String.raw`const\s+${name}\s*:\s*f64\s*=\s*([0-9]+(?:\.[0-9]+)?)`)
  )
  if (!match) {
    throw new Error(`Could not find numeric constant "${name}" in source`)
  }

  return Number(match[1])
}
