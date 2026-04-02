import type {
  InteractionTrigger,
  BehaviorVmEvent
} from '../behavior/contracts.ts'
import type {
  RuntimeEventReference,
  RuntimeVariableReference
} from '../contracts.ts'
import type { RuntimeVariableValue } from './keys.ts'

export const COMPATIBILITY_BRIDGE_SCHEMA_VERSION = 'msfs.compatibility.bridge.v0'

export interface CompatibilityBridgeVariableSnapshot {
  reference: RuntimeVariableReference
  value: RuntimeVariableValue
}

export interface CompatibilityBridgeAnimationSnapshot {
  bindingId: string
  animName?: string
  value: number
}

export interface CompatibilityBridgeNodeSnapshot {
  bindingId: string
  nodeId: string
  visible: boolean
}

export interface CompatibilityBridgeSoundSnapshot {
  category: string
  eventName?: string
  nodeName?: string
  active: boolean
  rtpcs: Record<string, number>
}

export interface CompatibilityBridgeSnapshot {
  schemaVersion: typeof COMPATIBILITY_BRIDGE_SCHEMA_VERSION
  runtimeId: string
  descriptorId: string
  generatedAt: string
  variables: CompatibilityBridgeVariableSnapshot[]
  recentEvents: BehaviorVmEvent[]
  animations: CompatibilityBridgeAnimationSnapshot[]
  nodes: CompatibilityBridgeNodeSnapshot[]
  sounds: CompatibilityBridgeSoundSnapshot[]
  diagnostics: string[]
}

export type CompatibilityBridgeMessage =
  | {
      type: 'snapshot'
      snapshot: CompatibilityBridgeSnapshot
    }
  | {
      type: 'set-variable'
      reference: RuntimeVariableReference
      value: RuntimeVariableValue
    }
  | {
      type: 'emit-event'
      event: RuntimeEventReference
      payload?: RuntimeVariableValue
    }
  | {
      type: 'dispatch-interaction'
      bindingId: string
      trigger?: InteractionTrigger
    }

export function compatibilityChannelName(runtimeId: string): string {
  return `msfs-compatibility:${runtimeId}`
}
