/**
 * The narrow Agent Browser boundary used by benchmark commands. Keeping the
 * process invocation here makes session and tab ownership enforceable.
 */

export const DEFAULT_BROWSER_TIMEOUT_MS = 120_000

const SESSION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u
const SESSION_PART_PATTERN = /[^a-zA-Z0-9]+/gu

export type BrowserDriverErrorCode =
  | 'BROWSER_COMMAND_FAILED'
  | 'BROWSER_COMMAND_TIMED_OUT'
  | 'BROWSER_INVALID_OUTPUT'
  | 'BROWSER_TAB_INVARIANT'
  | 'BROWSER_INVALID_ARGUMENT'

export class BrowserDriverError extends Error {
  readonly name = 'BrowserDriverError'

  constructor(
    readonly code: BrowserDriverErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message)
  }
}

export type AgentBrowserCommand = {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly stdin?: string
  readonly timeoutMs: number
}

export type AgentBrowserCommandResult = {
  readonly command: AgentBrowserCommand
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

export type AgentBrowserCommandRunner = (
  command: AgentBrowserCommand
) => Promise<AgentBrowserCommandResult>

export type BrowserSessionIdentity = {
  readonly worktree: string
  readonly agentId: string
  readonly queueSequence: number | string
}

export type BrowserDriverOptions = {
  /** An already-derived session retained by the queue/lease owner. */
  readonly session?: string
  /** Used only when `session` is omitted. */
  readonly sessionIdentity?: BrowserSessionIdentity
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly executable?: string
  readonly runner?: AgentBrowserCommandRunner
}

export type AgentBrowserTab = Readonly<Record<string, unknown>>

export type AgentBrowserSessionInspection = {
  readonly session: string
  readonly raw: unknown
}

export type BrowserOpenResult = {
  readonly command: AgentBrowserCommandResult
  readonly tabs: readonly AgentBrowserTab[]
}

export type BrowserScreenshotResult = {
  readonly command: AgentBrowserCommandResult
  readonly path: string | null
}

type BunSubprocess = {
  readonly stdin: {
    write(data: string): void
    end(): void
  }
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(): void
}

type BunRuntime = {
  spawn(
    command: readonly string[],
    options: {
      readonly cwd?: string
      readonly stdin: 'ignore' | 'pipe'
      readonly stdout: 'pipe'
      readonly stderr: 'pipe'
    }
  ): BunSubprocess
}

/**
 * Produces a shell-safe, deterministic session name scoped to a lease owner.
 * The worktree fingerprint prevents similarly named worktrees from colliding.
 */
export function deriveBrowserSessionName(identity: BrowserSessionIdentity): string {
  const worktree = identity.worktree.trim()
  const agentId = normalizeSessionPart(identity.agentId, 'agent')
  const queueSequence = normalizeSessionPart(String(identity.queueSequence), 'queue')
  if (!worktree) {
    throw new BrowserDriverError('BROWSER_INVALID_ARGUMENT', 'A worktree is required to derive an Agent Browser session.')
  }

  return `flightsim-${fingerprint(worktree)}-${agentId}-${queueSequence}`.slice(0, 96)
}

/** Runs Agent Browser commands without a shell and keeps one tab pinned to this session. */
export class BrowserDriver {
  readonly session: string
  readonly cwd: string | undefined
  readonly timeoutMs: number

  private readonly executable: string
  private readonly runner: AgentBrowserCommandRunner

  constructor(options: BrowserDriverOptions) {
    this.session = validateSessionName(options.session ?? deriveSessionName(options.sessionIdentity))
    this.cwd = options.cwd
    this.timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS)
    this.executable = options.executable ?? 'agent-browser'
    this.runner = options.runner ?? runAgentBrowserCommand
  }

  async open(url: string, timeoutMs = this.timeoutMs): Promise<BrowserOpenResult> {
    const parsed = parseBrowserUrl(url)
    const command = await this.runChecked(['open', parsed.href], timeoutMs)
    const tabs = await this.assertExactlyOneTab(timeoutMs)
    return { command, tabs }
  }

  async close(timeoutMs = this.timeoutMs): Promise<AgentBrowserCommandResult> {
    return this.run(['close'], timeoutMs)
  }

  /** Evaluates page JavaScript through stdin so source is never interpreted by a shell. */
  async eval(source: string, timeoutMs = this.timeoutMs): Promise<AgentBrowserCommandResult> {
    if (!source.trim()) {
      throw new BrowserDriverError('BROWSER_INVALID_ARGUMENT', 'Browser eval source must not be empty.')
    }
    return this.runChecked(['eval', '--stdin'], timeoutMs, source)
  }

  /** Evaluates an expression and decodes the JSON value it returns. */
  async evalJson<T>(expression: string, timeoutMs = this.timeoutMs): Promise<T> {
    const result = await this.eval(`(async () => JSON.stringify(await (${expression})))()`, timeoutMs)
    return decodeEvalJson<T>(result.stdout)
  }

  async waitFn(condition: string, timeoutMs = this.timeoutMs): Promise<AgentBrowserCommandResult> {
    if (!condition.trim()) {
      throw new BrowserDriverError('BROWSER_INVALID_ARGUMENT', 'Browser wait condition must not be empty.')
    }
    return this.runChecked(['wait', '--fn', condition, '--timeout', String(validateTimeout(timeoutMs))], timeoutMs)
  }

  async screenshot(path?: string, selector?: string, timeoutMs = this.timeoutMs): Promise<BrowserScreenshotResult> {
    const args = ['screenshot', ...(selector == null ? [] : [selector]), ...(path == null ? [] : [path])]
    const command = await this.runChecked(args, timeoutMs)
    return { command, path: readScreenshotPath(command.stdout) ?? path ?? null }
  }

  async setViewport(width: number, height: number, timeoutMs = this.timeoutMs): Promise<AgentBrowserCommandResult> {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new BrowserDriverError('BROWSER_INVALID_ARGUMENT', 'Viewport width and height must be positive integers.')
    }
    return this.runChecked(['set', 'viewport', String(width), String(height)], timeoutMs)
  }

  async startProfile(timeoutMs = this.timeoutMs): Promise<AgentBrowserCommandResult> {
    return this.runChecked(['profiler', 'start'], timeoutMs)
  }

  async stopProfile(path: string, timeoutMs = this.timeoutMs): Promise<AgentBrowserCommandResult> {
    if (!path.trim()) throw new BrowserDriverError('BROWSER_INVALID_ARGUMENT', 'Profile output path is required.')
    return this.runChecked(['profiler', 'stop', path], timeoutMs)
  }

  async inspectSession(timeoutMs = this.timeoutMs): Promise<AgentBrowserSessionInspection> {
    const result = await this.run(['session', 'info'], timeoutMs)
    await this.assertExactlyOneTab(timeoutMs)
    return { session: this.session, raw: parseJsonOutput(result.stdout) }
  }

  async tabs(timeoutMs = this.timeoutMs): Promise<readonly AgentBrowserTab[]> {
    const result = await this.run(['tab', 'list'], timeoutMs)
    return extractTabs(parseJsonOutput(result.stdout))
  }

  private async assertExactlyOneTab(timeoutMs: number): Promise<readonly AgentBrowserTab[]> {
    const tabs = await this.tabs(timeoutMs)
    if (tabs.length !== 1) {
      throw new BrowserDriverError(
        'BROWSER_TAB_INVARIANT',
        `Agent Browser session ${this.session} must contain exactly one tab; found ${tabs.length}.`,
        { session: this.session, tabCount: tabs.length, tabs }
      )
    }
    return tabs
  }

  private async runChecked(
    args: readonly string[],
    timeoutMs: number,
    stdin?: string
  ): Promise<AgentBrowserCommandResult> {
    const result = await this.run(args, timeoutMs, stdin)
    await this.assertExactlyOneTab(timeoutMs)
    return result
  }

  private async run(
    args: readonly string[],
    timeoutMs: number,
    stdin?: string
  ): Promise<AgentBrowserCommandResult> {
    const command: AgentBrowserCommand = {
      executable: this.executable,
      args: ['--session', this.session, '--pin-tab', '--json', ...args],
      ...(this.cwd == null ? {} : { cwd: this.cwd }),
      ...(stdin == null ? {} : { stdin }),
      timeoutMs: validateTimeout(timeoutMs)
    }

    let result: AgentBrowserCommandResult
    try {
      result = await this.runner(command)
    } catch (error) {
      throw new BrowserDriverError(
        'BROWSER_COMMAND_FAILED',
        `Could not start Agent Browser: ${errorMessage(error)}`,
        { command: command.args }
      )
    }

    if (result.timedOut) {
      throw new BrowserDriverError(
        'BROWSER_COMMAND_TIMED_OUT',
        `Agent Browser timed out after ${command.timeoutMs}ms.`,
        commandDetails(result)
      )
    }
    if (result.exitCode !== 0) {
      throw new BrowserDriverError(
        'BROWSER_COMMAND_FAILED',
        `Agent Browser exited with status ${result.exitCode}: ${conciseOutput(result.stderr, result.stdout)}`,
        commandDetails(result)
      )
    }
    return result
  }
}

/** The production runner. Tests normally inject an in-memory runner. */
export async function runAgentBrowserCommand(command: AgentBrowserCommand): Promise<AgentBrowserCommandResult> {
  const startedAt = performance.now()
  const bun = (globalThis as { readonly Bun?: BunRuntime }).Bun
  if (bun == null) {
    throw new BrowserDriverError('BROWSER_COMMAND_FAILED', 'Agent Browser requires the Bun runtime.')
  }
  const process = bun.spawn([command.executable, ...command.args], {
    cwd: command.cwd,
    stdin: command.stdin == null ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    process.kill()
  }, command.timeoutMs)

  try {
    if (command.stdin != null) {
      process.stdin.write(command.stdin)
      process.stdin.end()
    }
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text()
    ])
    return {
      command,
      exitCode,
      stdout,
      stderr,
      durationMs: performance.now() - startedAt,
      timedOut
    }
  } finally {
    clearTimeout(timeout)
  }
}

function deriveSessionName(identity: BrowserSessionIdentity | undefined): string {
  if (identity == null) {
    throw new BrowserDriverError(
      'BROWSER_INVALID_ARGUMENT',
      'BrowserDriver requires a retained session or a worktree, agent, and queue identity.'
    )
  }
  return deriveBrowserSessionName(identity)
}

function validateSessionName(session: string): string {
  if (!SESSION_NAME_PATTERN.test(session)) {
    throw new BrowserDriverError('BROWSER_INVALID_ARGUMENT', 'Agent Browser session names must be 1-96 safe characters.')
  }
  return session
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new BrowserDriverError('BROWSER_INVALID_ARGUMENT', 'Browser timeout must be a positive number of milliseconds.')
  }
  return Math.floor(timeoutMs)
}

function normalizeSessionPart(value: string, fallback: string): string {
  const normalized = value.trim().replace(SESSION_PART_PATTERN, '-').replace(/^-+|-+$/gu, '')
  return (normalized || fallback).slice(0, 28)
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function parseBrowserUrl(value: string): URL {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP(S) URLs are supported.')
    }
    return url
  } catch (error) {
    throw new BrowserDriverError('BROWSER_INVALID_ARGUMENT', `Invalid browser URL: ${errorMessage(error)}`)
  }
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output) as unknown
  } catch {
    throw new BrowserDriverError('BROWSER_INVALID_OUTPUT', 'Agent Browser returned invalid JSON.', { output })
  }
}

function decodeEvalJson<T>(output: string): T {
  const decoded = parseJsonOutput(output)
  const value = unwrapEvalResult(decoded)
  if (typeof value !== 'string') {
    throw new BrowserDriverError('BROWSER_INVALID_OUTPUT', 'Agent Browser eval did not return a JSON string.', { output })
  }
  try {
    return JSON.parse(value) as T
  } catch {
    throw new BrowserDriverError('BROWSER_INVALID_OUTPUT', 'Agent Browser eval returned invalid JSON.', { output })
  }
}

function unwrapEvalResult(value: unknown): unknown {
  if (!isRecord(value)) return value
  for (const key of ['value', 'result', 'data'] as const) {
    if (key in value) return unwrapEvalResult(value[key])
  }
  return value
}

function extractTabs(value: unknown): readonly AgentBrowserTab[] {
  const candidate = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tabs)
      ? value.tabs
      : isRecord(value) && isRecord(value.data) && Array.isArray(value.data.tabs)
        ? value.data.tabs
        : null
  if (candidate == null || !candidate.every(isRecord)) {
    throw new BrowserDriverError('BROWSER_INVALID_OUTPUT', 'Agent Browser tab list did not contain tabs.', { value })
  }
  return candidate
}

function readScreenshotPath(value: string): string | null {
  const parsed = tryParseJson(value)
  if (typeof parsed === 'string') return parsed
  if (isRecord(parsed)) {
    for (const key of ['path', 'file'] as const) {
      if (typeof parsed[key] === 'string') return parsed[key]
    }
    if (isRecord(parsed.data) && typeof parsed.data.path === 'string') return parsed.data.path
  }
  return null
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function conciseOutput(stderr: string, stdout: string): string {
  return (stderr || stdout).trim().replace(/\s+/gu, ' ').slice(0, 500) || 'no diagnostic output'
}

function commandDetails(result: AgentBrowserCommandResult): Readonly<Record<string, unknown>> {
  return {
    command: result.command.args,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
