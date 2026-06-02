import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'

const proxyPort = 3000
const appPort = Number(process.env.VITE_DEV_PORT ?? 3001)
const appName = process.env.PORTLESS_NAME ?? 'vanilla-3dtiles'
const localUrl = `https://${appName}.localhost:${proxyPort}`
const viteUrl = `http://127.0.0.1:${appPort}`

let cleanedUp = false

async function run(command, args, options = {}) {
  const { quiet = false, ...spawnOptions } = options
  const child = spawn(command, args, {
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...spawnOptions
  })

  const [stdout, stderr, code] = await Promise.all([
    quiet ? new Response(child.stdout).text() : Promise.resolve(''),
    quiet ? new Response(child.stderr).text() : Promise.resolve(''),
    new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (exitCode) => resolve(exitCode ?? 0))
    })
  ])

  if (code !== 0) {
    if (quiet) {
      process.stdout.write(stdout)
      process.stderr.write(stderr)
    }

    process.exit(code)
  }
}

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: options.stdio ?? 'inherit',
    ...options
  })
  child.on('error', (error) => {
    console.warn(`${command} failed to start: ${error.message}`)
  })
  return child
}

function isTcpPortOpen(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    let settled = false
    const done = (open) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(open)
    }

    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(200, () => done(false))
  })
}

function getTailscaleDnsName() {
  const status = spawnSync('tailscale', ['status', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })

  if (status.status === 0) {
    try {
      const parsed = JSON.parse(status.stdout)
      const nodeDnsName = parsed?.Self?.DNSName

      if (typeof nodeDnsName === 'string' && nodeDnsName.trim()) {
        return nodeDnsName.trim().replace(/\.$/, '')
      }
    } catch {
      // Tailscale is optional; an unreadable status response just means no DNS alias.
    }
  }

  return null
}

function startTailscaleServe(dnsName) {
  if (!dnsName) return { process: null, url: null }

  return {
    process: spawnChild('tailscale', ['serve', '--yes', '--https', String(proxyPort), viteUrl], {
      stdio: ['ignore', 'ignore', 'pipe']
    }),
    url: `https://${dnsName}:${proxyPort}`
  }
}

function pipeTailscaleErrors(process) {
  process?.stderr?.on('data', (chunk) => {
    const text = chunk.toString()

    if (!/client version .* != tailscaled server version/.test(text)) {
      process.stderr.write(text)
    }
  })
}

function cleanup(childProcesses) {
  if (cleanedUp) return
  cleanedUp = true

  for (const childProcess of childProcesses) {
    if (childProcess && !childProcess.killed) {
      childProcess.kill()
    }
  }

  spawnSync('portless', ['alias', '--remove', appName], { stdio: 'ignore' })
  spawnSync('portless', ['proxy', 'stop', '-p', String(proxyPort)], { stdio: 'ignore' })
}

const tailscaleDnsNamePromise = Promise.resolve().then(getTailscaleDnsName)
const proxyReadyPromise = isTcpPortOpen(proxyPort).then((open) =>
  open ? undefined : run('portless', ['proxy', 'start', '--port', String(proxyPort), '--https'], { quiet: true })
)

await proxyReadyPromise
const tailscaleDnsName = await tailscaleDnsNamePromise
await run('portless', ['alias', appName, String(appPort), '--force'], { quiet: true })

const cleanupProcess = spawnChild('bun', ['scripts/kill-stale-agent-browsers.mjs', '--active-only'])
const tailscaleServe = startTailscaleServe(tailscaleDnsName)
const viteProcess = spawnChild('bunx', ['vite', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], {
  env: {
    ...process.env,
    PORT: String(appPort),
    PORTLESS_URL: localUrl,
    TAILSCALE_URL: tailscaleServe.url ?? ''
  }
})
const childProcesses = [cleanupProcess, tailscaleServe.process]

pipeTailscaleErrors(tailscaleServe.process)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup(childProcesses)
    if (!viteProcess.killed) {
      viteProcess.kill(signal)
    }
  })
}

viteProcess.on('exit', (code, signal) => {
  cleanup(childProcesses)

  if (signal) {
    process.exit(signal === 'SIGINT' ? 130 : 143)
    return
  }

  process.exit(code ?? 0)
})
