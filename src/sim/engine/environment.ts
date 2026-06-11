import type { SimCommand } from './commands'
import type { SimStateStore } from './state'
import type { SimSubsystem, SimSubsystemContext } from './subsystem'

export const ENVIRONMENT_SUBSYSTEM_ID = 'environment'

export const EnvironmentCommandTypes = {
  setPitotHeat: 'environment.pitotHeat.set',
  setStructuralDeice: 'environment.structuralDeice.set',
  setEngineAntiIce: 'environment.engineAntiIce.set',
} as const

export interface EnvironmentSubsystemDefinition {
  readonly pitotHeat?: readonly PitotHeatDefinition[]
  readonly engineAntiIce?: readonly EngineAntiIceDefinition[]
  readonly defaultStructuralDeiceEnabled?: boolean
}

export interface PitotHeatDefinition {
  readonly index: number
  readonly defaultEnabled?: boolean
}

export interface EngineAntiIceDefinition {
  readonly index: number
  readonly defaultEnabled?: boolean
}

interface IndexedBooleanPayload {
  readonly index?: number
  readonly enabled?: boolean
  readonly value?: boolean | number
}

export const EnvironmentStateKeys = {
  pitotHeatEnabled(index = 1): string {
    return `environment.pitotHeat.${normalizePositiveIndex(index)}.enabled`
  },
  structuralDeiceEnabled(): string {
    return 'environment.structuralDeice.enabled'
  },
  engineAntiIceEnabled(index = 1): string {
    return `environment.engineAntiIce.${normalizePositiveIndex(index)}.enabled`
  },
} as const

export class EnvironmentSubsystem implements SimSubsystem {
  readonly id = ENVIRONMENT_SUBSYSTEM_ID
  readonly phase = 'systems' as const

  constructor(
    private readonly definition: EnvironmentSubsystemDefinition = {}
  ) {}

  initialize(context: SimSubsystemContext): void {
    for (const pitotHeat of this.definition.pitotHeat ?? []) {
      defineBooleanState(
        context.state,
        EnvironmentStateKeys.pitotHeatEnabled(pitotHeat.index),
        `Pitot heat ${pitotHeat.index} enabled`,
        pitotHeat.defaultEnabled
      )
    }

    defineBooleanState(
      context.state,
      EnvironmentStateKeys.structuralDeiceEnabled(),
      'Structural deice enabled',
      this.definition.defaultStructuralDeiceEnabled
    )

    for (const engineAntiIce of this.definition.engineAntiIce ?? []) {
      defineBooleanState(
        context.state,
        EnvironmentStateKeys.engineAntiIceEnabled(engineAntiIce.index),
        `Engine anti-ice ${engineAntiIce.index} enabled`,
        engineAntiIce.defaultEnabled
      )
    }
  }

  handleCommand(
    command: SimCommand,
    context: SimSubsystemContext
  ): boolean {
    switch (command.type) {
      case EnvironmentCommandTypes.setPitotHeat: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          EnvironmentStateKeys.pitotHeatEnabled(payload.index ?? 1),
          payload.enabled ?? payload.value ?? false
        )
        return true
      }
      case EnvironmentCommandTypes.setStructuralDeice: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          EnvironmentStateKeys.structuralDeiceEnabled(),
          payload.enabled ?? payload.value ?? false
        )
        return true
      }
      case EnvironmentCommandTypes.setEngineAntiIce: {
        const payload = command.payload as IndexedBooleanPayload
        setBoolean(
          context.state,
          EnvironmentStateKeys.engineAntiIceEnabled(payload.index ?? 1),
          payload.enabled ?? payload.value ?? false
        )
        return true
      }
      default:
        return false
    }
  }
}

export function readEnvironmentBoolean(
  state: SimStateStore,
  key: string,
  fallback = false
): boolean {
  return state.readBoolean(key, { fallback }) ?? fallback
}

function defineBooleanState(
  state: SimStateStore,
  key: string,
  description: string,
  defaultValue?: boolean
): void {
  state.define({ key, unit: 'boolean', valueType: 'boolean', description })
  if (defaultValue != null) {
    setBoolean(state, key, defaultValue, 'default')
  }
}

function setBoolean(
  state: SimStateStore,
  key: string,
  value: boolean | number,
  source: 'default' | 'runtime' = 'runtime'
): void {
  state.set(key, value === true || value === 1, {
    source,
    unit: 'boolean',
  })
}

function normalizePositiveIndex(index: number): number {
  return Number.isFinite(index) && index > 0 ? Math.trunc(index) : 1
}
