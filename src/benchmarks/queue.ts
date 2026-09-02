import { link, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type QueueTicket = {
  readonly sequence: number
  readonly pid: number
  readonly slot?: 1 | 2
}

export type BenchmarkLease = {
  readonly pid: number
  readonly slot: 1 | 2
  readonly sessionName?: string
}

export type RetainedBenchmarkLease = Required<Pick<BenchmarkLease, 'pid' | 'slot' | 'sessionName'>>

export type QueueProgress = {
  readonly requestsAhead: number
}

export type QueueWaitOptions = {
  readonly onProgress?: (progress: QueueProgress) => void
}

export type ProcessLiveness = (pid: number) => boolean | Promise<boolean>
export type SessionLiveness = (sessionName: string) => boolean | Promise<boolean>

export type BenchmarkQueueOptions = {
  /** A test override. Production callers should use the machine-wide default. */
  readonly rootDirectory?: string
  /** A test override. Queue records always retain the actual owning PID in production. */
  readonly pid?: number
  readonly isProcessAlive?: ProcessLiveness
  /** Used only for leases that retain an Agent Browser session. */
  readonly isSessionActive?: SessionLiveness
}

type QueuePaths = {
  readonly root: string
  readonly tickets: string
  readonly sequence: string
  readonly lease: string
  readonly extraLease: string
  readonly capacity: string
  readonly lock: string
}

type ParsedTicket = QueueTicket & {
  readonly path: string
}

const DEFAULT_QUEUE_DIRECTORY = join(tmpdir(), 'flightsim-browser-benchmark-queue-v1')
const LOCK_RETRY_MAX_MS = 100
const TICKET_FILE_PATTERN = /^(\d+)-(\d+)(?:-([12]))?$/
const localLocks = new Map<string, Promise<void>>()

/**
 * A machine-wide, filesystem-coordinated queue for work that can affect benchmark results.
 * Waiting is internal to acquire(); callers never need to implement a polling loop.
 */
export class BenchmarkQueue {
  readonly #paths: QueuePaths
  readonly #pid: number
  readonly #isProcessAlive: ProcessLiveness
  readonly #isSessionActive: SessionLiveness | undefined

  constructor(options: BenchmarkQueueOptions = {}) {
    this.#paths = createQueuePaths(options.rootDirectory ?? DEFAULT_QUEUE_DIRECTORY)
    this.#pid = options.pid ?? process.pid
    this.#isProcessAlive = options.isProcessAlive ?? isProcessAlive
    this.#isSessionActive = options.isSessionActive
  }

  async join(slot?: 1 | 2): Promise<QueueTicket> {
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      await this.#recoverStaleState()
      const sequence = await this.#nextSequence()
      const ticket: QueueTicket = { sequence, pid: this.#pid, slot }
      await writeFile(ticketPath(this.#paths, ticket), '', { flag: 'wx' })
      return ticket
    })
  }

  async acquire(options: QueueWaitOptions = {}): Promise<BenchmarkLease> {
    const ticket = await this.join()
    try {
      return await this.waitForLease(ticket, options)
    } catch (error) {
      await this.cancel(ticket)
      throw error
    }
  }

  async waitForLease(ticket: QueueTicket, options: QueueWaitOptions = {}): Promise<BenchmarkLease> {
    this.#assertTicketOwner(ticket)
    let previousAhead: number | undefined
    let retryMs = 4

    for (;;) {
      const result = await this.#withLock(async () => {
        await this.#ensureDirectories()
        await this.#recoverStaleState()
        const tickets = await this.#readTickets()
        const ownTicket = tickets.find(candidate => sameTicket(candidate, ticket))
        if (ownTicket == null) {
          throw new Error(`Benchmark queue ticket ${ticket.sequence}/${ticket.pid} no longer exists.`)
        }

        const capacity = await this.#readCapacity()
        const runnable = await this.#runnableTickets(tickets, capacity)
        const runnableIndex = runnable.findIndex(candidate => sameTicket(candidate.ticket, ticket))
        if (runnableIndex === 0) {
          const selected = runnable[0]!
          const lease: BenchmarkLease = { pid: ticket.pid, slot: selected.slot }
          await this.#writeLease(lease)
          await unlink(ownTicket.path)
          return { lease, requestsAhead: 0 }
        }
        const requestsAhead = runnableIndex > 0 ? runnableIndex : tickets.filter(candidate => candidate.sequence < ticket.sequence).length + 1
        return { lease: null, requestsAhead }
      })

      if (result.lease != null) return result.lease
      if (previousAhead !== result.requestsAhead) {
        options.onProgress?.({ requestsAhead: result.requestsAhead })
        previousAhead = result.requestsAhead
      }
      await waitForQueueChange(retryMs)
      retryMs = Math.min(retryMs * 2, LOCK_RETRY_MAX_MS)
    }
  }

  async acquireSlot(slot: 1 | 2, options: QueueWaitOptions = {}): Promise<{ readonly ticket: QueueTicket; readonly lease: BenchmarkLease }> {
    const ticket = await this.join(slot)
    try {
      return { ticket, lease: await this.waitForLease(ticket, options) }
    } catch (error) {
      await this.cancel(ticket)
      throw error
    }
  }

  async tryAcquire(ticket: QueueTicket): Promise<BenchmarkLease | null> {
    this.#assertTicketOwner(ticket)
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      await this.#recoverStaleState()
      const tickets = await this.#readTickets()
      const ownTicket = tickets.find(candidate => sameTicket(candidate, ticket))
      if (ownTicket == null) return null
      const runnable = await this.#runnableTickets(tickets, await this.#readCapacity())
      if (!sameTicket(runnable[0]?.ticket, ticket)) return null

      const lease: BenchmarkLease = { pid: ticket.pid, slot: runnable[0]!.slot }
      await this.#writeLease(lease)
      await rm(ownTicket.path)
      return lease
    })
  }

  async cancel(ticket: QueueTicket): Promise<boolean> {
    this.#assertTicketOwner(ticket)
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      try {
        await unlink(ticketPath(this.#paths, ticket))
        return true
      } catch (error) {
        if (isMissingFileError(error)) return false
        throw error
      }
    })
  }

  async release(lease: BenchmarkLease): Promise<boolean> {
    this.#assertLeaseOwner(lease)
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      const activeLease = await this.#readLease(lease.slot)
      if (activeLease == null || !sameLease(activeLease, lease)) return false
      await unlink(this.#leasePath(lease.slot))
      return true
    })
  }

  /** Associates the currently held lease with a retained Agent Browser session. */
  async retain(lease: BenchmarkLease, sessionName: string): Promise<RetainedBenchmarkLease> {
    this.#assertLeaseOwner(lease)
    if (sessionName.length === 0) throw new Error('A retained benchmark lease requires a session name.')

    return this.#withLock(async () => {
      await this.#ensureDirectories()
      const activeLease = await this.#readLease(lease.slot)
      if (activeLease == null || !sameLease(activeLease, lease)) {
        throw new Error('Cannot retain a benchmark lease that is no longer active.')
      }

      const retainedLease: RetainedBenchmarkLease = { pid: lease.pid, slot: lease.slot, sessionName }
      await this.#writeLease(retainedLease)
      return retainedLease
    })
  }

  /**
   * Transfers an active foreground lease to the detached browser keeper. The
   * persisted lease remains deliberately minimal: keeper PID, slot, and session name.
   */
  async transferToKeeper(
    lease: BenchmarkLease,
    keeperPid: number,
    sessionName: string
  ): Promise<RetainedBenchmarkLease> {
    this.#assertLeaseOwner(lease)
    if (!isPositiveInteger(keeperPid)) throw new Error('A benchmark lease keeper requires a positive PID.')
    if (sessionName.length === 0) throw new Error('A benchmark lease keeper requires a session name.')

    return this.#withLock(async () => {
      await this.#ensureDirectories()
      const activeLease = await this.#readLease(lease.slot)
      if (activeLease == null || !sameLease(activeLease, lease)) {
        throw new Error('Cannot transfer a benchmark lease that is no longer active.')
      }

      const retainedLease: RetainedBenchmarkLease = { pid: keeperPid, slot: lease.slot, sessionName }
      await this.#writeLease(retainedLease)
      return retainedLease
    })
  }

  /** Resolves a retained lease without exposing another owner’s session as reusable. */
  async resolveRetainedLease(sessionName: string): Promise<RetainedBenchmarkLease | null> {
    if (sessionName.length === 0) return null
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      await this.#recoverStaleState()
      const lease = (await this.#readLeases()).find(candidate => candidate.sessionName === sessionName)
      return lease == null || lease.sessionName == null
        ? null
        : { pid: lease.pid, slot: lease.slot, sessionName: lease.sessionName }
    })
  }

  /** Releases a retained session from a later browser-close process. */
  async releaseRetained(sessionName: string): Promise<boolean> {
    if (sessionName.length === 0) return false
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      const lease = (await this.#readLeases()).find(candidate => candidate.sessionName === sessionName)
      if (lease == null) return false
      await unlink(this.#leasePath(lease.slot))
      return true
    })
  }

  async activeLease(): Promise<BenchmarkLease | null> {
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      await this.#recoverStaleState()
      return (await this.#readLeases())[0] ?? null
    })
  }

  async activeLeases(): Promise<readonly BenchmarkLease[]> {
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      await this.#recoverStaleState()
      return this.#readLeases()
    })
  }

  async waitingTickets(): Promise<readonly QueueTicket[]> {
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      await this.#recoverStaleState()
      return (await this.#readTickets()).map(({ path: _path, ...ticket }) => ticket)
    })
  }

  async capacity(): Promise<1 | 2> {
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      return this.#readCapacity()
    })
  }

  async setCapacity(capacity: 1 | 2): Promise<1 | 2> {
    return this.#withLock(async () => {
      await this.#ensureDirectories()
      await writeAtomically(this.#paths.capacity, `${capacity}\n`)
      return capacity
    })
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withAtomicFileLock(this.#paths.lock, this.#pid, this.#isProcessAlive, operation)
  }

  async #ensureDirectories(): Promise<void> {
    await mkdir(this.#paths.tickets, { recursive: true })
  }

  async #nextSequence(): Promise<number> {
    let previousSequence = 0
    try {
      const contents = await readFile(this.#paths.sequence, 'utf8')
      previousSequence = parseSequence(contents)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }

    const sequence = previousSequence + 1
    await writeAtomically(this.#paths.sequence, `${sequence}\n`)
    return sequence
  }

  async #readTickets(): Promise<ParsedTicket[]> {
    const names = await readdir(this.#paths.tickets)
    const tickets = names.flatMap(name => {
      const ticket = parseTicket(name)
      return ticket == null ? [] : [{ ...ticket, path: join(this.#paths.tickets, name) }]
    })
    tickets.sort(compareTickets)
    return tickets
  }

  #leasePath(slot: 1 | 2): string {
    return slot === 1 ? this.#paths.lease : this.#paths.extraLease
  }

  async #readLease(slot: 1 | 2): Promise<BenchmarkLease | null> {
    try {
      const contents = await readFile(this.#leasePath(slot), 'utf8')
      return parseLease(contents, slot)
    } catch (error) {
      if (isMissingFileError(error)) return null
      throw error
    }
  }

  async #readLeases(): Promise<BenchmarkLease[]> {
    const leases = await Promise.all([this.#readLease(1), this.#readLease(2)])
    return leases.filter((lease): lease is BenchmarkLease => lease != null)
  }

  async #writeLease(lease: BenchmarkLease): Promise<void> {
    await writeAtomically(this.#leasePath(lease.slot), `${JSON.stringify(lease)}\n`)
  }

  async #readCapacity(): Promise<1 | 2> {
    try {
      return parseCapacity(await readFile(this.#paths.capacity, 'utf8'))
    } catch (error) {
      if (isMissingFileError(error)) return 1
      throw error
    }
  }

  async #runnableTickets(tickets: readonly ParsedTicket[], capacity: 1 | 2): Promise<readonly { readonly ticket: ParsedTicket; readonly slot: 1 | 2 }[]> {
    const free = new Set<1 | 2>()
    if (await this.#readLease(1) == null) free.add(1)
    if (await this.#readLease(2) == null) free.add(2)
    const automatic = capacity === 2 ? ([1, 2] as const) : ([1] as const)
    const result: { ticket: ParsedTicket; slot: 1 | 2 }[] = []
    for (const ticket of tickets) {
      const slot = ticket.slot == null ? automatic.find(candidate => free.has(candidate)) : free.has(ticket.slot) ? ticket.slot : undefined
      if (slot == null) continue
      result.push({ ticket, slot })
      free.delete(slot)
    }
    return result
  }

  async #recoverStaleState(): Promise<void> {
    for (const ticket of await this.#readTickets()) {
      if (!await this.#isProcessAlive(ticket.pid)) await unlink(ticket.path)
    }

    for (const lease of await this.#readLeases()) {
      const ownerAlive = await this.#isProcessAlive(lease.pid)
      const sessionAlive = lease.sessionName == null || this.#isSessionActive == null
        ? true
        : await this.#isSessionActive(lease.sessionName)
      if (!ownerAlive || !sessionAlive) await unlink(this.#leasePath(lease.slot))
    }
  }

  #assertTicketOwner(ticket: QueueTicket): void {
    if (ticket.pid !== this.#pid) throw new Error('A benchmark queue ticket can only be managed by its owning PID.')
  }

  #assertLeaseOwner(lease: BenchmarkLease): void {
    if (lease.pid !== this.#pid) throw new Error('A benchmark lease can only be managed by its owning PID.')
  }
}

export function createBenchmarkQueue(options: BenchmarkQueueOptions = {}): BenchmarkQueue {
  return new BenchmarkQueue(options)
}

/** The conservative process check used for stale recovery. Permission-denied means alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isPermissionError(error)
  }
}

/**
 * Runs an operation under a cross-process lock. The lock records its PID before it
 * becomes visible, so a crashed owner can be recovered only after that PID is dead.
 */
export async function withAtomicFileLock<T>(
  lockPath: string,
  pid: number,
  pidIsAlive: ProcessLiveness,
  operation: () => Promise<T>
): Promise<T> {
  const prior = localLocks.get(lockPath) ?? Promise.resolve()
  let releaseLocalLock: (() => void) | undefined
  const localLock = new Promise<void>(resolve => { releaseLocalLock = resolve })
  const queuedLocalLock = prior.then(() => localLock)
  localLocks.set(lockPath, queuedLocalLock)
  await prior

  try {
    await mkdir(parentDirectory(lockPath), { recursive: true })
    await acquireFileLock(lockPath, pid, pidIsAlive)
    try {
      return await operation()
    } finally {
      await unlink(lockPath).catch(error => {
        if (!isMissingFileError(error)) throw error
      })
    }
  } finally {
    releaseLocalLock?.()
    if (localLocks.get(lockPath) === queuedLocalLock) localLocks.delete(lockPath)
  }
}

function createQueuePaths(root: string): QueuePaths {
  return {
    root,
    tickets: join(root, 'tickets'),
    sequence: join(root, 'sequence'),
    lease: join(root, 'lease.json'),
    extraLease: join(root, 'lease-2.json'),
    capacity: join(root, 'capacity'),
    lock: join(root, 'coordination.lock')
  }
}

async function acquireFileLock(lockPath: string, pid: number, pidIsAlive: ProcessLiveness): Promise<void> {
  let retryMs = 2
  for (;;) {
    const candidate = `${lockPath}.${pid}.${crypto.randomUUID()}`
    await writeFile(candidate, `${pid}\n`, { flag: 'wx' })
    try {
      await link(candidate, lockPath)
      return
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error
    } finally {
      await rm(candidate, { force: true })
    }

    const ownerPid = await readLockOwnerPid(lockPath)
    if (ownerPid != null && !await pidIsAlive(ownerPid)) {
      await unlink(lockPath).catch(error => {
        if (!isMissingFileError(error)) throw error
      })
      continue
    }

    await waitForQueueChange(retryMs)
    retryMs = Math.min(retryMs * 2, LOCK_RETRY_MAX_MS)
  }
}

async function readLockOwnerPid(lockPath: string): Promise<number | null> {
  try {
    return parsePid(await readFile(lockPath, 'utf8'))
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}`
  await writeFile(temporaryPath, contents, { flag: 'wx' })
  await rename(temporaryPath, path)
}

function parseSequence(contents: string): number {
  const sequence = Number(contents.trim())
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Benchmark queue sequence is corrupt.')
  }
  return sequence
}

function parseTicket(name: string): QueueTicket | null {
  const match = TICKET_FILE_PATTERN.exec(name)
  if (match == null) return null
  const sequence = Number(match[1])
  const pid = Number(match[2])
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isSafeInteger(pid) || pid <= 0) return null
  const slot = match[3] === '1' ? 1 : match[3] === '2' ? 2 : undefined
  return { sequence, pid, slot }
}

function ticketPath(paths: QueuePaths, ticket: QueueTicket): string {
  return join(paths.tickets, `${ticket.sequence}-${ticket.pid}${ticket.slot == null ? '' : `-${ticket.slot}`}`)
}

function parseLease(contents: string, fallbackSlot: 1 | 2): BenchmarkLease {
  const parsed: unknown = JSON.parse(contents)
  if (!isRecord(parsed) || !isPositiveInteger(parsed.pid)) throw new Error('Benchmark queue lease is corrupt.')
  if (parsed.sessionName != null && typeof parsed.sessionName !== 'string') {
    throw new Error('Benchmark queue lease is corrupt.')
  }
  const slot = parsed.slot === 1 || parsed.slot === 2 ? parsed.slot : fallbackSlot
  return parsed.sessionName == null
    ? { pid: parsed.pid, slot }
    : { pid: parsed.pid, slot, sessionName: parsed.sessionName }
}

function parseCapacity(contents: string): 1 | 2 {
  const value = Number(contents.trim())
  if (value !== 1 && value !== 2) throw new Error('Benchmark queue capacity is corrupt.')
  return value
}

function parsePid(value: string): number | null {
  const pid = Number(value.trim())
  return isPositiveInteger(pid) ? pid : null
}

function compareTickets(left: QueueTicket, right: QueueTicket): number {
  return left.sequence - right.sequence || left.pid - right.pid
}

function sameTicket(left: QueueTicket | undefined, right: QueueTicket): boolean {
  return left?.sequence === right.sequence && left.pid === right.pid && left.slot === right.slot
}

function sameLease(left: BenchmarkLease, right: BenchmarkLease): boolean {
  return left.pid === right.pid && left.slot === right.slot && left.sessionName === right.sessionName
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '.' : path.slice(0, slash)
}

function waitForQueueChange(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isAlreadyExistsError(error: unknown): boolean {
  return isSystemError(error, 'EEXIST')
}

function isMissingFileError(error: unknown): boolean {
  return isSystemError(error, 'ENOENT')
}

function isPermissionError(error: unknown): boolean {
  return isSystemError(error, 'EPERM') || isSystemError(error, 'EACCES')
}

function isSystemError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}
