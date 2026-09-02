import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { createBenchmarkQueue } from './queue'

async function withQueueRoot(testCase: (rootDirectory: string) => Promise<void>): Promise<void> {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'flightsim-benchmark-queue-test-'))
  try {
    await testCase(rootDirectory)
  } finally {
    await rm(rootDirectory, { recursive: true, force: true })
  }
}

describe('benchmark queue', () => {
  test('assigns FIFO tickets and permits one lease at a time', async () => {
    await withQueueRoot(async rootDirectory => {
      const isProcessAlive = (pid: number): boolean => pid === 101 || pid === 202
      const first = createBenchmarkQueue({ rootDirectory, pid: 101, isProcessAlive })
      const second = createBenchmarkQueue({ rootDirectory, pid: 202, isProcessAlive })
      const firstTicket = await first.join()
      const secondTicket = await second.join()

      expect(firstTicket.sequence).toBe(1)
      expect(secondTicket.sequence).toBe(2)

      const firstLease = await first.tryAcquire(firstTicket)
      expect(firstLease).toEqual({ pid: 101, slot: 1 })
      expect(await second.tryAcquire(secondTicket)).toBe(null)

      expect(await first.release(firstLease!)).toBe(true)
      expect(await second.tryAcquire(secondTicket)).toEqual({ pid: 202, slot: 1 })
    })
  })

  test('waits internally and reports queue position without callers polling', async () => {
    await withQueueRoot(async rootDirectory => {
      const isProcessAlive = (pid: number): boolean => pid === 101 || pid === 202
      const first = createBenchmarkQueue({ rootDirectory, pid: 101, isProcessAlive })
      const second = createBenchmarkQueue({ rootDirectory, pid: 202, isProcessAlive })
      const firstTicket = await first.join()
      const firstLease = await first.tryAcquire(firstTicket)
      const secondTicket = await second.join()

      let notifyWaiting: (() => void) | undefined
      const positions: number[] = []
      const waiting = new Promise<void>(resolve => { notifyWaiting = resolve })
      const leasePromise = second.waitForLease(secondTicket, {
        onProgress: progress => {
          positions.push(progress.requestsAhead)
          if (progress.requestsAhead === 1) notifyWaiting?.()
        }
      })

      await waiting
      await first.release(firstLease!)
      expect(await leasePromise).toEqual({ pid: 202, slot: 1 })
      expect(positions[0]).toBe(1)
    })
  })

  test('recovers a lease only after its PID is demonstrably dead', async () => {
    await withQueueRoot(async rootDirectory => {
      const staleOwner = createBenchmarkQueue({
        rootDirectory,
        pid: 101,
        isProcessAlive: () => true
      })
      const staleLease = await staleOwner.acquire()
      expect(staleLease).toEqual({ pid: 101, slot: 1 })

      const nextOwner = createBenchmarkQueue({
        rootDirectory,
        pid: 202,
        isProcessAlive: pid => pid === 202
      })
      const nextTicket = await nextOwner.join()
      expect(await nextOwner.tryAcquire(nextTicket)).toEqual({ pid: 202, slot: 1 })
    })
  })

  test('retains and resolves only the named session, and recovers a missing retained session', async () => {
    await withQueueRoot(async rootDirectory => {
      const isProcessAlive = (pid: number): boolean => pid === 101 || pid === 202
      const owner = createBenchmarkQueue({ rootDirectory, pid: 101, isProcessAlive })
      const lease = await owner.acquire()
      const retained = await owner.retain(lease, 'flightsim-owner-1')
      expect(retained).toEqual({ pid: 101, slot: 1, sessionName: 'flightsim-owner-1' })
      expect(await owner.resolveRetainedLease('another-session')).toBe(null)
      expect(await owner.resolveRetainedLease('flightsim-owner-1')).toEqual(retained)

      const nextOwner = createBenchmarkQueue({
        rootDirectory,
        pid: 202,
        isProcessAlive,
        isSessionActive: sessionName => sessionName !== 'flightsim-owner-1'
      })
      const nextTicket = await nextOwner.join()
      expect(await nextOwner.tryAcquire(nextTicket)).toEqual({ pid: 202, slot: 1 })
    })
  })

  test('transfers a retained lease to its keeper and permits later session-matched cleanup', async () => {
    await withQueueRoot(async rootDirectory => {
      const foreground = createBenchmarkQueue({
        rootDirectory,
        pid: 101,
        isProcessAlive: pid => pid === 101 || pid === 303
      })
      const lease = await foreground.acquire()
      const retained = await foreground.transferToKeeper(lease, 303, 'flightsim-keeper-1')
      expect(retained).toEqual({ pid: 303, slot: 1, sessionName: 'flightsim-keeper-1' })

      const closeProcess = createBenchmarkQueue({
        rootDirectory,
        pid: 404,
        isProcessAlive: pid => pid === 303 || pid === 404
      })
      expect(await closeProcess.activeLease()).toEqual(retained)
      expect(await closeProcess.releaseRetained('wrong-session')).toBe(false)
      expect(await closeProcess.activeLease()).toEqual(retained)
      expect(await closeProcess.releaseRetained('flightsim-keeper-1')).toBe(true)
      expect(await closeProcess.activeLease()).toBe(null)
    })
  })

  test('persists minimal ticket and lease records', async () => {
    await withQueueRoot(async rootDirectory => {
      const queue = createBenchmarkQueue({ rootDirectory, pid: 101, isProcessAlive: pid => pid === 101 })
      const ticket = await queue.join()
      expect(await readFile(join(rootDirectory, 'sequence'), 'utf8')).toBe('1\n')
      const lease = await queue.tryAcquire(ticket)
      expect(await readFile(join(rootDirectory, 'lease.json'), 'utf8')).toBe('{"pid":101,"slot":1}\n')
      await queue.retain(lease!, 'flightsim-owner-1')
      expect(await readFile(join(rootDirectory, 'lease.json'), 'utf8')).toBe('{"pid":101,"slot":1,"sessionName":"flightsim-owner-1"}\n')
    })
  })

  test('persistent capacity two permits two FIFO leases and blocks the third', async () => {
    await withQueueRoot(async rootDirectory => {
      const alive = (pid: number): boolean => [101, 202, 303].includes(pid)
      const first = createBenchmarkQueue({ rootDirectory, pid: 101, isProcessAlive: alive })
      const second = createBenchmarkQueue({ rootDirectory, pid: 202, isProcessAlive: alive })
      const third = createBenchmarkQueue({ rootDirectory, pid: 303, isProcessAlive: alive })
      await first.setCapacity(2)
      expect(await first.capacity()).toBe(2)

      const firstTicket = await first.join()
      const secondTicket = await second.join()
      const thirdTicket = await third.join()
      expect(await first.tryAcquire(firstTicket)).toEqual({ pid: 101, slot: 1 })
      expect(await second.tryAcquire(secondTicket)).toEqual({ pid: 202, slot: 2 })
      expect(await third.tryAcquire(thirdTicket)).toBe(null)
    })
  })

  test('explicit slot two works without changing persistent capacity', async () => {
    await withQueueRoot(async rootDirectory => {
      const alive = (pid: number): boolean => pid === 101 || pid === 202
      const main = createBenchmarkQueue({ rootDirectory, pid: 101, isProcessAlive: alive })
      const sub = createBenchmarkQueue({ rootDirectory, pid: 202, isProcessAlive: alive })
      const mainLease = await main.acquire()
      const explicit = await sub.acquireSlot(2)

      expect(mainLease).toEqual({ pid: 101, slot: 1 })
      expect(explicit.lease).toEqual({ pid: 202, slot: 2 })
      expect(await sub.capacity()).toBe(1)
      expect(await sub.release(explicit.lease)).toBe(true)
      expect(await sub.capacity()).toBe(1)
    })
  })


  test('a blocked explicit slot waiter does not block later runnable automatic work', async () => {
    await withQueueRoot(async rootDirectory => {
      const alive = (pid: number): boolean => [101, 202, 303].includes(pid)
      const owner = createBenchmarkQueue({ rootDirectory, pid: 101, isProcessAlive: alive })
      const explicit = createBenchmarkQueue({ rootDirectory, pid: 202, isProcessAlive: alive })
      const automatic = createBenchmarkQueue({ rootDirectory, pid: 303, isProcessAlive: alive })
      await owner.setCapacity(2)
      const ownerTicket = await owner.join(1)
      expect(await owner.tryAcquire(ownerTicket)).toEqual({ pid: 101, slot: 1 })

      const explicitTicket = await explicit.join(1)
      const automaticTicket = await automatic.join()
      expect(await explicit.tryAcquire(explicitTicket)).toBe(null)
      expect(await automatic.tryAcquire(automaticTicket)).toEqual({ pid: 303, slot: 2 })
    })
  })

})
