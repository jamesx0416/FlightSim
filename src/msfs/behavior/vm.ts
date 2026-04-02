import type {
  BehaviorVmEvent,
  CompiledCalculatorProgram
} from './contracts.ts'
import type {
  RuntimeEventReference,
  RuntimeVariableReference
} from '../contracts.ts'

export type BehaviorValue = number | string | boolean

export interface BehaviorVmHost {
  getVariable(reference: RuntimeVariableReference): BehaviorValue | undefined
  setVariable(reference: RuntimeVariableReference, value: BehaviorValue): void
  emitEvent(reference: RuntimeEventReference, payload?: BehaviorValue): void
}

export class MemoryBehaviorVmHost implements BehaviorVmHost {
  private readonly variables = new Map<string, BehaviorValue>()
  readonly emittedEvents: BehaviorVmEvent[] = []

  constructor(initialValues?: Record<string, BehaviorValue>) {
    if (!initialValues) return
    for (const [key, value] of Object.entries(initialValues)) {
      this.variables.set(key, value)
    }
  }

  getVariable(reference: RuntimeVariableReference): BehaviorValue | undefined {
    return this.variables.get(variableKey(reference))
  }

  setVariable(reference: RuntimeVariableReference, value: BehaviorValue): void {
    this.variables.set(variableKey(reference), value)
  }

  emitEvent(reference: RuntimeEventReference, payload?: BehaviorValue): void {
    this.emittedEvents.push({ event: reference, payload })
  }
}

export interface BehaviorExecutionResult {
  stack: BehaviorValue[]
  locals: BehaviorValue[]
  returnValue?: BehaviorValue
}

export function executeBehaviorProgram(
  program: CompiledCalculatorProgram,
  host: BehaviorVmHost
): BehaviorExecutionResult {
  const stack: BehaviorValue[] = []
  const locals: BehaviorValue[] = []
  let instructionPointer = 0

  while (instructionPointer < program.instructions.length) {
    const instruction = program.instructions[instructionPointer]

    switch (instruction.op) {
      case 'push_number':
        stack.push(instruction.value)
        break
      case 'push_string':
        stack.push(instruction.value)
        break
      case 'read_var':
        stack.push(host.getVariable(instruction.reference) ?? 0)
        break
      case 'write_var': {
        const value = stack.pop() ?? 0
        host.setVariable(instruction.reference, value)
        break
      }
      case 'emit_event': {
        const payload = stack.length > 0 ? stack.pop() : undefined
        host.emitEvent(instruction.event, payload)
        break
      }
      case 'store_local':
        locals[instruction.slot] = stack.pop() ?? 0
        break
      case 'load_local':
        stack.push(locals[instruction.slot] ?? 0)
        break
      case 'add':
        binaryNumeric(stack, (left, right) => left + right)
        break
      case 'subtract':
        binaryNumeric(stack, (left, right) => left - right)
        break
      case 'multiply':
        binaryNumeric(stack, (left, right) => left * right)
        break
      case 'divide':
        binaryNumeric(stack, (left, right) => left / right)
        break
      case 'negate':
        unaryNumeric(stack, (value) => -value)
        break
      case 'not':
        stack.push(asBoolean(stack.pop()) ? 0 : 1)
        break
      case 'and':
        binaryBoolean(stack, (left, right) => left && right)
        break
      case 'or':
        binaryBoolean(stack, (left, right) => left || right)
        break
      case 'equal':
        binaryCompare(stack, (left, right) => left === right)
        break
      case 'not_equal':
        binaryCompare(stack, (left, right) => left !== right)
        break
      case 'greater':
        binaryNumericCompare(stack, (left, right) => left > right)
        break
      case 'greater_equal':
        binaryNumericCompare(stack, (left, right) => left >= right)
        break
      case 'less':
        binaryNumericCompare(stack, (left, right) => left < right)
        break
      case 'less_equal':
        binaryNumericCompare(stack, (left, right) => left <= right)
        break
      case 'max':
        binaryNumeric(stack, (left, right) => Math.max(left, right))
        break
      case 'min':
        binaryNumeric(stack, (left, right) => Math.min(left, right))
        break
      case 'abs':
        unaryNumeric(stack, (value) => Math.abs(value))
        break
      case 'string_compare_ignore_case': {
        const right = `${stack.pop() ?? ''}`.toLowerCase()
        const left = `${stack.pop() ?? ''}`.toLowerCase()
        stack.push(left === right ? 1 : 0)
        break
      }
      case 'range_inclusive': {
        const upper = asNumber(stack.pop())
        const lower = asNumber(stack.pop())
        const value = asNumber(stack.pop())
        stack.push(value >= lower && value <= upper ? 1 : 0)
        break
      }
      case 'jump_if_false':
        if (!asBoolean(stack.pop())) {
          instructionPointer = instruction.target
          continue
        }
        break
      case 'jump':
        instructionPointer = instruction.target
        continue
      case 'quit':
        instructionPointer = program.instructions.length
        continue
      case 'unsupported':
        break
    }

    instructionPointer += 1
  }

  return {
    stack: [...stack],
    locals: [...locals],
    returnValue: stack.at(-1)
  }
}

function binaryNumeric(
  stack: BehaviorValue[],
  operation: (left: number, right: number) => number
): void {
  const right = asNumber(stack.pop())
  const left = asNumber(stack.pop())
  stack.push(operation(left, right))
}

function unaryNumeric(stack: BehaviorValue[], operation: (value: number) => number): void {
  stack.push(operation(asNumber(stack.pop())))
}

function binaryBoolean(
  stack: BehaviorValue[],
  operation: (left: boolean, right: boolean) => boolean
): void {
  const right = asBoolean(stack.pop())
  const left = asBoolean(stack.pop())
  stack.push(operation(left, right) ? 1 : 0)
}

function binaryCompare(
  stack: BehaviorValue[],
  operation: (left: BehaviorValue, right: BehaviorValue) => boolean
): void {
  const right = stack.pop() ?? 0
  const left = stack.pop() ?? 0
  stack.push(operation(left, right) ? 1 : 0)
}

function binaryNumericCompare(
  stack: BehaviorValue[],
  operation: (left: number, right: number) => boolean
): void {
  const right = asNumber(stack.pop())
  const left = asNumber(stack.pop())
  stack.push(operation(left, right) ? 1 : 0)
}

function asBoolean(value: BehaviorValue | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.length > 0 && value !== '0'
  return false
}

function asNumber(value: BehaviorValue | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function variableKey(reference: RuntimeVariableReference): string {
  return `${reference.namespace}:${reference.name}:${reference.unit ?? ''}:${reference.index ?? ''}`
}
