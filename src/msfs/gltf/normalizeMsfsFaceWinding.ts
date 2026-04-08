import {
  BufferGeometry,
  FrontSide,
  Mesh,
  type Object3D
} from 'three'

const MAX_SAMPLED_TRIANGLES = 1024
const INVERTED_WINDING_THRESHOLD = 0.9
const PRESERVED_WINDING_THRESHOLD = 0.1

type FaceWindingState = 'preserved' | 'inverted' | 'mixed' | 'unknown'

export function normalizeMsfsFaceWinding(root: Object3D): void {
  root.traverse(object => {
    if (!(object instanceof Mesh) || Array.isArray(object.material)) {
      return
    }

    const material = object.material
    if (material.transparent === true || material.side !== FrontSide) {
      return
    }

    const geometry = object.geometry
    if (!(geometry instanceof BufferGeometry)) {
      return
    }

    const faceWindingState = classifyFaceWinding(geometry)
    geometry.userData.msfsFaceWinding = faceWindingState
    if (faceWindingState !== 'inverted') {
      return
    }

    flipIndexedGeometryWinding(geometry)
  })
}

function classifyFaceWinding(geometry: BufferGeometry): FaceWindingState {
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const index = geometry.getIndex()
  if (position == null || normal == null || index == null) {
    return 'unknown'
  }

  const sampledTriangles = Math.min(Math.floor(index.count / 3), MAX_SAMPLED_TRIANGLES)
  if (sampledTriangles === 0) {
    return 'unknown'
  }

  let alignedTriangles = 0
  let invertedTriangles = 0

  for (let triangleIndex = 0; triangleIndex < sampledTriangles; triangleIndex += 1) {
    const offset = triangleIndex * 3
    const a = index.getX(offset)
    const b = index.getX(offset + 1)
    const c = index.getX(offset + 2)

    const ax = position.getX(a)
    const ay = position.getY(a)
    const az = position.getZ(a)
    const abx = position.getX(b) - ax
    const aby = position.getY(b) - ay
    const abz = position.getZ(b) - az
    const acx = position.getX(c) - ax
    const acy = position.getY(c) - ay
    const acz = position.getZ(c) - az

    const faceX = aby * acz - abz * acy
    const faceY = abz * acx - abx * acz
    const faceZ = abx * acy - aby * acx
    const faceLength = Math.hypot(faceX, faceY, faceZ)
    if (faceLength < 1e-6) {
      continue
    }

    const normalX = normal.getX(a) + normal.getX(b) + normal.getX(c)
    const normalY = normal.getY(a) + normal.getY(b) + normal.getY(c)
    const normalZ = normal.getZ(a) + normal.getZ(b) + normal.getZ(c)
    const normalLength = Math.hypot(normalX, normalY, normalZ)
    if (normalLength < 1e-6) {
      continue
    }

    const alignment =
      (faceX / faceLength) * (normalX / normalLength) +
      (faceY / faceLength) * (normalY / normalLength) +
      (faceZ / faceLength) * (normalZ / normalLength)

    if (alignment >= 0) {
      alignedTriangles += 1
    } else {
      invertedTriangles += 1
    }
  }

  const evaluatedTriangles = alignedTriangles + invertedTriangles
  if (evaluatedTriangles === 0) {
    return 'unknown'
  }

  const invertedRatio = invertedTriangles / evaluatedTriangles
  if (invertedRatio >= INVERTED_WINDING_THRESHOLD) {
    return 'inverted'
  }

  if (invertedRatio <= PRESERVED_WINDING_THRESHOLD) {
    return 'preserved'
  }

  return 'mixed'
}

function flipIndexedGeometryWinding(geometry: BufferGeometry): void {
  const index = geometry.getIndex()
  if (index == null) {
    return
  }

  for (let offset = 0; offset < index.count; offset += 3) {
    const second = index.getX(offset + 1)
    const third = index.getX(offset + 2)
    index.setX(offset + 1, third)
    index.setX(offset + 2, second)
  }

  index.needsUpdate = true
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
}
