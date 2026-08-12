import type {
  CanonicalAircraftDefinition,
  CanonicalSystemDefinition,
  CanonicalSurfaceSystemConfig,
} from './aircraft'
import { AirPhysicsSubsystem } from './airPhysics'
import { AutopilotSubsystem } from './autopilot'
import { AvionicsSubsystem } from './avionics'
import { ControlStateKeys, ControlsSubsystem } from './controls'
import { ElectricalSubsystem } from './electrical'
import { EnvironmentSubsystem } from './environment'
import { FuelSubsystem } from './fuel'
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
      findSystemDefinition(aircraft, 'electrical')?.config ?? {}
    )
  )
  engine.registerSubsystem(
    new FuelSubsystem(
      findSystemDefinition(aircraft, 'fuel')?.config ?? {}
    )
  )
  engine.registerSubsystem(
    new PropulsionSubsystem(
      findSystemDefinition(aircraft, 'propulsion')?.config ?? {}
    )
  )
  engine.registerSubsystem(new ControlsSubsystem())
  engine.registerSubsystem(
    new SurfaceAnimationSubsystem(
      findSystemDefinition(aircraft, 'surfaces')?.config ??
        findSystemDefinition(aircraft, 'surface-animation')?.config ??
        DEFAULT_SURFACE_SYSTEM
    )
  )
  engine.registerSubsystem(new EnvironmentSubsystem())
  const airPhysics = findSystemDefinition(aircraft, 'air-physics')?.config
  if (airPhysics != null) {
    engine.registerSubsystem(
      new AirPhysicsSubsystem(
        airPhysics,
        findSystemDefinition(aircraft, 'propulsion')?.config ?? {},
        findSystemDefinition(aircraft, 'fuel')?.config ?? {}
      )
    )
  }
  engine.registerSubsystem(new LightingElectricalSubsystem())
  engine.registerSubsystem(new AvionicsSubsystem())
  engine.registerSubsystem(new AutopilotSubsystem())

  return engine
}

function findSystemDefinition<
  TKind extends CanonicalSystemDefinition['kind']
>(
  aircraft: CanonicalAircraftDefinition,
  kind: TKind
): Extract<CanonicalSystemDefinition, { readonly kind: TKind }> | undefined {
  return aircraft.systems?.find(
    (system): system is Extract<CanonicalSystemDefinition, { readonly kind: TKind }> =>
      system.kind === kind
  )
}
