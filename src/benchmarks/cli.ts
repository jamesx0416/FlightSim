/**
 * The public command grammar for the browser lifecycle and benchmark CLIs.
 * Execution, browser control, and Git worktree handling intentionally live elsewhere.
 */

export type HookSource =
  | { readonly kind: 'inline'; readonly source: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'stdin' }

export interface BenchmarkHooks {
  readonly before?: HookSource
  readonly after?: HookSource
}

export interface HelpOption {
  readonly usage: string
  readonly description: string
}

export interface CliHelp {
  readonly name: 'browser' | 'bench'
  readonly summary: string
  readonly usage: readonly string[]
  readonly sections?: readonly { readonly title: string; readonly lines: readonly string[] }[]
  readonly options: readonly HelpOption[]
}

export interface BrowserOpenCommand {
  readonly kind: 'browser-open'
  readonly stage: string
  readonly timeoutMs: number
  readonly slot?: number
  readonly json: boolean
}

export interface BrowserCloseCommand {
  readonly kind: 'browser-close'
  readonly slot?: number
  readonly json: boolean
}

export interface BrowserStatusCommand {
  readonly kind: 'browser-status'
  readonly json: boolean
}

export interface BrowserConcurrencyCommand {
  readonly kind: 'browser-concurrency'
  readonly capacity?: number
  readonly json: boolean
}

export interface BrowserEvalCommand {
  readonly kind: 'browser-eval'
  readonly source: HookSource
  readonly slot?: number
  readonly json: boolean
}

export type BrowserCommand = BrowserOpenCommand | BrowserCloseCommand | BrowserEvalCommand | BrowserStatusCommand | BrowserConcurrencyCommand

interface CommonBenchmarkCommand {
  readonly slot?: number
  readonly json: boolean
}

interface FrameBenchmarkCommand extends CommonBenchmarkCommand {
  readonly frames?: number
  readonly warmupFrames?: number
}

export interface BrowserBenchmarkCommand extends CommonBenchmarkCommand {
  readonly stage: string
  readonly timeoutMs: number
  readonly reuse: boolean
  readonly settleMs?: number
  readonly keepOpen: boolean
  readonly hooks: BenchmarkHooks
}

type BrowserBenchmarkOptions = Omit<BrowserBenchmarkCommand, 'kind'>

export interface CompiledBenchmarkCommand extends FrameBenchmarkCommand {
  readonly kind: 'compiled'
}

export interface BunNoRenderBenchmarkCommand extends FrameBenchmarkCommand {
  readonly kind: 'no-render-bun'
}

export interface BrowserNoRenderBenchmarkCommand extends BrowserBenchmarkCommand, FrameBenchmarkCommand {
  readonly kind: 'no-render-browser'
}

export interface BrowserLoadBenchmarkCommand extends CommonBenchmarkCommand {
  readonly kind: 'browser-load'
  readonly stage: string
  readonly timeoutMs: number
  readonly keepOpen: boolean
}

export interface BrowserFpsBenchmarkCommand extends BrowserBenchmarkCommand, FrameBenchmarkCommand {
  readonly kind: 'browser-fps'
}

export interface BrowserFullBenchmarkCommand extends BrowserBenchmarkCommand, FrameBenchmarkCommand {
  readonly kind: 'browser-full'
}

export interface BrowserProfileBenchmarkCommand extends BrowserBenchmarkCommand, FrameBenchmarkCommand {
  readonly kind: 'browser-profile'
}

export interface BrowserVisualBenchmarkCommand extends BrowserBenchmarkCommand {
  readonly kind: 'browser-visual'
}

export type BenchmarkCommand =
  | CompiledBenchmarkCommand
  | BunNoRenderBenchmarkCommand
  | BrowserNoRenderBenchmarkCommand
  | BrowserLoadBenchmarkCommand
  | BrowserFpsBenchmarkCommand
  | BrowserFullBenchmarkCommand
  | BrowserProfileBenchmarkCommand
  | BrowserVisualBenchmarkCommand

export interface ComparisonSelection {
  readonly baseline: string
  readonly candidate: string
}

export interface ExperimentOptions {
  readonly name: string
  readonly description?: string
  readonly aim?: string
  readonly cause?: string
  readonly hypothesis?: string
}

interface CommonComparisonCommand extends CommonBenchmarkCommand, ComparisonSelection {
  readonly kind: `compare-${string}`
  readonly experiment?: ExperimentOptions
}

interface FrameComparisonCommand extends CommonComparisonCommand, FrameBenchmarkCommand {}

interface BrowserComparisonCommand extends CommonComparisonCommand {
  readonly stage: string
  readonly timeoutMs: number
  readonly hooks: BenchmarkHooks
}

export interface CompareCompiledCommand extends FrameComparisonCommand {
  readonly kind: 'compare-compiled'
}

export interface CompareBunNoRenderCommand extends FrameComparisonCommand {
  readonly kind: 'compare-no-render-bun'
}

export interface CompareBrowserNoRenderCommand extends BrowserComparisonCommand, FrameComparisonCommand {
  readonly kind: 'compare-no-render-browser'
}

export interface CompareBrowserFpsCommand extends BrowserComparisonCommand, FrameComparisonCommand {
  readonly kind: 'compare-browser-fps'
}

export interface CompareBrowserFullCommand extends BrowserComparisonCommand, FrameComparisonCommand {
  readonly kind: 'compare-browser-full'
}

export interface CompareBrowserVisualCommand extends BrowserComparisonCommand {
  readonly kind: 'compare-browser-visual'
}

export type ComparisonCommand =
  | CompareCompiledCommand
  | CompareBunNoRenderCommand
  | CompareBrowserNoRenderCommand
  | CompareBrowserFpsCommand
  | CompareBrowserFullCommand
  | CompareBrowserVisualCommand

export interface BenchStatusCommand { readonly kind: 'bench-status'; readonly json: boolean }
export interface BenchConcurrencyCommand { readonly kind: 'bench-concurrency'; readonly capacity?: number; readonly json: boolean }
export interface ExperimentVerdictCommand { readonly kind: 'experiment-accept' | 'experiment-reject'; readonly id: string; readonly reason: string; readonly json: boolean }

export type BenchCommand = BenchmarkCommand | ComparisonCommand | BenchStatusCommand | BenchConcurrencyCommand | ExperimentVerdictCommand

export interface ParsedCommand<TCommand> {
  readonly kind: 'command'
  readonly command: TCommand
}

export interface HelpResult {
  readonly kind: 'help'
  readonly help: CliHelp
}

export interface ParseError {
  readonly code: 'INVALID_ARGUMENTS'
  readonly message: string
}

export interface InvalidArgumentsResult {
  readonly kind: 'error'
  readonly error: ParseError
  readonly help: CliHelp
}

export type CliParseResult<TCommand> = ParsedCommand<TCommand> | HelpResult | InvalidArgumentsResult

export const DEFAULT_BROWSER_TIMEOUT_MS = 120_000
export const DEFAULT_COMPARISON_BROWSER_TIMEOUT_MS = 180_000
export const DEFAULT_BROWSER_VISUAL_TIMEOUT_MS = 180_000
export const DEFAULT_REUSE_SETTLE_MS = 2_000
export const DEFAULT_BROWSER_STAGE = 'stable'
export const DEFAULT_BROWSER_VISUAL_STAGE = 'cockpit'
export const DEFAULT_NO_RENDER_BROWSER_STAGE = 'gltf:interior-upgrade:ready'
export const DEFAULT_COMPARISON_BASELINE = 'HEAD'
export const DEFAULT_COMPARISON_CANDIDATE = 'worktree'
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m)$/
const INTEGER_PATTERN = /^\d+$/

export const BROWSER_HELP: CliHelp = {
  name: 'browser',
  summary: 'Manage retained, queue-controlled FlightSim browsers.',
  usage: ['browser open <stage> [options]', 'browser close [options]', 'browser eval <js> [options]', 'browser eval --file <path> [options]', 'browser eval --stdin [options]', 'browser status [--json]', 'browser concurrency [count] [--json]'],
  sections: [
    { title: 'Browser lifecycle', lines: [
      'open <stage>   Open a browser, wait for readiness, and retain it.',
      'close          Close a retained browser. Without --slot, target the lowest retained slot.',
      'eval           Execute JavaScript in an already retained browser. Never opens a browser.'
    ] },
    { title: 'Queue', lines: [
      'browser and bench share a machine-wide numbered slot pool.',
      'concurrency 1  Automatic jobs use slot 1 only. This is the default.',
      'concurrency N  Automatic jobs may use slots 1 through N, always preferring the lowest free slot.',
      '--slot <number> Explicitly use or wait for any positive slot number, even above current concurrency.'
    ] },
    { title: 'Readiness stages', lines: [
      '<stage> may be a built-in alias: initial, compiled, aircraft, cockpit, gauges, stable.',
      'It may also be an exact DevApi load stage such as scene:ready or gltf:interior-upgrade:ready.',
      'Repository-configured stages are defined in src/benchmarks/config.ts.'
    ] }
  ],
  options: [
    { usage: '--timeout <duration>', description: 'Readiness timeout, for example 120s or 500ms.' },
    { usage: '--slot <number>', description: 'Explicitly use or wait for any positive browser slot number.' },
    { usage: '--file <path>', description: 'Read browser eval JavaScript from a file.' },
    { usage: '--stdin', description: 'Read browser eval JavaScript from stdin.' },
    { usage: '--json', description: 'Print the structured result.' }
  ]
}

export const BENCH_HELP: CliHelp = {
  name: 'bench',
  summary: 'Run a FlightSim benchmark or Git comparison.',
  usage: [
    'bench compiled [options]',
    'bench no-render bun [options]',
    'bench no-render browser [options]',
    'bench browser load --stage <stage> [options]',
    'bench browser fps [options]',
    'bench browser visual [options]',
    'bench browser full [options]',
    'bench browser profile [options]',
    'bench compare compiled [options]',
    'bench compare no-render bun [options]',
    'bench compare no-render browser [options]',
    'bench compare browser fps [options]',
    'bench compare browser visual [options]',
    'bench compare browser full [options]',
    'bench experiment accept <id> --reason <text>',
    'bench experiment reject <id> --reason <text>',
    'bench status [--json]',
    'bench concurrency [count] [--json]'
  ],
  sections: [
    { title: 'Browser modes', lines: [
      'load      Measure time to an explicit readiness stage. --stage is required.',
      'fps       Real rendered cockpit FPS/frame-time benchmark. Default stage: stable.',
      'visual    Deterministic cockpit panorama capture. Default stage: cockpit.',
      'full      FPS measurement plus deterministic visual validation. Default stage: stable.',
      'profile   FPS measurement plus Chrome performance profile. Default stage: stable.'
    ] },
    { title: 'Comparison', lines: [
      'compare runs baseline and candidate sequentially in one queue slot.',
      'Defaults: --baseline HEAD and --candidate worktree.',
      'browser full captures visual first, then waits for the FPS stage and takes 3 samples on the same page.'
    ] },
    { title: 'Readiness', lines: [
      '--stage accepts a built-in alias, exact DevApi load stage, or repository-configured stage from src/benchmarks/config.ts.'
    ] },
    { title: 'JavaScript hooks', lines: [
      '--before runs after readiness and before settle, warmup, and measurement.',
      '--after runs immediately after measurement and before full-mode visual capture.'
    ] },
    { title: 'Browser reuse', lines: [
      '--reuse reuses the lowest retained browser. If none exists, it opens one and retains it until 10 minutes idle.',
      '--settle adds settle time when reusing. --keep-open retains a browser after the benchmark.'
    ] },
    { title: 'Queue', lines: [
      'browser and bench share the same slots and concurrency setting.',
      'Without --slot, automatic work uses the lowest available permitted slot.'
    ] },
    { title: 'Experiment recording', lines: [
      '--experiment persists experiment.json, result.json, patch.diff, and append-only experiments.jsonl.',
      'accept and reject update status with one top-level reason.'
    ] }
  ],
  options: [
    { usage: '--stage <stage>', description: 'Built-in alias, exact DevApi stage, or configured stage.' },
    { usage: '--timeout <duration>', description: 'Browser readiness timeout, for example 120s or 500ms.' },
    { usage: '--frames <count>  --warmup <count>', description: 'Measured and warmup frame counts for frame benchmarks.' },
    { usage: '--before <js> | --before-file <path> | --before-stdin', description: 'Hook run after readiness.' },
    { usage: '--after <js> | --after-file <path> | --after-stdin', description: 'Hook run after measurement.' },
    { usage: '--reuse [--settle <duration>]', description: 'Reuse a retained page; an implicitly retained fallback closes after 10 minutes idle.' },
    { usage: '--keep-open', description: 'Retain a browser session after a non-comparison browser benchmark.' },
    { usage: '--slot <number>', description: 'Explicitly use or wait for any positive shared queue slot number.' },
    { usage: '--baseline <revision>  --candidate <revision|worktree>', description: 'Comparison inputs.' },
    { usage: '--experiment <name>', description: 'Persist this comparison as an experiment record.' },
    { usage: '--description <text>  --aim <text>  --cause <text>  --hypothesis <text>', description: 'Experiment metadata.' },
    { usage: '--json', description: 'Print the structured result.' }
  ]
}

export function formatHelp(help: CliHelp): string {
  const lines = [help.summary, '', 'Usage:', ...help.usage.map((usage) => `  ${usage}`)]
  for (const section of help.sections ?? []) {
    lines.push('', `${section.title}:`, ...section.lines.map(line => `  ${line}`))
  }
  lines.push('', 'Options:')
  for (const option of help.options) lines.push(`  ${option.usage}\n    ${option.description}`)
  return lines.join('\n')
}

export function parseBrowserCli(arguments_: readonly string[]): CliParseResult<BrowserCommand> {
  if (requestsHelp(arguments_) || arguments_.length === 0) {
    return { kind: 'help', help: BROWSER_HELP }
  }

  const operation = arguments_[0]
  if (operation === 'open') {
    return parseBrowserOpen(arguments_.slice(1))
  }
  if (operation === 'close') {
    return parseBrowserClose(arguments_.slice(1))
  }
  if (operation === 'eval') {
    return parseBrowserEval(arguments_.slice(1))
  }
  if (operation === 'status') {
    return parseBrowserStatus(arguments_.slice(1))
  }
  if (operation === 'concurrency') {
    return parseBrowserConcurrency(arguments_.slice(1))
  }
  return invalid(BROWSER_HELP, `Unknown browser operation: ${displayArgument(operation)}.`)
}

export function parseBenchCli(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  if (requestsHelp(arguments_) || arguments_.length === 0) {
    return { kind: 'help', help: BENCH_HELP }
  }

  const operation = arguments_[0]
  if (operation === 'compiled') {
    return parseStandaloneBenchmark('compiled', arguments_.slice(1))
  }
  if (operation === 'no-render') {
    return parseNoRender(arguments_.slice(1))
  }
  if (operation === 'browser') {
    return parseBrowserBenchmark(arguments_.slice(1))
  }
  if (operation === 'compare') {
    return parseComparison(arguments_.slice(1))
  }
  if (operation === 'experiment') return parseExperimentVerdict(arguments_.slice(1))
  if (operation === 'status') return parseBenchStatus(arguments_.slice(1))
  if (operation === 'concurrency') return parseBenchConcurrency(arguments_.slice(1))
  return invalid(BENCH_HELP, `Unknown benchmark operation: ${displayArgument(operation)}.`)
}

function parseBrowserOpen(arguments_: readonly string[]): CliParseResult<BrowserCommand> {
  const parsed = parseOptions(arguments_, BROWSER_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 1) {
    return invalid(BROWSER_HELP, 'browser open requires exactly one <stage> positional argument.')
  }
  const stage = parseText(parsed.positionals[0], 'stage', BROWSER_HELP)
  if (isInvalid(stage)) return stage
  const timeoutMs = optionDuration(parsed, 'timeout', BROWSER_HELP)
  if (isInvalid(timeoutMs)) return timeoutMs
  const slot = optionSlot(parsed, BROWSER_HELP)
  if (isInvalid(slot)) return slot
  const json = optionBoolean(parsed, 'json', BROWSER_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['timeout', 'slot', 'json']), BROWSER_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: slot == null
    ? { kind: 'browser-open', stage, timeoutMs: timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS, json }
    : { kind: 'browser-open', stage, timeoutMs: timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS, slot, json } }
}

function parseBrowserClose(arguments_: readonly string[]): CliParseResult<BrowserCommand> {
  const parsed = parseOptions(arguments_, BROWSER_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(BROWSER_HELP, 'browser close does not accept positional arguments.')
  const slot = optionSlot(parsed, BROWSER_HELP)
  if (isInvalid(slot)) return slot
  const json = optionBoolean(parsed, 'json', BROWSER_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['slot', 'json']), BROWSER_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: slot == null
    ? { kind: 'browser-close', json }
    : { kind: 'browser-close', slot, json } }
}

function parseBrowserEval(arguments_: readonly string[]): CliParseResult<BrowserCommand> {
  const parsed = parseOptions(arguments_, BROWSER_HELP)
  if (isInvalid(parsed)) return parsed
  const inline = parsed.positionals.length === 1 ? parseText(parsed.positionals[0]!, 'JavaScript', BROWSER_HELP) : undefined
  if (isInvalid(inline)) return inline
  if (parsed.positionals.length > 1) return invalid(BROWSER_HELP, 'browser eval accepts one inline JavaScript argument, --file, or --stdin.')
  const file = optionText(parsed, 'file', BROWSER_HELP, false)
  if (isInvalid(file)) return file
  const stdin = optionBoolean(parsed, 'stdin', BROWSER_HELP)
  if (isInvalid(stdin)) return stdin
  const count = Number(inline != null) + Number(file != null) + Number(stdin)
  if (count !== 1) return invalid(BROWSER_HELP, 'browser eval requires exactly one JavaScript source: inline, --file, or --stdin.')
  const slot = optionSlot(parsed, BROWSER_HELP)
  if (isInvalid(slot)) return slot
  const json = optionBoolean(parsed, 'json', BROWSER_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['file', 'stdin', 'slot', 'json']), BROWSER_HELP)
  if (unsupported != null) return unsupported
  const source: HookSource = inline != null ? { kind: 'inline', source: inline } : file != null ? { kind: 'file', path: file } : { kind: 'stdin' }
  return { kind: 'command', command: slot == null
    ? { kind: 'browser-eval', source, json }
    : { kind: 'browser-eval', source, slot, json } }
}

function parseBrowserStatus(arguments_: readonly string[]): CliParseResult<BrowserCommand> {
  const parsed = parseOptions(arguments_, BROWSER_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(BROWSER_HELP, 'browser status does not accept positional arguments.')
  const json = optionBoolean(parsed, 'json', BROWSER_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['json']), BROWSER_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: { kind: 'browser-status', json } }
}

function parseBrowserConcurrency(arguments_: readonly string[]): CliParseResult<BrowserCommand> {
  const parsed = parseOptions(arguments_, BROWSER_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length > 1) return invalid(BROWSER_HELP, 'browser concurrency accepts at most one positive integer capacity.')
  let capacity: number | undefined
  if (parsed.positionals[0] != null) {
    const value = Number(parsed.positionals[0])
    if (!Number.isSafeInteger(value) || value <= 0) return invalid(BROWSER_HELP, 'browser concurrency capacity must be a positive integer.')
    capacity = value
  }
  const json = optionBoolean(parsed, 'json', BROWSER_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['json']), BROWSER_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: capacity == null
    ? { kind: 'browser-concurrency', json }
    : { kind: 'browser-concurrency', capacity, json } }
}

function parseExperimentVerdict(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const action = arguments_[0]
  if (action !== 'accept' && action !== 'reject') return invalid(BENCH_HELP, 'bench experiment requires accept or reject.')
  const parsed = parseOptions(arguments_.slice(1), BENCH_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 1) return invalid(BENCH_HELP, `bench experiment ${action} requires exactly one <id>.`)
  const id = parseText(parsed.positionals[0]!, 'experiment id', BENCH_HELP)
  if (isInvalid(id)) return id
  const reason = optionText(parsed, 'reason', BENCH_HELP, true)
  if (isInvalid(reason) || reason == null) return isInvalid(reason) ? reason : invalid(BENCH_HELP, '--reason is required.')
  const json = optionBoolean(parsed, 'json', BENCH_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['reason', 'json']), BENCH_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: { kind: action === 'accept' ? 'experiment-accept' : 'experiment-reject', id, reason, json } }
}

function parseBenchStatus(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const parsed = parseOptions(arguments_, BENCH_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(BENCH_HELP, 'bench status does not accept positional arguments.')
  const json = optionBoolean(parsed, 'json', BENCH_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['json']), BENCH_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: { kind: 'bench-status', json } }
}

function parseBenchConcurrency(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const parsed = parseOptions(arguments_, BENCH_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length > 1) return invalid(BENCH_HELP, 'bench concurrency accepts at most one positive integer capacity.')
  let capacity: number | undefined
  if (parsed.positionals[0] != null) {
    const value = Number(parsed.positionals[0])
    if (!Number.isSafeInteger(value) || value <= 0) return invalid(BENCH_HELP, 'bench concurrency capacity must be a positive integer.')
    capacity = value
  }
  const json = optionBoolean(parsed, 'json', BENCH_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['json']), BENCH_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: capacity == null
    ? { kind: 'bench-concurrency', json }
    : { kind: 'bench-concurrency', capacity, json } }
}

function parseStandaloneBenchmark(kind: 'compiled', arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const options = parseFrameOptions(arguments_, BENCH_HELP)
  if (isInvalid(options)) return options
  return { kind: 'command', command: { kind, ...options } }
}

function parseNoRender(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const target = arguments_[0]
  if (target === 'bun') return parseNoRenderBun(arguments_.slice(1))
  if (target === 'browser') return parseBrowserFrameBenchmark('no-render-browser', arguments_.slice(1), DEFAULT_NO_RENDER_BROWSER_STAGE)
  return invalid(BENCH_HELP, 'bench no-render requires bun or browser.')
}

function parseNoRenderBun(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const options = parseFrameOptions(arguments_, BENCH_HELP)
  if (isInvalid(options)) return options
  return { kind: 'command', command: { kind: 'no-render-bun', ...options } }
}

function parseBrowserBenchmark(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const mode = arguments_[0]
  if (mode === 'load') return parseBrowserLoad(arguments_.slice(1))
  if (mode === 'fps') return parseBrowserFrameBenchmark('browser-fps', arguments_.slice(1))
  if (mode === 'full') return parseBrowserFrameBenchmark('browser-full', arguments_.slice(1))
  if (mode === 'profile') return parseBrowserFrameBenchmark('browser-profile', arguments_.slice(1))
  if (mode === 'visual') return parseBrowserVisual(arguments_.slice(1))
  return invalid(BENCH_HELP, 'bench browser requires load, fps, visual, full, or profile.')
}

function parseBrowserLoad(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const parsed = parseOptions(arguments_, BENCH_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(BENCH_HELP, 'bench browser load does not accept positional arguments.')
  const stage = optionText(parsed, 'stage', BENCH_HELP, true)
  if (isInvalid(stage)) return stage
  if (stage == null) return invalid(BENCH_HELP, '--stage is required.')
  const timeoutMs = optionDuration(parsed, 'timeout', BENCH_HELP)
  if (isInvalid(timeoutMs)) return timeoutMs
  const json = optionBoolean(parsed, 'json', BENCH_HELP)
  if (isInvalid(json)) return json
  const keepOpen = optionBoolean(parsed, 'keep-open', BENCH_HELP)
  if (isInvalid(keepOpen)) return keepOpen
  const slot = optionSlot(parsed, BENCH_HELP)
  if (isInvalid(slot)) return slot
  const unsupported = rejectUnsupported(parsed, new Set(['stage', 'timeout', 'json', 'keep-open', 'slot']), BENCH_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: slot == null
    ? { kind: 'browser-load', stage, timeoutMs: timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS, keepOpen, json }
    : { kind: 'browser-load', stage, timeoutMs: timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS, keepOpen, slot, json } }
}

function parseBrowserFrameBenchmark(
  kind: BrowserNoRenderBenchmarkCommand['kind'] | BrowserFpsBenchmarkCommand['kind'] | BrowserFullBenchmarkCommand['kind'] | BrowserProfileBenchmarkCommand['kind'],
  arguments_: readonly string[],
  defaultStage = DEFAULT_BROWSER_STAGE
): CliParseResult<BenchCommand> {
  const parsed = parseBrowserOptions(arguments_, BENCH_HELP, true, defaultStage)
  if (isInvalid(parsed)) return parsed
  const frameOptions = readFrameOptions(parsed.parsed, BENCH_HELP)
  if (isInvalid(frameOptions)) return frameOptions
  return { kind: 'command', command: { kind, ...parsed.value, ...frameOptions } }
}

function parseBrowserVisual(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const parsed = parseBrowserOptions(arguments_, BENCH_HELP, false, DEFAULT_BROWSER_VISUAL_STAGE, DEFAULT_BROWSER_VISUAL_TIMEOUT_MS)
  if (isInvalid(parsed)) return parsed
  return { kind: 'command', command: { kind: 'browser-visual', ...parsed.value } }
}

function parseComparison(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const target = comparisonTarget(arguments_)
  if (isInvalid(target)) return target
  const remaining = arguments_.slice(target.consumed)
  if (target.kind === 'compiled') return parseFrameComparison('compare-compiled', remaining)
  if (target.kind === 'no-render-bun') return parseFrameComparison('compare-no-render-bun', remaining)
  if (target.kind === 'no-render-browser') return parseBrowserComparison('compare-no-render-browser', remaining, true, DEFAULT_NO_RENDER_BROWSER_STAGE)
  if (target.kind === 'browser-fps') return parseBrowserComparison('compare-browser-fps', remaining, true)
  if (target.kind === 'browser-full') return parseBrowserComparison('compare-browser-full', remaining, true)
  return parseBrowserComparison('compare-browser-visual', remaining, false, DEFAULT_BROWSER_VISUAL_STAGE)
}

function comparisonTarget(arguments_: readonly string[]): { readonly kind: 'compiled' | 'no-render-bun' | 'no-render-browser' | 'browser-fps' | 'browser-full' | 'browser-visual'; readonly consumed: number } | InvalidArgumentsResult {
  if (arguments_[0] === 'compiled') return { kind: 'compiled', consumed: 1 }
  if (arguments_[0] === 'no-render' && arguments_[1] === 'bun') return { kind: 'no-render-bun', consumed: 2 }
  if (arguments_[0] === 'no-render' && arguments_[1] === 'browser') return { kind: 'no-render-browser', consumed: 2 }
  if (arguments_[0] === 'browser' && arguments_[1] === 'fps') return { kind: 'browser-fps', consumed: 2 }
  if (arguments_[0] === 'browser' && arguments_[1] === 'full') return { kind: 'browser-full', consumed: 2 }
  if (arguments_[0] === 'browser' && arguments_[1] === 'visual') return { kind: 'browser-visual', consumed: 2 }
  return invalid(BENCH_HELP, 'bench compare requires compiled, no-render bun|browser, or browser fps|visual|full.')
}

function parseFrameComparison(
  kind: CompareCompiledCommand['kind'] | CompareBunNoRenderCommand['kind'],
  arguments_: readonly string[]
): CliParseResult<BenchCommand> {
  const parsed = parseOptions(arguments_, BENCH_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(BENCH_HELP, 'Comparison commands do not accept positional arguments.')
  const common = readComparisonOptions(parsed, BENCH_HELP)
  if (isInvalid(common)) return common
  const frames = readFrameOptions(parsed, BENCH_HELP)
  if (isInvalid(frames)) return frames
  const unsupported = rejectUnsupported(parsed, new Set(['baseline', 'candidate', 'frames', 'warmup', 'slot', 'json', 'experiment', 'description', 'aim', 'cause', 'hypothesis']), BENCH_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: { kind, ...common, ...frames } }
}

function parseBrowserComparison(
  kind: CompareBrowserNoRenderCommand['kind'] | CompareBrowserFpsCommand['kind'] | CompareBrowserFullCommand['kind'] | CompareBrowserVisualCommand['kind'],
  arguments_: readonly string[],
  supportsFrames: boolean,
  defaultStage = DEFAULT_BROWSER_STAGE,
  defaultTimeoutMs = DEFAULT_COMPARISON_BROWSER_TIMEOUT_MS
): CliParseResult<BenchCommand> {
  const parsed = parseOptions(arguments_, BENCH_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(BENCH_HELP, 'Comparison commands do not accept positional arguments.')
  const common = readComparisonOptions(parsed, BENCH_HELP)
  if (isInvalid(common)) return common
  const browser = readComparisonBrowserOptions(parsed, BENCH_HELP, defaultStage, defaultTimeoutMs)
  if (isInvalid(browser)) return browser
  const frames = supportsFrames ? readFrameOptions(parsed, BENCH_HELP) : { frames: undefined, warmupFrames: undefined }
  if (isInvalid(frames)) return frames
  const allowed = new Set(['baseline', 'candidate', 'stage', 'timeout', 'before', 'before-file', 'before-stdin', 'after', 'after-file', 'after-stdin', 'slot', 'json', 'experiment', 'description', 'aim', 'cause', 'hypothesis'])
  if (supportsFrames) {
    allowed.add('frames')
    allowed.add('warmup')
  }
  const unsupported = rejectUnsupported(parsed, allowed, BENCH_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: { kind, ...common, ...browser, ...frames } }
}

function parseFrameOptions(arguments_: readonly string[], help: CliHelp): { readonly frames?: number; readonly warmupFrames?: number; readonly slot?: number; readonly json: boolean } | InvalidArgumentsResult {
  const parsed = parseOptions(arguments_, help)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(help, 'This benchmark does not accept positional arguments.')
  const frames = readFrameOptions(parsed, help)
  if (isInvalid(frames)) return frames
  const slot = optionSlot(parsed, help)
  if (isInvalid(slot)) return slot
  const json = optionBoolean(parsed, 'json', help)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['frames', 'warmup', 'slot', 'json']), help)
  if (unsupported != null) return unsupported
  return slot == null ? { ...frames, json } : { ...frames, slot, json }
}

function parseBrowserOptions(
  arguments_: readonly string[],
  help: CliHelp,
  supportsFrames: boolean,
  defaultStage = DEFAULT_BROWSER_STAGE,
  defaultTimeoutMs = DEFAULT_BROWSER_TIMEOUT_MS
): { readonly value: BrowserBenchmarkOptions; readonly parsed: ParsedOptions } | InvalidArgumentsResult {
  const parsed = parseOptions(arguments_, help)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(help, 'This benchmark does not accept positional arguments.')
  const stage = optionText(parsed, 'stage', help, false)
  if (isInvalid(stage)) return stage
  const timeoutMs = optionDuration(parsed, 'timeout', help)
  if (isInvalid(timeoutMs)) return timeoutMs
  const reuse = optionBoolean(parsed, 'reuse', help)
  if (isInvalid(reuse)) return reuse
  const settleMs = optionDuration(parsed, 'settle', help)
  if (isInvalid(settleMs)) return settleMs
  if (settleMs != null && !reuse) return invalid(help, '--settle requires --reuse.')
  const keepOpen = optionBoolean(parsed, 'keep-open', help)
  if (isInvalid(keepOpen)) return keepOpen
  const slot = optionSlot(parsed, help)
  if (isInvalid(slot)) return slot
  const json = optionBoolean(parsed, 'json', help)
  if (isInvalid(json)) return json
  const hooks = readHooks(parsed, help)
  if (isInvalid(hooks)) return hooks
  const allowed = new Set(['stage', 'timeout', 'reuse', 'settle', 'keep-open', 'slot', 'before', 'before-file', 'before-stdin', 'after', 'after-file', 'after-stdin', 'json'])
  if (supportsFrames) {
    allowed.add('frames')
    allowed.add('warmup')
  }
  const unsupported = rejectUnsupported(parsed, allowed, help)
  if (unsupported != null) return unsupported
  const valueBase = {
    stage: stage ?? defaultStage,
    timeoutMs: timeoutMs ?? defaultTimeoutMs,
    reuse,
    keepOpen,
    hooks,
    json
  }
  const value = reuse
    ? slot == null
      ? { ...valueBase, settleMs: settleMs ?? DEFAULT_REUSE_SETTLE_MS }
      : { ...valueBase, settleMs: settleMs ?? DEFAULT_REUSE_SETTLE_MS, slot }
    : slot == null
      ? valueBase
      : { ...valueBase, slot }
  return { value, parsed }
}

function readExperimentOptions(parsed: ParsedOptions, help: CliHelp): ExperimentOptions | undefined | InvalidArgumentsResult {
  const name = optionText(parsed, 'experiment', help, false)
  if (isInvalid(name)) return name
  const description = optionText(parsed, 'description', help, false)
  if (isInvalid(description)) return description
  const aim = optionText(parsed, 'aim', help, false)
  if (isInvalid(aim)) return aim
  const cause = optionText(parsed, 'cause', help, false)
  if (isInvalid(cause)) return cause
  const hypothesis = optionText(parsed, 'hypothesis', help, false)
  if (isInvalid(hypothesis)) return hypothesis
  if (name == null) {
    if (description != null || aim != null || cause != null || hypothesis != null) return invalid(help, 'Experiment metadata requires --experiment <name>.')
    return undefined
  }
  const options: ExperimentOptions = { name }
  if (description != null) Object.assign(options, { description })
  if (aim != null) Object.assign(options, { aim })
  if (cause != null) Object.assign(options, { cause })
  if (hypothesis != null) Object.assign(options, { hypothesis })
  return options
}

function readComparisonOptions(parsed: ParsedOptions, help: CliHelp): ComparisonSelection & CommonBenchmarkCommand & { readonly experiment?: ExperimentOptions } | InvalidArgumentsResult {
  const baseline = optionText(parsed, 'baseline', help, false)
  if (isInvalid(baseline)) return baseline
  const candidate = optionText(parsed, 'candidate', help, false)
  if (isInvalid(candidate)) return candidate
  const slot = optionSlot(parsed, help)
  if (isInvalid(slot)) return slot
  const experiment = readExperimentOptions(parsed, help)
  if (isInvalid(experiment)) return experiment
  const json = optionBoolean(parsed, 'json', help)
  if (isInvalid(json)) return json
  const selection = { baseline: baseline ?? DEFAULT_COMPARISON_BASELINE, candidate: candidate ?? DEFAULT_COMPARISON_CANDIDATE, json }
  if (slot == null && experiment == null) return selection
  if (slot == null) return { ...selection, experiment }
  if (experiment == null) return { ...selection, slot }
  return { ...selection, slot, experiment }
}

function readComparisonBrowserOptions(
  parsed: ParsedOptions,
  help: CliHelp,
  defaultStage = DEFAULT_BROWSER_STAGE,
  defaultTimeoutMs = DEFAULT_COMPARISON_BROWSER_TIMEOUT_MS
): Omit<BrowserComparisonCommand, keyof CommonComparisonCommand | 'kind'> | InvalidArgumentsResult {
  const stage = optionText(parsed, 'stage', help, false)
  if (isInvalid(stage)) return stage
  const timeoutMs = optionDuration(parsed, 'timeout', help)
  if (isInvalid(timeoutMs)) return timeoutMs
  const hooks = readHooks(parsed, help)
  if (isInvalid(hooks)) return hooks
  return { stage: stage ?? defaultStage, timeoutMs: timeoutMs ?? defaultTimeoutMs, hooks }
}

function readFrameOptions(parsed: ParsedOptions, help: CliHelp): { readonly frames?: number; readonly warmupFrames?: number } | InvalidArgumentsResult {
  const frames = optionCount(parsed, 'frames', help, 1)
  if (isInvalid(frames)) return frames
  const warmupFrames = optionCount(parsed, 'warmup', help, 0)
  if (isInvalid(warmupFrames)) return warmupFrames
  if (frames == null) return warmupFrames == null ? {} : { warmupFrames }
  return warmupFrames == null ? { frames } : { frames, warmupFrames }
}

function readHooks(parsed: ParsedOptions, help: CliHelp): BenchmarkHooks | InvalidArgumentsResult {
  const before = readHook(parsed, 'before', help)
  if (isInvalid(before)) return before
  const after = readHook(parsed, 'after', help)
  if (isInvalid(after)) return after
  if (before?.kind === 'stdin' && after?.kind === 'stdin') {
    return invalid(help, 'Only one stdin hook is allowed per invocation.')
  }
  if (before == null) return after == null ? {} : { after }
  return after == null ? { before } : { before, after }
}

function readHook(parsed: ParsedOptions, phase: 'before' | 'after', help: CliHelp): HookSource | undefined | InvalidArgumentsResult {
  const inline = optionText(parsed, phase, help, false)
  if (isInvalid(inline)) return inline
  const file = optionText(parsed, `${phase}-file`, help, false)
  if (isInvalid(file)) return file
  const stdin = optionBoolean(parsed, `${phase}-stdin`, help)
  if (isInvalid(stdin)) return stdin
  const count = Number(inline != null) + Number(file != null) + Number(stdin)
  if (count > 1) return invalid(help, `Use only one ${phase} hook source.`)
  if (inline != null) return { kind: 'inline', source: inline }
  if (file != null) return { kind: 'file', path: file }
  return stdin ? { kind: 'stdin' } : undefined
}

type ParsedOption = { readonly value?: string }
interface ParsedOptions {
  readonly positionals: readonly string[]
  readonly options: ReadonlyMap<string, ParsedOption>
}

function parseOptions(arguments_: readonly string[], help: CliHelp): ParsedOptions | InvalidArgumentsResult {
  const positionals: string[] = []
  const options = new Map<string, ParsedOption>()
  let parseOptions = true
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!
    if (parseOptions && argument === '--') {
      parseOptions = false
      continue
    }
    if (!parseOptions || !argument.startsWith('--') || argument === '--') {
      positionals.push(argument)
      continue
    }
    const equalsIndex = argument.indexOf('=')
    const name = argument.slice(2, equalsIndex < 0 ? undefined : equalsIndex)
    if (name.length === 0) return invalid(help, 'Option names cannot be empty.')
    if (options.has(name)) return invalid(help, `Option --${name} was provided more than once.`)
    const inlineValue = equalsIndex < 0 ? undefined : argument.slice(equalsIndex + 1)
    if (inlineValue != null) {
      options.set(name, { value: inlineValue })
      continue
    }
    const next = arguments_[index + 1]
    if (next != null && !next.startsWith('--')) {
      options.set(name, { value: next })
      index += 1
    } else {
      options.set(name, {})
    }
  }
  return { positionals, options }
}

function optionText(parsed: ParsedOptions, name: string, help: CliHelp, required: boolean): string | undefined | InvalidArgumentsResult {
  const option = parsed.options.get(name)
  if (option == null) return required ? invalid(help, `--${name} is required.`) : undefined
  if (option.value == null) return invalid(help, `--${name} requires a value.`)
  return parseText(option.value, `--${name}`, help)
}

function optionDuration(parsed: ParsedOptions, name: string, help: CliHelp): number | undefined | InvalidArgumentsResult {
  const value = optionText(parsed, name, help, false)
  if (isInvalid(value)) return value
  if (value == null) return undefined
  const match = DURATION_PATTERN.exec(value)
  if (match == null) return invalid(help, `--${name} must be a positive duration such as 120s or 500ms.`)
  const amount = Number(match[1])
  const unit = match[2]
  const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1
  const milliseconds = amount * multiplier
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || !Number.isSafeInteger(milliseconds)) {
    return invalid(help, `--${name} must be a positive whole number of milliseconds.`)
  }
  return milliseconds
}

function optionCount(parsed: ParsedOptions, name: string, help: CliHelp, minimum: number): number | undefined | InvalidArgumentsResult {
  const value = optionText(parsed, name, help, false)
  if (isInvalid(value)) return value
  if (value == null) return undefined
  if (!INTEGER_PATTERN.test(value)) return invalid(help, `--${name} must be an integer of at least ${minimum}.`)
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < minimum) return invalid(help, `--${name} must be an integer of at least ${minimum}.`)
  return count
}

function optionBoolean(parsed: ParsedOptions, name: string, help: CliHelp): boolean | InvalidArgumentsResult {
  const option = parsed.options.get(name)
  if (option == null) return false
  if (option.value != null) return invalid(help, `--${name} does not accept a value.`)
  return true
}

function optionSlot(parsed: ParsedOptions, help: CliHelp): number | undefined | InvalidArgumentsResult {
  const value = optionText(parsed, 'slot', help, false)
  if (isInvalid(value)) return value
  if (value == null) return undefined
  const slot = Number(value)
  return Number.isSafeInteger(slot) && slot > 0 ? slot : invalid(help, '--slot must be a positive integer.')
}

function rejectUnsupported(parsed: ParsedOptions, allowed: ReadonlySet<string>, help: CliHelp): InvalidArgumentsResult | undefined {
  for (const name of parsed.options.keys()) {
    if (!allowed.has(name)) return invalid(help, `--${name} is not valid for this command.`)
  }
  return undefined
}

function parseText(value: string, label: string, help: CliHelp): string | InvalidArgumentsResult {
  if (value.trim().length === 0) return invalid(help, `${label} cannot be empty.`)
  return value
}

function requestsHelp(arguments_: readonly string[]): boolean {
  return arguments_.length === 1 && (arguments_[0] === '--help' || arguments_[0] === '-h' || arguments_[0] === 'help')
}

function displayArgument(value: string | undefined): string {
  return value == null ? 'nothing' : JSON.stringify(value)
}

function invalid(help: CliHelp, message: string): InvalidArgumentsResult {
  return { kind: 'error', error: { code: 'INVALID_ARGUMENTS', message }, help }
}

function isInvalid(value: unknown): value is InvalidArgumentsResult {
  return typeof value === 'object' && value != null && 'kind' in value && value.kind === 'error'
}
