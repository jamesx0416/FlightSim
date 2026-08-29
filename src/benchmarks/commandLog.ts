import { createHash } from 'node:crypto'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { withAtomicFileLock, type ProcessLiveness } from './queue'

export type CommandHook =
  | { readonly kind: 'inline'; readonly source: string }
  | { readonly kind: 'file'; readonly path: string; readonly source: string }

export type SanitizedCommandHook =
  | { readonly kind: 'inline'; readonly hash: string }
  | { readonly kind: 'file'; readonly path: string; readonly hash: string }

export type CommandLogInput = {
  readonly timestamp?: string
  readonly owner: string
  readonly operation: string
  readonly arguments?: unknown
  readonly sessionName?: string
  readonly exitStatus?: number
  readonly durationMs?: number
  readonly error?: {
    readonly code?: string
    readonly message: string
  }
  readonly artifactDirectory?: string
  readonly beforeHook?: CommandHook
  readonly afterHook?: CommandHook
}

export type CommandLogRecord = {
  readonly timestamp: string
  readonly owner: string
  readonly operation: string
  readonly arguments: JsonValue
  readonly sessionName?: string
  readonly exitStatus?: number
  readonly durationMs?: number
  readonly error?: {
    readonly code?: string
    readonly message: string
  }
  readonly artifactDirectory?: string
  readonly beforeHook?: SanitizedCommandHook
  readonly afterHook?: SanitizedCommandHook
}

export type CommandLogOptions = {
  /** The ignored default is logs/flightsim-browser-bench.jsonl. */
  readonly filePath?: string
  /** Maximum size of the active file before a new record starts a rotated file. */
  readonly maxBytes?: number
  /** Number of files retained, including the active file. */
  readonly maxFiles?: number
  readonly pid?: number
  readonly isProcessAlive?: ProcessLiveness
}

export type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

const DEFAULT_LOG_PATH = join('logs', 'flightsim-browser-bench.jsonl')
const DEFAULT_MAX_BYTES = 1_000_000
const DEFAULT_MAX_FILES = 5

/** Creates a log-safe representation without retaining the hook source text. */
export function sanitizeCommandHook(hook: CommandHook): SanitizedCommandHook {
  const hash = hashCommandSource(hook.source)
  return hook.kind === 'inline'
    ? { kind: 'inline', hash }
    : { kind: 'file', path: hook.path, hash }
}

export function hashCommandSource(source: string): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`
}

/** Redacts known secrets and converts arbitrary command arguments into JSON-safe data. */
export function sanitizeCommandArguments(argumentsValue: unknown): JsonValue {
  return sanitizeValue(argumentsValue, undefined, new WeakSet<object>(), false)
}

export function createCommandLogRecord(input: CommandLogInput): CommandLogRecord {
  return {
    timestamp: input.timestamp ?? new Date().toISOString(),
    owner: redactString(input.owner),
    operation: redactString(input.operation),
    arguments: sanitizeCommandArguments(input.arguments ?? {}),
    sessionName: input.sessionName == null ? undefined : redactString(input.sessionName),
    exitStatus: input.exitStatus,
    durationMs: input.durationMs,
    error: input.error == null
      ? undefined
      : {
          code: input.error.code == null ? undefined : redactString(input.error.code),
          message: redactString(input.error.message)
        },
    artifactDirectory: input.artifactDirectory == null ? undefined : redactString(input.artifactDirectory),
    beforeHook: input.beforeHook == null ? undefined : sanitizeCommandHook(input.beforeHook),
    afterHook: input.afterHook == null ? undefined : sanitizeCommandHook(input.afterHook)
  }
}

/**
 * Appends compact operational history to an ignored JSONL file. Rotation and append
 * are serialized across processes so records are never split or overwritten.
 */
export class CommandLog {
  readonly #filePath: string
  readonly #maxBytes: number
  readonly #maxFiles: number
  readonly #pid: number
  readonly #isProcessAlive: ProcessLiveness

  constructor(options: CommandLogOptions = {}) {
    this.#filePath = options.filePath ?? DEFAULT_LOG_PATH
    this.#maxBytes = assertPositiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes')
    this.#maxFiles = assertPositiveInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 'maxFiles')
    this.#pid = options.pid ?? process.pid
    this.#isProcessAlive = options.isProcessAlive ?? defaultPidLiveness
  }

  async append(input: CommandLogInput): Promise<CommandLogRecord> {
    const record = createCommandLogRecord(input)
    const line = `${JSON.stringify(record)}\n`
    const directory = dirname(this.#filePath)
    const lockPath = `${this.#filePath}.lock`

    await withAtomicFileLock(lockPath, this.#pid, this.#isProcessAlive, async () => {
      await mkdir(directory, { recursive: true })
      const existingBytes = await fileSize(this.#filePath)
      if (existingBytes > 0 && existingBytes + new TextEncoder().encode(line).byteLength > this.#maxBytes) {
        await rotateLogFiles(this.#filePath, this.#maxFiles)
      }
      await writeFile(this.#filePath, line, { flag: 'a' })
    })

    return record
  }
}

export function createCommandLog(options: CommandLogOptions = {}): CommandLog {
  return new CommandLog(options)
}

async function rotateLogFiles(filePath: string, maxFiles: number): Promise<void> {
  if (maxFiles === 1) {
    await rm(filePath, { force: true })
    return
  }

  await rm(`${filePath}.${maxFiles - 1}`, { force: true })
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    await renameIfPresent(`${filePath}.${index}`, `${filePath}.${index + 1}`)
  }
  await renameIfPresent(filePath, `${filePath}.1`)
}

async function renameIfPresent(source: string, target: string): Promise<void> {
  try {
    await rename(source, target)
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (isMissingFileError(error)) return 0
    throw error
  }
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
  insideHook: boolean
): JsonValue {
  if (isSecretKey(key)) return '[redacted]'
  if (isInlineHookKey(key) && typeof value === 'string') return hashCommandSource(value)
  if (insideHook && key === 'source' && typeof value === 'string') return hashCommandSource(value)
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return '[unsupported]'
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const precedingFlag = value[index - 1]
      if (typeof precedingFlag === 'string' && isSecretFlag(precedingFlag)) return '[redacted]'
      return sanitizeValue(item, undefined, seen, false)
    })
  }
  if (!isRecord(value)) return Object.prototype.toString.call(value)

  const sanitized: Record<string, JsonValue> = {}
  for (const [property, propertyValue] of Object.entries(value)) {
    sanitized[property] = sanitizeValue(propertyValue, property, seen, insideHook || isInlineHookKey(key))
  }
  return sanitized
}

function redactString(value: string): string {
  return value
    .replace(/(https?:\/\/[^\s/:]+:)[^@\s/]+@/gi, '$1[redacted]@')
    .replace(/(authorization\s*[=:]\s*)(?:bearer\s+)?[^\s,;]+(?:\s+[^\s,;]+)?/gi, '$1[redacted]')
    .replace(/((?:token|secret|password|api[_-]?key|authorization|cookie|credential)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
}

function isSecretKey(key: string | undefined): boolean {
  return key != null && /(?:token|secret|password|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i.test(key)
}

function isInlineHookKey(key: string | undefined): boolean {
  return key != null && /^(?:before|after)(?:Hook)?$/i.test(key)
}

function isSecretFlag(value: string): boolean {
  return /^--?(?:[^=]*[-_])?(?:token|secret|password|api[-_]?key|authorization|cookie|credential)(?:=|$)/i.test(value)
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function defaultPidLiveness(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isRecord(error) && (error.code === 'EPERM' || error.code === 'EACCES')
  }
}
