import type { CanonicalAircraftDefinition } from './aircraft'
import {
  SimCommandBus,
  type SimCommand,
  type SimCommandDispatchResult,
} from './commands'
import { SimStateStore } from './state'
import type {
  SimDiagnostic,
  SimSchedulerPhase,
  SimSubsystem,
  SimSubsystemContext,
  SimSubsystemTickContext,
} from './subsystem'

const SCHEDULER_PHASES: readonly SimSchedulerPhase[] = [
  'input',
  'systems',
  'physics',
  'output',
]

export class SimulatorEngine {
  readonly state = new SimStateStore()
  readonly commands = new SimCommandBus()
  readonly diagnostics: SimDiagnostic[] = []

  private readonly subsystems: SimSubsystem[] = []
  private readonly commandUnsubscribers = new Map<string, () => void>()
  private aircraft: CanonicalAircraftDefinition | undefined
  private elapsedSeconds = 0

  constructor(aircraft?: CanonicalAircraftDefinition) {
    if (aircraft != null) {
      this.loadAircraft(aircraft)
    }
  }

  loadAircraft(aircraft: CanonicalAircraftDefinition): void {
    this.aircraft = aircraft

    for (const seed of aircraft.initialState ?? []) {
      this.state.define({
        key: seed.key,
        unit: seed.unit,
        valueType: seed.valueType,
        description: seed.description,
      })
      this.state.set(seed.key, seed.value, {
        source: seed.source ?? 'loaded',
        unit: seed.unit,
        metadata: { aircraftId: aircraft.identity.id },
      })
    }
  }

  getAircraft(): CanonicalAircraftDefinition | undefined {
    return this.aircraft
  }

  registerSubsystem(subsystem: SimSubsystem): void {
    if (this.subsystems.some((candidate) => candidate.id === subsystem.id)) {
      throw new Error(`Subsystem already registered: ${subsystem.id}`)
    }

    this.subsystems.push(subsystem)
    subsystem.initialize?.(this.createSubsystemContext())

    if (subsystem.handleCommand != null) {
      const unsubscribe = this.commands.subscribe('*', (command) => {
        return subsystem.handleCommand?.(command, this.createSubsystemContext())
      })
      this.commandUnsubscribers.set(subsystem.id, unsubscribe)
    }
  }

  dispatch(command: SimCommand): SimCommandDispatchResult {
    return this.commands.dispatch({
      ...command,
      timestampSeconds: command.timestampSeconds ?? this.elapsedSeconds,
    })
  }

  tick(dtSeconds: number): void {
    for (const phase of SCHEDULER_PHASES) {
      for (const subsystem of this.subsystems) {
        if ((subsystem.phase ?? 'systems') !== phase || subsystem.tick == null) {
          continue
        }

        subsystem.tick(this.createTickContext(dtSeconds, phase))
      }
    }

    this.elapsedSeconds += dtSeconds
  }

  dispose(): void {
    const context = this.createSubsystemContext()

    for (const subsystem of [...this.subsystems].reverse()) {
      subsystem.shutdown?.(context)
      this.commandUnsubscribers.get(subsystem.id)?.()
      this.commandUnsubscribers.delete(subsystem.id)
    }

    this.subsystems.length = 0
  }

  private createSubsystemContext(): SimSubsystemContext {
    return {
      state: this.state,
      commands: this.commands,
      aircraft: this.aircraft,
      elapsedSeconds: this.elapsedSeconds,
      diagnose: (diagnostic) => {
        this.diagnostics.push(diagnostic)
      },
    }
  }

  private createTickContext(
    dtSeconds: number,
    phase: SimSchedulerPhase
  ): SimSubsystemTickContext {
    return {
      ...this.createSubsystemContext(),
      dtSeconds,
      phase,
    }
  }
}
