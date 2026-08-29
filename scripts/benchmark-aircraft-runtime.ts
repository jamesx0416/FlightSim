import { DOMParser, Element } from 'linkedom'

Object.defineProperty(globalThis, 'DOMParser', { value: DOMParser, configurable: true })
Object.defineProperty(globalThis, 'Element', { value: Element, configurable: true })
Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true })

const { runBunAircraftRuntimeBenchmark } = await import('../src/sim/benchmarks/bunAircraftRuntimeAdapter')

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : Bun.argv[index + 1]
}

function numericArgument(name: string): number | undefined {
  const value = argument(name)
  return value == null ? undefined : Number(value)
}

const defaultPackageRoot = new URL('../aircrafts/headwindsim-aircraft-a330-900/', import.meta.url).toString()
const defaultCompiledPath = new URL('../.tmp/a330-compiled-behaviors.json', import.meta.url).pathname
const requestedCompiledPath = argument('compiled')
const compiledBehaviorsPath = requestedCompiledPath
  ?? (await Bun.file(defaultCompiledPath).exists() ? defaultCompiledPath : undefined)
const compiledBehaviors = compiledBehaviorsPath == null
  ? undefined
  : await Bun.file(compiledBehaviorsPath).json()
const result = await runBunAircraftRuntimeBenchmark({
  packageRoot: argument('package') ?? defaultPackageRoot,
  aircraftId: argument('aircraft'),
  compiledBehaviors,
  frames: numericArgument('frames'),
  warmupFrames: numericArgument('warmup'),
  dtSeconds: numericArgument('dt')
})

console.log(JSON.stringify(result, null, 2))
