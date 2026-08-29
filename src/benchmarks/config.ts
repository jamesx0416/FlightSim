import type { CustomReadinessStage } from './readiness'

/** Repository-local named readiness states. Add authoritative DevApi conditions here. */
export const BENCHMARK_READINESS_STAGES = {} satisfies Readonly<Record<string, CustomReadinessStage>>
