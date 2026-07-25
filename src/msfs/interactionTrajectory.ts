import type { Object3D } from 'three'

import type { CompiledInteractionBinding } from './types'

/** Resolves the node explicitly authored by MSFS for a trajectory drag. */
export function resolveMsfsAuthoredDragNode(
  binding: Pick<CompiledInteractionBinding, 'metadata'>,
  nodesByName: ReadonlyMap<string, Object3D>
): Object3D | null {
  const nodeId = binding.metadata.dragNodeId
  if (nodeId == null) return null
  return nodesByName.get(nodeId) ?? nodesByName.get(nodeId.toLowerCase()) ?? null
}
