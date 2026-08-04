import {
  BufferAttribute,
  BufferGeometry,
  DepthTexture,
  InterleavedBufferAttribute,
  LinearSRGBColorSpace,
  Material,
  Matrix3,
  Mesh,
  NoBlending,
  NoColorSpace,
  NormalBlending,
  Object3D,
  RGFormat,
  RED_GREEN_RGTC2_Format,
  RGB_S3TC_DXT1_Format,
  RGBA_S3TC_DXT1_Format,
  SIGNED_RED_GREEN_RGTC2_Format,
  TangentSpaceNormalMap,
  Texture,
  Vector3
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  Fn,
  TBNViewMatrix,
  cameraFar,
  cameraNear,
  float,
  linearDepth,
  materialAO,
  materialEmissive,
  materialMetalness,
  materialReference,
  materialRoughness,
  mix,
  mrt,
  normalView,
  positionView,
  screenUV,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexColor,
  viewZToOrthographicDepth,
  viewZToPerspectiveDepth,
} from 'three/tsl'
import { MeshBasicNodeMaterial, type NodeMaterial } from 'three/webgpu'
import type { NodeMaterialFactory } from '../../rendering/createAppRenderer'
import type { AircraftGBufferTextures } from '../../rendering/createAircraftGBuffer'

type MsfsMaterial = Material & {
  map?: Texture & {
    format?: number
    needsUpdate?: boolean
  } | null
  alphaMap?: Texture | null
  metalness?: number
  normalMap?: Texture & {
    format?: number
    needsUpdate?: boolean
  } | null
  emissiveMap?: Texture | null
  normalMapType?: number
  normalScale?: {
    x: number
    y: number
    set(x: number, y: number): void
  } | null
  opacity?: number
  roughness?: number
  aoMapIntensity?: number
  emissiveIntensity?: number
  transparent?: boolean
  vertexColors?: boolean
  alphaTest?: number
  depthWrite?: boolean
  polygonOffset?: boolean
  polygonOffsetFactor?: number
  polygonOffsetUnits?: number
  premultipliedAlpha?: boolean
  side?: number
  forceSinglePass?: boolean
  onBeforeCompile?: (shader: Shader) => void
  customProgramCacheKey?: () => string
  needsUpdate?: boolean
  userData?: {
    readonly gltfExtensions?: Record<string, unknown>
    msfsMaterialCode?: string
    msfsBaseOpacity?: number
    msfsBlendGBufferDepthMask?: boolean
    msfsBlendGBufferForwardColor?: boolean
    msfsBlendGBufferProjectedToReceiver?: boolean
    msfsGBufferWriter?: Material
  }
}

type Shader = {
  vertexShader: string
  fragmentShader: string
  uniforms: Record<string, { value: unknown }>
}

type GltfTextureRef = {
  readonly index: number
}

type MsfsMaterialExtensions = {
  readonly ASOBO_material_blend_gbuffer?: {
    readonly baseColorBlendFactor?: number
    readonly metallicBlendFactor?: number
    readonly metallnesBlendFactor?: number
    readonly roughnessBlendFactor?: number
    readonly normalBlendFactor?: number
    readonly emissiveBlendFactor?: number
    readonly occlusionBlendFactor?: number
  }
  readonly ASOBO_material_detail_map?: {
    readonly UVScale?: number
    readonly UVOffset?: readonly [number, number]
    readonly blendThreshold?: number
    readonly detailColorTexture?: GltfTextureRef
    readonly detailNormalTexture?: GltfTextureRef & {
      readonly scale?: number
    }
    readonly detailMetalRoughAOTexture?: GltfTextureRef
    readonly blendMaskTexture?: GltfTextureRef
  }
  readonly ASOBO_material_draw_order?: {
    readonly drawOrderOffset?: number
  }
  readonly ASOBO_material_invisible?: Record<string, never>
  readonly ASOBO_material_shadow_options?: {
    readonly noCastShadow?: boolean
  }
}

type GltfAssociation = {
  readonly materials?: number
  readonly meshes?: number
  readonly primitives?: number
}

type GltfMaterialDef = {
  readonly extensions?: MsfsMaterialExtensions
  readonly extras?: {
    readonly ASOBO_material_code?: string
  }
}

type GltfMeshDef = {
  readonly primitives?: readonly unknown[]
}

type GltfParserLike = {
  readonly associations: Map<object, GltfAssociation>
  readonly json: {
    readonly materials?: readonly GltfMaterialDef[]
    readonly meshes?: readonly GltfMeshDef[]
  }
  getDependency(type: 'texture', index: number): Promise<Texture>
}

const MSFS_DETAIL_TEXTURE_LOAD_TIMEOUT_MS = 5000

type MsfsDetailMapExtension = NonNullable<MsfsMaterialExtensions['ASOBO_material_detail_map']>

type LoadedMsfsDetailTextures = {
  readonly detailColorTexture: Texture | null
  readonly detailNormalTexture: Texture | null
  readonly detailMetalRoughAOTexture: Texture | null
  readonly blendMaskTexture: Texture | null
}

type MsfsMaterialNormalizationOptions = {
  readonly createNodeMaterial?: NodeMaterialFactory | null
}

type MsfsBlendGBufferExtension = NonNullable<MsfsMaterialExtensions['ASOBO_material_blend_gbuffer']>

type MeshWithGeometry = Mesh & {
  geometry: BufferGeometry
  material: Material | Material[]
}

type GltfPrimitiveMesh = {
  readonly mesh: MeshWithGeometry
  readonly primitiveIndex: number
  readonly material: MsfsMaterial
}

type DecalProjectionTriangle = {
  readonly a: Vector3
  readonly b: Vector3
  readonly c: Vector3
  readonly orientationNormal: Vector3
  readonly normalA: Vector3 | null
  readonly normalB: Vector3 | null
  readonly normalC: Vector3 | null
  readonly tangentA: readonly [number, number, number, number] | null
  readonly tangentB: readonly [number, number, number, number] | null
  readonly tangentC: readonly [number, number, number, number] | null
  readonly skinA: readonly SkinInfluence[]
  readonly skinB: readonly SkinInfluence[]
  readonly skinC: readonly SkinInfluence[]
}

type DecalProjectionTriangleItem = {
  readonly triangle: DecalProjectionTriangle
  readonly min: Vector3
  readonly max: Vector3
  readonly center: Vector3
}

type DecalProjectionSpatialIndex = {
  readonly min: Vector3
  readonly max: Vector3
  readonly items?: readonly DecalProjectionTriangleItem[]
  readonly left?: DecalProjectionSpatialIndex
  readonly right?: DecalProjectionSpatialIndex
}

type ClosestPointResult = {
  readonly point: Vector3
  readonly barycentric: readonly [number, number, number]
}

type SkinInfluence = {
  readonly joint: number
  readonly weight: number
}

type GeometryAttribute = BufferAttribute | InterleavedBufferAttribute
type ProjectionPoint2 = readonly [number, number]
type ProjectionBarycentric = readonly [number, number, number]

type ConformedDecalVertex = {
  readonly receiverPoint: Vector3
  readonly receiverTriangle: DecalProjectionTriangle
  readonly receiverBarycentric: ProjectionBarycentric
  readonly sourceBarycentric: ProjectionBarycentric
  readonly sourceIndices: readonly [number, number, number]
}

export type MsfsBlendFactors = {
  readonly baseColor: number
  readonly metallic: number
  readonly roughness: number
  readonly normal: number
  readonly emissive: number
  readonly occlusion: number
}

type MsfsNodeMaterial = MsfsMaterial & NodeMaterial & {
  colorNode?: any
  opacityNode?: any
  emissiveNode?: any
  roughnessNode?: any
  metalnessNode?: any
  aoNode?: any
  normalNode?: any
  fragmentNode?: any
  mrtNode?: any
}

type MsfsProjectedDecalMesh = MeshWithGeometry & {
  userData: MeshWithGeometry['userData'] & {
    msfsBlendGBufferProjectedToReceiver?: boolean
    msfsBlendGBufferReceiver?: MeshWithGeometry
    msfsBlendGBufferReceivers?: readonly MeshWithGeometry[]
  }
}

const MSFS_BLEND_GBUFFER_RENDER_ORDER_BASE = 10
const MSFS_BLEND_GBUFFER_POLYGON_OFFSET_BASE = -1
const MSFS_MATERIAL_DRAW_ORDER_MIN = -999
const msfsBlendGBufferDepthMaskEnabled = uniform(1)

const RESOLVED_COLOR_FRAGMENT_CHUNK = `#if defined( USE_COLOR_ALPHA )

\tdiffuseColor *= vColor;

#elif defined( USE_COLOR )

\tdiffuseColor.rgb *= vColor;

#endif`

const RESOLVED_ROUGHNESSMAP_FRAGMENT_CHUNK = `float roughnessFactor = roughness;

#ifdef USE_ROUGHNESSMAP

\tvec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );

\t// reads channel G, compatible with a combined OcclusionRoughnessMetallic (RGB) texture
\troughnessFactor *= texelRoughness.g;

#endif`

const RESOLVED_METALNESSMAP_FRAGMENT_CHUNK = `float metalnessFactor = metalness;

#ifdef USE_METALNESSMAP

\tvec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );

\t// reads channel B, compatible with a combined OcclusionRoughnessMetallic (RGB) texture
\tmetalnessFactor *= texelMetalness.b;

#endif`

const RESOLVED_AOMAP_FRAGMENT_CHUNK = `#ifdef USE_AOMAP

\t// reads channel R, compatible with a combined OcclusionRoughnessMetallic (RGB) texture
\tfloat ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;

\treflectedLight.indirectDiffuse *= ambientOcclusion;

\t#if defined( USE_CLEARCOAT ) 
\t\tclearcoatSpecularIndirect *= ambientOcclusion;
\t#endif

\t#if defined( USE_SHEEN ) 
\t\tsheenSpecularIndirect *= ambientOcclusion;
\t#endif

\t#if defined( USE_ENVMAP ) && defined( STANDARD )

\t\tfloat dotNV = saturate( dot( geometryNormal, geometryViewDir ) );

\t\treflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );

\t#endif

#endif`

const msfsBlendGBufferDepthTexture = new DepthTexture(1, 1)

export function getMsfsBlendGBufferDepthTexture(): DepthTexture {
  return msfsBlendGBufferDepthTexture
}

export function setMsfsBlendGBufferDepthMaskEnabled(enabled: boolean): void {
  msfsBlendGBufferDepthMaskEnabled.value = enabled ? 1 : 0
}

export async function normalizeMsfsMaterials(
  gltf: GLTF,
  options: MsfsMaterialNormalizationOptions = {}
): Promise<void> {
  const root = gltf.scene
  const parser = (gltf as unknown as { parser?: GltfParserLike }).parser
  const materials = new Set<MsfsMaterial>()
  const materialReplacements = new Map<MsfsMaterial, MsfsMaterial>()
  const textureCache = new Map<number, Promise<Texture>>()
  const decalRenderOrderStride = getMsfsDecalRenderOrderStride(parser)

  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const meshMaterials = Array.isArray(object.material)
      ? object.material
      : [object.material]

    for (const material of meshMaterials) {
      if (material != null) {
        materials.add(material as MsfsMaterial)
      }
    }

    if (meshMaterials.some(material => usesInvisibleMaterial(material))) {
      object.visible = false
      return
    }

    if (
      meshMaterials.some(material => usesMsfsNoCastShadow(material))
    ) {
      object.castShadow = false
    }

    const hasBlendGBufferMaterial =
      meshMaterials.some(material => usesBlendGBufferMaterial(material))
    if (hasBlendGBufferMaterial) {
      const association = parser?.associations.get(object)
      const renderOrder = getMsfsDecalRenderOrder(
        Math.max(...meshMaterials.map(material => getMsfsDrawOrderOffset(material))),
        association?.primitives ?? 0,
        decalRenderOrderStride
      )
      object.renderOrder = renderOrder
      object.userData.msfsDecalRenderOrder = renderOrder
    } else {
      const drawOrderOffset = Math.max(
        0,
        ...meshMaterials.map(material => getMsfsDrawOrderOffset(material))
      )
      if (drawOrderOffset > 0) {
        object.renderOrder = Math.max(
          object.renderOrder,
          MSFS_BLEND_GBUFFER_RENDER_ORDER_BASE + drawOrderOffset
        )
      }
    }
  })

  projectBlendGBufferDecals(root, parser)
  const gBufferMaterials = collectProjectedBlendGBufferMaterials(root)

  await Promise.all(
    [...materials].map(async material => {
      const normalizedMaterial = await normalizeMsfsMaterial(
        material,
        parser,
        textureCache,
        parser?.associations.get(material)?.materials,
        options,
        gBufferMaterials.has(material)
      )
      materialReplacements.set(material, normalizedMaterial)
    })
  )

  if (materialReplacements.size > 0) {
    root.traverse(object => {
      if (!(object instanceof Mesh)) {
        return
      }

      if (Array.isArray(object.material)) {
        object.material = object.material.map(material =>
          material == null
            ? material
            : materialReplacements.get(material as MsfsMaterial) ?? material
        )
        return
      }

      if (object.material != null) {
        object.material =
          materialReplacements.get(object.material as MsfsMaterial) ?? object.material
      }
    })
  }
}

// MSFS geometry decals are authored as separate primitives that resolve onto
// covered surfaces in the decal/G-buffer pass. In this forward renderer, same
// glTF-mesh decal primitives need their bind-pose geometry and skin weights
// projected onto sibling base primitives so they do not render as detached
// physical surfaces.
function projectBlendGBufferDecals(
  root: Object3D,
  parser: GltfParserLike | undefined
): void {
  root.updateWorldMatrix(true, true)
  const projectedMeshes = projectSameMeshBlendGBufferDecals(root, parser)
  projectSameParentBlendGBufferDecals(root, projectedMeshes)
}

function projectSameMeshBlendGBufferDecals(
  root: Object3D,
  parser: GltfParserLike | undefined
): Set<MeshWithGeometry> {
  const projectedMeshes = new Set<MeshWithGeometry>()

  if (parser == null) {
    return projectedMeshes
  }

  const primitivesByParent = new Map<Object3D, Map<number, GltfPrimitiveMesh[]>>()

  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const association = parser.associations.get(object)
    if (association?.meshes == null || association.primitives == null) {
      return
    }

    const material = getSingleMeshMaterial(object.material)
    if (material == null) {
      return
    }

    const parent = object.parent ?? root
    const primitivesByMesh = primitivesByParent.get(parent) ?? new Map<number, GltfPrimitiveMesh[]>()
    const primitives = primitivesByMesh.get(association.meshes) ?? []
    primitives.push({
      mesh: object as MeshWithGeometry,
      primitiveIndex: association.primitives,
      material: material as MsfsMaterial,
    })
    primitivesByMesh.set(association.meshes, primitives)
    primitivesByParent.set(parent, primitivesByMesh)
  })

  for (const primitivesByMesh of primitivesByParent.values()) {
    for (const primitives of primitivesByMesh.values()) {
      const basePrimitives = primitives
        .filter(primitive => !usesBlendGBufferMaterial(primitive.material))
        .sort((left, right) => left.primitiveIndex - right.primitiveIndex)
      const decalPrimitives = primitives
        .filter(primitive =>
          shouldProjectBlendGBufferPrimitive(primitive.material) &&
          isSkinnedMeshWithBones(primitive.mesh)
        )
        .sort((left, right) => left.primitiveIndex - right.primitiveIndex)

      if (basePrimitives.length === 0 || decalPrimitives.length === 0) {
        continue
      }

      const triangles = buildDecalProjectionTriangles(basePrimitives)
      const triangleIndex = buildDecalProjectionSpatialIndex(triangles)
      if (triangleIndex == null) {
        continue
      }

      const receivers = basePrimitives.map(primitive => primitive.mesh)
      for (const decalPrimitive of decalPrimitives) {
        conformProjectedDecalToBase(
          decalPrimitive.mesh,
          triangles,
          triangleIndex
        )
        const decalMesh = decalPrimitive.mesh as MsfsProjectedDecalMesh
        decalMesh.userData.msfsBlendGBufferProjectedToReceiver = true
        decalMesh.userData.msfsBlendGBufferReceivers = receivers
        if (receivers.length === 1) {
          decalMesh.userData.msfsBlendGBufferReceiver = receivers[0]
        }
        projectedMeshes.add(decalPrimitive.mesh)
      }
    }
  }

  return projectedMeshes
}

function projectSameParentBlendGBufferDecals(
  root: Object3D,
  projectedMeshes: Set<MeshWithGeometry>
): void {
  const primitivesByParent = new Map<
    Object3D,
    {
      readonly basePrimitives: GltfPrimitiveMesh[]
      readonly decalPrimitives: GltfPrimitiveMesh[]
    }
  >()

  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const mesh = object as MeshWithGeometry
    const material = getSingleMeshMaterial(mesh.material)
    if (material == null) {
      return
    }

    const parent = mesh.parent
    if (parent == null || parent === root) {
      return
    }

    const group =
      primitivesByParent.get(parent) ??
      ({
        basePrimitives: [],
        decalPrimitives: []
      } as {
        readonly basePrimitives: GltfPrimitiveMesh[]
        readonly decalPrimitives: GltfPrimitiveMesh[]
      })
    const primitive = {
      mesh,
      primitiveIndex: parent.children.indexOf(mesh),
      material: material as MsfsMaterial
    }

    if (usesBlendGBufferMaterial(material)) {
      if (
        shouldProjectBlendGBufferPrimitive(material) &&
        !projectedMeshes.has(mesh)
      ) {
        group.decalPrimitives.push(primitive)
      }
    } else if (
      mesh.visible !== false &&
      material.visible !== false &&
      !usesInvisibleMaterial(material)
    ) {
      group.basePrimitives.push(primitive)
    }

    primitivesByParent.set(parent, group)
  })

  for (const { basePrimitives, decalPrimitives } of primitivesByParent.values()) {
    if (basePrimitives.length === 0 || decalPrimitives.length === 0) {
      continue
    }

    const triangles = buildDecalProjectionTriangles(basePrimitives)
    const triangleIndex = buildDecalProjectionSpatialIndex(triangles)
    if (triangleIndex == null) {
      continue
    }

    const descendantTriangles = buildDescendantDecalProjectionTriangles(basePrimitives)
    const descendantTriangleIndex = buildDecalProjectionSpatialIndex(descendantTriangles)
    const receivers = basePrimitives.map(primitive => primitive.mesh)
    for (const decalPrimitive of decalPrimitives) {
      if (!hasUnambiguousSameParentReceiver(
        decalPrimitive.mesh,
        triangleIndex,
        descendantTriangleIndex
      )) {
        continue
      }
      conformProjectedDecalToBase(
        decalPrimitive.mesh,
        triangles,
        triangleIndex
      )
      const decalMesh = decalPrimitive.mesh as MsfsProjectedDecalMesh
      decalMesh.userData.msfsBlendGBufferProjectedToReceiver = true
      decalMesh.userData.msfsBlendGBufferReceivers = receivers
      if (receivers.length === 1) {
        decalMesh.userData.msfsBlendGBufferReceiver = receivers[0]
      }
      projectedMeshes.add(decalPrimitive.mesh)
    }
  }
}

function collectProjectedBlendGBufferMaterials(root: Object3D): Set<MsfsMaterial> {
  const materials = new Set<MsfsMaterial>()
  root.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }
    const decal = object as MsfsProjectedDecalMesh
    if (decal.userData.msfsBlendGBufferProjectedToReceiver !== true) {
      return
    }
    for (const material of Array.isArray(decal.material) ? decal.material : [decal.material]) {
      if (usesBlendGBufferMaterial(material)) {
        materials.add(material as MsfsMaterial)
      }
    }
    const receivers = decal.userData.msfsBlendGBufferReceivers ??
      (decal.userData.msfsBlendGBufferReceiver == null
        ? []
        : [decal.userData.msfsBlendGBufferReceiver])
    for (const receiver of receivers) {
      for (const material of Array.isArray(receiver.material)
        ? receiver.material
        : [receiver.material]) {
        materials.add(material as MsfsMaterial)
      }
    }
  })
  return materials
}

function getSingleMeshMaterial(material: Material | Material[]): Material | null {
  return Array.isArray(material)
    ? material.length === 1
      ? material[0]
      : null
    : material
}

function shouldProjectBlendGBufferPrimitive(material: Material | MsfsMaterial): boolean {
  return usesBlendGBufferMaterial(material)
}

function isSkinnedMeshWithBones(mesh: MeshWithGeometry): boolean {
  const skeleton = (mesh as MeshWithGeometry & {
    readonly isSkinnedMesh?: boolean
    readonly skeleton?: {
      readonly bones?: readonly Object3D[]
    }
  }).skeleton
  const bones = skeleton?.bones
  return (mesh as { readonly isSkinnedMesh?: boolean }).isSkinnedMesh === true &&
    bones != null &&
    bones.length > 0
}

function buildDecalProjectionTriangles(
  basePrimitives: readonly GltfPrimitiveMesh[]
): DecalProjectionTriangle[] {
  const triangles: DecalProjectionTriangle[] = []

  for (const primitive of basePrimitives) {
    const { mesh } = primitive
    mesh.updateWorldMatrix(true, false)
    const geometry = mesh.geometry
    const positionAttribute = geometry.getAttribute('position')
    if (positionAttribute == null || positionAttribute.itemSize < 3) {
      continue
    }

    const normalAttribute = geometry.getAttribute('normal') ?? null
    const tangentAttribute = geometry.getAttribute('tangent') ?? null
    const normalMatrix = new Matrix3().getNormalMatrix(mesh.matrixWorld)
    const indexAttribute = geometry.index
    const indexCount = indexAttribute?.count ?? positionAttribute.count

    for (let index = 0; index + 2 < indexCount; index += 3) {
      const aIndex = indexAttribute?.getX(index) ?? index
      const bIndex = indexAttribute?.getX(index + 1) ?? index + 1
      const cIndex = indexAttribute?.getX(index + 2) ?? index + 2
      const a = getPositionAttributeVector(positionAttribute, aIndex)
        .applyMatrix4(mesh.matrixWorld)
      const b = getPositionAttributeVector(positionAttribute, bIndex)
        .applyMatrix4(mesh.matrixWorld)
      const c = getPositionAttributeVector(positionAttribute, cIndex)
        .applyMatrix4(mesh.matrixWorld)

      const geometricNormal = new Vector3()
        .subVectors(b, a)
        .cross(new Vector3().subVectors(c, a))
      if (geometricNormal.lengthSq() < 1e-18) {
        continue
      }

      const normalA = getNormalAttributeVector(normalAttribute, aIndex, normalMatrix)
      const normalB = getNormalAttributeVector(normalAttribute, bIndex, normalMatrix)
      const normalC = getNormalAttributeVector(normalAttribute, cIndex, normalMatrix)
      const authoredNormal = new Vector3()
      for (const normal of [normalA, normalB, normalC]) {
        if (normal != null) {
          authoredNormal.add(normal)
        }
      }
      const orientationNormal = geometricNormal.normalize()
      if (
        authoredNormal.lengthSq() > 0 &&
        orientationNormal.dot(authoredNormal) < 0
      ) {
        orientationNormal.negate()
      }

      triangles.push({
        a,
        b,
        c,
        orientationNormal,
        normalA,
        normalB,
        normalC,
        tangentA: getTangentAttributeVector(tangentAttribute, aIndex, normalMatrix),
        tangentB: getTangentAttributeVector(tangentAttribute, bIndex, normalMatrix),
        tangentC: getTangentAttributeVector(tangentAttribute, cIndex, normalMatrix),
        skinA: getSkinInfluences(geometry, aIndex),
        skinB: getSkinInfluences(geometry, bIndex),
        skinC: getSkinInfluences(geometry, cIndex),
      })
    }
  }

  return triangles
}

function buildDescendantDecalProjectionTriangles(
  basePrimitives: readonly GltfPrimitiveMesh[]
): DecalProjectionTriangle[] {
  const descendants: GltfPrimitiveMesh[] = []
  const seen = new Set<MeshWithGeometry>()

  for (const basePrimitive of basePrimitives) {
    basePrimitive.mesh.traverse(object => {
      if (object === basePrimitive.mesh || !(object instanceof Mesh)) {
        return
      }
      const mesh = object as MeshWithGeometry
      if (seen.has(mesh)) {
        return
      }
      const material = getSingleMeshMaterial(mesh.material)
      if (
        material == null ||
        mesh.visible === false ||
        material.visible === false ||
        usesBlendGBufferMaterial(material) ||
        usesInvisibleMaterial(material)
      ) {
        return
      }
      seen.add(mesh)
      descendants.push({
        mesh,
        primitiveIndex: mesh.parent?.children.indexOf(mesh) ?? -1,
        material: material as MsfsMaterial,
      })
    })
  }

  return buildDecalProjectionTriangles(descendants)
}

function hasUnambiguousSameParentReceiver(
  decal: MeshWithGeometry,
  receiverIndex: DecalProjectionSpatialIndex,
  descendantIndex: DecalProjectionSpatialIndex | null
): boolean {
  if (descendantIndex == null) {
    return true
  }

  const position = decal.geometry.getAttribute('position')
  if (position == null || position.itemSize < 3) {
    return false
  }
  decal.updateWorldMatrix(true, false)

  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const point = getPositionAttributeVector(position, vertex).applyMatrix4(decal.matrixWorld)
    const receiver = findClosestProjectionTriangle(point, receiverIndex)
    if (receiver == null) {
      return false
    }
    const descendant = findClosestProjectionTriangle(point, descendantIndex)
    if (
      descendant != null &&
      descendant.point.distanceToSquared(point) < receiver.point.distanceToSquared(point)
    ) {
      return false
    }
  }

  return true
}

function buildDecalProjectionSpatialIndex(
  triangles: readonly DecalProjectionTriangle[]
): DecalProjectionSpatialIndex | null {
  if (triangles.length === 0) {
    return null
  }

  return buildDecalProjectionSpatialIndexNode(
    triangles.map(triangle => {
      const min = new Vector3(
        Math.min(triangle.a.x, triangle.b.x, triangle.c.x),
        Math.min(triangle.a.y, triangle.b.y, triangle.c.y),
        Math.min(triangle.a.z, triangle.b.z, triangle.c.z)
      )
      const max = new Vector3(
        Math.max(triangle.a.x, triangle.b.x, triangle.c.x),
        Math.max(triangle.a.y, triangle.b.y, triangle.c.y),
        Math.max(triangle.a.z, triangle.b.z, triangle.c.z)
      )

      return {
        triangle,
        min,
        max,
        center: min.clone().add(max).multiplyScalar(0.5),
      }
    })
  )
}

function buildDecalProjectionSpatialIndexNode(
  items: DecalProjectionTriangleItem[]
): DecalProjectionSpatialIndex {
  const bounds = getProjectionItemBounds(items)
  if (items.length <= 16) {
    return { ...bounds, items }
  }

  const centerBounds = getProjectionItemCenterBounds(items)
  const axis = getLongestBoundsAxis(centerBounds.min, centerBounds.max)
  const sortedItems = [...items].sort((left, right) =>
    getVectorAxis(left.center, axis) - getVectorAxis(right.center, axis)
  )
  const splitIndex = Math.floor(sortedItems.length / 2)
  const leftItems = sortedItems.slice(0, splitIndex)
  const rightItems = sortedItems.slice(splitIndex)

  if (leftItems.length === 0 || rightItems.length === 0) {
    return { ...bounds, items }
  }

  return {
    ...bounds,
    left: buildDecalProjectionSpatialIndexNode(leftItems),
    right: buildDecalProjectionSpatialIndexNode(rightItems),
  }
}

function getProjectionItemBounds(
  items: readonly DecalProjectionTriangleItem[]
): { readonly min: Vector3; readonly max: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)

  for (const item of items) {
    min.min(item.min)
    max.max(item.max)
  }

  return { min, max }
}

function getProjectionItemCenterBounds(
  items: readonly DecalProjectionTriangleItem[]
): { readonly min: Vector3; readonly max: Vector3 } {
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)

  for (const item of items) {
    min.min(item.center)
    max.max(item.center)
  }

  return { min, max }
}

function getLongestBoundsAxis(min: Vector3, max: Vector3): 'x' | 'y' | 'z' {
  const x = max.x - min.x
  const y = max.y - min.y
  const z = max.z - min.z
  return x >= y && x >= z ? 'x' : y >= z ? 'y' : 'z'
}

function getVectorAxis(vector: Vector3, axis: 'x' | 'y' | 'z'): number {
  return axis === 'x' ? vector.x : axis === 'y' ? vector.y : vector.z
}

function conformProjectedDecalToBase(
  mesh: MeshWithGeometry,
  triangles: readonly DecalProjectionTriangle[],
  triangleIndex: DecalProjectionSpatialIndex
): void {
  if (!clipBlendGBufferPrimitiveToBase(mesh, triangles, triangleIndex)) {
    projectBlendGBufferPrimitiveToBase(mesh, triangleIndex)
  }
}

function clipBlendGBufferPrimitiveToBase(
  mesh: MeshWithGeometry,
  receiverTriangles: readonly DecalProjectionTriangle[],
  triangleIndex: DecalProjectionSpatialIndex
): boolean {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  if (
    position == null ||
    position.itemSize < 3 ||
    Object.keys(geometry.morphAttributes).length > 0
  ) {
    return false
  }

  mesh.updateWorldMatrix(true, false)
  const normalAttribute = geometry.getAttribute('normal') ?? null
  const worldNormalMatrix = new Matrix3().getNormalMatrix(mesh.matrixWorld)
  const index = geometry.index
  const count = index?.count ?? position.count
  const vertices: ConformedDecalVertex[] = []

  for (let triangleOffset = 0; triangleOffset + 2 < count; triangleOffset += 3) {
    const sourceIndices = [
      index?.getX(triangleOffset) ?? triangleOffset,
      index?.getX(triangleOffset + 1) ?? triangleOffset + 1,
      index?.getX(triangleOffset + 2) ?? triangleOffset + 2,
    ] as const
    const sourceWorld = sourceIndices.map(vertexIndex =>
      getPositionAttributeVector(position, vertexIndex).applyMatrix4(mesh.matrixWorld)
    ) as [Vector3, Vector3, Vector3]
    const xAxis = new Vector3().subVectors(sourceWorld[1], sourceWorld[0])
    const sourceNormal = xAxis.clone().cross(
      new Vector3().subVectors(sourceWorld[2], sourceWorld[0])
    )
    if (xAxis.lengthSq() === 0 || sourceNormal.lengthSq() === 0) {
      continue
    }
    xAxis.normalize()
    sourceNormal.normalize()
    const sourceOrientationNormal = sourceNormal.clone()
    if (normalAttribute != null && normalAttribute.itemSize >= 3) {
      const authoredNormal = sourceIndices.reduce((sum, vertexIndex) => {
        const normal = getNormalAttributeVector(
          normalAttribute,
          vertexIndex,
          worldNormalMatrix
        )
        return normal == null ? sum : sum.add(normal)
      }, new Vector3())
      if (
        authoredNormal.lengthSq() > 0 &&
        sourceOrientationNormal.dot(authoredNormal) < 0
      ) {
        sourceOrientationNormal.negate()
      }
    }
    const yAxis = sourceNormal.clone().cross(xAxis).normalize()
    const toPlane = (point: Vector3): ProjectionPoint2 => {
      const relative = point.clone().sub(sourceWorld[0])
      return [relative.dot(xAxis), relative.dot(yAxis)]
    }
    const sourceTriangle2 = sourceWorld.map(toPlane) as [
      ProjectionPoint2,
      ProjectionPoint2,
      ProjectionPoint2,
    ]
    let emittedTriangle = false

    for (const receiverTriangle of receiverTriangles) {
      if (receiverTriangle.orientationNormal.dot(sourceOrientationNormal) <= 0) {
        continue
      }
      const receiverTriangle2 = [
        toPlane(receiverTriangle.a),
        toPlane(receiverTriangle.b),
        toPlane(receiverTriangle.c),
      ] as [ProjectionPoint2, ProjectionPoint2, ProjectionPoint2]
      const receiverArea = getProjectionSignedArea(receiverTriangle2)
      if (receiverArea === 0) {
        continue
      }

      let overlap = clipProjectionPolygon(sourceTriangle2, receiverTriangle2)
      if (overlap.length < 3) {
        continue
      }

      if (receiverArea < 0) {
        overlap = [...overlap].reverse()
      }
      for (let polygonVertex = 1; polygonVertex + 1 < overlap.length; polygonVertex += 1) {
        const outputTriangle = [
          overlap[0],
          overlap[polygonVertex],
          overlap[polygonVertex + 1],
        ] as const
        if (Math.abs(getProjectionSignedArea(outputTriangle)) <= getProjectionAreaEpsilon(outputTriangle)) {
          continue
        }

        const outputCenter = getProjectionPolygonCenter(outputTriangle)
        const sourceCenterBarycentric = getProjectionBarycentric(
          outputCenter,
          sourceTriangle2
        )
        if (sourceCenterBarycentric == null) {
          continue
        }
        const sourceCenter = interpolateProjectionVector3(
          sourceWorld[0],
          sourceWorld[1],
          sourceWorld[2],
          sourceCenterBarycentric
        )
        if (
          findClosestProjectionTriangle(
            sourceCenter,
            triangleIndex,
            sourceOrientationNormal
          )?.triangle !== receiverTriangle
        ) {
          continue
        }

        const outputVertices: ConformedDecalVertex[] = []
        for (const point of outputTriangle) {
          const sourceBarycentric = getProjectionBarycentric(point, sourceTriangle2)
          const receiverBarycentric = getProjectionBarycentric(point, receiverTriangle2)
          if (sourceBarycentric == null || receiverBarycentric == null) {
            outputVertices.length = 0
            break
          }
          outputVertices.push({
            receiverPoint: interpolateProjectionVector3(
              receiverTriangle.a,
              receiverTriangle.b,
              receiverTriangle.c,
              receiverBarycentric
            ),
            receiverTriangle,
            receiverBarycentric,
            sourceBarycentric,
            sourceIndices,
          })
        }
        if (outputVertices.length === 3) {
          vertices.push(...outputVertices)
          emittedTriangle = true
        }
      }
    }

    if (!emittedTriangle) {
      continue
    }
  }

  if (vertices.length === 0) {
    return false
  }

  rebuildConformedDecalGeometry(mesh, vertices)
  return true
}

function rebuildConformedDecalGeometry(
  mesh: MeshWithGeometry,
  vertices: readonly ConformedDecalVertex[]
): void {
  const geometry = mesh.geometry
  const sourceAttributes = Object.entries(geometry.attributes) as [string, GeometryAttribute][]
  const outputAttributes = new Map<string, number[]>()
  for (const [name] of sourceAttributes) {
    if (name !== 'msfsBlendGBufferDepthAllowance') {
      outputAttributes.set(name, [])
    }
  }

  const inverseMeshMatrix = mesh.matrixWorld.clone().invert()
  const inverseNormalMatrix = new Matrix3().getNormalMatrix(inverseMeshMatrix)
  const projectedSkinIndices: number[] = []
  const projectedSkinWeights: number[] = []
  let hasProjectedSkin = false

  for (const vertex of vertices) {
    for (const [name, attribute] of sourceAttributes) {
      const values = outputAttributes.get(name)
      if (values == null) {
        continue
      }

      if (name === 'position') {
        const localPosition = vertex.receiverPoint.clone().applyMatrix4(inverseMeshMatrix)
        values.push(localPosition.x, localPosition.y, localPosition.z)
        continue
      }
      if (name === 'normal' && attribute.itemSize >= 3) {
        const normal = interpolateProjectedNormal(
          vertex.receiverTriangle,
          vertex.receiverBarycentric
        )
        if (normal != null) {
          normal.applyMatrix3(inverseNormalMatrix).normalize()
          values.push(normal.x, normal.y, normal.z)
          for (let component = 3; component < attribute.itemSize; component += 1) {
            values.push(interpolateProjectionAttribute(
              attribute,
              vertex.sourceIndices,
              vertex.sourceBarycentric,
              component
            ))
          }
          continue
        }
      }
      if (name === 'tangent' && attribute.itemSize >= 4) {
        const tangent = interpolateProjectedTangent(
          vertex.receiverTriangle,
          vertex.receiverBarycentric
        )
        if (tangent != null) {
          const tangentDirection = new Vector3(tangent[0], tangent[1], tangent[2])
            .applyMatrix3(inverseNormalMatrix)
            .normalize()
          values.push(
            tangentDirection.x,
            tangentDirection.y,
            tangentDirection.z,
            tangent[3]
          )
          continue
        }
      }

      for (let component = 0; component < attribute.itemSize; component += 1) {
        values.push(interpolateProjectionAttribute(
          attribute,
          vertex.sourceIndices,
          vertex.sourceBarycentric,
          component
        ))
      }
    }

    const influences = interpolateProjectedSkinInfluences(
      vertex.receiverTriangle,
      vertex.receiverBarycentric
    )
    hasProjectedSkin ||= influences.length > 0
    for (let component = 0; component < 4; component += 1) {
      projectedSkinIndices.push(influences[component]?.joint ?? 0)
      projectedSkinWeights.push(influences[component]?.weight ?? 0)
    }
  }

  for (const [name, attribute] of sourceAttributes) {
    if (
      name === 'msfsBlendGBufferDepthAllowance' ||
      (hasProjectedSkin && (name === 'skinIndex' || name === 'skinWeight'))
    ) {
      continue
    }
    const values = outputAttributes.get(name)
    if (values != null) {
      geometry.setAttribute(
        name,
        new BufferAttribute(new Float32Array(values), attribute.itemSize)
      )
    }
  }
  geometry.deleteAttribute('msfsBlendGBufferDepthAllowance')
  if (hasProjectedSkin) {
    geometry.setAttribute(
      'skinIndex',
      new BufferAttribute(new Uint16Array(projectedSkinIndices), 4)
    )
    geometry.setAttribute(
      'skinWeight',
      new BufferAttribute(new Float32Array(projectedSkinWeights), 4)
    )
  }
  geometry.setIndex(null)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
}

function interpolateProjectionAttribute(
  attribute: GeometryAttribute,
  indices: readonly [number, number, number],
  barycentric: ProjectionBarycentric,
  component: number
): number {
  return (
    getAttributeComponent(attribute, indices[0], component) * barycentric[0] +
    getAttributeComponent(attribute, indices[1], component) * barycentric[1] +
    getAttributeComponent(attribute, indices[2], component) * barycentric[2]
  )
}

function interpolateProjectionVector3(
  a: Vector3,
  b: Vector3,
  c: Vector3,
  barycentric: ProjectionBarycentric
): Vector3 {
  return new Vector3()
    .addScaledVector(a, barycentric[0])
    .addScaledVector(b, barycentric[1])
    .addScaledVector(c, barycentric[2])
}

function getProjectionBarycentric(
  point: ProjectionPoint2,
  triangle: readonly [ProjectionPoint2, ProjectionPoint2, ProjectionPoint2]
): ProjectionBarycentric | null {
  const ab: ProjectionPoint2 = [
    triangle[1][0] - triangle[0][0],
    triangle[1][1] - triangle[0][1],
  ]
  const ac: ProjectionPoint2 = [
    triangle[2][0] - triangle[0][0],
    triangle[2][1] - triangle[0][1],
  ]
  const ap: ProjectionPoint2 = [
    point[0] - triangle[0][0],
    point[1] - triangle[0][1],
  ]
  const denominator = getProjectionCross(ab, ac)
  if (Math.abs(denominator) <= getProjectionAreaEpsilon(triangle)) {
    return null
  }
  const b = getProjectionCross(ap, ac) / denominator
  const c = getProjectionCross(ab, ap) / denominator
  return [1 - b - c, b, c]
}

function clipProjectionPolygon(
  subject: readonly ProjectionPoint2[],
  clipTriangle: readonly [ProjectionPoint2, ProjectionPoint2, ProjectionPoint2]
): ProjectionPoint2[] {
  const clipOrientation = Math.sign(getProjectionSignedArea(clipTriangle))
  if (clipOrientation === 0) {
    return []
  }
  const epsilon = getProjectionAreaEpsilon([...subject, ...clipTriangle])
  let output = [...subject]

  for (let edgeIndex = 0; edgeIndex < 3 && output.length > 0; edgeIndex += 1) {
    const edgeStart = clipTriangle[edgeIndex]
    const edgeEnd = clipTriangle[(edgeIndex + 1) % 3]
    const edge: ProjectionPoint2 = [
      edgeEnd[0] - edgeStart[0],
      edgeEnd[1] - edgeStart[1],
    ]
    const input = output
    output = []
    let previous = input[input.length - 1]
    let previousInside = isProjectionPointInsideEdge(
      previous,
      edgeStart,
      edge,
      clipOrientation,
      epsilon
    )

    for (const current of input) {
      const currentInside = isProjectionPointInsideEdge(
        current,
        edgeStart,
        edge,
        clipOrientation,
        epsilon
      )
      if (currentInside !== previousInside) {
        const intersection = intersectProjectionLines(
          previous,
          current,
          edgeStart,
          edgeEnd,
          epsilon
        )
        if (intersection != null) {
          output.push(intersection)
        }
      }
      if (currentInside) {
        output.push(current)
      }
      previous = current
      previousInside = currentInside
    }
  }

  return output
}

function isProjectionPointInsideEdge(
  point: ProjectionPoint2,
  edgeStart: ProjectionPoint2,
  edge: ProjectionPoint2,
  orientation: number,
  epsilon: number
): boolean {
  return orientation * getProjectionCross(edge, [
    point[0] - edgeStart[0],
    point[1] - edgeStart[1],
  ]) >= -epsilon
}

function intersectProjectionLines(
  segmentStart: ProjectionPoint2,
  segmentEnd: ProjectionPoint2,
  edgeStart: ProjectionPoint2,
  edgeEnd: ProjectionPoint2,
  epsilon: number
): ProjectionPoint2 | null {
  const segment: ProjectionPoint2 = [
    segmentEnd[0] - segmentStart[0],
    segmentEnd[1] - segmentStart[1],
  ]
  const edge: ProjectionPoint2 = [
    edgeEnd[0] - edgeStart[0],
    edgeEnd[1] - edgeStart[1],
  ]
  const denominator = getProjectionCross(segment, edge)
  if (Math.abs(denominator) <= epsilon) {
    return null
  }
  const toEdge: ProjectionPoint2 = [
    edgeStart[0] - segmentStart[0],
    edgeStart[1] - segmentStart[1],
  ]
  const amount = getProjectionCross(toEdge, edge) / denominator
  return [
    segmentStart[0] + segment[0] * amount,
    segmentStart[1] + segment[1] * amount,
  ]
}

function getProjectionPolygonCenter(points: readonly ProjectionPoint2[]): ProjectionPoint2 {
  const sum = points.reduce(
    (value, point) => [value[0] + point[0], value[1] + point[1]] as ProjectionPoint2,
    [0, 0] as ProjectionPoint2
  )
  return [sum[0] / points.length, sum[1] / points.length]
}

function getProjectionSignedArea(points: readonly ProjectionPoint2[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    twiceArea += current[0] * next[1] - current[1] * next[0]
  }
  return twiceArea * 0.5
}

function getProjectionCross(a: ProjectionPoint2, b: ProjectionPoint2): number {
  return a[0] * b[1] - a[1] * b[0]
}

function getProjectionAreaEpsilon(points: readonly ProjectionPoint2[]): number {
  let scale = 1
  for (const point of points) {
    scale = Math.max(scale, Math.abs(point[0]), Math.abs(point[1]))
  }
  return Number.EPSILON * scale * scale * 128
}

function projectBlendGBufferPrimitiveToBase(
  mesh: MeshWithGeometry,
  triangleIndex: DecalProjectionSpatialIndex
): void {
  const geometry = mesh.geometry
  mesh.updateWorldMatrix(true, false)
  const positionAttribute = geometry.getAttribute('position')
  if (positionAttribute == null || positionAttribute.itemSize < 3) {
    return
  }

  const normalAttribute = geometry.getAttribute('normal') ?? null
  const tangentAttribute = geometry.getAttribute('tangent') ?? null
  const inverseMeshMatrix = mesh.matrixWorld.clone().invert()
  const inverseNormalMatrix = new Matrix3().getNormalMatrix(inverseMeshMatrix)
  const skinIndices = new Uint16Array(positionAttribute.count * 4)
  const skinWeights = new Float32Array(positionAttribute.count * 4)
  let shouldReplaceSkinAttributes = false
  for (let vertexIndex = 0; vertexIndex < positionAttribute.count; vertexIndex += 1) {
    const point = getPositionAttributeVector(positionAttribute, vertexIndex)
      .applyMatrix4(mesh.matrixWorld)
    const closest = findClosestProjectionTriangle(point, triangleIndex)
    if (closest == null) {
      continue
    }

    const localProjectedPoint = closest.point.clone().applyMatrix4(inverseMeshMatrix)
    positionAttribute.setXYZ(
      vertexIndex,
      localProjectedPoint.x,
      localProjectedPoint.y,
      localProjectedPoint.z
    )

    const normal = interpolateProjectedNormal(closest.triangle, closest.barycentric)
    if (normal != null && normalAttribute != null && normalAttribute.itemSize >= 3) {
      normal.applyMatrix3(inverseNormalMatrix).normalize()
      normalAttribute.setXYZ(vertexIndex, normal.x, normal.y, normal.z)
    }

    const tangent = interpolateProjectedTangent(closest.triangle, closest.barycentric)
    if (tangent != null && tangentAttribute != null && tangentAttribute.itemSize >= 4) {
      const tangentDirection = new Vector3(tangent[0], tangent[1], tangent[2])
        .applyMatrix3(inverseNormalMatrix)
        .normalize()
      tangentAttribute.setXYZW(
        vertexIndex,
        tangentDirection.x,
        tangentDirection.y,
        tangentDirection.z,
        tangent[3]
      )
    }

    const influences = interpolateProjectedSkinInfluences(closest.triangle, closest.barycentric)
    if (influences.length > 0) {
      shouldReplaceSkinAttributes = true
      for (let component = 0; component < 4; component += 1) {
        skinIndices[vertexIndex * 4 + component] = influences[component]?.joint ?? 0
        skinWeights[vertexIndex * 4 + component] = influences[component]?.weight ?? 0
      }
    }

  }

  positionAttribute.needsUpdate = true
  if (normalAttribute != null) {
    normalAttribute.needsUpdate = true
  }
  if (tangentAttribute != null) {
    tangentAttribute.needsUpdate = true
  }

  if (shouldReplaceSkinAttributes) {
    geometry.setAttribute(
      'skinIndex',
      new BufferAttribute(skinIndices, 4)
    )
    geometry.setAttribute(
      'skinWeight',
      new BufferAttribute(skinWeights, 4)
    )
  }
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
}

function findClosestProjectionTriangle(
  point: Vector3,
  triangleIndex: DecalProjectionSpatialIndex,
  orientationNormal?: Vector3
): (ClosestPointResult & { readonly triangle: DecalProjectionTriangle }) | null {
  const closest: {
    triangle: DecalProjectionTriangleItem | null
    result: ClosestPointResult | null
    distanceSq: number
  } = {
    triangle: null,
    result: null,
    distanceSq: Infinity,
  }
  const search = (node: DecalProjectionSpatialIndex): void => {
    if (getPointToBoundsDistanceSquared(point, node.min, node.max) > closest.distanceSq) {
      return
    }

    if (node.items != null) {
      for (const item of node.items) {
        if (
          orientationNormal != null &&
          item.triangle.orientationNormal.dot(orientationNormal) <= 0
        ) {
          continue
        }
        if (getPointToBoundsDistanceSquared(point, item.min, item.max) > closest.distanceSq) {
          continue
        }

        const result = closestPointToTriangle(point, item.triangle.a, item.triangle.b, item.triangle.c)
        const distanceSq = result.point.distanceToSquared(point)
        if (distanceSq < closest.distanceSq) {
          closest.distanceSq = distanceSq
          closest.triangle = item
          closest.result = result
        }
      }
      return
    }

    const left = node.left
    const right = node.right
    if (left == null && right == null) {
      return
    }

    if (left == null) {
      search(right!)
      return
    }
    if (right == null) {
      search(left)
      return
    }

    const leftDistanceSq = getPointToBoundsDistanceSquared(point, left.min, left.max)
    const rightDistanceSq = getPointToBoundsDistanceSquared(point, right.min, right.max)
    if (leftDistanceSq <= rightDistanceSq) {
      search(left)
      search(right)
    } else {
      search(right)
      search(left)
    }
  }

  search(triangleIndex)

  return closest.triangle != null && closest.result != null
    ? {
        point: closest.result.point,
        barycentric: closest.result.barycentric,
        triangle: closest.triangle.triangle,
      }
    : null
}

function getPointToBoundsDistanceSquared(point: Vector3, min: Vector3, max: Vector3): number {
  const dx = point.x < min.x ? min.x - point.x : point.x > max.x ? point.x - max.x : 0
  const dy = point.y < min.y ? min.y - point.y : point.y > max.y ? point.y - max.y : 0
  const dz = point.z < min.z ? min.z - point.z : point.z > max.z ? point.z - max.z : 0
  return dx * dx + dy * dy + dz * dz
}

function getPositionAttributeVector(attribute: GeometryAttribute, index: number): Vector3 {
  return new Vector3(
    attribute.getX(index),
    attribute.getY(index),
    attribute.getZ(index)
  )
}

function getNormalAttributeVector(
  attribute: GeometryAttribute | null,
  index: number,
  normalMatrix: Matrix3
): Vector3 | null {
  if (attribute == null || attribute.itemSize < 3) {
    return null
  }

  return getPositionAttributeVector(attribute, index)
    .applyMatrix3(normalMatrix)
    .normalize()
}

function getTangentAttributeVector(
  attribute: GeometryAttribute | null,
  index: number,
  normalMatrix: Matrix3
): readonly [number, number, number, number] | null {
  if (attribute == null || attribute.itemSize < 4) {
    return null
  }

  const tangentDirection = new Vector3(
    attribute.getX(index),
    attribute.getY(index),
    attribute.getZ(index)
  )
    .applyMatrix3(normalMatrix)
    .normalize()

  return [
    tangentDirection.x,
    tangentDirection.y,
    tangentDirection.z,
    attribute.getW(index)
  ]
}

function getSkinInfluences(geometry: BufferGeometry, vertexIndex: number): readonly SkinInfluence[] {
  const skinIndexAttribute = geometry.getAttribute('skinIndex')
  const skinWeightAttribute = geometry.getAttribute('skinWeight')
  if (skinIndexAttribute == null || skinWeightAttribute == null) {
    return []
  }

  const influences: SkinInfluence[] = []
  const componentCount = Math.min(4, skinIndexAttribute.itemSize, skinWeightAttribute.itemSize)
  for (let component = 0; component < componentCount; component += 1) {
    const weight = getAttributeComponent(skinWeightAttribute, vertexIndex, component)
    if (weight <= 0) {
      continue
    }

    influences.push({
      joint: Math.round(getAttributeComponent(skinIndexAttribute, vertexIndex, component)),
      weight,
    })
  }

  return influences
}

function getAttributeComponent(
  attribute: GeometryAttribute,
  vertexIndex: number,
  component: number
): number {
  switch (component) {
    case 0: return attribute.getX(vertexIndex)
    case 1: return attribute.getY(vertexIndex)
    case 2: return attribute.getZ(vertexIndex)
    case 3: return attribute.getW(vertexIndex)
    default: return 0
  }
}

function interpolateProjectedNormal(
  triangle: DecalProjectionTriangle,
  barycentric: readonly [number, number, number]
): Vector3 | null {
  if (triangle.normalA == null || triangle.normalB == null || triangle.normalC == null) {
    return null
  }

  return new Vector3()
    .addScaledVector(triangle.normalA, barycentric[0])
    .addScaledVector(triangle.normalB, barycentric[1])
    .addScaledVector(triangle.normalC, barycentric[2])
    .normalize()
}

function interpolateProjectedTangent(
  triangle: DecalProjectionTriangle,
  barycentric: readonly [number, number, number]
): readonly [number, number, number, number] | null {
  if (triangle.tangentA == null || triangle.tangentB == null || triangle.tangentC == null) {
    return null
  }

  const tangent = new Vector3()
    .addScaledVector(new Vector3(triangle.tangentA[0], triangle.tangentA[1], triangle.tangentA[2]), barycentric[0])
    .addScaledVector(new Vector3(triangle.tangentB[0], triangle.tangentB[1], triangle.tangentB[2]), barycentric[1])
    .addScaledVector(new Vector3(triangle.tangentC[0], triangle.tangentC[1], triangle.tangentC[2]), barycentric[2])
    .normalize()

  return [
    tangent.x,
    tangent.y,
    tangent.z,
    barycentric[0] >= barycentric[1] && barycentric[0] >= barycentric[2]
      ? triangle.tangentA[3]
      : barycentric[1] >= barycentric[2]
        ? triangle.tangentB[3]
        : triangle.tangentC[3]
  ]
}

function interpolateProjectedSkinInfluences(
  triangle: DecalProjectionTriangle,
  barycentric: readonly [number, number, number]
): readonly SkinInfluence[] {
  const weightsByJoint = new Map<number, number>()
  addWeightedSkinInfluences(weightsByJoint, triangle.skinA, barycentric[0])
  addWeightedSkinInfluences(weightsByJoint, triangle.skinB, barycentric[1])
  addWeightedSkinInfluences(weightsByJoint, triangle.skinC, barycentric[2])

  const influences = [...weightsByJoint]
    .filter(([, weight]) => weight > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([joint, weight]) => ({ joint, weight }))
  const weightSum = influences.reduce((sum, influence) => sum + influence.weight, 0)
  if (weightSum <= 0) {
    return []
  }

  return influences.map(influence => ({
    joint: influence.joint,
    weight: influence.weight / weightSum,
  }))
}

function addWeightedSkinInfluences(
  weightsByJoint: Map<number, number>,
  influences: readonly SkinInfluence[],
  barycentricWeight: number
): void {
  for (const influence of influences) {
    weightsByJoint.set(
      influence.joint,
      (weightsByJoint.get(influence.joint) ?? 0) + influence.weight * barycentricWeight
    )
  }
}

// From Real-Time Collision Detection, Christer Ericson.
function closestPointToTriangle(
  point: Vector3,
  a: Vector3,
  b: Vector3,
  c: Vector3
): ClosestPointResult {
  const ab = new Vector3().subVectors(b, a)
  const ac = new Vector3().subVectors(c, a)
  const ap = new Vector3().subVectors(point, a)
  const d1 = ab.dot(ap)
  const d2 = ac.dot(ap)
  if (d1 <= 0 && d2 <= 0) {
    return { point: a.clone(), barycentric: [1, 0, 0] }
  }

  const bp = new Vector3().subVectors(point, b)
  const d3 = ab.dot(bp)
  const d4 = ac.dot(bp)
  if (d3 >= 0 && d4 <= d3) {
    return { point: b.clone(), barycentric: [0, 1, 0] }
  }

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return {
      point: a.clone().addScaledVector(ab, v),
      barycentric: [1 - v, v, 0],
    }
  }

  const cp = new Vector3().subVectors(point, c)
  const d5 = ab.dot(cp)
  const d6 = ac.dot(cp)
  if (d6 >= 0 && d5 <= d6) {
    return { point: c.clone(), barycentric: [0, 0, 1] }
  }

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return {
      point: a.clone().addScaledVector(ac, w),
      barycentric: [1 - w, 0, w],
    }
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    return {
      point: b.clone().addScaledVector(new Vector3().subVectors(c, b), w),
      barycentric: [0, 1 - w, w],
    }
  }

  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return {
    point: a.clone().addScaledVector(ab, v).addScaledVector(ac, w),
    barycentric: [1 - v - w, v, w],
  }
}

async function normalizeMsfsMaterial(
  material: MsfsMaterial,
  parser: GltfParserLike | undefined,
  textureCache: Map<number, Promise<Texture>>,
  materialIndex: number | undefined,
  options: MsfsMaterialNormalizationOptions,
  buildGBufferWriter: boolean
): Promise<MsfsMaterial> {
  let outputMaterial = material
  const isBlendGBufferMaterial = usesBlendGBufferMaterial(outputMaterial)
  const blendFactors = getMsfsBlendFactors(outputMaterial)
  const materialDef =
    parser != null && materialIndex != null
      ? parser.json.materials?.[materialIndex]
      : null
  const asoboMaterialCode = materialDef?.extras?.ASOBO_material_code
  if (asoboMaterialCode != null) {
    outputMaterial.userData ??= {}
    outputMaterial.userData.msfsMaterialCode = asoboMaterialCode
  }

  // MSFS exports DirectX-convention normal maps, while stock glTF assumes OpenGL.
  if (outputMaterial.normalMap != null && outputMaterial.normalScale != null) {
    const normalBlendFactor =
      isBlendGBufferMaterial && buildGBufferWriter
        ? 1
        : blendFactors.normal
    outputMaterial.normalScale.set(
      outputMaterial.normalScale.x * normalBlendFactor,
      -Math.abs(outputMaterial.normalScale.y) * normalBlendFactor
    )
    outputMaterial.normalMap.needsUpdate = true
    outputMaterial.needsUpdate = true
  }

  if (
    outputMaterial.normalMap != null &&
    usesMsfsCompressedRgNormalMap(outputMaterial.normalMap.format)
  ) {
    if (options.createNodeMaterial == null) {
      patchCompressedRgNormalMapShader(outputMaterial, outputMaterial.normalMap.format)
    } else {
      outputMaterial = createCompressedRgNormalNodeMaterial(
        outputMaterial,
        options.createNodeMaterial
      )
    }
  }

  // Some MSFS blend/decal albedo textures use BC1/DXT1 1-bit alpha. Reinterpret
  // those transparent materials as RGBA DXT1 so the alpha channel is preserved.
  if (
    outputMaterial.transparent === true &&
    outputMaterial.map != null &&
    outputMaterial.map.format === RGB_S3TC_DXT1_Format
  ) {
    outputMaterial.map.format = RGBA_S3TC_DXT1_Format
    outputMaterial.map.needsUpdate = true
    outputMaterial.needsUpdate = true
  }

  if (
    asoboMaterialCode === 'Porthole' &&
    outputMaterial.map != null &&
    outputMaterial.transparent !== true
  ) {
    outputMaterial.transparent = true
    outputMaterial.depthWrite = false
    outputMaterial.premultipliedAlpha = false
    outputMaterial.needsUpdate = true
  }

  if (isBlendGBufferMaterial) {
    const hasForwardColor = usesBlendGBufferColorMaterial(outputMaterial)
    outputMaterial.depthWrite = false
    outputMaterial.polygonOffset = true
    outputMaterial.polygonOffsetFactor =
      MSFS_BLEND_GBUFFER_POLYGON_OFFSET_BASE - getMsfsDrawOrderOffset(outputMaterial)
    outputMaterial.polygonOffsetUnits =
      MSFS_BLEND_GBUFFER_POLYGON_OFFSET_BASE - getMsfsDrawOrderOffset(outputMaterial)
    outputMaterial.premultipliedAlpha = false
    outputMaterial.forceSinglePass = true
    outputMaterial.userData ??= {}
    outputMaterial.userData.msfsBlendGBufferForwardColor = hasForwardColor
    outputMaterial.needsUpdate = true
  }

  if (parser != null && materialIndex != null) {
    const detailMapExtension = materialDef?.extensions?.ASOBO_material_detail_map
    if (detailMapExtension != null) {
      const detailTextures = await loadMsfsDetailTextures(
        parser,
        textureCache,
        detailMapExtension
      )
      if (options.createNodeMaterial != null) {
        outputMaterial = applyMsfsDetailMapNodeMaterial(
          outputMaterial,
          detailMapExtension,
          detailTextures,
          options.createNodeMaterial
        )
      } else {
        applyMsfsDetailMapShader(outputMaterial, detailMapExtension, detailTextures)
      }
    }
  }

  if (options.createNodeMaterial != null) {
    const nodeMaterial = ensureNodeMaterial(outputMaterial, options.createNodeMaterial)
    if (nodeMaterial != null) {
      const gBufferWriter = buildGBufferWriter
        ? createMsfsGBufferWriter(
            nodeMaterial,
            isBlendGBufferMaterial ? blendFactors : null
          )
        : null
      if (isBlendGBufferMaterial) {
        outputMaterial = applyMsfsBlendGBufferNodeMaterial(
          nodeMaterial,
          blendFactors,
          usesBlendGBufferColorMaterial(nodeMaterial),
          options.createNodeMaterial
        )
      } else {
        outputMaterial = nodeMaterial as unknown as MsfsMaterial
      }
      outputMaterial.userData ??= {}
      if (gBufferWriter != null) {
        outputMaterial.userData.msfsGBufferWriter = gBufferWriter
      }
    }
  }

  return outputMaterial
}

export function usesBlendGBufferMaterial(
  material: Material | MsfsMaterial | null | undefined
): boolean {
  return getMsfsExtensions(material)?.ASOBO_material_blend_gbuffer != null
}

export function usesBlendGBufferColorMaterial(
  material: Material | MsfsMaterial | null | undefined
): boolean {
  if (!usesBlendGBufferMaterial(material)) {
    return false
  }

  const materialFlag = (material?.userData as MsfsMaterial['userData'] | undefined)
    ?.msfsBlendGBufferForwardColor
  if (materialFlag != null) {
    return materialFlag
  }

  const blendFactors = getMsfsBlendFactors(material)
  return blendFactors.baseColor > 0 || blendFactors.emissive > 0
}

export function usesGeoDecalFrostedMaterial(
  material: Material | MsfsMaterial | null | undefined
): boolean {
  return (material?.userData as { msfsMaterialCode?: string } | undefined)?.msfsMaterialCode === 'GeoDecalFrosted'
}

function usesInvisibleMaterial(material: Material | MsfsMaterial | null | undefined): boolean {
  return getMsfsExtensions(material)?.ASOBO_material_invisible != null
}

function usesMsfsNoCastShadow(material: Material | MsfsMaterial | null | undefined): boolean {
  return getMsfsExtensions(material)?.ASOBO_material_shadow_options?.noCastShadow === true
}

function getMsfsDrawOrderOffset(
  material: Material | MsfsMaterial | null | undefined
): number {
  const drawOrderOffset = getMsfsExtensions(material)?.ASOBO_material_draw_order?.drawOrderOffset
  return typeof drawOrderOffset === 'number' ? drawOrderOffset : 0
}

function getMsfsDecalRenderOrder(
  drawOrderOffset: number,
  primitiveOrder: number,
  primitiveOrderStride: number
): number {
  return (
    MSFS_BLEND_GBUFFER_RENDER_ORDER_BASE +
    (drawOrderOffset - MSFS_MATERIAL_DRAW_ORDER_MIN) * primitiveOrderStride +
    primitiveOrder
  )
}

function getMsfsDecalRenderOrderStride(parser: GltfParserLike | undefined): number {
  return Math.max(
    1,
    ...(
      parser?.json.meshes?.map(mesh => mesh.primitives?.length ?? 0) ?? []
    )
  ) + 1
}

function getMsfsExtensions(
  material: Material | MsfsMaterial | null | undefined
): MsfsMaterialExtensions | null {
  return (material?.userData?.gltfExtensions as MsfsMaterialExtensions | undefined) ?? null
}

function usesMsfsCompressedRgNormalMap(format: number | undefined): boolean {
  return (
    format === RGFormat ||
    format === RED_GREEN_RGTC2_Format ||
    format === SIGNED_RED_GREEN_RGTC2_Format
  )
}

function patchCompressedRgNormalMapShader(material: MsfsMaterial, format: number): void {
  const shaderMode = format === SIGNED_RED_GREEN_RGTC2_Format ? 'signed-rg' : 'unsigned-rg'
  registerShaderPatch(material, `msfs-normal:${shaderMode}`, shader => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
      createCompressedRgNormalMapShaderSnippet(shaderMode)
    )
  })
}

function createCompressedRgNormalMapShaderSnippet(shaderMode: 'signed-rg' | 'unsigned-rg'): string {
  const decodeRg =
    shaderMode === 'signed-rg'
      ? 'vec2 rawMapNxy = texture2D( normalMap, vNormalMapUv ).xy;'
      : 'vec2 rawMapNxy = texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0;'

  return [
    decodeRg,
    'vec2 mapNxy = rawMapNxy;',
    'mapNxy *= normalScale;',
    'float mapNz = sqrt( max( 1.0 - dot( rawMapNxy, rawMapNxy ), 0.0 ) );',
    'vec3 mapN = vec3( mapNxy, mapNz );'
  ].join('\n\t')
}

function createCompressedRgNormalNodeMaterial(
  material: MsfsMaterial,
  createNodeMaterial: NodeMaterialFactory
): MsfsMaterial {
  const nodeMaterial = ensureNodeMaterial(material, createNodeMaterial)
  if (
    nodeMaterial == null ||
    material.normalMap == null ||
    material.normalScale == null
  ) {
    return material
  }

  const compressedRgNormalNode = createMsfsCompressedRgNormalNode(material)
  if (compressedRgNormalNode == null) {
    return material
  }

  nodeMaterial.normalNode = compressedRgNormalNode
  nodeMaterial.needsUpdate = true
  return nodeMaterial as unknown as MsfsMaterial
}

export function getMsfsGBufferWriter(
  material: Material | MsfsMaterial | null | undefined
): Material | null {
  return (material?.userData as MsfsMaterial['userData'] | undefined)?.msfsGBufferWriter ?? null
}

export function createMsfsDeferredLightingMaterial(
  material: Material | MsfsMaterial,
  textures: AircraftGBufferTextures
): Material | null {
  const source = material as MsfsNodeMaterial
  if (source.isNodeMaterial !== true) {
    return null
  }

  const lightingMaterial = source.clone() as MsfsNodeMaterial
  const g0 = texture(textures.g0, screenUV)
  const g1 = texture(textures.g1, screenUV)
  const g2 = texture(textures.g2, screenUV)
  const g3 = texture(textures.g3, screenUV)

  lightingMaterial.colorNode = vec4(g0.rgb, 1)
  lightingMaterial.opacityNode = float(1)
  lightingMaterial.normalNode = g1.xyz.normalize()
  lightingMaterial.roughnessNode = g2.r
  lightingMaterial.metalnessNode = g2.g
  lightingMaterial.aoNode = g2.b
  lightingMaterial.emissiveNode = g3.rgb
  lightingMaterial.transparent = false
  lightingMaterial.alphaTest = 0
  lightingMaterial.depthTest = true
  lightingMaterial.depthWrite = true
  lightingMaterial.polygonOffset = false
  lightingMaterial.blending = NoBlending
  lightingMaterial.userData = { ...lightingMaterial.userData }
  delete lightingMaterial.userData.msfsGBufferWriter
  lightingMaterial.needsUpdate = true
  return lightingMaterial as unknown as Material
}

function resolveMsfsMaterialNode(node: any, fallback: any): any {
  return node?.isVarNode === true ? node.node : node ?? fallback
}

// Direct MRT fragment outputs bypass NodeMaterial's diffuse setup, so mirror its
// color, texture, vertex-color, opacity, and alpha-map composition explicitly.
function createMsfsMaterialBaseColorNode(source: MsfsNodeMaterial) {
  let colorNode: any
  if (source.colorNode != null) {
    colorNode = vec4(resolveMsfsMaterialNode(source.colorNode, vec4(1)))
  } else {
    colorNode = vec4(materialReference('color', 'color'), 1)
    if (source.map != null) {
      colorNode = colorNode.mul(texture(source.map))
    }
  }
  if (source.vertexColors === true) {
    colorNode = colorNode.mul(vec4(vertexColor()))
  }
  return colorNode
}

function createMsfsMaterialOpacityNode(source: MsfsNodeMaterial) {
  if (source.opacityNode != null) {
    return float(resolveMsfsMaterialNode(source.opacityNode, 1))
  }

  let opacityNode: any = materialReference('opacity', 'float')
  if (source.alphaMap != null) {
    opacityNode = opacityNode.mul(texture(source.alphaMap).g)
  }
  return opacityNode
}

function createMsfsMaterialCoverageNode(source: MsfsNodeMaterial, colorNode: any) {
  return colorNode.a.mul(createMsfsMaterialOpacityNode(source)).clamp(0, 1)
}

function createMsfsGBufferWriter(
  source: MsfsNodeMaterial,
  blendFactors: MsfsBlendFactors | null
): Material | null {
  const writer = new MeshBasicNodeMaterial() as unknown as MsfsNodeMaterial
  copyMsfsGBufferWriterInputs(writer, source)
  const colorNode = createMsfsMaterialBaseColorNode(source)
  const materialCoverage = createMsfsMaterialCoverageNode(source, colorNode)
  const normalNode = vec3(resolveMsfsMaterialNode(
    source.normalNode,
    createMsfsGBufferNormalNode(source)
  )).normalize()
  const roughnessNode = resolveMsfsMaterialNode(
    source.roughnessNode,
    createMsfsGBufferRoughnessNode(source)
  )
  const metalnessNode = resolveMsfsMaterialNode(
    source.metalnessNode,
    createMsfsGBufferMetalnessNode(source)
  )
  const aoNode = resolveMsfsMaterialNode(source.aoNode, createMsfsGBufferAoNode(source))
  const emissiveNode = vec3(createMsfsGBufferEmissiveNode(source))
  const isDecal = blendFactors != null
  if (
    isDecal &&
    (
      blendFactors.roughness !== blendFactors.metallic ||
      blendFactors.roughness !== blendFactors.occlusion
    )
  ) {
    // A packed RGB attachment has one source alpha, so independent ORM blend
    // factors cannot be represented without reading the destination. Fall back
    // rather than silently blending the three channels incorrectly.
    writer.dispose()
    return null
  }
  const coverage = (factor: number) => isDecal
    ? materialCoverage.mul(factor)
    : float(1)
  const ormCoverage = coverage(blendFactors?.roughness ?? 1)

  const writerMrt = mrt({
    aircraftG0: vec4(colorNode.rgb, coverage(blendFactors?.baseColor ?? 1)),
    aircraftG1: vec4(normalNode, coverage(blendFactors?.normal ?? 1)),
    aircraftG2: vec4(roughnessNode, metalnessNode, aoNode, ormCoverage),
    aircraftG3: vec4(emissiveNode, coverage(blendFactors?.emissive ?? 1)),
  }) as unknown as {
    getBlendMode?: (name: string) => { constructor: new (blending?: number) => unknown }
    setBlendMode?: (name: string, blendMode: unknown) => unknown
  }

  if (isDecal) {
    if (writerMrt.getBlendMode == null || writerMrt.setBlendMode == null) {
      writer.dispose()
      return null
    }
    const BlendMode = writerMrt.getBlendMode('output').constructor
    for (const name of ['aircraftG0', 'aircraftG1', 'aircraftG2', 'aircraftG3']) {
      writerMrt.setBlendMode(name, new BlendMode(NormalBlending))
    }
  }

  // NodeMaterial only merges mrtNode through its standard fragment path. Use
  // the MRT output struct directly so converted MSFS node graphs cannot replace
  // or bypass the G-buffer outputs during compilation. Keep coverage rejection
  // in maskNode so it runs before the direct MRT output without wrapping it.
  writer.fragmentNode = writerMrt
  writer.maskNode = isDecal
    ? materialCoverage
        .greaterThan(source.alphaTest ?? 0)
        .and(createMsfsBlendGBufferDepthMaskNode().greaterThan(0.5))
    : null
  writer.mrtNode = writerMrt
  writer.depthNode = isDecal ? createMsfsGBufferDecalDepthNode() : null
  writer.lights = false
  writer.fog = false
  writer.toneMapped = false
  writer.transparent = isDecal
  writer.alphaTest = 0
  writer.depthTest = true
  writer.depthWrite = !isDecal
  writer.polygonOffset = false
  writer.premultipliedAlpha = false
  writer.blending = isDecal ? NormalBlending : NoBlending
  writer.userData = { ...writer.userData }
  delete writer.userData.msfsGBufferWriter
  writer.needsUpdate = true
  return writer as unknown as Material
}

function copyMsfsGBufferWriterInputs(
  writer: MsfsNodeMaterial,
  source: MsfsNodeMaterial
): void {
  const sourceMaterial = source as any
  const writerMaterial = writer as any
  for (const property of [
    'alphaMap',
    'aoMap',
    'aoMapIntensity',
    'bumpMap',
    'bumpScale',
    'displacementBias',
    'displacementMap',
    'displacementScale',
    'emissiveIntensity',
    'emissiveMap',
    'map',
    'metalness',
    'metalnessMap',
    'normalMap',
    'normalMapType',
    'normalScale',
    'opacity',
    'roughness',
    'roughnessMap',
    'side',
    'vertexColors',
  ]) {
    if (sourceMaterial[property] !== undefined) {
      writerMaterial[property] = sourceMaterial[property]
    }
  }
  writerMaterial.color?.copy?.(sourceMaterial.color)
  writerMaterial.emissive = sourceMaterial.emissive
}

function createMsfsGBufferNormalNode(material: MsfsMaterial) {
  if (material.normalMap == null) {
    return normalView
  }
  const tangentNormal = createMsfsBaseTangentNormalNode(material)
  return tangentNormal == null
    ? normalView
    : TBNViewMatrix.mul(tangentNormal).normalize()
}

function createMsfsGBufferRoughnessNode(material: MsfsMaterial) {
  const source = material as any
  const value = float(source.roughness ?? 1)
  return source.roughnessMap == null
    ? value
    : value.mul(texture(source.roughnessMap).g)
}

function createMsfsGBufferMetalnessNode(material: MsfsMaterial) {
  const source = material as any
  const value = float(source.metalness ?? 0)
  return source.metalnessMap == null
    ? value
    : value.mul(texture(source.metalnessMap).b)
}

function createMsfsGBufferAoNode(material: MsfsMaterial) {
  const source = material as any
  if (source.aoMap == null) {
    return float(1)
  }
  return mix(
    float(1),
    texture(source.aoMap).r,
    float(source.aoMapIntensity ?? 1)
  ).clamp(0, 1)
}

function createMsfsGBufferEmissiveNode(material: MsfsMaterial) {
  const source = material as any
  let emissiveNode = vec3(uniform(source.emissive)).mul(source.emissiveIntensity ?? 1)
  if (source.emissiveMap != null) {
    emissiveNode = emissiveNode.mul(texture(source.emissiveMap).rgb)
  }
  return emissiveNode
}

function applyMsfsBlendGBufferNodeMaterial(
  material: MsfsMaterial,
  blendFactors: MsfsBlendFactors,
  hasForwardColor: boolean,
  createNodeMaterial: NodeMaterialFactory
): MsfsMaterial {
  const nodeMaterial = ensureNodeMaterial(material, createNodeMaterial)
  if (nodeMaterial == null) {
    return material
  }

  nodeMaterial.lights = !hasForwardColor
  const baseColorNode = createMsfsMaterialBaseColorNode(nodeMaterial)
  const opacityBlendFactor = getMsfsBlendGBufferForwardOpacityFactor(blendFactors)
  nodeMaterial.colorNode = vec4(
    baseColorNode.rgb.mul(blendFactors.baseColor),
    1
  )
  nodeMaterial.opacityNode = createMsfsMaterialCoverageNode(nodeMaterial, baseColorNode)
    .mul(opacityBlendFactor)
    .mul(createMsfsBlendGBufferDepthMaskNode())

  if (material.emissiveMap != null) {
    nodeMaterial.emissiveNode = texture(material.emissiveMap)
      .rgb
      .mul(materialEmissive)
      .mul(blendFactors.emissive)
  }

  nodeMaterial.userData ??= {}
  nodeMaterial.userData.msfsBlendGBufferDepthMask = true
  nodeMaterial.userData.msfsBlendGBufferForwardColor = hasForwardColor
  nodeMaterial.needsUpdate = true
  return nodeMaterial as unknown as MsfsMaterial
}

function getMsfsBlendGBufferForwardOpacityFactor(blendFactors: MsfsBlendFactors): number {
  return Math.max(blendFactors.baseColor, blendFactors.emissive)
}

const viewZToBiasedDecalDepth = Fn(([viewZ]: any[], builder: any) => {
  const fragmentDepth = builder.camera.isPerspectiveCamera
    ? viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar)
    : viewZToOrthographicDepth(viewZ, cameraNear, cameraFar)
  const outputDepth = builder.renderer.reversedDepthBuffer === true
    ? fragmentDepth.oneMinus()
    : fragmentDepth
  const pixelAllowance = outputDepth.fwidth()
  return builder.renderer.reversedDepthBuffer === true
    ? outputDepth.add(pixelAllowance).clamp(0, 1)
    : outputDepth.sub(pixelAllowance).clamp(0, 1)
})

function createMsfsGBufferDecalDepthNode() {
  return viewZToBiasedDecalDepth(positionView.z)
}

function createMsfsBlendGBufferDepthMaskNode() {
  const decalDepth = linearDepth()
  const sceneDepth = linearDepth(texture(msfsBlendGBufferDepthTexture, screenUV).r)
  const sameSurfaceDepthAllowance = decalDepth
    .fwidth()
    .add(sceneDepth.fwidth())

  const depthMask = decalDepth
    .sub(sceneDepth)
    .abs()
    .lessThanEqual(sameSurfaceDepthAllowance)
    .select(1, 0)
  return msfsBlendGBufferDepthMaskEnabled.lessThan(0.5).select(1, depthMask)
}

function applyMsfsDetailMapNodeMaterial(
  material: MsfsMaterial,
  extension: MsfsDetailMapExtension,
  textures: LoadedMsfsDetailTextures,
  createNodeMaterial: NodeMaterialFactory
): MsfsMaterial {
  const nodeMaterial = ensureNodeMaterial(material, createNodeMaterial)
  if (nodeMaterial == null) {
    applyMsfsDetailMapShader(material, extension, textures)
    return material
  }

  const detailUv = uv()
    .mul(extension.UVScale ?? 1)
    .add(vec2(extension.UVOffset?.[0] ?? 0, extension.UVOffset?.[1] ?? 0))

  let detailBlend = vertexColor().a
  if (textures.blendMaskTexture != null) {
    detailBlend = detailBlend.mul(texture(textures.blendMaskTexture, detailUv).r)
  }
  detailBlend = detailBlend.clamp(0, 1)

  if (textures.detailColorTexture != null) {
    const baseColorNode = createMsfsMaterialBaseColorNode(nodeMaterial)
    const detailColorNode = texture(textures.detailColorTexture, detailUv).rgb.mul(2)
    nodeMaterial.colorNode = vec4(
      mix(baseColorNode.rgb, baseColorNode.rgb.mul(detailColorNode), detailBlend),
      baseColorNode.a
    )
  }

  if (textures.detailMetalRoughAOTexture != null) {
    const detailOrmNode = texture(textures.detailMetalRoughAOTexture, detailUv)
    const detailAdjustNode = detailOrmNode.rgb.sub(0.5).mul(2).mul(detailBlend)

    nodeMaterial.roughnessNode = (
      nodeMaterial.roughnessNode != null ? nodeMaterial.roughnessNode : materialRoughness
    )
      .add(detailAdjustNode.g)
      .clamp(0, 1)

    nodeMaterial.metalnessNode = (
      nodeMaterial.metalnessNode != null ? nodeMaterial.metalnessNode : materialMetalness
    )
      .add(detailAdjustNode.b)
      .clamp(0, 1)

    nodeMaterial.aoNode = (
      nodeMaterial.aoNode != null ? nodeMaterial.aoNode : materialAO
    )
      .add(detailAdjustNode.r)
      .clamp(0, 1)
  }

  if (
    textures.detailNormalTexture != null &&
    material.normalMap != null &&
    material.normalScale != null &&
    material.normalMapType === TangentSpaceNormalMap
  ) {
    nodeMaterial.normalNode = createMsfsDetailNormalNode(
      material,
      detailUv,
      detailBlend,
      textures.detailNormalTexture,
      extension.detailNormalTexture?.scale ?? 1
    )
  }

  nodeMaterial.needsUpdate = true
  return nodeMaterial as unknown as MsfsMaterial
}

function createMsfsDetailNormalNode(
  material: MsfsMaterial,
  detailUv: any,
  detailBlend: ReturnType<typeof vertexColor>['a'],
  detailNormalTexture: Texture,
  detailNormalScale: number
) {
  const baseNormalNode = createMsfsBaseTangentNormalNode(material)
  if (baseNormalNode == null) {
    return null
  }

  const detailNormalRawXY = createMsfsDetailNormalXYNode(detailNormalTexture, detailUv)
  const detailNormalXY = detailNormalRawXY
    .mul(detailNormalScale)
    .mul(detailBlend)
  const detailNormalZ = createMsfsDetailNormalZNode(detailNormalTexture, detailUv, detailNormalRawXY)
  const combinedTangentNormal = vec3(
    baseNormalNode.xy.add(detailNormalXY),
    baseNormalNode.z.mul(detailNormalZ).max(0)
  ).normalize()

  return TBNViewMatrix.mul(combinedTangentNormal).normalize()
}

function createMsfsDetailNormalXYNode(
  detailNormalTexture: Texture,
  detailUv: any
) {
  if (detailNormalTexture.format === SIGNED_RED_GREEN_RGTC2_Format) {
    return texture(detailNormalTexture, detailUv).xy
  }

  if (detailNormalTexture.format === RGFormat) {
    return texture(detailNormalTexture, detailUv).xy.mul(2).sub(1)
  }

  return texture(detailNormalTexture, detailUv).xy.mul(2).sub(1)
}

function createMsfsDetailNormalZNode(
  detailNormalTexture: Texture,
  detailUv: any,
  detailNormalRawXY: any
) {
  if (usesMsfsCompressedRgNormalMap(detailNormalTexture.format)) {
    return detailNormalRawXY
      .dot(detailNormalRawXY)
      .oneMinus()
      .max(0)
      .sqrt()
  }

  return texture(detailNormalTexture, detailUv).z.mul(2).sub(1)
}

function createMsfsBaseTangentNormalNode(material: MsfsMaterial) {
  if (material.normalMap == null || material.normalScale == null) {
    return null
  }

  if (material.normalMap.format === SIGNED_RED_GREEN_RGTC2_Format) {
    const signedCompressedNormalRawXY = texture(material.normalMap).xy
    const signedCompressedNormalXY = signedCompressedNormalRawXY.mul(material.normalScale as never)

    return vec3(
      signedCompressedNormalXY,
      signedCompressedNormalRawXY
        .dot(signedCompressedNormalRawXY)
        .oneMinus()
        .max(0)
        .sqrt()
    )
  }

  if (material.normalMap.format === RED_GREEN_RGTC2_Format) {
    const compressedNormalRawXY = texture(material.normalMap)
      .xy
      .mul(2)
      .sub(1)
    const compressedNormalXY = compressedNormalRawXY.mul(material.normalScale as never)

    return vec3(
      compressedNormalXY,
      compressedNormalRawXY
        .dot(compressedNormalRawXY)
        .oneMinus()
        .max(0)
        .sqrt()
    )
  }

  if (material.normalMap.format === RGFormat) {
    const decodedNormalRawXY = texture(material.normalMap)
      .xy
      .mul(2)
      .sub(1)
    const decodedNormalXY = decodedNormalRawXY.mul(material.normalScale as never)

    return vec3(
      decodedNormalXY,
      decodedNormalRawXY
        .dot(decodedNormalRawXY)
        .oneMinus()
        .max(0)
        .sqrt()
    )
  }

  const tangentNormal = texture(material.normalMap)
    .xyz
    .mul(2)
    .sub(1)

  return vec3(
    tangentNormal.xy.mul(material.normalScale as never),
    tangentNormal.z
  )
}

function createMsfsCompressedRgNormalNode(material: MsfsMaterial) {
  if (
    material.normalMap == null ||
    material.normalScale == null ||
    !usesMsfsCompressedRgNormalMap(material.normalMap.format)
  ) {
    return null
  }

  const tangentNormal = createMsfsBaseTangentNormalNode(material)
  if (tangentNormal == null) {
    return null
  }

  return TBNViewMatrix.mul(tangentNormal).normalize()
}

function ensureNodeMaterial(
  material: MsfsMaterial,
  createNodeMaterial: NodeMaterialFactory
): MsfsNodeMaterial | null {
  if ((material as MsfsNodeMaterial).isNodeMaterial === true) {
    return material as MsfsNodeMaterial
  }

  return createNodeMaterial(material) as MsfsNodeMaterial | null
}

export function getMsfsBlendFactors(
  material: Material | MsfsMaterial | null | undefined
): MsfsBlendFactors {
  const extension = getMsfsExtensions(material)?.ASOBO_material_blend_gbuffer
  return {
    baseColor: clampBlendFactor(extension?.baseColorBlendFactor),
    metallic: clampBlendFactor(
      extension?.metallicBlendFactor ?? extension?.metallnesBlendFactor
    ),
    roughness: clampBlendFactor(extension?.roughnessBlendFactor),
    normal: clampBlendFactor(extension?.normalBlendFactor),
    emissive: clampBlendFactor(extension?.emissiveBlendFactor),
    occlusion: clampBlendFactor(extension?.occlusionBlendFactor),
  }
}

function clampBlendFactor(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 1
  }

  return Math.min(Math.max(value, 0), 1)
}

async function loadMsfsDetailTextures(
  parser: GltfParserLike,
  textureCache: Map<number, Promise<Texture>>,
  extension: MsfsDetailMapExtension
): Promise<LoadedMsfsDetailTextures> {
  const [
    detailColorTexture,
    detailNormalTexture,
    detailMetalRoughAOTexture,
    blendMaskTexture
  ] = await Promise.all([
    loadMsfsTextureRef(
      parser,
      textureCache,
      extension.detailColorTexture,
      LinearSRGBColorSpace
    ),
    loadMsfsTextureRef(
      parser,
      textureCache,
      extension.detailNormalTexture,
      NoColorSpace
    ),
    loadMsfsTextureRef(
      parser,
      textureCache,
      extension.detailMetalRoughAOTexture,
      NoColorSpace
    ),
    loadMsfsTextureRef(
      parser,
      textureCache,
      extension.blendMaskTexture,
      NoColorSpace
    )
  ])

  return {
    detailColorTexture,
    detailNormalTexture,
    detailMetalRoughAOTexture,
    blendMaskTexture,
  }
}

async function loadMsfsTextureRef(
  parser: GltfParserLike,
  textureCache: Map<number, Promise<Texture>>,
  textureRef: GltfTextureRef | undefined,
  colorSpace: string
): Promise<Texture | null> {
  if (textureRef == null) {
    return null
  }

  let pendingTexture = textureCache.get(textureRef.index)
  if (pendingTexture == null) {
    pendingTexture = parser.getDependency('texture', textureRef.index)
    textureCache.set(textureRef.index, pendingTexture)
  }

  const texture = await withOptionalMsfsTextureTimeout(
    pendingTexture,
    MSFS_DETAIL_TEXTURE_LOAD_TIMEOUT_MS
  )
  if (texture == null) {
    return null
  }

  if (texture.colorSpace !== colorSpace) {
    texture.colorSpace = colorSpace
    texture.needsUpdate = true
  }

  return texture
}

async function withOptionalMsfsTextureTimeout(
  texturePromise: Promise<Texture>,
  timeoutMs: number
): Promise<Texture | null> {
  let timeoutId: number | null = null
  const timeoutPromise = new Promise<null>(resolve => {
    timeoutId = window.setTimeout(() => resolve(null), timeoutMs)
  })

  try {
    return await Promise.race([texturePromise, timeoutPromise])
  } catch {
    return null
  } finally {
    if (timeoutId != null) {
      window.clearTimeout(timeoutId)
    }
  }
}

function applyMsfsDetailMapShader(
  material: MsfsMaterial,
  extension: MsfsDetailMapExtension,
  textures: LoadedMsfsDetailTextures
): void {
  const hasDetailColorTexture = textures.detailColorTexture != null
  const hasDetailOrmTexture = textures.detailMetalRoughAOTexture != null
  const hasDetailNormalTexture =
    textures.detailNormalTexture != null &&
    material.normalMap != null

  if (!hasDetailColorTexture && !hasDetailOrmTexture && !hasDetailNormalTexture) {
    return
  }

  const hasBlendMaskTexture = textures.blendMaskTexture != null
  const uvScale = extension.UVScale ?? 1
  const uvOffset = extension.UVOffset ?? [0, 0]
  const detailNormalScale = extension.detailNormalTexture?.scale ?? 1
  const detailNormalShaderMode = getCompressedRgNormalShaderMode(textures.detailNormalTexture?.format)

  registerShaderPatch(
    material,
    createMsfsDetailMapCacheKey(
      uvScale,
      uvOffset,
      detailNormalScale,
      detailNormalShaderMode,
      hasDetailColorTexture,
      hasDetailOrmTexture,
      hasDetailNormalTexture,
      hasBlendMaskTexture
    ),
    shader => {
      injectMsfsDetailMapVertexShader(shader, uvScale, uvOffset)
      injectMsfsDetailMapFragmentShaderDeclarations(
        shader,
        hasDetailColorTexture,
        hasDetailOrmTexture,
        hasDetailNormalTexture,
        hasBlendMaskTexture
      )
      assignMsfsDetailMapUniforms(shader, textures)

      if (hasDetailColorTexture) {
        shader.fragmentShader = shader.fragmentShader.replace(
          RESOLVED_COLOR_FRAGMENT_CHUNK,
          createMsfsDetailColorFragmentChunk()
        )
      }

      if (hasDetailOrmTexture) {
        shader.fragmentShader = shader.fragmentShader.replace(
          RESOLVED_ROUGHNESSMAP_FRAGMENT_CHUNK,
          createMsfsDetailRoughnessFragmentChunk()
        )
        shader.fragmentShader = shader.fragmentShader.replace(
          RESOLVED_METALNESSMAP_FRAGMENT_CHUNK,
          createMsfsDetailMetalnessFragmentChunk()
        )
        shader.fragmentShader = shader.fragmentShader.replace(
          RESOLVED_AOMAP_FRAGMENT_CHUNK,
          createMsfsDetailAoFragmentChunk()
        )
      }

      if (hasDetailNormalTexture) {
        shader.fragmentShader = shader.fragmentShader.replace(
          'normal = normalize( tbn * mapN );',
          createMsfsDetailNormalFragmentSnippet(detailNormalScale, detailNormalShaderMode)
        )
      }
    }
  )
}

function injectMsfsDetailMapVertexShader(
  shader: Shader,
  uvScale: number,
  uvOffset: readonly [number, number]
): void {
  shader.vertexShader = shader.vertexShader.replace(
    'void main() {',
    [
      '#ifdef USE_UV',
      'varying vec2 vMsfsDetailUv;',
      '#endif',
      '',
      'void main() {',
      '',
      '\t#ifdef USE_UV',
      '\tvMsfsDetailUv = vec2( 0.0 );',
      '\t#endif',
    ].join('\n')
  )

  shader.vertexShader = shader.vertexShader.replace(
    'vUv = vec3( uv, 1 ).xy;',
    [
      'vUv = vec3( uv, 1 ).xy;',
      `\tvMsfsDetailUv = uv * vec2( ${formatGlslFloat(uvScale)}, ${formatGlslFloat(uvScale)} ) + vec2( ${formatGlslFloat(uvOffset[0])}, ${formatGlslFloat(uvOffset[1])} );`,
    ].join('\n')
  )
}

function injectMsfsDetailMapFragmentShaderDeclarations(
  shader: Shader,
  hasDetailColorTexture: boolean,
  hasDetailOrmTexture: boolean,
  hasDetailNormalTexture: boolean,
  hasBlendMaskTexture: boolean
): void {
  const declarations = [
    '#ifdef USE_UV',
    'varying vec2 vMsfsDetailUv;',
    '',
    hasDetailColorTexture ? 'uniform sampler2D msfsDetailColorTexture;' : '',
    hasDetailOrmTexture ? 'uniform sampler2D msfsDetailMetalRoughAOTexture;' : '',
    hasDetailNormalTexture ? 'uniform sampler2D msfsDetailNormalTexture;' : '',
    hasBlendMaskTexture ? 'uniform sampler2D msfsDetailBlendMaskTexture;' : '',
    '',
    'float getMsfsDetailBlend() {',
    '\tfloat msfsDetailBlend = 1.0;',
    '',
    '\t#if defined( USE_COLOR_ALPHA )',
    '\t\tmsfsDetailBlend *= vColor.a;',
    '\t#endif',
    '',
    hasBlendMaskTexture
      ? '\tmsfsDetailBlend *= texture2D( msfsDetailBlendMaskTexture, vMsfsDetailUv ).r;'
      : '',
    '',
    '\treturn clamp( msfsDetailBlend, 0.0, 1.0 );',
    '}',
    '#endif',
    '',
  ]
    .filter(Boolean)
    .join('\n')

  shader.fragmentShader = shader.fragmentShader.replace(
    'void main() {',
    `${declarations}\nvoid main() {`
  )
}

function assignMsfsDetailMapUniforms(
  shader: Shader,
  textures: LoadedMsfsDetailTextures
): void {
  if (textures.detailColorTexture != null) {
    shader.uniforms.msfsDetailColorTexture = { value: textures.detailColorTexture }
  }

  if (textures.detailMetalRoughAOTexture != null) {
    shader.uniforms.msfsDetailMetalRoughAOTexture = {
      value: textures.detailMetalRoughAOTexture,
    }
  }

  if (textures.detailNormalTexture != null) {
    shader.uniforms.msfsDetailNormalTexture = { value: textures.detailNormalTexture }
  }

  if (textures.blendMaskTexture != null) {
    shader.uniforms.msfsDetailBlendMaskTexture = { value: textures.blendMaskTexture }
  }
}

function createMsfsDetailColorFragmentChunk(): string {
  return [
    RESOLVED_COLOR_FRAGMENT_CHUNK,
    '',
    '#ifdef USE_UV',
    '\tvec3 msfsDetailColor = texture2D( msfsDetailColorTexture, vMsfsDetailUv ).rgb * 2.0;',
    '\tdiffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * msfsDetailColor, getMsfsDetailBlend() );',
    '#endif',
  ].join('\n')
}

function createMsfsDetailRoughnessFragmentChunk(): string {
  return [
    RESOLVED_ROUGHNESSMAP_FRAGMENT_CHUNK,
    '',
    '#ifdef USE_UV',
    '\tvec4 msfsDetailOrm = texture2D( msfsDetailMetalRoughAOTexture, vMsfsDetailUv );',
    '\troughnessFactor = clamp( roughnessFactor + ( msfsDetailOrm.g - 0.5 ) * 2.0 * getMsfsDetailBlend(), 0.0, 1.0 );',
    '#endif',
  ].join('\n')
}

function createMsfsDetailMetalnessFragmentChunk(): string {
  return [
    RESOLVED_METALNESSMAP_FRAGMENT_CHUNK,
    '',
    '#ifdef USE_UV',
    '\tvec4 msfsDetailOrm = texture2D( msfsDetailMetalRoughAOTexture, vMsfsDetailUv );',
    '\tmetalnessFactor = clamp( metalnessFactor + ( msfsDetailOrm.b - 0.5 ) * 2.0 * getMsfsDetailBlend(), 0.0, 1.0 );',
    '#endif',
  ].join('\n')
}

function createMsfsDetailAoFragmentChunk(): string {
  return [
    'float ambientOcclusion = 1.0;',
    '',
    '#ifdef USE_AOMAP',
    '\t// reads channel R, compatible with a combined OcclusionRoughnessMetallic (RGB) texture',
    '\tambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;',
    '#endif',
    '',
    '#ifdef USE_UV',
    '\tvec4 msfsDetailOrm = texture2D( msfsDetailMetalRoughAOTexture, vMsfsDetailUv );',
    '\tambientOcclusion = clamp( ambientOcclusion + ( msfsDetailOrm.r - 0.5 ) * 2.0 * getMsfsDetailBlend(), 0.0, 1.0 );',
    '#endif',
    '',
    'reflectedLight.indirectDiffuse *= ambientOcclusion;',
    '',
    '#if defined( USE_CLEARCOAT )',
    '\tclearcoatSpecularIndirect *= ambientOcclusion;',
    '#endif',
    '',
    '#if defined( USE_SHEEN )',
    '\tsheenSpecularIndirect *= ambientOcclusion;',
    '#endif',
    '',
    '#if defined( USE_ENVMAP ) && defined( STANDARD )',
    '\tfloat dotNV = saturate( dot( geometryNormal, geometryViewDir ) );',
    '\treflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );',
    '#endif',
  ].join('\n')
}

function createMsfsDetailNormalFragmentSnippet(
  detailNormalScale: number,
  shaderMode: 'signed-rg' | 'unsigned-rg' | 'rgb'
): string {
  const decodeDetailNormal =
    shaderMode === 'signed-rg'
      ? [
          '\tvec2 msfsDetailRawMapNxy = texture2D( msfsDetailNormalTexture, vMsfsDetailUv ).xy;',
          '\tvec2 msfsDetailMapNxy = msfsDetailRawMapNxy;',
          `\tmsfsDetailMapNxy *= ${formatGlslFloat(detailNormalScale)} * getMsfsDetailBlend();`,
          '\tfloat msfsDetailMapNz = sqrt( max( 1.0 - dot( msfsDetailRawMapNxy, msfsDetailRawMapNxy ), 0.0 ) );',
        ]
      : shaderMode === 'unsigned-rg'
        ? [
            '\tvec2 msfsDetailRawMapNxy = texture2D( msfsDetailNormalTexture, vMsfsDetailUv ).xy * 2.0 - 1.0;',
            '\tvec2 msfsDetailMapNxy = msfsDetailRawMapNxy;',
            `\tmsfsDetailMapNxy *= ${formatGlslFloat(detailNormalScale)} * getMsfsDetailBlend();`,
            '\tfloat msfsDetailMapNz = sqrt( max( 1.0 - dot( msfsDetailRawMapNxy, msfsDetailRawMapNxy ), 0.0 ) );',
          ]
        : [
            '\tvec3 msfsDetailMapN = texture2D( msfsDetailNormalTexture, vMsfsDetailUv ).xyz * 2.0 - 1.0;',
            `\tmsfsDetailMapN.xy *= ${formatGlslFloat(detailNormalScale)} * getMsfsDetailBlend();`,
            '\tvec2 msfsDetailMapNxy = msfsDetailMapN.xy;',
            '\tfloat msfsDetailMapNz = msfsDetailMapN.z;',
          ]

  return [
    '#ifdef USE_UV',
    ...decodeDetailNormal,
    '\tmapN = normalize( vec3( mapN.xy + msfsDetailMapNxy, max( mapN.z * msfsDetailMapNz, 0.0 ) ) );',
    '#endif',
    '\tnormal = normalize( tbn * mapN );',
  ].join('\n')
}

function createMsfsDetailMapCacheKey(
  uvScale: number,
  uvOffset: readonly [number, number],
  detailNormalScale: number,
  detailNormalShaderMode: 'signed-rg' | 'unsigned-rg' | 'rgb',
  hasDetailColorTexture: boolean,
  hasDetailOrmTexture: boolean,
  hasDetailNormalTexture: boolean,
  hasBlendMaskTexture: boolean
): string {
  return [
    'msfs-detail',
    `scale:${uvScale}`,
    `offset:${uvOffset[0]},${uvOffset[1]}`,
    `normalScale:${detailNormalScale}`,
    `normalMode:${detailNormalShaderMode}`,
    `color:${hasDetailColorTexture}`,
    `orm:${hasDetailOrmTexture}`,
    `normal:${hasDetailNormalTexture}`,
    `mask:${hasBlendMaskTexture}`,
  ].join('|')
}

function getCompressedRgNormalShaderMode(
  format: number | undefined
): 'signed-rg' | 'unsigned-rg' | 'rgb' {
  if (format === SIGNED_RED_GREEN_RGTC2_Format) {
    return 'signed-rg'
  }

  if (format === RED_GREEN_RGTC2_Format || format === RGFormat) {
    return 'unsigned-rg'
  }

  return 'rgb'
}

function registerShaderPatch(
  material: MsfsMaterial,
  patchKey: string,
  patch: (shader: Shader) => void
): void {
  const previousOnBeforeCompile = material.onBeforeCompile
  const previousCustomProgramCacheKey = material.customProgramCacheKey

  material.onBeforeCompile = shader => {
    previousOnBeforeCompile?.call(material, shader)
    patch(shader)
  }

  material.customProgramCacheKey = () => {
    const previousKey = previousCustomProgramCacheKey?.call(material) ?? ''
    return `${previousKey}|${patchKey}`
  }

  material.needsUpdate = true
}

function formatGlslFloat(value: number): string {
  if (Number.isInteger(value)) {
    return `${value}.0`
  }

  return `${value}`
}
