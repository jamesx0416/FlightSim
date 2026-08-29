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
  readonly options: readonly HelpOption[]
}

export interface BrowserOpenCommand {
  readonly kind: 'browser-open'
  readonly stage: string
  readonly timeoutMs: number
  readonly json: boolean
}

export interface BrowserCloseCommand {
  readonly kind: 'browser-close'
  readonly json: boolean
}

export type BrowserCommand = BrowserOpenCommand | BrowserCloseCommand

interface CommonBenchmarkCommand {
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
  | BrowserFullBenchmarkCommand
  | BrowserProfileBenchmarkCommand
  | BrowserVisualBenchmarkCommand

export interface ComparisonSelection {
  readonly baseline: string
  readonly candidate: string
}

interface CommonComparisonCommand extends CommonBenchmarkCommand, ComparisonSelection {
  readonly kind: `compare-${string}`
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

export interface CompareBrowserFullCommand extends BrowserComparisonCommand, FrameComparisonCommand {
  readonly kind: 'compare-browser-full'
  readonly visual: boolean
}

export interface CompareBrowserVisualCommand extends BrowserComparisonCommand {
  readonly kind: 'compare-browser-visual'
  readonly visual: true
}

export type ComparisonCommand =
  | CompareCompiledCommand
  | CompareBunNoRenderCommand
  | CompareBrowserNoRenderCommand
  | CompareBrowserFullCommand
  | CompareBrowserVisualCommand

export type BenchCommand = BenchmarkCommand | ComparisonCommand

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
export const DEFAULT_REUSE_SETTLE_MS = 2_000
export const DEFAULT_BROWSER_STAGE = 'stable'
export const DEFAULT_COMPARISON_BASELINE = 'HEAD'
export const DEFAULT_COMPARISON_CANDIDATE = 'worktree'

export const BROWSER_HELP: CliHelp = {
  name: 'browser',
  summary: 'Open or close the retained, queue-managed FlightSim browser.',
  usage: ['browser open <stage> [--timeout <duration>] [--json]', 'browser close [--json]'],
  options: [
    { usage: '--timeout <duration>', description: 'Readiness timeout, for example 120s or 500ms.' },
    { usage: '--json', description: 'Print the structured result.' }
  ]
}

export const BENCH_HELP: CliHelp = {
  name: 'bench',
  summary: 'Run a FlightSim benchmark or Git comparison.',
  usage: [
    'bench compiled [--frames <count>] [--warmup <count>]',
    'bench no-render bun|browser [options]',
    'bench browser load --stage <stage> [options]',
    'bench browser full|profile|visual [options]',
    'bench compare compiled|no-render bun|browser|browser full|visual [options]'
  ],
  options: [
    { usage: '--stage <stage>', description: 'Built-in alias, exact DevApi stage, or configured stage.' },
    { usage: '--timeout <duration>', description: 'Browser readiness timeout, for example 120s or 500ms.' },
    { usage: '--frames <count>  --warmup <count>', description: 'Measured and warmup frame counts for frame benchmarks.' },
    { usage: '--before <js> | --before-file <path> | --before-stdin', description: 'Hook run after readiness.' },
    { usage: '--after <js> | --after-file <path> | --after-stdin', description: 'Hook run after measurement.' },
    { usage: '--reuse [--settle <duration>]', description: 'Reuse a retained page and settle it before warmup.' },
    { usage: '--keep-open', description: 'Retain a browser session after a non-comparison browser benchmark.' },
    { usage: '--baseline <revision>  --candidate <revision|worktree>', description: 'Comparison inputs.' },
    { usage: '--visual', description: 'Add deterministic visual comparison to browser full.' },
    { usage: '--json', description: 'Print the structured result.' }
  ]
}

export function formatHelp(help: CliHelp): string {
  const lines = [help.summary, '', 'Usage:', ...help.usage.map((usage) => `  ${usage}`), '', 'Options:']
  for (const option of help.options) {
    lines.push(`  ${option.usage}\n    ${option.description}`)
  }
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
  const json = optionBoolean(parsed, 'json', BROWSER_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['timeout', 'json']), BROWSER_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: { kind: 'browser-open', stage, timeoutMs: timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS, json } }
}

function parseBrowserClose(arguments_: readonly string[]): CliParseResult<BrowserCommand> {
  const parsed = parseOptions(arguments_, BROWSER_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(BROWSER_HELP, 'browser close does not accept positional arguments.')
  const json = optionBoolean(parsed, 'json', BROWSER_HELP)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['json']), BROWSER_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: { kind: 'browser-close', json } }
}

function parseStandaloneBenchmark(kind: 'compiled', arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const options = parseFrameOptions(arguments_, BENCH_HELP)
  if (isInvalid(options)) return options
  return { kind: 'command', command: { kind, ...options } }
}

function parseNoRender(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const target = arguments_[0]
  if (target === 'bun') return parseNoRenderBun(arguments_.slice(1))
  if (target === 'browser') return parseBrowserFrameBenchmark('no-render-browser', arguments_.slice(1))
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
  if (mode === 'full') return parseBrowserFrameBenchmark('browser-full', arguments_.slice(1))
  if (mode === 'profile') return parseBrowserFrameBenchmark('browser-profile', arguments_.slice(1))
  if (mode === 'visual') return parseBrowserVisual(arguments_.slice(1))
  return invalid(BENCH_HELP, 'bench browser requires load, full, profile, or visual.')
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
  const unsupported = rejectUnsupported(parsed, new Set(['stage', 'timeout', 'json', 'keep-open']), BENCH_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: { kind: 'browser-load', stage, timeoutMs: timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS, keepOpen, json } }
}

function parseBrowserFrameBenchmark(
  kind: BrowserNoRenderBenchmarkCommand['kind'] | BrowserFullBenchmarkCommand['kind'] | BrowserProfileBenchmarkCommand['kind'],
  arguments_: readonly string[]
): CliParseResult<BenchCommand> {
  const parsed = parseBrowserOptions(arguments_, BENCH_HELP, true)
  if (isInvalid(parsed)) return parsed
  const frameOptions = readFrameOptions(parsed.parsed, BENCH_HELP)
  if (isInvalid(frameOptions)) return frameOptions
  return { kind: 'command', command: { kind, ...parsed.value, ...frameOptions } }
}

function parseBrowserVisual(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const parsed = parseBrowserOptions(arguments_, BENCH_HELP, false)
  if (isInvalid(parsed)) return parsed
  return { kind: 'command', command: { kind: 'browser-visual', ...parsed.value } }
}

function parseComparison(arguments_: readonly string[]): CliParseResult<BenchCommand> {
  const target = comparisonTarget(arguments_)
  if (isInvalid(target)) return target
  const remaining = arguments_.slice(target.consumed)
  if (target.kind === 'compiled') return parseFrameComparison('compare-compiled', remaining)
  if (target.kind === 'no-render-bun') return parseFrameComparison('compare-no-render-bun', remaining)
  if (target.kind === 'no-render-browser') return parseBrowserComparison('compare-no-render-browser', remaining, true)
  if (target.kind === 'browser-full') return parseBrowserComparison('compare-browser-full', remaining, true)
  return parseBrowserComparison('compare-browser-visual', remaining, false)
}

function comparisonTarget(arguments_: readonly string[]): { readonly kind: 'compiled' | 'no-render-bun' | 'no-render-browser' | 'browser-full' | 'browser-visual'; readonly consumed: number } | InvalidArgumentsResult {
  if (arguments_[0] === 'compiled') return { kind: 'compiled', consumed: 1 }
  if (arguments_[0] === 'no-render' && arguments_[1] === 'bun') return { kind: 'no-render-bun', consumed: 2 }
  if (arguments_[0] === 'no-render' && arguments_[1] === 'browser') return { kind: 'no-render-browser', consumed: 2 }
  if (arguments_[0] === 'browser' && arguments_[1] === 'full') return { kind: 'browser-full', consumed: 2 }
  if (arguments_[0] === 'browser' && arguments_[1] === 'visual') return { kind: 'browser-visual', consumed: 2 }
  return invalid(BENCH_HELP, 'bench compare requires compiled, no-render bun|browser, browser full, or browser visual.')
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
  const unsupported = rejectUnsupported(parsed, new Set(['baseline', 'candidate', 'frames', 'warmup', 'json']), BENCH_HELP)
  if (unsupported != null) return unsupported
  return { kind: 'command', command: { kind, ...common, ...frames } }
}

function parseBrowserComparison(
  kind: CompareBrowserNoRenderCommand['kind'] | CompareBrowserFullCommand['kind'] | CompareBrowserVisualCommand['kind'],
  arguments_: readonly string[],
  supportsFrames: boolean
): CliParseResult<BenchCommand> {
  const parsed = parseOptions(arguments_, BENCH_HELP)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(BENCH_HELP, 'Comparison commands do not accept positional arguments.')
  const common = readComparisonOptions(parsed, BENCH_HELP)
  if (isInvalid(common)) return common
  const browser = readComparisonBrowserOptions(parsed, BENCH_HELP)
  if (isInvalid(browser)) return browser
  const frames = supportsFrames ? readFrameOptions(parsed, BENCH_HELP) : { frames: undefined, warmupFrames: undefined }
  if (isInvalid(frames)) return frames
  const visual = optionBoolean(parsed, 'visual', BENCH_HELP)
  if (isInvalid(visual)) return visual
  if (kind !== 'compare-browser-full' && visual) {
    return invalid(BENCH_HELP, '--visual is only valid with bench compare browser full; browser visual is already visual.')
  }
  const allowed = new Set(['baseline', 'candidate', 'stage', 'timeout', 'before', 'before-file', 'before-stdin', 'after', 'after-file', 'after-stdin', 'json', 'visual'])
  if (supportsFrames) {
    allowed.add('frames')
    allowed.add('warmup')
  }
  const unsupported = rejectUnsupported(parsed, allowed, BENCH_HELP)
  if (unsupported != null) return unsupported
  if (kind === 'compare-browser-full') {
    return { kind: 'command', command: { kind, ...common, ...browser, ...frames, visual } }
  }
  if (kind === 'compare-browser-visual') {
    return { kind: 'command', command: { kind, ...common, ...browser, visual: true } }
  }
  return { kind: 'command', command: { kind, ...common, ...browser, ...frames } }
}

function parseFrameOptions(arguments_: readonly string[], help: CliHelp): { readonly frames?: number; readonly warmupFrames?: number; readonly json: boolean } | InvalidArgumentsResult {
  const parsed = parseOptions(arguments_, help)
  if (isInvalid(parsed)) return parsed
  if (parsed.positionals.length !== 0) return invalid(help, 'This benchmark does not accept positional arguments.')
  const frames = readFrameOptions(parsed, help)
  if (isInvalid(frames)) return frames
  const json = optionBoolean(parsed, 'json', help)
  if (isInvalid(json)) return json
  const unsupported = rejectUnsupported(parsed, new Set(['frames', 'warmup', 'json']), help)
  if (unsupported != null) return unsupported
  return { ...frames, json }
}

function parseBrowserOptions(arguments_: readonly string[], help: CliHelp, supportsFrames: boolean): { readonly value: BrowserBenchmarkOptions; readonly parsed: ParsedOptions } | InvalidArgumentsResult {
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
  const json = optionBoolean(parsed, 'json', help)
  if (isInvalid(json)) return json
  const hooks = readHooks(parsed, help)
  if (isInvalid(hooks)) return hooks
  const allowed = new Set(['stage', 'timeout', 'reuse', 'settle', 'keep-open', 'before', 'before-file', 'before-stdin', 'after', 'after-file', 'after-stdin', 'json'])
  if (supportsFrames) {
    allowed.add('frames')
    allowed.add('warmup')
  }
  const unsupported = rejectUnsupported(parsed, allowed, help)
  if (unsupported != null) return unsupported
  return {
    value: {
      stage: stage ?? DEFAULT_BROWSER_STAGE,
      timeoutMs: timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS,
      reuse,
      ...(reuse ? { settleMs: settleMs ?? DEFAULT_REUSE_SETTLE_MS } : {}),
      keepOpen,
      hooks,
      json
    },
    parsed
  }
}

function readComparisonOptions(parsed: ParsedOptions, help: CliHelp): ComparisonSelection & CommonBenchmarkCommand | InvalidArgumentsResult {
  const baseline = optionText(parsed, 'baseline', help, false)
  if (isInvalid(baseline)) return baseline
  const candidate = optionText(parsed, 'candidate', help, false)
  if (isInvalid(candidate)) return candidate
  const json = optionBoolean(parsed, 'json', help)
  if (isInvalid(json)) return json
  return { baseline: baseline ?? DEFAULT_COMPARISON_BASELINE, candidate: candidate ?? DEFAULT_COMPARISON_CANDIDATE, json }
}

function readComparisonBrowserOptions(parsed: ParsedOptions, help: CliHelp): Omit<BrowserComparisonCommand, keyof CommonComparisonCommand | 'kind'> | InvalidArgumentsResult {
  const stage = optionText(parsed, 'stage', help, false)
  if (isInvalid(stage)) return stage
  const timeoutMs = optionDuration(parsed, 'timeout', help)
  if (isInvalid(timeoutMs)) return timeoutMs
  const hooks = readHooks(parsed, help)
  if (isInvalid(hooks)) return hooks
  return { stage: stage ?? DEFAULT_BROWSER_STAGE, timeoutMs: timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS, hooks }
}

function readFrameOptions(parsed: ParsedOptions, help: CliHelp): { readonly frames?: number; readonly warmupFrames?: number } | InvalidArgumentsResult {
  const frames = optionCount(parsed, 'frames', help, 1)
  if (isInvalid(frames)) return frames
  const warmupFrames = optionCount(parsed, 'warmup', help, 0)
  if (isInvalid(warmupFrames)) return warmupFrames
  return { ...(frames == null ? {} : { frames }), ...(warmupFrames == null ? {} : { warmupFrames }) }
}

function readHooks(parsed: ParsedOptions, help: CliHelp): BenchmarkHooks | InvalidArgumentsResult {
  const before = readHook(parsed, 'before', help)
  if (isInvalid(before)) return before
  const after = readHook(parsed, 'after', help)
  if (isInvalid(after)) return after
  if (before?.kind === 'stdin' && after?.kind === 'stdin') {
    return invalid(help, 'Only one stdin hook is allowed per invocation.')
  }
  return { ...(before == null ? {} : { before }), ...(after == null ? {} : { after }) }
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
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value)
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
  if (!/^\d+$/.test(value)) return invalid(help, `--${name} must be an integer of at least ${minimum}.`)
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
