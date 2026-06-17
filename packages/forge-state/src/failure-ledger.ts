import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { FailureLedger, FailureEntry, FailureReflection } from '@forge/types'

export interface FailureLedgerOptions {
  stateDir?: string
}

let failureCounter = 0

function nextId(): string {
  failureCounter++
  return `fail-${Date.now()}-${failureCounter}`
}

export class FailureLedgerEngine {
  private stateDir: string
  private cache = new Map<string, FailureLedger>()

  constructor(options?: FailureLedgerOptions) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  async addEntry(
    taskId: string,
    hypothesis: string,
    action: string,
    result: string,
    lesson: string,
    options?: {
      nextHypothesis?: string
      evidenceRefs?: string[]
      context?: Record<string, unknown>
    },
  ): Promise<FailureEntry> {
    const ledger = (await this.getLedger(taskId)) ?? { entries: [], taskId }

    const entry: FailureEntry = {
      id: nextId(),
      hypothesis,
      action,
      result,
      lesson,
      nextHypothesis: options?.nextHypothesis,
      evidenceRefs: options?.evidenceRefs ?? [],
      timestamp: new Date().toISOString(),
      context: options?.context,
    }

    ledger.entries.push(entry)
    this.cache.set(taskId, ledger)
    await this.persist(taskId, ledger)
    return entry
  }

  async getLedger(taskId: string): Promise<FailureLedger | undefined> {
    if (this.cache.has(taskId)) return this.cache.get(taskId)
    return this.load(taskId)
  }

  async getEntries(taskId: string): Promise<FailureEntry[]> {
    const ledger = await this.getLedger(taskId)
    return ledger?.entries ?? []
  }

  async getRecent(taskId: string, count = 5): Promise<FailureEntry[]> {
    const entries = await this.getEntries(taskId)
    return entries.slice(-count)
  }

  async getSummary(taskId: string): Promise<{
    total: number
    uniqueHypotheses: number
    recentFailures: FailureEntry[]
  }> {
    const entries = await this.getEntries(taskId)
    const uniqueHypotheses = new Set(entries.map((e) => e.hypothesis)).size
    return {
      total: entries.length,
      uniqueHypotheses,
      recentFailures: entries.slice(-3),
    }
  }

  // Reflection: check if a hypothesis has already been tried

  async hasFailed(taskId: string, hypothesis: string): Promise<boolean> {
    const entries = await this.getEntries(taskId)
    return entries.some((e) =>
      e.hypothesis.toLowerCase() === hypothesis.toLowerCase(),
    )
  }

  async getFailedAttempts(taskId: string, hypothesis: string): Promise<FailureEntry[]> {
    const entries = await this.getEntries(taskId)
    return entries.filter((e) =>
      e.hypothesis.toLowerCase() === hypothesis.toLowerCase(),
    )
  }

  async getReflection(taskId: string, hypothesis: string): Promise<FailureReflection | undefined> {
    const entries = await this.getFailedAttempts(taskId, hypothesis)
    if (entries.length === 0) return undefined

    const last = entries[entries.length - 1]!

    return {
      entryId: last.id,
      whatWasTried: last.hypothesis,
      whyItFailed: last.result,
      whatDisprovedIt: last.lesson,
      shouldNotRepeat: [last.action],
      newlyPlausible: last.nextHypothesis ? [last.nextHypothesis] : [],
      nextBestHypothesis: last.nextHypothesis ?? 'Re-evaluate the problem',
    }
  }

  async shouldAvoid(taskId: string, hypothesis: string): Promise<{
    shouldAvoid: boolean
    reason?: string
    previousAttempt?: FailureEntry
  }> {
    const attempts = await this.getFailedAttempts(taskId, hypothesis)
    if (attempts.length === 0) return { shouldAvoid: false }

    const last = attempts[attempts.length - 1]!
    return {
      shouldAvoid: true,
      reason: last.lesson,
      previousAttempt: last,
    }
  }

  async getWarnings(taskId: string): Promise<string[]> {
    const entries = await this.getEntries(taskId)
    return entries.slice(-3).map((e) =>
      `⚠ ${e.hypothesis}: ${e.lesson}`,
    )
  }

  private ledgerPath(taskId: string): string {
    return join(this.stateDir, 'failures', `${taskId}.json`)
  }

  private async persist(taskId: string, ledger: FailureLedger): Promise<void> {
    const filePath = this.ledgerPath(taskId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(ledger, null, 2), 'utf-8')
  }

  private async load(taskId: string): Promise<FailureLedger | undefined> {
    try {
      const filePath = this.ledgerPath(taskId)
      const content = await readFile(filePath, 'utf-8')
      const ledger = JSON.parse(content) as FailureLedger
      this.cache.set(taskId, ledger)
      return ledger
    } catch {
      return undefined
    }
  }
}
