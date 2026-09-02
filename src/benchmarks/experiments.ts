import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ComparisonCommand, ExperimentOptions } from './cli'
import type { ExecutionResult } from './execute'

export type ExperimentHandle = {
  readonly id: string
  readonly directory: string
}

type ExperimentStatus = 'pending' | 'accepted' | 'rejected' | 'error'

type ExperimentRecord = {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly status: ExperimentStatus
  readonly description?: string
  readonly aim?: string
  readonly cause?: string
  readonly hypothesis?: string
  readonly baseline: string
  readonly command: readonly string[]
  readonly patch: 'patch.diff'
  readonly result: 'result.json'
  readonly reason?: string
}
const EXPERIMENTS_DIRECTORY = '.benchmarks/experiments'
const EXPERIMENT_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/

export async function beginExperiment(
  root: string,
  command: ComparisonCommand,
  options: ExperimentOptions
): Promise<ExperimentHandle> {
  const createdAt = new Date()
  const id = `${compactTimestamp(createdAt)}-${slug(options.name)}`
  const experimentsRoot = path.join(root, EXPERIMENTS_DIRECTORY)
  await mkdir(experimentsRoot, { recursive: true })
  const directory = path.join(experimentsRoot, id)
  await mkdir(directory, { recursive: false })
  const baseline = await git(root, ['rev-parse', '--verify', `${command.baseline}^{commit}`])
  const patch = command.candidate === 'worktree'
    ? await worktreePatch(root, baseline)
    : await git(root, ['diff', '--binary', baseline, await git(root, ['rev-parse', '--verify', `${command.candidate}^{commit}`])])
  await writeFile(path.join(directory, 'patch.diff'), patch)
  await writeFile(path.join(directory, 'result.json'), 'null\n')
  const record = experimentRecord(id, createdAt, baseline, command, options, 'pending')
  await writeExperiment(directory, record)
  await appendHistory(root, record)
  return { id, directory }
}

export async function finishExperiment(root: string, handle: ExperimentHandle, result: ExecutionResult): Promise<void> {
  await writeFile(path.join(handle.directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  if (result.ok) return
  const current = await readExperiment(handle.directory)
  const record = { ...current, status: 'error' as const, reason: result.error?.message ?? 'Benchmark failed.' }
  await writeExperiment(handle.directory, record)
  await appendHistory(root, record)
}
export async function setExperimentVerdict(
  root: string,
  id: string,
  status: 'accepted' | 'rejected',
  reason: string
): Promise<ExperimentRecord> {
  if (!EXPERIMENT_ID_PATTERN.test(id)) throw new Error('Invalid experiment id.')
  const directory = path.join(root, EXPERIMENTS_DIRECTORY, id)
  const current = await readExperiment(directory)
  const record = { ...current, status, reason }
  await writeExperiment(directory, record)
  await appendHistory(root, record)
  return record
}

function experimentRecord(
  id: string,
  createdAt: Date,
  baseline: string,
  command: ComparisonCommand,
  options: ExperimentOptions,
  status: ExperimentStatus
): ExperimentRecord {
  return {
    id,
    name: options.name,
    createdAt: createdAt.toISOString(),
    status,
    description: options.description,
    aim: options.aim,
    cause: options.cause,
    hypothesis: options.hypothesis,
    baseline,
    command: commandTokens(command),
    patch: 'patch.diff',
    result: 'result.json'
  }
}
function commandTokens(command: ComparisonCommand): readonly string[] {
  const targets = {
    'compare-compiled': ['compiled'],
    'compare-no-render-bun': ['no-render', 'bun'],
    'compare-no-render-browser': ['no-render', 'browser'],
    'compare-browser-fps': ['browser', 'fps'],
    'compare-browser-visual': ['browser', 'visual'],
    'compare-browser-full': ['browser', 'full']
  } satisfies Record<ComparisonCommand['kind'], readonly string[]>
  const tokens = ['bench', 'compare', ...targets[command.kind]]
  if (command.baseline !== 'HEAD') tokens.push('--baseline', command.baseline)
  if (command.candidate !== 'worktree') tokens.push('--candidate', command.candidate)
  if (command.slot != null) tokens.push('--slot', String(command.slot))
  return tokens
}

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

function slug(value: string): string {
  const result = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (result.length === 0) throw new Error('Experiment name must contain letters or numbers.')
  return result
}

async function readExperiment(directory: string): Promise<ExperimentRecord> {
  // SAFETY: experiment.json is written only by writeExperiment from an ExperimentRecord.
  return JSON.parse(await readFile(path.join(directory, 'experiment.json'), 'utf8')) as ExperimentRecord
}

async function writeExperiment(directory: string, record: ExperimentRecord): Promise<void> {
  await writeFile(path.join(directory, 'experiment.json'), `${JSON.stringify(record, null, 2)}\n`)
}

async function appendHistory(root: string, record: ExperimentRecord): Promise<void> {
  const directory = path.join(root, EXPERIMENTS_DIRECTORY)
  await mkdir(directory, { recursive: true })
  await appendFile(path.join(directory, 'experiments.jsonl'), `${JSON.stringify(record)}\n`)
}


async function worktreePatch(root: string, baseline: string): Promise<string> {
  const parts = [await git(root, ['diff', '--binary', baseline])]
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
  for (const file of untracked) {
    parts.push(await git(root, ['diff', '--binary', '--no-index', '--', '/dev/null', file], [0, 1]))
  }
  return parts.filter(Boolean).join('\n')
}

async function git(root: string, args: readonly string[], acceptedExitCodes: readonly number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', code => acceptedExitCodes.includes(code ?? -1)
      ? resolve(Buffer.concat(stdout).toString('utf8').trim())
      : reject(new Error(`git ${args[0] ?? ''} failed: ${Buffer.concat(stderr).toString('utf8').trim()}`)))
  })
}
