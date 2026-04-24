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
      const hiddenBlendMeshes = hideMeshes(blendMeshes)

      try {
        renderer.autoClear = true
        renderer.render(scene, camera)
      } finally {
        restoreMeshes(hiddenBlendMeshes)
      }

      const hiddenBaseMeshesForDecals = hideMeshes(baseMeshes)
      try {
        scene.background = null
        renderer.autoClear = false
        renderer.render(scene, camera)
      } finally {
        restoreMeshes(hiddenBaseMeshesForDecals)
        scene.background = originalBackground
        renderer.autoClear = originalAutoClear
      }
    },
  }
}

function hideMeshes(meshes: readonly Mesh[]): Map<Mesh, boolean> {
  const hiddenMeshes = new Map<Mesh, boolean>()

  for (const mesh of meshes) {
    hiddenMeshes.set(mesh, mesh.visible)
    mesh.visible = false
  }

  return hiddenMeshes
}

function restoreMeshes(hiddenMeshes: Map<Mesh, boolean>): void {
  for (const [mesh, visible] of hiddenMeshes) {
    mesh.visible = visible
  }
}
