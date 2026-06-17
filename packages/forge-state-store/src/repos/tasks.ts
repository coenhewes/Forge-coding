/**
 * Typed repository for `tasks` and `task_snapshots`.
 *
 * A task is the unit of long-horizon engineering work in Forge. The
 * `task_snapshots` table stores point-in-time summaries that the
 * resume path uses to rebuild hot context after a model reset.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface TaskRow {
  id: string
  repoId: string
  title: string
  originalRequest: string
  interpretedGoal: string | null
  status: string
  mode: string
  activeBranch: string | null
  activePatchCandidateId: string | null
  currentSummary: string | null
  nextAction: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface TaskSnapshotRow {
  id: string
  taskId: string
  snapshotType: string
  summary: string
  payload: Record<string, unknown>
  createdAt: string
}

export type TaskInsert = Omit<TaskRow, 'createdAt' | 'updatedAt'>
export type TaskUpdate = Partial<Omit<TaskInsert, 'id' | 'repoId'>>

export type TaskSnapshotInsert = Omit<TaskSnapshotRow, 'createdAt'>

interface RawTask {
  id: string
  repo_id: string
  title: string
  original_request: string
  interpreted_goal: string | null
  status: string
  mode: string
  active_branch: string | null
  active_patch_candidate_id: string | null
  current_summary: string | null
  next_action: string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

interface RawTaskSnapshot {
  id: string
  task_id: string
  snapshot_type: string
  summary: string
  payload: Record<string, unknown>
  created_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function mapTask(row: RawTask): TaskRow {
  return {
    id: row.id,
    repoId: row.repo_id,
    title: row.title,
    originalRequest: row.original_request,
    interpretedGoal: row.interpreted_goal,
    status: row.status,
    mode: row.mode,
    activeBranch: row.active_branch,
    activePatchCandidateId: row.active_patch_candidate_id,
    currentSummary: row.current_summary,
    nextAction: row.next_action,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapSnapshot(row: RawTaskSnapshot): TaskSnapshotRow {
  return {
    id: row.id,
    taskId: row.task_id,
    snapshotType: row.snapshot_type,
    summary: row.summary,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
  }
}

export class TaskRepo {
  constructor(private sql: Db) {}

  async insert(input: TaskInsert): Promise<TaskRow> {
    const rows = await this.sql<RawTask[]>`
      insert into tasks (
        id, repo_id, title, original_request, interpreted_goal,
        status, mode, active_branch, active_patch_candidate_id,
        current_summary, next_action, payload
      )
      values (
        ${input.id},
        ${input.repoId},
        ${input.title},
        ${input.originalRequest},
        ${input.interpretedGoal},
        ${input.status},
        ${input.mode},
        ${input.activeBranch},
        ${input.activePatchCandidateId},
        ${input.currentSummary},
        ${input.nextAction},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning *
    `
    return mapTask(rows[0]!)
  }

  async update(id: string, patch: TaskUpdate): Promise<TaskRow> {
    const rows = await this.sql<RawTask[]>`
      update tasks
      set
        title = coalesce(${patch.title ?? null}, title),
        original_request = coalesce(${patch.originalRequest ?? null}, original_request),
        interpreted_goal = coalesce(${patch.interpretedGoal ?? null}, interpreted_goal),
        status = coalesce(${patch.status ?? null}, status),
        mode = coalesce(${patch.mode ?? null}, mode),
        active_branch = coalesce(${patch.activeBranch ?? null}, active_branch),
        active_patch_candidate_id = coalesce(${patch.activePatchCandidateId ?? null}, active_patch_candidate_id),
        current_summary = coalesce(${patch.currentSummary ?? null}, current_summary),
        next_action = coalesce(${patch.nextAction ?? null}, next_action),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning *
    `
    if (!rows.length) throw new Error(`Task not found: ${id}`)
    return mapTask(rows[0]!)
  }

  async get(id: string): Promise<TaskRow | undefined> {
    const rows = await this.sql<RawTask[]>`
      select * from tasks where id = ${id}
    `
    return rows[0] ? mapTask(rows[0]) : undefined
  }

  async listByRepo(repoId: string): Promise<TaskRow[]> {
    const rows = await this.sql<RawTask[]>`
      select * from tasks where repo_id = ${repoId} order by created_at asc
    `
    return rows.map(mapTask)
  }

  async listByStatus(repoId: string, status: string): Promise<TaskRow[]> {
    const rows = await this.sql<RawTask[]>`
      select * from tasks
      where repo_id = ${repoId} and status = ${status}
      order by created_at asc
    `
    return rows.map(mapTask)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from tasks where id = ${id} returning id
    `
    return rows.length > 0
  }
}

export class TaskSnapshotRepo {
  constructor(private sql: Db) {}

  async insert(input: TaskSnapshotInsert): Promise<TaskSnapshotRow> {
    const rows = await this.sql<RawTaskSnapshot[]>`
      insert into task_snapshots (id, task_id, snapshot_type, summary, payload)
      values (
        ${input.id},
        ${input.taskId},
        ${input.snapshotType},
        ${input.summary},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, snapshot_type, summary, payload, created_at
    `
    return mapSnapshot(rows[0]!)
  }

  async listByTask(taskId: string, limit?: number): Promise<TaskSnapshotRow[]> {
    const rows = limit
      ? await this.sql<RawTaskSnapshot[]>`
          select id, task_id, snapshot_type, summary, payload, created_at
          from task_snapshots
          where task_id = ${taskId}
          order by created_at desc
          limit ${limit}
        `
      : await this.sql<RawTaskSnapshot[]>`
          select id, task_id, snapshot_type, summary, payload, created_at
          from task_snapshots
          where task_id = ${taskId}
          order by created_at desc
        `
    return rows.map(mapSnapshot)
  }

  async latest(taskId: string): Promise<TaskSnapshotRow | undefined> {
    const rows = await this.sql<RawTaskSnapshot[]>`
      select id, task_id, snapshot_type, summary, payload, created_at
      from task_snapshots
      where task_id = ${taskId}
      order by created_at desc
      limit 1
    `
    return rows[0] ? mapSnapshot(rows[0]) : undefined
  }
}
