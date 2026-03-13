import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const INPUT_DIR = 'public/aircraft/a32nx/exterior/LOD00-msfs'
const INPUT_GLTF = path.join(INPUT_DIR, 'A320_NEO_LOD00.gltf')
const INPUT_BIN = path.join(INPUT_DIR, 'A320_NEO_LOD00.bin')
const OUTPUT_DIR = 'public/aircraft/a32nx/exterior/LOD00-ktx2'
const OUTPUT_GLTF = path.join(OUTPUT_DIR, 'A320_NEO_LOD00.gltf')
const OUTPUT_BIN = path.join(OUTPUT_DIR, 'A320_NEO_LOD00.bin')

const TOKTX = '/tmp/ktx-tools/usr/local/bin/toktx'
const PYTHON = 'python3'
const DDS_TO_PNG = 'scripts/dds_to_png.py'
const SOLID_PNG = 'scripts/make_solid_png.py'
const TEMP_DIR = '/tmp/a32nx-ktx2'

function run(cmd: string, args: string[]) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${cmd} failed with exit code ${result.status}`)
  }
}

function isSRGB(name: string): boolean {
  const upper = name.toUpperCase()
  return (
    upper.includes('ALBD') ||
    upper.includes('ALBEDO') ||
    upper.includes('LIVERY') ||
    upper.includes('TEXTS') ||
    upper.includes('DECALS') ||
    upper.includes('EMIS')
  )
}

function placeholderColor(name: string): [number, number, number] {
  const upper = name.toUpperCase()
  if (upper.includes('NORM')) return [128, 128, 255]
  if (upper.includes('COMP')) return [0, 255, 255]
  if (upper.includes('MASK')) return [255, 255, 255]
  return [128, 128, 128]
}

const PLACEHOLDER_SIZE = 4

function ensureTempDir() {
  if (existsSync(TEMP_DIR)) return
  mkdirSync(TEMP_DIR, { recursive: true })
}

async function main() {
  if (!existsSync(TOKTX)) {
    throw new Error(`toktx not found at ${TOKTX}. Install KTX-Software tools first.`)
  }

  if (!existsSync(INPUT_GLTF) || !existsSync(INPUT_BIN)) {
    throw new Error('Missing input glTF or .bin in public/aircraft/a32nx/exterior/LOD00-msfs')
  }

  mkdirSync(OUTPUT_DIR, { recursive: true })
  ensureTempDir()

  const json = JSON.parse(readFileSync(INPUT_GLTF, 'utf8'))

  const images = json.images ?? []
  const missing: string[] = []
  const converted: string[] = []

  for (let i = 0; i < images.length; i++) {
    const image = images[i]
    const uri: string | undefined = image?.uri
    if (!uri) continue

    const inputPath = path.join(INPUT_DIR, uri)
    const outputName = uri.replace(/\.DDS$/i, '.ktx2')
    const outputPath = path.join(OUTPUT_DIR, outputName)

    const tempPng = path.join(TEMP_DIR, `${outputName}.png`)

    if (existsSync(outputPath)) rmSync(outputPath, { force: true })

    if (existsSync(inputPath)) {
      run(PYTHON, [DDS_TO_PNG, inputPath, tempPng])
      const args = [
        '--encode',
        'etc1s',
        '--genmipmap',
        '--assign_oetf',
        isSRGB(outputName) ? 'srgb' : 'linear',
        outputPath,
        tempPng
      ]
      run(TOKTX, args)
      rmSync(tempPng, { force: true })
    } else {
      missing.push(uri)
      const [r, g, b] = placeholderColor(outputName)
      run(PYTHON, [SOLID_PNG, tempPng, String(PLACEHOLDER_SIZE), String(r), String(g), String(b)])
      const args = [
        '--encode',
        'etc1s',
        '--genmipmap',
        '--assign_oetf',
        isSRGB(outputName) ? 'srgb' : 'linear',
        outputPath,
        tempPng
      ]
      run(TOKTX, args)
      rmSync(tempPng, { force: true })
    }

    converted.push(outputName)
    image.uri = outputName
    image.mimeType = 'image/ktx2'
  }

  if (Array.isArray(json.textures)) {
    for (const texture of json.textures) {
      const ext = texture.extensions ?? {}
      const msft = ext.MSFT_texture_dds
      if (msft && msft.source != null) {
        ext.KHR_texture_basisu = { source: msft.source }
      }
      delete ext.MSFT_texture_dds
      if (Object.keys(ext).length === 0) {
        delete texture.extensions
      } else {
        texture.extensions = ext
      }
      if ('source' in texture) {
        delete texture.source
      }
    }
  }

  const used = new Set<string>(json.extensionsUsed ?? [])
  used.delete('MSFT_texture_dds')
  used.add('KHR_texture_basisu')
  json.extensionsUsed = Array.from(used)

  if (Array.isArray(json.extensionsRequired)) {
    const required = new Set<string>(json.extensionsRequired)
    required.delete('MSFT_texture_dds')
    required.add('KHR_texture_basisu')
    json.extensionsRequired = Array.from(required)
  } else {
    json.extensionsRequired = ['KHR_texture_basisu']
  }

  writeFileSync(OUTPUT_GLTF, JSON.stringify(json, null, 2))
  copyFileSync(INPUT_BIN, OUTPUT_BIN)

  const manifest = {
    available: converted,
    missing
  }
  writeFileSync(path.join(OUTPUT_DIR, 'texture-manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`Wrote ${OUTPUT_GLTF}`)
  console.log(`Wrote ${OUTPUT_BIN}`)
  if (missing.length) {
    console.log(`Missing source DDS: ${missing.length}`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
