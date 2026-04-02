import { importMsfsPackage, resolvePackageRoot, writeImportCache } from './msfs/importer.ts'

const args = process.argv.slice(2)

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printUsage()
  process.exit(args.length === 0 ? 1 : 0)
}

const positional: string[] = []
let outDir = '.msfs-cache'

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
const packageRoot = resolvePackageRoot(inputPath)
const cache = importMsfsPackage({ packageRoot })
const result = writeImportCache(cache, outDir)

console.log(`Imported package root: ${packageRoot}`)
console.log(`Aircraft discovered: ${cache.aircraft.length}`)
console.log(`Asset files indexed: ${cache.assetManifest.files.length}`)
console.log(`Diagnostics: ${cache.diagnostics.length}`)
console.log(`Cache written: ${result.outputPath}`)

function printUsage(): void {
  console.log('Usage: bun run import:msfs2020 -- <package-root-or-aircraft-dir> [--out <dir>]')
}
