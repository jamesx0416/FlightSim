import type {
  BehaviorInstruction,
  CompiledCalculatorProgram
} from './contracts.ts'
import type {
  RuntimeEventReference,
  RuntimeVariableReference
} from '../contracts.ts'

const OPERATOR_MAP: Record<string, BehaviorInstruction['op']> = {
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  '!': 'not',
  and: 'and',
  or: 'or',
  '==': 'equal',
  '!=': 'not_equal',
  '>': 'greater',
  '>=': 'greater_equal',
  '<': 'less',
  '<=': 'less_equal',
  max: 'max',
  min: 'min',
  abs: 'abs'
}

export function compileCalculatorCode(source: string): CompiledCalculatorProgram {
  const normalizedSource = source.replaceAll(/\r/g, ' ').trim()
  const tokens = tokenizeCalculatorCode(normalizedSource)
  const instructions: BehaviorInstruction[] = []
  const unsupportedTokens = new Set<string>()
  const referencedVariables = new Map<string, RuntimeVariableReference>()
  const writtenVariables = new Map<string, RuntimeVariableReference>()
  const emittedEvents = new Map<string, RuntimeEventReference>()
  let index = 0

  function compileBlock(stopTokens: string[]): void {
    while (index < tokens.length && !stopTokens.includes(tokens[index])) {
      const token = tokens[index]
      if (token === 'if{') {
        compileConditional()
        continue
      }

      const emitted = emitInstruction(token)
      if (!emitted) {
        instructions.push({ op: 'unsupported', token })
        unsupportedTokens.add(token)
      }

      index += 1
    }
  }

  function compileConditional(): void {
    index += 1
    const jumpIfFalseIndex =
      instructions.push({
        op: 'jump_if_false',
        target: -1
      }) - 1

    compileBlock(['els{', '}'])

    if (tokens[index] === 'els{') {
      index += 1
      const jumpIndex =
        instructions.push({
          op: 'jump',
          target: -1
        }) - 1
      ;(instructions[jumpIfFalseIndex] as Extract<BehaviorInstruction, { op: 'jump_if_false' }>).target =
        instructions.length
      compileBlock(['}'])
      ;(instructions[jumpIndex] as Extract<BehaviorInstruction, { op: 'jump' }>).target =
        instructions.length
    } else {
      ;(instructions[jumpIfFalseIndex] as Extract<BehaviorInstruction, { op: 'jump_if_false' }>).target =
        instructions.length
    }

    if (tokens[index] === '}') {
      index += 1
    }
  }

  function emitInstruction(token: string): boolean {
    if (!token) return true

    if (/^-?\d+(?:\.\d+)?$/.test(token)) {
      instructions.push({ op: 'push_number', value: Number.parseFloat(token) })
      return true
    }

    if (token.startsWith("'") && token.endsWith("'")) {
      instructions.push({ op: 'push_string', value: token.slice(1, -1) })
      return true
    }

    if (token.startsWith('(') && token.endsWith(')')) {
      const emitted = emitReferenceInstruction(token.slice(1, -1).trim())
      return emitted
    }

    if (/^sp\d+$/.test(token)) {
      instructions.push({
        op: 'store_local',
        slot: Number.parseInt(token.slice(2), 10)
      })
      return true
    }

    if (/^l\d+$/.test(token)) {
      instructions.push({
        op: 'load_local',
        slot: Number.parseInt(token.slice(1), 10)
      })
      return true
    }

    if (token === 'scmi') {
      instructions.push({ op: 'string_compare_ignore_case' })
      return true
    }

    if (token === 'rng') {
      instructions.push({ op: 'range_inclusive' })
      return true
    }

    if (token === 'quit') {
      instructions.push({ op: 'quit' })
      return true
    }

    if (OPERATOR_MAP[token]) {
      instructions.push({ op: OPERATOR_MAP[token] })
      return true
    }

    return false
  }

  function emitReferenceInstruction(rawReference: string): boolean {
    if (!rawReference) return false

    const isWrite = rawReference.startsWith('>')
    const referenceBody = isWrite ? rawReference.slice(1) : rawReference
    const parsed = parseReference(referenceBody)
    if (!parsed) return false

    if (isWrite) {
      if (parsed.kind === 'variable') {
        instructions.push({ op: 'write_var', reference: parsed.reference })
        writtenVariables.set(referenceKey(parsed.reference), parsed.reference)
        return true
      }

      instructions.push({ op: 'emit_event', event: parsed.reference })
      emittedEvents.set(eventKey(parsed.reference), parsed.reference)
      return true
    }

    if (parsed.kind === 'variable') {
      instructions.push({ op: 'read_var', reference: parsed.reference })
      referencedVariables.set(referenceKey(parsed.reference), parsed.reference)
      return true
    }

    return false
  }

  compileBlock([])

  return {
    source: normalizedSource,
    tokens,
    instructions,
    referencedVariables: [...referencedVariables.values()],
    writtenVariables: [...writtenVariables.values()],
    emittedEvents: [...emittedEvents.values()],
    unsupportedTokens: [...unsupportedTokens]
  }
}

function tokenizeCalculatorCode(source: string): string[] {
  const tokens: string[] = []
  const tokenPattern =
    /\s+|(\([^()]*\))|('(?:[^']|\\')*')|(if\{|els\{|})|(<=|>=|==|!=)|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_:#.-]*)|([+\-*/<>!])/g
  let lastIndex = 0

  for (const match of source.matchAll(tokenPattern)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      const leftover = source.slice(lastIndex, index).trim()
      if (leftover.length > 0) {
        tokens.push(leftover)
      }
    }

    lastIndex = index + match[0].length
    const token = match.slice(1).find((value) => value !== undefined)
    if (!token || token.trim().length === 0) continue
    tokens.push(token)
  }

  const trailing = source.slice(lastIndex).trim()
  if (trailing.length > 0) {
    tokens.push(trailing)
  }

  return tokens
}

function parseReference(
  rawReference: string
):
  | { kind: 'variable'; reference: RuntimeVariableReference }
  | { kind: 'event'; reference: RuntimeEventReference }
  | undefined {
  const commaIndex = rawReference.indexOf(',')
  const head = (commaIndex >= 0 ? rawReference.slice(0, commaIndex) : rawReference).trim()
  const unit = commaIndex >= 0 ? rawReference.slice(commaIndex + 1).trim() : undefined
  const namespaceSeparator = head.indexOf(':')
  if (namespaceSeparator < 0) return undefined

  const group = head.slice(0, namespaceSeparator).trim()
  const name = head.slice(namespaceSeparator + 1).trim()
  if (!name) return undefined

  if (group === 'K' || group === 'H') {
    return {
      kind: 'event',
      reference: {
        channel: group === 'K' ? 'key-event' : 'h-event',
        name,
        payloadShape: 'opaque'
      }
    }
  }

  if (group === 'B' && !unit) {
    return {
      kind: 'event',
      reference: {
        channel: 'b-event',
        name,
        payloadShape: 'opaque'
      }
    }
  }

  return {
    kind: 'variable',
    reference: {
      namespace: variableNamespaceForGroup(group),
      name,
      unit
    }
  }
}

function variableNamespaceForGroup(group: string): RuntimeVariableNamespace {
  switch (group) {
    case 'A':
      return 'simvar'
    case 'L':
      return 'lvar'
    case 'B':
      return 'bvar'
    default:
      return 'custom'
  }
}

function referenceKey(reference: RuntimeVariableReference): string {
  return `${reference.namespace}:${reference.name}:${reference.unit ?? ''}:${reference.index ?? ''}`
}

function eventKey(reference: RuntimeEventReference): string {
  return `${reference.channel}:${reference.name}:${reference.payloadShape ?? ''}`
}
