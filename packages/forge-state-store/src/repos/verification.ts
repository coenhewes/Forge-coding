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
 * Active verification state lives in `verification_actions`,
 * `verification_action_claim_links`, `verification_action_scores`, and
 * `verification_history`. These repos keep the planner's claim-driven
 * decisions durable and inspectable.
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

export interface VerificationActionRow {
  id: string
  taskId: string
  actionType: string
  command: string | null
  capability: string | null
  status: string
  expectedEvidenceValue: number | null
  selectionReason: string | null
  estimatedRuntimeMs: number | null
  estimatedCost: string | null
  flakinessRisk: string | null
  setupCost: string | null
  evidenceQuality: string | null
  reviewUsefulness: string | null
  resultEvidenceId: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface VerificationActionClaimLinkRow {
  id: string
  verificationActionId: string
  claimId: string
  linkType: string
  expectedConfidenceDelta: number | null
  actualConfidenceDelta: number | null
  createdAt: string
}

export interface VerificationActionScoreRow {
  id: string
  verificationActionId: string
  totalScore: number
  claimImportance: number
  expectedConfidenceShift: number
  riskWeight: number
  hypothesisDiscrimination: number
  evidenceQuality: number
  reviewUsefulness: number
  runtimePenalty: number
  flakinessPenalty: number
  setupPenalty: number
  contextPenalty: number
  explanation: string
  createdAt: string
}

export interface VerificationHistoryRow {
  id: string
  repoId: string
  actionSignature: string
  actionType: string
  command: string | null
  domain: string | null
  averageRuntimeMs: number | null
  failureRate: number | null
  flakeRate: number | null
  historicalDetectionValue: number | null
  lastRunAt: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type VerificationActionInsert = Omit<VerificationActionRow, 'createdAt' | 'updatedAt'>
export type VerificationActionUpdate = Partial<Omit<VerificationActionInsert, 'id' | 'taskId'>>
export type VerificationActionClaimLinkInsert = Omit<VerificationActionClaimLinkRow, 'createdAt'>
export type VerificationActionClaimLinkUpdate = Partial<Pick<VerificationActionClaimLinkRow, 'actualConfidenceDelta'>>
export type VerificationActionScoreInsert = Omit<VerificationActionScoreRow, 'createdAt'>
export type VerificationHistoryInsert = Omit<VerificationHistoryRow, 'createdAt' | 'updatedAt'>
export type VerificationHistoryUpdate = Partial<Omit<VerificationHistoryInsert, 'id' | 'repoId' | 'actionSignature'>>

interface RawVerificationAction {
  id: string
  task_id: string
  action_type: string
  command: string | null
  capability: string | null
  status: string
  expected_evidence_value: number | string | null
  selection_reason: string | null
  estimated_runtime_ms: number | null
  estimated_cost: string | null
  flakiness_risk: string | null
  setup_cost: string | null
  evidence_quality: string | null
  review_usefulness: string | null
  result_evidence_id: string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

interface RawVerificationActionClaimLink {
  id: string
  verification_action_id: string
  claim_id: string
  link_type: string
  expected_confidence_delta: number | string | null
  actual_confidence_delta: number | string | null
  created_at: Date | string
}

interface RawVerificationActionScore {
  id: string
  verification_action_id: string
  total_score: number | string
  claim_importance: number | string
  expected_confidence_shift: number | string
  risk_weight: number | string
  hypothesis_discrimination: number | string
  evidence_quality: number | string
  review_usefulness: number | string
  runtime_penalty: number | string
  flakiness_penalty: number | string
  setup_penalty: number | string
  context_penalty: number | string
  explanation: string
  created_at: Date | string
}

interface RawVerificationHistory {
  id: string
  repo_id: string
  action_signature: string
  action_type: string
  command: string | null
  domain: string | null
  average_runtime_ms: number | null
  failure_rate: number | string | null
  flake_rate: number | string | null
  historical_detection_value: number | string | null
  last_run_at: Date | string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? Number(value) : value
}

function mapAction(row: RawVerificationAction): VerificationActionRow {
  return {
    id: row.id,
    taskId: row.task_id,
    actionType: row.action_type,
    command: row.command,
    capability: row.capability,
    status: row.status,
    expectedEvidenceValue: toNumber(row.expected_evidence_value),
    selectionReason: row.selection_reason,
    estimatedRuntimeMs: row.estimated_runtime_ms,
    estimatedCost: row.estimated_cost,
    flakinessRisk: row.flakiness_risk,
    setupCost: row.setup_cost,
    evidenceQuality: row.evidence_quality,
    reviewUsefulness: row.review_usefulness,
    resultEvidenceId: row.result_evidence_id,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapActionLink(row: RawVerificationActionClaimLink): VerificationActionClaimLinkRow {
  return {
    id: row.id,
    verificationActionId: row.verification_action_id,
    claimId: row.claim_id,
    linkType: row.link_type,
    expectedConfidenceDelta: toNumber(row.expected_confidence_delta),
    actualConfidenceDelta: toNumber(row.actual_confidence_delta),
    createdAt: toIso(row.created_at),
  }
}

function mapActionScore(row: RawVerificationActionScore): VerificationActionScoreRow {
  return {
    id: row.id,
    verificationActionId: row.verification_action_id,
    totalScore: toNumber(row.total_score) ?? 0,
    claimImportance: toNumber(row.claim_importance) ?? 0,
    expectedConfidenceShift: toNumber(row.expected_confidence_shift) ?? 0,
    riskWeight: toNumber(row.risk_weight) ?? 0,
    hypothesisDiscrimination: toNumber(row.hypothesis_discrimination) ?? 0,
    evidenceQuality: toNumber(row.evidence_quality) ?? 0,
    reviewUsefulness: toNumber(row.review_usefulness) ?? 0,
    runtimePenalty: toNumber(row.runtime_penalty) ?? 0,
    flakinessPenalty: toNumber(row.flakiness_penalty) ?? 0,
    setupPenalty: toNumber(row.setup_penalty) ?? 0,
    contextPenalty: toNumber(row.context_penalty) ?? 0,
    explanation: row.explanation,
    createdAt: toIso(row.created_at),
  }
}

function mapHistory(row: RawVerificationHistory): VerificationHistoryRow {
  return {
    id: row.id,
    repoId: row.repo_id,
    actionSignature: row.action_signature,
    actionType: row.action_type,
    command: row.command,
    domain: row.domain,
    averageRuntimeMs: row.average_runtime_ms,
    failureRate: toNumber(row.failure_rate),
    flakeRate: toNumber(row.flake_rate),
    historicalDetectionValue: toNumber(row.historical_detection_value),
    lastRunAt: row.last_run_at ? toIso(row.last_run_at) : null,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

export class VerificationActionRepo {
  constructor(private sql: Db) {}

  async insert(input: VerificationActionInsert): Promise<VerificationActionRow> {
    const rows = await this.sql<RawVerificationAction[]>`
      insert into verification_actions (
        id, task_id, action_type, command, capability, status,
        expected_evidence_value, selection_reason, estimated_runtime_ms,
        estimated_cost, flakiness_risk, setup_cost, evidence_quality,
        review_usefulness, result_evidence_id, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.actionType},
        ${input.command},
        ${input.capability},
        ${input.status},
        ${input.expectedEvidenceValue},
        ${input.selectionReason},
        ${input.estimatedRuntimeMs},
        ${input.estimatedCost},
        ${input.flakinessRisk},
        ${input.setupCost},
        ${input.evidenceQuality},
        ${input.reviewUsefulness},
        ${input.resultEvidenceId},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, action_type, command, capability, status, expected_evidence_value, selection_reason, estimated_runtime_ms, estimated_cost, flakiness_risk, setup_cost, evidence_quality, review_usefulness, result_evidence_id, payload, created_at, updated_at
    `
    return mapAction(rows[0]!)
  }

  async update(id: string, patch: VerificationActionUpdate): Promise<VerificationActionRow> {
    const rows = await this.sql<RawVerificationAction[]>`
      update verification_actions
      set
        action_type = coalesce(${patch.actionType ?? null}, action_type),
        command = coalesce(${patch.command ?? null}, command),
        capability = coalesce(${patch.capability ?? null}, capability),
        status = coalesce(${patch.status ?? null}, status),
        expected_evidence_value = coalesce(${patch.expectedEvidenceValue ?? null}, expected_evidence_value),
        selection_reason = coalesce(${patch.selectionReason ?? null}, selection_reason),
        estimated_runtime_ms = coalesce(${patch.estimatedRuntimeMs ?? null}, estimated_runtime_ms),
        estimated_cost = coalesce(${patch.estimatedCost ?? null}, estimated_cost),
        flakiness_risk = coalesce(${patch.flakinessRisk ?? null}, flakiness_risk),
        setup_cost = coalesce(${patch.setupCost ?? null}, setup_cost),
        evidence_quality = coalesce(${patch.evidenceQuality ?? null}, evidence_quality),
        review_usefulness = coalesce(${patch.reviewUsefulness ?? null}, review_usefulness),
        result_evidence_id = coalesce(${patch.resultEvidenceId ?? null}, result_evidence_id),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, task_id, action_type, command, capability, status, expected_evidence_value, selection_reason, estimated_runtime_ms, estimated_cost, flakiness_risk, setup_cost, evidence_quality, review_usefulness, result_evidence_id, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`VerificationAction not found: ${id}`)
    return mapAction(rows[0]!)
  }

  async get(id: string): Promise<VerificationActionRow | undefined> {
    const rows = await this.sql<RawVerificationAction[]>`
      select id, task_id, action_type, command, capability, status, expected_evidence_value, selection_reason, estimated_runtime_ms, estimated_cost, flakiness_risk, setup_cost, evidence_quality, review_usefulness, result_evidence_id, payload, created_at, updated_at
      from verification_actions where id = ${id}
    `
    return rows[0] ? mapAction(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<VerificationActionRow[]> {
    const rows = await this.sql<RawVerificationAction[]>`
      select id, task_id, action_type, command, capability, status, expected_evidence_value, selection_reason, estimated_runtime_ms, estimated_cost, flakiness_risk, setup_cost, evidence_quality, review_usefulness, result_evidence_id, payload, created_at, updated_at
      from verification_actions where task_id = ${taskId} order by expected_evidence_value desc nulls last, created_at asc
    `
    return rows.map(mapAction)
  }

  async listByStatus(taskId: string, status: string): Promise<VerificationActionRow[]> {
    const rows = await this.sql<RawVerificationAction[]>`
      select id, task_id, action_type, command, capability, status, expected_evidence_value, selection_reason, estimated_runtime_ms, estimated_cost, flakiness_risk, setup_cost, evidence_quality, review_usefulness, result_evidence_id, payload, created_at, updated_at
      from verification_actions
      where task_id = ${taskId} and status = ${status}
      order by expected_evidence_value desc nulls last, created_at asc
    `
    return rows.map(mapAction)
  }
}

export class VerificationActionClaimLinkRepo {
  constructor(private sql: Db) {}

  async insert(input: VerificationActionClaimLinkInsert): Promise<VerificationActionClaimLinkRow> {
    const rows = await this.sql<RawVerificationActionClaimLink[]>`
      insert into verification_action_claim_links (
        id, verification_action_id, claim_id, link_type,
        expected_confidence_delta, actual_confidence_delta
      )
      values (
        ${input.id},
        ${input.verificationActionId},
        ${input.claimId},
        ${input.linkType},
        ${input.expectedConfidenceDelta},
        ${input.actualConfidenceDelta}
      )
      on conflict (verification_action_id, claim_id, link_type) do update
        set expected_confidence_delta = excluded.expected_confidence_delta,
            actual_confidence_delta = excluded.actual_confidence_delta
      returning id, verification_action_id, claim_id, link_type, expected_confidence_delta, actual_confidence_delta, created_at
    `
    return mapActionLink(rows[0]!)
  }

  async update(id: string, patch: VerificationActionClaimLinkUpdate): Promise<VerificationActionClaimLinkRow> {
    const rows = await this.sql<RawVerificationActionClaimLink[]>`
      update verification_action_claim_links
      set actual_confidence_delta = coalesce(${patch.actualConfidenceDelta ?? null}, actual_confidence_delta)
      where id = ${id}
      returning id, verification_action_id, claim_id, link_type, expected_confidence_delta, actual_confidence_delta, created_at
    `
    if (!rows.length) throw new Error(`VerificationActionClaimLink not found: ${id}`)
    return mapActionLink(rows[0]!)
  }

  async listByAction(actionId: string): Promise<VerificationActionClaimLinkRow[]> {
    const rows = await this.sql<RawVerificationActionClaimLink[]>`
      select id, verification_action_id, claim_id, link_type, expected_confidence_delta, actual_confidence_delta, created_at
      from verification_action_claim_links
      where verification_action_id = ${actionId}
      order by created_at asc
    `
    return rows.map(mapActionLink)
  }

  async listByClaim(claimId: string): Promise<VerificationActionClaimLinkRow[]> {
    const rows = await this.sql<RawVerificationActionClaimLink[]>`
      select id, verification_action_id, claim_id, link_type, expected_confidence_delta, actual_confidence_delta, created_at
      from verification_action_claim_links
      where claim_id = ${claimId}
      order by created_at asc
    `
    return rows.map(mapActionLink)
  }
}

export class VerificationActionScoreRepo {
  constructor(private sql: Db) {}

  async insert(input: VerificationActionScoreInsert): Promise<VerificationActionScoreRow> {
    const rows = await this.sql<RawVerificationActionScore[]>`
      insert into verification_action_scores (
        id, verification_action_id, total_score, claim_importance,
        expected_confidence_shift, risk_weight, hypothesis_discrimination,
        evidence_quality, review_usefulness, runtime_penalty,
        flakiness_penalty, setup_penalty, context_penalty, explanation
      )
      values (
        ${input.id},
        ${input.verificationActionId},
        ${input.totalScore},
        ${input.claimImportance},
        ${input.expectedConfidenceShift},
        ${input.riskWeight},
        ${input.hypothesisDiscrimination},
        ${input.evidenceQuality},
        ${input.reviewUsefulness},
        ${input.runtimePenalty},
        ${input.flakinessPenalty},
        ${input.setupPenalty},
        ${input.contextPenalty},
        ${input.explanation}
      )
      returning id, verification_action_id, total_score, claim_importance, expected_confidence_shift, risk_weight, hypothesis_discrimination, evidence_quality, review_usefulness, runtime_penalty, flakiness_penalty, setup_penalty, context_penalty, explanation, created_at
    `
    return mapActionScore(rows[0]!)
  }

  async listByAction(actionId: string): Promise<VerificationActionScoreRow[]> {
    const rows = await this.sql<RawVerificationActionScore[]>`
      select id, verification_action_id, total_score, claim_importance, expected_confidence_shift, risk_weight, hypothesis_discrimination, evidence_quality, review_usefulness, runtime_penalty, flakiness_penalty, setup_penalty, context_penalty, explanation, created_at
      from verification_action_scores
      where verification_action_id = ${actionId}
      order by created_at desc
    `
    return rows.map(mapActionScore)
  }
}

export class VerificationHistoryRepo {
  constructor(private sql: Db) {}

  async upsert(input: VerificationHistoryInsert): Promise<VerificationHistoryRow> {
    const rows = await this.sql<RawVerificationHistory[]>`
      insert into verification_history (
        id, repo_id, action_signature, action_type, command, domain,
        average_runtime_ms, failure_rate, flake_rate,
        historical_detection_value, last_run_at, payload
      )
      values (
        ${input.id},
        ${input.repoId},
        ${input.actionSignature},
        ${input.actionType},
        ${input.command},
        ${input.domain},
        ${input.averageRuntimeMs},
        ${input.failureRate},
        ${input.flakeRate},
        ${input.historicalDetectionValue},
        ${input.lastRunAt},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      on conflict (repo_id, action_signature) do update
        set action_type = excluded.action_type,
            command = excluded.command,
            domain = excluded.domain,
            average_runtime_ms = excluded.average_runtime_ms,
            failure_rate = excluded.failure_rate,
            flake_rate = excluded.flake_rate,
            historical_detection_value = excluded.historical_detection_value,
            last_run_at = excluded.last_run_at,
            payload = excluded.payload,
            updated_at = now()
      returning id, repo_id, action_signature, action_type, command, domain, average_runtime_ms, failure_rate, flake_rate, historical_detection_value, last_run_at, payload, created_at, updated_at
    `
    return mapHistory(rows[0]!)
  }

  async update(id: string, patch: VerificationHistoryUpdate): Promise<VerificationHistoryRow> {
    const rows = await this.sql<RawVerificationHistory[]>`
      update verification_history
      set
        action_type = coalesce(${patch.actionType ?? null}, action_type),
        command = coalesce(${patch.command ?? null}, command),
        domain = coalesce(${patch.domain ?? null}, domain),
        average_runtime_ms = coalesce(${patch.averageRuntimeMs ?? null}, average_runtime_ms),
        failure_rate = coalesce(${patch.failureRate ?? null}, failure_rate),
        flake_rate = coalesce(${patch.flakeRate ?? null}, flake_rate),
        historical_detection_value = coalesce(${patch.historicalDetectionValue ?? null}, historical_detection_value),
        last_run_at = coalesce(${patch.lastRunAt ?? null}, last_run_at),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, repo_id, action_signature, action_type, command, domain, average_runtime_ms, failure_rate, flake_rate, historical_detection_value, last_run_at, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`VerificationHistory not found: ${id}`)
    return mapHistory(rows[0]!)
  }

  async getBySignature(repoId: string, actionSignature: string): Promise<VerificationHistoryRow | undefined> {
    const rows = await this.sql<RawVerificationHistory[]>`
      select id, repo_id, action_signature, action_type, command, domain, average_runtime_ms, failure_rate, flake_rate, historical_detection_value, last_run_at, payload, created_at, updated_at
      from verification_history
      where repo_id = ${repoId} and action_signature = ${actionSignature}
    `
    return rows[0] ? mapHistory(rows[0]) : undefined
  }

  async listByRepo(repoId: string): Promise<VerificationHistoryRow[]> {
    const rows = await this.sql<RawVerificationHistory[]>`
      select id, repo_id, action_signature, action_type, command, domain, average_runtime_ms, failure_rate, flake_rate, historical_detection_value, last_run_at, payload, created_at, updated_at
      from verification_history
      where repo_id = ${repoId}
      order by last_run_at desc nulls last, updated_at desc
    `
    return rows.map(mapHistory)
  }
}
