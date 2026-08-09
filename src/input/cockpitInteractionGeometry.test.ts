import { expect, test } from 'bun:test'
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Raycaster,
  Vector3
} from 'three'

import {
  collectCockpitOccluderMeshes,
  resolveCockpitGeometryHit,
  type CockpitGeometryRegistry
} from './cockpitInteractionGeometry'

const raycaster = (): Raycaster =>
  new Raycaster(new Vector3(0, 0, 5), new Vector3(0, 0, -1))

const meshAt = (name: string, z: number): Mesh => {
  const mesh = new Mesh(new BoxGeometry(1, 1, 0.2), new MeshBasicMaterial())
  mesh.name = name
  mesh.position.z = z
  mesh.updateWorldMatrix(true, false)
  return mesh
}

const registry = <T>(overrides: Partial<CockpitGeometryRegistry<T>> = {}): CockpitGeometryRegistry<T> => ({
  interactionMeshes: [],
  fallbackHitboxes: [],
  blockers: [],
  gaugeSurfaces: [],
  occluderMeshes: [],
  ...overrides
})

test('interaction meshes are active while a true geometric miss stays a miss', () => {
  const control = meshAt('control', 0)
  const active = resolveCockpitGeometryHit(raycaster(), registry({
    interactionMeshes: [{
      object: control,
      binding: 'CONTROL',
      prioritizeVCockpits: false,
      ignoreZTest: false
    }]
  }))
  expect(active.kind).toBe('active')
  if (active.kind !== 'active') throw new Error('Expected an active interaction mesh hit.')
  expect([active.binding, active.object, active.hitKind]).toEqual([
    'CONTROL',
    control,
    'interaction-mesh'
  ])
  expect(Math.abs(active.point.z - 0.1) < 1e-6).toBe(true)

  control.position.x = 4
  control.updateWorldMatrix(true, false)
  expect(resolveCockpitGeometryHit(raycaster(), registry({
    interactionMeshes: [{
      object: control,
      binding: 'CONTROL',
      prioritizeVCockpits: false,
      ignoreZTest: false
    }]
  }))).toEqual({ kind: 'miss', reason: 'raycast-miss', occluder: null })
})

test('live visibility and ancestor visibility gate cached interaction meshes', () => {
  const parent = new Group()
  const control = meshAt('control', 0)
  parent.add(control)
  parent.updateWorldMatrix(true, true)
  const cached = registry({
    interactionMeshes: [{
      object: control,
      binding: 'CONTROL',
      prioritizeVCockpits: false,
      ignoreZTest: false
    }]
  })

  control.visible = false
  expect(resolveCockpitGeometryHit(raycaster(), cached)).toEqual({
    kind: 'miss', reason: 'raycast-miss', occluder: null
  })

  control.visible = true
  parent.visible = false
  expect(resolveCockpitGeometryHit(raycaster(), cached)).toEqual({
    kind: 'miss', reason: 'raycast-miss', occluder: null
  })

  parent.visible = true
  expect(resolveCockpitGeometryHit(raycaster(), cached).kind).toBe('active')
})

test('PrioritizeVCockpits wins before geometric depth and equal priority keeps the nearest hit', () => {
  const near = meshAt('near', 1)
  const far = meshAt('far', 0)
  const targets = [
    { object: near, binding: 'NEAR', prioritizeVCockpits: false, ignoreZTest: false },
    { object: far, binding: 'FAR', prioritizeVCockpits: true, ignoreZTest: false }
  ]
  const prioritized = resolveCockpitGeometryHit(raycaster(), registry({ interactionMeshes: targets }))
  expect(prioritized.kind === 'active' ? prioritized.binding : null).toBe('FAR')

  const nearest = resolveCockpitGeometryHit(raycaster(), registry({
    interactionMeshes: targets.map(target => ({ ...target, prioritizeVCockpits: false }))
  }))
  expect(nearest.kind === 'active' ? nearest.binding : null).toBe('NEAR')
})

test('fallback hitboxes remain selectable without renderable interaction geometry', () => {
  const sourceNode = new Object3D()
  sourceNode.name = 'fallback-source'
  const hit = resolveCockpitGeometryHit(raycaster(), registry({
    fallbackHitboxes: [{
      object: sourceNode,
      box: new Box3(new Vector3(-0.5, -0.5, -0.1), new Vector3(0.5, 0.5, 0.1)),
      binding: 'FALLBACK',
      prioritizeVCockpits: false,
      ignoreZTest: false
    }]
  }))
  expect(hit.kind).toBe('active')
  if (hit.kind !== 'active') throw new Error('Expected an active fallback hitbox hit.')
  expect([hit.binding, hit.object, hit.hitKind]).toEqual([
    'FALLBACK',
    sourceNode,
    'fallback-hitbox'
  ])
  expect(Math.abs(hit.point.z - 0.1) < 1e-6).toBe(true)
})

test('blockers and covers consume hits in front of an interaction', () => {
  const control = meshAt('control', 0)
  const blocker = meshAt('guard', 1)
  for (const reason of ['blocker', 'cover'] as const) {
    const hit = resolveCockpitGeometryHit(raycaster(), registry({
      interactionMeshes: [{
        object: control,
        binding: 'CONTROL',
        prioritizeVCockpits: false,
        ignoreZTest: false
      }],
      blockers: [{ object: blocker, mesh: blocker, target: blocker.name, reason }]
    }))
    expect(hit.kind).toBe('consumed')
    if (hit.kind !== 'consumed') throw new Error(`Expected ${reason} to consume the hit.`)
    expect([hit.reason, hit.object, hit.target]).toEqual([reason, blocker, 'guard'])
  }
})

test('IgnoreZTest authoritatively bypasses ordinary cockpit occlusion', () => {
  const control = meshAt('control', 0)
  const panel = meshAt('panel', 1)
  const interaction = {
    object: control,
    binding: 'CONTROL',
    prioritizeVCockpits: false,
    ignoreZTest: false
  }
  const occluded = resolveCockpitGeometryHit(raycaster(), registry({
    interactionMeshes: [interaction],
    occluderMeshes: [panel]
  }))
  expect(occluded).toEqual({ kind: 'miss', reason: 'occluded', occluder: panel })

  const ignored = resolveCockpitGeometryHit(raycaster(), registry({
    interactionMeshes: [{ ...interaction, ignoreZTest: true }],
    occluderMeshes: [panel]
  }))
  expect(ignored.kind === 'active' ? ignored.binding : null).toBe('CONTROL')
})

test('a claimed VCockpit gauge mesh hides controls but falls through to camera input', () => {
  const root = new Group()
  const control = meshAt('control', 0)
  const gauge = meshAt('gauge', 1)
  root.add(control, gauge)
  root.updateWorldMatrix(true, true)
  const occluders = collectCockpitOccluderMeshes(
    root,
    new Set([control, gauge]),
    () => true,
    new Set([gauge])
  )
  expect(occluders).toEqual([gauge])

  const hit = resolveCockpitGeometryHit(raycaster(), registry({
    interactionMeshes: [{
      object: control,
      binding: 'CONTROL',
      prioritizeVCockpits: false,
      ignoreZTest: false
    }],
    gaugeSurfaces: [gauge],
    occluderMeshes: occluders
  }))
  expect(hit).toEqual({ kind: 'miss', reason: 'occluded', occluder: gauge })
})
