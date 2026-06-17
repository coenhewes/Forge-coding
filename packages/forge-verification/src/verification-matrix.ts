import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type {
  VerificationMatrix,
  VerificationEntry,
  VerificationStatus,
} from '@forge/types'

export interface VerificationMatrixOptions {
  stateDir?: string
}

export class VerificationMatrixEngine {
  private stateDir: string
  private cache = new Map<string, VerificationMatrix>()

  constructor(options?: VerificationMatrixOptions) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  async addEntry(
    taskId: string,
    check: string,
    options?: {
      status?: VerificationStatus
      evidenceRef?: string
      notes?: string
      riskLevel?: 'low' | 'medium' | 'high' | 'critical'
    },
  ): Promise<VerificationEntry> {
    const matrix = await this.getOrCreate(taskId)

    const entry: VerificationEntry = {
      check,
      status: options?.status ?? 'unverified' as VerificationStatus,
      evidenceRef: options?.evidenceRef,
      notes: options?.notes,
      riskLevel: options?.riskLevel,
    }

    matrix.entries.push(entry)
    matrix.updatedAt = new Date().toISOString()
    await this.persist(taskId, matrix)
    return entry
  }

  async updateStatus(
    taskId: string,
    check: string,
    status: VerificationStatus,
    options?: {
      evidenceRef?: string
      notes?: string
    },
  ): Promise<VerificationEntry | undefined> {
    const matrix = await this.getOrCreate(taskId)
    const entry = matrix.entries.find((e) => e.check === check)
    if (!entry) return undefined

    entry.status = status
    if (options?.evidenceRef) entry.evidenceRef = options.evidenceRef
    if (options?.notes) entry.notes = options.notes

    matrix.updatedAt = new Date().toISOString()
    await this.persist(taskId, matrix)
    return entry
  }

  async getMatrix(taskId: string): Promise<VerificationMatrix | undefined> {
    if (this.cache.has(taskId)) return this.cache.get(taskId)
    return this.load(taskId)
  }

  async getEntries(taskId: string): Promise<VerificationEntry[]> {
    const matrix = await this.getMatrix(taskId)
    return matrix?.entries ?? []
  }

  async getNeedsReview(taskId: string): Promise<VerificationEntry[]> {
    const entries = await this.getEntries(taskId)
    return entries.filter((e) => e.status === 'needs_human_review')
  }

  async getSummary(taskId: string): Promise<Record<VerificationStatus, number>> {
    const entries = await this.getEntries(taskId)
    const summary: Record<string, number> = {
      passed: 0,
      failed: 0,
      skipped: 0,
      not_applicable: 0,
      blocked: 0,
      needs_human_review: 0,
      unverified: 0,
    }
    for (const entry of entries) {
      const key = entry.status as string
      if (key in summary) summary[key]!++
    }
    return summary as Record<VerificationStatus, number>
  }

  async isFullyPassed(taskId: string): Promise<boolean> {
    const entries = await this.getEntries(taskId)
    if (entries.length === 0) return false
    return entries.every((e) => e.status === 'passed' || e.status === 'not_applicable' || e.status === 'skipped')
  }

  async getBlockers(taskId: string): Promise<VerificationEntry[]> {
    const entries = await this.getEntries(taskId)
    return entries.filter((e) => e.status === 'failed' || e.status === 'blocked')
  }

  private async getOrCreate(taskId: string): Promise<VerificationMatrix> {
    const existing = await this.getMatrix(taskId)
    if (existing) return existing

    const matrix: VerificationMatrix = {
      entries: [],
      taskId,
      updatedAt: new Date().toISOString(),
    }
    this.cache.set(taskId, matrix)
    return matrix
  }

  private matrixPath(taskId: string): string {
    return join(this.stateDir, 'verification', `${taskId}.json`)
  }

  private async persist(taskId: string, matrix: VerificationMatrix): Promise<void> {
    const filePath = this.matrixPath(taskId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(matrix, null, 2), 'utf-8')
  }

  private async load(taskId: string): Promise<VerificationMatrix | undefined> {
    try {
      const filePath = this.matrixPath(taskId)
      const content = await readFile(filePath, 'utf-8')
      const matrix = JSON.parse(content) as VerificationMatrix
      this.cache.set(taskId, matrix)
      return matrix
    } catch {
      return undefined
    }
  }
}
