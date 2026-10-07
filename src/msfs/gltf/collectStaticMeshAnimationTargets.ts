import {
  Material,
  Object3D,
  PropertyBinding,
  SkinnedMesh,
  type AnimationClip,
  type ParseTrackNameResults
} from 'three'

export type StaticMeshAnimationTargets = {
  readonly nodes: ReadonlySet<Object3D>
  readonly materials: ReadonlySet<Material>
}

/**
 * Resolve each animation track through Three's runtime binding rules. A null result means at
 * least one target could not be resolved, so callers must leave the scene unoptimized.
 */
export function collectStaticMeshAnimationTargets(
  root: Object3D,
  animations: readonly AnimationClip[]
): StaticMeshAnimationTargets | null {
  const nodes = new Set<Object3D>()
  const materials = new Set<Material>()

  try {
    for (const animation of animations) {
      for (const track of animation.tracks) {
        const binding = new PropertyBinding(root, track.name)
        const node = binding.node
        if (!(node instanceof Object3D)) {
          return null
        }

        const path = binding.parsedPath as ParseTrackNameResults
        const target = resolveAnimationTarget(node, path)
        if (target instanceof Material) {
          materials.add(target)
        } else if (target instanceof Object3D) {
          nodes.add(target)
        } else {
          return null
        }
      }
    }
  } catch {
    return null
  }

  return { nodes, materials }
}

function resolveAnimationTarget(
  node: Object3D,
  path: ParseTrackNameResults
): Object3D | Material | null {
  const objectName = path.objectName
  if (objectName == null || objectName === '') {
    return objectNameHasProperty(node, path.propertyName) ? node : null
  }

  if (objectName === 'bones') {
    if (!(node instanceof SkinnedMesh) || path.objectIndex == null || path.objectIndex === '') {
      return null
    }
    const boneByName = node.skeleton.bones.find(candidate => candidate.name === path.objectIndex)
    const boneIndex = /^(0|[1-9]\d*)$/.test(path.objectIndex)
      ? Number(path.objectIndex)
      : -1
    const bone = boneByName ?? node.skeleton.bones[boneIndex]
    return bone != null && objectNameHasProperty(bone, path.propertyName) ? bone : null
  }

  if (objectName === 'materials' || objectName === 'map') {
    // PropertyBinding resolves these through renderer-specific texture/material state.
    // That state is not represented by a single Object3D target, so skip batching.
    return null
  }

  let target: unknown = (node as unknown as Record<string, unknown>)[objectName]
  if (path.objectIndex != null && path.objectIndex !== '') {
    if (target == null || typeof target !== 'object') {
      return null
    }
    target = (target as Record<string, unknown>)[path.objectIndex]
  }

  if (
    !(target instanceof Object3D) &&
    !(target instanceof Material)
  ) {
    return null
  }
  return objectNameHasProperty(target, path.propertyName) ? target : null
}

function objectNameHasProperty(target: object, propertyName: string): boolean {
  return propertyName in target
}
