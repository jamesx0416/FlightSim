import os from 'node:os'
import { spawn } from 'node:child_process'

const PROCESS_ROW_PATTERN = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/
const CHROME_PROCESS_PATTERN = /(?:Google Chrome|Chromium|chrome-for-testing|agent-browser)/i

export type ProcessObservation = {
  readonly pid: number
  readonly cpuPercent: number
  readonly residentBytes: number
  readonly command: string
}

export type EnvironmentObservation = {
  readonly timestamp: string
  readonly loadAverage: readonly [number, number, number]
  readonly totalMemoryBytes: number
  readonly freeMemoryBytes: number
  readonly processResidentBytes: number
  readonly chromeProcessCount: number
  readonly chromeCpuPercent: number
  readonly chromeResidentBytes: number
  readonly chromeRendererCpuPercent: number
  readonly chromeRendererResidentBytes: number
  readonly chromeGpuProcessCpuPercent: number
  readonly chromeGpuProcessResidentBytes: number
  readonly gpuUtilizationPercent: null
}

export type EnvironmentSummary = {
  readonly sampleCount: number
  readonly peakLoadAverage1m: number
  readonly minimumFreeMemoryBytes: number
  readonly peakChromeCpuPercent: number
  readonly peakChromeResidentBytes: number
  readonly peakChromeRendererCpuPercent: number
  readonly peakChromeGpuProcessCpuPercent: number
  readonly gpuUtilizationAvailable: boolean
  readonly noiseClassification: 'unassessed'
  readonly noiseReason: string
}

function parseProcessRow(line: string): ProcessObservation | null {
  const match = PROCESS_ROW_PATTERN.exec(line)
  if (match == null) return null
  return {
    pid: Number(match[1]),
    cpuPercent: Number(match[2]),
    residentBytes: Number(match[3]) * 1_024,
    command: match[4]!
  }
}

async function chromeProcesses(): Promise<readonly ProcessObservation[]> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('ps', ['-Ao', 'pid=,pcpu=,rss=,command='], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolve(Buffer.concat(chunks).toString('utf8'))
      : reject(new Error(`ps exited with code ${code ?? 'unknown'}.`)))
  })
  return output
    .split('\n')
    .map(parseProcessRow)
    .filter((value): value is ProcessObservation => value != null)
    .filter(value => CHROME_PROCESS_PATTERN.test(value.command))
}

export async function observeEnvironment(): Promise<EnvironmentObservation> {
  const chrome = await chromeProcesses()
  const renderers = chrome.filter(process => process.command.includes('--type=renderer'))
  const gpuProcesses = chrome.filter(process => process.command.includes('--type=gpu-process'))
  const usage = process.memoryUsage()
  const loadAverageValues = os.loadavg()
  const oneMinute = loadAverageValues.at(0)
  const fiveMinutes = loadAverageValues.at(1)
  const fifteenMinutes = loadAverageValues.at(2)
  if (oneMinute == null || fiveMinutes == null || fifteenMinutes == null) throw new Error('OS load average did not contain three values.')
  const loadAverage: readonly [number, number, number] = [oneMinute, fiveMinutes, fifteenMinutes]
  return {
    timestamp: new Date().toISOString(),
    loadAverage,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    processResidentBytes: usage.rss,
    chromeProcessCount: chrome.length,
    chromeCpuPercent: chrome.reduce((total, row) => total + row.cpuPercent, 0),
    chromeResidentBytes: chrome.reduce((total, row) => total + row.residentBytes, 0),
    chromeRendererCpuPercent: renderers.reduce((total, row) => total + row.cpuPercent, 0),
    chromeRendererResidentBytes: renderers.reduce((total, row) => total + row.residentBytes, 0),
    chromeGpuProcessCpuPercent: gpuProcesses.reduce((total, row) => total + row.cpuPercent, 0),
    chromeGpuProcessResidentBytes: gpuProcesses.reduce((total, row) => total + row.residentBytes, 0),
    gpuUtilizationPercent: null
  }
}

export function summarizeEnvironment(observations: readonly EnvironmentObservation[]): EnvironmentSummary {
  const maximum = (select: (observation: EnvironmentObservation) => number) =>
    observations.reduce((value, observation) => Math.max(value, select(observation)), 0)
  const minimum = (select: (observation: EnvironmentObservation) => number) =>
    observations.reduce((value, observation) => Math.min(value, select(observation)), Number.POSITIVE_INFINITY)
  return {
    sampleCount: observations.length,
    peakLoadAverage1m: maximum(observation => observation.loadAverage[0]),
    minimumFreeMemoryBytes: minimum(observation => observation.freeMemoryBytes),
    peakChromeCpuPercent: maximum(observation => observation.chromeCpuPercent),
    peakChromeResidentBytes: maximum(observation => observation.chromeResidentBytes),
    peakChromeRendererCpuPercent: maximum(observation => observation.chromeRendererCpuPercent),
    peakChromeGpuProcessCpuPercent: maximum(observation => observation.chromeGpuProcessCpuPercent),
    gpuUtilizationAvailable: observations.some(observation => observation.gpuUtilizationPercent != null),
    noiseClassification: 'unassessed',
    noiseReason: 'No repository noise threshold is configured.'
  }
}

export class EnvironmentSampler {
  private observations: EnvironmentObservation[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  async start(intervalMs = 1_000): Promise<void> {
    this.observations = [await observeEnvironment()]
    this.timer = setInterval(() => {
      void observeEnvironment().then(observation => this.observations.push(observation))
    }, intervalMs)
  }

  async stop(): Promise<readonly EnvironmentObservation[]> {
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
    this.observations.push(await observeEnvironment())
    return this.observations
  }
}
