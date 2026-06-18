/**
 * Typed repository for `sessions` and `prompts`.
 *
 * Sessions are the durable execution envelope for a task run. Prompts are the
 * admitted model-visible inputs/outputs that let Forge reconstruct hot context
 * after a process restart without treating chat history as the source of truth.
 */
import { jsonParam, type Db } from './base.js'

export interface SessionRow {
  id: string
  taskId: string
  repoId: string
  status: string
  modelProvider: string | null
  modelName: string | null
  mode: string | null
  currentStage: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface PromptRow {
  id: string
  sessionId: string
  taskId: string
  promptType: string
  role: string
  content: string
  status: string
  payload: Record<string, unknown>
  createdAt: string
  promotedAt: string | null
}

export type SessionInsert = Omit<SessionRow, 'createdAt' | 'updatedAt'>
export type SessionUpdate = Partial<Omit<SessionInsert, 'id' | 'taskId' | 'repoId'>>
export type PromptInsert = Omit<PromptRow, 'createdAt' | 'promotedAt'>
export type PromptUpdate = Partial<Pick<PromptRow, 'status' | 'payload' | 'promotedAt'>>

interface RawSession {
  id: string
  task_id: string
  repo_id: string
  status: string
  model_provider: string | null
  model_name: string | null
  mode: string | null
  current_stage: string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

interface RawPrompt {
  id: string
  session_id: string
  task_id: string
  prompt_type: string
  role: string
  content: string
  status: string
  payload: Record<string, unknown>
  created_at: Date | string
  promoted_at: Date | string | null
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : value
}

function mapSession(row: RawSession): SessionRow {
  return {
    id: row.id,
    taskId: row.task_id,
    repoId: row.repo_id,
    status: row.status,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    mode: row.mode,
    currentStage: row.current_stage,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  }
}

function mapPrompt(row: RawPrompt): PromptRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    promptType: row.prompt_type,
    role: row.role,
    content: row.content,
    status: row.status,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at)!,
    promotedAt: toIso(row.promoted_at),
  }
}

export class SessionRepo {
  constructor(private sql: Db) {}

  async insert(input: SessionInsert): Promise<SessionRow> {
    const rows = await this.sql<RawSession[]>`
      insert into sessions (
        id, task_id, repo_id, status, model_provider, model_name,
        mode, current_stage, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.repoId},
        ${input.status},
        ${input.modelProvider},
        ${input.modelName},
        ${input.mode},
        ${input.currentStage},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, repo_id, status, model_provider, model_name, mode, current_stage, payload, created_at, updated_at
    `
    return mapSession(rows[0]!)
  }

  async update(id: string, patch: SessionUpdate): Promise<SessionRow> {
    const rows = await this.sql<RawSession[]>`
      update sessions
      set
        status = coalesce(${patch.status ?? null}, status),
        model_provider = coalesce(${patch.modelProvider ?? null}, model_provider),
        model_name = coalesce(${patch.modelName ?? null}, model_name),
        mode = coalesce(${patch.mode ?? null}, mode),
        current_stage = coalesce(${patch.currentStage ?? null}, current_stage),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, task_id, repo_id, status, model_provider, model_name, mode, current_stage, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`Session not found: ${id}`)
    return mapSession(rows[0]!)
  }

  async get(id: string): Promise<SessionRow | undefined> {
    const rows = await this.sql<RawSession[]>`
      select id, task_id, repo_id, status, model_provider, model_name, mode, current_stage, payload, created_at, updated_at
      from sessions where id = ${id}
    `
    return rows[0] ? mapSession(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<SessionRow[]> {
    const rows = await this.sql<RawSession[]>`
      select id, task_id, repo_id, status, model_provider, model_name, mode, current_stage, payload, created_at, updated_at
      from sessions where task_id = ${taskId} order by created_at asc
    `
    return rows.map(mapSession)
  }

  async listActiveByTask(taskId: string): Promise<SessionRow[]> {
    const rows = await this.sql<RawSession[]>`
      select id, task_id, repo_id, status, model_provider, model_name, mode, current_stage, payload, created_at, updated_at
      from sessions
      where task_id = ${taskId} and status in ('running', 'queued', 'blocked', 'interrupted')
      order by created_at asc
    `
    return rows.map(mapSession)
  }
}

export class PromptRepo {
  constructor(private sql: Db) {}

  async insert(input: PromptInsert): Promise<PromptRow> {
    const rows = await this.sql<RawPrompt[]>`
      insert into prompts (
        id, session_id, task_id, prompt_type, role, content, status, payload
      )
      values (
        ${input.id},
        ${input.sessionId},
        ${input.taskId},
        ${input.promptType},
        ${input.role},
        ${input.content},
        ${input.status},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, session_id, task_id, prompt_type, role, content, status, payload, created_at, promoted_at
    `
    return mapPrompt(rows[0]!)
  }

  async update(id: string, patch: PromptUpdate): Promise<PromptRow> {
    const rows = await this.sql<RawPrompt[]>`
      update prompts
      set
        status = coalesce(${patch.status ?? null}, status),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        promoted_at = coalesce(${patch.promotedAt ?? null}, promoted_at)
      where id = ${id}
      returning id, session_id, task_id, prompt_type, role, content, status, payload, created_at, promoted_at
    `
    if (!rows.length) throw new Error(`Prompt not found: ${id}`)
    return mapPrompt(rows[0]!)
  }

  async get(id: string): Promise<PromptRow | undefined> {
    const rows = await this.sql<RawPrompt[]>`
      select id, session_id, task_id, prompt_type, role, content, status, payload, created_at, promoted_at
      from prompts where id = ${id}
    `
    return rows[0] ? mapPrompt(rows[0]) : undefined
  }

  async listBySession(sessionId: string): Promise<PromptRow[]> {
    const rows = await this.sql<RawPrompt[]>`
      select id, session_id, task_id, prompt_type, role, content, status, payload, created_at, promoted_at
      from prompts where session_id = ${sessionId} order by created_at asc
    `
    return rows.map(mapPrompt)
  }

  async listByTask(taskId: string): Promise<PromptRow[]> {
    const rows = await this.sql<RawPrompt[]>`
      select id, session_id, task_id, prompt_type, role, content, status, payload, created_at, promoted_at
      from prompts where task_id = ${taskId} order by created_at asc
    `
    return rows.map(mapPrompt)
  }
}
