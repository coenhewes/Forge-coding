import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { DecisionLedger, DecisionEntry } from '@forge/types'

export interface DecisionLedgerOptions {
  stateDir?: string
}

let decisionCounter = 0

function nextId(): string {
  decisionCounter++
  return `dec-${Date.now()}-${decisionCounter}`
}

export class DecisionLedgerEngine {
  private stateDir: string
  private cache = new Map<string, DecisionLedger>()

  constructor(options?: DecisionLedgerOptions) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  async addEntry(
    taskId: string,
    decision: string,
    rationale: string,
    alternativesRejected: string[],
    options?: {
      verificationRequired?: string[]
      domain?: string
    },
  ): Promise<DecisionEntry> {
    const ledger = (await this.getLedger(taskId)) ?? { entries: [], taskId }

    const entry: DecisionEntry = {
      id: nextId(),
      decision,
      rationale,
      alternativesRejected,
      verificationRequired: options?.verificationRequired ?? [],
      domain: options?.domain,
      author: 'agent',
      timestamp: new Date().toISOString(),
    }

    ledger.entries.push(entry)
    this.cache.set(taskId, ledger)
    await this.persist(taskId, ledger)
    return entry
  }

  async addHumanDecision(
    taskId: string,
    decision: string,
    rationale: string,
    alternativesRejected: string[],
    options?: {
      verificationRequired?: string[]
      domain?: string
    },
  ): Promise<DecisionEntry> {
    const entry = await this.addEntry(taskId, decision, rationale, alternativesRejected, options)
    entry.author = 'human'
    // Re-persist to save the updated author
    const ledger = await this.getLedger(taskId)
    if (ledger) {
      const idx = ledger.entries.findIndex((e) => e.id === entry.id)
      if (idx >= 0) {
        ledger.entries[idx] = entry
        this.cache.set(taskId, ledger)
        await this.persist(taskId, ledger)
      }
    }
    return entry
  }

  async getLedger(taskId: string): Promise<DecisionLedger | undefined> {
    if (this.cache.has(taskId)) return this.cache.get(taskId)
    return this.load(taskId)
  }

  async getEntries(taskId: string): Promise<DecisionEntry[]> {
    const ledger = await this.getLedger(taskId)
    return ledger?.entries ?? []
  }

  async getDecisionsByDomain(taskId: string, domain: string): Promise<DecisionEntry[]> {
    const entries = await this.getEntries(taskId)
    return entries.filter((e) => e.domain === domain)
  }

  async getRecent(taskId: string, count = 5): Promise<DecisionEntry[]> {
    const entries = await this.getEntries(taskId)
    return entries.slice(-count)
  }

  async getSummary(taskId: string): Promise<{
    total: number
    agent: number
    human: number
    domains: string[]
  }> {
    const entries = await this.getEntries(taskId)
    const domains = [...new Set(entries.map((e) => e.domain).filter(Boolean) as string[])]
    return {
      total: entries.length,
      agent: entries.filter((e) => e.author === 'agent').length,
      human: entries.filter((e) => e.author === 'human').length,
      domains,
    }
  }

  private ledgerPath(taskId: string): string {
    return join(this.stateDir, 'decisions', `${taskId}.json`)
  }

  private async persist(taskId: string, ledger: DecisionLedger): Promise<void> {
    const filePath = this.ledgerPath(taskId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(ledger, null, 2), 'utf-8')
  }

  private async load(taskId: string): Promise<DecisionLedger | undefined> {
    try {
      const filePath = this.ledgerPath(taskId)
      const content = await readFile(filePath, 'utf-8')
      const ledger = JSON.parse(content) as DecisionLedger
      this.cache.set(taskId, ledger)
      return ledger
    } catch {
      return undefined
    }
  }
}
