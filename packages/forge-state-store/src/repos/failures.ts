/**
 * Typed repository for `failures`.
 *
 * Each row is one failed attempt — hypothesis, patch, command, test —
 * with a free-form `lesson` field that the failure-reflection system
 * surfaces before repeating similar work.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface FailureRow {
  id: string
  taskId: string
  hypothesisId: string | null
  failureType: string
  summary: string
  lesson: string | null
  artifactId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export type FailureInsert = Omit<FailureRow, 'createdAt'>

interface RawFailure {
  id: string
  task_id: string
  hypothesis_id: string | null
  failure_type: string
  summary: string
  lesson: string | null
  artifact_id: string | null
  payload: Record<string, unknown>
  created_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function mapRow(row: RawFailure): FailureRow {
  return {
    id: row.id,
    taskId: row.task_id,
    hypothesisId: row.hypothesis_id,
    failureType: row.failure_type,
    summary: row.summary,
    lesson: row.lesson,
    artifactId: row.artifact_id,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
  }
}

export class FailureRepo {
  constructor(private sql: Db) {}

  async insert(input: FailureInsert): Promise<FailureRow> {
    const rows = await this.sql<RawFailure[]>`
      insert into failures (
        id, task_id, hypothesis_id, failure_type, summary, lesson, artifact_id, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.hypothesisId},
        ${input.failureType},
        ${input.summary},
        ${input.lesson},
        ${input.artifactId},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, hypothesis_id, failure_type, summary, lesson, artifact_id, payload, created_at
    `
    return mapRow(rows[0]!)
  }

  async get(id: string): Promise<FailureRow | undefined> {
    const rows = await this.sql<RawFailure[]>`
      select id, task_id, hypothesis_id, failure_type, summary, lesson, artifact_id, payload, created_at
      from failures where id = ${id}
    `
    return rows[0] ? mapRow(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<FailureRow[]> {
    const rows = await this.sql<RawFailure[]>`
      select id, task_id, hypothesis_id, failure_type, summary, lesson, artifact_id, payload, created_at
      from failures where task_id = ${taskId} order by created_at desc
    `
    return rows.map(mapRow)
  }

  async listByHypothesis(hypothesisId: string): Promise<FailureRow[]> {
    const rows = await this.sql<RawFailure[]>`
      select id, task_id, hypothesis_id, failure_type, summary, lesson, artifact_id, payload, created_at
      from failures where hypothesis_id = ${hypothesisId} order by created_at desc
    `
    return rows.map(mapRow)
  }

  async searchBySummary(taskId: string, like: string): Promise<FailureRow[]> {
    const rows = await this.sql<RawFailure[]>`
      select id, task_id, hypothesis_id, failure_type, summary, lesson, artifact_id, payload, created_at
      from failures
      where task_id = ${taskId} and summary ilike ${'%' + like + '%'}
      order by created_at desc
    `
    return rows.map(mapRow)
  }
}
