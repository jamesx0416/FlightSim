import type { CanonicalCockpitAction, CockpitInteractionOperation, CockpitInteractionTarget } from '../input/cockpitInteraction'
import type { AircraftRuntime } from './runtime'
import type { CompiledInteractionBinding, CompiledInteractionRoute } from './types'

export interface MsfsInteractionTarget extends CockpitInteractionTarget {
  readonly binding: CompiledInteractionBinding
}

export type InteractionResolution =
  | { readonly ok: true; readonly target: MsfsInteractionTarget }
  | { readonly ok: false; readonly code: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS'; readonly candidates: readonly string[] }

export class MsfsInteractionAdapter {
  constructor(private readonly runtimeSource: AircraftRuntime | (() => AircraftRuntime)) {}

  private get runtime(): AircraftRuntime { return typeof this.runtimeSource === 'function' ? this.runtimeSource() : this.runtimeSource }

  list(): readonly MsfsInteractionTarget[] {
    return this.runtime.getInteractionBindings().map(binding => ({
      id: binding.metadata.qualifiedId,
      lockable: binding.metadata.lockable,
      operations: [...new Set(binding.metadata.routes.map(route => route.operation))],
      binding
    }))
  }

  resolve(id: string): InteractionResolution {
    const bindings = this.runtime.getInteractionBindings()
    const qualified = bindings.filter(binding => binding.metadata.qualifiedId === id)
    if (qualified.length === 1) return { ok: true, target: this.toTarget(qualified[0]!) }
    const authored = bindings.filter(binding => binding.metadata.authoredId === id)
    if (authored.length === 1) return { ok: true, target: this.toTarget(authored[0]!) }
    if (authored.length > 1) return { ok: false, code: 'TARGET_AMBIGUOUS', candidates: authored.map(binding => binding.metadata.qualifiedId) }
    return { ok: false, code: 'TARGET_NOT_FOUND', candidates: [] }
  }

  execute(target: MsfsInteractionTarget, action: CanonicalCockpitAction): boolean {
    const route = selectRoute(target.binding.metadata.routes, action)
    if (route == null) return false
    const value = action.axisValue ?? action.delta
    return this.runtime.executeInteractionBindingDirect(target.binding, {
      holdFeedback: action.phase === 'hold' || action.phase === 'drag',
      mouseEvent: route.msfsEvent ?? undefined,
      inputType: route.inputTypes[0],
      relativeX: action.axis === 'x' ? value : undefined,
      relativeY: action.axis === 'y' ? value : undefined,
      relativeZ: action.axis === 'z' ? value : undefined,
      dragPercent: action.dragPercent
    })
  }

  release(target: MsfsInteractionTarget): boolean { return this.runtime.releaseInteractionBinding(target.binding) }

  private toTarget(binding: CompiledInteractionBinding): MsfsInteractionTarget {
    return { id: binding.metadata.qualifiedId, lockable: binding.metadata.lockable, operations: [...new Set(binding.metadata.routes.map(route => route.operation))], binding }
  }
}

function selectRoute(routes: readonly CompiledInteractionRoute[], action: CanonicalCockpitAction): CompiledInteractionRoute | null {
  const operation: CockpitInteractionOperation = action.operation === 'hold' ? 'press' : action.operation
  const candidates = routes.filter(route => route.operation === operation || (operation === 'turn' && route.phase === 'drag'))
  if (action.channel == null && candidates.length === 1) return candidates[0] ?? null
  return candidates.find(route => route.channel === action.channel) ?? candidates.find(route => route.channel == null) ?? null
}
