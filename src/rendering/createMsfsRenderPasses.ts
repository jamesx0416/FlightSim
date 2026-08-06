import {
  Color,
  Frustum,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Camera,
  type Material,
  type Object3D,
  type Scene
} from 'three'
import type { WebGPURenderer } from 'three/webgpu'

import {
  createMsfsDeferredLightingMaterial,
  getMsfsGBufferWriter,
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

export interface MsfsRenderPasses {
  readonly hasBlendGBufferDecals: boolean
  refresh(): void
  setDeferredEnabled(enabled: boolean): void
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

export function canKeepReceiverlessBlendGBufferMaterialInBasePass(
  material: Material
): boolean {
  return usesBlendGBufferColorMaterial(material) &&
    !usesBlendGBufferDrawOrderMaterial(material as MsfsMaterial)
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
    visible: false,
  })
  const decals: DeferredMesh[] = []
  const forwardDecals: DeferredMesh[] = []
  const receivers = new Set<DeferredMesh>()
  const decalReceivers = new Map<DeferredMesh, readonly DeferredMesh[]>()
  const writerMaterials = new Map<DeferredMesh, MeshMaterial>()
  const resolveMaterials = new Map<DeferredMesh, MeshMaterial>()
  const sourceMaterials = new Map<DeferredMesh, MeshMaterial>()
  const forwardSourceMaterials = new Map<DeferredMesh, MeshMaterial>()
  const forwardColorMaterials = new Set<Material>()
  const originalForwardDecalLayerMasks = new Map<Mesh, number>()
  const opaqueSceneMaterials = new Set<Material>()
  const transparentSceneMaterials = new Set<Material>()
  const disposableLightingMaterials = new Set<Material>()
  const deferredFrustum = new Frustum()
  const deferredViewProjection = new Matrix4()
  let forwardDecalLayerMask = findLayerMaskOutsideCamera(camera)
  let sharedResolveMaterial: Material | null = null
  let canRenderDeferred = false
  let deferredEnabled = true

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
    decalReceivers.clear()
    writerMaterials.clear()
    resolveMaterials.clear()
    sourceMaterials.clear()
    forwardSourceMaterials.clear()
    forwardColorMaterials.clear()
    opaqueSceneMaterials.clear()
    transparentSceneMaterials.clear()
    disposableLightingMaterials.clear()
    sharedResolveMaterial = null
    forwardDecalLayerMask = findLayerMaskOutsideCamera(camera)
    canRenderDeferred = false

    if (!deferredEnabled) {
      return
    }

    collectSceneMaterials(scene, opaqueSceneMaterials, transparentSceneMaterials)

    let requiresFullFallback = false
    root.traverse(object => {
      if (!(object instanceof Mesh)) {
        return
      }
      const decal = object as DeferredMesh
      if (isInteriorModelObject(decal)) {
        return
      }
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
      if (sharedResolveMaterial == null) {
        const sourceMaterial = decalMaterials[0]
        const writer = getMsfsGBufferWriter(sourceMaterial) as (Material & { depthNode?: unknown }) | null
        const lighting = createMsfsDeferredLightingMaterial(sourceMaterial, gBuffer.textures)
        if (writer == null || lighting == null) {
          lighting?.dispose()
          rejectRelationship()
          return
        }
        const resolve = lighting as Material & { depthNode?: unknown }
        resolve.depthNode = writer.depthNode
        resolve.depthTest = true
        resolve.depthWrite = false
        sharedResolveMaterial = resolve
        disposableLightingMaterials.add(resolve)
      }
      const decalResolve = Array.isArray(decal.material)
        ? decal.material.map(() => sharedResolveMaterial!)
        : sharedResolveMaterial

      const pendingReceiverVariants: Array<{
        readonly receiver: DeferredMesh
        readonly writers: MeshMaterial
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
        if (receiverWriters == null) {
          rejectRelationship()
          return
        }
        pendingReceiverVariants.push({ receiver, writers: receiverWriters })
      }

      decals.push(decal)
      decalReceivers.set(decal, relatedReceivers)
      sourceMaterials.set(decal, decal.material)
      writerMaterials.set(decal, decalWriters)
      resolveMaterials.set(decal, decalResolve)
      for (const variant of pendingReceiverVariants) {
        receivers.add(variant.receiver)
        sourceMaterials.set(variant.receiver, variant.receiver.material)
        writerMaterials.set(variant.receiver, variant.writers)
      }
    })

    if (requiresFullFallback) {
      for (const material of disposableLightingMaterials) {
        material.dispose()
      }
      decals.length = 0
      receivers.clear()
      decalReceivers.clear()
      writerMaterials.clear()
      resolveMaterials.clear()
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
    setDeferredEnabled: enabled => {
      if (deferredEnabled === enabled) {
        return
      }
      deferredEnabled = enabled
      refresh()
    },
    render: () => {
      if (!deferredEnabled || !canRenderDeferred) {
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
        setMeshMaterialsFor(receivers, sourceMaterials)
        hideMaterials(transparentSceneMaterials, originalMaterialState)
        renderer.render(scene, camera)

        deferredFrustum.setFromProjectionMatrix(
          deferredViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
          camera.coordinateSystem,
          camera.reversedDepth
        )
        const active = collectVisibleDeferredRelationships(
          decals,
          decalReceivers,
          decal =>
            isDeferredMeshVisible(
              decal,
              camera,
              deferredFrustum,
              sourceMaterials.get(decal),
              originalMaterialState
            )
        )

        restoreMaterialRenderState(originalMaterialState.keys(), originalMaterialState)
        hideMaterials(opaqueSceneMaterials, originalMaterialState)
        hideMaterials(transparentSceneMaterials, originalMaterialState)
        scene.background = null
        renderer.setClearColor(0x000000, 0)
        renderer.setRenderTarget(gBuffer.renderTarget)
        renderer.autoClear = true
        setMeshMaterials(sourceMaterials, hiddenMaterial)
        setMeshMaterialsFor(active.receivers, writerMaterials)
        renderer.render(scene, camera)

        configureDeferredDecalWriterDepthTest(active.decals, writerMaterials)
        renderer.autoClear = false
        setMeshMaterials(sourceMaterials, hiddenMaterial)
        setMeshMaterialsFor(active.decals, writerMaterials)
        renderer.render(scene, camera)

        renderer.setRenderTarget(originalTarget)
        renderer.setClearColor(originalClearColor.getHex(), originalClearAlpha)
        setMeshMaterials(sourceMaterials, hiddenMaterial)
        setMeshMaterialsFor(active.decals, resolveMaterials)
        renderer.render(scene, camera)

        restoreMaterialRenderState(originalMaterialState.keys(), originalMaterialState)
        hideMaterials(opaqueSceneMaterials, originalMaterialState)
        setMeshMaterials(sourceMaterials, hiddenMaterial)
        setMeshMaterials(forwardSourceMaterials, hiddenMaterial)
        renderer.render(scene, camera)

        if (forwardDecals.length > 0) {
          restoreMeshMaterials(forwardSourceMaterials)
          configureBlendGBufferMaterialsForDecalPass(
            forwardColorMaterials,
            originalMaterialState
          )
          camera.layers.mask = forwardDecalLayerMask
          scene.background = null
          renderer.autoClear = false
          renderer.render(scene, camera)
        }
      } finally {
        configureDeferredDecalWriterDepthTest(decals, writerMaterials)
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

export function collectVisibleDeferredRelationships<T>(
  decals: readonly T[],
  receiversByDecal: ReadonlyMap<T, readonly T[]>,
  isVisible: (decal: T) => boolean
): { readonly decals: T[]; readonly receivers: Set<T> } {
  const visibleDecals: T[] = []
  const visibleReceivers = new Set<T>()
  for (const decal of decals) {
    if (!isVisible(decal)) continue
    visibleDecals.push(decal)
    for (const receiver of receiversByDecal.get(decal) ?? []) {
      visibleReceivers.add(receiver)
    }
  }
  return { decals: visibleDecals, receivers: visibleReceivers }
}

function isDeferredMeshVisible(
  mesh: DeferredMesh,
  camera: Camera,
  frustum: Frustum,
  sourceMaterial: MeshMaterial | undefined,
  originalMaterialState: ReadonlyMap<MsfsMaterial, MaterialRenderState>
): boolean {
  for (let current: Object3D | null = mesh; current != null; current = current.parent) {
    if (!current.visible) return false
  }
  if (!mesh.layers.test(camera.layers)) return false
  if (
    sourceMaterial != null &&
    !getMaterials(sourceMaterial).some(material =>
      originalMaterialState.get(material as MsfsMaterial)?.visible ?? material.visible
    )
  ) {
    return false
  }
  return mesh.frustumCulled === false || frustum.intersectsObject(mesh)
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

function isInteriorModelObject(object: Object3D): boolean {
  for (let current: Object3D | null = object; current != null; current = current.parent) {
    if (current.userData.msfsModelKind === 'interior') {
      return true
    }
  }
  return false
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

function configureDeferredDecalWriterDepthTest(
  decals: Iterable<DeferredMesh>,
  materials: ReadonlyMap<DeferredMesh, MeshMaterial>
): void {
  for (const decal of decals) {
    const material = materials.get(decal)
    if (material == null) {
      continue
    }
    for (const writer of getMaterials(material)) {
      writer.depthTest = true
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
          blendMesh.userData?.msfsBlendGBufferProjectedToReceiver === true
        let hasForwardColor = false
        for (const material of materials) {
          if (usesBlendGBufferMaterial(material as MsfsMaterial)) {
            const isColorBlendMaterial = usesBlendGBufferColorMaterial(material as MsfsMaterial)
            if (isProjectedDecal && isColorBlendMaterial) {
              hiddenBlendMaterials.add(material)
              colorBlendMaterials.add(material)
              hasForwardColor = true
            } else if (!canKeepReceiverlessBlendGBufferMaterialInBasePass(material)) {
              hiddenBlendMaterials.add(material)
              componentOnlyBlendMaterials.add(material)
            }
          } else {
            nonBlendMaterialsOnBlendMeshes.add(material)
          }
        }
        if (hasForwardColor) {
          decalBlendMeshes.push(blendMesh)
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
    setDeferredEnabled: () => {},
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
        hideMaterials(hiddenBlendMaterials, originalMaterialState)
        renderer.render(scene, camera)

        restoreMaterialRenderState(colorBlendMaterials, originalMaterialState)
        hideMaterials(componentOnlyBlendMaterials, originalMaterialState)
        hideMaterials(nonBlendMaterialsOnBlendMeshes, originalMaterialState)
        configureBlendGBufferMaterialsForDecalPass(
          colorBlendMaterials,
          originalMaterialState
        )
        camera.layers.mask = decalLayerMask
        scene.background = null
        renderer.autoClear = false
        renderer.render(scene, camera)
      } finally {
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

export function configureBlendGBufferMaterialsForDecalPass(
  materials: Iterable<Material>,
  originalMaterialState: Map<MsfsMaterial, MaterialRenderState>
): void {
  for (const material of materials) {
    const msfsMaterial = material as MsfsMaterial
    preserveMaterialRenderState(msfsMaterial, originalMaterialState)
    msfsMaterial.visible = originalMaterialState.get(msfsMaterial)?.visible ?? msfsMaterial.visible
    msfsMaterial.depthTest = true
    msfsMaterial.depthWrite = false
    msfsMaterial.polygonOffset = originalMaterialState.get(msfsMaterial)?.polygonOffset ?? msfsMaterial.polygonOffset ?? false
  }
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
