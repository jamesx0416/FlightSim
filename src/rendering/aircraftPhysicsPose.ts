import { Matrix4, Quaternion, Vector3 } from 'three'

const PHYSICS_TO_VIEWER_BASIS = new Quaternion().setFromRotationMatrix(
  new Matrix4().set(
    0, -1, 0, 0,
    0, 0, -1, 0,
    1, 0, 0, 0,
    0, 0, 0, 1
  )
)
const VIEWER_TO_PHYSICS_BASIS = PHYSICS_TO_VIEWER_BASIS.clone().invert()

export function physicsVectorToViewer(
  forwardOrNorth: number,
  rightOrEast: number,
  down: number,
  target = new Vector3()
): Vector3 {
  return target.set(-rightOrEast, -down, forwardOrNorth)
}

export function physicsBodyReferenceOffsetToViewer(
  centerOfMassForwardM: number,
  centerOfMassRightM: number,
  centerOfMassDownM: number,
  target = new Vector3()
): Vector3 {
  return physicsVectorToViewer(
    -centerOfMassForwardM,
    -centerOfMassRightM,
    -centerOfMassDownM,
    target
  )
}

export function physicsQuaternionToViewer(
  physics: readonly [number, number, number, number],
  target = new Quaternion()
): Quaternion {
  const source = new Quaternion(physics[0], physics[1], physics[2], physics[3]).normalize()
  return target
    .copy(PHYSICS_TO_VIEWER_BASIS)
    .multiply(source)
    .multiply(VIEWER_TO_PHYSICS_BASIS)
    .normalize()
}
