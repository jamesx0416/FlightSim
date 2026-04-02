import type {
  AircraftVisualState,
  PlaneStepResult
} from '../../entities/Plane.ts'

export interface CompatibilityRuntimeFlightState {
  dtSeconds: number
  elapsedSeconds: number
  wheelCycle01: number
  visualState: AircraftVisualState
  telemetry: Partial<PlaneStepResult>
  angularRatesBodyRadPerSec?: {
    x: number
    y: number
    z: number
  }
}
