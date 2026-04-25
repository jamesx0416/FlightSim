import { Mesh } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

type GltfAssociation = {
  readonly meshes?: number
  readonly primitives?: number
}

type GltfPrimitiveDef = {
  readonly mode?: number
  readonly extras?: {
    readonly ASOBO_primitive?: {
      readonly VertexType?: string
    }
  }
}

type GltfMeshDef = {
  readonly primitives?: readonly GltfPrimitiveDef[]
}

type GltfParserLike = {
  readonly associations: Map<object, GltfAssociation>
  readonly json: {
    readonly meshes?: readonly GltfMeshDef[]
  }
}

const GLTF_MODE_TRIANGLES = 4

export function normalizeAsoboPrimitiveWinding(gltf: GLTF): void {
  const parser = (gltf as GLTF & { parser?: GltfParserLike }).parser
  if (parser == null) {
    return
  }

  const flippedGeometries = new WeakSet<object>()

  gltf.scene.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const geometry = object.geometry
    if (geometry == null || flippedGeometries.has(geometry)) {
      return
    }

    const association = parser.associations.get(object)
    if (association?.meshes == null || association.primitives == null) {
      return
    }

    const primitiveDef =
      parser.json.meshes?.[association.meshes]?.primitives?.[association.primitives]
    if (!usesAsoboTrianglePrimitive(primitiveDef)) {
      return
    }

    const index = geometry.getIndex()
    if (index == null) {
      return
    }

    const indexArray = index.array
    for (let offset = 0; offset < indexArray.length; offset += 3) {
      const first = indexArray[offset]!
      indexArray[offset] = indexArray[offset + 2]!
      indexArray[offset + 2] = first
    }

    index.needsUpdate = true
    flippedGeometries.add(geometry)
  })
}

function usesAsoboTrianglePrimitive(
  primitiveDef: GltfPrimitiveDef | undefined
): boolean {
  if (primitiveDef == null) {
    return false
  }

  if (primitiveDef.extras?.ASOBO_primitive == null) {
    return false
  }

  return (primitiveDef.mode ?? GLTF_MODE_TRIANGLES) === GLTF_MODE_TRIANGLES
}
