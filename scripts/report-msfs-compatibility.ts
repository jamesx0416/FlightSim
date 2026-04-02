import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { loadCompatibilityDescriptors } from './msfs/compatibility.ts'

const args = process.argv.slice(2)
const positional: string[] = []
let jsonOut: string | undefined

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--json-out') {
    const nextValue = args[index + 1]
    if (!nextValue) {
      throw new Error('Missing value for --json-out')
    }
    jsonOut = nextValue
    index += 1
    continue
  }

  positional.push(arg)
}

if (positional.includes('--help') || positional.includes('-h')) {
  printUsage()
  process.exit(0)
}

const cacheRoot = positional[0] ?? '.msfs-cache'
const bundle = loadCompatibilityDescriptors(cacheRoot)

const report = {
  generatedAt: new Date().toISOString(),
  cacheRoot: resolve(cacheRoot),
  descriptors: bundle.descriptors.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    backend: descriptor.source.backend,
    aircraftId: descriptor.aircraftId,
    variantId: descriptor.variantId,
    bindings: descriptor.compiledBehavior.summary,
    trackedVariables: descriptor.trackedVariables.length,
    panelSurfaces: descriptor.panel?.surfaces.length ?? 0,
    wasmGauges: descriptor.wasm.gauges.length,
    soundEntries: descriptor.sound?.entries?.length ?? 0,
    diagnostics: descriptor.diagnostics.length
  }))
}

if (jsonOut) {
  const outputPath = resolve(jsonOut)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
}

console.log(`Compatibility descriptors: ${report.descriptors.length}`)
for (const descriptor of report.descriptors) {
  console.log(
    [
      descriptor.label,
      descriptor.backend,
      `bindings=${descriptor.bindings.animationCount}/${descriptor.bindings.visibilityCount}/${descriptor.bindings.interactionCount}/${descriptor.bindings.updateCount}`,
      `panel=${descriptor.panelSurfaces}`,
      `wasm=${descriptor.wasmGauges}`,
      `sound=${descriptor.soundEntries}`,
      `diagnostics=${descriptor.diagnostics}`
    ].join(' | ')
  )
}

if (jsonOut) {
  console.log(`Report written: ${resolve(jsonOut)}`)
}

function printUsage(): void {
  console.log('Usage: bun run report:msfs-compat -- [cache-root] [--json-out <path>]')
}
