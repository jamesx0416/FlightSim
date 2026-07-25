import { expect, test } from 'bun:test'
import { Object3D } from 'three'

import { resolveMsfsAuthoredDragNode } from './interactionTrajectory'

test('uses the authored trajectory node instead of the clicked child mesh', () => {
  const lever = new Object3D()
  lever.name = 'SPEEDBRAKE_LEVER'
  const clickedMesh = new Object3D()
  clickedMesh.name = 'SPEEDBRAKE_LEVER_GRIP'
  lever.add(clickedMesh)
  const nodes = new Map<string, Object3D>([
    [lever.name, lever],
    [lever.name.toLowerCase(), lever]
  ])

  expect(resolveMsfsAuthoredDragNode({
    metadata: { dragNodeId: lever.name }
  } as never, nodes)).toBe(lever)
  expect(resolveMsfsAuthoredDragNode({
    metadata: { dragNodeId: null }
  } as never, nodes)).toBe(null)
  expect(clickedMesh === lever).toBe(false)
})
