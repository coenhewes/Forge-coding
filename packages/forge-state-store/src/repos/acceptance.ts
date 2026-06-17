/**
 * Typed repository for `acceptance_criteria`.
 *
 * Each row is one criterion extracted from the user's task. Forge's
 * completion gate requires every criterion to reach `status = 'verified'`
 * before claiming the task done.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface AcceptanceCriterionRow {
  id: string
  taskId: string
  text: string
  status: string
  riskLevel: string | null
  requiresHumanReview: boolean
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type AcceptanceCriterionInsert = Omit<AcceptanceCriterionRow, 'createdAt' | 'updatedAt'>
export type AcceptanceCriterionUpdate = Partial<
  Omit<AcceptanceCriterionInsert, 'id' | 'taskId'>
>

interface RawAcceptanceCriterion {
  id: string
  task_id: string
  text: string
  status: string
  risk_level: string | null
  requires_human_review: boolean
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function mapRow(row: RawAcceptanceCriterion): AcceptanceCriterionRow {
  return {
    id: row.id,
    taskId: row.task_id,
    text: row.text,
    status: row.status,
    riskLevel: row.risk_level,
    requiresHumanReview: row.requires_human_review,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

export class AcceptanceRepo {
  constructor(private sql: Db) {}

  async insert(input: AcceptanceCriterionInsert): Promise<AcceptanceCriterionRow> {
    const rows = await this.sql<RawAcceptanceCriterion[]>`
      insert into acceptance_criteria (
        id, task_id, text, status, risk_level, requires_human_review, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.text},
        ${input.status},
        ${input.riskLevel},
        ${input.requiresHumanReview},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, text, status, risk_level, requires_human_review, payload, created_at, updated_at
    `
    return mapRow(rows[0]!)
  }

  async update(id: string, patch: AcceptanceCriterionUpdate): Promise<AcceptanceCriterionRow> {
    const rows = await this.sql<RawAcceptanceCriterion[]>`
      update acceptance_criteria
      set
        text = coalesce(${patch.text ?? null}, text),
        status = coalesce(${patch.status ?? null}, status),
        risk_level = coalesce(${patch.riskLevel ?? null}, risk_level),
        requires_human_review = coalesce(${patch.requiresHumanReview ?? null}, requires_human_review),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, task_id, text, status, risk_level, requires_human_review, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`AcceptanceCriterion not found: ${id}`)
    return mapRow(rows[0]!)
  }

  async get(id: string): Promise<AcceptanceCriterionRow | undefined> {
    const rows = await this.sql<RawAcceptanceCriterion[]>`
      select id, task_id, text, status, risk_level, requires_human_review, payload, created_at, updated_at
      from acceptance_criteria where id = ${id}
    `
    return rows[0] ? mapRow(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<AcceptanceCriterionRow[]> {
    const rows = await this.sql<RawAcceptanceCriterion[]>`
      select id, task_id, text, status, risk_level, requires_human_review, payload, created_at, updated_at
      from acceptance_criteria where task_id = ${taskId} order by created_at asc
    `
    return rows.map(mapRow)
  }

  async countByStatus(taskId: string, status: string): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count
      from acceptance_criteria where task_id = ${taskId} and status = ${status}
    `
    return rows[0]?.count ?? 0
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from acceptance_criteria where id = ${id} returning id
    `
    return rows.length > 0
  }
}
