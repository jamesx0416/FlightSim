import type { CompiledBehaviorSet } from '../types'

export function collectProtectedNodeNames(
  behaviorSet: CompiledBehaviorSet
): ReadonlySet<string> {
  const names = new Set<string>()
  const add = (name: string | null): void => {
    if (name == null || name === '') return
    names.add(name)
    names.add(name.toLowerCase())
  }

  for (const binding of [
    ...behaviorSet.animationBindings,
    ...behaviorSet.visibilityBindings,
    ...behaviorSet.materialBindings
  ]) add(binding.target)

  for (const binding of behaviorSet.interactionBindings) {
    add(binding.target)
    for (const target of binding.feedbackTargets) add(target)
    add(binding.metadata.highlightNodeId)
  }
  for (const blocker of behaviorSet.interactionBlockers) {
    add(blocker.target)
    for (const target of blocker.feedbackTargets) add(target)
  }
  return names
}
