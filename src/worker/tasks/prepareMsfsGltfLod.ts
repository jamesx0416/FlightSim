import { sanitizeMsfsGltf } from '../../msfs/gltf/sanitizeMsfsGltf'
import { Transfer, type TransferResult } from '../transfer'

type WorkerPhase = {
  readonly label: string
  readonly durationMs: number
  readonly details: Record<string, unknown> | null
}

type PreparedExternalBuffer = {
  readonly index: number
  readonly buffer: ArrayBuffer
  readonly byteLength: number
}

type PreparedMsfsGltfLod = {
  readonly gltfJson: Record<string, unknown>
  readonly buffers: readonly PreparedExternalBuffer[]
  readonly phases: readonly WorkerPhase[]
}

const GLTF_BUFFER_CHUNK_BYTES = 256 * 1024
const GLTF_BUFFER_CHUNK_TIMEOUT_MS = 60000
const GLTF_BUFFER_CHUNK_CONCURRENCY = 6

export async function prepareMsfsGltfLod(
  url: string
): Promise<TransferResult<PreparedMsfsGltfLod>> {
  const phases: WorkerPhase[] = []
  const recordPhase = (
    label: string,
    startMs: number,
    details: Record<string, unknown> | null = null
  ): void => {
    phases.push({
      label,
      durationMs: performance.now() - startMs,
      details
    })
  }

  const fetchStartMs = performance.now()
  const response = await fetch(url)
  recordPhase('worker:lod:fetch', fetchStartMs, {
    httpStatus: response.status,
    ok: response.ok
  })
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${response.status}`)
  }

  const contentLengthHeader = response.headers.get('content-length')
  const contentLength =
    contentLengthHeader == null ? null : Number.parseInt(contentLengthHeader, 10)
  const jsonStartMs = performance.now()
  const gltfJson = (await response.json()) as Record<string, unknown>
  recordPhase('worker:lod:parse-json', jsonStartMs, {
    byteLength: Number.isFinite(contentLength) ? contentLength : null
  })

  const sanitizeStartMs = performance.now()
  const sanitizedGltf = sanitizeMsfsGltf(gltfJson)
  recordPhase('worker:lod:sanitize-msfs-gltf', sanitizeStartMs)

  const bufferStartMs = performance.now()
  const buffers = await fetchExternalGltfBuffers(sanitizedGltf, url)
  recordPhase('worker:lod:fetch-buffers', bufferStartMs, {
    bufferCount: buffers.length,
    byteLength: buffers.reduce((total, buffer) => total + buffer.byteLength, 0)
  })

  return Transfer(
    {
      gltfJson: sanitizedGltf,
      buffers,
      phases
    },
    buffers.map(buffer => buffer.buffer)
  )
}

async function fetchExternalGltfBuffers(
  gltfJson: Record<string, unknown>,
  gltfUrl: string
): Promise<PreparedExternalBuffer[]> {
  const buffers = Array.isArray(gltfJson.buffers)
    ? gltfJson.buffers as Array<Record<string, unknown>>
    : []
  const baseUrl = gltfUrl.slice(0, gltfUrl.lastIndexOf('/') + 1)
  const externalBuffers = buffers
    .map((buffer, index) => ({ buffer, index, uri: buffer.uri }))
    .filter((entry): entry is {
      readonly buffer: Record<string, unknown>
      readonly index: number
      readonly uri: string
    } => typeof entry.uri === 'string' && !isEmbeddedGltfBufferUri(entry.uri))

  return Promise.all(externalBuffers.map(async ({ index, uri }) => {
    const bufferUrl = new URL(uri, baseUrl).toString()
    const arrayBuffer = await fetchExternalGltfBuffer(bufferUrl)
    return {
      index,
      buffer: arrayBuffer,
      byteLength: arrayBuffer.byteLength
    }
  }))
}

async function fetchExternalGltfBuffer(url: string): Promise<ArrayBuffer> {
  const requestUrl = appendGltfBufferCacheBuster(url)
  const firstEnd = GLTF_BUFFER_CHUNK_BYTES - 1
  const firstResponse = await fetchExternalGltfBufferRange(requestUrl, 0, firstEnd)
  if (firstResponse.status !== 206) {
    if (!firstResponse.ok) {
      throw new Error(`Failed to load ${url}: HTTP ${firstResponse.status}`)
    }
    return firstResponse.buffer
  }

  const firstRange = parseContentRange(firstResponse.contentRange)
  if (firstRange == null) {
    return firstResponse.buffer
  }

  const output = new Uint8Array(firstRange.size)
  output.set(new Uint8Array(firstResponse.buffer), 0)
  const ranges: Array<{ readonly start: number; readonly end: number }> = []
  for (let start = firstRange.end + 1; start < firstRange.size; start += GLTF_BUFFER_CHUNK_BYTES) {
    ranges.push({
      start,
      end: Math.min(start + GLTF_BUFFER_CHUNK_BYTES - 1, firstRange.size - 1)
    })
  }

  let nextRangeIndex = 0
  const loadNextRange = async (): Promise<void> => {
    while (nextRangeIndex < ranges.length) {
      const range = ranges[nextRangeIndex]!
      nextRangeIndex += 1
      const { start, end } = range
      const response = await fetchExternalGltfBufferRange(requestUrl, start, end)
      if (response.status !== 206 && !response.ok) {
        throw new Error(`Failed to load ${url}: HTTP ${response.status}`)
      }
      output.set(new Uint8Array(response.buffer), start)
    }
  }

  await Promise.all(
    Array.from({
      length: Math.min(GLTF_BUFFER_CHUNK_CONCURRENCY, ranges.length)
    }, () => loadNextRange())
  )
  return output.buffer
}

async function fetchExternalGltfBufferRange(
  url: string,
  start: number,
  end: number
): Promise<{
  readonly ok: boolean
  readonly status: number
  readonly contentRange: string | null
  readonly buffer: ArrayBuffer
}> {
  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(),
    GLTF_BUFFER_CHUNK_TIMEOUT_MS
  )
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: {
        Range: `bytes=${start}-${end}`
      },
      signal: controller.signal
    })
    const buffer = await response.arrayBuffer()
    return {
      ok: response.ok,
      status: response.status,
      contentRange: response.headers.get('content-range'),
      buffer
    }
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

function appendGltfBufferCacheBuster(url: string): string {
  const parsedUrl = new URL(url, globalThis.location.href)
  parsedUrl.searchParams.set('msfsBufferLoad', Math.random().toString(36).slice(2))
  return parsedUrl.toString()
}

function parseContentRange(header: string | null): {
  readonly start: number
  readonly end: number
  readonly size: number
} | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/iu.exec(header ?? '')
  if (match == null) {
    return null
  }

  return {
    start: Number.parseInt(match[1]!, 10),
    end: Number.parseInt(match[2]!, 10),
    size: Number.parseInt(match[3]!, 10)
  }
}

function isEmbeddedGltfBufferUri(uri: string): boolean {
  return uri.startsWith('data:') || uri.startsWith('blob:')
}
