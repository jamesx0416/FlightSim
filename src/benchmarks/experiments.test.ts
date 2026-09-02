import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'bun:test'

import type { CompareCompiledCommand } from './cli'
import { beginExperiment, finishExperiment, setExperimentVerdict } from './experiments'

const SHA_PATTERN = /^[0-9a-f]{40}$/

async function git(cwd: string, ...args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)))
  })
}

test('experiment records preserve baseline, patch, result, and verdict history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'flightsim-experiment-test-'))
  try {
    await git(root, 'init')
    await git(root, 'config', 'user.email', 'bench@example.test')
    await git(root, 'config', 'user.name', 'Bench Test')
    await writeFile(path.join(root, 'fixture.txt'), 'baseline\n')
    await git(root, 'add', 'fixture.txt')
    await git(root, 'commit', '-m', 'baseline')
    await writeFile(path.join(root, 'fixture.txt'), 'candidate\n')
    await writeFile(path.join(root, 'new-file.txt'), 'untracked candidate\n')

    const command: CompareCompiledCommand = {
      kind: 'compare-compiled', baseline: 'HEAD', candidate: 'worktree', json: true
    }
    const handle = await beginExperiment(root, command, {
      name: 'dirty domain cache', hypothesis: 'Skip unchanged propagation.'
    })
    const pending = JSON.parse(await readFile(path.join(handle.directory, 'experiment.json'), 'utf8'))
    expect(pending.status).toBe('pending')
    expect(SHA_PATTERN.test(pending.baseline)).toBe(true)
    const patch = await readFile(path.join(handle.directory, 'patch.diff'), 'utf8')
    expect(patch.includes('candidate')).toBe(true)
    expect(patch.includes('new-file.txt')).toBe(true)

    await finishExperiment(root, handle, {
      ok: true,
      operation: 'compare-compiled',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      data: { performance: { available: true } }
    })
    expect(JSON.parse(await readFile(path.join(handle.directory, 'result.json'), 'utf8')).ok).toBe(true)

    const accepted = await setExperimentVerdict(root, handle.id, 'accepted', '3/3 paired wins.')
    expect(accepted.status).toBe('accepted')
    expect(accepted.reason).toBe('3/3 paired wins.')
    const history = (await readFile(path.join(root, '.benchmarks/experiments/experiments.jsonl'), 'utf8')).trim().split('\n')
    expect(history.length).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
