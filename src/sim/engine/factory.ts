import type {
  CanonicalAircraftDefinition,
  CanonicalElectricalSystemConfig,
  CanonicalFuelSystemConfig,
  CanonicalPropulsionSystemConfig,
  CanonicalSurfaceSystemConfig,
} from './aircraft'
import { AutopilotSubsystem } from './autopilot'
import { AvionicsSubsystem } from './avionics'
import { ControlStateKeys, ControlsSubsystem } from './controls'
import { ElectricalSubsystem } from './electrical'
import { EnvironmentSubsystem } from './environment'
import { FuelSubsystem, type FuelSubsystemDefinition } from './fuel'
import { LightingElectricalSubsystem } from './lightingElectrical'
import { PropulsionSubsystem } from './propulsion'
import { SimulatorEngine } from './SimulatorEngine'
import { SurfaceAnimationSubsystem } from './surfaces'

const DEFAULT_SURFACE_SYSTEM: CanonicalSurfaceSystemConfig = {
  surfaces: [
    {
      id: 'flaps',
      controlStateKey: ControlStateKeys.flapsHandleRatio(),
      extensionRatePerSecond: 0.85,
      retractionRatePerSecond: 0.85,
    },
    {
      id: 'spoilers',
      controlStateKey: ControlStateKeys.spoilersHandleRatio(),
      extensionRatePerSecond: 2.5,
      retractionRatePerSecond: 2.5,
    },
  ],
}

export function createSimulatorEngineForAircraft(
  aircraft: CanonicalAircraftDefinition
): SimulatorEngine {
  const engine = new SimulatorEngine(aircraft)

  engine.registerSubsystem(
    new ElectricalSubsystem(
      findSystemConfig<CanonicalElectricalSystemConfig>(aircraft, 'electrical') ?? {}
    )
  )
  engine.registerSubsystem(
    new FuelSubsystem(
      findSystemConfig<CanonicalFuelSystemConfig & FuelSubsystemDefinition>(
        aircraft,
        'fuel'
      ) ?? {}
    )
  )
  engine.registerSubsystem(
    new PropulsionSubsystem(
      findSystemConfig<CanonicalPropulsionSystemConfig>(aircraft, 'propulsion') ?? {}
    )
  )
  engine.registerSubsystem(new ControlsSubsystem())
  engine.registerSubsystem(
    new SurfaceAnimationSubsystem(
      findSystemConfig<CanonicalSurfaceSystemConfig>(aircraft, 'surfaces') ??
        findSystemConfig<CanonicalSurfaceSystemConfig>(aircraft, 'surface-animation') ??
        DEFAULT_SURFACE_SYSTEM
    )
  )
  engine.registerSubsystem(new EnvironmentSubsystem())
  engine.registerSubsystem(new LightingElectricalSubsystem())
  engine.registerSubsystem(new AvionicsSubsystem())
  engine.registerSubsystem(new AutopilotSubsystem())

  return engine
}

function findSystemConfig<T>(
  aircraft: CanonicalAircraftDefinition,
  kind: string
): T | undefined {
  return aircraft.systems?.find(system => system.kind === kind)?.config as unknown as
    | T
    | undefined
}
