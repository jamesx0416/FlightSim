export interface ParsedCfgSection {
  readonly name: string
  readonly values: ReadonlyMap<string, string>
}

export function parseCfg(text: string): ParsedCfgSection[] {
  const sections: ParsedCfgSection[] = []
  let currentName = ''
  let currentValues = new Map<string, string>()

  const pushCurrentSection = (): void => {
    if (!currentName) return
    sections.push({
      name: currentName,
      values: currentValues
    })
  }

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      pushCurrentSection()
      currentName = line.slice(1, -1).trim()
      currentValues = new Map<string, string>()
      continue
    }

    const equalsIndex = line.indexOf('=')
    if (equalsIndex < 0 || !currentName) continue

    const key = line.slice(0, equalsIndex).trim().toLowerCase()
    const value = line.slice(equalsIndex + 1).trim()
    currentValues.set(key, stripQuotes(value))
  }

  pushCurrentSection()
  return sections
}

export function getCfgSection(
  sections: readonly ParsedCfgSection[],
  sectionName: string
): ParsedCfgSection | null {
  const normalizedName = sectionName.toLowerCase()
  return (
    sections.find(section => section.name.toLowerCase() === normalizedName) ?? null
  )
}

export function getCfgSectionsByPrefix(
  sections: readonly ParsedCfgSection[],
  prefix: string
): ParsedCfgSection[] {
  const normalizedPrefix = prefix.toLowerCase()
  return sections.filter(section =>
    section.name.toLowerCase().startsWith(normalizedPrefix)
  )
}

function stripComment(line: string): string {
  const commentIndex = line.indexOf(';')
  if (commentIndex < 0) return line
  return line.slice(0, commentIndex)
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}
