import { expect, test } from 'bun:test'

import { createSimulatorEngineForAircraft } from './factory'
import {
  PropulsionCommandTypes,
  PropulsionStateKeys,
} from './propulsion'

test('uses the configured N1 integration rate during normal running', () => {
  const engine = createSimulatorEngineForAircraft({
    identity: { id: 'propulsion-physics-test' },
    systems: [{
      id: 'propulsion',
      kind: 'propulsion',
      config: {
        engines: [{
          index: 1,
          idleN1Percent: 20,
          n1NormalIntegrationRate: 0.25,
          idleFuelFlowKgPerSecond: 0.2,
          highFuelFlowKgPerSecond: 2,
        }],
      },
    }],
  })

  engine.dispatch({
    type: PropulsionCommandTypes.setEngineRunning,
    payload: { index: 1, enabled: true },
  })
  engine.dispatch({
    type: PropulsionCommandTypes.setEngineThrottle,
    payload: { index: 1, value: 1 },
  })
  engine.tick(1)
  expect(engine.state.readNumber(PropulsionStateKeys.engineN1Percent(1))).toBe(25)
  expect(engine.state.readNumber(PropulsionStateKeys.engineCommandedN1Percent(1))).toBe(100)
  expect((engine.state.readNumber(PropulsionStateKeys.engineFuelFlowKgPerSecond(1)) ?? 0) > 0).toBe(true)

  engine.tick(1)
  expect(engine.state.readNumber(PropulsionStateKeys.engineN1Percent(1))).toBe(43.75)
})
