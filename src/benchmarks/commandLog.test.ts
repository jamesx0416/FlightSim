import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { createCommandLog, createCommandLogRecord, hashCommandSource } from './commandLog'

async function withLogDirectory(testCase: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'flightsim-command-log-test-'))
  try {
    await testCase(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('benchmark command log', () => {
  test('redacts secrets and hashes hook source instead of retaining it', () => {
    const inlineSource = 'window.__DevApi.setToken("do-not-log")'
    const fileSource = 'window.__DevApi.capture()'
    const record = createCommandLogRecord({
      timestamp: '2026-08-29T00:00:00.000Z',
      owner: 'agent-token=visible',
      operation: 'bench browser full',
      arguments: {
        password: 'do-not-log',
        before: inlineSource,
        beforeHook: { kind: 'inline', source: inlineSource },
        nested: { apiKey: 'do-not-log' },
        flags: ['--token', 'do-not-log']
      },
      beforeHook: { kind: 'inline', source: inlineSource },
      afterHook: { kind: 'file', path: 'hooks/capture.js', source: fileSource },
      error: { code: 'AUTH_TOKEN=do-not-log', message: 'token=do-not-log' }
    })

    const serialized = JSON.stringify(record)
    expect(record.beforeHook).toEqual({ kind: 'inline', hash: hashCommandSource(inlineSource) })
    expect(record.afterHook).toEqual({ kind: 'file', path: 'hooks/capture.js', hash: hashCommandSource(fileSource) })
    expect(serialized.includes(inlineSource)).toBe(false)
    expect(serialized.includes(fileSource)).toBe(false)
    expect(serialized.includes('do-not-log')).toBe(false)
    expect(record.arguments).toEqual({
      password: '[redacted]',
      before: hashCommandSource(inlineSource),
      beforeHook: { kind: 'inline', source: hashCommandSource(inlineSource) },
      nested: { apiKey: '[redacted]' },
      flags: ['--token', '[redacted]']
    })
  })

  test('appends successful and failed command records as JSONL', async () => {
    await withLogDirectory(async directory => {
      const filePath = join(directory, 'history.jsonl')
      const log = createCommandLog({ filePath, pid: 101, isProcessAlive: pid => pid === 101 })
      await log.append({ owner: 'agent', operation: 'bench compiled', exitStatus: 0, durationMs: 12 })
      await log.append({
        owner: 'agent',
        operation: 'bench browser full',
        exitStatus: 1,
        durationMs: 15,
        error: { code: 'TIMEOUT', message: 'Timed out after 120 seconds.' },
        artifactDirectory: 'logs/artifacts/run-1'
      })

      const records = (await readFile(filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
        timestamp: string
        operation: string
        exitStatus: number
      })
      expect(records).toEqual([
        { timestamp: records[0]?.timestamp, owner: 'agent', operation: 'bench compiled', arguments: {}, exitStatus: 0, durationMs: 12 },
        {
          timestamp: records[1]?.timestamp,
          owner: 'agent',
          operation: 'bench browser full',
          arguments: {},
          exitStatus: 1,
          durationMs: 15,
          error: { code: 'TIMEOUT', message: 'Timed out after 120 seconds.' },
          artifactDirectory: 'logs/artifacts/run-1'
        }
      ])
    })
  })

  test('rotates a bounded set of log files', async () => {
    await withLogDirectory(async directory => {
      const filePath = join(directory, 'history.jsonl')
      const log = createCommandLog({
        filePath,
        maxBytes: 180,
        maxFiles: 3,
        pid: 101,
        isProcessAlive: pid => pid === 101
      })
      for (const operation of ['first', 'second', 'third', 'fourth']) {
        await log.append({ owner: 'agent', operation, arguments: { payload: 'x'.repeat(80) } })
      }

      expect((await readdir(directory)).sort()).toEqual(['history.jsonl', 'history.jsonl.1', 'history.jsonl.2'])
      expect((await readFile(filePath, 'utf8')).includes('fourth')).toBe(true)
      expect((await readFile(`${filePath}.1`, 'utf8')).includes('third')).toBe(true)
      expect((await readFile(`${filePath}.2`, 'utf8')).includes('second')).toBe(true)
    })
  })

  test('serializes concurrent append and rotation operations', async () => {
    await withLogDirectory(async directory => {
      const filePath = join(directory, 'history.jsonl')
      const log = createCommandLog({ filePath, maxBytes: 10_000, pid: 101, isProcessAlive: pid => pid === 101 })
      await Promise.all(Array.from({ length: 12 }, (_, index) => log.append({
        owner: 'agent',
        operation: `bench-${index}`,
        arguments: { index }
      })))

      const lines = (await readFile(filePath, 'utf8')).trim().split('\n')
      expect(lines.length).toBe(12)
      expect(lines.map(line => JSON.parse(line).operation).sort()).toEqual(Array.from({ length: 12 }, (_, index) => `bench-${index}`).sort())
    })
  })
})
