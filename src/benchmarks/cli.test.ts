import { expect, test } from 'bun:test'

import {
  BENCH_HELP,
  BROWSER_HELP,
  DEFAULT_BROWSER_STAGE,
  DEFAULT_BROWSER_TIMEOUT_MS,
  DEFAULT_COMPARISON_BASELINE,
  DEFAULT_COMPARISON_CANDIDATE,
  DEFAULT_REUSE_SETTLE_MS,
  formatHelp,
  parseBenchCli,
  parseBrowserCli,
  type BenchCommand,
  type BrowserCommand,
  type CliParseResult
} from './cli'

function command<TCommand>(result: CliParseResult<TCommand>): TCommand {
  expect(result.kind).toBe('command')
  if (result.kind !== 'command') throw new Error('Expected a parsed command.')
  return result.command
}

function invalid<TCommand>(result: CliParseResult<TCommand>): void {
  expect(result.kind).toBe('error')
  if (result.kind !== 'error') throw new Error('Expected invalid arguments.')
  expect(result.error.code).toBe('INVALID_ARGUMENTS')
}

test('browser lifecycle parsing keeps open stage positional and applies its timeout default', () => {
  expect(command<BrowserCommand>(parseBrowserCli(['open', 'cockpit']))).toEqual({
    kind: 'browser-open',
    stage: 'cockpit',
    timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
    json: false
  })
  expect(command<BrowserCommand>(parseBrowserCli(['open', 'gltf:interior-upgrade:ready', '--timeout', '1.5m', '--json']))).toEqual({
    kind: 'browser-open',
    stage: 'gltf:interior-upgrade:ready',
    timeoutMs: 90_000,
    json: true
  })
  expect(command<BrowserCommand>(parseBrowserCli(['close', '--json']))).toEqual({ kind: 'browser-close', json: true })
  invalid(parseBrowserCli(['open', '--stage', 'cockpit']))
})

test('empty CLIs and explicit help return their concise typed help models', () => {
  expect(parseBrowserCli([])).toEqual({ kind: 'help', help: BROWSER_HELP })
  expect(parseBenchCli(['--help'])).toEqual({ kind: 'help', help: BENCH_HELP })
  expect(formatHelp(BENCH_HELP).includes('bench browser load --stage <stage>')).toBe(true)
  expect(formatHelp(BROWSER_HELP).includes('browser open <stage>')).toBe(true)
})

test('parses compiled and Bun no-render frame benchmarks', () => {
  expect(command<BenchCommand>(parseBenchCli(['compiled', '--frames=5000', '--warmup', '300', '--json']))).toEqual({
    kind: 'compiled',
    frames: 5000,
    warmupFrames: 300,
    json: true
  })
  expect(command<BenchCommand>(parseBenchCli(['no-render', 'bun']))).toEqual({ kind: 'no-render-bun', json: false })
})

test('parses browser benchmarks with defaults, reuse settling, and hooks', () => {
  expect(command<BenchCommand>(parseBenchCli([
    'no-render', 'browser', '--reuse', '--before', 'window.quality = 1', '--after-file', 'cleanup.js', '--frames', '20'
  ]))).toEqual({
    kind: 'no-render-browser',
    stage: DEFAULT_BROWSER_STAGE,
    timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
    reuse: true,
    settleMs: DEFAULT_REUSE_SETTLE_MS,
    keepOpen: false,
    hooks: {
      before: { kind: 'inline', source: 'window.quality = 1' },
      after: { kind: 'file', path: 'cleanup.js' }
    },
    frames: 20,
    json: false
  })
  expect(command<BenchCommand>(parseBenchCli(['browser', 'load', '--stage', 'cockpit', '--keep-open']))).toEqual({
    kind: 'browser-load',
    stage: 'cockpit',
    timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
    keepOpen: true,
    json: false
  })
  expect(command<BenchCommand>(parseBenchCli(['browser', 'visual', '--reuse', '--settle', '3s', '--before-stdin']))).toEqual({
    kind: 'browser-visual',
    stage: DEFAULT_BROWSER_STAGE,
    timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
    reuse: true,
    settleMs: 3_000,
    keepOpen: false,
    hooks: { before: { kind: 'stdin' } },
    json: false
  })
})

test('parses comparison defaults and visual modes without allowing page reuse', () => {
  expect(command<BenchCommand>(parseBenchCli(['compare', 'browser', 'full', '--visual', '--baseline', 'HEAD~5', '--candidate', 'HEAD~2']))).toEqual({
    kind: 'compare-browser-full',
    baseline: 'HEAD~5',
    candidate: 'HEAD~2',
    stage: DEFAULT_BROWSER_STAGE,
    timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
    hooks: {},
    frames: undefined,
    warmupFrames: undefined,
    visual: true,
    json: false
  })
  expect(command<BenchCommand>(parseBenchCli(['compare', 'browser', 'visual']))).toEqual({
    kind: 'compare-browser-visual',
    baseline: DEFAULT_COMPARISON_BASELINE,
    candidate: DEFAULT_COMPARISON_CANDIDATE,
    stage: DEFAULT_BROWSER_STAGE,
    timeoutMs: DEFAULT_BROWSER_TIMEOUT_MS,
    hooks: {},
    visual: true,
    json: false
  })
  invalid(parseBenchCli(['compare', 'no-render', 'browser', '--reuse']))
  invalid(parseBenchCli(['compare', 'browser', 'visual', '--visual']))
})

test('rejects unsupported options, invalid values, conflicting hooks, and invalid combinations', () => {
  invalid(parseBenchCli(['browser', 'load']))
  invalid(parseBenchCli(['browser', 'load', '--stage', 'cockpit', '--reuse']))
  invalid(parseBenchCli(['browser', 'full', '--settle', '3s']))
  invalid(parseBenchCli(['compiled', '--stage', 'stable']))
  invalid(parseBenchCli(['compiled', '--frames', '1.5']))
  invalid(parseBenchCli(['browser', 'full', '--timeout', 'soon']))
  invalid(parseBenchCli(['browser', 'full', '--before', 'a', '--before-file', 'a.js']))
  invalid(parseBenchCli(['browser', 'full', '--before-stdin', '--after-stdin']))
  invalid(parseBenchCli(['browser', 'full', '--reuse', '--reuse']))
  invalid(parseBenchCli(['compare', 'compiled', '--visual']))
})
