/**
 * Typed repository for `claims`, `evidence`, and `claim_evidence_links`.
 *
 * The claim-evidence graph is the heart of Forge's "claims backed by
 * proof" discipline. A claim is something Forge asserts (e.g.
 * "non-admin users cannot invite teammates"). Evidence rows are
 * observations that support, contradict, or qualify claims; the
 * `claim_evidence_links` join table records the relationship and its
 * type. Each evidence row may optionally reference an artifact in the
 * artifact store via `artifact_id`.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface ClaimRow {
  id: string
  taskId: string
  acceptanceCriterionId: string | null
  text: string
  status: string
  confidence: number | null
  riskLevel: string | null
  reviewerGuidance: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface EvidenceRow {
  id: string
  taskId: string
  evidenceType: string
  summary: string
  status: string | null
  sourceType: string
  sourceRef: string | null
  artifactId: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface ClaimEvidenceLinkRow {
  id: string
  claimId: string
  evidenceId: string
  linkType: string
  createdAt: string
}

export type ClaimInsert = Omit<ClaimRow, 'createdAt' | 'updatedAt'>
export type ClaimUpdate = Partial<Omit<ClaimInsert, 'id' | 'taskId'>>

export type EvidenceInsert = Omit<EvidenceRow, 'createdAt'>
export type EvidenceUpdate = Partial<Omit<EvidenceInsert, 'id' | 'taskId'>>

export type ClaimEvidenceLinkInsert = Omit<ClaimEvidenceLinkRow, 'createdAt'>

interface RawClaim {
  id: string
  task_id: string
  acceptance_criterion_id: string | null
  text: string
  status: string
  confidence: number | string | null
  risk_level: string | null
  reviewer_guidance: string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

interface RawEvidence {
  id: string
  task_id: string
  evidence_type: string
  summary: string
  status: string | null
  source_type: string
  source_ref: string | null
  artifact_id: string | null
  payload: Record<string, unknown>
  created_at: Date | string
}

interface RawClaimEvidenceLink {
  id: string
  claim_id: string
  evidence_id: string
  link_type: string
  created_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? Number(value) : value
}

function mapClaim(row: RawClaim): ClaimRow {
  return {
    id: row.id,
    taskId: row.task_id,
    acceptanceCriterionId: row.acceptance_criterion_id,
    text: row.text,
    status: row.status,
    confidence: toNumber(row.confidence),
    riskLevel: row.risk_level,
    reviewerGuidance: row.reviewer_guidance,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapEvidence(row: RawEvidence): EvidenceRow {
  return {
    id: row.id,
    taskId: row.task_id,
    evidenceType: row.evidence_type,
    summary: row.summary,
    status: row.status,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    artifactId: row.artifact_id,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
  }
}

function mapLink(row: RawClaimEvidenceLink): ClaimEvidenceLinkRow {
  return {
    id: row.id,
    claimId: row.claim_id,
    evidenceId: row.evidence_id,
    linkType: row.link_type,
    createdAt: toIso(row.created_at),
  }
}

export class ClaimRepo {
  constructor(private sql: Db) {}

  async insert(input: ClaimInsert): Promise<ClaimRow> {
    const rows = await this.sql<RawClaim[]>`
      insert into claims (
        id, task_id, acceptance_criterion_id, text, status, confidence,
        risk_level, reviewer_guidance, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.acceptanceCriterionId},
        ${input.text},
        ${input.status},
        ${input.confidence},
        ${input.riskLevel},
        ${input.reviewerGuidance},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, acceptance_criterion_id, text, status, confidence, risk_level, reviewer_guidance, payload, created_at, updated_at
    `
    return mapClaim(rows[0]!)
  }

  async update(id: string, patch: ClaimUpdate): Promise<ClaimRow> {
    const rows = await this.sql<RawClaim[]>`
      update claims
      set
        acceptance_criterion_id = coalesce(${patch.acceptanceCriterionId ?? null}, acceptance_criterion_id),
        text = coalesce(${patch.text ?? null}, text),
        status = coalesce(${patch.status ?? null}, status),
        confidence = coalesce(${patch.confidence ?? null}, confidence),
        risk_level = coalesce(${patch.riskLevel ?? null}, risk_level),
        reviewer_guidance = coalesce(${patch.reviewerGuidance ?? null}, reviewer_guidance),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, task_id, acceptance_criterion_id, text, status, confidence, risk_level, reviewer_guidance, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`Claim not found: ${id}`)
    return mapClaim(rows[0]!)
  }

  async get(id: string): Promise<ClaimRow | undefined> {
    const rows = await this.sql<RawClaim[]>`
      select id, task_id, acceptance_criterion_id, text, status, confidence, risk_level, reviewer_guidance, payload, created_at, updated_at
      from claims where id = ${id}
    `
    return rows[0] ? mapClaim(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<ClaimRow[]> {
    const rows = await this.sql<RawClaim[]>`
      select id, task_id, acceptance_criterion_id, text, status, confidence, risk_level, reviewer_guidance, payload, created_at, updated_at
      from claims where task_id = ${taskId} order by created_at asc
    `
    return rows.map(mapClaim)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from claims where id = ${id} returning id
    `
    return rows.length > 0
  }
}

export class EvidenceRepo {
  constructor(private sql: Db) {}

  async insert(input: EvidenceInsert): Promise<EvidenceRow> {
    const rows = await this.sql<RawEvidence[]>`
      insert into evidence (
        id, task_id, evidence_type, summary, status, source_type, source_ref, artifact_id, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.evidenceType},
        ${input.summary},
        ${input.status},
        ${input.sourceType},
        ${input.sourceRef},
        ${input.artifactId},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, evidence_type, summary, status, source_type, source_ref, artifact_id, payload, created_at
    `
    return mapEvidence(rows[0]!)
  }

  async update(id: string, patch: EvidenceUpdate): Promise<EvidenceRow> {
    const rows = await this.sql<RawEvidence[]>`
      update evidence
      set
        evidence_type = coalesce(${patch.evidenceType ?? null}, evidence_type),
        summary = coalesce(${patch.summary ?? null}, summary),
        status = coalesce(${patch.status ?? null}, status),
        source_type = coalesce(${patch.sourceType ?? null}, source_type),
        source_ref = coalesce(${patch.sourceRef ?? null}, source_ref),
        artifact_id = coalesce(${patch.artifactId ?? null}, artifact_id),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload)
      where id = ${id}
      returning id, task_id, evidence_type, summary, status, source_type, source_ref, artifact_id, payload, created_at
    `
    if (!rows.length) throw new Error(`Evidence not found: ${id}`)
    return mapEvidence(rows[0]!)
  }

  async get(id: string): Promise<EvidenceRow | undefined> {
    const rows = await this.sql<RawEvidence[]>`
      select id, task_id, evidence_type, summary, status, source_type, source_ref, artifact_id, payload, created_at
      from evidence where id = ${id}
    `
    return rows[0] ? mapEvidence(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<EvidenceRow[]> {
    const rows = await this.sql<RawEvidence[]>`
      select id, task_id, evidence_type, summary, status, source_type, source_ref, artifact_id, payload, created_at
      from evidence where task_id = ${taskId} order by created_at desc
    `
    return rows.map(mapEvidence)
  }

  async listByClaim(claimId: string): Promise<EvidenceRow[]> {
    const rows = await this.sql<RawEvidence[]>`
      select e.id, e.task_id, e.evidence_type, e.summary, e.status, e.source_type, e.source_ref, e.artifact_id, e.payload, e.created_at
      from evidence e
      join claim_evidence_links l on l.evidence_id = e.id
      where l.claim_id = ${claimId}
      order by l.created_at asc
    `
    return rows.map(mapEvidence)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from evidence where id = ${id} returning id
    `
    return rows.length > 0
  }
}

export class ClaimEvidenceLinkRepo {
  constructor(private sql: Db) {}

  async insert(input: ClaimEvidenceLinkInsert): Promise<ClaimEvidenceLinkRow> {
    const rows = await this.sql<RawClaimEvidenceLink[]>`
      insert into claim_evidence_links (id, claim_id, evidence_id, link_type)
      values (${input.id}, ${input.claimId}, ${input.evidenceId}, ${input.linkType})
      on conflict (claim_id, evidence_id, link_type) do nothing
      returning id, claim_id, evidence_id, link_type, created_at
    `
    if (!rows.length) {
      // Already exists — return the existing row.
      const existing = await this.sql<RawClaimEvidenceLink[]>`
        select id, claim_id, evidence_id, link_type, created_at
        from claim_evidence_links
        where claim_id = ${input.claimId}
          and evidence_id = ${input.evidenceId}
          and link_type = ${input.linkType}
      `
      return mapLink(existing[0]!)
    }
    return mapLink(rows[0]!)
  }

  async listByClaim(claimId: string): Promise<ClaimEvidenceLinkRow[]> {
    const rows = await this.sql<RawClaimEvidenceLink[]>`
      select id, claim_id, evidence_id, link_type, created_at
      from claim_evidence_links where claim_id = ${claimId} order by created_at asc
    `
    return rows.map(mapLink)
  }

  async listByEvidence(evidenceId: string): Promise<ClaimEvidenceLinkRow[]> {
    const rows = await this.sql<RawClaimEvidenceLink[]>`
      select id, claim_id, evidence_id, link_type, created_at
      from claim_evidence_links where evidence_id = ${evidenceId} order by created_at asc
    `
    return rows.map(mapLink)
  }
}
