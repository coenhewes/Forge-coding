/**
 * Typed repository for `decisions`.
 *
 * Records architectural / product / migration / security-sensitive
 * choices Forge has made, along with the rationale and the rejected
 * alternatives. Used by the resume path to reconstruct reasoning
 * after a context reset and by reviewers to understand why a change
 * was made.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface DecisionRow {
  id: string
  taskId: string
  decision: string
  rationale: string
  alternativesRejected: string[]
  verificationRequired: string[]
  decidedBy: string
  payload: Record<string, unknown>
  createdAt: string
}

export type DecisionInsert = Omit<DecisionRow, 'createdAt'>

interface RawDecision {
  id: string
  task_id: string
  decision: string
  rationale: string
  alternatives_rejected: string[]
  verification_required: string[]
  decided_by: string
  payload: Record<string, unknown>
  created_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function mapRow(row: RawDecision): DecisionRow {
  return {
    id: row.id,
    taskId: row.task_id,
    decision: row.decision,
    rationale: row.rationale,
    alternativesRejected: row.alternatives_rejected ?? [],
    verificationRequired: row.verification_required ?? [],
    decidedBy: row.decided_by,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
  }
}

export class DecisionRepo {
  constructor(private sql: Db) {}

  async insert(input: DecisionInsert): Promise<DecisionRow> {
    const rows = await this.sql<RawDecision[]>`
      insert into decisions (
        id, task_id, decision, rationale,
        alternatives_rejected, verification_required, decided_by, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.decision},
        ${input.rationale},
        ${jsonArrayParam(this.sql, input.alternativesRejected)}::jsonb,
        ${jsonArrayParam(this.sql, input.verificationRequired)}::jsonb,
        ${input.decidedBy},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, decision, rationale, alternatives_rejected, verification_required, decided_by, payload, created_at
    `
    return mapRow(rows[0]!)
  }

  async get(id: string): Promise<DecisionRow | undefined> {
    const rows = await this.sql<RawDecision[]>`
      select id, task_id, decision, rationale, alternatives_rejected, verification_required, decided_by, payload, created_at
      from decisions where id = ${id}
    `
    return rows[0] ? mapRow(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<DecisionRow[]> {
    const rows = await this.sql<RawDecision[]>`
      select id, task_id, decision, rationale, alternatives_rejected, verification_required, decided_by, payload, created_at
      from decisions where task_id = ${taskId} order by created_at asc
    `
    return rows.map(mapRow)
  }

  async listRecent(taskId: string, limit: number): Promise<DecisionRow[]> {
    const rows = await this.sql<RawDecision[]>`
      select id, task_id, decision, rationale, alternatives_rejected, verification_required, decided_by, payload, created_at
      from decisions where task_id = ${taskId}
      order by created_at desc
      limit ${limit}
    `
    return rows.map(mapRow)
  }
}
