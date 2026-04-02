import type {
  RuntimeEventReference,
  RuntimeVariableReference
} from '../contracts.ts'

export type RuntimeVariableValue = number | string | boolean

export function runtimeVariableKey(reference: RuntimeVariableReference): string {
  return `${reference.namespace}:${reference.name}:${reference.unit ?? ''}:${reference.index ?? ''}`
}

export function runtimeEventKey(reference: RuntimeEventReference): string {
  return `${reference.channel}:${reference.name}:${reference.payloadShape ?? ''}`
}
