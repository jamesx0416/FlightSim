import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import { BrowserDriver, deriveBrowserSessionName } from './browserDriver'
import { createCommandLog } from './commandLog'
import { BENCHMARK_READINESS_STAGES } from './config'
import { EnvironmentSampler, summarizeEnvironment } from './environment'
import { createBenchmarkQueue, type BenchmarkLease, type QueueTicket } from './queue'
import { waitForReadiness } from './readiness'
import { createRevisionWorkspace, startRevisionServer, type RevisionWorkspace } from './revision'
import {
  CUBEMAP_FACE_NAMES,
  comparePanoramas,
  stitchEquirectangularPanorama,
  type CubemapFaceName,
  type CubemapFacePaths
} from './visual'

const DEFAULT_URL = 'https://vanilla-3dtiles.localhost:3000'
const DEFAULT_PACKAGE = 'headwindsim-aircraft-a330-900'
const RETAINED_STATE_PATH = '.benchmarks/retained-browser.json'

type JsonRecord = Record<string, unknown>
type BrowserModeCommand = Exclude<BenchmarkCommand, Extract<BenchmarkCommand, { readonly kind: 'compiled' | 'no-render-bun' }>>

type ExecutionContext = {
  readonly root: string
  readonly cwd: string
  readonly url: string
  readonly ticket: QueueTicket
  readonly side?: 'baseline' | 'candidate'
}

type RetainedBrowserState = {
  readonly sessionName: string
  readonly keeperPid: number
  readonly stage: string
  readonly url: string
  readonly openedAt: string
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

function operationName(command: BrowserCommand | BenchCommand): string {
  return command.kind
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'BENCHMARK_FAILED'
}

async function withRecordedExecution(
  root: string,
  command: BrowserCommand | BenchCommand,
  operation: () => Promise<unknown>
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

async function acquireQueue() {
  const queue = createBenchmarkQueue()
  const ticket = await queue.join()
  const lease = await queue.waitForLease(ticket, {
    onProgress: ({ requestsAhead }) => console.error(`Waiting for benchmark slot, ${requestsAhead} request${requestsAhead === 1 ? '' : 's'} ahead`)
  })
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
    session: deriveBrowserSessionName({
      worktree: context.cwd,
      agentId: `${process.pid}${context.side == null ? '' : `-${context.side}`}`,
      queueSequence: context.ticket.sequence
    })
  })
}

async function runHook(driver: BrowserDriver, source: string | undefined, phase: string): Promise<unknown> {
  if (source == null) return null
  const result = await driver.evalJson<unknown>(`(async () => { ${source}\n })()`)
  if (isRecord(result) && result.ok === false) throw new Error(`${phase} hook returned a failed DevApi response.`)
  return result
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
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
  const sampler = new EnvironmentSampler()
  await sampler.start()
  let readiness: unknown
  let result: unknown
  let artifacts: unknown
  const startedAt = performance.now()
  try {
    if (retainedDriver == null) {
      await driver.open(context.url, command.timeoutMs)
    }
    readiness = await waitForReadiness(driver, {
      stage: command.stage,
      mode: command.kind === 'browser-load' ? 'load' : command.kind === 'no-render-browser' ? 'no-render' : command.kind === 'browser-profile' ? 'profile' : command.kind === 'browser-visual' ? 'visual' : 'full',
      timeoutMs: command.timeoutMs,
      stages: BENCHMARK_READINESS_STAGES
    })
    if (command.kind === 'browser-load') {
      result = { elapsedMs: performance.now() - startedAt, stage: command.stage }
    } else {
      const hooks = await resolvedHooks(command.hooks, context.cwd, stdin)
      const before = await runHook(driver, hooks.before, 'Before')
      if (command.reuse && command.settleMs != null) await sleep(command.settleMs)
      if (command.kind === 'no-render-browser') {
        result = await browserNoRender(driver, command.frames, command.warmupFrames)
      } else if (command.kind === 'browser-full') {
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
      result = { before, measurement: result, after }
    }
  } finally {
    const environment = await sampler.stop()
    result = { result, environment, environmentSummary: summarizeEnvironment(environment) }
  }
  const reused = 'reuse' in command && command.reuse
  return {
    result,
    driver,
    execution: {
      page: reused ? 'reused' : 'fresh-navigation',
      cache: 'uncontrolled-browser-cache',
      measurement: reused ? 'steady-state-reuse' : command.kind === 'browser-load' ? 'load' : 'fresh-page',
      ...(reused ? { settleMs: command.settleMs } : {})
    },
    ...(readiness == null ? {} : { readiness }),
    ...(artifacts == null ? {} : { artifacts })
  }
}

async function browserNoRender(driver: BrowserDriver, frames?: number, warmupFrames?: number): Promise<unknown> {
  const options = JSON.stringify({
    ...(frames == null ? {} : { frames }),
    ...(warmupFrames == null ? {} : { warmupFrames })
  })
  const response = await driver.evalJson<unknown>(`window.__DevApi.bench.aircraftRuntime(${options})`)
  if (!isRecord(response) || response.ok !== true) {
    throw new Error(`Browser no-render benchmark failed: ${JSON.stringify(response)}`)
  }
  return response.data
}

async function browserFull(
  driver: BrowserDriver,
  frames = 300,
  warmupFrames = 60,
  timeoutMs = driver.timeoutMs
): Promise<unknown> {
  return driver.evalJson<unknown>(`(async () => {
    const enabled = await window.__DevApi.settings.set({ cockpitPerf: true })
    if (enabled?.ok !== true) throw new Error(enabled?.summary ?? 'Could not enable cockpit performance collection.')
    const collector = globalThis.__cockpitPerf
    if (collector == null || collector.enabled !== true) throw new Error('Cockpit performance collector is unavailable.')
    const deadline = performance.now() + ${Math.max(1_000, timeoutMs - 5_000)}
    const waitForSamples = async count => {
      while ((collector.getSummary()?.sampleCount ?? 0) < count) {
        if (performance.now() >= deadline) throw new Error('Cockpit performance sampling timed out.')
        await new Promise(resolve => requestAnimationFrame(resolve))
      }
    }
    collector.reset()
    await waitForSamples(${warmupFrames})
    collector.reset()
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
  })()`)
}

const FACE_ROTATIONS: Readonly<Record<CubemapFaceName, readonly [number, number, number, number]>> = {
  front: [0, 0, 0, 1],
  back: [0, 1, 0, 0],
  left: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  right: [0, -Math.SQRT1_2, 0, Math.SQRT1_2],
  up: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  down: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]
}

async function capturePanorama(driver: BrowserDriver, directory: string): Promise<unknown> {
  const poseResponse = await driver.evalJson<unknown>('window.__DevApi.camera.getPose()')
  if (!isRecord(poseResponse) || poseResponse.ok !== true || !isRecord(poseResponse.data)) {
    throw new Error('Could not collect the authoritative visual camera pose.')
  }
  const basePose = poseResponse.data
  const viewport = await driver.evalJson<{ readonly width: number; readonly height: number }>('({ width: innerWidth, height: innerHeight })')
  const facesDirectory = path.join(directory, 'faces')
  await mkdir(facesDirectory, { recursive: true })
  const facePaths = {} as Record<CubemapFaceName, string>
  await driver.setViewport(1_024, 1_024)
  try {
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
    await driver.evalJson<unknown>(`window.__DevApi.camera.setPose(${JSON.stringify(basePose)})`)
    await driver.setViewport(viewport.width, viewport.height)
  }
  const panoramaPath = path.join(directory, 'panorama.png')
  await stitchEquirectangularPanorama(facePaths as CubemapFacePaths, panoramaPath)
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

async function runBunCommand(command: Extract<BenchmarkCommand, { readonly kind: 'compiled' | 'no-render-bun' }>, root: string, cwd: string): Promise<unknown> {
  installDomGlobals()
  await ensureBenchmarkHarness(root, cwd)
  const packageRoot = pathToFileURL(path.join(cwd, 'aircrafts', DEFAULT_PACKAGE, path.sep)).href
  const additionalPackageRoots = [pathToFileURL(path.join(cwd, 'public/vendor/msfs-stock', path.sep)).href]
  const frameOptions = {
    ...(command.frames == null ? {} : { frames: command.frames }),
    ...(command.warmupFrames == null ? {} : { warmupFrames: command.warmupFrames })
  }
  if (command.kind === 'compiled') {
    const moduleUrl = `${pathToFileURL(path.join(cwd, 'src/sim/benchmarks/bunCompiledBindingsAdapter.ts')).href}?revision=${Date.now()}`
    const adapter = await import(moduleUrl) as typeof import('../sim/benchmarks/bunCompiledBindingsAdapter')
    return adapter.runBunCompiledBindingsBenchmark({ packageRoot, additionalPackageRoots, ...frameOptions })
  }
  const moduleUrl = `${pathToFileURL(path.join(cwd, 'src/sim/benchmarks/bunAircraftRuntimeAdapter.ts')).href}?revision=${Date.now()}`
  const adapter = await import(moduleUrl) as typeof import('../sim/benchmarks/bunAircraftRuntimeAdapter')
  return adapter.runBunAircraftRuntimeBenchmark({ packageRoot, additionalPackageRoots, ...frameOptions })
}

function installDomGlobals(): void {
  if (globalThis.DOMParser != null) return
  // This indirection keeps browser bundles from importing the Bun-only DOM adapter.
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

async function retainBrowser(root: string, lease: BenchmarkLease, driver: BrowserDriver, stage: string, url: string): Promise<RetainedBrowserState> {
  const keeperPid = await spawnKeeper(root, driver.session)
  const queue = createBenchmarkQueue()
  await queue.transferToKeeper(lease, keeperPid, driver.session)
  const state = { sessionName: driver.session, keeperPid, stage, url, openedAt: new Date().toISOString() }
  await mkdir(path.dirname(path.join(root, RETAINED_STATE_PATH)), { recursive: true })
  await writeFile(path.join(root, RETAINED_STATE_PATH), `${JSON.stringify(state, null, 2)}\n`)
  return state
}

async function readRetainedState(root: string): Promise<RetainedBrowserState> {
  const state = JSON.parse(await readFile(path.join(root, RETAINED_STATE_PATH), 'utf8')) as unknown
  if (!isRecord(state) || typeof state.sessionName !== 'string' || typeof state.keeperPid !== 'number' || typeof state.stage !== 'string' || typeof state.url !== 'string' || typeof state.openedAt !== 'string') {
    throw new Error('Retained browser state is malformed.')
  }
  return state as RetainedBrowserState
}

async function closeRetained(root: string): Promise<unknown> {
  const state = await readRetainedState(root)
  const driver = new BrowserDriver({ session: state.sessionName, cwd: root })
  let browserAlreadyGone = false
  try {
    await driver.close()
  } catch {
    // The keeper exits when Agent Browser disappears. Its retained state still
    // needs to be released so a crashed browser cannot block the FIFO queue.
    browserAlreadyGone = true
  }
  try { process.kill(state.keeperPid, 'SIGTERM') } catch {}
  await createBenchmarkQueue().releaseRetained(state.sessionName)
  await rm(path.join(root, RETAINED_STATE_PATH), { force: true })
  return { closed: !browserAlreadyGone, browserAlreadyGone, sessionName: state.sessionName }
}

export async function runKeeper(sessionName: string): Promise<never> {
  const driver = new BrowserDriver({ session: sessionName })
  for (;;) {
    await sleep(2_000)
    try {
      await driver.inspectSession(5_000)
    } catch {
      process.exit(0)
    }
  }
}

export async function executeBrowserCommand(command: BrowserCommand, root: string): Promise<ExecutionResult> {
  return withRecordedExecution(root, command, async () => {
    if (command.kind === 'browser-close') return closeRetained(root)
    const { queue, ticket, lease } = await acquireQueue()
    const context = { root, cwd: root, url: process.env.FLIGHTSIM_BENCH_URL ?? DEFAULT_URL, ticket }
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

async function compare(command: ComparisonCommand, root: string, ticket: QueueTicket, stdin: string | undefined): Promise<unknown> {
  const baseline = await createRevisionWorkspace(root, command.baseline)
  const candidate = await createRevisionWorkspace(root, command.candidate)
  try {
    const runSide = async (workspace: RevisionWorkspace, side: 'baseline' | 'candidate') => {
      let server: Awaited<ReturnType<typeof startRevisionServer>> | undefined
      let driver: BrowserDriver | undefined
      try {
        const browserMode = command.kind.includes('browser')
        if (browserMode) server = await startRevisionServer(workspace)
        const context = {
          root,
          cwd: workspace.cwd,
          url: server?.url ?? DEFAULT_URL,
          ticket,
          side
        } as const
        const benchmark = comparisonBenchmark(command)
        const benchmarkResult = await runSingleBenchmark(benchmark, context, stdin)
        driver = benchmarkResult.driver
        const performance = benchmarkResult.data
        if (command.kind === 'compare-browser-full' && command.visual) {
          const visualCommand: BenchmarkCommand = {
            kind: 'browser-visual',
            stage: command.stage,
            timeoutMs: command.timeoutMs,
            reuse: false,
            keepOpen: false,
            hooks: command.hooks,
            json: true
          }
          return { performance, visual: (await runSingleBenchmark(visualCommand, context, stdin, driver)).data }
        }
        return performance
      } finally {
        await driver?.close().catch(() => {})
        await server?.stop()
      }
    }
    const baselineResult = await runSide(baseline, 'baseline')
    const candidateResult = await runSide(candidate, 'candidate')
    const visual = command.kind === 'compare-browser-visual' || (command.kind === 'compare-browser-full' && command.visual)
      ? await compareVisualArtifacts(baselineResult, candidateResult, root)
      : undefined
    return {
      baseline: { selector: command.baseline, revision: baseline.revision, result: baselineResult },
      candidate: { selector: command.candidate, revision: candidate.revision, result: candidateResult },
      semantic: compareSemantics(baselineResult, candidateResult),
      performance: comparePrimaryMetric(baselineResult, candidateResult),
      ...(visual == null ? {} : { visual })
    }
  } finally {
    await candidate.cleanup()
    await baseline.cleanup()
  }
}

function comparisonBenchmark(command: ComparisonCommand): BenchmarkCommand {
  const common = { json: true }
  if (command.kind === 'compare-compiled') return { kind: 'compiled', frames: command.frames, warmupFrames: command.warmupFrames, ...common }
  if (command.kind === 'compare-no-render-bun') return { kind: 'no-render-bun', frames: command.frames, warmupFrames: command.warmupFrames, ...common }
  const browser = { stage: command.stage, timeoutMs: command.timeoutMs, reuse: false, keepOpen: false, hooks: command.hooks, ...common }
  if (command.kind === 'compare-no-render-browser') return { kind: 'no-render-browser', frames: command.frames, warmupFrames: command.warmupFrames, ...browser }
  if (command.kind === 'compare-browser-full') return { kind: 'browser-full', frames: command.frames, warmupFrames: command.warmupFrames, ...browser }
  return { kind: 'browser-visual', ...browser }
}

function findValues(value: unknown, key: string, results: unknown[] = []): readonly unknown[] {
  if (Array.isArray(value)) {
    for (const child of value) findValues(child, key, results)
  } else if (isRecord(value)) {
    if (key in value) results.push(value[key])
    for (const child of Object.values(value)) findValues(child, key, results)
  }
  return results
}

function compareSemantics(baseline: unknown, candidate: unknown): unknown {
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

function primaryMetric(value: unknown): number | null {
  const candidates = [
    ...findValues(value, 'steadyStateMsPerFrame'),
    ...findValues(value, 'medianFrameMs'),
    ...findValues(value, 'msPerFrame'),
    ...findValues(value, 'frameMs')
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    if (isRecord(candidate) && typeof candidate.median === 'number') return candidate.median
  }
  return null
}

function comparePrimaryMetric(baseline: unknown, candidate: unknown): unknown {
  const baselineMs = primaryMetric(baseline)
  const candidateMs = primaryMetric(candidate)
  return baselineMs == null || candidateMs == null
    ? { available: false }
    : {
        available: true,
        baselineMsPerFrame: baselineMs,
        candidateMsPerFrame: candidateMs,
        changePercent: ((candidateMs - baselineMs) / baselineMs) * 100,
        speedup: baselineMs / candidateMs
      }
}

function visualArtifact(value: unknown): { readonly panorama: string } | null {
  if (isRecord(value) && typeof value.panorama === 'string') return { panorama: value.panorama }
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

async function compareVisualArtifacts(baseline: unknown, candidate: unknown, root: string): Promise<unknown> {
  const baselineArtifact = visualArtifact(baseline)
  const candidateArtifact = visualArtifact(candidate)
  if (baselineArtifact == null || candidateArtifact == null) throw new Error('Visual comparison artifacts are unavailable.')
  const directory = await artifactDirectory(root, 'visual-diff')
  const difference = await comparePanoramas(baselineArtifact.panorama, candidateArtifact.panorama, path.join(directory, 'difference.png'))
  const reportPath = path.join(directory, 'comparison.json')
  const report = { baseline: baselineArtifact, candidate: candidateArtifact, difference }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return { ...report, report: reportPath }
}

export async function executeBenchCommand(command: BenchCommand, root: string, stdin?: string): Promise<ExecutionResult> {
  return withRecordedExecution(root, command, async () => {
    if ('kind' in command && command.kind.startsWith('compare-')) {
      const { queue, ticket, lease } = await acquireQueue()
      try {
        return await compare(command as ComparisonCommand, root, ticket, stdin)
      } finally {
        await queue.release(lease)
      }
    }

    const benchmark = command as BenchmarkCommand
    if ('reuse' in benchmark && benchmark.reuse) {
      const retained = await readRetainedState(root)
      const driver = new BrowserDriver({ session: retained.sessionName, cwd: root, timeoutMs: benchmark.timeoutMs })
      return (await runSingleBenchmark(benchmark, {
        root,
        cwd: root,
        url: retained.url,
        ticket: { sequence: 0, pid: retained.keeperPid }
      }, stdin, driver)).data
    }

    const { queue, ticket, lease } = await acquireQueue()
    let browserDriver: BrowserDriver | undefined
    try {
      const result = await runSingleBenchmark(benchmark, {
        root,
        cwd: root,
        url: process.env.FLIGHTSIM_BENCH_URL ?? DEFAULT_URL,
        ticket
      }, stdin)
      browserDriver = result.driver
      if ('keepOpen' in benchmark && benchmark.keepOpen && browserDriver != null) {
        const retained = await retainBrowser(root, lease, browserDriver, benchmark.stage, process.env.FLIGHTSIM_BENCH_URL ?? DEFAULT_URL)
        return { ...result.data as JsonRecord, retained }
      }
      await browserDriver?.close().catch(() => {})
      await queue.release(lease)
      return result.data
    } catch (error) {
      await browserDriver?.close().catch(() => {})
      await queue.release(lease)
      throw error
    }
  })
}

export const __benchmarkExecuteTestHooks = {
  compareSemantics,
  comparePrimaryMetric
}
