import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'

export type RevisionWorkspace = {
  readonly selector: string
  readonly revision: string
  readonly cwd: string
  readonly isCurrentWorktree: boolean
  cleanup(): Promise<void>
}

export type RevisionServer = {
  readonly url: string
  stop(): Promise<void>
}

type ProcessResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

async function run(command: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('exit', code => resolve({
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }))
  })
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const result = await run('git', args, root)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

/** Creates an isolated detached worktree for a Git selector without mutating the active checkout. */
export async function createRevisionWorkspace(root: string, selector: string): Promise<RevisionWorkspace> {
  if (selector === 'worktree') {
    const head = await git(root, ['rev-parse', 'HEAD'])
    return {
      selector,
      revision: `${head}+worktree`,
      cwd: root,
      isCurrentWorktree: true,
      cleanup: async () => {}
    }
  }

  const revision = await git(root, ['rev-parse', '--verify', `${selector}^{commit}`])
  const worktreesRoot = path.join(root, '.worktrees')
  await mkdir(worktreesRoot, { recursive: true })
  const cwd = path.join(worktreesRoot, `bench-${revision.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`)
  await git(root, ['worktree', 'add', '--detach', cwd, revision])
  await symlink(path.join(root, 'aircrafts'), path.join(cwd, 'aircrafts'), 'dir')
  let cleaned = false
  return {
    selector,
    revision,
    cwd,
    isCurrentWorktree: false,
    cleanup: async () => {
      if (cleaned) return
      cleaned = true
      await git(root, ['worktree', 'remove', '--force', cwd])
    }
  }
}

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address == null || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a benchmark server port.')))
        return
      }
      server.close(error => error == null ? resolve(address.port) : reject(error))
    })
  })
}

async function waitForServer(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const startedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) throw new Error(`Benchmark Vite server exited with code ${child.exitCode}.`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The server has not bound yet.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for benchmark server ${url}.`)
}

/** Starts a revision-local Vite server. Dependencies resolve from the parent checkout's node_modules. */
export async function startRevisionServer(workspace: RevisionWorkspace, timeoutMs = 30_000): Promise<RevisionServer> {
  const port = await unusedPort()
  const url = `http://127.0.0.1:${port}`
  const child = spawn(
    process.execPath,
    ['x', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: workspace.cwd, stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000) })
  try {
    await waitForServer(url, child, timeoutMs)
  } catch (error) {
    child.kill('SIGTERM')
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${stderr}`.trim())
  }

  return {
    url,
    stop: async () => {
      if (child.exitCode != null) return
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const forced = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 2_000)
        child.once('exit', () => {
          clearTimeout(forced)
          resolve()
        })
      })
    }
  }
}
