import { expect, test } from 'bun:test'

import {
  BrowserDriver,
  type AgentBrowserCommand,
  type AgentBrowserCommandResult
} from './browserDriver'
import {
  DEFAULT_STABLE_SAMPLE_COUNT,
  ReadinessError,
  defaultReadinessStage,
  resolveReadinessStage,
  waitForReadiness
} from './readiness'

function result(command: AgentBrowserCommand, stdout = '{}'): AgentBrowserCommandResult {
  return { command, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false }
}

test('defaults no-render to the exact interior-ready marker, rendered work to stable, and requires a load boundary', () => {
  expect(defaultReadinessStage('no-render')).toBe('gltf:interior-upgrade:ready')
  expect(defaultReadinessStage('full')).toBe('stable')
  expect(defaultReadinessStage('load')).toBeUndefined()
  expect(resolveReadinessStage().resolved).toBe('stable')

  try {
    resolveReadinessStage({ mode: 'load' })
    throw new Error('Expected load stage resolution to fail.')
  } catch (error) {
    if (!(error instanceof ReadinessError)) throw error
    expect(error.code).toBe('READINESS_STAGE_REQUIRED')
  }
})

test('uses DevApi conditions for aliases, exact stages, and configured hooks', () => {
  const compiled = resolveReadinessStage({ stage: 'compiled' })
  const cockpit = resolveReadinessStage({ stage: 'cockpit' })
  const stable = resolveReadinessStage({ stage: 'stable' })
  const exact = resolveReadinessStage({ stage: 'gltf:interior-upgrade:ready' })
  const custom = resolveReadinessStage({
    stage: 'perf-ready',
    stages: { 'perf-ready': { condition: 'globalThis.__cockpitPerf?.sampleCount >= 300' } }
  })

  expect(compiled.condition.includes('gltf:loaded')).toBe(true)
  expect(cockpit.condition.includes('activeInteriorLodIndex === cockpit.selectedInteriorLodIndex')).toBe(true)
  expect(stable.condition.includes(`samples >= ${DEFAULT_STABLE_SAMPLE_COUNT}`)).toBe(true)
  expect(resolveReadinessStage({ stage: 'gauges' }).prerequisites).toEqual(['cockpit'])
  expect(stable.prepare?.includes(`let remaining = ${DEFAULT_STABLE_SAMPLE_COUNT}`)).toBe(true)
  expect(stable.prepare?.includes('requestAnimationFrame')).toBe(true)
  expect(exact.kind).toBe('exact')
  expect(exact.condition.includes('gltf:interior-upgrade:ready')).toBe(true)
  expect([custom.kind, custom.condition]).toEqual(['custom', 'globalThis.__cockpitPerf?.sampleCount >= 300'])
})

test('allows five fresh propagation frames only after gauges are ready', async () => {
  const commands: AgentBrowserCommand[] = []
  const driver = new BrowserDriver({
    session: 'flightsim-readiness-stable',
    runner: async command => {
      commands.push(command)
      if (command.args.includes('list')) return result(command, JSON.stringify({ tabs: [{ tabId: 't1' }] }))
      if (command.args.includes('eval') && command.stdin?.includes('JSON.stringify')) {
        return result(command, JSON.stringify(JSON.stringify({ ok: true })))
      }
      return result(command)
    }
  })

  const readiness = await waitForReadiness(driver, {
    stage: 'stable',
    stableSampleCount: 12,
    timeoutMs: 5_000
  })

  expect(readiness.completedStages).toEqual(['aircraft', 'cockpit', 'gauges', 'stable'])
  const frameSettle = commands.find(command => command.stdin?.includes('let remaining = 12'))
  const gaugesWaitIndex = commands.findIndex(command => command.stdin?.includes('gltf:interior-upgrade:ready'))
  expect(frameSettle?.stdin?.includes('requestAnimationFrame')).toBe(true)
  expect(commands.indexOf(frameSettle!) > gaugesWaitIndex).toBe(true)
  expect(commands.every(command => !command.args.includes('sleep'))).toBe(true)
})

test('waits through cockpit prerequisites, preparation, and a condition without sleeps', async () => {
  const commands: AgentBrowserCommand[] = []
  const driver = new BrowserDriver({
    session: 'flightsim-readiness-1',
    runner: async command => {
      commands.push(command)
      if (command.args.includes('list')) return result(command, JSON.stringify({ tabs: [{ tabId: 't1' }] }))
      if (command.args.includes('eval') && command.stdin?.includes('JSON.stringify')) {
        return result(command, JSON.stringify(JSON.stringify({ ok: true, data: { loadStage: { stage: 'scene:ready' } } })))
      }
      return result(command)
    }
  })

  const readiness = await waitForReadiness(driver, { stage: 'cockpit', timeoutMs: 5_000 })

  expect(readiness.completedStages).toEqual(['aircraft', 'cockpit'])
  expect(commands.filter(command => command.args.includes('wait')).length).toBe(2)
  expect(commands.some(command => command.stdin?.includes('camera?.enterCockpit'))).toBe(true)
  expect(commands.every(command => !command.args.includes('sleep'))).toBe(true)
})
