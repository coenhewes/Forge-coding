/**
 * Typed repository for `trace_events`.
 *
 * The trace is Forge's flight recorder. Every important state write
 * must emit a trace event in the same transaction as the write — see
 * `ForgeStateStore.tx` and `tx.trace(event)` for the co-transactional
 * guarantee.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface TraceEventRow {
  id: string
  taskId: string | null
  repoId: string | null
  eventType: string
  actor: string
  summary: string
  payload: Record<string, unknown>
  createdAt: string
}

export type TraceEventInsert = Omit<TraceEventRow, 'createdAt'>

interface RawTraceEvent {
  id: string
  task_id: string | null
  repo_id: string | null
  event_type: string
  actor: string
  summary: string
  payload: Record<string, unknown>
  created_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function mapRow(row: RawTraceEvent): TraceEventRow {
  return {
    id: row.id,
    taskId: row.task_id,
    repoId: row.repo_id,
    eventType: row.event_type,
    actor: row.actor,
    summary: row.summary,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
  }
}

export class TraceEventRepo {
  constructor(private sql: Db) {}

  async insert(input: TraceEventInsert): Promise<TraceEventRow> {
    const rows = await this.sql<RawTraceEvent[]>`
      insert into trace_events (
        id, task_id, repo_id, event_type, actor, summary, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.repoId},
        ${input.eventType},
        ${input.actor},
        ${input.summary},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, repo_id, event_type, actor, summary, payload, created_at
    `
    return mapRow(rows[0]!)
  }

  async get(id: string): Promise<TraceEventRow | undefined> {
    const rows = await this.sql<RawTraceEvent[]>`
      select id, task_id, repo_id, event_type, actor, summary, payload, created_at
      from trace_events where id = ${id}
    `
    return rows[0] ? mapRow(rows[0]) : undefined
  }

  async listByTask(taskId: string, limit?: number): Promise<TraceEventRow[]> {
    const rows = limit
      ? await this.sql<RawTraceEvent[]>`
          select id, task_id, repo_id, event_type, actor, summary, payload, created_at
          from trace_events
          where task_id = ${taskId}
          order by created_at desc
          limit ${limit}
        `
      : await this.sql<RawTraceEvent[]>`
          select id, task_id, repo_id, event_type, actor, summary, payload, created_at
          from trace_events
          where task_id = ${taskId}
          order by created_at desc
        `
    return rows.map(mapRow)
  }

  async listRecentByType(eventType: string, limit: number): Promise<TraceEventRow[]> {
    const rows = await this.sql<RawTraceEvent[]>`
      select id, task_id, repo_id, event_type, actor, summary, payload, created_at
      from trace_events
      where event_type = ${eventType}
      order by created_at desc
      limit ${limit}
    `
    return rows.map(mapRow)
  }

  /**
   * Trace helper used by the `ForgeStateStore.tx(...)` wrapper. The
   * caller does not need to provide an id — we generate one here so the
   * shape stays consistent with other write helpers.
   */
  async append(event: TraceEventInsert): Promise<TraceEventRow> {
    return this.insert(event)
  }

  async countByTask(taskId: string): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(*)::int as count from trace_events where task_id = ${taskId}
    `
    return rows[0]?.count ?? 0
  }
}
