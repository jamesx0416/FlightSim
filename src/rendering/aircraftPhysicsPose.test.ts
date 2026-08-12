import { expect, test } from 'bun:test'
import { Euler, Quaternion, Vector3 } from 'three'

import {
  physicsQuaternionToViewer,
  physicsVectorToViewer,
} from './aircraftPhysicsPose'

test('maps NED and body axes into the viewer model axes', () => {
  expect(physicsVectorToViewer(1, 0, 0).distanceTo(new Vector3(0, 0, 1)) < 1e-12).toBe(true)
  expect(physicsVectorToViewer(0, 1, 0).distanceTo(new Vector3(-1, 0, 0)) < 1e-12).toBe(true)
  expect(physicsVectorToViewer(0, 0, 1).distanceTo(new Vector3(0, -1, 0)) < 1e-12).toBe(true)
})

test('maps heading and pitch without changing zero attitude', () => {
  const identity = physicsQuaternionToViewer([0, 0, 0, 1])
  expect(identity.angleTo(new Quaternion()) < 1e-12).toBe(true)

  const yaw = new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 2, 'ZYX'))
  const yawViewer = physicsQuaternionToViewer(yaw.toArray())
  const forwardAfterYaw = new Vector3(0, 0, 1).applyQuaternion(yawViewer)
  expect(forwardAfterYaw.distanceTo(new Vector3(-1, 0, 0)) < 1e-9).toBe(true)

  const pitch = new Quaternion().setFromEuler(new Euler(0, Math.PI / 6, 0, 'ZYX'))
  const pitchViewer = physicsQuaternionToViewer(pitch.toArray())
  const forwardAfterPitch = new Vector3(0, 0, 1).applyQuaternion(pitchViewer)
  expect(forwardAfterPitch.y > 0).toBe(true)
  expect(Math.abs(forwardAfterPitch.length() - 1) < 1e-12).toBe(true)
})
