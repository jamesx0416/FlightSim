import fs from 'node:fs'
import path from 'node:path'
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three'

const COMPONENT_ARRAYS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
}

const TYPE_SIZES = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
}

const MODELS = {
  a320: 'aircrafts/flybywire-aircraft-a320-neo/SimObjects/AirPlanes/FlyByWire_A320_NEO/model/A320_NEO_LOD00.gltf',
  a330: 'aircrafts/headwindsim-aircraft-a330-900/SimObjects/Airplanes/Headwind_A330neo/model/A330NEO_LOD00.gltf',
}

const A320_COMPARISONS = [
  { label: 'A320 FLAPS_02_LEFT METALFLAPS -> FLAPS_02_LEFT WINGS', mesh: 153, fromPrimitive: 2, toPrimitive: 0, animation: 'l_flap_percent_key' },
  { label: 'A320 FLAPS_02_LEFT RIBBONS -> FLAPS_02_LEFT WINGS', mesh: 153, fromPrimitive: 1, toPrimitive: 0, animation: 'l_flap_percent_key' },
  { label: 'A320 FLAPS_01_LEFT METALFLAPS -> FLAPS_01_LEFT WINGS', mesh: 154, fromPrimitive: 1, toPrimitive: 0, animation: 'l_flap_percent_key' },
  { label: 'A320 FLAPS_02_RIGHT METALFLAPS -> FLAPS_02_RIGHT WINGS', mesh: 193, fromPrimitive: 2, toPrimitive: 0, animation: 'r_flap_percent_key' },
  { label: 'A320 FLAPS_01_RIGHT METALFLAPS -> FLAPS_01_RIGHT WINGS', mesh: 206, fromPrimitive: 1, toPrimitive: 0, animation: 'r_flap_percent_key' },
]

const A320_SKINS = [2, 6, 8, 10, 14, 15, 25, 53, 65, 69, 73, 93]
const A330_SKINS = [3, 17, 18, 19]

function main() {
  for (const [key, modelPath] of Object.entries(MODELS)) {
    const model = loadModel(modelPath)
    console.log(`\n## ${key.toUpperCase()} ${modelPath}`)
    summarizeFlapMeshMaterials(model, key)
    summarizeBlendMeshes(model, key)
    summarizeSkinBindDeltas(model, key === 'a320' ? A320_SKINS : A330_SKINS)
  }

  const a320 = loadModel(MODELS.a320)
  console.log('\n## A320 decal-to-base geometry distances')
  for (const comparison of A320_COMPARISONS) {
    summarizePrimitiveDistance(a320, comparison, 'glTF inverse-bind rest pose', null, 'gltf')
    summarizePrimitiveDistance(a320, comparison, 'MSFS rest-pose bind', null, 'msfs')
    summarizePrimitiveDistance(a320, comparison, `glTF inverse-bind ${comparison.animation} endpoint`, comparison.animation, 'gltf')
    summarizePrimitiveDistance(a320, comparison, `MSFS rest-bind ${comparison.animation} endpoint`, comparison.animation, 'msfs')
    summarizeProjectedPrimitiveDistance(a320, comparison, `projected+receiver-skin ${comparison.animation} endpoint`, comparison.animation)
  }
}

function loadModel(gltfPath) {
  const json = JSON.parse(fs.readFileSync(gltfPath, 'utf8'))
  const baseDir = path.dirname(gltfPath)
  const buffers = json.buffers.map(buffer => {
    const raw = fs.readFileSync(path.join(baseDir, buffer.uri))
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  })
  return {
    path: gltfPath,
    json,
    buffers,
    worldMatrices: computeWorldMatrices(json),
  }
}

function summarizeFlapMeshMaterials(model, key) {
  const { json } = model
  const rows = []

  json.nodes?.forEach((node, nodeIndex) => {
    if (node.mesh == null) {
      return
    }

    const mesh = json.meshes[node.mesh]
    if (!/flap/i.test(`${node.name ?? ''} ${mesh?.name ?? ''}`)) {
      return
    }

    const materials = mesh?.primitives
      ?.map((primitive, primitiveIndex) => {
        const material = json.materials?.[primitive.material]
        const extensions = material?.extensions ?? {}
        const flags = [
          extensions.ASOBO_material_blend_gbuffer != null ? 'blend_gbuffer' : null,
          extensions.ASOBO_material_draw_order != null
            ? `drawOrder=${extensions.ASOBO_material_draw_order.drawOrderOffset}`
            : null,
        ].filter(Boolean)
        return `${primitiveIndex}:${material?.name ?? primitive.material}${flags.length ? ` [${flags.join(', ')}]` : ''}`
      })
      .join(', ')

    rows.push({
      node: nodeIndex,
      nodeName: node.name,
      mesh: node.mesh,
      meshName: mesh?.name,
      skin: node.skin,
      materials,
    })
  })

  console.log(`flap mesh material layout (${key}):`)
  console.table(rows)
}

function summarizeBlendMeshes(model, key) {
  const { json } = model
  const rows = []
  json.nodes?.forEach((node, nodeIndex) => {
    if (node.mesh == null) {
      return
    }

    const mesh = json.meshes[node.mesh]
    const blendMaterials = mesh?.primitives
      ?.map((primitive, primitiveIndex) => {
        const material = json.materials?.[primitive.material]
        if (material?.extensions?.ASOBO_material_blend_gbuffer == null) {
          return null
        }
        return `${primitiveIndex}:${material.name ?? primitive.material}`
      })
      .filter(Boolean)

    if (blendMaterials?.length) {
      rows.push({
        node: nodeIndex,
        nodeName: node.name,
        mesh: node.mesh,
        meshName: mesh?.name,
        skin: node.skin,
        blendMaterials: blendMaterials.join(', '),
      })
    }
  })

  console.log(`blend mesh nodes (${key}):`)
  console.table(rows.filter(row => /wing|flap|rivet|ribbon|livery/i.test(`${row.nodeName} ${row.meshName}`)).slice(0, 80))
}

function summarizeSkinBindDeltas(model, skinIndices) {
  const { json, worldMatrices } = model
  const rows = []

  for (const skinIndex of skinIndices) {
    const skin = json.skins?.[skinIndex]
    if (skin == null || skin.inverseBindMatrices == null) {
      continue
    }

    const inverseBindMatrices = getMatrices(model, skin.inverseBindMatrices)
    let maxAbsDelta = 0
    let maxJoint = null

    skin.joints.forEach((jointNodeIndex, jointIndex) => {
      const authoredInverseBind = inverseBindMatrices[jointIndex]
      const restInverse = worldMatrices[jointNodeIndex].clone().invert()
      const delta = maxMatrixAbsDelta(authoredInverseBind, restInverse)
      if (delta > maxAbsDelta) {
        maxAbsDelta = delta
        maxJoint = `${jointNodeIndex}:${json.nodes[jointNodeIndex]?.name}`
      }
    })

    rows.push({
      skin: skinIndex,
      joints: skin.joints.length,
      skeleton: skin.skeleton,
      maxAbsDelta: format(maxAbsDelta),
      maxJoint,
      inverseBindAccessor: skin.inverseBindMatrices,
    })
  }

  console.log('authored inverseBindMatrices vs node rest-pose inverse:')
  console.table(rows)
}

function summarizePrimitiveDistance(model, comparison, poseLabel, animationName = null, skinningMode = 'gltf') {
  const { json } = model
  const mesh = json.meshes[comparison.mesh]
  const fromPrimitive = mesh.primitives[comparison.fromPrimitive]
  const toPrimitive = mesh.primitives[comparison.toPrimitive]
  const poseWorldMatrices = animationName == null
    ? model.worldMatrices
    : sampleAnimationEndpointWorldMatrices(model, animationName)
  const nodeIndex = findNodeIndexForMesh(json, comparison.mesh)
  const fromPositions = getPrimitiveWorldPositions(model, nodeIndex, fromPrimitive, poseWorldMatrices, skinningMode)
  const fromNormals = getPrimitiveWorldNormals(model, nodeIndex, fromPrimitive, poseWorldMatrices, skinningMode)
  const toPositions = getPrimitiveWorldPositions(model, nodeIndex, toPrimitive, poseWorldMatrices, skinningMode)
  const toIndices = getIndexAccessor(model, toPrimitive.indices, toPositions.length)
  const triangles = []

  for (let index = 0; index + 2 < toIndices.length; index += 3) {
    const a = toPositions[toIndices[index]]
    const b = toPositions[toIndices[index + 1]]
    const c = toPositions[toIndices[index + 2]]
    const normal = new Vector3()
      .subVectors(b, a)
      .cross(new Vector3().subVectors(c, a))
    if (normal.lengthSq() < 1e-18) {
      continue
    }
    normal.normalize()
    triangles.push({ a, b, c, normal })
  }

  const distances = []
  const signedDistances = []
  const normalAngles = []
  const closest = new Vector3()

  for (let i = 0; i < fromPositions.length; i += 1) {
    const point = fromPositions[i]
    let bestDistanceSq = Infinity
    let bestTriangle = null
    let bestClosest = null

    for (const triangle of triangles) {
      closestPointToTriangle(point, triangle.a, triangle.b, triangle.c, closest)
      const distanceSq = closest.distanceToSquared(point)
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq
        bestTriangle = triangle
        bestClosest = closest.clone()
      }
    }

    if (bestTriangle == null || bestClosest == null) {
      continue
    }

    const delta = new Vector3().subVectors(point, bestClosest)
    const signedDistance = delta.dot(bestTriangle.normal)
    distances.push(Math.sqrt(bestDistanceSq))
    signedDistances.push(signedDistance)

    const fromNormal = fromNormals[i]
    if (fromNormal != null && fromNormal.lengthSq() > 0) {
      const dot = Math.max(-1, Math.min(1, Math.abs(fromNormal.clone().normalize().dot(bestTriangle.normal))))
      normalAngles.push(Math.acos(dot) * 180 / Math.PI)
    }
  }

  const fromMaterial = json.materials[fromPrimitive.material]?.name
  const toMaterial = json.materials[toPrimitive.material]?.name
  console.log(`${comparison.label} (${poseLabel})`)
  console.log({
    mesh: `${comparison.mesh}:${mesh.name}`,
    fromMaterial,
    toMaterial,
    skinningMode,
    fromVertices: fromPositions.length,
    toTriangles: triangles.length,
    distanceMeters: summarize(distances),
    signedDistanceMeters: summarize(signedDistances),
    normalAngleDegrees: summarize(normalAngles),
  })
}

function summarizeProjectedPrimitiveDistance(model, comparison, poseLabel, animationName) {
  const { json } = model
  const mesh = json.meshes[comparison.mesh]
  const fromPrimitive = mesh.primitives[comparison.fromPrimitive]
  const toPrimitive = mesh.primitives[comparison.toPrimitive]
  const nodeIndex = findNodeIndexForMesh(json, comparison.mesh)
  const projection = projectPrimitiveToReceiverSkin(model, nodeIndex, fromPrimitive, toPrimitive)
  const poseWorldMatrices = sampleAnimationEndpointWorldMatrices(model, animationName)
  const fromPositions = getProjectedPrimitiveWorldPositions(model, nodeIndex, projection, poseWorldMatrices)
  const toPositions = getPrimitiveWorldPositions(model, nodeIndex, toPrimitive, poseWorldMatrices, 'msfs')
  summarizePointCloudToPrimitive(model, comparison, poseLabel, fromPositions, [], toPositions)
}

function summarizePointCloudToPrimitive(model, comparison, poseLabel, fromPositions, fromNormals, toPositions) {
  const { json } = model
  const mesh = json.meshes[comparison.mesh]
  const toPrimitive = mesh.primitives[comparison.toPrimitive]
  const toIndices = getIndexAccessor(model, toPrimitive.indices, toPositions.length)
  const triangles = []

  for (let index = 0; index + 2 < toIndices.length; index += 3) {
    const a = toPositions[toIndices[index]]
    const b = toPositions[toIndices[index + 1]]
    const c = toPositions[toIndices[index + 2]]
    const normal = new Vector3()
      .subVectors(b, a)
      .cross(new Vector3().subVectors(c, a))
    if (normal.lengthSq() < 1e-18) {
      continue
    }
    normal.normalize()
    triangles.push({ a, b, c, normal })
  }

  const distances = []
  const signedDistances = []
  const normalAngles = []
  const closest = new Vector3()

  for (let i = 0; i < fromPositions.length; i += 1) {
    const point = fromPositions[i]
    let bestDistanceSq = Infinity
    let bestTriangle = null
    let bestClosest = null

    for (const triangle of triangles) {
      closestPointToTriangle(point, triangle.a, triangle.b, triangle.c, closest)
      const distanceSq = closest.distanceToSquared(point)
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq
        bestTriangle = triangle
        bestClosest = closest.clone()
      }
    }

    if (bestTriangle == null || bestClosest == null) {
      continue
    }

    const delta = new Vector3().subVectors(point, bestClosest)
    const signedDistance = delta.dot(bestTriangle.normal)
    distances.push(Math.sqrt(bestDistanceSq))
    signedDistances.push(signedDistance)

    const fromNormal = fromNormals[i]
    if (fromNormal != null && fromNormal.lengthSq() > 0) {
      const dot = Math.max(-1, Math.min(1, Math.abs(fromNormal.clone().normalize().dot(bestTriangle.normal))))
      normalAngles.push(Math.acos(dot) * 180 / Math.PI)
    }
  }

  const fromPrimitive = mesh.primitives[comparison.fromPrimitive]
  const fromMaterial = json.materials[fromPrimitive.material]?.name
  const toMaterial = json.materials[toPrimitive.material]?.name
  console.log(`${comparison.label} (${poseLabel})`)
  console.log({
    mesh: `${comparison.mesh}:${mesh.name}`,
    fromMaterial,
    toMaterial,
    skinningMode: 'projected-msfs',
    fromVertices: fromPositions.length,
    toTriangles: triangles.length,
    distanceMeters: summarize(distances),
    signedDistanceMeters: summarize(signedDistances),
    normalAngleDegrees: summarize(normalAngles),
  })
}

function findNodeIndexForMesh(json, meshIndex) {
  const nodeIndex = json.nodes.findIndex(node => node.mesh === meshIndex)
  if (nodeIndex < 0) {
    throw new Error(`No node found for mesh ${meshIndex}`)
  }
  return nodeIndex
}

function projectPrimitiveToReceiverSkin(model, nodeIndex, fromPrimitive, toPrimitive) {
  const receiverPositions = getPrimitiveWorldPositions(model, nodeIndex, toPrimitive, model.worldMatrices, 'msfs')
  const receiverIndices = getIndexAccessor(model, toPrimitive.indices, receiverPositions.length)
  const receiverJoints = getOptionalVec4Accessor(model, toPrimitive.attributes.JOINTS_0)
  const receiverWeights = getOptionalVec4Accessor(model, toPrimitive.attributes.WEIGHTS_0)
  const triangles = []

  for (let index = 0; index + 2 < receiverIndices.length; index += 3) {
    const aIndex = receiverIndices[index]
    const bIndex = receiverIndices[index + 1]
    const cIndex = receiverIndices[index + 2]
    const a = receiverPositions[aIndex]
    const b = receiverPositions[bIndex]
    const c = receiverPositions[cIndex]
    if (new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).lengthSq() < 1e-18) {
      continue
    }
    triangles.push({
      a,
      b,
      c,
      skinA: getVertexInfluences(receiverJoints, receiverWeights, aIndex),
      skinB: getVertexInfluences(receiverJoints, receiverWeights, bIndex),
      skinC: getVertexInfluences(receiverJoints, receiverWeights, cIndex),
    })
  }

  const fromPositions = getPrimitiveWorldPositions(model, nodeIndex, fromPrimitive, model.worldMatrices, 'msfs')
  const projected = []
  const closest = new Vector3()

  for (const point of fromPositions) {
    let bestDistanceSq = Infinity
    let bestTriangle = null
    let bestPoint = null

    for (const triangle of triangles) {
      closestPointToTriangle(point, triangle.a, triangle.b, triangle.c, closest)
      const distanceSq = closest.distanceToSquared(point)
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq
        bestTriangle = triangle
        bestPoint = closest.clone()
      }
    }

    if (bestTriangle == null || bestPoint == null) {
      projected.push({ position: point.clone(), influences: [] })
      continue
    }

    const barycentric = getBarycentric(bestPoint, bestTriangle.a, bestTriangle.b, bestTriangle.c)
    projected.push({
      position: bestPoint,
      influences: interpolateSkinInfluences(bestTriangle, barycentric),
    })
  }

  return projected
}

function getProjectedPrimitiveWorldPositions(model, nodeIndex, projectedVertices, worldMatrices) {
  const node = model.json.nodes[nodeIndex]
  const nodeWorld = worldMatrices[nodeIndex]
  const inverseNodeWorld = nodeWorld.clone().invert()
  const skin = node.skin != null ? model.json.skins[node.skin] : null
  if (skin == null) {
    return projectedVertices.map(vertex => vertex.position.clone())
  }

  const inverseBindMatrices = getSkinInverseBindMatrices(model, skin, 'msfs')
  const jointMatrices = skin.joints.map((jointNodeIndex, jointIndex) =>
    inverseNodeWorld
      .clone()
      .multiply(worldMatrices[jointNodeIndex])
      .multiply(inverseBindMatrices[jointIndex])
  )

  return projectedVertices.map(vertex => {
    const skinned = new Vector3()
    let weightSum = 0
    for (const influence of vertex.influences) {
      const jointMatrix = jointMatrices[influence.joint]
      if (jointMatrix == null || influence.weight <= 0) {
        continue
      }
      skinned.addScaledVector(vertex.position.clone().applyMatrix4(jointMatrix), influence.weight)
      weightSum += influence.weight
    }
    if (weightSum > 0 && Math.abs(weightSum - 1) > 1e-4) {
      skinned.multiplyScalar(1 / weightSum)
    }
    if (weightSum === 0) {
      skinned.copy(vertex.position)
    }
    return skinned.applyMatrix4(nodeWorld)
  })
}

function getPrimitiveWorldPositions(model, nodeIndex, primitive, worldMatrices, skinningMode = 'gltf') {
  const positions = getVec3Accessor(model, primitive.attributes.POSITION)
  const node = model.json.nodes[nodeIndex]
  const nodeWorld = worldMatrices[nodeIndex]
  const skin = node.skin != null ? model.json.skins[node.skin] : null
  if (
    skin == null ||
    primitive.attributes.JOINTS_0 == null ||
    primitive.attributes.WEIGHTS_0 == null
  ) {
    return positions.map(position => position.clone().applyMatrix4(nodeWorld))
  }

  const inverseNodeWorld = nodeWorld.clone().invert()
  const inverseBindMatrices = getSkinInverseBindMatrices(model, skin, skinningMode)
  const jointMatrices = skin.joints.map((jointNodeIndex, jointIndex) =>
    inverseNodeWorld
      .clone()
      .multiply(worldMatrices[jointNodeIndex])
      .multiply(inverseBindMatrices[jointIndex])
  )
  const joints = getVec4Accessor(model, primitive.attributes.JOINTS_0)
  const weights = getVec4Accessor(model, primitive.attributes.WEIGHTS_0)

  return positions.map((position, vertexIndex) => {
    const skinned = new Vector3()
    const vertexJoints = joints[vertexIndex]
    const vertexWeights = weights[vertexIndex]
    let weightSum = 0
    for (let component = 0; component < 4; component += 1) {
      const weight = vertexWeights[component]
      if (weight === 0) {
        continue
      }
      const jointMatrix = jointMatrices[vertexJoints[component]]
      if (jointMatrix == null) {
        continue
      }
      skinned.addScaledVector(position.clone().applyMatrix4(jointMatrix), weight)
      weightSum += weight
    }
    if (weightSum > 0 && Math.abs(weightSum - 1) > 1e-4) {
      skinned.multiplyScalar(1 / weightSum)
    }
    return skinned.applyMatrix4(nodeWorld)
  })
}

function getPrimitiveWorldNormals(model, nodeIndex, primitive, worldMatrices, skinningMode = 'gltf') {
  if (primitive.attributes.NORMAL == null) {
    return []
  }

  const normals = getVec3Accessor(model, primitive.attributes.NORMAL)
  const node = model.json.nodes[nodeIndex]
  const nodeWorld = worldMatrices[nodeIndex]
  const nodeNormalMatrix = new Matrix3().getNormalMatrix(nodeWorld)
  const skin = node.skin != null ? model.json.skins[node.skin] : null
  if (
    skin == null ||
    primitive.attributes.JOINTS_0 == null ||
    primitive.attributes.WEIGHTS_0 == null
  ) {
    return normals.map(normal => normal.clone().applyMatrix3(nodeNormalMatrix).normalize())
  }

  const inverseNodeWorld = nodeWorld.clone().invert()
  const inverseBindMatrices = getSkinInverseBindMatrices(model, skin, skinningMode)
  const jointNormalMatrices = skin.joints.map((jointNodeIndex, jointIndex) => {
    const jointMatrix = inverseNodeWorld
      .clone()
      .multiply(worldMatrices[jointNodeIndex])
      .multiply(inverseBindMatrices[jointIndex])
    return new Matrix3().getNormalMatrix(jointMatrix)
  })
  const joints = getVec4Accessor(model, primitive.attributes.JOINTS_0)
  const weights = getVec4Accessor(model, primitive.attributes.WEIGHTS_0)

  return normals.map((normal, vertexIndex) => {
    const skinned = new Vector3()
    const vertexJoints = joints[vertexIndex]
    const vertexWeights = weights[vertexIndex]
    let weightSum = 0
    for (let component = 0; component < 4; component += 1) {
      const weight = vertexWeights[component]
      if (weight === 0) {
        continue
      }
      const jointNormalMatrix = jointNormalMatrices[vertexJoints[component]]
      if (jointNormalMatrix == null) {
        continue
      }
      skinned.addScaledVector(normal.clone().applyMatrix3(jointNormalMatrix), weight)
      weightSum += weight
    }
    if (weightSum > 0 && Math.abs(weightSum - 1) > 1e-4) {
      skinned.multiplyScalar(1 / weightSum)
    }
    if (skinned.lengthSq() === 0) {
      skinned.copy(normal)
    }
    return skinned.applyMatrix3(nodeNormalMatrix).normalize()
  })
}

function sampleAnimationEndpointWorldMatrices(model, animationName) {
  const { json } = model
  const animation = json.animations?.find(candidate => candidate.name === animationName)
  if (animation == null) {
    throw new Error(`Animation not found: ${animationName}`)
  }

  const overrides = new Map()
  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.sampler]
    const input = getAccessor(model, sampler.input)
    const output = getAccessor(model, sampler.output)
    const inputAccessor = json.accessors[sampler.input]
    const outputAccessor = json.accessors[sampler.output]
    const outputItemSize = TYPE_SIZES[outputAccessor.type]
    const lastKey = inputAccessor.count - 1
    const values = Array.from(output.slice(lastKey * outputItemSize, (lastKey + 1) * outputItemSize))
    const nodeState = overrides.get(channel.target.node) ?? {}
    nodeState[channel.target.path] = values
    overrides.set(channel.target.node, nodeState)
  }

  return computeWorldMatrices(json, overrides)
}

function getSkinInverseBindMatrices(model, skin, skinningMode) {
  if (skinningMode === 'msfs') {
    return skin.joints.map(jointNodeIndex => model.worldMatrices[jointNodeIndex].clone().invert())
  }

  return getMatrices(model, skin.inverseBindMatrices)
}

function getNodeLocalMatrix(node, override = null) {
  if (node.matrix != null) {
    return new Matrix4().fromArray(node.matrix)
  }

  const translation = new Vector3(...(override?.translation ?? node.translation ?? [0, 0, 0]))
  const rotation = new Quaternion(...(override?.rotation ?? node.rotation ?? [0, 0, 0, 1]))
  const scale = new Vector3(...(override?.scale ?? node.scale ?? [1, 1, 1]))
  return new Matrix4().compose(translation, rotation, scale)
}

function computeWorldMatrices(json, overrides = new Map()) {
  const localMatrices = json.nodes.map((node, index) => getNodeLocalMatrix(node, overrides.get(index)))
  const worldMatrices = localMatrices.map(() => new Matrix4())
  const computed = new Set()
  const parent = new Map()
  json.nodes.forEach((node, index) => {
    node.children?.forEach(child => parent.set(child, index))
  })

  const compute = index => {
    if (computed.has(index)) {
      return worldMatrices[index]
    }
    const parentIndex = parent.get(index)
    if (parentIndex == null) {
      worldMatrices[index].copy(localMatrices[index])
    } else {
      worldMatrices[index].multiplyMatrices(compute(parentIndex), localMatrices[index])
    }
    computed.add(index)
    return worldMatrices[index]
  }

  for (let index = 0; index < json.nodes.length; index += 1) {
    compute(index)
  }

  return worldMatrices
}

function getMatrices(model, accessorIndex) {
  const values = getAccessor(model, accessorIndex)
  const matrices = []
  for (let item = 0; item < values.length; item += 16) {
    matrices.push(new Matrix4().fromArray(values.slice(item, item + 16)))
  }
  return matrices
}

function getVec3Accessor(model, accessorIndex) {
  const accessor = model.json.accessors[accessorIndex]
  const itemSize = TYPE_SIZES[accessor.type]
  const values = getAccessor(model, accessorIndex)
  const vectors = []
  for (let item = 0; item < values.length; item += itemSize) {
    vectors.push(new Vector3(values[item], values[item + 1] ?? 0, values[item + 2] ?? 0))
  }
  return vectors
}

function getVec4Accessor(model, accessorIndex) {
  const accessor = model.json.accessors[accessorIndex]
  const itemSize = TYPE_SIZES[accessor.type]
  const values = getAccessor(model, accessorIndex)
  const vectors = []
  for (let item = 0; item < values.length; item += itemSize) {
    vectors.push([
      values[item] ?? 0,
      values[item + 1] ?? 0,
      values[item + 2] ?? 0,
      values[item + 3] ?? 0,
    ])
  }
  return vectors
}

function getOptionalVec4Accessor(model, accessorIndex) {
  return accessorIndex == null ? null : getVec4Accessor(model, accessorIndex)
}

function getVertexInfluences(joints, weights, vertexIndex) {
  if (joints == null || weights == null) {
    return []
  }

  const output = []
  for (let component = 0; component < 4; component += 1) {
    const weight = weights[vertexIndex]?.[component] ?? 0
    if (weight <= 0) {
      continue
    }
    output.push({
      joint: Math.round(joints[vertexIndex]?.[component] ?? 0),
      weight,
    })
  }
  return output
}

function interpolateSkinInfluences(triangle, barycentric) {
  const weightsByJoint = new Map()
  addWeightedInfluences(weightsByJoint, triangle.skinA, barycentric[0])
  addWeightedInfluences(weightsByJoint, triangle.skinB, barycentric[1])
  addWeightedInfluences(weightsByJoint, triangle.skinC, barycentric[2])

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

function addWeightedInfluences(weightsByJoint, influences, barycentricWeight) {
  for (const influence of influences) {
    weightsByJoint.set(
      influence.joint,
      (weightsByJoint.get(influence.joint) ?? 0) + influence.weight * barycentricWeight
    )
  }
}

function getBarycentric(point, a, b, c) {
  const v0 = new Vector3().subVectors(b, a)
  const v1 = new Vector3().subVectors(c, a)
  const v2 = new Vector3().subVectors(point, a)
  const d00 = v0.dot(v0)
  const d01 = v0.dot(v1)
  const d11 = v1.dot(v1)
  const d20 = v2.dot(v0)
  const d21 = v2.dot(v1)
  const denom = d00 * d11 - d01 * d01
  if (Math.abs(denom) < 1e-18) {
    return [1, 0, 0]
  }

  const v = (d11 * d20 - d01 * d21) / denom
  const w = (d00 * d21 - d01 * d20) / denom
  return [1 - v - w, v, w]
}

function getIndexAccessor(model, accessorIndex, count) {
  if (accessorIndex == null) {
    return Array.from({ length: count }, (_, index) => index)
  }
  return Array.from(getAccessor(model, accessorIndex))
}

function getAccessor(model, accessorIndex) {
  const { json, buffers } = model
  const accessor = json.accessors[accessorIndex]
  const bufferView = json.bufferViews[accessor.bufferView]
  const ArrayType = COMPONENT_ARRAYS[accessor.componentType]
  const itemSize = TYPE_SIZES[accessor.type]
  const buffer = buffers[bufferView.buffer]
  const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const byteStride = bufferView.byteStride
  const elementBytes = ArrayType.BYTES_PER_ELEMENT

  if (byteStride == null || byteStride === itemSize * elementBytes) {
    const values = new ArrayType(buffer, byteOffset, accessor.count * itemSize)
    return accessor.normalized === true
      ? normalizeAccessorValues(values, accessor.componentType)
      : values
  }

  const view = new DataView(buffer)
  const output = new ArrayType(accessor.count * itemSize)
  for (let item = 0; item < accessor.count; item += 1) {
    for (let component = 0; component < itemSize; component += 1) {
      output[item * itemSize + component] = readComponent(
        view,
        byteOffset + item * byteStride + component * elementBytes,
        accessor.componentType
      )
    }
  }
  return accessor.normalized === true
    ? normalizeAccessorValues(output, accessor.componentType)
    : output
}

function normalizeAccessorValues(values, componentType) {
  const divisor =
    componentType === 5120 ? 127 :
      componentType === 5121 ? 255 :
        componentType === 5122 ? 32767 :
          componentType === 5123 ? 65535 :
            componentType === 5125 ? 4294967295 :
              1
  if (divisor === 1) {
    return values
  }

  return Float32Array.from(values, value => {
    if (componentType === 5120 || componentType === 5122) {
      return Math.max(value / divisor, -1)
    }
    return value / divisor
  })
}

function readComponent(view, byteOffset, componentType) {
  switch (componentType) {
    case 5120: return view.getInt8(byteOffset)
    case 5121: return view.getUint8(byteOffset)
    case 5122: return view.getInt16(byteOffset, true)
    case 5123: return view.getUint16(byteOffset, true)
    case 5125: return view.getUint32(byteOffset, true)
    case 5126: return view.getFloat32(byteOffset, true)
    default: throw new Error(`Unsupported component type: ${componentType}`)
  }
}

function maxMatrixAbsDelta(left, right) {
  let max = 0
  for (let index = 0; index < 16; index += 1) {
    max = Math.max(max, Math.abs(left.elements[index] - right.elements[index]))
  }
  return max
}

function summarize(values) {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  const absSorted = values.map(Math.abs).sort((a, b) => a - b)
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const absMean = absSorted.reduce((sum, value) => sum + value, 0) / absSorted.length
  return {
    min: format(sorted[0]),
    p50: format(percentile(sorted, 0.5)),
    p95: format(percentile(sorted, 0.95)),
    max: format(sorted[sorted.length - 1]),
    mean: format(mean),
    absMean: format(absMean),
  }
}

function percentile(sorted, t) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(t * (sorted.length - 1))))
  return sorted[index]
}

function format(value) {
  return Number(value.toPrecision(6))
}

// From Real-Time Collision Detection, Christer Ericson.
function closestPointToTriangle(point, a, b, c, target) {
  const ab = new Vector3().subVectors(b, a)
  const ac = new Vector3().subVectors(c, a)
  const ap = new Vector3().subVectors(point, a)
  const d1 = ab.dot(ap)
  const d2 = ac.dot(ap)
  if (d1 <= 0 && d2 <= 0) {
    return target.copy(a)
  }

  const bp = new Vector3().subVectors(point, b)
  const d3 = ab.dot(bp)
  const d4 = ac.dot(bp)
  if (d3 >= 0 && d4 <= d3) {
    return target.copy(b)
  }

  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    return target.copy(a).addScaledVector(ab, d1 / (d1 - d3))
  }

  const cp = new Vector3().subVectors(point, c)
  const d5 = ab.dot(cp)
  const d6 = ac.dot(cp)
  if (d6 >= 0 && d5 <= d6) {
    return target.copy(c)
  }

  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    return target.copy(a).addScaledVector(ac, d2 / (d2 - d6))
  }

  const va = d3 * d6 - d5 * d4
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    return target.copy(b).addScaledVector(new Vector3().subVectors(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)))
  }

  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  return target.copy(a).addScaledVector(ab, v).addScaledVector(ac, w)
}

main()
