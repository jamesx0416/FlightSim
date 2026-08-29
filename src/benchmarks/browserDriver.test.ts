import { expect, test } from 'bun:test'

import {
  BrowserDriver,
  BrowserDriverError,
  type AgentBrowserCommand,
  type AgentBrowserCommandResult,
  deriveBrowserSessionName
} from './browserDriver'

function result(command: AgentBrowserCommand, stdout = '{}'): AgentBrowserCommandResult {
  return { command, exitCode: 0, stdout, stderr: '', durationMs: 1, timedOut: false }
}

test('derives safe worktree-scoped session names', () => {
  const session = deriveBrowserSessionName({
    worktree: '/Users/james/Flight Sim',
    agentId: 'agent/1',
    queueSequence: 42
  })

  expect(/^flightsim-[a-f0-9]{8}-agent-1-42$/u.test(session)).toBe(true)
  expect(session.includes('/')).toBe(false)
})

test('uses an isolated pinned session and stdin for page JavaScript', async () => {
  const commands: AgentBrowserCommand[] = []
  const driver = new BrowserDriver({
    session: 'flightsim-test-1',
    cwd: '/worktree',
    runner: async command => {
      commands.push(command)
      if (command.args.includes('list')) return result(command, JSON.stringify({ tabs: [{ tabId: 't1' }] }))
      return result(command)
    }
  })

  await driver.open('https://vanilla-3dtiles.localhost:3000')
  await driver.eval('window.__DevApi.status()')
  await driver.waitFn('window.__DevApi != null')
  await driver.screenshot('/tmp/flight.png')
  await driver.inspectSession()
  await driver.close()

  expect(commands.every(command => command.args.slice(0, 4).join(' ') === '--session flightsim-test-1 --pin-tab --json')).toBe(true)
  const evalCommand = commands.find(command => command.args.includes('eval'))
  expect(evalCommand?.args).toEqual(['--session', 'flightsim-test-1', '--pin-tab', '--json', 'eval', '--stdin'])
  expect(evalCommand?.stdin).toBe('window.__DevApi.status()')
  expect(commands.find(command => command.args.includes('wait'))?.args.includes('--timeout')).toBe(true)
})

test('fails before an operation can continue with more than one tab', async () => {
  const driver = new BrowserDriver({
    session: 'flightsim-test-2',
    runner: async command => command.args.includes('list')
      ? result(command, JSON.stringify({ tabs: [{ tabId: 't1' }, { tabId: 't2' }] }))
      : result(command)
  })

  try {
    await driver.open('https://vanilla-3dtiles.localhost:3000')
    throw new Error('Expected the tab invariant to fail.')
  } catch (error) {
    expect(error instanceof BrowserDriverError).toBe(true)
    expect((error as BrowserDriverError).code).toBe('BROWSER_TAB_INVARIANT')
  }
})

test('reports a structured browser command failure', async () => {
  const driver = new BrowserDriver({
    session: 'flightsim-test-3',
    runner: async command => ({ ...result(command), exitCode: 17, stderr: 'tab_gone' })
  })

  try {
    await driver.close()
    throw new Error('Expected the command to fail.')
  } catch (error) {
    expect(error instanceof BrowserDriverError).toBe(true)
    expect((error as BrowserDriverError).code).toBe('BROWSER_COMMAND_FAILED')
  }
})
