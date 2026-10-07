import {
  Material,
  LOD,
  Object3D,
  ShaderMaterial,
  SkinnedMesh,
  type Mesh
} from 'three'
import { NodeMaterial } from 'three/webgpu'

/** Keep batching limited to meshes whose render and vertex behavior survives regrouping. */
export function isSafeStaticMeshBatchCandidate(mesh: Mesh, material: Material): boolean {
  if (
    mesh instanceof SkinnedMesh ||
    mesh.parent instanceof LOD ||
    mesh.children.length > 0 ||
    (mesh.morphTargetInfluences != null && mesh.morphTargetInfluences.length > 0) ||
    Object.keys(mesh.geometry.morphAttributes).length > 0 ||
    mesh.matrixAutoUpdate === false ||
    mesh.matrixWorldAutoUpdate === false ||
    mesh.onBeforeRender !== Object3D.prototype.onBeforeRender ||
    mesh.onAfterRender !== Object3D.prototype.onAfterRender ||
    mesh.onBeforeShadow !== Object3D.prototype.onBeforeShadow ||
    mesh.onAfterShadow !== Object3D.prototype.onAfterShadow ||
    mesh.customDepthMaterial != null ||
    mesh.customDistanceMaterial != null ||
    material.onBeforeRender !== Material.prototype.onBeforeRender
  ) {
    return false
  }

  if ('displacementMap' in material && material.displacementMap != null) {
    return false
  }

  if (material instanceof ShaderMaterial) {
    return false
  }

  if (material instanceof NodeMaterial) {
    return (
      material.positionNode == null &&
      material.vertexNode == null &&
      material.geometryNode == null &&
      !('displacementMap' in material && material.displacementMap != null) &&
      material.setupPosition === NodeMaterial.prototype.setupPosition &&
      material.setupVertex === NodeMaterial.prototype.setupVertex &&
      material.setup === NodeMaterial.prototype.setup &&
      material.customProgramCacheKey === NodeMaterial.prototype.customProgramCacheKey
    )
  }

  return (
    material.onBeforeCompile === Material.prototype.onBeforeCompile &&
    material.customProgramCacheKey === Material.prototype.customProgramCacheKey
  )
}
