/**
 * Typed repository for `probes` and `patch_candidates`.
 *
 * A probe is a planned capability call intended to gather information
 * (e.g. `auth.trace_permission_check`). A patch candidate is a
 * concrete diff proposal — with its hypothesis, diff artifact,
 * verification status, and promotion decision — so the harness can
 * compare attempts and recover from bad directions.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface ProbeRow {
  id: string
  taskId: string
  capability: string
  status: string
  expectedInformationGain: string | null
  cost: string | null
  risk: string | null
  reason: string | null
  input: Record<string, unknown>
  result: Record<string, unknown> | null
  createdAt: string
  completedAt: string | null
}

export interface PatchCandidateRow {
  id: string
  taskId: string
  name: string
  baseCommit: string
  status: string
  hypothesisId: string | null
  diffArtifactId: string | null
  summary: string | null
  verificationStatus: string | null
  promotionDecision: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ProbeInsert = Omit<ProbeRow, 'createdAt' | 'completedAt'>
export type ProbeUpdate = Partial<Pick<ProbeRow, 'status' | 'result' | 'completedAt'>>

export type PatchCandidateInsert = Omit<PatchCandidateRow, 'createdAt' | 'updatedAt'>
export type PatchCandidateUpdate = Partial<Omit<PatchCandidateInsert, 'id' | 'taskId'>>

interface RawProbe {
  id: string
  task_id: string
  capability: string
  status: string
  expected_information_gain: string | null
  cost: string | null
  risk: string | null
  reason: string | null
  input: Record<string, unknown>
  result: Record<string, unknown> | null
  created_at: Date | string
  completed_at: Date | string | null
}

interface RawPatchCandidate {
  id: string
  task_id: string
  name: string
  base_commit: string
  status: string
  hypothesis_id: string | null
  diff_artifact_id: string | null
  summary: string | null
  verification_status: string | null
  promotion_decision: string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : value
}

function mapProbe(row: RawProbe): ProbeRow {
  return {
    id: row.id,
    taskId: row.task_id,
    capability: row.capability,
    status: row.status,
    expectedInformationGain: row.expected_information_gain,
    cost: row.cost,
    risk: row.risk,
    reason: row.reason,
    input: row.input ?? {},
    result: row.result,
    createdAt: toIso(row.created_at)!,
    completedAt: toIso(row.completed_at),
  }
}

function mapPatch(row: RawPatchCandidate): PatchCandidateRow {
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.name,
    baseCommit: row.base_commit,
    status: row.status,
    hypothesisId: row.hypothesis_id,
    diffArtifactId: row.diff_artifact_id,
    summary: row.summary,
    verificationStatus: row.verification_status,
    promotionDecision: row.promotion_decision,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  }
}

export class ProbeRepo {
  constructor(private sql: Db) {}

  async insert(input: ProbeInsert): Promise<ProbeRow> {
    const rows = await this.sql<RawProbe[]>`
      insert into probes (
        id, task_id, capability, status,
        expected_information_gain, cost, risk, reason,
        input, result
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.capability},
        ${input.status},
        ${input.expectedInformationGain},
        ${input.cost},
        ${input.risk},
        ${input.reason},
        ${jsonParam(this.sql, input.input)}::jsonb,
        ${input.result ? jsonParam(this.sql, input.result) : null}::jsonb
      )
      returning id, task_id, capability, status, expected_information_gain, cost, risk, reason, input, result, created_at, completed_at
    `
    return mapProbe(rows[0]!)
  }

  async update(id: string, patch: ProbeUpdate): Promise<ProbeRow> {
    const rows = await this.sql<RawProbe[]>`
      update probes
      set
        status = coalesce(${patch.status ?? null}, status),
        result = coalesce(${patch.result ? jsonParam(this.sql, patch.result) : null}::jsonb, result),
        completed_at = coalesce(${patch.completedAt ?? null}, completed_at)
      where id = ${id}
      returning id, task_id, capability, status, expected_information_gain, cost, risk, reason, input, result, created_at, completed_at
    `
    if (!rows.length) throw new Error(`Probe not found: ${id}`)
    return mapProbe(rows[0]!)
  }

  async get(id: string): Promise<ProbeRow | undefined> {
    const rows = await this.sql<RawProbe[]>`
      select id, task_id, capability, status, expected_information_gain, cost, risk, reason, input, result, created_at, completed_at
      from probes where id = ${id}
    `
    return rows[0] ? mapProbe(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<ProbeRow[]> {
    const rows = await this.sql<RawProbe[]>`
      select id, task_id, capability, status, expected_information_gain, cost, risk, reason, input, result, created_at, completed_at
      from probes where task_id = ${taskId} order by created_at asc
    `
    return rows.map(mapProbe)
  }
}

export class PatchCandidateRepo {
  constructor(private sql: Db) {}

  async insert(input: PatchCandidateInsert): Promise<PatchCandidateRow> {
    const rows = await this.sql<RawPatchCandidate[]>`
      insert into patch_candidates (
        id, task_id, name, base_commit, status, hypothesis_id,
        diff_artifact_id, summary, verification_status, promotion_decision, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.name},
        ${input.baseCommit},
        ${input.status},
        ${input.hypothesisId},
        ${input.diffArtifactId},
        ${input.summary},
        ${input.verificationStatus},
        ${input.promotionDecision},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, name, base_commit, status, hypothesis_id, diff_artifact_id, summary, verification_status, promotion_decision, payload, created_at, updated_at
    `
    return mapPatch(rows[0]!)
  }

  async update(id: string, patch: PatchCandidateUpdate): Promise<PatchCandidateRow> {
    const rows = await this.sql<RawPatchCandidate[]>`
      update patch_candidates
      set
        name = coalesce(${patch.name ?? null}, name),
        base_commit = coalesce(${patch.baseCommit ?? null}, base_commit),
        status = coalesce(${patch.status ?? null}, status),
        hypothesis_id = coalesce(${patch.hypothesisId ?? null}, hypothesis_id),
        diff_artifact_id = coalesce(${patch.diffArtifactId ?? null}, diff_artifact_id),
        summary = coalesce(${patch.summary ?? null}, summary),
        verification_status = coalesce(${patch.verificationStatus ?? null}, verification_status),
        promotion_decision = coalesce(${patch.promotionDecision ?? null}, promotion_decision),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, task_id, name, base_commit, status, hypothesis_id, diff_artifact_id, summary, verification_status, promotion_decision, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`PatchCandidate not found: ${id}`)
    return mapPatch(rows[0]!)
  }

  async get(id: string): Promise<PatchCandidateRow | undefined> {
    const rows = await this.sql<RawPatchCandidate[]>`
      select id, task_id, name, base_commit, status, hypothesis_id, diff_artifact_id, summary, verification_status, promotion_decision, payload, created_at, updated_at
      from patch_candidates where id = ${id}
    `
    return rows[0] ? mapPatch(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<PatchCandidateRow[]> {
    const rows = await this.sql<RawPatchCandidate[]>`
      select id, task_id, name, base_commit, status, hypothesis_id, diff_artifact_id, summary, verification_status, promotion_decision, payload, created_at, updated_at
      from patch_candidates where task_id = ${taskId} order by created_at asc
    `
    return rows.map(mapPatch)
  }

  async listActive(taskId: string): Promise<PatchCandidateRow[]> {
    const rows = await this.sql<RawPatchCandidate[]>`
      select id, task_id, name, base_commit, status, hypothesis_id, diff_artifact_id, summary, verification_status, promotion_decision, payload, created_at, updated_at
      from patch_candidates
      where task_id = ${taskId} and status in ('proposed', 'testing')
      order by created_at asc
    `
    return rows.map(mapPatch)
  }
}
