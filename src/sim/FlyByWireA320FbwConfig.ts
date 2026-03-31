import type {
  FlapAutoCommandConfig,
  FlapVisualSchedule
} from './FlightModel'
import {
  buildEvenDetents01,
  parseMsfsFlapSections,
  parseMsfsTemplateNormalizedTimes,
  parseSourceConstantNumber
} from './MsfsFlapConfig'

import flightModelCfgRaw from '../../third_party/flybywire-aircraft/fbw-a32nx/src/base/flybywire-aircraft-a320-neo/SimObjects/AirPlanes/FlyByWire_A320_NEO/flight_model.cfg?raw'
import flapsChannelRaw from '../../third_party/flybywire-aircraft/fbw-a32nx/src/wasm/systems/a320_systems/src/hydraulic/sfcc/flaps_channel.rs?raw'
import modelXmlRaw from '../../third_party/flybywire-aircraft/fbw-a32nx/src/base/flybywire-aircraft-a320-neo/SimObjects/AirPlanes/FlyByWire_A320_NEO/model/A320_NEO.xml?raw'

export interface FlyByWireA320FbwConfig {
  readonly flapDetents01: readonly number[]
  readonly flapSurfaceTargets01: readonly number[]
  readonly defaultFlapDetentIndex: number
  readonly flapVisualSchedule: FlapVisualSchedule
  readonly nativeTrailingFlapClipDetents01: readonly number[]
  readonly flapAutoCommand: FlapAutoCommandConfig
}

const parsedFlapSections = parseMsfsFlapSections(flightModelCfgRaw)
const flapReferenceSection = parsedFlapSections.find(candidate => candidate.index === 0)

function getRequiredPositionIndex(label: string): number {
  const positionIndex = flapReferenceSection?.positions.findIndex(
    position => (position.label ?? '').trim().toUpperCase() === label
  )
  if (positionIndex == null || positionIndex < 0) {
    throw new Error(`Missing FBW flap position label ${label}`)
  }
  return positionIndex
}

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

  const flapSurfaceDetents01 = buildEvenDetents01(detentCount)
  const conf0Index = getRequiredPositionIndex('CONF 0')
  const conf1Index = getRequiredPositionIndex('CONF 1')
  const conf1FIndex = getRequiredPositionIndex('CONF 1+F')
  const conf2Index = getRequiredPositionIndex('CONF 2')
  const conf3Index = getRequiredPositionIndex('CONF 3')
  const confFullIndex = getRequiredPositionIndex('CONF FULL')
  const flapHandleSurfaceIndices = [
    conf0Index,
    conf1Index,
    conf2Index,
    conf3Index,
    confFullIndex
  ]
  const flapDetents01 = buildEvenDetents01(flapHandleSurfaceIndices.length)
  const flapSurfaceTargets01 = flapHandleSurfaceIndices.map(
    index => flapSurfaceDetents01[index] ?? 0
  )
  const flapVisualSchedule: FlapVisualSchedule = {
    detents01: flapSurfaceDetents01,
    trailingOutboardDeg,
    trailingInboardDeg,
    leadingDeg
  }
  const nativeFlapClipTimes = parseMsfsTemplateNormalizedTimes(
    modelXmlRaw,
    'ASOBO_HANDLING_Flaps_Template'
  )
  const nativeTrailingFlapClipDetents01 = [0, ...nativeFlapClipTimes]
  if (nativeTrailingFlapClipDetents01.length !== detentCount) {
    throw new Error(
      `FBW flap clip detent count mismatch: expected ${detentCount}, got ${nativeTrailingFlapClipDetents01.length}`
    )
  }
  const flapAutoCommand: FlapAutoCommandConfig = {
    conf1Handle01: flapDetents01[1] ?? 0,
    conf1Surface01: flapSurfaceDetents01[conf1Index] ?? 0,
    conf1FSurface01: flapSurfaceDetents01[conf1FIndex] ?? 0,
    lowSpeedKts: parseSourceConstantNumber(flapsChannelRaw, 'KNOTS_100'),
    highSpeedKts: parseSourceConstantNumber(flapsChannelRaw, 'KNOTS_210')
  }

  return {
    flapDetents01,
    flapSurfaceTargets01,
    defaultFlapDetentIndex: Math.min(2, flapDetents01.length - 1),
    flapVisualSchedule,
    nativeTrailingFlapClipDetents01,
    flapAutoCommand
  }
}

export const flyByWireA320FbwConfig = buildFbwConfig()
