import {
  DepthFormat,
  Mesh,
  UnsignedIntType,
  Vector2,
  type Object3D,
  type Scene,
  type Camera,
  type Material
} from 'three'

import {
  getMsfsBlendGBufferDepthTexture,
  setMsfsBlendGBufferDepthMaskEnabled,
  usesBlendGBufferColorMaterial,
  usesBlendGBufferMaterial
} from '../msfs/gltf/normalizeMsfsMaterials'
import type { AppRenderer } from './createAppRenderer'

type MsfsMaterial = Material & {
  depthTest?: boolean
  depthWrite?: boolean
  polygonOffset?: boolean
  userData?: {
    readonly gltfExtensions?: Record<string, unknown>
    readonly msfsBlendGBufferDepthMask?: boolean
    readonly msfsBlendGBufferForwardColor?: boolean
  }
}

type MaterialRenderState = {
  readonly visible: boolean
  readonly depthTest: boolean
  readonly depthWrite: boolean
  readonly polygonOffset: boolean
}

type BlendGBufferMesh = Mesh & {
  material: MsfsMaterial
  userData?: {
    readonly msfsBlendGBufferProjectedToReceiver?: boolean
  }
}

type DepthCopyRenderer = AppRenderer & {
  copyFramebufferToTexture?: (texture: unknown) => void
  getDrawingBufferSize?: (target: Vector2) => Vector2
}

const depthTextureSize = new Vector2()

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
  const decalBlendMeshes: BlendGBufferMesh[] = []
  const hiddenBlendMaterials = new Set<Material>()
  const colorBlendMaterials = new Set<Material>()
  const componentOnlyBlendMaterials = new Set<Material>()
  const nonBlendMaterialsOnBlendMeshes = new Set<Material>()
  const originalBlendMeshLayerMasks = new Map<Mesh, number>()
  let decalLayerMask = findLayerMaskOutsideCamera(camera)

  const refresh = (): void => {
    restoreMeshDrawables(originalBlendMeshLayerMasks)
    originalBlendMeshLayerMasks.clear()
    blendMeshes.length = 0
    decalBlendMeshes.length = 0
    hiddenBlendMaterials.clear()
    colorBlendMaterials.clear()
    componentOnlyBlendMaterials.clear()
    nonBlendMaterialsOnBlendMeshes.clear()
    decalLayerMask = findLayerMaskOutsideCamera(camera)

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
        const blendMesh = object as BlendGBufferMesh
        blendMeshes.push(blendMesh)
        const isProjectedDecal =
          blendMesh.userData?.msfsBlendGBufferProjectedToReceiver === true &&
          materials.some(material => usesBlendGBufferColorMaterial(material as MsfsMaterial))
        if (isProjectedDecal) {
          decalBlendMeshes.push(blendMesh)
        }
        for (const material of materials) {
          if (usesBlendGBufferMaterial(material as MsfsMaterial)) {
            const isColorBlendMaterial = usesBlendGBufferColorMaterial(material as MsfsMaterial)
            const isDrawOrderBlendMaterial = usesBlendGBufferDrawOrderMaterial(
              material as MsfsMaterial
            )
            if (isProjectedDecal && isColorBlendMaterial) {
              hiddenBlendMaterials.add(material)
              colorBlendMaterials.add(material)
            } else if (!isColorBlendMaterial || isDrawOrderBlendMaterial) {
              hiddenBlendMaterials.add(material)
              componentOnlyBlendMaterials.add(material)
            } else {
              // Receiverless blend-gbuffer color materials without draw-order
              // metadata are treated as physical/background surfaces in this
              // forward renderer. They stay visible in the base pass with the
              // blend depth mask disabled.
            }
          } else {
            nonBlendMaterialsOnBlendMeshes.add(material)
          }
        }
      }
    })

    addMeshDrawablesToLayer(
      decalBlendMeshes,
      decalLayerMask,
      originalBlendMeshLayerMasks
    )
  }

  refresh()

  return {
    get hasBlendGBufferDecals() {
      return decalBlendMeshes.length > 0
    },
    refresh,
    render: () => {
      if (blendMeshes.length === 0) {
        renderer.render(scene, camera)
        return
      }

      if (!canMaskBlendGBufferSceneDepth(renderer, colorBlendMaterials)) {
        const originalMaterialState = new Map<MsfsMaterial, MaterialRenderState>()
        try {
          hideMaterials(componentOnlyBlendMaterials, originalMaterialState)
          setMsfsBlendGBufferDepthMaskEnabled(false)
          renderer.render(scene, camera)
        } finally {
          setMsfsBlendGBufferDepthMaskEnabled(true)
          restoreMaterialRenderState(
            originalMaterialState.keys(),
            originalMaterialState
          )
        }
        return
      }

      const originalBackground = scene.background
      const originalAutoClear = renderer.autoClear
      const originalCameraLayerMask = camera.layers.mask
      const originalMaterialState = new Map<MsfsMaterial, MaterialRenderState>()

      try {
        renderer.autoClear = true
        setMsfsBlendGBufferDepthMaskEnabled(false)
        hideMaterials(hiddenBlendMaterials, originalMaterialState)
        renderer.render(scene, camera)
        // Resolve the mask from the base pass while blend-gbuffer materials are
        // still hidden, so copy and render-target fallback paths sample the same
        // receiver depth.
        const useDepthMask = copyBlendGBufferSceneDepth(renderer, colorBlendMaterials)
        setMsfsBlendGBufferDepthMaskEnabled(true)

        restoreMaterialRenderState(colorBlendMaterials, originalMaterialState)
        hideMaterials(componentOnlyBlendMaterials, originalMaterialState)
        hideMaterials(nonBlendMaterialsOnBlendMeshes, originalMaterialState)
        configureBlendGBufferMaterialsForDecalPass(
          colorBlendMaterials,
          originalMaterialState,
          useDepthMask
        )
        setMsfsBlendGBufferDepthMaskEnabled(useDepthMask)
        camera.layers.mask = decalLayerMask
        scene.background = null
        renderer.autoClear = false
        renderer.render(scene, camera)
      } finally {
        setMsfsBlendGBufferDepthMaskEnabled(true)
        restoreMaterialRenderState(
          originalMaterialState.keys(),
          originalMaterialState
        )
        camera.layers.mask = originalCameraLayerMask
        scene.background = originalBackground
        renderer.autoClear = originalAutoClear
      }
    },
  }
}

function addMeshDrawablesToLayer(
  meshes: readonly Mesh[],
  layerMask: number,
  originalMeshLayerMasks: Map<Mesh, number>
): void {
  for (const mesh of meshes) {
    originalMeshLayerMasks.set(mesh, mesh.layers.mask)
    mesh.layers.mask |= layerMask
  }
}

function restoreMeshDrawables(originalMeshLayerMasks: Map<Mesh, number>): void {
  for (const [mesh, layerMask] of originalMeshLayerMasks) {
    mesh.layers.mask = layerMask
  }
}

function hideMaterials(
  materials: Iterable<Material>,
  originalMaterialState: Map<MsfsMaterial, MaterialRenderState>
): void {
  for (const material of materials) {
    preserveMaterialRenderState(material as MsfsMaterial, originalMaterialState)
    material.visible = false
  }
}

function usesBlendGBufferDrawOrderMaterial(material: MsfsMaterial): boolean {
  return material.userData?.gltfExtensions?.ASOBO_material_draw_order != null
}

function configureBlendGBufferMaterialsForDecalPass(
  materials: Iterable<Material>,
  originalMaterialState: Map<MsfsMaterial, MaterialRenderState>,
  useDepthMask: boolean
): void {
  for (const material of materials) {
    const msfsMaterial = material as MsfsMaterial
    const hasDepthMask = msfsMaterial.userData?.msfsBlendGBufferDepthMask === true
    const useMaterialDepthMask = hasDepthMask && useDepthMask
    preserveMaterialRenderState(msfsMaterial, originalMaterialState)
    msfsMaterial.visible = originalMaterialState.get(msfsMaterial)?.visible ?? msfsMaterial.visible
    msfsMaterial.depthTest = !useMaterialDepthMask
    msfsMaterial.depthWrite = false
    msfsMaterial.polygonOffset =
      useMaterialDepthMask
        ? false
        : originalMaterialState.get(msfsMaterial)?.polygonOffset ?? msfsMaterial.polygonOffset ?? false
  }
}

function copyBlendGBufferSceneDepth(
  renderer: AppRenderer,
  materials: Iterable<Material>
): boolean {
  if (!canCopyBlendGBufferSceneDepth(renderer, materials)) {
    return false
  }

  const depthCopyRenderer = renderer as DepthCopyRenderer
  depthCopyRenderer.getDrawingBufferSize(depthTextureSize)
  const depthTexture = getMsfsBlendGBufferDepthTexture()
  depthTexture.format = DepthFormat
  depthTexture.type = UnsignedIntType
  if (
    depthTexture.image.width !== depthTextureSize.x ||
    depthTexture.image.height !== depthTextureSize.y
  ) {
    depthTexture.image.width = depthTextureSize.x
    depthTexture.image.height = depthTextureSize.y
    depthTexture.needsUpdate = true
  }

  depthCopyRenderer.copyFramebufferToTexture(depthTexture)
  return true
}

function getConfiguredBlendGBufferDepthTexture() {
  const depthTexture = getMsfsBlendGBufferDepthTexture()
  depthTexture.format = DepthFormat
  depthTexture.type = UnsignedIntType
  return depthTexture
}

function canCopyBlendGBufferSceneDepth(
  renderer: AppRenderer,
  materials: Iterable<Material>
): boolean {
  if (!hasBlendGBufferDepthMaskMaterial(materials)) {
    return false
  }

  const depthCopyRenderer = renderer as DepthCopyRenderer
  return (
    depthCopyRenderer.copyFramebufferToTexture != null &&
    depthCopyRenderer.getDrawingBufferSize != null
  )
}

function canMaskBlendGBufferSceneDepth(
  renderer: AppRenderer,
  materials: Iterable<Material>
): boolean {
  return canCopyBlendGBufferSceneDepth(renderer, materials)
}

function hasBlendGBufferDepthMaskMaterial(materials: Iterable<Material>): boolean {
  for (const material of materials) {
    if ((material as MsfsMaterial).userData?.msfsBlendGBufferDepthMask === true) {
      return true
    }
  }

  return false
}

function restoreMaterialRenderState(
  materials: Iterable<Material>,
  originalMaterialState: ReadonlyMap<MsfsMaterial, MaterialRenderState>
): void {
  for (const material of materials) {
    const msfsMaterial = material as MsfsMaterial
    const state = originalMaterialState.get(msfsMaterial)
    if (state != null) {
      msfsMaterial.visible = state.visible
      msfsMaterial.depthTest = state.depthTest
      msfsMaterial.depthWrite = state.depthWrite
      msfsMaterial.polygonOffset = state.polygonOffset
    }
  }
}

function preserveMaterialRenderState(
  material: MsfsMaterial,
  originalMaterialState: Map<MsfsMaterial, MaterialRenderState>
): void {
  if (originalMaterialState.has(material)) {
    return
  }

  originalMaterialState.set(material, {
    visible: material.visible,
    depthTest: material.depthTest ?? true,
    depthWrite: material.depthWrite ?? true,
    polygonOffset: material.polygonOffset ?? false
  })
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
