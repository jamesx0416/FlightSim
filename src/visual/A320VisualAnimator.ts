import { Box3, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from 'three'
import type { AircraftVisualState } from '../entities/Plane'
import type { FlapVisualSchedule } from '../sim/FlightModel'

interface AnimatedNode {
  readonly object: Object3D
  readonly basePosition: Vector3
  readonly baseQuaternion: Quaternion
  readonly axis: Vector3
  readonly parentAxis: Vector3 | null
  readonly pivotLocal: Vector3 | null
  readonly parentPivot: Vector3 | null
  readonly amount: (state: AircraftVisualState) => number
}

export interface A320VisualAnimatorOptions {
  readonly enableAilerons?: boolean
  readonly enableElevator?: boolean
  readonly enableRudder?: boolean
  readonly enableTrailingFlaps?: boolean
  readonly enableInboardTrailingFlaps?: boolean
  readonly enableOutboardTrailingFlaps?: boolean
  readonly enableLeadingEdge?: boolean
  readonly enableSpoilers?: boolean
  readonly enableGear?: boolean
}

const rotationScratch = new Quaternion()
const pivotScratch = new Vector3()
const offsetScratch = new Vector3()
const worldPosScratch = new Vector3()
const worldQuatScratch = new Quaternion()
const parentQuatScratch = new Quaternion()
const helperQuatScratch = new Quaternion()
const helperPosScratch = new Vector3()
const helperPos2Scratch = new Vector3()
const helperAxisScratch = new Vector3()
const helperAxis2Scratch = new Vector3()
const principalAxisScratch = new Vector3()
const fallbackAxisScratch = new Vector3()
const fallbackNormalScratch = new Vector3()
const basisXScratch = new Vector3()
const basisYScratch = new Vector3()
const basisZScratch = new Vector3()
const basisMatrixScratch = new Matrix4()
const vertexScratch = new Vector3()

export class A320VisualAnimator {
  private readonly animatedNodes: AnimatedNode[]

  constructor(
    root: Object3D,
    flapVisualSchedule: FlapVisualSchedule,
    options: A320VisualAnimatorOptions = {}
  ) {
    this.animatedNodes = collectAnimatedNodes(root, flapVisualSchedule, options)
  }

  update(state: AircraftVisualState): void {
    for (const node of this.animatedNodes) {
      node.object.position.copy(node.basePosition)
      rotationScratch.setFromAxisAngle(node.axis, node.amount(state))
      node.object.quaternion.copy(node.baseQuaternion).multiply(rotationScratch)
      if (node.pivotLocal != null) {
        pivotScratch.copy(node.pivotLocal)
        offsetScratch.copy(node.pivotLocal).applyQuaternion(rotationScratch)
        pivotScratch.sub(offsetScratch).applyQuaternion(node.baseQuaternion)
        node.object.position.add(pivotScratch)
      }
    }
  }
}

function collectAnimatedNodes(
  root: Object3D,
  flapVisualSchedule: FlapVisualSchedule,
  options: A320VisualAnimatorOptions
): AnimatedNode[] {
  const animatedNodes: AnimatedNode[] = []
  const candidates: Array<{ object: Object3D; name: string }> = []

  root.traverse(object => {
    const name = object.name
    if (!name || name.startsWith('x0_')) return
    candidates.push({ object, name })
  })

  for (const { object, name } of candidates) {
    const animatedNode = createAnimatedNode(root, object, name, flapVisualSchedule, options)
    if (animatedNode) animatedNodes.push(animatedNode)
  }

  return animatedNodes
}

function createAnimatedNode(
  root: Object3D,
  object: Object3D,
  name: string,
  flapVisualSchedule: FlapVisualSchedule,
  options: A320VisualAnimatorOptions
): AnimatedNode | null {
  const upperName = name.toUpperCase()

  if (options.enableAilerons !== false && aileronNodeNames.has(upperName)) {
    const sign = upperName.includes('_RIGHT') ? -1 : 1
    return createAileronNode(
      root,
      object,
      upperName.includes('_RIGHT') ? 'right' : 'left',
      state => radians(-18) * sign * state.aileron
    )
  }

  if (options.enableElevator !== false && elevatorNodeNames.has(upperName)) {
    const sign = upperName.includes('_RIGHT') ? -1 : 1
    return createNode(
      object,
      new Vector3(1, 0, 0),
      state => radians(-16) * sign * state.elevator
    )
  }

  if (options.enableRudder !== false && rudderNodeNames.has(upperName)) {
    return createNode(
      object,
      new Vector3(0, 1, 0),
      state => radians(24) * state.rudder
    )
  }

  if (options.enableTrailingFlaps !== false && trailingFlapNodeNames.has(upperName)) {
    const isInboard = upperName.includes('FLAPS_01')
    if (isInboard) {
      if (options.enableInboardTrailingFlaps === false) return null
    } else if (options.enableOutboardTrailingFlaps === false) {
      return null
    }
    const flapAngleSign = trailingFlapAngleSignByNodeName[upperName] ?? 1
    return createNode(
      object,
      new Vector3(1, 0, 0),
      state =>
        radians(
          a320TrailingFlapAngle(state.flaps01, isInboard, flapVisualSchedule) *
            flapAngleSign
        ),
      'trailing'
    )
  }

  if (options.enableLeadingEdge !== false && leadingEdgeNodeNames.has(upperName)) {
    const referencedNode = createReferencedHingeNode(
      root,
      object,
      leadingEdgeHelperByNodeName[upperName],
      state => radians(a320LeadingEdgeAngle(state.flaps01, flapVisualSchedule))
    )
    if (referencedNode) return referencedNode
    return createNode(
      object,
      new Vector3(1, 0, 0),
      state => radians(a320LeadingEdgeAngle(state.flaps01, flapVisualSchedule)),
      'leading'
    )
  }

  if (options.enableSpoilers !== false && spoilerNodeNames.has(upperName)) {
    const isRightSide = upperName.includes('_RIGHT') || upperName.endsWith('_R')
    const amount = (state: AircraftVisualState) => {
      const rollSpoiler = isRightSide
        ? Math.max(0, state.aileron) * 0.45
        : Math.max(0, -state.aileron) * 0.45
      const deflection = Math.max(state.spoiler01, rollSpoiler)
      return radians(-45) * deflection
    }
    const referencedNode = createReferencedHingeNode(
      root,
      object,
      spoilerHelperByNodeName[upperName],
      amount
    )
    if (referencedNode) return referencedNode
    return createNode(object, new Vector3(1, 0, 0), amount, 'spoiler')
  }

  if (options.enableGear !== false && gearPrimaryNodeNames.has(upperName)) {
    const sign = upperName.endsWith('_RIGHT') ? -1 : 1
    return createNode(
      object,
      new Vector3(0, 0, 1),
      state => radians(78) * sign * (1 - state.gear01)
    )
  }

  if (options.enableGear !== false && gearSecondaryNodeNames.has(upperName)) {
    const sign = upperName.endsWith('_RIGHT') ? 1 : -1
    return createNode(
      object,
      new Vector3(0, 0, 1),
      state => radians(24) * sign * (1 - state.gear01)
    )
  }

  if (
    options.enableGear !== false &&
    matchesName(upperName, gearDoorNodeNames, gearDoorNodePrefixes)
  ) {
    const sign = upperName.includes('_RIGHT') ? -1 : 1
    return createNode(
      object,
      new Vector3(0, 0, 1),
      state => radians(92) * sign * (1 - state.gear01)
    )
  }

  return null
}

function createNode(
  object: Object3D,
  axis: Vector3,
  amount: (state: AircraftVisualState) => number,
  pivotKind?: 'trailing' | 'leading' | 'vertical' | 'spoiler'
): AnimatedNode {
  return {
    object,
    basePosition: object.position.clone(),
    baseQuaternion: object.quaternion.clone(),
    axis: axis.normalize(),
    parentAxis: null,
    pivotLocal: pivotKind ? estimatePivotLocal(object, pivotKind) : null,
    parentPivot: null,
    amount
  }
}

function createAileronNode(
  root: Object3D,
  object: Object3D,
  side: 'left' | 'right',
  amount: (state: AircraftVisualState) => number
): AnimatedNode | null {
  const helper1 = root.getObjectByName(`WING_AILERON_1_${side}`)
  const helper2 = root.getObjectByName(`WING_AILERON_2_${side}`)
  if (!helper1 || !helper2) {
    return createNode(object, new Vector3(1, 0, 0), amount, 'trailing')
  }

  root.updateMatrixWorld(true)
  const position = helper1
    .getWorldPosition(helperPosScratch)
    .add(helper2.getWorldPosition(helperPos2Scratch))
    .multiplyScalar(0.5)
  const helperAxis = helper2
    .getWorldPosition(worldPosScratch)
    .sub(helper1.getWorldPosition(helperPos2Scratch))
    .normalize()
  const normalHint = helper1
    .getWorldQuaternion(worldQuatScratch)
    .slerp(helper2.getWorldQuaternion(helperQuatScratch), 0.5)
  const worldNormal = new Vector3(0, 0, 1).applyQuaternion(normalHint)

  return createPivotDrivenNode(root, object, position, helperAxis, worldNormal, amount)
}

function createReferencedHingeNode(
  root: Object3D,
  object: Object3D,
  helperName: string | undefined,
  amount: (state: AircraftVisualState) => number
): AnimatedNode | null {
  if (!helperName) return null
  const helper = root.getObjectByName(helperName)
  if (!helper) return null

  root.updateMatrixWorld(true)
  const position = helper.getWorldPosition(worldPosScratch)
  const helperOrientation = helper.getWorldQuaternion(worldQuatScratch)
  const helperAxis = new Vector3(1, 0, 0).applyQuaternion(helperOrientation)
  const normalHint = new Vector3(0, 0, 1).applyQuaternion(helperOrientation)

  return createPivotDrivenNode(root, object, position, helperAxis, normalHint, amount)
}

function createPivotDrivenNode(
  root: Object3D,
  object: Object3D,
  worldPosition: Vector3,
  fallbackAxisWorld: Vector3,
  fallbackNormalWorld: Vector3,
  amount: (state: AircraftVisualState) => number
): AnimatedNode {
  const pivot = new Object3D()
  pivot.name = `anim_${object.name}`

  const hingeAxisWorld = computeSurfacePrincipalAxisWorld(object)?.normalize()
  if (hingeAxisWorld != null && hingeAxisWorld.dot(fallbackAxisWorld) < 0) {
    hingeAxisWorld.multiplyScalar(-1)
  }

  basisXScratch.copy(hingeAxisWorld ?? fallbackAxisWorld).normalize()
  basisZScratch.copy(fallbackNormalWorld)
  basisZScratch.addScaledVector(
    basisXScratch,
    -basisZScratch.dot(basisXScratch)
  )
  if (basisZScratch.lengthSq() < 1e-6) {
    basisZScratch.set(0, 0, 1)
    basisZScratch.addScaledVector(
      basisXScratch,
      -basisZScratch.dot(basisXScratch)
    )
  }
  if (basisZScratch.lengthSq() < 1e-6) {
    basisZScratch.set(0, 1, 0)
    basisZScratch.addScaledVector(
      basisXScratch,
      -basisZScratch.dot(basisXScratch)
    )
  }
  basisZScratch.normalize()
  basisYScratch.crossVectors(basisZScratch, basisXScratch).normalize()
  basisZScratch.crossVectors(basisXScratch, basisYScratch).normalize()

  const rootWorldQuaternion = root.getWorldQuaternion(parentQuatScratch)
  pivot.position.copy(root.worldToLocal(worldPosition.clone()))
  pivot.quaternion
    .setFromRotationMatrix(
      basisMatrixScratch.makeBasis(basisXScratch, basisYScratch, basisZScratch)
    )
    .premultiply(rootWorldQuaternion.invert())
  root.add(pivot)
  pivot.attach(object)

  return {
    object: pivot,
    basePosition: pivot.position.clone(),
    baseQuaternion: pivot.quaternion.clone(),
    axis: new Vector3(1, 0, 0),
    parentAxis: null,
    pivotLocal: null,
    parentPivot: null,
    amount
  }
}

function computeSurfacePrincipalAxisWorld(object: Object3D): Vector3 | null {
  const centroid = new Vector3()
  let vertexCount = 0

  object.updateMatrixWorld(true)
  object.traverse(child => {
    if (!(child as Mesh).isMesh) return
    const mesh = child as Mesh
    const position = mesh.geometry?.attributes?.position
    if (!position || position.count === 0) return

    for (let i = 0; i < position.count; i++) {
      vertexScratch.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)
      centroid.add(vertexScratch)
      vertexCount++
    }
  })

  if (vertexCount === 0) return null
  centroid.multiplyScalar(1 / vertexCount)

  fallbackAxisScratch.set(1, 0, 0)
  for (let iteration = 0; iteration < 10; iteration++) {
    principalAxisScratch.set(0, 0, 0)
    object.traverse(child => {
      if (!(child as Mesh).isMesh) return
      const mesh = child as Mesh
      const position = mesh.geometry?.attributes?.position
      if (!position || position.count === 0) return

      for (let i = 0; i < position.count; i++) {
        vertexScratch
          .fromBufferAttribute(position, i)
          .applyMatrix4(mesh.matrixWorld)
          .sub(centroid)
        principalAxisScratch.addScaledVector(
          vertexScratch,
          vertexScratch.dot(fallbackAxisScratch)
        )
      }
    })

    if (principalAxisScratch.lengthSq() < 1e-8) return null
    fallbackAxisScratch.copy(principalAxisScratch.normalize())
  }

  return fallbackAxisScratch.clone()
}

function estimatePivotLocal(
  object: Object3D,
  pivotKind: 'trailing' | 'leading' | 'vertical' | 'spoiler'
): Vector3 | null {
  const bounds = computeLocalBounds(object)
  if (bounds == null) return null

  const center = bounds.getCenter(new Vector3())
  switch (pivotKind) {
    case 'trailing':
      return new Vector3(center.x, center.y, bounds.max.z)
    case 'leading':
      return new Vector3(center.x, center.y, bounds.min.z)
    case 'vertical':
      return new Vector3(center.x, center.y, bounds.max.z)
    case 'spoiler':
      return new Vector3(center.x, center.y, bounds.max.z)
  }
}

function computeLocalBounds(root: Object3D): Box3 | null {
  root.updateMatrixWorld(true)
  const rootInverse = new Matrix4().copy(root.matrixWorld).invert()
  const bounds = new Box3()
  const temp = new Box3()
  let hasBounds = false

  root.traverse(object => {
    if (!(object as Mesh).isMesh) return
    const mesh = object as Mesh
    const geometry = mesh.geometry
    const position = geometry?.attributes?.position
    if (!position || position.count === 0) return
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    if (!geometry.boundingBox) return
    temp.copy(geometry.boundingBox)
    temp.applyMatrix4(mesh.matrixWorld)
    temp.applyMatrix4(rootInverse)
    if (!hasBounds) {
      bounds.copy(temp)
      hasBounds = true
    } else {
      bounds.union(temp)
    }
  })

  return hasBounds ? bounds : null
}

function matchesName(
  name: string,
  exactNames: ReadonlySet<string>,
  prefixes: readonly string[]
): boolean {
  if (exactNames.has(name)) return true
  return prefixes.some(prefix => name.startsWith(prefix))
}

function radians(valueDeg: number): number {
  return (valueDeg * Math.PI) / 180
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function scheduleAngle(
  flaps01: number,
  detents01: readonly number[],
  anglesDeg: readonly number[]
): number {
  const clampedFlaps01 = Math.max(0, Math.min(1, flaps01))
  if (detents01.length === 0 || anglesDeg.length === 0) return 0
  if (detents01.length === 1 || anglesDeg.length === 1) return anglesDeg[0] ?? 0

  if (clampedFlaps01 <= detents01[0]) return anglesDeg[0] ?? 0

  for (let index = 1; index < detents01.length; index += 1) {
    const previousDetent = detents01[index - 1]
    const nextDetent = detents01[index]
    if (clampedFlaps01 > nextDetent) continue
    const span = nextDetent - previousDetent
    const t = span > 0 ? (clampedFlaps01 - previousDetent) / span : 0
    return lerp(anglesDeg[index - 1] ?? 0, anglesDeg[index] ?? 0, t)
  }

  return anglesDeg[anglesDeg.length - 1] ?? 0
}

function a320TrailingFlapAngle(
  flaps01: number,
  isInboard: boolean,
  flapVisualSchedule: FlapVisualSchedule
): number {
  return scheduleAngle(
    flaps01,
    flapVisualSchedule.detents01,
    isInboard
      ? flapVisualSchedule.trailingInboardDeg
      : flapVisualSchedule.trailingOutboardDeg
  )
}

function a320LeadingEdgeAngle(
  flaps01: number,
  flapVisualSchedule: FlapVisualSchedule
): number {
  return scheduleAngle(
    flaps01,
    flapVisualSchedule.detents01,
    flapVisualSchedule.leadingDeg
  )
}

const aileronNodeNames = new Set(['AILERON_LEFT', 'AILERON_RIGHT'])

const elevatorNodeNames = new Set([
  'WING_TAIL_ELEVATOR_LEFT',
  'WING_TAIL_ELEVATOR_RIGHT'
])

const rudderNodeNames = new Set(['TAIL_RUDDER_C'])

const trailingFlapNodeNames = new Set([
  'FLAPS_01_LEFT',
  'FLAPS_02_LEFT',
  'FLAPS_01_RIGHT',
  'FLAPS_02_RIGHT'
])

const leadingEdgeNodeNames = new Set([
  'FLAPSKRUEGER_LEFT',
  'FLAPSKRUEGER_02_LEFT',
  'FLAPSKRUEGER_RIGHT',
  'FLAPSKRUEGER_02_RIGHT'
])

const leadingEdgeHelperByNodeName: Record<string, string> = {
  FLAPSKRUEGER_LEFT: 'WING_FLAPSKRUEGER_0_left',
  FLAPSKRUEGER_02_LEFT: 'WING_FLAPSKRUEGER_1_left',
  FLAPSKRUEGER_RIGHT: 'WING_FLAPSKRUEGER_0_right',
  FLAPSKRUEGER_02_RIGHT: 'WING_FLAPSKRUEGER_1_right'
}

const spoilerNodeNames = new Set([
  'SPOILER_LEFT',
  'SPOILER_RIGHT',
  'SPOILER_2_1_LEFT',
  'SPOILER_2_3_LEFT',
  'SPOILER_2_1_RIGHT',
  'SPOILER_2_3_RIGHT'
])

const spoilerHelperByNodeName: Record<string, string> = {
  SPOILER_LEFT: 'WING_SPOILER_1_left',
  SPOILER_RIGHT: 'WING_SPOILER_1_right',
  SPOILER_2_1_LEFT: 'WING_SPOILER_2_1_left',
  SPOILER_2_3_LEFT: 'WING_SPOILER_2_3_left',
  SPOILER_2_1_RIGHT: 'WING_SPOILER_2_1_right',
  SPOILER_2_3_RIGHT: 'WING_SPOILER_2_3_right'
}

const trailingFlapAngleSignByNodeName: Record<string, number> = {
  FLAPS_01_LEFT: -1,
  FLAPS_02_LEFT: 1,
  FLAPS_01_RIGHT: -1,
  FLAPS_02_RIGHT: 1
}

const gearPrimaryNodeNames = new Set(['GEAR_BONE01_LEFT', 'GEAR_BONE01_RIGHT'])
const gearSecondaryNodeNames = new Set(['GEAR_BONE02_LEFT', 'GEAR_BONE02_RIGHT'])

const gearDoorNodeNames = new Set([
  'DOOR01_LEFT',
  'DOOR01_RIGHT',
  'DOOR02_LEFT',
  'DOOR02_RIGHT',
  'DOOR03_LEFT',
  'R_DOOR03_RIGHT'
])
const gearDoorNodePrefixes = ['WING_DOOR01_', 'WING_DOOR02_', 'WING_DOOR03_']
