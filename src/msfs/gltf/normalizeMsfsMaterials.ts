import {
  DoubleSide,
  LinearSRGBColorSpace,
  Material,
  Mesh,
  NoColorSpace,
  Object3D,
  RGFormat,
  RED_GREEN_RGTC2_Format,
  RGB_S3TC_DXT1_Format,
  RGBA_S3TC_DXT1_Format,
  SIGNED_RED_GREEN_RGTC2_Format,
  TangentSpaceNormalMap,
  Texture,
  type Shader
} from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  TBNViewMatrix,
  materialAO,
  materialColor,
  materialMetalness,
  materialEmissive,
  materialOpacity,
  materialRoughness,
  mix,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
  vertexColor,
} from 'three/tsl'
import type { NodeMaterial } from 'three/webgpu'
import type { NodeMaterialFactory } from '../../rendering/createAppRenderer'

type MsfsMaterial = Material & {
  map?: {
    format?: number
    needsUpdate?: boolean
  } | null
  metalness?: number
  normalMap?: {
    format?: number
    needsUpdate?: boolean
  } | null
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
  alphaTest?: number
  depthWrite?: boolean
  polygonOffset?: boolean
  polygonOffsetFactor?: number
  polygonOffsetUnits?: number
  premultipliedAlpha?: boolean
  side?: number
  onBeforeCompile?: (shader: Shader) => void
  customProgramCacheKey?: () => string
  needsUpdate?: boolean
  userData?: {
    readonly gltfExtensions?: Record<string, unknown>
    msfsMaterialCode?: string
    msfsBaseOpacity?: number
  }
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
}

type GltfMaterialDef = {
  readonly extensions?: MsfsMaterialExtensions
  readonly extras?: {
    readonly ASOBO_material_code?: string
  }
}

type GltfParserLike = {
  readonly associations: Map<object, GltfAssociation>
  readonly json: {
    readonly materials?: readonly GltfMaterialDef[]
  }
  getDependency(type: 'texture', index: number): Promise<Texture>
}

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

export type MsfsBlendFactors = {
  readonly baseColor: number
  readonly metallic: number
  readonly roughness: number
  readonly normal: number
  readonly emissive: number
  readonly occlusion: number
}

type MsfsNodeMaterial = MsfsMaterial & NodeMaterial

const MSFS_BLEND_GBUFFER_RENDER_ORDER_BASE = 10
const MSFS_BLEND_GBUFFER_POLYGON_OFFSET_BASE = -1

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

export async function normalizeMsfsMaterials(
  gltf: GLTF,
  options: MsfsMaterialNormalizationOptions = {}
): Promise<void> {
  const root = gltf.scene
  const parser = (gltf as GLTF & { parser?: GltfParserLike }).parser
  const materials = new Set<MsfsMaterial>()
  const materialReplacements = new Map<MsfsMaterial, MsfsMaterial>()
  const textureCache = new Map<number, Promise<Texture>>()

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

    const drawOrderOffset = Math.max(
      0,
      ...meshMaterials.map(material => getMsfsDrawOrderOffset(material))
    )
    if (
      drawOrderOffset > 0 ||
      meshMaterials.some(material => usesBlendGBufferMaterial(material))
    ) {
      object.renderOrder = Math.max(
        object.renderOrder,
        MSFS_BLEND_GBUFFER_RENDER_ORDER_BASE + drawOrderOffset
      )
    }
  })

  for (const material of materials) {
    const normalizedMaterial = await normalizeMsfsMaterial(
      material,
      parser,
      textureCache,
      parser?.associations.get(material)?.materials,
      options
    )
    materialReplacements.set(material, normalizedMaterial)
  }

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

async function normalizeMsfsMaterial(
  material: MsfsMaterial,
  parser: GltfParserLike | undefined,
  textureCache: Map<number, Promise<Texture>>,
  materialIndex: number | undefined,
  options: MsfsMaterialNormalizationOptions
): Promise<MsfsMaterial> {
  let outputMaterial = material
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
    outputMaterial.normalScale.set(
      outputMaterial.normalScale.x * blendFactors.normal,
      -Math.abs(outputMaterial.normalScale.y) * blendFactors.normal
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

  if (usesBlendGBufferMaterial(outputMaterial)) {
    outputMaterial.depthWrite = false
    outputMaterial.alphaTest = 0.02
    outputMaterial.polygonOffset = true
    outputMaterial.polygonOffsetFactor =
      MSFS_BLEND_GBUFFER_POLYGON_OFFSET_BASE - getMsfsDrawOrderOffset(outputMaterial)
    outputMaterial.polygonOffsetUnits =
      MSFS_BLEND_GBUFFER_POLYGON_OFFSET_BASE - getMsfsDrawOrderOffset(outputMaterial)
    outputMaterial.premultipliedAlpha = false
    outputMaterial.side = DoubleSide
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

  return outputMaterial
}

export function usesBlendGBufferMaterial(
  material: Material | MsfsMaterial | null | undefined
): boolean {
  return getMsfsExtensions(material)?.ASOBO_material_blend_gbuffer != null
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
    const baseColorNode = nodeMaterial.colorNode != null
      ? vec4(nodeMaterial.colorNode)
      : materialColor
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
  detailUv: ReturnType<typeof uv>,
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
  detailUv: ReturnType<typeof uv>
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
  detailUv: ReturnType<typeof uv>,
  detailNormalRawXY: ReturnType<typeof vec2>
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
    const signedCompressedNormalXY = signedCompressedNormalRawXY.mul(material.normalScale)

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
    const compressedNormalXY = compressedNormalRawXY.mul(material.normalScale)

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
    const decodedNormalXY = decodedNormalRawXY.mul(material.normalScale)

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
    tangentNormal.xy.mul(material.normalScale),
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
  const detailColorTexture = await loadMsfsTextureRef(
    parser,
    textureCache,
    extension.detailColorTexture,
    LinearSRGBColorSpace
  )
  const detailNormalTexture = await loadMsfsTextureRef(
    parser,
    textureCache,
    extension.detailNormalTexture,
    NoColorSpace
  )
  const detailMetalRoughAOTexture = await loadMsfsTextureRef(
    parser,
    textureCache,
    extension.detailMetalRoughAOTexture,
    NoColorSpace
  )
  const blendMaskTexture = await loadMsfsTextureRef(
    parser,
    textureCache,
    extension.blendMaskTexture,
    NoColorSpace
  )

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

  const texture = await pendingTexture
  if (texture.colorSpace !== colorSpace) {
    texture.colorSpace = colorSpace
    texture.needsUpdate = true
  }

  return texture
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
