import {
  Box3,
  Mesh,
  Object3D,
  Raycaster,
  Vector3
} from 'three'

import type { CockpitInputConsumeReason } from './cockpitInputArbitration'

export type CockpitGeometryMeshTarget<T> = {
  readonly object: Mesh
  readonly binding: T
  readonly prioritizeVCockpits: boolean
  readonly ignoreZTest: boolean
}

export type CockpitGeometryBoxTarget<T> = {
  readonly object: Object3D
  readonly box: Box3
  readonly binding: T
  readonly prioritizeVCockpits: boolean
  readonly ignoreZTest: boolean
}

export type CockpitGeometryBlocker = {
  readonly object: Object3D
  readonly target: string
  readonly reason: Extract<CockpitInputConsumeReason, 'blocker' | 'cover'>
  readonly mesh?: Mesh
  readonly box?: Box3
}

export type CockpitGeometryRegistry<T> = {
  readonly interactionMeshes: readonly CockpitGeometryMeshTarget<T>[]
  readonly fallbackHitboxes: readonly CockpitGeometryBoxTarget<T>[]
  readonly blockers: readonly CockpitGeometryBlocker[]
  readonly gaugeSurfaces: readonly Mesh[]
  readonly occluderMeshes: readonly Mesh[]
}

export type CockpitGeometryHit<T> =
  | {
      readonly kind: 'active'
      readonly binding: T
      readonly object: Object3D
      readonly point: Vector3
      readonly hitKind: 'interaction-mesh' | 'fallback-hitbox'
      readonly distance: number
    }
  | {
      readonly kind: 'consumed'
      readonly reason: Extract<CockpitInputConsumeReason, 'blocker' | 'cover'>
      readonly object: Object3D
      readonly target: string
    }
  | {
      readonly kind: 'miss'
      readonly reason: 'empty-interaction-registry' | 'occluded' | 'raycast-miss'
      readonly occluder: Object3D | null
    }

type RankedInteractionHit<T> = {
  readonly binding: T
  readonly object: Object3D
  readonly point: Vector3
  readonly hitKind: 'interaction-mesh' | 'fallback-hitbox'
  readonly distance: number
  readonly prioritizeVCockpits: boolean
  readonly ignoreZTest: boolean
}

const HIT_EPSILON = 1e-4

export function resolveCockpitGeometryHit<T>(
  raycaster: Raycaster,
  registry: CockpitGeometryRegistry<T>
): CockpitGeometryHit<T> {
  const interactionByMesh = new Map(
    registry.interactionMeshes.map(target => [target.object, target] as const)
  )
  const blockerHits = registry.blockers
    .flatMap(blocker => {
      const hit = blocker.mesh == null
        ? intersectBox(raycaster, blocker.box)
        : raycaster.intersectObject(blocker.mesh, false)[0]
      return hit == null ? [] : [{ blocker, distance: hit.distance }]
    })
    .sort((left, right) => left.distance - right.distance)
  const gaugeHits = raycaster
    .intersectObjects([...registry.gaugeSurfaces], false)
    .sort((left, right) => left.distance - right.distance)
  const interactionHits: RankedInteractionHit<T>[] = [
    ...raycaster.intersectObjects(
      registry.interactionMeshes.map(target => target.object),
      false
    ).flatMap(hit => {
      const target = interactionByMesh.get(hit.object as Mesh)
      return target == null ? [] : [{
        binding: target.binding,
        object: target.object,
        point: hit.point.clone(),
        hitKind: 'interaction-mesh' as const,
        distance: hit.distance,
        prioritizeVCockpits: target.prioritizeVCockpits,
        ignoreZTest: target.ignoreZTest
      }]
    }),
    ...registry.fallbackHitboxes.flatMap(target => {
      const hit = intersectBox(raycaster, target.box)
      return hit == null ? [] : [{
        binding: target.binding,
        object: target.object,
        point: hit.point,
        hitKind: 'fallback-hitbox' as const,
        distance: hit.distance,
        prioritizeVCockpits: target.prioritizeVCockpits,
        ignoreZTest: target.ignoreZTest
      }]
    })
  ].sort((left, right) =>
    Number(right.prioritizeVCockpits) - Number(left.prioritizeVCockpits) ||
    left.distance - right.distance
  )

  let occluder: Object3D | null = null
  for (const hit of interactionHits) {
    const hitOccluder = hit.ignoreZTest
      ? null
      : findCockpitOccluder(raycaster, hit.distance, registry.occluderMeshes)
    if (hitOccluder != null) {
      occluder ??= hitOccluder
      continue
    }

    const blockerHit = blockerHits.find(candidate =>
      candidate.distance <= hit.distance + HIT_EPSILON &&
      findCockpitOccluder(raycaster, candidate.distance, registry.occluderMeshes) == null
    )
    if (blockerHit != null) {
      return {
        kind: 'consumed',
        reason: blockerHit.blocker.reason,
        object: blockerHit.blocker.object,
        target: blockerHit.blocker.target
      }
    }

    return {
      kind: 'active',
      binding: hit.binding,
      object: hit.object,
      point: hit.point,
      hitKind: hit.hitKind,
      distance: hit.distance
    }
  }

  const gaugeHit = gaugeHits.find(hit =>
    findCockpitOccluder(raycaster, hit.distance, registry.occluderMeshes) == null
  )
  if (gaugeHit != null) {
    return {
      kind: 'miss',
      reason: 'occluded',
      occluder: gaugeHit.object
    }
  }

  if (occluder != null) return { kind: 'miss', reason: 'occluded', occluder }

  const blockerHit = blockerHits.find(hit =>
    findCockpitOccluder(raycaster, hit.distance, registry.occluderMeshes) == null
  )
  if (blockerHit != null) {
    return {
      kind: 'consumed',
      reason: blockerHit.blocker.reason,
      object: blockerHit.blocker.object,
      target: blockerHit.blocker.target
    }
  }

  const isEmpty =
    registry.interactionMeshes.length === 0 &&
    registry.fallbackHitboxes.length === 0 &&
    registry.blockers.length === 0 &&
    registry.gaugeSurfaces.length === 0
  return {
    kind: 'miss',
    reason: isEmpty ? 'empty-interaction-registry' : 'raycast-miss',
    occluder: null
  }
}

export function collectCockpitOccluderMeshes(
  root: Object3D,
  excludedMeshes: ReadonlySet<Mesh>,
  isOccluder: (mesh: Mesh) => boolean,
  retainedMeshes: ReadonlySet<Mesh> = new Set()
): Mesh[] {
  const occluders: Mesh[] = []
  root.traverse(node => {
    if (
      !isRenderableMesh(node) ||
      (excludedMeshes.has(node) && !retainedMeshes.has(node)) ||
      !isOccluder(node)
    ) return
    occluders.push(node)
  })
  return occluders
}

function intersectBox(raycaster: Raycaster, box: Box3 | undefined): { readonly distance: number; readonly point: Vector3 } | null {
  if (box == null) return null
  const point = raycaster.ray.intersectBox(box, new Vector3())
  return point == null ? null : { distance: point.distanceTo(raycaster.ray.origin), point }
}

function findCockpitOccluder(
  raycaster: Raycaster,
  hitDistance: number,
  occluderMeshes: readonly Mesh[]
): Object3D | null {
  const maxDistance = Math.max(hitDistance - HIT_EPSILON, 0)
  if (maxDistance <= 0 || occluderMeshes.length === 0) return null

  const candidates = occluderMeshes.filter(mesh => {
    if (!isRenderableMesh(mesh)) return false
    mesh.updateWorldMatrix(true, false)
    const bounds = new Box3().setFromObject(mesh)
    const point = bounds.isEmpty()
      ? null
      : raycaster.ray.intersectBox(bounds, new Vector3())
    return point != null && point.distanceTo(raycaster.ray.origin) <= maxDistance
  })
  return raycaster
    .intersectObjects(candidates, false)
    .find(hit => hit.distance <= maxDistance)?.object ?? null
}

function isRenderableMesh(object: Object3D): object is Mesh {
  const mesh = object as Mesh
  return mesh.isMesh === true && mesh.geometry != null && object.visible
}
