export type CockpitInputConsumeReason =
  | 'interaction'
  | 'input-unbound'
  | 'operation-unsupported'
  | 'target-busy'
  | 'interaction-unavailable'
  | 'blocker'
  | 'cover'

export type CockpitInputHit<T> =
  | { readonly kind: 'active'; readonly binding: T }
  | { readonly kind: 'consumed'; readonly reason: CockpitInputConsumeReason }
  | { readonly kind: 'miss' }

export type CockpitInputDecision<T> =
  | { readonly kind: 'interaction'; readonly binding: T }
  | { readonly kind: 'camera' }
  | { readonly kind: 'consumed'; readonly reason: CockpitInputConsumeReason }

export function resolveCockpitInputDecision<T>(
  hit: CockpitInputHit<T>,
  cameraMapped: boolean
): CockpitInputDecision<T> {
  if (hit.kind === 'active') return { kind: 'interaction', binding: hit.binding }
  if (hit.kind === 'consumed') return hit
  return cameraMapped ? { kind: 'camera' } : { kind: 'consumed', reason: 'input-unbound' }
}
