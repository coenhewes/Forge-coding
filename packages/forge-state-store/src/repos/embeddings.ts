/**
 * Typed repository for local embedding records.
 *
 * V1 stores vectors as JSONB float arrays so Forge can use local embeddings
 * without requiring pgvector. Retrieval can compute cosine in process; a later
 * migration can add ANN indexes without changing this public surface.
 */
import type { EmbeddingRecord, EmbeddingTargetType } from '@forge/types'
import { jsonParam, type Db } from './base.js'

export type EmbeddingInsert = Omit<EmbeddingRecord, 'createdAt'>
export type EmbeddingUpsert = Omit<EmbeddingInsert, 'id'>

interface RawEmbedding {
  id: string
  repo_id: string
  target_type: EmbeddingTargetType
  target_ref: string
  model: string
  dim: number
  vector: number[] | string
  content_hash: string
  created_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function mapEmbedding(row: RawEmbedding): EmbeddingRecord {
  const vector = typeof row.vector === 'string' ? JSON.parse(row.vector) as number[] : row.vector
  return {
    id: row.id,
    repoId: row.repo_id,
    targetType: row.target_type,
    targetRef: row.target_ref,
    model: row.model,
    dim: row.dim,
    vector,
    contentHash: row.content_hash,
    createdAt: toIso(row.created_at),
  }
}

export class EmbeddingRepo {
  constructor(private sql: Db) {}

  async insert(input: EmbeddingInsert): Promise<EmbeddingRecord> {
    const rows = await this.sql<RawEmbedding[]>`
      insert into embeddings (
        id, repo_id, target_type, target_ref, model, dim, vector, content_hash
      )
      values (
        ${input.id},
        ${input.repoId},
        ${input.targetType},
        ${input.targetRef},
        ${input.model},
        ${input.dim},
        ${jsonParam(this.sql, { vector: input.vector })}::jsonb->'vector',
        ${input.contentHash}
      )
      returning id, repo_id, target_type, target_ref, model, dim, vector, content_hash, created_at
    `
    return mapEmbedding(rows[0]!)
  }

  async upsert(input: EmbeddingInsert): Promise<EmbeddingRecord> {
    const rows = await this.sql<RawEmbedding[]>`
      insert into embeddings (
        id, repo_id, target_type, target_ref, model, dim, vector, content_hash
      )
      values (
        ${input.id},
        ${input.repoId},
        ${input.targetType},
        ${input.targetRef},
        ${input.model},
        ${input.dim},
        ${jsonParam(this.sql, { vector: input.vector })}::jsonb->'vector',
        ${input.contentHash}
      )
      on conflict (repo_id, target_type, target_ref, model)
      do update set
        dim = excluded.dim,
        vector = excluded.vector,
        content_hash = excluded.content_hash,
        created_at = now()
      returning id, repo_id, target_type, target_ref, model, dim, vector, content_hash, created_at
    `
    return mapEmbedding(rows[0]!)
  }

  async get(repoId: string, targetType: EmbeddingTargetType, targetRef: string, model: string): Promise<EmbeddingRecord | undefined> {
    const rows = await this.sql<RawEmbedding[]>`
      select id, repo_id, target_type, target_ref, model, dim, vector, content_hash, created_at
      from embeddings
      where repo_id = ${repoId}
        and target_type = ${targetType}
        and target_ref = ${targetRef}
        and model = ${model}
      limit 1
    `
    return rows[0] ? mapEmbedding(rows[0]) : undefined
  }

  async listByRepo(repoId: string, targetType?: EmbeddingTargetType, limit = 500): Promise<EmbeddingRecord[]> {
    const rows = targetType
      ? await this.sql<RawEmbedding[]>`
          select id, repo_id, target_type, target_ref, model, dim, vector, content_hash, created_at
          from embeddings
          where repo_id = ${repoId} and target_type = ${targetType}
          order by created_at desc
          limit ${limit}
        `
      : await this.sql<RawEmbedding[]>`
          select id, repo_id, target_type, target_ref, model, dim, vector, content_hash, created_at
          from embeddings
          where repo_id = ${repoId}
          order by created_at desc
          limit ${limit}
        `
    return rows.map(mapEmbedding)
  }

  async deleteForTarget(repoId: string, targetType: EmbeddingTargetType, targetRef: string, model?: string): Promise<number> {
    const rows = model
      ? await this.sql<{ id: string }[]>`
          delete from embeddings
          where repo_id = ${repoId} and target_type = ${targetType} and target_ref = ${targetRef} and model = ${model}
          returning id
        `
      : await this.sql<{ id: string }[]>`
          delete from embeddings
          where repo_id = ${repoId} and target_type = ${targetType} and target_ref = ${targetRef}
          returning id
        `
    return rows.length
  }
}
