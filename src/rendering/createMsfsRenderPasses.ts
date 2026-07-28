import {
  Color,
  DepthFormat,
  Mesh,
  MeshBasicMaterial,
  UnsignedIntType,
  Vector2,
  type Camera,
  type Material,
  type Object3D,
  type Scene
} from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import {
  createMsfsDeferredLightingMaterial,
  getMsfsBlendGBufferDepthTexture,
  getMsfsGBufferWriter,
  setMsfsBlendGBufferDepthMaskEnabled,
  usesBlendGBufferColorMaterial,
  usesBlendGBufferMaterial
} from '../msfs/gltf/normalizeMsfsMaterials'
import {
  createAircraftGBuffer,
  supportsAircraftGBuffer
} from './createAircraftGBuffer'
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

export type MsfsDecalRenderPath = 'regular' | 'deferred' | 'forward'

export function selectMsfsDecalRenderPath(
  hasBlendGBufferDecals: boolean,
  hasDeferredRelationships: boolean,
  supportsDeferred: boolean
): MsfsDecalRenderPath {
  if (!hasBlendGBufferDecals) {
    return 'regular'
  }
  return supportsDeferred && hasDeferredRelationships ? 'deferred' : 'forward'
}

export function canKeepBlendGBufferDecalInForwardScenePass(
  materials: readonly Material[]
): boolean {
  return materials.every(material =>
    material.transparent === true && usesBlendGBufferColorMaterial(material)
  )
}

export function hasBlendGBufferReceiver(receiverCount: number): boolean {
  return receiverCount > 0
}

export function createMsfsRenderPasses(
  renderer: AppRenderer,
  scene: Scene,
  camera: Camera,
  root: Object3D
): MsfsRenderPasses {
  const fallback = createForwardMsfsRenderPasses(renderer, scene, camera, root)
  if (!hasBlendGBufferMaterials(root) || !supportsAircraftGBuffer(renderer)) {
    return fallback
  }
  return createDeferredMsfsRenderPasses(renderer, scene, camera, root, fallback)
}

function hasBlendGBufferMaterials(root: Object3D): boolean {
  let found = false
  root.traverse(object => {
    if (found || !(object instanceof Mesh)) {
      return
    }
    const materials = Array.isArray(object.material)
      ? object.material
      : [object.material]
    found = materials.some(usesBlendGBufferMaterial)
  })
  return found
}

type MeshMaterial = Material | Material[]

type DeferredMesh = Mesh & {
  material: MeshMaterial
  userData: Mesh['userData'] & {
    readonly msfsBlendGBufferProjectedToReceiver?: boolean
    readonly msfsBlendGBufferReceiver?: DeferredMesh
    readonly msfsBlendGBufferReceivers?: readonly DeferredMesh[]
  }
}

function createDeferredMsfsRenderPasses(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  root: Object3D,
  fallback: MsfsRenderPasses
): MsfsRenderPasses {
  const gBuffer = createAircraftGBuffer(renderer)
  const hiddenMaterial = new MeshBasicMaterial({
    colorWrite: false,
    depthTest: false,
    depthWrite: false,
  })
  const decals: DeferredMesh[] = []
  const forwardDecals: DeferredMesh[] = []
  const receivers = new Set<DeferredMesh>()
  const writerMaterials = new Map<DeferredMesh, MeshMaterial>()
  const lightingMaterials = new Map<DeferredMesh, MeshMaterial>()
  const sourceMaterials = new Map<DeferredMesh, MeshMaterial>()
  const forwardSourceMaterials = new Map<DeferredMesh, MeshMaterial>()
  const forwardColorMaterials = new Set<Material>()
  const originalForwardDecalLayerMasks = new Map<Mesh, number>()
  const opaqueSceneMaterials = new Set<Material>()
  const transparentSceneMaterials = new Set<Material>()
  const lightingMaterialCache = new Map<Material, Material | null>()
  const disposableLightingMaterials = new Set<Material>()
  let forwardDecalLayerMask = findLayerMaskOutsideCamera(camera)
  let canRenderDeferred = false

  const refresh = (): void => {
    fallback.refresh()
    restoreMeshDrawables(originalForwardDecalLayerMasks)
    originalForwardDecalLayerMasks.clear()
    for (const material of disposableLightingMaterials) {
      material.dispose()
    }
    decals.length = 0
    forwardDecals.length = 0
    receivers.clear()
    writerMaterials.clear()
    lightingMaterials.clear()
    sourceMaterials.clear()
    forwardSourceMaterials.clear()
    forwardColorMaterials.clear()
    opaqueSceneMaterials.clear()
    transparentSceneMaterials.clear()
    lightingMaterialCache.clear()
    disposableLightingMaterials.clear()
    forwardDecalLayerMask = findLayerMaskOutsideCamera(camera)
    canRenderDeferred = false

    collectSceneMaterials(scene, opaqueSceneMaterials, transparentSceneMaterials)

    let requiresFullFallback = false
    root.traverse(object => {
      if (!(object instanceof Mesh)) {
        return
      }
      const decal = object as DeferredMesh
      const decalMaterials = getMaterials(decal.material)
      if (
        decal.userData.msfsBlendGBufferProjectedToReceiver !== true ||
        !decalMaterials.some(usesBlendGBufferMaterial)
      ) {
        return
      }

      const canStayInForwardScenePass =
        canKeepBlendGBufferDecalInForwardScenePass(decalMaterials)
      const rejectRelationship = (): void => {
        if (canStayInForwardScenePass) {
          if (!forwardSourceMaterials.has(decal)) {
            forwardDecals.push(decal)
            forwardSourceMaterials.set(decal, decal.material)
            for (const material of decalMaterials) {
              forwardColorMaterials.add(material)
            }
          }
        } else {
          requiresFullFallback = true
        }
      }
      const relatedReceivers = decal.userData.msfsBlendGBufferReceivers ??
        (decal.userData.msfsBlendGBufferReceiver == null
          ? []
          : [decal.userData.msfsBlendGBufferReceiver])
      const decalWriters = mapMaterials(decal.material, getMsfsGBufferWriter)
      if (!hasBlendGBufferReceiver(relatedReceivers.length) || decalWriters == null) {
        rejectRelationship()
        return
      }

      const pendingReceiverVariants: Array<{
        readonly receiver: DeferredMesh
        readonly writers: MeshMaterial
        readonly lighting: MeshMaterial
      }> = []
      for (const receiver of relatedReceivers) {
        const receiverMaterials = getMaterials(receiver.material)
        if (
          receiverMaterials.some(material =>
            material.transparent === true || usesBlendGBufferMaterial(material)
          )
        ) {
          rejectRelationship()
          return
        }
        const receiverWriters = mapMaterials(receiver.material, getMsfsGBufferWriter)
        const receiverLighting = mapMaterials(receiver.material, material => {
          if (!lightingMaterialCache.has(material)) {
            const lightingMaterial = createMsfsDeferredLightingMaterial(
              material,
              gBuffer.textures
            )
            lightingMaterialCache.set(material, lightingMaterial)
            if (lightingMaterial != null) {
              disposableLightingMaterials.add(lightingMaterial)
            }
          }
          return lightingMaterialCache.get(material) ?? null
        })
        if (receiverWriters == null || receiverLighting == null) {
          rejectRelationship()
          return
        }
        pendingReceiverVariants.push({
          receiver,
          writers: receiverWriters,
          lighting: receiverLighting,
        })
      }

      decals.push(decal)
      sourceMaterials.set(decal, decal.material)
      writerMaterials.set(decal, decalWriters)
      for (const variant of pendingReceiverVariants) {
        receivers.add(variant.receiver)
        sourceMaterials.set(variant.receiver, variant.receiver.material)
        writerMaterials.set(variant.receiver, variant.writers)
        if (!lightingMaterials.has(variant.receiver)) {
          lightingMaterials.set(variant.receiver, variant.lighting)
        }
      }
    })

    if (requiresFullFallback) {
      for (const material of disposableLightingMaterials) {
        material.dispose()
      }
      decals.length = 0
      receivers.clear()
      writerMaterials.clear()
      lightingMaterials.clear()
      sourceMaterials.clear()
      forwardDecals.length = 0
      forwardSourceMaterials.clear()
      forwardColorMaterials.clear()
      disposableLightingMaterials.clear()
      return
    }

    decals.sort((left, right) => left.renderOrder - right.renderOrder)
    forwardDecals.sort((left, right) => left.renderOrder - right.renderOrder)
    addMeshDrawablesToLayer(
      forwardDecals,
      forwardDecalLayerMask,
      originalForwardDecalLayerMasks
    )
    canRenderDeferred = decals.length > 0 && receivers.size > 0
  }

  refresh()

  return {
    get hasBlendGBufferDecals() {
      return canRenderDeferred || fallback.hasBlendGBufferDecals
    },
    refresh,
    render: () => {
      if (!canRenderDeferred) {
        fallback.render()
        return
      }

      const originalBackground = scene.background
      const originalAutoClear = renderer.autoClear
      const originalCameraLayerMask = camera.layers.mask
      const originalTarget = renderer.getRenderTarget()
      const originalClearColor = renderer.getClearColor(new Color() as never) as unknown as Color
      const originalClearAlpha = renderer.getClearAlpha()
      const originalMaterialState = new Map<MsfsMaterial, MaterialRenderState>()

      try {
        gBuffer.resize()

        renderer.setRenderTarget(originalTarget)
        renderer.autoClear = true
        camera.layers.mask = originalCameraLayerMask
        setMeshMaterials(sourceMaterials, hiddenMaterial)
        hideMaterials(transparentSceneMaterials, originalMaterialState)
        renderer.render(scene, camera)

        restoreMaterialRenderState(originalMaterialState.keys(), originalMaterialState)
        hideMaterials(opaqueSceneMaterials, originalMaterialState)
        hideMaterials(transparentSceneMaterials, originalMaterialState)
        scene.background = null
        renderer.setClearColor(0x000000, 0)
        renderer.setRenderTarget(gBuffer.renderTarget)
        renderer.autoClear = true
        setMeshMaterials(sourceMaterials, hiddenMaterial)
        setMeshMaterialsFor(receivers, writerMaterials)
        renderer.render(scene, camera)

        renderer.autoClear = false
        setMeshMaterials(sourceMaterials, hiddenMaterial)
        setMeshMaterialsFor(decals, writerMaterials)
        renderer.render(scene, camera)

        renderer.setRenderTarget(originalTarget)
        renderer.setClearColor(originalClearColor.getHex(), originalClearAlpha)
        setMeshMaterials(sourceMaterials, hiddenMaterial)
        setMeshMaterialsFor(receivers, lightingMaterials)
        renderer.render(scene, camera)

        const useForwardDepthMask = copyBlendGBufferSceneDepth(
          renderer,
          forwardColorMaterials
        )

        restoreMaterialRenderState(originalMaterialState.keys(), originalMaterialState)
        hideMaterials(opaqueSceneMaterials, originalMaterialState)
        setMeshMaterials(sourceMaterials, hiddenMaterial)
        setMeshMaterials(forwardSourceMaterials, hiddenMaterial)
        setMsfsBlendGBufferDepthMaskEnabled(false)
        renderer.render(scene, camera)

        if (forwardDecals.length > 0) {
          restoreMeshMaterials(forwardSourceMaterials)
          configureBlendGBufferMaterialsForDecalPass(
            forwardColorMaterials,
            originalMaterialState,
            useForwardDepthMask
          )
          setMsfsBlendGBufferDepthMaskEnabled(useForwardDepthMask)
          camera.layers.mask = forwardDecalLayerMask
          scene.background = null
          renderer.autoClear = false
          renderer.render(scene, camera)
        }
      } finally {
        setMsfsBlendGBufferDepthMaskEnabled(true)
        restoreMeshMaterials(forwardSourceMaterials)
        restoreMeshMaterials(sourceMaterials)
        restoreMaterialRenderState(originalMaterialState.keys(), originalMaterialState)
        renderer.setRenderTarget(originalTarget)
        renderer.setClearColor(originalClearColor.getHex(), originalClearAlpha)
        renderer.autoClear = originalAutoClear
        camera.layers.mask = originalCameraLayerMask
        scene.background = originalBackground
      }
    },
  }
}

function collectSceneMaterials(
  scene: Scene,
  opaque: Set<Material>,
  transparent: Set<Material>
): void {
  scene.traverse(object => {
    const material = (object as { readonly material?: MeshMaterial }).material
    if (material == null) {
      return
    }
    for (const item of getMaterials(material)) {
      ;(item.transparent === true ? transparent : opaque).add(item)
    }
  })
}

function mapMaterials(
  material: MeshMaterial,
  map: (material: Material) => Material | null
): MeshMaterial | null {
  if (Array.isArray(material)) {
    const mapped = material.map(map)
    return mapped.some(item => item == null) ? null : mapped as Material[]
  }
  return map(material)
}

function getMaterials(material: MeshMaterial): Material[] {
  return Array.isArray(material) ? material : [material]
}

function setMeshMaterials(
  sourceMaterials: ReadonlyMap<DeferredMesh, MeshMaterial>,
  material: Material
): void {
  for (const mesh of sourceMaterials.keys()) {
    mesh.material = Array.isArray(sourceMaterials.get(mesh))
      ? getMaterials(sourceMaterials.get(mesh) as MeshMaterial).map(() => material)
      : material
  }
}

function setMeshMaterialsFor(
  meshes: Iterable<DeferredMesh>,
  materials: ReadonlyMap<DeferredMesh, MeshMaterial>
): void {
  for (const mesh of meshes) {
    const material = materials.get(mesh)
    if (material != null) {
      mesh.material = material
    }
  }
}

function restoreMeshMaterials(
  sourceMaterials: ReadonlyMap<DeferredMesh, MeshMaterial>
): void {
  for (const [mesh, material] of sourceMaterials) {
    mesh.material = material
  }
}

function createForwardMsfsRenderPasses(
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
