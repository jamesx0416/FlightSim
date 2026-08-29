import { compileMsfs2020Behaviors } from '../../msfs/behavior'
import { importBuiltMsfs2020Package } from '../../msfs/importer'
import {
  runCompiledBindingsBenchmark,
  type CompiledBindingsBenchmarkOptions,
  type CompiledBindingsBenchmarkResult
} from './compiledBindingsBenchmark'
import { selectBenchmarkAircraft } from './selectBenchmarkAircraft'

export type BunCompiledBindingsBenchmarkOptions = CompiledBindingsBenchmarkOptions & {
  readonly packageRoot: string
  readonly additionalPackageRoots?: readonly string[]
  readonly aircraftId?: string
}

export type BunCompiledBindingsBenchmarkResult = {
  readonly aircraftId: string
  readonly setupMs: number
  readonly benchmark: CompiledBindingsBenchmarkResult
}

export async function runBunCompiledBindingsBenchmark(
  options: BunCompiledBindingsBenchmarkOptions
): Promise<BunCompiledBindingsBenchmarkResult> {
  const setupStartedAt = performance.now()
  const pkg = await importBuiltMsfs2020Package(options.packageRoot, {
    requestedAircraftId: options.aircraftId,
    additionalPackageRoots: options.additionalPackageRoots
  })
  const aircraft = selectBenchmarkAircraft(pkg.aircraft, options.aircraftId)
  const compiled = await compileMsfs2020Behaviors(pkg, aircraft, {
    includeInteriorModel: true,
    additionalPackageRoots: options.additionalPackageRoots
  })
  const setupMs = performance.now() - setupStartedAt
  return {
    aircraftId: aircraft.id,
    setupMs,
    benchmark: runCompiledBindingsBenchmark(compiled, options)
  }
}
