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

const DEFAULT_CRITERION_TEMPLATES: Record<string, string[]> = {
  auth: [
    'Authentication flow works correctly',
    'Authorization checks are in place for all protected routes',
    'Permission boundaries are respected',
    'Role-based access control functions as expected',
    'Session management is secure',
  ],
  backend: [
    'API endpoints return correct status codes',
    'Error handling covers edge cases',
    'Input validation is applied',
    'Response format matches contract',
  ],
  database: [
    'Migration runs successfully up and down',
    'Schema changes are backward compatible',
    'Data integrity is preserved',
    'No data loss on migration',
  ],
  frontend: [
    'UI renders correctly across viewport sizes',
    'User interactions work as expected',
    'Loading states are handled',
    'Error states are displayed appropriately',
  ],
  tests: [
    'New behavior has corresponding tests',
    'Existing tests still pass',
    'Edge cases are covered',
    'Test quality meets project standards',
  ],
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
      allVerified: total > 0 && verified === total,
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
    const lower = description.toLowerCase()
    const domainsToCheck = domains ?? this.inferDomains(description)

    for (const domain of domainsToCheck) {
      const templates = DEFAULT_CRITERION_TEMPLATES[domain]
      if (!templates) continue
      for (const template of templates) {
        criteria.push({
          id: `${domain}-${criteria.length + 1}`,
          description: template,
          status: 'needs_review',
          evidenceRefs: [],
          riskArea: domain === 'auth' ? 'security' : domain,
        })
      }
    }

    // Add general criteria
    if (criteria.length === 0) {
      criteria.push({
        id: 'general-1',
        description: 'The implementation satisfies the task requirements',
        status: 'needs_review',
        evidenceRefs: [],
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
