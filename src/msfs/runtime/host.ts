import type {
  BehaviorVmEvent,
  CompiledAnimationBinding,
  CompiledInteractionBinding,
  CompiledVisibilityBinding
} from '../behavior/contracts.ts'
import { executeBehaviorProgram, type BehaviorVmHost } from '../behavior/vm.ts'
import type {
  RuntimeEventReference,
  RuntimeVariableReference,
  SoundVariableDescriptor
} from '../contracts.ts'
import type { CompatibilityBridgeSnapshot } from './bridge.ts'
import { COMPATIBILITY_BRIDGE_SCHEMA_VERSION } from './bridge.ts'
import type { AircraftCompatibilityDescriptor } from './descriptor.ts'
import type { CompatibilityRuntimeFlightState } from './flight-state.ts'
import type { RuntimeVariableValue } from './keys.ts'
import {
  runtimeVariableKey
} from './keys.ts'
import {
  collectCompatibilityOverrideMutations,
  DEFAULT_COMPATIBILITY_OVERRIDES,
  type CompatibilityOverride
} from './overrides.ts'
import {
  SoundCompatibilityHost,
  type ActiveSoundEntry,
  type SoundValueReader
} from './sound.ts'

const KNOTS_PER_MPS = 1.9438444924406046

export interface RuntimeAnimationOutput {
  binding: CompiledAnimationBinding
  value: number
}

export interface RuntimeVisibilityOutput {
  binding: CompiledVisibilityBinding
  visible: boolean
}

export interface AircraftCompatibilityRuntimeOptions {
  overrides?: readonly CompatibilityOverride[]
}

export class AircraftCompatibilityRuntime
  implements BehaviorVmHost, SoundValueReader
{
  readonly runtimeId = `runtime-${Math.random().toString(36).slice(2, 10)}`

  private readonly descriptor: AircraftCompatibilityDescriptor
  private readonly overrides: readonly CompatibilityOverride[]
  private readonly variables = new Map<string, RuntimeVariableValue>()
  private readonly trackedVariableKeys = new Set<string>()
  private readonly recentEvents: BehaviorVmEvent[] = []
  private readonly updateAccumulatedTime = new Map<string, number>()
  private readonly soundHost: SoundCompatibilityHost
  private animationOutputs: RuntimeAnimationOutput[] = []
  private visibilityOutputs: RuntimeVisibilityOutput[] = []
  private activeSounds: ActiveSoundEntry[] = []
  private diagnostics: string[] = []
  private interactionBindings = new Map<string, CompiledInteractionBinding>()
  private lastAltitudeMeters?: number

  constructor(
    descriptor: AircraftCompatibilityDescriptor,
    options?: AircraftCompatibilityRuntimeOptions
  ) {
    this.descriptor = descriptor
    this.overrides = options?.overrides ?? DEFAULT_COMPATIBILITY_OVERRIDES
    this.soundHost = new SoundCompatibilityHost(descriptor.sound)

    for (const reference of descriptor.trackedVariables) {
      this.trackedVariableKeys.add(runtimeVariableKey(reference))
    }
    for (const seed of descriptor.startupVariables ?? []) {
      this.variables.set(runtimeVariableKey(seed.reference), seed.value)
    }
    for (const binding of descriptor.compiledBehavior.bindings.interactions) {
      this.interactionBindings.set(binding.id, binding)
    }

    for (const diagnostic of descriptor.diagnostics) {
      this.diagnostics.push(`${diagnostic.code}: ${diagnostic.message}`)
    }
  }

  getVariable(reference: RuntimeVariableReference): RuntimeVariableValue | undefined {
    return this.variables.get(runtimeVariableKey(reference))
  }

  setVariable(reference: RuntimeVariableReference, value: RuntimeVariableValue): void {
    this.variables.set(runtimeVariableKey(reference), value)
  }

  emitEvent(reference: RuntimeEventReference, payload?: RuntimeVariableValue): void {
    this.recentEvents.push({ event: reference, payload })
    if (this.recentEvents.length > 48) {
      this.recentEvents.splice(0, this.recentEvents.length - 48)
    }
  }

  readSoundVariable(reference: SoundVariableDescriptor): number {
    const runtimeReference: RuntimeVariableReference = {
      namespace: reference.source === 'SimVar' ? 'simvar' : 'lvar',
      name: reference.name,
      unit: reference.unit,
      index: reference.index
    }
    return asNumber(this.getVariable(runtimeReference))
  }

  tick(flightState: CompatibilityRuntimeFlightState): void {
    this.seedCommonVariables(flightState)

    const overrideMutations = collectCompatibilityOverrideMutations(this.overrides, {
      descriptor: this.descriptor,
      flightState
    })
    for (const mutation of overrideMutations) {
      this.setVariable(mutation.reference, mutation.value)
      if (mutation.note) {
        this.diagnostics.push(mutation.note)
      }
    }

    this.runUpdateBindings(flightState.dtSeconds)
    this.animationOutputs = this.descriptor.compiledBehavior.bindings.animations.map((binding) => ({
      binding,
      value: asNumber(executeBehaviorProgram(binding.program, this).returnValue)
    }))
    this.visibilityOutputs = this.descriptor.compiledBehavior.bindings.visibility.map((binding) => ({
      binding,
      visible: asBoolean(executeBehaviorProgram(binding.program, this).returnValue)
    }))
    this.activeSounds = this.soundHost.update(this, flightState.dtSeconds)
  }

  dispatchInteraction(bindingId: string): void {
    const binding = this.interactionBindings.get(bindingId)
    if (!binding) return
    executeBehaviorProgram(binding.program, this)
  }

  getAnimationOutputs(): RuntimeAnimationOutput[] {
    return this.animationOutputs
  }

  getVisibilityOutputs(): RuntimeVisibilityOutput[] {
    return this.visibilityOutputs
  }

  getActiveSounds(): ActiveSoundEntry[] {
    return this.activeSounds
  }

  createBridgeSnapshot(): CompatibilityBridgeSnapshot {
    const variables = [...this.descriptor.trackedVariables]
      .map((reference) => ({
        reference,
        value: this.getVariable(reference) ?? 0
      }))
      .filter((entry) => this.trackedVariableKeys.has(runtimeVariableKey(entry.reference)))

    return {
      schemaVersion: COMPATIBILITY_BRIDGE_SCHEMA_VERSION,
      runtimeId: this.runtimeId,
      descriptorId: this.descriptor.id,
      generatedAt: new Date().toISOString(),
      variables,
      recentEvents: [...this.recentEvents],
      animations: this.animationOutputs.map((entry) => ({
        bindingId: entry.binding.id,
        animName: entry.binding.animName,
        value: entry.value
      })),
      nodes: this.visibilityOutputs
        .filter((entry) => entry.binding.nodeId)
        .map((entry) => ({
          bindingId: entry.binding.id,
          nodeId: entry.binding.nodeId!,
          visible: entry.visible
        })),
      sounds: this.activeSounds.map((entry) => ({
        category: entry.category,
        eventName: entry.eventName,
        nodeName: entry.nodeName,
        active: entry.active,
        rtpcs: entry.rtpcs
      })),
      diagnostics: [...new Set(this.diagnostics)].slice(-32)
    }
  }

  private runUpdateBindings(dtSeconds: number): void {
    for (const binding of this.descriptor.compiledBehavior.bindings.updates) {
      const frequency = binding.frequency ?? 0
      if (frequency <= 0) {
        executeBehaviorProgram(binding.program, this)
        continue
      }

      const intervalSeconds = 1 / frequency
      const nextValue = (this.updateAccumulatedTime.get(binding.id) ?? 0) + dtSeconds
      if (nextValue < intervalSeconds) {
        this.updateAccumulatedTime.set(binding.id, nextValue)
        continue
      }

      this.updateAccumulatedTime.set(binding.id, nextValue % intervalSeconds)
      executeBehaviorProgram(binding.program, this)
    }
  }

  private seedCommonVariables(flightState: CompatibilityRuntimeFlightState): void {
    const { visualState, telemetry, wheelCycle01, angularRatesBodyRadPerSec } = flightState
    const altitudeMeters = telemetry.altitudeMeters ?? this.lastAltitudeMeters ?? 0
    const verticalSpeedFpm =
      this.lastAltitudeMeters == null || flightState.dtSeconds <= 0
        ? 0
        : ((altitudeMeters - this.lastAltitudeMeters) / flightState.dtSeconds) * 196.8503937
    this.lastAltitudeMeters = altitudeMeters

    this.seedSimVar('ELEVATOR POSITION', visualState.elevator, 'position')
    this.seedSimVar('ELEVATOR DEFLECTION PCT', visualState.elevator * 100, 'percent')
    this.seedSimVar('ELEVATOR TRIM PCT', visualState.elevator, 'percent over 100')
    this.seedSimVar('AILERON POSITION', visualState.aileron, 'position')
    this.seedSimVar('AILERON LEFT DEFLECTION PCT', -visualState.aileron * 100, 'percent')
    this.seedSimVar('AILERON RIGHT DEFLECTION PCT', visualState.aileron * 100, 'percent')
    this.seedSimVar('RUDDER POSITION', visualState.rudder, 'position')
    this.seedSimVar('YOKE X POSITION', visualState.aileron * 100, 'percent')
    this.seedSimVar('YOKE Y POSITION', visualState.elevator * 100, 'percent')
    this.seedSimVar('RUDDER PEDAL POSITION', visualState.rudder * 100, 'percent')
    this.seedSimVar('TRAILING EDGE FLAPS LEFT PERCENT', visualState.flaps01 * 100, 'percent')
    this.seedSimVar('TRAILING EDGE FLAPS RIGHT PERCENT', visualState.flaps01 * 100, 'percent')
    this.seedSimVar('LEADING EDGE FLAPS LEFT PERCENT', visualState.flaps01 * 100, 'percent')
    this.seedSimVar('LEADING EDGE FLAPS RIGHT PERCENT', visualState.flaps01 * 100, 'percent')
    this.seedSimVar('SPOILERS LEFT POSITION', visualState.spoiler01 * 100, 'percent')
    this.seedSimVar('SPOILERS RIGHT POSITION', visualState.spoiler01 * 100, 'percent')
    this.seedSimVar('GEAR HANDLE POSITION', visualState.gear01, 'bool')
    this.seedSimVar('GEAR ANIMATION POSITION:0', visualState.gear01 * 100, 'percent')
    this.seedSimVar('GEAR ANIMATION POSITION:1', visualState.gear01 * 100, 'percent')
    this.seedSimVar('GEAR ANIMATION POSITION:2', visualState.gear01 * 100, 'percent')
    this.seedSimVar('WHEEL RPM', wheelCycle01 * 1000, 'rpm', 0)
    this.seedSimVar('WHEEL RPM', wheelCycle01 * 1000, 'rpm', 1)
    this.seedSimVar('WHEEL RPM', wheelCycle01 * 1000, 'rpm', 2)
    this.seedSimVar('AIRSPEED TRUE', (telemetry.airspeedMps ?? 0) * KNOTS_PER_MPS, 'knots')
    this.seedSimVar('VERTICAL SPEED', verticalSpeedFpm, 'feet per minute')
    this.seedSimVar('PLANE ALTITUDE', altitudeMeters * 3.280839895, 'feet')
    this.seedSimVar('ROTATION VELOCITY BODY X', angularRatesBodyRadPerSec?.x ?? 0, 'percent')
    this.seedSimVar('ROTATION VELOCITY BODY Y', angularRatesBodyRadPerSec?.y ?? 0, 'percent')
    this.seedSimVar('ROTATION VELOCITY BODY Z', angularRatesBodyRadPerSec?.z ?? 0, 'percent')
  }

  private seedSimVar(
    name: string,
    value: RuntimeVariableValue,
    unit?: string,
    index?: number
  ): void {
    this.setVariable(
      {
        namespace: 'simvar',
        name,
        unit,
        index
      },
      value
    )
  }
}

function asNumber(value: RuntimeVariableValue | undefined): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function asBoolean(value: RuntimeVariableValue | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.length > 0 && value !== '0'
  return false
}
