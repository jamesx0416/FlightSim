import type { RuntimeVariableReference } from '../contracts.ts'
import type { AircraftCompatibilityDescriptor } from './descriptor.ts'
import type { CompatibilityRuntimeFlightState } from './flight-state.ts'
import type { RuntimeVariableValue } from './keys.ts'

export interface CompatibilityOverrideMutation {
  reference: RuntimeVariableReference
  value: RuntimeVariableValue
  note?: string
}

export interface CompatibilityOverrideContext {
  descriptor: Pick<AircraftCompatibilityDescriptor, 'id' | 'aircraftId' | 'variantId'>
  flightState: CompatibilityRuntimeFlightState
}

export interface CompatibilityOverride {
  id: string
  matches(context: CompatibilityOverrideContext): boolean
  apply(context: CompatibilityOverrideContext): CompatibilityOverrideMutation[]
}

export const DEFAULT_COMPATIBILITY_OVERRIDES: readonly CompatibilityOverride[] = []

export function collectCompatibilityOverrideMutations(
  overrides: readonly CompatibilityOverride[],
  context: CompatibilityOverrideContext
): CompatibilityOverrideMutation[] {
  return overrides
    .filter((override) => override.matches(context))
    .flatMap((override) => override.apply(context))
}
