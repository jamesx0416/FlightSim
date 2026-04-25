import { BufferAttribute, Mesh } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

type GltfAssociation = {
  readonly meshes?: number
  readonly primitives?: number
}

type GltfPrimitiveDef = {
  readonly extras?: {
    readonly ASOBO_primitive?: {
      readonly BaseVertexIndex?: number
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

export function normalizeAsoboPrimitiveBaseVertex(gltf: GLTF): void {
  const parser = (gltf as GLTF & { parser?: GltfParserLike }).parser
  if (parser == null) {
    return
  }

  const adjustedGeometries = new WeakSet<object>()

  gltf.scene.traverse(object => {
    if (!(object instanceof Mesh)) {
      return
    }

    const geometry = object.geometry
    if (geometry == null || adjustedGeometries.has(geometry)) {
      return
    }

    const index = geometry.getIndex()
    const position = geometry.getAttribute('position')
    if (index == null || position == null) {
      return
    }

    const association = parser.associations.get(object)
    if (association?.meshes == null || association.primitives == null) {
      return
    }

    const primitiveDef =
      parser.json.meshes?.[association.meshes]?.primitives?.[association.primitives]
    const baseVertexIndex = primitiveDef?.extras?.ASOBO_primitive?.BaseVertexIndex
    if (
      !Number.isInteger(baseVertexIndex) ||
      baseVertexIndex == null ||
      baseVertexIndex === 0
    ) {
      return
    }

    const indexArray = index.array
    let minIndex = Number.POSITIVE_INFINITY
    let maxIndex = Number.NEGATIVE_INFINITY
    for (let offset = 0; offset < indexArray.length; offset += 1) {
      const value = indexArray[offset]!
      minIndex = Math.min(minIndex, value)
      maxIndex = Math.max(maxIndex, value)
    }

    if (!Number.isFinite(minIndex) || !Number.isFinite(maxIndex)) {
      return
    }

    const indicesArePrimitiveLocal =
      minIndex < baseVertexIndex && maxIndex + baseVertexIndex < position.count
    const indicesAlreadySharedAbsolute =
      maxIndex < position.count
    const indicesNeedRebasing =
      minIndex >= baseVertexIndex && maxIndex - baseVertexIndex < position.count

    if (indicesArePrimitiveLocal) {
      const nextIndexArray = new Uint32Array(indexArray.length)
      for (let offset = 0; offset < indexArray.length; offset += 1) {
        nextIndexArray[offset] = indexArray[offset]! + baseVertexIndex
      }
      geometry.setIndex(new BufferAttribute(nextIndexArray, 1))
    } else if (indicesNeedRebasing && !indicesAlreadySharedAbsolute) {
      for (let offset = 0; offset < indexArray.length; offset += 1) {
        indexArray[offset] = indexArray[offset]! - baseVertexIndex
      }

      index.needsUpdate = true
    } else {
      return
    }

    adjustedGeometries.add(geometry)
  })
}
