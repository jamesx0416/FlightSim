import type { MsfsAnimationState } from '../../helpers/msfsGltf.ts'
import {
  applyMsfsBindingAnimationValue,
  applyMsfsNodeVisibilityValue
} from '../../helpers/msfsGltf.ts'
import type { AircraftCompatibilityRuntime } from './host.ts'

export function applyCompatibilityRuntimeState(
  animationState: MsfsAnimationState,
  runtime: AircraftCompatibilityRuntime
): void {
  for (const output of runtime.getAnimationOutputs()) {
    if (!output.binding.animName) continue
    applyMsfsBindingAnimationValue(
      animationState,
      output.binding.animName,
      output.value,
      output.binding.animLength
    )
  }

  for (const output of runtime.getVisibilityOutputs()) {
    if (!output.binding.nodeId) continue
    applyMsfsNodeVisibilityValue(animationState, output.binding.nodeId, output.visible)
  }

  animationState.mixer?.update(0)
}
