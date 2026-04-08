import { Mesh } from 'three'
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
    if (!Number.isInteger(baseVertexIndex) || baseVertexIndex == null) {
      return
    }

    let minIndex = Number.POSITIVE_INFINITY
    let maxIndex = Number.NEGATIVE_INFINITY
    for (let offset = 0; offset < index.count; offset += 1) {
      const value = index.getX(offset)
      minIndex = Math.min(minIndex, value)
      maxIndex = Math.max(maxIndex, value)
    }

    if (
      !Number.isFinite(minIndex) ||
      !Number.isFinite(maxIndex) ||
      maxIndex < position.count ||
      minIndex < baseVertexIndex ||
      maxIndex - baseVertexIndex >= position.count
    ) {
      return
    }

    for (let offset = 0; offset < index.count; offset += 1) {
      index.setX(offset, index.getX(offset) - baseVertexIndex)
    }

    index.needsUpdate = true
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    adjustedGeometries.add(geometry)
  })
}
