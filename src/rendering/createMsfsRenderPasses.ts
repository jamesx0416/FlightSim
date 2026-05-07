import {
  DepthFormat,
  Mesh,
  MeshBasicMaterial,
  RenderTarget,
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
}

type DepthCopyRenderer = AppRenderer & {
  copyFramebufferToTexture?: (texture: unknown) => void
  getDrawingBufferSize?: (target: Vector2) => Vector2
}

type RenderTargetRenderer = AppRenderer & {
  getRenderTarget(): RenderTarget | null
  setRenderTarget(renderTarget: RenderTarget | null): void
}

const depthTextureSize = new Vector2()
const depthOnlyMaterial = new MeshBasicMaterial({
  colorWrite: false,
  depthTest: true,
  depthWrite: true
})
depthOnlyMaterial.name = 'MSFS_BLEND_GBUFFER_DEPTH_ONLY'

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
  const allBlendMaterials = new Set<Material>()
  const colorBlendMaterials = new Set<Material>()
  const componentOnlyBlendMaterials = new Set<Material>()
  const nonBlendMaterialsOnBlendMeshes = new Set<Material>()
  const originalBlendMeshLayerMasks = new Map<Mesh, number>()
  let depthRenderTarget: RenderTarget | null = null
  let decalLayerMask = findLayerMaskOutsideCamera(camera)

  const refresh = (): void => {
    restoreMeshDrawables(originalBlendMeshLayerMasks)
    originalBlendMeshLayerMasks.clear()
    blendMeshes.length = 0
    allBlendMaterials.clear()
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
        blendMeshes.push(object as BlendGBufferMesh)
        for (const material of materials) {
          if (usesBlendGBufferMaterial(material as MsfsMaterial)) {
            allBlendMaterials.add(material)
            if (usesBlendGBufferColorMaterial(material as MsfsMaterial)) {
              colorBlendMaterials.add(material)
            } else {
              componentOnlyBlendMaterials.add(material)
            }
          } else {
            nonBlendMaterialsOnBlendMeshes.add(material)
          }
        }
      }
    })

    addMeshDrawablesToLayer(
      blendMeshes,
      decalLayerMask,
      originalBlendMeshLayerMasks
    )
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
      const originalCameraLayerMask = camera.layers.mask
      const originalMaterialState = new Map<MsfsMaterial, MaterialRenderState>()

      try {
        renderer.autoClear = true
        hideMaterials(allBlendMaterials, originalMaterialState)
        const renderTargetDepthAvailable = renderBasePassToDepthTarget(renderer, scene, camera)
        renderer.render(scene, camera)

        restoreMaterialRenderState(colorBlendMaterials, originalMaterialState)
        hideMaterials(componentOnlyBlendMaterials, originalMaterialState)
        hideMaterials(nonBlendMaterialsOnBlendMeshes, originalMaterialState)
        const useDepthMask =
          renderTargetDepthAvailable || copyBlendGBufferSceneDepth(renderer, colorBlendMaterials)
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

  function renderBasePassToDepthTarget(
    renderer: AppRenderer,
    scene: Scene,
    camera: Camera
  ): boolean {
    if (!isWebGpuRenderer(renderer) || !hasBlendGBufferDepthMaskMaterial(colorBlendMaterials)) {
      return false
    }

    const renderTargetRenderer = renderer as RenderTargetRenderer
    if (
      typeof renderTargetRenderer.getRenderTarget !== 'function' ||
      typeof renderTargetRenderer.setRenderTarget !== 'function' ||
      typeof renderer.getDrawingBufferSize !== 'function'
    ) {
      return false
    }

    renderer.getDrawingBufferSize(depthTextureSize)
    const width = Math.max(1, Math.floor(depthTextureSize.x))
    const height = Math.max(1, Math.floor(depthTextureSize.y))
    depthRenderTarget = ensureBlendGBufferDepthRenderTarget(depthRenderTarget, width, height)

    const previousRenderTarget = renderTargetRenderer.getRenderTarget()
    const previousOverrideMaterial = scene.overrideMaterial
    try {
      renderTargetRenderer.setRenderTarget(depthRenderTarget)
      scene.overrideMaterial = depthOnlyMaterial
      renderer.render(scene, camera)
    } finally {
      scene.overrideMaterial = previousOverrideMaterial
      renderTargetRenderer.setRenderTarget(previousRenderTarget)
    }

    return true
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
  if (!hasBlendGBufferDepthMaskMaterial(materials)) {
    return false
  }

  const depthCopyRenderer = renderer as DepthCopyRenderer
  if ((renderer as AppRenderer & { readonly backend?: { readonly isWebGPUBackend?: boolean } }).backend?.isWebGPUBackend === true) {
    return false
  }

  if (
    depthCopyRenderer.copyFramebufferToTexture == null ||
    depthCopyRenderer.getDrawingBufferSize == null
  ) {
    return false
  }

  depthCopyRenderer.getDrawingBufferSize(depthTextureSize)
  const depthTexture = getMsfsBlendGBufferDepthTexture()
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

function hasBlendGBufferDepthMaskMaterial(materials: Iterable<Material>): boolean {
  for (const material of materials) {
    if ((material as MsfsMaterial).userData?.msfsBlendGBufferDepthMask === true) {
      return true
    }
  }

  return false
}

function ensureBlendGBufferDepthRenderTarget(
  renderTarget: RenderTarget | null,
  width: number,
  height: number
): RenderTarget {
  const depthTexture = getMsfsBlendGBufferDepthTexture()
  depthTexture.format = DepthFormat
  depthTexture.type = UnsignedIntType
  if (
    depthTexture.image.width !== width ||
    depthTexture.image.height !== height
  ) {
    depthTexture.image.width = width
    depthTexture.image.height = height
    depthTexture.needsUpdate = true
  }

  if (renderTarget == null) {
    return new RenderTarget(width, height, {
      depthBuffer: true,
      depthTexture,
      samples: 0
    })
  }

  if (renderTarget.width !== width || renderTarget.height !== height) {
    renderTarget.setSize(width, height)
  }
  if (renderTarget.depthTexture !== depthTexture) {
    renderTarget.depthTexture = depthTexture
  }

  return renderTarget
}

function isWebGpuRenderer(renderer: AppRenderer): boolean {
  return (renderer as AppRenderer & { readonly backend?: { readonly isWebGPUBackend?: boolean } })
    .backend?.isWebGPUBackend === true
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
