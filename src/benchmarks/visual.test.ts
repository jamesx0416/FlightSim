import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { PNG } from 'pngjs'

import { CUBEMAP_FACE_NAMES, comparePanoramas, stitchEquirectangularPanorama, type CubemapFaceName } from './visual'

test('stitches canonical faces and reports exact pixel differences', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'flightsim-visual-test-'))
  try {
  const colors: Record<CubemapFaceName, readonly [number, number, number]> = {
    front: [255, 0, 0], back: [0, 255, 0], left: [0, 0, 255],
    right: [255, 255, 0], up: [255, 0, 255], down: [0, 255, 255]
  }
  const faces = Object.fromEntries(await Promise.all(CUBEMAP_FACE_NAMES.map(async name => {
    const image = new PNG({ width: 16, height: 16 })
    for (let index = 0; index < image.data.length; index += 4) {
      image.data[index] = colors[name][0]
      image.data[index + 1] = colors[name][1]
      image.data[index + 2] = colors[name][2]
      image.data[index + 3] = 255
    }
    const facePath = path.join(directory, `${name}.png`)
    await writeFile(facePath, PNG.sync.write(image))
    return [name, facePath] as const
  }))) as Record<CubemapFaceName, string>
  const panorama = await stitchEquirectangularPanorama(
    faces,
    path.join(directory, 'panorama.png'),
    { faceSize: 16, width: 64, height: 32 }
  )
  const identical = await comparePanoramas(panorama, panorama, path.join(directory, 'diff.png'))
  expect(identical.changedPixels).toBe(0)
  expect(identical.meanChannelDifference).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
