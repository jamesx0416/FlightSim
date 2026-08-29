import { evaluateCompiledExpression } from './rpn'
import type { CompiledUpdateBinding } from './types'

export type UpdateBindingServices = Parameters<typeof evaluateCompiledExpression>[1]

const EVERY_FRAME = -1
const ONCE = -2
const MAX_CACHED_EXECUTION_PLANS = 256

interface ExecutionPlanNode {
  due?: ExecutionPlanNode
  notDue?: ExecutionPlanNode
  oncePending?: ExecutionPlanNode
  onceComplete?: ExecutionPlanNode
  expressions?: readonly CompiledUpdateBinding['expression'][]
}

/** Runs authored update bindings on their shared frequency clock. Used by both the viewer and compiled benchmark. */
export class UpdateBindingScheduler {
  private readonly intervals: readonly number[]
  private readonly elapsedSeconds: Float64Array
  private readonly dueFlags: Uint8Array
  private readonly bindingFrequencyIndices: Int32Array
  private readonly expressions: readonly CompiledUpdateBinding['expression'][]
  private readonly executionPlanRoot: ExecutionPlanNode = {}
  private cachedExecutionPlanCount = 0
  private oncePending = true

  constructor(
    private readonly bindings: readonly CompiledUpdateBinding[],
    private readonly services: UpdateBindingServices
  ) {
    const frequencies = [...new Set(
      bindings
        .filter(binding => !binding.once && binding.frequency > 0)
        .map(binding => binding.frequency)
    )]
    const frequencyIndices = new Map(
      frequencies.map((frequency, index) => [frequency, index] as const)
    )
    this.intervals = frequencies.map(frequency => 1 / frequency)
    this.elapsedSeconds = new Float64Array(frequencies.length)
    this.dueFlags = new Uint8Array(frequencies.length)
    this.bindingFrequencyIndices = Int32Array.from(bindings, binding =>
      binding.once
        ? ONCE
        : binding.frequency <= 0
          ? EVERY_FRAME
          : frequencyIndices.get(binding.frequency) ?? EVERY_FRAME
    )
    this.expressions = bindings.map(binding => binding.expression)
  }

  update(dtSeconds: number): number {
    for (let index = 0; index < this.intervals.length; index += 1) {
      const interval = this.intervals[index]!
      let elapsed = this.elapsedSeconds[index]! + dtSeconds
      const due = elapsed + 1e-9 >= interval
      if (due) elapsed %= interval
      this.elapsedSeconds[index] = elapsed
      this.dueFlags[index] = due ? 1 : 0
    }

    let evaluationCount = 0
    const oncePending = this.oncePending
    const expressions = this.getExecutionPlan(oncePending) ?? this.getDueExpressions(oncePending)
    for (const expression of expressions) {
      evaluateCompiledExpression(expression, this.services)
      evaluationCount += 1
    }
    this.oncePending = false
    return evaluationCount
  }

  /**
   * Each frequency combination repeats. Cache its source-ordered expression list so the
   * common frames do not rescan bindings that are not due. The cap keeps arbitrary inputs
   * from turning an unusually varied delta-time stream into an unbounded cache.
   */
  private getExecutionPlan(oncePending: boolean): readonly CompiledUpdateBinding['expression'][] | null {
    let node = this.executionPlanRoot
    for (let index = 0; index < this.dueFlags.length; index += 1) {
      const key = this.dueFlags[index] === 1 ? 'due' : 'notDue'
      let child = node[key]
      if (child == null) {
        if (this.cachedExecutionPlanCount >= MAX_CACHED_EXECUTION_PLANS) return null
        child = {}
        node[key] = child
      }
      node = child
    }
    const onceKey = oncePending ? 'oncePending' : 'onceComplete'
    let child = node[onceKey]
    if (child == null) {
      if (this.cachedExecutionPlanCount >= MAX_CACHED_EXECUTION_PLANS) return null
      child = {}
      node[onceKey] = child
    }
    node = child
    if (node.expressions != null) return node.expressions
    if (this.cachedExecutionPlanCount >= MAX_CACHED_EXECUTION_PLANS) return null

    const expressions = this.getDueExpressions(oncePending)
    node.expressions = expressions
    this.cachedExecutionPlanCount += 1
    return expressions
  }

  private getDueExpressions(oncePending: boolean): readonly CompiledUpdateBinding['expression'][] {
    const expressions: CompiledUpdateBinding['expression'][] = []
    for (let index = 0; index < this.bindings.length; index += 1) {
      const frequencyIndex = this.bindingFrequencyIndices[index]!
      if (
        (frequencyIndex === ONCE && !oncePending) ||
        (frequencyIndex >= 0 && this.dueFlags[frequencyIndex] === 0)
      ) {
        continue
      }
      expressions.push(this.expressions[index]!)
    }
    return expressions
  }
}
