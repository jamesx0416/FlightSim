import type { CompiledExpression, ImportDiagnostic, Instruction } from './types'

interface CompileOptions {
  readonly sourcePath: string
  readonly diagnostics: ImportDiagnostic[]
}

const BINARY_OPERATORS = new Map<string, Instruction['op']>([
  ['+', 'add'],
  ['-', 'sub'],
  ['*', 'mul'],
  ['/', 'div'],
  ['%', 'mod'],
  ['min', 'min'],
  ['max', 'max'],
  ['>', 'gt'],
  ['<', 'lt'],
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['==', 'eq'],
  ['!=', 'neq'],
  ['and', 'and'],
  ['or', 'or']
])

const UNARY_OPERATORS = new Map<string, Instruction['op']>([
  ['abs', 'abs'],
  ['!', 'not'],
  ['not', 'not'],
  ['neg', 'neg']
])

export function compileRpnExpression(
  source: string,
  options: CompileOptions
): CompiledExpression | null {
  const instructions: Instruction[] = []
  const variableKeys = new Set<string>()
  const tokens = tokenizeRpn(source)

  for (const token of tokens) {
    const normalized = token.trim()
    if (!normalized) continue

    if (normalized === 'True') {
      instructions.push({ op: 'pushNumber', value: 1 })
      continue
    }

    if (normalized === 'False') {
      instructions.push({ op: 'pushNumber', value: 0 })
      continue
    }

    const numericValue = Number.parseFloat(normalized)
    if (Number.isFinite(numericValue) && /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/iu.test(normalized)) {
      instructions.push({ op: 'pushNumber', value: numericValue })
      continue
    }

    const variableKey = extractVariableKey(normalized)
    if (variableKey != null) {
      variableKeys.add(variableKey)
      instructions.push({ op: 'pushVariable', key: variableKey })
      continue
    }

    const binaryOperator = BINARY_OPERATORS.get(normalized)
    if (binaryOperator) {
      instructions.push({ op: binaryOperator })
      continue
    }

    const unaryOperator = UNARY_OPERATORS.get(normalized)
    if (unaryOperator) {
      instructions.push({ op: unaryOperator })
      continue
    }

    options.diagnostics.push({
      code: 'rpn_token_unsupported',
      message: `Unsupported RPN token "${normalized}" prevented compilation.`,
      severity: 'warning',
      sourcePath: options.sourcePath
    })
    return null
  }

  return {
    source,
    instructions,
    variableKeys: [...variableKeys]
  }
}

export function evaluateCompiledExpression(
  expression: CompiledExpression,
  readVariable: (key: string) => number
): number {
  const stack: number[] = []

  for (const instruction of expression.instructions) {
    switch (instruction.op) {
      case 'pushNumber':
        stack.push(instruction.value)
        break
      case 'pushVariable':
        stack.push(readVariable(instruction.key))
        break
      case 'add':
        stack.push((stack.pop() ?? 0) + (stack.pop() ?? 0))
        break
      case 'sub': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left - right)
        break
      }
      case 'mul':
        stack.push((stack.pop() ?? 0) * (stack.pop() ?? 0))
        break
      case 'div': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(right === 0 ? 0 : left / right)
        break
      }
      case 'mod': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(right === 0 ? 0 : left % right)
        break
      }
      case 'min': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(Math.min(left, right))
        break
      }
      case 'max': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(Math.max(left, right))
        break
      }
      case 'gt': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left > right ? 1 : 0)
        break
      }
      case 'lt': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left < right ? 1 : 0)
        break
      }
      case 'gte': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left >= right ? 1 : 0)
        break
      }
      case 'lte': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left <= right ? 1 : 0)
        break
      }
      case 'eq': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left === right ? 1 : 0)
        break
      }
      case 'neq': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left !== right ? 1 : 0)
        break
      }
      case 'and': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left !== 0 && right !== 0 ? 1 : 0)
        break
      }
      case 'or': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left !== 0 || right !== 0 ? 1 : 0)
        break
      }
      case 'abs':
        stack.push(Math.abs(stack.pop() ?? 0))
        break
      case 'neg':
        stack.push(-(stack.pop() ?? 0))
        break
      case 'not':
        stack.push((stack.pop() ?? 0) === 0 ? 1 : 0)
        break
    }
  }

  return stack.at(-1) ?? 0
}

function tokenizeRpn(source: string): string[] {
  const tokens: string[] = []
  let index = 0

  while (index < source.length) {
    const character = source[index]
    if (character == null) break

    if (/\s/u.test(character)) {
      index += 1
      continue
    }

    if (character === '(') {
      let endIndex = index + 1
      while (endIndex < source.length && source[endIndex] !== ')') {
        endIndex += 1
      }
      if (endIndex < source.length) {
        tokens.push(source.slice(index, endIndex + 1))
        index = endIndex + 1
        continue
      }
    }

    let endIndex = index + 1
    while (endIndex < source.length && !/\s/u.test(source[endIndex] ?? '')) {
      endIndex += 1
    }
    tokens.push(source.slice(index, endIndex))
    index = endIndex
  }

  return tokens
}

function extractVariableKey(token: string): string | null {
  if (!token.startsWith('(') || !token.endsWith(')')) return null
  const content = token.slice(1, -1).trim()
  const variableMatch = /^(A|L|O):([^,]+?)(?=,|$)/iu.exec(content)
  if (!variableMatch) return null
  return `${variableMatch[1].toUpperCase()}:${variableMatch[2].trim()}`
}
