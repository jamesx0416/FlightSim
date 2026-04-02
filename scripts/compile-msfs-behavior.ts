import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

import type { NormalizedPackageImportCache } from '../src/msfs/contracts.ts'
import { compileBehaviorPackage } from '../src/msfs/behavior/compiler.ts'
import { importMsfsPackage, resolvePackageRoot } from './msfs/importer.ts'

const args = process.argv.slice(2)

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printUsage()
  process.exit(args.length === 0 ? 1 : 0)
}

const positional: string[] = []
let outDir = '.msfs-cache/behavior'

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--out') {
    const nextValue = args[index + 1]
    if (!nextValue) {
      throw new Error('Missing value for --out')
    }
    outDir = nextValue
    index += 1
    continue
  }

  positional.push(arg)
}

if (positional.length !== 1) {
  printUsage()
  process.exit(1)
}

const inputPath = positional[0]
const resolvedInput = resolve(inputPath)
const cache = loadImportCache(resolvedInput)
const compiled = compileBehaviorPackage(cache, {
  importCachePath: extname(resolvedInput).toLowerCase() === '.json' ? resolvedInput : undefined
})

const outputPath = resolveOutputPath(cache, outDir)
await mkdir(resolve(outDir), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(compiled, null, 2)}\n`)

const summary = compiled.aircraft.flatMap((aircraft) => aircraft.variants)
console.log(`Behavior package written: ${outputPath}`)
console.log(`Aircraft compiled: ${compiled.aircraft.length}`)
console.log(`Variants compiled: ${summary.length}`)
console.log(
  `Bindings: animations=${sum(summary.map((variant) => variant.summary.animationCount))}, visibility=${sum(summary.map((variant) => variant.summary.visibilityCount))}, interactions=${sum(summary.map((variant) => variant.summary.interactionCount))}, updates=${sum(summary.map((variant) => variant.summary.updateCount))}`
)
console.log(`Compiler diagnostics: ${compiled.diagnostics.length}`)

function loadImportCache(resolvedInputPath: string): NormalizedPackageImportCache {
  if (existsSync(resolvedInputPath) && extname(resolvedInputPath).toLowerCase() === '.json') {
    return JSON.parse(readFileSync(resolvedInputPath, 'utf8')) as NormalizedPackageImportCache
  }

  const packageRoot = resolvePackageRoot(resolvedInputPath)
  return importMsfsPackage({ packageRoot })
}

function resolveOutputPath(cache: NormalizedPackageImportCache, outDirPath: string): string {
  const packageSlug = slugify(basename(cache.source.packageRoot) || 'package')
  const suffix =
    cache.source.backend === 'msfs2024-modular'
      ? 'msfs2024-behavior.json'
      : 'msfs2020-behavior.json'
  return join(resolve(outDirPath), `${packageSlug}.${suffix}`)
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

function sum(values: number[]): number {
  return values.reduce((accumulator, value) => accumulator + value, 0)
}

function printUsage(): void {
  console.log('Usage: bun run compile:msfs2020-behavior -- <import-cache.json|package-root|aircraft-dir> [--out <dir>]')
}
