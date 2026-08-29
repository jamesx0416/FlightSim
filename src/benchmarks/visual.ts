import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { PNG } from 'pngjs'

export const CUBEMAP_FACE_NAMES = ['front', 'back', 'left', 'right', 'up', 'down'] as const
export type CubemapFaceName = typeof CUBEMAP_FACE_NAMES[number]
export type CubemapFacePaths = Readonly<Record<CubemapFaceName, string>>

export type VisualDifference = {
  readonly changedPixels: number
  readonly totalPixels: number
  readonly changedRatio: number
  readonly meanChannelDifference: number
  readonly maximumChannelDifference: number
  readonly differencePath: string
}

type PanoramaDimensions = {
  readonly faceSize?: number
  readonly width?: number
  readonly height?: number
}

const FACE_SIZE = 1_024
const PANORAMA_WIDTH = 4_096
const PANORAMA_HEIGHT = 2_048

function pixelIndex(width: number, x: number, y: number): number {
  return (y * width + x) * 4
}

function sampleFace(face: PNG, u: number, v: number, output: PNG, outputIndex: number): void {
  const x = Math.max(0, Math.min(face.width - 1, Math.round((u + 1) * 0.5 * (face.width - 1))))
  const y = Math.max(0, Math.min(face.height - 1, Math.round((1 - (v + 1) * 0.5) * (face.height - 1))))
  const sourceIndex = pixelIndex(face.width, x, y)
  output.data[outputIndex] = face.data[sourceIndex]!
  output.data[outputIndex + 1] = face.data[sourceIndex + 1]!
  output.data[outputIndex + 2] = face.data[sourceIndex + 2]!
  output.data[outputIndex + 3] = face.data[sourceIndex + 3]!
}

function selectFace(x: number, y: number, z: number): { readonly name: CubemapFaceName; readonly u: number; readonly v: number } {
  const absoluteX = Math.abs(x)
  const absoluteY = Math.abs(y)
  const absoluteZ = Math.abs(z)
  if (absoluteX >= absoluteY && absoluteX >= absoluteZ) {
    return x >= 0
      ? { name: 'right', u: z / absoluteX, v: y / absoluteX }
      : { name: 'left', u: -z / absoluteX, v: y / absoluteX }
  }
  if (absoluteY >= absoluteX && absoluteY >= absoluteZ) {
    return y >= 0
      ? { name: 'up', u: x / absoluteY, v: -z / absoluteY }
      : { name: 'down', u: x / absoluteY, v: z / absoluteY }
  }
  return z < 0
    ? { name: 'front', u: x / absoluteZ, v: y / absoluteZ }
    : { name: 'back', u: -x / absoluteZ, v: y / absoluteZ }
}

/** Stitches six canonical 90-degree cubemap faces into the agreed equirectangular artifact. */
export async function stitchEquirectangularPanorama(
  facePaths: CubemapFacePaths,
  outputPath: string,
  dimensions: PanoramaDimensions = {}
): Promise<string> {
  const faceSize = dimensions.faceSize ?? FACE_SIZE
  const width = dimensions.width ?? PANORAMA_WIDTH
  const height = dimensions.height ?? PANORAMA_HEIGHT
  const faces = Object.fromEntries(await Promise.all(CUBEMAP_FACE_NAMES.map(async name => {
    const face = PNG.sync.read(await readFile(facePaths[name]))
    if (face.width !== faceSize || face.height !== faceSize) {
      throw new Error(`${name} cubemap face must be ${faceSize} by ${faceSize}, received ${face.width} by ${face.height}.`)
    }
    return [name, face] as const
  }))) as unknown as Record<CubemapFaceName, PNG>

  const panorama = new PNG({ width, height })
  for (let outputY = 0; outputY < height; outputY += 1) {
    const latitude = Math.PI / 2 - ((outputY + 0.5) / height) * Math.PI
    const cosLatitude = Math.cos(latitude)
    for (let outputX = 0; outputX < width; outputX += 1) {
      const longitude = ((outputX + 0.5) / width) * Math.PI * 2 - Math.PI
      const directionX = Math.sin(longitude) * cosLatitude
      const directionY = Math.sin(latitude)
      const directionZ = -Math.cos(longitude) * cosLatitude
      const selected = selectFace(directionX, directionY, directionZ)
      sampleFace(faces[selected.name], selected.u, selected.v, panorama, pixelIndex(width, outputX, outputY))
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, PNG.sync.write(panorama))
  return outputPath
}

export async function comparePanoramas(
  baselinePath: string,
  candidatePath: string,
  differencePath: string
): Promise<VisualDifference> {
  const [baseline, candidate] = await Promise.all([
    readFile(baselinePath).then(value => PNG.sync.read(value)),
    readFile(candidatePath).then(value => PNG.sync.read(value))
  ])
  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    throw new Error('Visual comparison images must have identical dimensions.')
  }

  const difference = new PNG({ width: baseline.width, height: baseline.height })
  let changedPixels = 0
  let totalDifference = 0
  let maximumChannelDifference = 0
  for (let index = 0; index < baseline.data.length; index += 4) {
    let pixelChanged = false
    for (let channel = 0; channel < 3; channel += 1) {
      const channelDifference = Math.abs(baseline.data[index + channel]! - candidate.data[index + channel]!)
      totalDifference += channelDifference
      maximumChannelDifference = Math.max(maximumChannelDifference, channelDifference)
      pixelChanged ||= channelDifference > 0
      difference.data[index + channel] = channelDifference
    }
    difference.data[index + 3] = 255
    if (pixelChanged) changedPixels += 1
  }
  await mkdir(path.dirname(differencePath), { recursive: true })
  await writeFile(differencePath, PNG.sync.write(difference))
  const totalPixels = baseline.width * baseline.height
  return {
    changedPixels,
    totalPixels,
    changedRatio: changedPixels / totalPixels,
    meanChannelDifference: totalDifference / (totalPixels * 3),
    maximumChannelDifference,
    differencePath
  }
}
