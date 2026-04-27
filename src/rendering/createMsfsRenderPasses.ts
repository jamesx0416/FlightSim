import {
  Mesh,
  type Object3D,
  type Scene,
  type Camera,
  type Material
} from 'three'

import {
  usesBlendGBufferMaterial
} from '../msfs/gltf/normalizeMsfsMaterials'
import type { AppRenderer } from './createAppRenderer'

type MsfsMaterial = Material & {
  userData?: {
    readonly gltfExtensions?: Record<string, unknown>
  }
}

type BlendGBufferMesh = Mesh & {
  material: MsfsMaterial
}

export interface MsfsRenderPasses {
  readonly hasBlendGBufferDecals: boolean
  refresh(): void
  render(): void
}

export function createMsfsRenderPasses(
  renderer: AppRenderer,
  scene: Scene,
  camera: Camera,
  root: Object3D
): MsfsRenderPasses {
  const blendMeshes: BlendGBufferMesh[] = []
  const baseMeshes: Mesh[] = []

  const refresh = (): void => {
    blendMeshes.length = 0
    baseMeshes.length = 0

    root.traverse(object => {
      if (!(object instanceof Mesh)) {
        return
      }

      const materials = Array.isArray(object.material)
        ? object.material
        : object.material != null
          ? [object.material]
          : []
      if (materials.some(material => usesBlendGBufferMaterial(material as MsfsMaterial))) {
        blendMeshes.push(object as BlendGBufferMesh)
        return
      }

      baseMeshes.push(object)
    })
  }

  refresh()

  return {
    get hasBlendGBufferDecals() {
      return blendMeshes.length > 0
    },
    refresh,
    render: () => {
      if (blendMeshes.length === 0) {
        renderer.render(scene, camera)
        return
      }

      const originalBackground = scene.background
      const originalAutoClear = renderer.autoClear
      const hiddenBlendMeshes = hideMeshDrawablesFromCamera(blendMeshes, camera)

      try {
        renderer.autoClear = true
        renderer.render(scene, camera)
      } finally {
        restoreMeshDrawables(hiddenBlendMeshes)
      }

      const hiddenBaseMeshesForDecals = hideMeshDrawablesFromCamera(baseMeshes, camera)
      try {
        scene.background = null
        renderer.autoClear = false
        renderer.render(scene, camera)
      } finally {
        restoreMeshDrawables(hiddenBaseMeshesForDecals)
        scene.background = originalBackground
        renderer.autoClear = originalAutoClear
      }
    },
  }
}

function hideMeshDrawablesFromCamera(
  meshes: readonly Mesh[],
  camera: Camera
): Map<Mesh, number> {
  const hiddenMeshLayerMasks = new Map<Mesh, number>()
  const hiddenLayerMask = findLayerMaskOutsideCamera(camera)

  for (const mesh of meshes) {
    hiddenMeshLayerMasks.set(mesh, mesh.layers.mask)
    mesh.layers.mask = hiddenLayerMask
  }

  return hiddenMeshLayerMasks
}

function restoreMeshDrawables(hiddenMeshLayerMasks: Map<Mesh, number>): void {
  for (const [mesh, layerMask] of hiddenMeshLayerMasks) {
    mesh.layers.mask = layerMask
  }
}

function findLayerMaskOutsideCamera(camera: Camera): number {
  for (let layer = 0; layer < 32; layer += 1) {
    const layerMask = 1 << layer
    if ((camera.layers.mask & layerMask) === 0) {
      return layerMask
    }
  }

  return 0
}
