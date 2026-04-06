import {
  DoubleSide,
  Material,
  Mesh,
  Object3D,
  RED_GREEN_RGTC2_Format,
  RGB_S3TC_DXT1_Format,
  RGBA_S3TC_DXT1_Format,
  SIGNED_RED_GREEN_RGTC2_Format,
  type Shader
} from 'three'

type MsfsMaterial = Material & {
  map?: {
    format?: number
    needsUpdate?: boolean
  } | null
  normalMap?: {
    format?: number
    needsUpdate?: boolean
  } | null
  normalScale?: {
    x: number
    y: number
    set(x: number, y: number): void
  } | null
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
  }
}

export function normalizeMsfsMaterials(root: Object3D): void {
  const materials = new Set<MsfsMaterial>()

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

    if (meshMaterials.some(material => usesBlendGBuffer(material))) {
      object.renderOrder = Math.max(object.renderOrder, 10)
    }
  })

  for (const material of materials) {
    normalizeMsfsMaterial(material)
  }
}

function normalizeMsfsMaterial(material: MsfsMaterial): void {
  // MSFS exports DirectX-convention normal maps, while stock glTF assumes OpenGL.
  if (material.normalMap != null && material.normalScale != null) {
    material.normalScale.set(material.normalScale.x, -Math.abs(material.normalScale.y))
    material.normalMap.needsUpdate = true
    material.needsUpdate = true
  }

  if (material.normalMap != null && usesMsfsCompressedRgNormalMap(material.normalMap.format)) {
    patchCompressedRgNormalMapShader(material, material.normalMap.format)
  }

  // Some MSFS blend/decal albedo textures use BC1/DXT1 1-bit alpha. Reinterpret
  // those transparent materials as RGBA DXT1 so the alpha channel is preserved.
  if (
    material.transparent === true &&
    material.map != null &&
    material.map.format === RGB_S3TC_DXT1_Format
  ) {
    material.map.format = RGBA_S3TC_DXT1_Format
    material.map.needsUpdate = true
    material.needsUpdate = true
  }

  if (usesBlendGBuffer(material)) {
    material.depthWrite = false
    material.alphaTest = 0.02
    material.polygonOffset = true
    material.polygonOffsetFactor = -1
    material.polygonOffsetUnits = -1
    material.premultipliedAlpha = false
    material.side = DoubleSide
    material.needsUpdate = true
  }
}

function usesBlendGBuffer(material: Material | MsfsMaterial | null | undefined): boolean {
  return (
    material?.userData?.gltfExtensions != null &&
    'ASOBO_material_blend_gbuffer' in material.userData.gltfExtensions
  )
}

function usesInvisibleMaterial(material: Material | MsfsMaterial | null | undefined): boolean {
  return (
    material?.userData?.gltfExtensions != null &&
    'ASOBO_material_invisible' in material.userData.gltfExtensions
  )
}

function usesMsfsCompressedRgNormalMap(format: number | undefined): boolean {
  return (
    format === RED_GREEN_RGTC2_Format ||
    format === SIGNED_RED_GREEN_RGTC2_Format
  )
}

function patchCompressedRgNormalMapShader(material: MsfsMaterial, format: number): void {
  const shaderMode = format === SIGNED_RED_GREEN_RGTC2_Format ? 'signed-rg' : 'unsigned-rg'
  const previousOnBeforeCompile = material.onBeforeCompile
  const previousCustomProgramCacheKey = material.customProgramCacheKey

  material.onBeforeCompile = shader => {
    previousOnBeforeCompile?.call(material, shader)

    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
      createCompressedRgNormalMapShaderSnippet(shaderMode)
    )
  }

  material.customProgramCacheKey = () => {
    const previousKey = previousCustomProgramCacheKey?.call(material) ?? ''
    return `${previousKey}|msfs-normal:${shaderMode}`
  }

  material.needsUpdate = true
}

function createCompressedRgNormalMapShaderSnippet(shaderMode: 'signed-rg' | 'unsigned-rg'): string {
  const decodeRg =
    shaderMode === 'signed-rg'
      ? 'vec2 mapNxy = texture2D( normalMap, vNormalMapUv ).xy;'
      : 'vec2 mapNxy = texture2D( normalMap, vNormalMapUv ).xy * 2.0 - 1.0;'

  return [
    decodeRg,
    'mapNxy *= normalScale;',
    'float mapNz = sqrt( max( 1.0 - dot( mapNxy, mapNxy ), 0.0 ) );',
    'vec3 mapN = vec3( mapNxy, mapNz );'
  ].join('\n\t')
}
