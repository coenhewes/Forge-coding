/**
 * Typed repository for `verification_checks`.
 *
 * A verification check records one concrete validation step Forge has
 * run for a task (e.g. `npm test`, `tsc --noEmit`, an API integration
 * test). Each check can link to the acceptance criterion and claim it
 * supports, plus the evidence (test output, screenshot, etc.) it
 * produced. The check's `status` is the source of truth for whether
 * the underlying code change is verified.
 *
 * Track 3 (active verification) will add typed access to
 * `verification_actions`, `verification_action_claim_links`,
 * `verification_action_scores`, and `verification_history`. The tables
 * already exist in the migration; the typed repositories for them are
 * stubbed here so the facade surface compiles — they return `[]`
 * and throw on write. Track 3 replaces these stubs with real methods.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface VerificationCheckRow {
  id: string
  taskId: string
  acceptanceCriterionId: string | null
  claimId: string | null
  checkType: string
  command: string | null
  status: string
  evidenceId: string | null
  riskLevel: string | null
  reason: string | null
  staleReason: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type VerificationCheckInsert = Omit<VerificationCheckRow, 'createdAt' | 'updatedAt'>
export type VerificationCheckUpdate = Partial<
  Omit<VerificationCheckInsert, 'id' | 'taskId'>
>

interface RawVerificationCheck {
  id: string
  task_id: string
  acceptance_criterion_id: string | null
  claim_id: string | null
  check_type: string
  command: string | null
  status: string
  evidence_id: string | null
  risk_level: string | null
  reason: string | null
  stale_reason: string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function mapRow(row: RawVerificationCheck): VerificationCheckRow {
  return {
    id: row.id,
    taskId: row.task_id,
    acceptanceCriterionId: row.acceptance_criterion_id,
    claimId: row.claim_id,
    checkType: row.check_type,
    command: row.command,
    status: row.status,
    evidenceId: row.evidence_id,
    riskLevel: row.risk_level,
    reason: row.reason,
    staleReason: row.stale_reason,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

export class VerificationCheckRepo {
  constructor(private sql: Db) {}

  async insert(input: VerificationCheckInsert): Promise<VerificationCheckRow> {
    const rows = await this.sql<RawVerificationCheck[]>`
      insert into verification_checks (
        id, task_id, acceptance_criterion_id, claim_id, check_type, command,
        status, evidence_id, risk_level, reason, stale_reason, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.acceptanceCriterionId},
        ${input.claimId},
        ${input.checkType},
        ${input.command},
        ${input.status},
        ${input.evidenceId},
        ${input.riskLevel},
        ${input.reason},
        ${input.staleReason},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, acceptance_criterion_id, claim_id, check_type, command, status, evidence_id, risk_level, reason, stale_reason, payload, created_at, updated_at
    `
    return mapRow(rows[0]!)
  }

  async update(id: string, patch: VerificationCheckUpdate): Promise<VerificationCheckRow> {
    const rows = await this.sql<RawVerificationCheck[]>`
      update verification_checks
      set
        acceptance_criterion_id = coalesce(${patch.acceptanceCriterionId ?? null}, acceptance_criterion_id),
        claim_id = coalesce(${patch.claimId ?? null}, claim_id),
        check_type = coalesce(${patch.checkType ?? null}, check_type),
        command = coalesce(${patch.command ?? null}, command),
        status = coalesce(${patch.status ?? null}, status),
        evidence_id = coalesce(${patch.evidenceId ?? null}, evidence_id),
        risk_level = coalesce(${patch.riskLevel ?? null}, risk_level),
        reason = coalesce(${patch.reason ?? null}, reason),
        stale_reason = coalesce(${patch.staleReason ?? null}, stale_reason),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, task_id, acceptance_criterion_id, claim_id, check_type, command, status, evidence_id, risk_level, reason, stale_reason, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`VerificationCheck not found: ${id}`)
    return mapRow(rows[0]!)
  }

  async get(id: string): Promise<VerificationCheckRow | undefined> {
    const rows = await this.sql<RawVerificationCheck[]>`
      select id, task_id, acceptance_criterion_id, claim_id, check_type, command, status, evidence_id, risk_level, reason, stale_reason, payload, created_at, updated_at
      from verification_checks where id = ${id}
    `
    return rows[0] ? mapRow(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<VerificationCheckRow[]> {
    const rows = await this.sql<RawVerificationCheck[]>`
      select id, task_id, acceptance_criterion_id, claim_id, check_type, command, status, evidence_id, risk_level, reason, stale_reason, payload, created_at, updated_at
      from verification_checks where task_id = ${taskId} order by created_at asc
    `
    return rows.map(mapRow)
  }

  async listByStatus(taskId: string, status: string): Promise<VerificationCheckRow[]> {
    const rows = await this.sql<RawVerificationCheck[]>`
      select id, task_id, acceptance_criterion_id, claim_id, check_type, command, status, evidence_id, risk_level, reason, stale_reason, payload, created_at, updated_at
      from verification_checks where task_id = ${taskId} and status = ${status}
      order by created_at asc
    `
    return rows.map(mapRow)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from verification_checks where id = ${id} returning id
    `
    return rows.length > 0
  }
}

/**
 * Track 3 placeholder. The `verification_actions` table already exists
 * in the migration; the typed methods below are intentionally a no-op
 * stub for this track and return `[]`. Track 3 will replace them with
 * real CRUD and the scoring / claim-link repositories.
 */
export class VerificationActionRepo {
  constructor(private sql: Db) {}

  /** @stub Returns `[]` — Track 3 will replace with a real SELECT. */
  async listByTask(_taskId: string): Promise<unknown[]> {
    void this.sql
    return []
  }
}

/** @stub — Track 3. */
export class VerificationActionClaimLinkRepo {
  constructor(private sql: Db) {}

  async listByAction(_actionId: string): Promise<unknown[]> {
    void this.sql
    return []
  }
}

/** @stub — Track 3. */
export class VerificationActionScoreRepo {
  constructor(private sql: Db) {}

  async listByAction(_actionId: string): Promise<unknown[]> {
    void this.sql
    return []
  }
}

/** @stub — Track 3. */
export class VerificationHistoryRepo {
  constructor(private sql: Db) {}

  async listByRepo(_repoId: string): Promise<unknown[]> {
    void this.sql
    return []
  }
}
