import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type {
  EvidenceLedger,
  EvidenceEntry,
  EvidenceStatus,
  EvidenceKind,
} from '@forge/types'

export interface EvidenceLedgerOptions {
  stateDir?: string
}

let entryCounter = 0

function nextId(): string {
  entryCounter++
  return `ev-${Date.now()}-${entryCounter}`
}

export class EvidenceLedgerEngine {
  private stateDir: string
  private cache = new Map<string, EvidenceLedger>()

  constructor(options?: EvidenceLedgerOptions) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  async getLedger(taskId: string): Promise<EvidenceLedger | undefined> {
    if (this.cache.has(taskId)) return this.cache.get(taskId)
    return this.load(taskId)
  }

  async addEntry(
    taskId: string,
    claim: string,
    kind: EvidenceKind,
    options?: {
      evidence?: string[]
      unverified?: string[]
      status?: EvidenceStatus
      source?: string
    },
  ): Promise<EvidenceEntry> {
    const ledger = (await this.getLedger(taskId)) ?? {
      entries: [],
      taskId,
    }

    const entry: EvidenceEntry = {
      id: nextId(),
      claim,
      evidence: options?.evidence ?? [],
      unverified: options?.unverified ?? [],
      status: options?.status ?? (options?.evidence && options.evidence.length > 0 ? 'verified' : 'unverified'),
      kind,
      source: options?.source,
      timestamp: new Date().toISOString(),
      referencableId: `evidence:${taskId}:${entryCounter}`,
    }

    ledger.entries.push(entry)
    this.cache.set(taskId, ledger)
    await this.persist(taskId, ledger)
    return entry
  }

  async addEvidence(
    taskId: string,
    entryId: string,
    evidence: string,
  ): Promise<EvidenceEntry | undefined> {
    const ledger = await this.getLedger(taskId)
    if (!ledger) return undefined

    const entry = ledger.entries.find((e) => e.id === entryId)
    if (!entry) return undefined

    if (!entry.evidence.includes(evidence)) {
      entry.evidence.push(evidence)
    }
    // Auto-verify when evidence is added
    entry.status = 'verified'

    this.cache.set(taskId, ledger)
    await this.persist(taskId, ledger)
    return entry
  }

  async markUnverified(
    taskId: string,
    entryId: string,
    note: string,
  ): Promise<EvidenceEntry | undefined> {
    const ledger = await this.getLedger(taskId)
    if (!ledger) return undefined

    const entry = ledger.entries.find((e) => e.id === entryId)
    if (!entry) return undefined

    if (!entry.unverified.includes(note)) {
      entry.unverified.push(note)
    }
    entry.status = 'unverified'

    this.cache.set(taskId, ledger)
    await this.persist(taskId, ledger)
    return entry
  }

  async markNeedsReview(
    taskId: string,
    entryId: string,
  ): Promise<EvidenceEntry | undefined> {
    const ledger = await this.getLedger(taskId)
    if (!ledger) return undefined

    const entry = ledger.entries.find((e) => e.id === entryId)
    if (!entry) return undefined

    entry.status = 'needs_review'

    this.cache.set(taskId, ledger)
    await this.persist(taskId, ledger)
    return entry
  }

  async getEntry(
    taskId: string,
    entryId: string,
  ): Promise<EvidenceEntry | undefined> {
    const ledger = await this.getLedger(taskId)
    return ledger?.entries.find((e) => e.id === entryId)
  }

  async getVerifiedClaims(taskId: string): Promise<EvidenceEntry[]> {
    const ledger = await this.getLedger(taskId)
    return (ledger?.entries ?? []).filter((e) => e.status === 'verified')
  }

  async getUnverifiedClaims(taskId: string): Promise<EvidenceEntry[]> {
    const ledger = await this.getLedger(taskId)
    return (ledger?.entries ?? []).filter((e) => e.status === 'unverified')
  }

  async getNeedsReviewClaims(taskId: string): Promise<EvidenceEntry[]> {
    const ledger = await this.getLedger(taskId)
    return (ledger?.entries ?? []).filter((e) => e.status === 'needs_review')
  }

  async getSummary(taskId: string): Promise<{
    total: number
    verified: number
    unverified: number
    needsReview: number
  }> {
    const ledger = await this.getLedger(taskId)
    const entries = ledger?.entries ?? []
    return {
      total: entries.length,
      verified: entries.filter((e) => e.status === 'verified').length,
      unverified: entries.filter((e) => e.status === 'unverified').length,
      needsReview: entries.filter((e) => e.status === 'needs_review').length,
    }
  }

  private ledgerPath(taskId: string): string {
    return join(this.stateDir, 'evidence', `${taskId}.json`)
  }

  private async persist(taskId: string, ledger: EvidenceLedger): Promise<void> {
    const filePath = this.ledgerPath(taskId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(ledger, null, 2), 'utf-8')
  }

  private async load(taskId: string): Promise<EvidenceLedger | undefined> {
    try {
      const filePath = this.ledgerPath(taskId)
      const content = await readFile(filePath, 'utf-8')
      const ledger = JSON.parse(content) as EvidenceLedger
      this.cache.set(taskId, ledger)
      return ledger
    } catch {
      return undefined
    }
  }
}
