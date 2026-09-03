import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { DOMParser, Element } from 'linkedom'

import type {
  BenchCommand,
  BenchmarkCommand,
  BenchmarkHooks,
  BrowserCommand,
  ComparisonCommand,
  HookSource
} from './cli'
import { BrowserDriver, deriveBrowserSessionName, listAgentBrowserSessions } from './browserDriver'
import { createCommandLog } from './commandLog'
import { BENCHMARK_READINESS_STAGES } from './config'
import { EnvironmentSampler, summarizeEnvironment } from './environment'
import { beginExperiment, finishExperiment, setExperimentVerdict } from './experiments'
import {
  createBenchmarkQueue,
  isProcessAlive,
  withAtomicFileLock,
  type BenchmarkLease,
  type QueueTicket
} from './queue'
import { waitForReadiness } from './readiness'
import { createRevisionWorkspace, startRevisionServer, type RevisionWorkspace } from './revision'
import {
  CUBEMAP_FACE_NAMES,
  comparePanoramas,
  stitchEquirectangularPanorama,
  type CubemapFaceName
} from './visual'

const DEFAULT_URL = 'https://vanilla-3dtiles.localhost:3000'
const DEFAULT_PACKAGE = 'headwindsim-aircraft-a330-900'
const LEGACY_RETAINED_STATE_PATH = '.benchmarks/retained-browser.json'
const NO_RENDER_BROWSER_PAGE_PATH = '.benchmarks/no-render-browser.html'
const DEFAULT_COMPARISON_BROWSER_PORT = 3002
const DEFAULT_BROWSER_BENCHMARK_PORT = 3003
const FULL_VISUAL_CONFIRMATION_SAMPLES = 3
const RETAINED_SESSION_LOCK_DIRECTORY = path.join(tmpdir(), 'flightsim-retained-browser-locks-v1')
const AGENT_BROWSER_PROCESS_PATTERN = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u
const AGENT_BROWSER_COMMAND_PATTERN = /(?:^|\/)agent-browser(?:\s|$)/u

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- this is the runtime record view used only after isRecord validates object-ness.
type JsonRecord = Record<string, unknown>
type BrowserModeCommand = Exclude<BenchmarkCommand, Extract<BenchmarkCommand, { readonly kind: 'compiled' | 'no-render-bun' }>>

type ExecutionContext = {
  readonly root: string
  readonly cwd: string
  readonly url: string
  readonly cacheMode?: 'immutable-package-cache'
  readonly ticket: QueueTicket
  readonly slot: 1 | 2
  readonly side?: 'baseline' | 'candidate'
}

type RetainedBrowserState = {
  readonly slot: 1 | 2
  readonly sessionName: string
  readonly keeperPid: number
  readonly stage: string
  readonly url: string
  readonly openedAt: string
  readonly revisionHash: string
}

export type ExecutionResult = {
  readonly ok: boolean
  readonly operation: string
  readonly startedAt: string
  readonly durationMs: number
  readonly data?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function operationName(command: BrowserCommand | BenchCommand): string {
  return command.kind
}

function errorCode(cause: unknown): string {
  return isRecord(cause) && isString(cause.code) ? cause.code : 'BENCHMARK_FAILED'
}

async function withRecordedExecution<T>(
  root: string,
  command: BrowserCommand | BenchCommand,
  operation: () => Promise<T>
): Promise<ExecutionResult> {
  const startedAt = new Date()
  const started = performance.now()
  const log = createCommandLog({ filePath: path.join(root, 'logs/flightsim-browser-bench.jsonl') })
  try {
    const data = await operation()
    const result = {
      ok: true,
      operation: operationName(command),
      startedAt: startedAt.toISOString(),
      durationMs: performance.now() - started,
      data
    } as const
    await log.append({
      owner: root,
      operation: result.operation,
      arguments: command,
      exitStatus: 0,
      durationMs: result.durationMs,
      artifactDirectory: artifactRoot(root)
    })
    return result
  } catch (error) {
    const result = {
      ok: false,
      operation: operationName(command),
      startedAt: startedAt.toISOString(),
      durationMs: performance.now() - started,
      error: { code: errorCode(error), message: error instanceof Error ? error.message : String(error) }
    } as const
    await log.append({
      owner: root,
      operation: result.operation,
      arguments: command,
      exitStatus: 1,
      durationMs: result.durationMs,
      error: result.error,
      artifactDirectory: artifactRoot(root)
    })
    return result
  }
}

function artifactRoot(root: string): string {
  return path.join(root, '.benchmarks/artifacts')
}

async function artifactDirectory(root: string, operation: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const directory = path.join(artifactRoot(root), `${timestamp}-${operation}`)
  await mkdir(directory, { recursive: true })
  return directory
}

type AgentBrowserForegroundCommand = {
  readonly pid: number
  readonly startedAt: string
  readonly command: string
}

type BrowserStatusSession = {
  readonly sessionName: string
  readonly active: true
  readonly foregroundCommand: AgentBrowserForegroundCommand | null
  readonly lastKnownNavigationAt: string | null
  readonly lastKnownUrl: string | null
  readonly page: unknown
}

async function browserStatus(root: string) {
  const queue = createBenchmarkQueue()
  const [foreground, knownSessions, capacity, leases, waiting, retained1, retained2] = await Promise.all([
    readAgentBrowserForegroundCommands(),
    listAgentBrowserSessions(5_000),
    queue.capacity(),
    queue.activeLeases(),
    queue.waitingTickets(),
    tryReadRetainedState(root, 1),
    tryReadRetainedState(root, 2)
  ])
  const sessions: BrowserStatusSession[] = []

  for (const sessionName of knownSessions) {
    const driver = new BrowserDriver({ session: sessionName, timeoutMs: 5_000 })
    let active = false
    try {
      active = await driver.isSessionActive(5_000)
    } catch {
      continue
    }
    if (!active) continue

    const command = foreground.find(entry => commandTargetsSession(entry.command, sessionName)) ?? null
    const target = await readAgentBrowserTargetMetadata(sessionName)
    let page: BrowserStatusSession['page'] = null
    try {
      page = await driver.evalJson<unknown>(`({
        href: location.href,
        devApi: typeof window.__DevApi === 'object',
        activity: window.__DevApi?.activity?.status?.() ?? null,
        lastInteraction: window.__DevApi?.interactions?.history?.({ limit: 1 }) ?? null
      })`, 5_000)
    } catch (error) {
      page = { unavailable: true, error: error instanceof Error ? error.message : String(error) }
    }

    sessions.push({
      sessionName,
      active: true,
      foregroundCommand: command,
      lastKnownNavigationAt: target?.modifiedAt ?? null,
      lastKnownUrl: target?.url ?? null,
      page
    })
  }

  return {
    activeCount: sessions.length,
    capacity,
    slots: [1, 2].map(slot => ({ slot, lease: leases.find(lease => lease.slot === slot) ?? null })),
    waiting,
    queueLeases: leases,
    retained: [retained1, retained2].filter(state => state != null),
    sessions,
    note: 'Status inspects existing Agent Browser sessions only; it never opens Chrome.'
  }
}

async function readAgentBrowserForegroundCommands(): Promise<readonly AgentBrowserForegroundCommand[]> {
  const child = spawn('ps', ['-axo', 'pid=,lstart=,command='], { stdio: ['ignore', 'pipe', 'ignore'] })
  let stdout = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { stdout += String(chunk) })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => resolve())
  })
  return stdout.split('\n').flatMap(line => {
    const match = AGENT_BROWSER_PROCESS_PATTERN.exec(line)
    if (match == null || !AGENT_BROWSER_COMMAND_PATTERN.test(match[3])) return []
    return [{ pid: Number(match[1]), startedAt: match[2], command: match[3] }]
  })
}

function commandTargetsSession(command: string, sessionName: string): boolean {
  return command.includes(`--session ${sessionName}`) || command.includes(`--session=${sessionName}`)
}

async function readAgentBrowserTargetMetadata(sessionName: string): Promise<{ readonly url: string | null; readonly modifiedAt: string } | null> {
  const targetPath = path.join(homedir(), '.agent-browser', `${sessionName}.target`)
  try {
    const [metadata, contents] = await Promise.all([stat(targetPath), readFile(targetPath, 'utf8')])
    let url: string | null = null
    try {
      const parsed: unknown = JSON.parse(contents)
      if (isRecord(parsed) && isString(parsed.url)) url = parsed.url
    } catch {}
    return { url, modifiedAt: metadata.mtime.toISOString() }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null
    throw error
  }
}

async function acquireQueue(slot?: 1 | 2) {
  const queue = createBenchmarkQueue()
  const onProgress = ({ requestsAhead }: { readonly requestsAhead: number }) =>
    console.error(`Waiting for benchmark slot, ${requestsAhead} request${requestsAhead === 1 ? '' : 's'} ahead`)
  if (slot != null) return { queue, ...(await queue.acquireSlot(slot, { onProgress })) }
  const ticket = await queue.join()
  const lease = await queue.waitForLease(ticket, { onProgress })
  return { queue, ticket, lease }
}

async function resolveHook(hook: HookSource | undefined, cwd: string, stdin: string | undefined): Promise<string | undefined> {
  if (hook == null) return undefined
  if (hook.kind === 'inline') return hook.source
  if (hook.kind === 'file') return readFile(path.resolve(cwd, hook.path), 'utf8')
  if (stdin == null) throw new Error('A stdin hook was requested but standard input was empty.')
  return stdin
}

async function resolvedHooks(hooks: BenchmarkHooks, cwd: string, stdin: string | undefined) {
  return {
    before: await resolveHook(hooks.before, cwd, stdin),
    after: await resolveHook(hooks.after, cwd, stdin)
  }
}

function createDriver(context: ExecutionContext, timeoutMs: number): BrowserDriver {
  return new BrowserDriver({
    cwd: context.cwd,
    timeoutMs,
    profile: path.join(context.root, '.benchmarks', context.slot === 1 ? 'chrome-profile' : 'chrome-profile-2'),
    session: deriveBrowserSessionName({
      worktree: context.cwd,
      agentId: `${process.pid}${context.side == null ? '' : `-${context.side}`}`,
      queueSequence: context.ticket.sequence
    })
  })
}

async function runHook(driver: BrowserDriver, source: string | undefined, phase: string) {
  if (source == null) return null
  const result = await driver.evalJson<unknown>(`(async () => { ${source}\n })()`)
  if (isRecord(result) && result.ok === false) throw new Error(`${phase} hook returned a failed DevApi response.`)
  return result
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function withRetainedSessionLock<T>(sessionName: string, operation: () => Promise<T>): Promise<T> {
  return withAtomicFileLock(
    path.join(RETAINED_SESSION_LOCK_DIRECTORY, `${sessionName}.lock`),
    process.pid,
    isProcessAlive,
    operation
  )
}

async function readPageRevisionHash(driver: BrowserDriver): Promise<string> {
  const metadata = await driver.evalJson<unknown>(`fetch('/__devapi/git.json', { cache: 'no-store' })
    .then(async response => response.ok ? response.json() : null)`)
  if (!isRecord(metadata) || metadata.available !== true || !isString(metadata.hash)) {
    throw new Error('The retained FlightSim page could not report its Git revision.')
  }
  return metadata.hash
}

async function assertRevisionServerIdentity(driver: BrowserDriver, workspace: RevisionWorkspace) {
  const identity = await driver.evalJson<unknown>(`Promise.all([
    fetch('/__benchmark/revision.json', { cache: 'no-store' }).then(async response => response.ok ? response.json() : null),
    Promise.resolve(globalThis.__FlightSimBenchmarkRevision ?? null)
  ])`)
  const server = Array.isArray(identity) ? identity[0] : null
  const page = Array.isArray(identity) ? identity[1] : null
  const expected = { selector: workspace.selector, revision: workspace.revision }
  if (!isRecord(server) || server.selector !== expected.selector || server.revision !== expected.revision ||
      !isRecord(page) || page.selector !== expected.selector || page.revision !== expected.revision) {
    throw new Error(`Revision browser identity mismatch for ${workspace.selector}.`)
  }
  return { server, page }
}

function comparisonBrowserPort(): number {
  const raw = process.env.FLIGHTSIM_BENCH_COMPARE_PORT
  const port = raw == null ? DEFAULT_COMPARISON_BROWSER_PORT : Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('FLIGHTSIM_BENCH_COMPARE_PORT must be an integer from 1 to 65535.')
  }
  return port
}

function browserBenchmarkPort(slot: 1 | 2, raw = process.env.FLIGHTSIM_BENCH_PORT): number {
  const basePort = raw == null ? DEFAULT_BROWSER_BENCHMARK_PORT : Number(raw)
  const port = basePort + slot - 1
  if (!Number.isInteger(basePort) || basePort <= 0 || port > 65_535) {
    throw new Error('FLIGHTSIM_BENCH_PORT must leave room for benchmark slots within ports 1 to 65535.')
  }
  return port
}

function usesManagedBenchmarkServer(
  command: BenchmarkCommand,
  benchmarkUrl = process.env.FLIGHTSIM_BENCH_URL
): boolean {
  if (benchmarkUrl != null) return false
  if (command.kind === 'compiled' || command.kind === 'no-render-bun') return false
  if (command.keepOpen || ('reuse' in command && command.reuse)) return false
  return true
}

function noRenderBrowserPageSource(): string {
  return `<!doctype html><meta charset="utf-8"><script type="module">
import { runBunAircraftRuntimeBenchmark } from '/src/sim/benchmarks/bunAircraftRuntimeAdapter.ts'
const packageRoot = new URL('/aircrafts/${DEFAULT_PACKAGE}/', location.href).href
const additionalPackageRoots = [new URL('/vendor/msfs-stock/', location.href).href]
globalThis.__FlightSimNoRenderBenchmark = async options => {
  try {
    const result = await runBunAircraftRuntimeBenchmark({ packageRoot, additionalPackageRoots, ...options })
    return { ok: true, data: {
      ...result.benchmark,
      aircraftId: result.aircraftId,
      setupMs: result.setupMs,
      source: { model: result.model }
    } }
  } catch (error) {
    return { ok: false, summary: error instanceof Error ? error.message : String(error) }
  }
}
</script>\n`
}

async function prepareNoRenderBrowserPage(context: ExecutionContext): Promise<string> {
  const pagePath = path.join(context.cwd, NO_RENDER_BROWSER_PAGE_PATH)
  await mkdir(path.dirname(pagePath), { recursive: true })
  await writeFile(pagePath, noRenderBrowserPageSource())
  return new URL(`/${NO_RENDER_BROWSER_PAGE_PATH}`, context.url).href
}

async function noRenderHarnessReadiness(driver: BrowserDriver, timeoutMs: number) {
  const condition = 'typeof window.__FlightSimNoRenderBenchmark === "function"'
  const startedAt = performance.now()
  await driver.waitFn(condition, timeoutMs)
  return {
    requestedStage: 'gltf:interior-upgrade:ready',
    resolvedStage: 'no-render:ready',
    kind: 'custom',
    condition,
    timeoutMs,
    elapsedMs: performance.now() - startedAt,
    completedStages: ['no-render:ready'],
    observedStatus: { noRenderHarness: true }
  }
}

async function runBrowserMeasurement(
  command: BrowserModeCommand,
  context: ExecutionContext,
  stdin: string | undefined,
  retainedDriver?: BrowserDriver
): Promise<{
  readonly result: unknown
  readonly driver: BrowserDriver
  readonly execution: unknown
  readonly readiness?: unknown
  readonly artifacts?: unknown
}> {
  const driver = retainedDriver ?? createDriver(context, command.timeoutMs)
  const lightweightNoRender = retainedDriver == null &&
    command.kind === 'no-render-browser' &&
    command.stage === 'gltf:interior-upgrade:ready' &&
    command.keepOpen === false
  const pageUrl = lightweightNoRender ? await prepareNoRenderBrowserPage(context) : context.url
  const sampler = new EnvironmentSampler()
  await sampler.start()
  let readiness = null
  let result = null
  let artifacts = null
  const startedAt = performance.now()
  let completed = false
  try {
    try {
      if (retainedDriver == null) {
        await driver.open(pageUrl, command.timeoutMs)
      }
      readiness = lightweightNoRender
        ? await noRenderHarnessReadiness(driver, command.timeoutMs)
        : await waitForReadiness(driver, {
            stage: command.stage,
            mode: command.kind === 'browser-load' ? 'load' : command.kind === 'no-render-browser' ? 'no-render' : command.kind === 'browser-profile' ? 'profile' : command.kind === 'browser-visual' ? 'visual' : command.kind === 'browser-fps' ? 'full' : 'full',
            timeoutMs: command.timeoutMs,
            stages: BENCHMARK_READINESS_STAGES
          })
      if (command.kind === 'browser-load') {
        result = { elapsedMs: performance.now() - startedAt, stage: command.stage }
      } else {
        const hooks = await resolvedHooks(command.hooks, context.cwd, stdin)
        const before = await runHook(driver, hooks.before, 'Before')
        const settleMs = 'settleMs' in command ? command.settleMs : undefined
        if (retainedDriver != null && settleMs != null) await sleep(settleMs)
        if (command.kind === 'no-render-browser') {
          result = await browserNoRender(driver, command.frames, command.warmupFrames)
        } else if (command.kind === 'browser-fps' || command.kind === 'browser-full') {
          result = await browserFull(driver, command.frames, command.warmupFrames, command.timeoutMs)
        } else if (command.kind === 'browser-profile') {
          const directory = await artifactDirectory(context.root, command.kind)
          const profilePath = path.join(directory, 'chrome-profile.json')
          await driver.startProfile()
          try {
            result = await browserFull(driver, command.frames, command.warmupFrames, command.timeoutMs)
          } finally {
            await driver.stopProfile(profilePath)
          }
          artifacts = { profile: profilePath }
        } else {
          const directory = await artifactDirectory(context.root, command.kind)
          artifacts = await capturePanorama(driver, directory)
          result = { visual: artifacts }
        }
        const after = await runHook(driver, hooks.after, 'After')
        if (command.kind === 'browser-full') {
          const directory = await artifactDirectory(context.root, command.kind)
          const visual = await capturePanorama(driver, directory)
          artifacts = visual
          result = { before, measurement: result, after, visual }
        } else {
          result = { before, measurement: result, after }
        }
      }
    } finally {
      const environment = await sampler.stop()
      result = { result, environment, environmentSummary: summarizeEnvironment(environment) }
    }
    completed = true
  } finally {
    if (!completed && retainedDriver == null) await driver.close().catch(() => {})
  }
  const reused = retainedDriver != null
  const executionBase = {
    page: reused ? 'reused' : lightweightNoRender ? 'fresh-no-render-harness' : 'fresh-navigation',
    cache: context.cacheMode ?? 'uncontrolled-browser-cache',
    measurement: reused ? 'steady-state-reuse' : lightweightNoRender ? 'no-render-runtime' : command.kind === 'browser-load' ? 'load' : 'fresh-page'
  }
  const execution = reused && 'settleMs' in command
    ? { ...executionBase, settleMs: command.settleMs }
    : executionBase
  const base = { result, driver, execution }
  if (readiness == null) return artifacts == null ? base : { ...base, artifacts }
  return artifacts == null ? { ...base, readiness } : { ...base, readiness, artifacts }
}

async function browserNoRender(driver: BrowserDriver, frames?: number, warmupFrames?: number) {
  const frameOptions = frames == null
    ? warmupFrames == null ? {} : { warmupFrames }
    : warmupFrames == null ? { frames } : { frames, warmupFrames }
  const options = JSON.stringify(frameOptions)
  const response = await driver.evalJson<unknown>(`typeof window.__FlightSimNoRenderBenchmark === 'function'
    ? window.__FlightSimNoRenderBenchmark(${options})
    : window.__DevApi.bench.aircraftRuntime(${options})`)
  if (!isRecord(response) || response.ok !== true) {
    throw new Error(`Browser no-render benchmark failed: ${JSON.stringify(response)}`)
  }
  return response.data
}

async function browserFull(
  driver: BrowserDriver,
  frames = 300,
  warmupFrames = 30,
  timeoutMs = driver.timeoutMs
) {
  return driver.evalJson<unknown>(createBrowserFullExpression(frames, warmupFrames, timeoutMs))
}

function createBrowserFullExpression(frames: number, warmupFrames: number, timeoutMs: number): string {
  return `(async () => {
    const settings = window.__DevApi.settings.get()
    if (settings?.ok !== true) throw new Error(settings?.summary ?? 'Could not read cockpit performance setting.')
    const cockpitPerfWasEnabled = settings.data?.cockpitPerf === true
    const enabled = cockpitPerfWasEnabled ? settings : await window.__DevApi.settings.set({ cockpitPerf: true })
    if (enabled?.ok !== true) throw new Error(enabled?.summary ?? 'Could not enable cockpit performance collection.')
    const activity = window.__DevApi.activity.begin('benchmark:full')
    const activityId = activity?.ok === true ? activity.data?.id : null
    try {
      const collector = globalThis.__cockpitPerf
      if (collector == null || collector.enabled !== true) throw new Error('Cockpit performance collector is unavailable.')
      const deadline = performance.now() + ${Math.max(1_000, timeoutMs - 5_000)}
    const waitForFrames = async count => {
      for (let completed = 0; completed < count; completed += 1) {
        if (performance.now() >= deadline) throw new Error('Cockpit performance warmup timed out.')
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
    }
    const waitForSamples = async count => {
      while ((collector.getSummary()?.sampleCount ?? 0) < count) {
        if (performance.now() >= deadline) throw new Error('Cockpit performance sampling timed out.')
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
    }
    await waitForFrames(${warmupFrames})
    collector.reset(${frames})
    await waitForSamples(${frames})
    const perfResponse = window.__DevApi.perf()
    if (perfResponse?.ok !== true) throw new Error(perfResponse?.summary ?? 'Could not collect viewer performance data.')
    const runtimeHost = perfResponse.data?.runtimeHost ?? {}
    return {
      cockpitPerf: collector.getSummary(),
      devApi: {
        fps: perfResponse.data?.fps,
        rendererInfo: perfResponse.data?.rendererInfo,
        runtimeHost: {
          variableReadCount: runtimeHost.variableReadCount,
          variableReadCacheHitCount: runtimeHost.variableReadCacheHitCount,
          variableReadCacheMissCount: runtimeHost.variableReadCacheMissCount,
          variableWriteCount: runtimeHost.variableWriteCount,
          keyEventCount: runtimeHost.keyEventCount,
          htmlEventCount: runtimeHost.htmlEventCount,
          soundEventCount: runtimeHost.soundEventCount,
          bridgeCallCount: runtimeHost.bridgeCallCount,
          storedVariableCount: runtimeHost.storedVariableCount,
          defaultedVariableCount: runtimeHost.defaultedVariableCount
        }
      }
    }
    } finally {
      try {
        if (!cockpitPerfWasEnabled) {
          const restored = await window.__DevApi.settings.set({ cockpitPerf: false })
          if (restored?.ok !== true) throw new Error(restored?.summary ?? 'Could not restore cockpit performance setting.')
        }
      } finally {
        if (activityId != null) window.__DevApi.activity.end(activityId)
      }
    }
  })()`
}

const FACE_ROTATIONS = {
  front: [0, 0, 0, 1],
  back: [0, 1, 0, 0],
  left: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  right: [0, -Math.SQRT1_2, 0, Math.SQRT1_2],
  up: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  down: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]
} satisfies Readonly<Record<CubemapFaceName, readonly [number, number, number, number]>>

async function capturePanorama(driver: BrowserDriver, directory: string) {
  const poseResponse = await driver.evalJson<unknown>('window.__DevApi.camera.getPose()')
  if (!isRecord(poseResponse) || poseResponse.ok !== true || !isRecord(poseResponse.data)) {
    throw new Error('Could not collect the authoritative visual camera pose.')
  }
  const basePose = poseResponse.data
  const viewport = await driver.evalJson<{ readonly width: number; readonly height: number }>('({ width: innerWidth, height: innerHeight })')
  const activity = await driver.evalJson<unknown>(`window.__DevApi.activity.begin('benchmark:visual')`)
  const activityId = isRecord(activity) && activity.ok === true && isRecord(activity.data) && isNumber(activity.data.id)
    ? activity.data.id
    : null
  const facesDirectory = path.join(directory, 'faces')
  await mkdir(facesDirectory, { recursive: true })
  // SAFETY: the loop below writes one path for each CUBEMAP_FACE_NAMES member before facePaths is consumed.
  const facePaths = {} as Record<CubemapFaceName, string>
  let frozen = false
  let uiHidden = false
  try {
    await driver.eval(`(() => {
      for (const element of document.body.children) {
        if (!(element instanceof HTMLDivElement)) continue
        element.dataset.flightSimBenchmarkVisualVisibility = element.style.visibility
        element.style.visibility = 'hidden'
      }
    })()` )
    uiHidden = true
    const freeze = await driver.evalJson<unknown>('window.__DevApi.visual.freeze(true)')
    if (!isRecord(freeze) || freeze.ok !== true) throw new Error('Could not freeze viewer updates for visual capture.')
    frozen = true
    await driver.setViewport(1_024, 1_024)
    for (const name of CUBEMAP_FACE_NAMES) {
      const facePath = path.join(facesDirectory, `${name}.png`)
      const response = await driver.evalJson<unknown>(`(() => {
        const base = ${JSON.stringify(basePose)}
        const local = ${JSON.stringify(FACE_ROTATIONS[name])}
        const multiply = (a, b) => [
          a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
          a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
          a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
          a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
        ]
        const rotate = (q, v) => {
          const qv = [q[0], q[1], q[2]]
          const uv = [qv[1] * v[2] - qv[2] * v[1], qv[2] * v[0] - qv[0] * v[2], qv[0] * v[1] - qv[1] * v[0]]
          const uuv = [qv[1] * uv[2] - qv[2] * uv[1], qv[2] * uv[0] - qv[0] * uv[2], qv[0] * uv[1] - qv[1] * uv[0]]
          return v.map((value, index) => value + 2 * (q[3] * uv[index] + uuv[index]))
        }
        const quaternion = multiply(base.quaternion, local)
        const direction = rotate(quaternion, [0, 0, -1])
        const target = base.position.map((value, index) => value + direction[index])
        return window.__DevApi.camera.setPose({ ...base, quaternion, target, fov: 90 })
      })()`)
      if (!isRecord(response) || response.ok !== true) throw new Error(`Could not set ${name} panorama pose.`)
      await driver.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await driver.screenshot(facePath, 'body > canvas')
      facePaths[name] = facePath
    }
  } finally {
    await driver.evalJson<unknown>(`window.__DevApi.camera.setPose(${JSON.stringify(basePose)})`).catch(() => null)
    await driver.setViewport(viewport.width, viewport.height).catch(() => null)
    if (frozen) {
      await driver.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))').catch(() => null)
      await driver.evalJson<unknown>('window.__DevApi.visual.freeze(false)').catch(() => null)
    }
    if (uiHidden) {
      await driver.eval(`(() => {
        for (const element of document.body.children) {
          if (!(element instanceof HTMLDivElement)) continue
          const previous = element.dataset.flightSimBenchmarkVisualVisibility
          if (previous == null) continue
          element.style.visibility = previous
          delete element.dataset.flightSimBenchmarkVisualVisibility
        }
      })()` ).catch(() => null)
    }
    if (activityId != null) {
      await driver.evalJson<unknown>(`window.__DevApi.activity.end(${activityId})`).catch(() => null)
    }
  }
  const panoramaPath = path.join(directory, 'panorama.png')
  await stitchEquirectangularPanorama(facePaths, panoramaPath)
  const reportPath = path.join(directory, 'visual.json')
  const report = { panorama: panoramaPath, faces: facePaths, pose: basePose, projection: 'equirectangular', width: 4_096, height: 2_048 }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return { ...report, report: reportPath }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await stat(value)
    return true
  } catch {
    return false
  }
}

async function ensureBenchmarkHarness(root: string, cwd: string): Promise<void> {
  if (root === cwd) return
  const benchmarkDirectory = path.join(cwd, 'src/sim/benchmarks')
  // A/B sides must use the same measurement harness even when the selected
  // product revision predates the CLI.
  await cp(path.join(root, 'src/sim/benchmarks'), benchmarkDirectory, { recursive: true })
  const scheduler = path.join(cwd, 'src/msfs/updateBindingScheduler.ts')
  if (!await pathExists(scheduler)) {
    await cp(path.join(root, 'src/msfs/updateBindingScheduler.ts'), scheduler)
  }
}

async function runBunCommand(command: Extract<BenchmarkCommand, { readonly kind: 'compiled' | 'no-render-bun' }>, root: string, cwd: string) {
  installDomGlobals()
  await ensureBenchmarkHarness(root, cwd)
  const packageRoot = pathToFileURL(path.join(cwd, 'aircrafts', DEFAULT_PACKAGE, path.sep)).href
  const additionalPackageRoots = [pathToFileURL(path.join(cwd, 'public/vendor/msfs-stock', path.sep)).href]
  const frameOptions = command.frames == null
    ? command.warmupFrames == null ? {} : { warmupFrames: command.warmupFrames }
    : command.warmupFrames == null ? { frames: command.frames } : { frames: command.frames, warmupFrames: command.warmupFrames }
  if (command.kind === 'compiled') {
    const moduleUrl = `${pathToFileURL(path.join(cwd, 'src/sim/benchmarks/bunCompiledBindingsAdapter.ts')).href}?revision=${Date.now()}`
    // SAFETY: moduleUrl points at this repository's compiled bindings adapter with only a cache-busting query.
    const adapter = await import(moduleUrl) as typeof import('../sim/benchmarks/bunCompiledBindingsAdapter')
    return adapter.runBunCompiledBindingsBenchmark({ packageRoot, additionalPackageRoots, ...frameOptions })
  }
  const moduleUrl = `${pathToFileURL(path.join(cwd, 'src/sim/benchmarks/bunAircraftRuntimeAdapter.ts')).href}?revision=${Date.now()}`
  // SAFETY: moduleUrl points at this repository's aircraft runtime adapter with only a cache-busting query.
  const adapter = await import(moduleUrl) as typeof import('../sim/benchmarks/bunAircraftRuntimeAdapter')
  return adapter.runBunAircraftRuntimeBenchmark({ packageRoot, additionalPackageRoots, ...frameOptions })
}

function installDomGlobals(): void {
  if (globalThis.DOMParser != null) return
  // This indirection keeps browser bundles from importing the Bun-only DOM adapter.
  // SAFETY: these globals are installed only for the Bun benchmark DOM shim and restored by process exit.
  const globals = globalThis as typeof globalThis & { DOMParser?: unknown; Element?: unknown; window?: unknown }
  Object.defineProperty(globals, 'DOMParser', { value: DOMParser, configurable: true })
  Object.defineProperty(globals, 'Element', { value: Element, configurable: true })
  Object.defineProperty(globals, 'window', { value: globalThis, configurable: true })
}

async function runSingleBenchmark(
  command: BenchmarkCommand,
  context: ExecutionContext,
  stdin: string | undefined,
  retainedDriver?: BrowserDriver
): Promise<{ readonly data: unknown; readonly driver?: BrowserDriver }> {
  if (command.kind === 'compiled' || command.kind === 'no-render-bun') {
    const sampler = new EnvironmentSampler()
    await sampler.start()
    try {
      const measurement = await runBunCommand(command, context.root, context.cwd)
      const environment = await sampler.stop()
      return { data: { measurement, environment, environmentSummary: summarizeEnvironment(environment) } }
    } catch (error) {
      await sampler.stop()
      throw error
    }
  }
  const browser = await runBrowserMeasurement(command, context, stdin, retainedDriver)
  return { data: browser, driver: browser.driver }
}

async function spawnKeeper(root: string, sessionName: string): Promise<number> {
  const child = spawn(process.execPath, [path.join(root, 'scripts/flightsim-tools.ts'), 'keeper', sessionName], {
    cwd: root,
    detached: true,
    stdio: 'ignore'
  })
  if (child.pid == null) throw new Error('Could not start retained browser lease keeper.')
  child.unref()
  return child.pid
}

function retainedStatePath(root: string, slot: 1 | 2): string {
  return path.join(root, `.benchmarks/retained-browser-${slot}.json`)
}

function legacyRetainedStatePath(root: string): string {
  return path.join(root, LEGACY_RETAINED_STATE_PATH)
}

async function retainBrowser(root: string, lease: BenchmarkLease, driver: BrowserDriver, stage: string, url: string): Promise<RetainedBrowserState> {
  const revisionHash = await readPageRevisionHash(driver)
  const keeperPid = await spawnKeeper(root, driver.session)
  const queue = createBenchmarkQueue()
  await queue.transferToKeeper(lease, keeperPid, driver.session)
  const state = {
    slot: lease.slot,
    sessionName: driver.session,
    keeperPid,
    stage,
    url,
    openedAt: new Date().toISOString(),
    revisionHash
  } as const
  const statePath = retainedStatePath(root, lease.slot)
  await mkdir(path.dirname(statePath), { recursive: true })
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
  if (lease.slot === 1) await rm(legacyRetainedStatePath(root), { force: true })
  return state
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- retained state is decoded from JSON at this boundary.
function parseRetainedBrowserState(value: unknown, slot: 1 | 2): RetainedBrowserState {
  if (!isRecord(value) || !isString(value.sessionName) || !isNumber(value.keeperPid) || !isString(value.stage) || !isString(value.url) || !isString(value.openedAt) || !isString(value.revisionHash)) {
    throw new Error('Retained browser state is malformed.')
  }
  if (value.slot != null && value.slot !== slot) throw new Error('Retained browser state slot does not match its file.')
  return {
    slot,
    sessionName: value.sessionName,
    keeperPid: value.keeperPid,
    stage: value.stage,
    url: value.url,
    openedAt: value.openedAt,
    revisionHash: value.revisionHash
  }
}

async function readRetainedState(root: string, slot: 1 | 2 = 1): Promise<RetainedBrowserState> {
  try {
    return parseRetainedBrowserState(JSON.parse(await readFile(retainedStatePath(root, slot), 'utf8')), slot)
  } catch (error) {
    if (!(isRecord(error) && error.code === 'ENOENT') || slot !== 1) throw error
  }
  return parseRetainedBrowserState(JSON.parse(await readFile(legacyRetainedStatePath(root), 'utf8')), 1)
}

async function tryReadRetainedState(root: string, slot: 1 | 2 = 1): Promise<RetainedBrowserState | null> {
  try {
    return await readRetainedState(root, slot)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null
    throw error
  }
}

async function lowestRetainedState(root: string): Promise<RetainedBrowserState | null> {
  return await tryReadRetainedState(root, 1) ?? await tryReadRetainedState(root, 2)
}

async function waitForSessionInactive(driver: BrowserDriver, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (await driver.isSessionActive(Math.min(1_000, timeoutMs))) {
    if (performance.now() >= deadline) {
      throw new Error(`Agent Browser session ${driver.session} remained active after close.`)
    }
    await sleep(100)
  }
}

async function closeRetained(root: string, slot: 1 | 2 = 1) {
  const state = await readRetainedState(root, slot)
  return withRetainedSessionLock(state.sessionName, async () => {
    const driver = new BrowserDriver({ session: state.sessionName, cwd: root })
    const browserAlreadyGone = !await driver.isSessionActive(5_000)
    let closeError: unknown
    if (!browserAlreadyGone) {
      try {
        await driver.close()
      } catch (error) {
        closeError = error
      }
      try {
        await waitForSessionInactive(driver)
      } catch (error) {
        throw closeError ?? error
      }
    }

    try { process.kill(state.keeperPid, 'SIGTERM') } catch {}
    await createBenchmarkQueue().releaseRetained(state.sessionName)
    await rm(retainedStatePath(root, slot), { force: true })
    if (slot === 1) await rm(legacyRetainedStatePath(root), { force: true })
    return { closed: !browserAlreadyGone && closeError == null, browserAlreadyGone, slot, sessionName: state.sessionName }
  })
}

export async function runKeeper(sessionName: string): Promise<never> {
  const driver = new BrowserDriver({ session: sessionName })
  for (;;) {
    await sleep(2_000)
    try {
      await withRetainedSessionLock(sessionName, () => driver.inspectSession(5_000))
    } catch {
      process.exit(0)
    }
  }
}

export async function executeBrowserCommand(command: BrowserCommand, root: string, stdin?: string): Promise<ExecutionResult> {
  return withRecordedExecution(root, command, async () => {
    if (command.kind === 'browser-status') return browserStatus(root)
    if (command.kind === 'browser-concurrency') {
      const queue = createBenchmarkQueue()
      const capacity = command.capacity == null ? await queue.capacity() : await queue.setCapacity(command.capacity)
      return { capacity, activeLeases: await queue.activeLeases() }
    }
    if (command.kind === 'browser-close') {
      const retained = command.slot == null ? await lowestRetainedState(root) : await readRetainedState(root, command.slot)
      if (retained == null) throw new Error('No retained browser is available.')
      return closeRetained(root, retained.slot)
    }
    if (command.kind === 'browser-eval') {
      const retained = command.slot == null ? await lowestRetainedState(root) : await readRetainedState(root, command.slot)
      if (retained == null) throw new Error('browser eval requires an already retained browser.')
      return withRetainedSessionLock(retained.sessionName, async () => {
        const driver = new BrowserDriver({ session: retained.sessionName, cwd: root })
        if (!await driver.isSessionActive(5_000)) throw new Error(`Retained Agent Browser session ${retained.sessionName} is not active.`)
        const source = await resolveHook(command.source, root, stdin)
        if (source == null) throw new Error('browser eval source is unavailable.')
        return { slot: retained.slot, sessionName: retained.sessionName, result: await driver.eval(source) }
      })
    }
    const { queue, ticket, lease } = await acquireQueue(command.slot)
    const context = { root, cwd: root, url: process.env.FLIGHTSIM_BENCH_URL ?? DEFAULT_URL, ticket, slot: lease.slot }
    const driver = createDriver(context, command.timeoutMs)
    try {
      await driver.open(context.url)
      const readiness = await waitForReadiness(driver, {
        stage: command.stage,
        mode: 'browser',
        timeoutMs: command.timeoutMs,
        stages: BENCHMARK_READINESS_STAGES
      })
      const retained = await retainBrowser(root, lease, driver, command.stage, context.url)
      return { readiness, retained }
    } catch (error) {
      await driver.close().catch(() => {})
      await queue.release(lease)
      throw error
    }
  })
}

async function compareBrowserFullVisualFirst(
  command: Extract<ComparisonCommand, { readonly kind: 'compare-browser-full' }>,
  root: string,
  ticket: QueueTicket,
  slot: 1 | 2,
  stdin: string | undefined
) {
  const port = comparisonBrowserPort()
  const driver = createDriver({ root, cwd: root, url: `http://127.0.0.1:${port}`, ticket, slot }, command.timeoutMs)
  const browser = { stage: command.stage, timeoutMs: command.timeoutMs, reuse: false, keepOpen: false, hooks: command.hooks, json: true } as const
  const visualCommand: BenchmarkCommand = { kind: 'browser-visual', ...browser }
  const fpsCommand: BenchmarkCommand = { kind: 'browser-fps', frames: command.frames, warmupFrames: command.warmupFrames, ...browser }

  const runRevision = async (selector: string, side: 'baseline' | 'candidate', benchmark: BenchmarkCommand, samples = 1) => {
    const workspace = await createRevisionWorkspace(root, selector)
    let server: Awaited<ReturnType<typeof startRevisionServer>> | undefined
    try {
      server = await startRevisionServer(workspace, 30_000, port)
      await driver.open(server.url, command.timeoutMs)
      await assertRevisionServerIdentity(driver, workspace)
      const context = { root, cwd: workspace.cwd, url: server.url, ticket, slot, side } as const
      const results: unknown[] = []
      while (results.length < samples) results.push((await runSingleBenchmark(benchmark, context, stdin, driver)).data)
      return { revision: workspace.revision, result: samples === 1 ? results[0] : results }
    } finally {
      await server?.stop()
      await workspace.cleanup()
    }
  }

  try {
    const baselineVisual = await runRevision(command.baseline, 'baseline', visualCommand)
    const candidateVisual = await runRevision(command.candidate, 'candidate', visualCommand)
    const visual = await compareVisualArtifacts(baselineVisual.result, candidateVisual.result, root)
    const visualPassed = isVisualComparisonIdentical(visual)
    if (!visualPassed) {
      return {
        baseline: { selector: command.baseline, revision: baselineVisual.revision, result: { visual: baselineVisual.result, performanceSamples: [] } },
        candidate: { selector: command.candidate, revision: candidateVisual.revision, result: { visual: candidateVisual.result, performanceSamples: [] } },
        semantic: compareSemantics(baselineVisual.result, candidateVisual.result),
        performance: { available: false, skipped: true, reason: 'visual-mismatch' },
        visual,
        confirmation: { samplesPerRevision: FULL_VISUAL_CONFIRMATION_SAMPLES, visualPassed: false, completed: false }
      }
    }

    const baselinePerformance = await runRevision(command.baseline, 'baseline', fpsCommand, FULL_VISUAL_CONFIRMATION_SAMPLES)
    const candidatePerformance = await runRevision(command.candidate, 'candidate', fpsCommand, FULL_VISUAL_CONFIRMATION_SAMPLES)
    const baselineResult = { visual: baselineVisual.result, performanceSamples: baselinePerformance.result }
    const candidateResult = { visual: candidateVisual.result, performanceSamples: candidatePerformance.result }
    return {
      baseline: { selector: command.baseline, revision: baselinePerformance.revision, result: baselineResult },
      candidate: { selector: command.candidate, revision: candidatePerformance.revision, result: candidateResult },
      semantic: compareSemantics(baselineResult, candidateResult),
      performance: comparePrimaryMetric(baselineResult, candidateResult),
      visual,
      confirmation: { samplesPerRevision: FULL_VISUAL_CONFIRMATION_SAMPLES, visualPassed: true, completed: true }
    }
  } finally {
    await driver.close().catch(() => {})
  }
}

async function compare(command: ComparisonCommand, root: string, ticket: QueueTicket, slot: 1 | 2, stdin: string | undefined) {
  if (command.kind === 'compare-browser-full') return compareBrowserFullVisualFirst(command, root, ticket, slot, stdin)
  const sharedBrowser = command.kind === 'compare-browser-fps' || command.kind === 'compare-browser-visual'
  const sharedPort = sharedBrowser ? comparisonBrowserPort() : undefined
  const sharedDriver = command.kind === 'compare-browser-fps' || command.kind === 'compare-browser-visual'
    ? createDriver({ root, cwd: root, url: `http://127.0.0.1:${sharedPort}`, ticket, slot }, command.timeoutMs)
    : undefined
  try {
    const runSide = async (
      workspace: RevisionWorkspace,
      side: 'baseline' | 'candidate'
    ) => {
      let server: Awaited<ReturnType<typeof startRevisionServer>> | undefined
      let driver: BrowserDriver | undefined
      try {
        const browserMode = command.kind.includes('browser')
        if (command.kind === 'compare-no-render-browser') {
          await ensureBenchmarkHarness(root, workspace.cwd)
        }
        if (browserMode) server = await startRevisionServer(workspace, 30_000, sharedPort)
        const context = {
          root,
          cwd: workspace.cwd,
          url: server?.url ?? DEFAULT_URL,
          ticket,
          slot,
          side
        } as const
        const benchmark = comparisonBenchmark(command)
        if (sharedDriver != null && server != null) {
          await sharedDriver.open(server.url, 'timeoutMs' in benchmark ? benchmark.timeoutMs : sharedDriver.timeoutMs)
          await assertRevisionServerIdentity(sharedDriver, workspace)
        }
        const first = await runSingleBenchmark(benchmark, context, stdin, sharedDriver)
        driver = sharedDriver ?? first.driver
        if (sharedDriver == null && driver != null && server != null) {
          await assertRevisionServerIdentity(driver, workspace)
        }
        return first.data

      } finally {
        if (sharedDriver == null) await driver?.close().catch(() => {})
        await server?.stop()
      }
    }

    const runRevision = async (
      selector: string,
      side: 'baseline' | 'candidate'
    ) => {
      const workspace = await createRevisionWorkspace(root, selector)
      try {
        return { revision: workspace.revision, result: await runSide(workspace, side) }
      } finally {
        await workspace.cleanup()
      }
    }

    const baseline = await runRevision(command.baseline, 'baseline')
    const baselineResult = baseline.result
    const candidate = await runRevision(command.candidate, 'candidate')
    const candidateResult = candidate.result
    const visual = command.kind === 'compare-browser-visual'
      ? await compareVisualArtifacts(baselineResult, candidateResult, root)
      : undefined
    const visualPassed = visual == null || isVisualComparisonIdentical(visual)
    const comparison = {
      baseline: { selector: command.baseline, revision: baseline.revision, result: baselineResult },
      candidate: { selector: command.candidate, revision: candidate.revision, result: candidateResult },
      semantic: compareSemantics(baselineResult, candidateResult),
      performance: visualPassed
        ? comparePrimaryMetric(baselineResult, candidateResult)
        : { available: false, skipped: true, reason: 'visual-mismatch' }
    }
    return visual == null ? comparison : { ...comparison, visual }
  } finally {
    await sharedDriver?.close().catch(() => {})
  }
}

function comparisonBenchmark(command: ComparisonCommand): BenchmarkCommand {
  const common = { json: true }
  if (command.kind === 'compare-compiled') return { kind: 'compiled', frames: command.frames, warmupFrames: command.warmupFrames, ...common }
  if (command.kind === 'compare-no-render-bun') return { kind: 'no-render-bun', frames: command.frames, warmupFrames: command.warmupFrames, ...common }
  const browser = { stage: command.stage, timeoutMs: command.timeoutMs, reuse: false, keepOpen: false, hooks: command.hooks, ...common }
  if (command.kind === 'compare-no-render-browser') return { kind: 'no-render-browser', frames: command.frames, warmupFrames: command.warmupFrames, ...browser }
  if (command.kind === 'compare-browser-fps' || command.kind === 'compare-browser-full') return { kind: 'browser-fps', frames: command.frames, warmupFrames: command.warmupFrames, ...browser }
  return { kind: 'browser-visual', ...browser }
}

function findValues<T>(value: T, key: string, results: unknown[] = []): readonly unknown[] {
  if (Array.isArray(value)) {
    for (const child of value) findValues(child, key, results)
  } else if (isRecord(value)) {
    if (key in value) results.push(value[key])
    for (const child of Object.values(value)) findValues(child, key, results)
  }
  return results
}

function compareSemantics<TBaseline, TCandidate>(baseline: TBaseline, candidate: TCandidate) {
  const baselineChecksums = [...findValues(baseline, 'checksum'), ...findValues(baseline, 'outputChecksum')]
  const candidateChecksums = [...findValues(candidate, 'checksum'), ...findValues(candidate, 'outputChecksum')]
  const baselineBindings = [...findValues(baseline, 'bindingCounts'), ...findValues(baseline, 'bindingCount')]
  const candidateBindings = [...findValues(candidate, 'bindingCounts'), ...findValues(candidate, 'bindingCount')]
  const checksumsAvailable = baselineChecksums.length > 0 && candidateChecksums.length > 0
  const bindingCountsAvailable = baselineBindings.length > 0 && candidateBindings.length > 0
  return {
    checksumsAvailable,
    checksumsEqual: checksumsAvailable && JSON.stringify(baselineChecksums) === JSON.stringify(candidateChecksums),
    bindingCountsAvailable,
    bindingCountsEqual: bindingCountsAvailable && JSON.stringify(baselineBindings) === JSON.stringify(candidateBindings),
    baselineChecksums,
    candidateChecksums
  }
}

function primaryMetricSamples<T>(value: T): readonly number[] {
  for (const key of ['steadyStateMsPerFrame', 'medianFrameMs', 'msPerFrame', 'frameMs']) {
    const values = findValues(value, key).flatMap(candidate => {
      if (isNumber(candidate)) return [candidate]
      if (isRecord(candidate) && isNumber(candidate.median)) return [candidate.median]
      return []
    })
    if (values.length > 0) return values
  }
  return []
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function sampleSummary(values: readonly number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return {
    values,
    median: median(values),
    mean,
    standardDeviation: Math.sqrt(variance),
    coefficientOfVariationPercent: mean === 0 ? 0 : Math.sqrt(variance) / mean * 100
  }
}

type MetricSampleSummary = ReturnType<typeof sampleSummary>
type MetricComparison =
  | { readonly available: false }
  | {
      readonly available: true
      readonly baselineMsPerFrame: number
      readonly candidateMsPerFrame: number
      readonly changePercent: number
      readonly speedup: number
      readonly baselineSamples: MetricSampleSummary
      readonly candidateSamples: MetricSampleSummary
      readonly pairedWins: number
      readonly confirmedFaster: boolean
    }

function comparePrimaryMetric<TBaseline, TCandidate>(baseline: TBaseline, candidate: TCandidate): MetricComparison {
  const baselineSamples = primaryMetricSamples(baseline)
  const candidateSamples = primaryMetricSamples(candidate)
  if (baselineSamples.length === 0 || candidateSamples.length === 0) return { available: false }
  const baselineSummary = sampleSummary(baselineSamples)
  const candidateSummary = sampleSummary(candidateSamples)
  const pairedCount = Math.min(baselineSamples.length, candidateSamples.length)
  const pairedWins = Array.from({ length: pairedCount }, (_, index) => candidateSamples[index]! < baselineSamples[index]!)
    .filter(Boolean).length
  return {
    available: true,
    baselineMsPerFrame: baselineSummary.median,
    candidateMsPerFrame: candidateSummary.median,
    changePercent: ((candidateSummary.median - baselineSummary.median) / baselineSummary.median) * 100,
    speedup: baselineSummary.median / candidateSummary.median,
    baselineSamples: baselineSummary,
    candidateSamples: candidateSummary,
    pairedWins,
    confirmedFaster: candidateSummary.median < baselineSummary.median && pairedWins >= Math.ceil(pairedCount / 2)
  }
}

function visualArtifact<T>(value: T): { readonly panorama: string } | null {
  if (isRecord(value) && isString(value.panorama)) return { panorama: value.panorama }
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = visualArtifact(child)
      if (found != null) return found
    }
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) {
      const found = visualArtifact(child)
      if (found != null) return found
    }
  }
  return null
}

function isVisualComparisonIdentical<T>(value: T): boolean {
  return isRecord(value) && value.identical === true
}

async function compareVisualArtifacts<TBaseline, TCandidate>(baseline: TBaseline, candidate: TCandidate, root: string) {
  const baselineArtifact = visualArtifact(baseline)
  const candidateArtifact = visualArtifact(candidate)
  if (baselineArtifact == null || candidateArtifact == null) throw new Error('Visual comparison artifacts are unavailable.')
  const directory = await artifactDirectory(root, 'visual-diff')
  const difference = await comparePanoramas(baselineArtifact.panorama, candidateArtifact.panorama, path.join(directory, 'difference.png'))
  const reportPath = path.join(directory, 'comparison.json')
  const report = { baseline: baselineArtifact, candidate: candidateArtifact, difference, identical: difference.changedPixels === 0 }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return { ...report, report: reportPath }
}

function isComparisonCommand(command: BenchCommand): command is ComparisonCommand {
  return command.kind === 'compare-compiled' ||
    command.kind === 'compare-no-render-bun' ||
    command.kind === 'compare-no-render-browser' ||
    command.kind === 'compare-browser-fps' ||
    command.kind === 'compare-browser-visual' ||
    command.kind === 'compare-browser-full'
}

function isBenchmarkCommand(command: BenchCommand): command is BenchmarkCommand {
  return command.kind === 'compiled' ||
    command.kind === 'no-render-bun' ||
    command.kind === 'no-render-browser' ||
    command.kind === 'browser-load' ||
    command.kind === 'browser-fps' ||
    command.kind === 'browser-visual' ||
    command.kind === 'browser-full' ||
    command.kind === 'browser-profile'
}

export async function executeBenchCommand(command: BenchCommand, root: string, stdin?: string): Promise<ExecutionResult> {
  if (command.kind === 'experiment-accept' || command.kind === 'experiment-reject') {
    return withRecordedExecution(root, command, () => setExperimentVerdict(
      root,
      command.id,
      command.kind === 'experiment-accept' ? 'accepted' : 'rejected',
      command.reason
    ))
  }
  const experiment = isComparisonCommand(command) && command.experiment != null
    ? await beginExperiment(root, command, command.experiment)
    : undefined
  const result = await withRecordedExecution(root, command, async () => {
    if (command.kind === 'bench-status') return browserStatus(root)
    if (command.kind === 'bench-concurrency') {
      const queue = createBenchmarkQueue()
      const capacity = command.capacity == null ? await queue.capacity() : await queue.setCapacity(command.capacity)
      return { capacity, activeLeases: await queue.activeLeases() }
    }
    if (isComparisonCommand(command)) {
      const { queue, ticket, lease } = await acquireQueue(command.slot)
      try {
        return await compare(command, root, ticket, lease.slot, stdin)
      } finally {
        await queue.release(lease)
      }
    }

    if (!isBenchmarkCommand(command)) throw new Error(`Unsupported benchmark command ${command.kind}.`)
    const benchmark = command
    const browserTimeoutMs = 'timeoutMs' in benchmark ? benchmark.timeoutMs : 5_000
    const explicitReuse = 'reuse' in benchmark && benchmark.reuse
    const retainedSlot = benchmark.slot
    let retained = explicitReuse
      ? retainedSlot == null ? await lowestRetainedState(root) : await tryReadRetainedState(root, retainedSlot)
      : null

    if (retained != null) {
      const active = await new BrowserDriver({ session: retained.sessionName, cwd: root, timeoutMs: browserTimeoutMs }).isSessionActive(5_000)
      if (!active) {
        await closeRetained(root, retained.slot).catch(() => {})
        retained = null
      }
    }

    if (retained != null) {
      return withRetainedSessionLock(retained.sessionName, async () => {
        const driver = new BrowserDriver({ session: retained.sessionName, cwd: root, timeoutMs: browserTimeoutMs })
        if (!await driver.isSessionActive(5_000)) throw new Error(`Retained Agent Browser session ${retained.sessionName} is not active.`)
        const revisionHash = await readPageRevisionHash(driver)
        if (revisionHash !== retained.revisionHash) {
          throw new Error(`Retained browser revision changed from ${retained.revisionHash} to ${revisionHash}; reopen the browser before reusing it.`)
        }
        return (await runSingleBenchmark(benchmark, {
          root,
          cwd: root,
          url: retained.url,
          ticket: { sequence: 0, pid: retained.keeperPid },
          slot: retained.slot
        }, stdin, driver)).data
      })
    }

    const { queue, ticket, lease } = await acquireQueue(benchmark.slot)
    let browserDriver: BrowserDriver | undefined
    let workspace: RevisionWorkspace | undefined
    let server: Awaited<ReturnType<typeof startRevisionServer>> | undefined
    try {
      if (usesManagedBenchmarkServer(benchmark)) {
        workspace = await createRevisionWorkspace(root, 'worktree')
        server = await startRevisionServer(workspace, 30_000, browserBenchmarkPort(lease.slot))
      }
      const benchmarkUrl = process.env.FLIGHTSIM_BENCH_URL ?? server?.url ?? DEFAULT_URL
      const context: ExecutionContext = server == null
        ? { root, cwd: root, url: benchmarkUrl, ticket, slot: lease.slot }
        : { root, cwd: root, url: benchmarkUrl, cacheMode: 'immutable-package-cache', ticket, slot: lease.slot }
      const result = await runSingleBenchmark(benchmark, context, stdin)
      browserDriver = result.driver
      if ('keepOpen' in benchmark && (benchmark.keepOpen || ('reuse' in benchmark && benchmark.reuse)) && browserDriver != null) {
        const retained = await retainBrowser(root, lease, browserDriver, benchmark.stage, benchmarkUrl)
        if (!isRecord(result.data)) throw new Error('Retained browser benchmark result must be an object.')
        return { ...result.data, retained }
      }
      await browserDriver?.close().catch(() => {})
      await queue.release(lease)
      return result.data
    } catch (error) {
      await browserDriver?.close().catch(() => {})
      await queue.release(lease)
      throw error
    } finally {
      await server?.stop()
      await workspace?.cleanup()
    }
  })
  if (experiment != null) await finishExperiment(root, experiment, result)
  return result
}

export const __benchmarkExecuteTestHooks = {
  browserBenchmarkPort,
  usesManagedBenchmarkServer,
  compareSemantics,
  comparePrimaryMetric,
  createBrowserFullExpression,
  isVisualComparisonIdentical,
  noRenderBrowserPageSource
}
