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
    if (!usesAsoboOptimizedTrianglePrimitive(primitiveDef)) {
      return
    }

    const index = geometry.getIndex()
    if (index == null) {
      return
    }

    for (let offset = 0; offset < index.count; offset += 3) {
      const first = index.getX(offset)
      const third = index.getX(offset + 2)
      index.setX(offset, third)
      index.setX(offset + 2, first)
    }

    index.needsUpdate = true
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    flippedGeometries.add(geometry)
  })
}

function usesAsoboOptimizedTrianglePrimitive(
  primitiveDef: GltfPrimitiveDef | undefined
): boolean {
  if (primitiveDef == null) {
    return false
  }

  const asoboPrimitive = primitiveDef.extras?.ASOBO_primitive
  if (asoboPrimitive?.VertexType !== 'VTX') {
    return false
  }

  return (primitiveDef.mode ?? GLTF_MODE_TRIANGLES) === GLTF_MODE_TRIANGLES
}
