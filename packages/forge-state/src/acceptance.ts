import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type {
  AcceptanceContract,
  AcceptanceCriterion,
  CriterionStatus,
} from '@forge/types'

export interface ContractEngineOptions {
  stateDir?: string
}

/**
 * One concise, *verifiable* criterion per high-signal domain. Acceptance
 * criteria gate completion, so each must be something the agent can actually
 * confirm with evidence — not aspirational boilerplate.
 */
const DOMAIN_CRITERION: Record<string, string> = {
  auth: 'Authorization checks protect the affected routes',
  backend: 'Affected API endpoints return correct status codes and validate input',
  database: 'Migrations apply cleanly and preserve data integrity',
  frontend: 'Affected UI renders and handles its key states',
  tests: 'The project test suite passes',
}

export class AcceptanceContractEngine {
  private contracts = new Map<string, AcceptanceContract>()
  private stateDir: string

  constructor(private options?: ContractEngineOptions) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  async createContract(
    taskId: string,
    description: string,
    criteria: AcceptanceCriterion[],
  ): Promise<AcceptanceContract> {
    const now = new Date().toISOString()
    const contract: AcceptanceContract = {
      taskId,
      description,
      criteria,
      createdAt: now,
      updatedAt: now,
    }
    this.contracts.set(taskId, contract)
    await this.persist(contract)
    return contract
  }

  async generateContract(
    taskId: string,
    description: string,
    domains?: string[],
  ): Promise<AcceptanceContract> {
    const criteria = this.synthesizeCriteria(description, domains)
    return this.createContract(taskId, description, criteria)
  }

  async getContract(taskId: string): Promise<AcceptanceContract | undefined> {
    if (this.contracts.has(taskId)) return this.contracts.get(taskId)
    return this.load(taskId)
  }

  async updateCriterionStatus(
    taskId: string,
    criterionId: string,
    status: CriterionStatus,
    evidenceRef?: string,
  ): Promise<AcceptanceContract> {
    const contract = await this.getContract(taskId)
    if (!contract) throw new Error(`Contract not found for task ${taskId}`)

    const updatedCriteria = contract.criteria.map((c) => {
      if (c.id !== criterionId) return c
      const refs = evidenceRef
        ? [...c.evidenceRefs.filter((r) => r !== evidenceRef), evidenceRef]
        : c.evidenceRefs
      return { ...c, status, evidenceRefs: refs }
    })

    const updated: AcceptanceContract = {
      ...contract,
      criteria: updatedCriteria,
      updatedAt: new Date().toISOString(),
    }

    this.contracts.set(taskId, updated)
    await this.persist(updated)
    return updated
  }

  async addCriterion(
    taskId: string,
    criterion: AcceptanceCriterion,
  ): Promise<AcceptanceContract> {
    const contract = await this.getContract(taskId)
    if (!contract) throw new Error(`Contract not found for task ${taskId}`)

    const updated: AcceptanceContract = {
      ...contract,
      criteria: [...contract.criteria, criterion],
      updatedAt: new Date().toISOString(),
    }

    this.contracts.set(taskId, updated)
    await this.persist(updated)
    return updated
  }

  async getCompletionStatus(taskId: string): Promise<{
    total: number
    verified: number
    failed: number
    needsReview: number
    blocked: number
    skipped: number
    percentComplete: number
    allVerified: boolean
  }> {
    const contract = await this.getContract(taskId)
    if (!contract) {
      return { total: 0, verified: 0, failed: 0, needsReview: 0, blocked: 0, skipped: 0, percentComplete: 0, allVerified: false }
    }

    const criteria = contract.criteria
    const total = criteria.length
    const verified = criteria.filter((c) => c.status === 'verified').length
    const failed = criteria.filter((c) => c.status === 'failed').length
    const needsReview = criteria.filter((c) => c.status === 'needs_review').length
    const blocked = criteria.filter((c) => c.status === 'blocked').length
    const skipped = criteria.filter((c) => c.status === 'skipped').length
    const percentComplete = total > 0 ? Math.round((verified / total) * 100) : 0

    return {
      total,
      verified,
      failed,
      needsReview,
      blocked,
      skipped,
      percentComplete,
      // Completion-ready when every criterion is RESOLVED: either verified, or
      // legitimately marked `skipped` (not applicable to this task — e.g. a
      // database criterion on a pure logic fix). A `skipped` criterion is done,
      // not pending, so it must not block completion forever. `failed`,
      // `blocked`, and `needs_review` still block (they need attention).
      allVerified: total > 0 && verified + skipped === total,
    }
  }

  private contractPath(taskId: string): string {
    return join(this.stateDir, 'verification', `acceptance-${taskId}.json`)
  }

  private async persist(contract: AcceptanceContract): Promise<void> {
    const filePath = this.contractPath(contract.taskId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(contract, null, 2), 'utf-8')
  }

  private async load(taskId: string): Promise<AcceptanceContract | undefined> {
    try {
      const content = await readFile(this.contractPath(taskId), 'utf-8')
      const contract = JSON.parse(content) as AcceptanceContract
      this.contracts.set(taskId, contract)
      return contract
    } catch {
      return undefined
    }
  }

  private synthesizeCriteria(
    description: string,
    domains?: string[],
  ): AcceptanceCriterion[] {
    const criteria: AcceptanceCriterion[] = []

    // Ground the criteria in the actual task. The caller's domain selection
    // can be over-broad (e.g. routing a string utility to "frontend"), which
    // would add unverifiable criteria that can never be satisfied. So we only
    // keep domains that are also reflected in the task text.
    const inferred = this.inferDomains(description)
    const requested = domains ?? inferred
    const grounded = requested.filter((d) => inferred.includes(d))
    const effective = grounded.length > 0 ? grounded : inferred

    // 1) A concrete, task-derived primary criterion.
    const firstLine = (description.split('\n').find((l) => l.trim()) ?? description).trim()
    const summary = firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine
    const primaryRisk = effective.includes('auth') ? 'security' : effective[0]
    criteria.push({
      id: 'task-1',
      description: `Implementation satisfies the task: ${summary}`,
      status: 'needs_review',
      evidenceRefs: [],
      riskArea: primaryRisk,
    })

    // 2) If the task involves tests, require the suite to pass.
    if (/\b(test|tests|spec|e2e|suite|passes|passing)\b/i.test(description)
      && !effective.includes('tests')) {
      effective.push('tests')
    }

    // 3) One targeted, verifiable criterion per relevant domain.
    for (const domain of effective) {
      const text = DOMAIN_CRITERION[domain]
      if (!text || criteria.some((c) => c.description === text)) continue
      criteria.push({
        id: `${domain}-1`,
        description: text,
        status: 'needs_review',
        evidenceRefs: [],
        riskArea: domain === 'auth' ? 'security' : domain,
        requiredChecks: domain === 'tests' ? ['test'] : undefined,
      })
    }

    return criteria
  }

  private inferDomains(description: string): string[] {
    const domains: string[] = []
    const lower = description.toLowerCase()

    if (/\b(auth|login|register|permission|role|invite|session)\b/i.test(lower)) {
      domains.push('auth')
    }
    if (/\b(api|endpoint|route|backend)\b/i.test(lower)) {
      domains.push('backend')
    }
    if (/\b(db|database|migration|schema|table|prisma)\b/i.test(lower)) {
      domains.push('database')
    }
    if (/\b(ui|component|page|form|button|frontend|modal)\b/i.test(lower)) {
      domains.push('frontend')
    }
    if (/\b(test|e2e|spec)\b/i.test(lower)) {
      domains.push('tests')
    }

    if (domains.length === 0) domains.push('backend')
    return domains
  }
}
