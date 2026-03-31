import type {
  FlapAutoCommandConfig,
  FlapVisualSchedule
} from './FlightModel'
import {
  buildEvenDetents01,
  parseMsfsFlapSections,
  parseSourceConstantNumber
} from './MsfsFlapConfig'

import flightModelCfgRaw from '../../third_party/flybywire-aircraft/fbw-a32nx/src/base/flybywire-aircraft-a320-neo/SimObjects/AirPlanes/FlyByWire_A320_NEO/flight_model.cfg?raw'
import flapsChannelRaw from '../../third_party/flybywire-aircraft/fbw-a32nx/src/wasm/systems/a320_systems/src/hydraulic/sfcc/flaps_channel.rs?raw'

export interface FlyByWireA320FbwConfig {
  readonly flapDetents01: readonly number[]
  readonly defaultFlapDetentIndex: number
  readonly flapVisualSchedule: FlapVisualSchedule
  readonly flapAutoCommand: FlapAutoCommandConfig
}

const parsedFlapSections = parseMsfsFlapSections(flightModelCfgRaw)

function getSectionAngles(sectionIndex: number): readonly number[] {
  const section = parsedFlapSections.find(candidate => candidate.index === sectionIndex)
  if (!section) {
    throw new Error(`Missing FBW flap section FLAPS.${sectionIndex}`)
  }
  if (section.positions.length === 0) {
    throw new Error(`FBW flap section FLAPS.${sectionIndex} has no positions`)
  }
  return section.positions.map(position => position.angleDeg)
}

function buildFbwConfig(): FlyByWireA320FbwConfig {
  const trailingOutboardDeg = getSectionAngles(0)
  const trailingInboardDeg = getSectionAngles(1)
  const leadingDeg = getSectionAngles(2)
  const detentCount = Math.max(
    trailingOutboardDeg.length,
    trailingInboardDeg.length,
    leadingDeg.length
  )

  if (
    trailingOutboardDeg.length !== detentCount ||
    trailingInboardDeg.length !== detentCount ||
    leadingDeg.length !== detentCount
  ) {
    throw new Error('FBW flap sections do not share the same detent count')
  }

  const flapDetents01 = buildEvenDetents01(detentCount)
  const flapVisualSchedule: FlapVisualSchedule = {
    detents01: flapDetents01,
    trailingOutboardDeg,
    trailingInboardDeg,
    leadingDeg
  }
  const flapAutoCommand: FlapAutoCommandConfig = {
    conf1Handle01: flapDetents01[1] ?? 0,
    conf1FHandle01: flapDetents01[2] ?? 0,
    lowSpeedKts: parseSourceConstantNumber(flapsChannelRaw, 'KNOTS_100'),
    highSpeedKts: parseSourceConstantNumber(flapsChannelRaw, 'KNOTS_210')
  }

  return {
    flapDetents01,
    defaultFlapDetentIndex: Math.min(3, flapDetents01.length - 1),
    flapVisualSchedule,
    flapAutoCommand
  }
}

export const flyByWireA320FbwConfig = buildFbwConfig()
