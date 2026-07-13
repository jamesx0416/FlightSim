import type { CanonicalCockpitAction, CockpitInteractionOperation, CockpitInteractionTarget } from '../input/cockpitInteraction'
import type { AircraftRuntime } from './runtime'
import type { CompiledInteractionBinding, CompiledInteractionRoute } from './types'

export interface MsfsInteractionTarget extends CockpitInteractionTarget {
  readonly binding: CompiledInteractionBinding
}

export type InteractionResolution =
  | { readonly ok: true; readonly target: MsfsInteractionTarget }
  | { readonly ok: false; readonly code: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS'; readonly candidates: readonly string[] }

export function selectDragRoutes(
  routes: readonly CompiledInteractionRoute[],
  firstSample: boolean
): readonly CompiledInteractionRoute[] {
  const drag = routes.find(route => route.phase === 'drag')
  if (drag == null) return []
  if (!firstSample) return [drag]
  const lock = routes.find(route => route.operation === 'lock')
  return lock == null ? [drag] : [lock, drag]
}

export interface MsfsDragTrajectoryPoint {
  readonly relativeX: number
  readonly relativeY: number
  readonly dragPercent: number
}

export function resolveMsfsDragPercent(
  trajectory: readonly MsfsDragTrajectoryPoint[],
  relativeX: number,
  relativeY: number,
  fallback: number,
  offset = 0
): number {
  let bestDistanceSquared = Number.POSITIVE_INFINITY
  let bestPercent = fallback
  for (let index = 1; index < trajectory.length; index += 1) {
    const start = trajectory[index - 1]!
    const end = trajectory[index]!
    const dx = end.relativeX - start.relativeX
    const dy = end.relativeY - start.relativeY
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared <= Number.EPSILON) continue
    const ratio = Math.min(1, Math.max(0,
      ((relativeX - start.relativeX) * dx + (relativeY - start.relativeY) * dy) / lengthSquared
    ))
    const projectedX = start.relativeX + dx * ratio
    const projectedY = start.relativeY + dy * ratio
    const distanceSquared = (relativeX - projectedX) ** 2 + (relativeY - projectedY) ** 2
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared
      bestPercent = start.dragPercent + (end.dragPercent - start.dragPercent) * ratio
    }
  }
  return Math.min(1, Math.max(0, bestPercent + offset))
}

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
