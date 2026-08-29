import { fileURLToPath } from 'node:url'

import {
  formatHelp,
  parseBenchCli,
  parseBrowserCli,
  type BenchCommand,
  type BrowserCommand,
  type HookSource
} from '../src/benchmarks/cli'
import {
  executeBenchCommand,
  executeBrowserCommand,
  runKeeper,
  type ExecutionResult
} from '../src/benchmarks/execute'
import { createCommandLog } from '../src/benchmarks/commandLog'

const root = fileURLToPath(new URL('..', import.meta.url))
const [cli, ...arguments_] = Bun.argv.slice(2)

async function logNonExecution(
  operation: string,
  argumentsValue: unknown,
  exitStatus: number,
  error?: { readonly code: string; readonly message: string }
): Promise<void> {
  await createCommandLog({ filePath: `${root}/logs/flightsim-browser-bench.jsonl` }).append({
    owner: root,
    operation,
    arguments: argumentsValue,
    exitStatus,
    error
  })
}

if (cli === 'keeper') {
  const sessionName = arguments_[0]
  if (sessionName == null) process.exit(2)
  await runKeeper(sessionName)
}

function usesStdin(command: BenchCommand): boolean {
  const hookUsesStdin = (hook: HookSource | undefined) => hook?.kind === 'stdin'
  return 'hooks' in command && (
    hookUsesStdin(command.hooks.before) || hookUsesStdin(command.hooks.after)
  )
}

function printResult(result: ExecutionResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (!result.ok) {
    console.error(`${result.operation} failed: ${result.error?.message ?? 'unknown error'}`)
    return
  }
  console.log(`${result.operation} completed in ${(result.durationMs / 1_000).toFixed(2)}s`)
  if (result.data != null) console.log(JSON.stringify(result.data, null, 2))
}

async function runBrowser(arguments_: readonly string[]): Promise<number> {
  const parsed = parseBrowserCli(arguments_)
  if (parsed.kind === 'help') {
    await logNonExecution('browser-help', { arguments: arguments_ }, 0)
    console.log(formatHelp(parsed.help))
    return 0
  }
  if (parsed.kind === 'error') {
    await logNonExecution('browser-parse', { arguments: arguments_ }, 2, parsed.error)
    console.error(`${parsed.error.message}\n\n${formatHelp(parsed.help)}`)
    return 2
  }
  const command: BrowserCommand = parsed.command
  const result = await executeBrowserCommand(command, root)
  printResult(result, command.json)
  return result.ok ? 0 : 1
}

async function runBench(arguments_: readonly string[]): Promise<number> {
  const parsed = parseBenchCli(arguments_)
  if (parsed.kind === 'help') {
    await logNonExecution('bench-help', { arguments: arguments_ }, 0)
    console.log(formatHelp(parsed.help))
    return 0
  }
  if (parsed.kind === 'error') {
    await logNonExecution('bench-parse', { arguments: arguments_ }, 2, parsed.error)
    console.error(`${parsed.error.message}\n\n${formatHelp(parsed.help)}`)
    return 2
  }
  const command: BenchCommand = parsed.command
  const stdin = usesStdin(command) ? await Bun.stdin.text() : undefined
  const result = await executeBenchCommand(command, root, stdin)
  printResult(result, command.json)
  return result.ok ? 0 : 1
}

let exitCode: number
if (cli === 'browser') {
  exitCode = await runBrowser(arguments_)
} else if (cli === 'bench') {
  exitCode = await runBench(arguments_)
} else {
  await logNonExecution('cli-parse', { cli, arguments: arguments_ }, 2, {
    code: 'INVALID_CLI',
    message: 'Usage: flightsim-tools.ts browser|bench'
  })
  console.error('Usage: flightsim-tools.ts browser|bench')
  exitCode = 2
}
process.exit(exitCode)
