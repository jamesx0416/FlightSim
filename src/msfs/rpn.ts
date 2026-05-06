import type { CompiledExpression, ImportDiagnostic, Instruction } from './types'

interface CompileOptions {
  readonly sourcePath: string
  readonly sourceExpression: string
  readonly diagnostics: ImportDiagnostic[]
  readonly localVariableScope?: string | null
}

const BINARY_OPERATORS = new Map<string, Instruction['op']>([
  ['+', 'add'],
  ['-', 'sub'],
  ['*', 'mul'],
  ['/', 'div'],
  ['div', 'integerDiv'],
  ['%', 'mod'],
  ['min', 'min'],
  ['max', 'max'],
  ['pow', 'pow'],
  ['>', 'gt'],
  ['<', 'lt'],
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['==', 'eq'],
  ['!=', 'neq'],
  ['and', 'and'],
  ['or', 'or'],
  ['&&', 'and'],
  ['||', 'or']
])

const UNARY_OPERATORS = new Map<string, Instruction['op']>([
  ['abs', 'abs'],
  ['!', 'not'],
  ['not', 'not'],
  ['neg', 'neg'],
  ['/-/', 'neg'],
  ['ceil', 'ceil'],
  ['flr', 'floor'],
  ['near', 'roundNearest'],
  ['sign', 'sign'],
  ['sqrt', 'sqrt'],
  ['sin', 'sin'],
  ['cos', 'cos'],
  ['dgrd', 'degreesToRadians'],
  ['rddg', 'radiansToDegrees'],
  ['dnor', 'normalizeDegrees'],
  ['rnor', 'normalizeRadians']
])

export function compileRpnExpression(
  source: string,
  options: CompileOptions
): CompiledExpression | null {
  const variableKeys = new Set<string>()
  const tokens = tokenizeRpn(source)
  const compiled = compileInstructionBlock(tokens, 0, options, variableKeys)
  if (compiled == null || compiled.nextIndex !== tokens.length) {
    return null
  }

  return {
    source,
    instructions: compiled.instructions,
    variableKeys: [...variableKeys]
  }
}

function compileInstructionBlock(
  tokens: readonly string[],
  startIndex: number,
  options: CompileOptions,
  variableKeys: Set<string>,
  stopTokens: readonly string[] = []
): { readonly instructions: Instruction[]; readonly nextIndex: number } | null {
  const instructions: Instruction[] = []

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index]
    const normalized = token.trim()
    if (!normalized) continue

    if (stopTokens.includes(normalized)) {
      return {
        instructions,
        nextIndex: index
      }
    }

    if (normalized === 'if{') {
      const thenBlock = compileInstructionBlock(tokens, index + 1, options, variableKeys, ['}', 'els{'])
      if (thenBlock == null) {
        return null
      }

      let elseInstructions: Instruction[] = []
      let nextIndex = thenBlock.nextIndex
      const branchTerminator = tokens[nextIndex]?.trim()
      let closingBraceIndex = nextIndex

      if (branchTerminator === '}') {
        const explicitElseToken = tokens[nextIndex + 1]?.trim()
        if (explicitElseToken === 'els{') {
          const elseBlock = compileInstructionBlock(tokens, nextIndex + 2, options, variableKeys, ['}'])
          if (elseBlock == null) {
            return null
          }
          elseInstructions = elseBlock.instructions
          closingBraceIndex = elseBlock.nextIndex
        }
      } else if (branchTerminator === 'els{') {
        const elseBlock = compileInstructionBlock(tokens, nextIndex + 1, options, variableKeys, ['}'])
        if (elseBlock == null) {
          return null
        }
        elseInstructions = elseBlock.instructions
        closingBraceIndex = elseBlock.nextIndex
      }

      if (tokens[closingBraceIndex]?.trim() !== '}') {
        options.diagnostics.push({
          code: 'rpn_token_unsupported',
          message: 'Unsupported RPN control-flow structure prevented compilation.',
          severity: 'warning',
          sourcePath: options.sourcePath,
          details: options.sourceExpression
        })
        return null
      }

      instructions.push({
        op: 'if',
        thenInstructions: thenBlock.instructions,
        elseInstructions
      })
      index = closingBraceIndex
      continue
    }

    if (normalized === 'True') {
      instructions.push({ op: 'pushNumber', value: 1 })
      continue
    }

    if (normalized === 'False') {
      instructions.push({ op: 'pushNumber', value: 0 })
      continue
    }

    if (normalized === 'pi') {
      instructions.push({ op: 'pushPi' })
      continue
    }

    const numericValue = Number.parseFloat(normalized)
    if (Number.isFinite(numericValue) && /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/iu.test(normalized)) {
      instructions.push({ op: 'pushNumber', value: numericValue })
      continue
    }

    const variableReference = extractVariableReference(normalized, options.localVariableScope ?? null)
    if (variableReference != null) {
      variableKeys.add(formatVariableSymbol(variableReference.key, variableReference.unit))
      instructions.push({
        op: 'pushVariable',
        key: variableReference.key,
        unit: variableReference.unit
      })
      continue
    }

    const parameterIndex = extractParameterIndex(normalized)
    if (parameterIndex != null) {
      instructions.push({ op: 'pushParameter', index: parameterIndex })
      continue
    }

    const variableWriteReference = extractVariableWriteReference(normalized, options.localVariableScope ?? null)
    if (variableWriteReference != null) {
      variableKeys.add(formatVariableSymbol(variableWriteReference.key, variableWriteReference.unit))
      instructions.push({
        op: 'writeVariable',
        key: variableWriteReference.key,
        unit: variableWriteReference.unit
      })
      continue
    }

    const keyEventWrite = extractKeyEventWrite(normalized)
    if (keyEventWrite != null) {
      instructions.push({
        op: 'invokeKeyEvent',
        name: keyEventWrite.name,
        argCount: keyEventWrite.argCount
      })
      continue
    }

    const registerStore = extractRegisterStore(normalized)
    if (registerStore != null) {
      instructions.push({
        op: 'storeRegister',
        index: registerStore.index,
        pop: registerStore.pop
      })
      continue
    }

    const registerLoad = extractRegisterLoad(normalized)
    if (registerLoad != null) {
      instructions.push({ op: 'loadRegister', index: registerLoad })
      continue
    }

    switch (normalized) {
      case 'd':
        instructions.push({ op: 'duplicate' })
        continue
      case 'p':
        instructions.push({ op: 'popDiscard' })
        continue
      case 'r':
        instructions.push({ op: 'swap' })
        continue
      case '++':
        instructions.push({ op: 'increment' })
        continue
      case '--':
        instructions.push({ op: 'decrement' })
        continue
      case '?':
        instructions.push({ op: 'ternary' })
        continue
      case 'case':
        instructions.push({ op: 'case' })
        continue
      case 'quit':
        instructions.push({ op: 'quit' })
        continue
    }

    const binaryOperator = BINARY_OPERATORS.get(normalized)
    if (binaryOperator) {
      instructions.push({ op: binaryOperator } as Instruction)
      continue
    }

    const unaryOperator = UNARY_OPERATORS.get(normalized)
    if (unaryOperator) {
      instructions.push({ op: unaryOperator } as Instruction)
      continue
    }

    options.diagnostics.push({
      code: 'rpn_token_unsupported',
      message: `Unsupported RPN token "${normalized}" prevented compilation.`,
      severity: 'warning',
      sourcePath: options.sourcePath,
      details: options.sourceExpression
    })
    return null
  }

  return {
    instructions,
    nextIndex: tokens.length
  }
}

export function evaluateCompiledExpression(
  expression: CompiledExpression,
  services: {
    readVariable: (key: string, unit?: string | null) => number
    writeVariable?: (key: string, value: number, unit?: string | null) => void
    invokeKeyEvent?: (name: string, args: readonly number[]) => void
    parameterValues?: readonly number[]
  }
): number {
  const stack: number[] = []
  executeInstructions(expression.instructions, stack, services, createEvaluationContext())
  return stack.at(-1) ?? 0
}

function executeInstructions(
  instructions: readonly Instruction[],
  stack: number[],
  services: {
    readVariable: (key: string, unit?: string | null) => number
    writeVariable?: (key: string, value: number, unit?: string | null) => void
    invokeKeyEvent?: (name: string, args: readonly number[]) => void
    parameterValues?: readonly number[]
  },
  context: EvaluationContext
): boolean {
  for (const instruction of instructions) {
    switch (instruction.op) {
      case 'pushNumber':
        stack.push(instruction.value)
        break
      case 'pushVariable':
        stack.push(services.readVariable(instruction.key, instruction.unit))
        break
      case 'pushParameter':
        stack.push(services.parameterValues?.[instruction.index] ?? 0)
        break
      case 'writeVariable': {
        const value = stack.pop() ?? 0
        services.writeVariable?.(instruction.key, value, instruction.unit)
        break
      }
      case 'invokeKeyEvent': {
        const args = new Array<number>(Math.max(0, instruction.argCount))
        for (let index = args.length - 1; index >= 0; index -= 1) {
          args[index] = stack.pop() ?? 0
        }
        services.invokeKeyEvent?.(instruction.name, args)
        break
      }
      case 'duplicate': {
        stack.push(stack.at(-1) ?? 0)
        break
      }
      case 'popDiscard':
        stack.pop()
        break
      case 'swap': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(right, left)
        break
      }
      case 'increment':
        stack.push((stack.pop() ?? 0) + 1)
        break
      case 'decrement':
        stack.push((stack.pop() ?? 0) - 1)
        break
      case 'storeRegister': {
        const value = instruction.pop ? stack.pop() ?? 0 : stack.at(-1) ?? 0
        context.registers[instruction.index] = value
        break
      }
      case 'loadRegister':
        stack.push(context.registers[instruction.index] ?? 0)
        break
      case 'if': {
        const condition = stack.pop() ?? 0
        const shouldContinue = executeInstructions(
          condition !== 0 ? instruction.thenInstructions : instruction.elseInstructions,
          stack,
          services,
          context
        )
        if (!shouldContinue) {
          return false
        }
        break
      }
      case 'ternary': {
        const condition = stack.pop() ?? 0
        const falseValue = stack.pop() ?? 0
        const trueValue = stack.pop() ?? 0
        stack.push(condition !== 0 ? trueValue : falseValue)
        break
      }
      case 'case': {
        const selector = Math.trunc(stack.pop() ?? 0)
        const count = Math.max(0, Math.trunc(stack.pop() ?? 0))
        const values = new Array<number>(count)
        for (let valueIndex = count - 1; valueIndex >= 0; valueIndex -= 1) {
          values[valueIndex] = stack.pop() ?? 0
        }
        stack.push(values[selector] ?? 0)
        break
      }
      case 'quit':
        return false
      case 'pushPi':
        stack.push(Math.PI)
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
      case 'integerDiv': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(right === 0 ? 0 : Math.trunc(left / right))
        break
      }
      case 'mod': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(right === 0 ? 0 : left % right)
        break
      }
      case 'pow': {
        const right = stack.pop() ?? 0
        const left = stack.pop() ?? 0
        stack.push(left ** right)
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
      case 'ceil':
        stack.push(Math.ceil(stack.pop() ?? 0))
        break
      case 'floor':
        stack.push(Math.floor(stack.pop() ?? 0))
        break
      case 'roundNearest':
        stack.push(Math.round(stack.pop() ?? 0))
        break
      case 'sign':
        stack.push((stack.pop() ?? 0) < 0 ? -1 : 1)
        break
      case 'neg':
        stack.push(-(stack.pop() ?? 0))
        break
      case 'not':
        stack.push((stack.pop() ?? 0) === 0 ? 1 : 0)
        break
      case 'sqrt':
        stack.push(Math.sqrt(stack.pop() ?? 0))
        break
      case 'sin':
        stack.push(Math.sin(stack.pop() ?? 0))
        break
      case 'cos':
        stack.push(Math.cos(stack.pop() ?? 0))
        break
      case 'degreesToRadians':
        stack.push(((stack.pop() ?? 0) * Math.PI) / 180)
        break
      case 'radiansToDegrees':
        stack.push(((stack.pop() ?? 0) * 180) / Math.PI)
        break
      case 'normalizeDegrees':
        stack.push(normalizeAngleDegrees(stack.pop() ?? 0))
        break
      case 'normalizeRadians':
        stack.push(normalizeAngleRadians(stack.pop() ?? 0))
        break
    }
  }

  return true
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

function extractVariableReference(
  token: string,
  localVariableScope: string | null
): { readonly key: string; readonly unit: string | null } | null {
  if (!token.startsWith('(') || !token.endsWith(')')) return null
  const content = token.slice(1, -1).trim()
  const variableMatch = /^(A|L|O|B|H|E):([^,]+?)(?:,\s*(.+))?$/iu.exec(content)
  if (!variableMatch) return null
  const namespace = variableMatch[1].toUpperCase()
  const variableName = variableMatch[2].trim()
  return {
    key: namespace === 'O' ? scopeObjectVariableKey(variableName, localVariableScope) : `${namespace}:${variableName}`,
    unit: variableMatch[3]?.trim() || null
  }
}

function extractVariableWriteReference(
  token: string,
  localVariableScope: string | null
): { readonly key: string; readonly unit: string | null } | null {
  if (!token.startsWith('(') || !token.endsWith(')')) return null
  const content = token.slice(1, -1).trim()
  const variableMatch = /^>(A|L|O|B|H):([^,]+?)(?:,\s*(.+))?$/iu.exec(content)
  if (!variableMatch) return null
  const namespace = variableMatch[1].toUpperCase()
  const variableName = variableMatch[2].trim()
  return {
    key: namespace === 'O' ? scopeObjectVariableKey(variableName, localVariableScope) : `${namespace}:${variableName}`,
    unit: variableMatch[3]?.trim() || null
  }
}

function scopeObjectVariableKey(variableName: string, localVariableScope: string | null): string {
  const scope = localVariableScope?.trim()
  if (!scope) {
    return `O:${variableName}`
  }
  return `O:${scope}:${variableName}`
}

function formatVariableSymbol(key: string, unit: string | null): string {
  return unit == null ? key : `${key}, ${unit}`
}

function extractKeyEventWrite(
  token: string
): { readonly name: string; readonly argCount: number } | null {
  if (!token.startsWith('(') || !token.endsWith(')')) return null
  const content = token.slice(1, -1).trim()
  const explicitCountMatch = /^>K:(\d+):(.+)$/iu.exec(content)
  if (explicitCountMatch != null) {
    return {
      argCount: Number.parseInt(explicitCountMatch[1], 10),
      name: explicitCountMatch[2].trim()
    }
  }

  const simpleMatch = /^>K:(.+)$/iu.exec(content)
  if (simpleMatch == null) {
    return null
  }

  return {
    argCount: 0,
    name: simpleMatch[1].trim()
  }
}

function extractParameterIndex(token: string): number | null {
  const match = /^p(\d{1,2})$/iu.exec(token)
  if (!match) return null
  const index = Number.parseInt(match[1], 10)
  if (!Number.isInteger(index) || index < 0 || index > 99) {
    return null
  }
  return index
}

interface EvaluationContext {
  readonly registers: number[]
}

function createEvaluationContext(): EvaluationContext {
  return {
    registers: new Array<number>(50).fill(0)
  }
}

function extractRegisterStore(
  token: string
): { readonly index: number; readonly pop: boolean } | null {
  const match = /^sp?(\d{1,2})$/iu.exec(token)
  if (!match) return null
  const index = Number.parseInt(match[1], 10)
  if (!Number.isInteger(index) || index < 0 || index > 49) {
    return null
  }

  return {
    index,
    pop: token.toLowerCase().startsWith('sp')
  }
}

function extractRegisterLoad(token: string): number | null {
  const match = /^l(\d{1,2})$/iu.exec(token)
  if (!match) return null
  const index = Number.parseInt(match[1], 10)
  if (!Number.isInteger(index) || index < 0 || index > 49) {
    return null
  }
  return index
}

function normalizeAngleDegrees(value: number): number {
  const normalized = value % 360
  return normalized < 0 ? normalized + 360 : normalized
}

function normalizeAngleRadians(value: number): number {
  const turn = Math.PI * 2
  const normalized = value % turn
  return normalized < 0 ? normalized + turn : normalized
}
