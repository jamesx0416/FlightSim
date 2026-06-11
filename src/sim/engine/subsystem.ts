import type { CanonicalAircraftDefinition } from './aircraft'
import type { SimCommand, SimCommandBus } from './commands'
import type { SimStateStore } from './state'

export type SimDiagnosticSeverity = 'info' | 'warning' | 'error'
export type SimSchedulerPhase = 'input' | 'systems' | 'physics' | 'output'

export interface SimDiagnostic {
  readonly severity: SimDiagnosticSeverity
  readonly code: string
  readonly message: string
  readonly details?: Readonly<Record<string, unknown>>
}

export interface SimSubsystemContext {
  readonly state: SimStateStore
  readonly commands: SimCommandBus
  readonly aircraft: CanonicalAircraftDefinition | undefined
  readonly elapsedSeconds: number
  readonly diagnose: (diagnostic: SimDiagnostic) => void
}

export interface SimSubsystemTickContext extends SimSubsystemContext {
  readonly dtSeconds: number
  readonly phase: SimSchedulerPhase
}

export interface SimSubsystem {
  readonly id: string
  readonly phase?: SimSchedulerPhase
  initialize?(context: SimSubsystemContext): void
  tick?(context: SimSubsystemTickContext): void
  handleCommand?(command: SimCommand, context: SimSubsystemContext): boolean | void
  shutdown?(context: SimSubsystemContext): void
}
