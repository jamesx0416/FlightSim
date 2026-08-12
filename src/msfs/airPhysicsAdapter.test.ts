import { expect, test } from 'bun:test'

import type { CanonicalPropulsionEngineConfig } from '../sim/engine/aircraft'
import { computeJetCommandedN1Percent, computeJetThrustN } from '../sim/engine/jetEngine'
import { parseCfg } from './config'
import {
  addMsfsFuelMassProperties,
  addMsfsPropulsionPhysicsMetadata,
  createMsfsAirPhysicsSystemConfig,
  parseMsfsLookup2D,
} from './airPhysicsAdapter'
import type { ImportedAircraft, ImportedCfgFile } from './types'

function cfg(kind: string, source: string): ImportedCfgFile {
  return {
    kind,
    path: `${kind}.cfg`,
    url: `/${kind}.cfg`,
    sourceAircraftCfgPath: 'aircraft.cfg',
    sections: parseCfg(source),
  }
}

const flightModel = cfg('flight_model', `
[WEIGHT_AND_BALANCE]
max_gross_weight=553360
empty_weight=279987
empty_weight_CG_position=-28.276,0,0
empty_weight_pitch_MOI=23228392
empty_weight_roll_MOI=14300433
empty_weight_yaw_MOI=18500000

[FUEL]
fuel_type=2

[FUEL_SYSTEM]
Tank.1=Name:Center#Capacity:10951#Position:-8,0,4#Priority:1
Tank.2=Name:LeftInner#Capacity:10928#Position:-12,-21,2#Priority:2
Tank.3=Name:RightInner#Capacity:10928#Position:-12,21,2#Priority:2
Tank.4=Name:LeftOuter#Capacity:1392#Position:-14,-44,4#Priority:3
Tank.5=Name:RightOuter#Capacity:1392#Position:-14,44,4#Priority:3

[AIRPLANE_GEOMETRY]
wing_area=4000
wing_span=209.97
wing_root_chord=34.61
wing_sweep=30
wing_dihedral=8
wing_incidence=0
wing_twist=-1
oswald_efficiency_factor=0.72
wing_pos_apex_vert=-2.8
fuselage_center_pos=-24.987358,0,3.121224
fuselage_diameter=18.5
fuselage_length=208.86
htail_area=883.29
htail_pos_lon=-120
htail_pos_vert=10
htail_span=63.65
vtail_area=486.85
vtail_pos_lon=-107
vtail_pos_vert=23.5
vtail_span=28.87
elevator_area=211.40
aileron_area=160.60
rudder_area=116.14
aileron_up_limit=25
aileron_down_limit=25
elevator_up_limit=25
elevator_down_limit=17
rudder_limit=25
[AERODYNAMICS]
aero_center_lift=-28.0
lift_coef_aoa_table=-3.15:0,0:0.224,0.139:1.39,0.2:1.48,3.15:0
drag_coef_zero_lift=0.026
lift_coef_ground_effect_mach_table=0:1.178,1:1
lift_coef_mach_table=0:1
drag_coef_zero_lift_mach_tab=0:0,0.85:0.01,1:0.5
lift_coef_at_drag_zero=0.175
lift_coef_flaps=1.2
drag_coef_flaps=0.0602
drag_coef_gear=0.030
lift_coef_air_spoilers=-0.25
drag_coef_spoilers=0.05775
pitch_moment_delta_elevator=-11.780
pitch_moment_pitch_damping=-1245.917

[FLIGHT_TUNING]
modern_fm_only=1
cruise_lift_scalar=0.83
parasite_drag_scalar=1.25
induced_drag_scalar=1.2
flap_induced_drag_scalar=1.44
elevator_effectiveness=0.7
elevator_maxangle_scalar=0.465
aileron_effectiveness=0.95
rudder_effectiveness=0.21
rudder_maxangle_scalar=0.78
wingflex_scalar=0.75
wingflex_offset=0.02

[FLAPS.0]
span-outboard=0.8
`)
const enginesCfg = cfg('engines', `
[GENERALENGINEDATA]
number_of_engines=2
engine.0=-2,-31.000369,-6.000072
engine.1=-2,31.000369,-6.000072
ThrustAnglesPitchHeading.0=0,0
ThrustAnglesPitchHeading.1=0,0

[TURBINEENGINEDATA]
static_thrust=72834
low_idle_n1=19.6
high_n1=101
n1_normal_tc=0.25
use_commanded_Ne_table=1
use_n2_to_n1_table=1
mach_0_corrected_commanded_ne_table=0:1:5.415178,0:68.2:78.644882,1:104.2:120.158309
mach_hi_corrected_commanded_ne_table=0.9:1:5.415178,0:63.267593:72.957073,1:104.2:120.158309
n2_to_n1_table=0:0:0.9,97:65:65,100:77:77,104:85:85.5,116.5:101:101
idle_fuel_flow=1800
high_fuel_flow=60000
mach_influence_on_n1=10
n1_and_mach_on_thrust_table=0:0:0.8,20:0.08:0.06,80:0.88:0.54,85:1.025:0.63,90:1.124:0.69,100:1.357:0.83,110:1.55:1.00

[JET_ENGINE]
thrust_scalar=1
`)

const aircraft = {
  id: 'a330-test',
  cfgFiles: [flightModel, enginesCfg],
} as unknown as ImportedAircraft
test('builds modern air physics from MSFS flight model metadata', () => {
  const physics = createMsfsAirPhysicsSystemConfig(aircraft)
  expect(physics == null).toBe(false)
  expect(Math.abs(physics!.emptyMassKg - 127000) < 1).toBe(true)
  expect(Math.abs(physics!.maxGrossMassKg - 251000) < 1).toBe(true)
  expect(Math.abs(physics!.geometry.wingAreaM2 - 371.61216) < 1e-4).toBe(true)
  expect(Math.abs(physics!.geometry.wingSpanM - 63.998856) < 1e-5).toBe(true)
  expect(Math.abs(physics!.geometry.aerodynamicCenterBodyM[0] - 0.0841248) < 1e-5).toBe(true)
  expect(Math.abs((physics!.geometry.fuselageLengthM ?? 0) - 63.660528) < 1e-6).toBe(true)
  expect(Math.abs((physics!.geometry.fuselageDiameterM ?? 0) - 5.6388) < 1e-6).toBe(true)
  expect(Math.abs((physics!.geometry.fuselageCenterBodyM?.[0] ?? 0) - 1.0023780816) < 1e-6).toBe(true)
  expect(physics!.aerodynamics.fuselageLateralDragCoefficient).toBe(0.4)
  expect(physics!.aerodynamics.groundEffectLiftMultiplierByMach?.values[0]).toBe(1.178)
  expect(physics!.aerodynamics.liftCoefficientMultiplierByMach?.values[0]).toBe(1)
  expect(physics!.wingFlex?.scalar).toBe(0.75)
  expect(physics!.wingFlex?.offset).toBe(0.02)
  expect((physics!.geometry.horizontalTailPositionBodyM?.[0] ?? 0) < -20).toBe(true)
  expect((physics!.geometry.verticalTailPositionBodyM?.[2] ?? 0) < 0).toBe(true)
  expect(physics!.controls.elevatorDeflectionSign).toBe(-1)
  expect(physics!.controls.elevatorLiftCoefficientSlopePerRad).toBe(5)
  expect(physics!.controls.rudderLiftCoefficientSlopePerRad).toBe(5)
  expect(physics!.controls.flapSpanOutboardRatio).toBe(0.8)
  expect(physics!.aerodynamics.pitchDampingCoefficient).toBe(0)
  expect(physics!.aerodynamics.liftCoefficientByAlphaRad.breakpoints.includes(0.139)).toBe(true)
})

test('adds physical A330 fuel tank mass properties without replacing system routing', () => {
  const fuel = addMsfsFuelMassProperties({
    tanks: [{ id: 'main', defaultQuantityRatio: 0.5 }],
  }, aircraft)
  expect(fuel.tanks?.length).toBe(6)
  const center = fuel.tanks?.find(tank => tank.id === 'Center')
  const leftInner = fuel.tanks?.find(tank => tank.id === 'LeftInner')
  const rightInner = fuel.tanks?.find(tank => tank.id === 'RightInner')
  expect(Math.abs((center?.capacityKg ?? 0) - 33280.8433) < 0.01).toBe(true)
  expect(center?.priority).toBe(1)
  expect(center?.defaultQuantityRatio).toBe(0.5)
  expect((leftInner?.positionBodyM?.[1] ?? 0) < 0).toBe(true)
  expect((rightInner?.positionBodyM?.[1] ?? 0) > 0).toBe(true)
})

test('adds engine thrust metadata and installation position', () => {
  const base: CanonicalPropulsionEngineConfig[] = [{ index: 1 }, { index: 2 }]
  const engines = addMsfsPropulsionPhysicsMetadata(base, aircraft)
  expect(Math.abs((engines[0].staticThrustN ?? 0) - 323981.77) < 0.1).toBe(true)
  expect(Math.abs((engines[0].positionBodyM?.[0] ?? 0) - 8.0089) < 1e-3).toBe(true)
  expect(Math.abs((engines[0].positionBodyM?.[1] ?? 0) + 9.4489) < 1e-3).toBe(true)
  expect(Math.abs((engines[0].positionBodyM?.[2] ?? 0) - 1.8288) < 1e-3).toBe(true)
  expect(Math.abs((engines[1].positionBodyM?.[1] ?? 0) - 9.4489) < 1e-3).toBe(true)
  expect(engines[0].highN1Percent).toBe(101)
  expect(engines[0].thrustByCorrectedN1AndMach?.breakpointsX).toEqual([0, 0.8])
})
test('parses MSFS two dimensional engine tables row major', () => {
  expect(parseMsfsLookup2D('0:0:0.8,20:0.08:0.06,100:1.35:0.83')).toEqual({
    breakpointsX: [0, 0.8],
    breakpointsY: [20, 100],
    values: [0.08, 0.06, 1.35, 0.83],
  })
})
test('A330-style commanded Ne tables land full throttle near rated N1 and thrust', () => {
  const engine = addMsfsPropulsionPhysicsMetadata(
    [{ index: 1, idleN1Percent: 19.6 }],
    aircraft
  )[0]
  const environment = {
    temperatureK: 288.15,
    pressurePa: 101_325,
    mach: 0,
    trueAirspeedMps: 0,
  }
  const commandedN1 = computeJetCommandedN1Percent(engine, 1, environment)
  const thrustN = computeJetThrustN(engine, commandedN1, environment)
  expect(commandedN1 > 85 && commandedN1 < 86).toBe(true)
  expect(thrustN > (engine.staticThrustN ?? 0) * 0.98).toBe(true)
  expect(thrustN < (engine.staticThrustN ?? 0) * 1.08).toBe(true)
})
