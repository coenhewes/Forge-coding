/**
 * Typed repository for `beliefs` and `hypotheses`.
 *
 * Beliefs are durable claims Forge holds about the repository (e.g.
 * "the auth flow normalises roles in middleware"). Hypotheses are
 * task-scoped bets Forge is actively testing. Track 2 will wire
 * belief-update logic; for now we expose CRUD + query-by-task so the
 * state substrate is in place.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface BeliefRow {
  id: string
  taskId: string | null
  repoId: string
  beliefType: string
  claim: string
  status: string
  confidence: number | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface HypothesisRow {
  id: string
  taskId: string
  claim: string
  status: string
  confidence: number
  relevantDomains: string[]
  relevantGraphNodes: string[]
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type BeliefInsert = Omit<BeliefRow, 'createdAt' | 'updatedAt'>
export type BeliefUpdate = Partial<Omit<BeliefInsert, 'id' | 'repoId'>>

export type HypothesisInsert = Omit<HypothesisRow, 'createdAt' | 'updatedAt'>
export type HypothesisUpdate = Partial<Omit<HypothesisInsert, 'id' | 'taskId'>>

interface RawBelief {
  id: string
  task_id: string | null
  repo_id: string
  belief_type: string
  claim: string
  status: string
  confidence: number | string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

interface RawHypothesis {
  id: string
  task_id: string
  claim: string
  status: string
  confidence: number | string
  relevant_domains: string[]
  relevant_graph_nodes: string[]
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? Number(value) : value
}

function mapBelief(row: RawBelief): BeliefRow {
  return {
    id: row.id,
    taskId: row.task_id,
    repoId: row.repo_id,
    beliefType: row.belief_type,
    claim: row.claim,
    status: row.status,
    confidence: toNumber(row.confidence),
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapHypothesis(row: RawHypothesis): HypothesisRow {
  return {
    id: row.id,
    taskId: row.task_id,
    claim: row.claim,
    status: row.status,
    confidence: toNumber(row.confidence) ?? 0,
    relevantDomains: row.relevant_domains ?? [],
    relevantGraphNodes: row.relevant_graph_nodes ?? [],
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

export class BeliefRepo {
  constructor(private sql: Db) {}

  async insert(input: BeliefInsert): Promise<BeliefRow> {
    const rows = await this.sql<RawBelief[]>`
      insert into beliefs (
        id, task_id, repo_id, belief_type, claim, status, confidence, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.repoId},
        ${input.beliefType},
        ${input.claim},
        ${input.status},
        ${input.confidence},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, repo_id, belief_type, claim, status, confidence, payload, created_at, updated_at
    `
    return mapBelief(rows[0]!)
  }

  async update(id: string, patch: BeliefUpdate): Promise<BeliefRow> {
    const rows = await this.sql<RawBelief[]>`
      update beliefs
      set
        task_id = coalesce(${patch.taskId ?? null}, task_id),
        belief_type = coalesce(${patch.beliefType ?? null}, belief_type),
        claim = coalesce(${patch.claim ?? null}, claim),
        status = coalesce(${patch.status ?? null}, status),
        confidence = coalesce(${patch.confidence ?? null}, confidence),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, task_id, repo_id, belief_type, claim, status, confidence, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`Belief not found: ${id}`)
    return mapBelief(rows[0]!)
  }

  async get(id: string): Promise<BeliefRow | undefined> {
    const rows = await this.sql<RawBelief[]>`
      select id, task_id, repo_id, belief_type, claim, status, confidence, payload, created_at, updated_at
      from beliefs where id = ${id}
    `
    return rows[0] ? mapBelief(rows[0]) : undefined
  }

  async listByRepo(repoId: string): Promise<BeliefRow[]> {
    const rows = await this.sql<RawBelief[]>`
      select id, task_id, repo_id, belief_type, claim, status, confidence, payload, created_at, updated_at
      from beliefs where repo_id = ${repoId} order by updated_at desc
    `
    return rows.map(mapBelief)
  }

  async listByTask(taskId: string): Promise<BeliefRow[]> {
    const rows = await this.sql<RawBelief[]>`
      select id, task_id, repo_id, belief_type, claim, status, confidence, payload, created_at, updated_at
      from beliefs where task_id = ${taskId} order by updated_at desc
    `
    return rows.map(mapBelief)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from beliefs where id = ${id} returning id
    `
    return rows.length > 0
  }
}

export class HypothesisRepo {
  constructor(private sql: Db) {}

  async insert(input: HypothesisInsert): Promise<HypothesisRow> {
    const rows = await this.sql<RawHypothesis[]>`
      insert into hypotheses (
        id, task_id, claim, status, confidence, relevant_domains, relevant_graph_nodes, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.claim},
        ${input.status},
        ${input.confidence},
        ${jsonArrayParam(this.sql, input.relevantDomains)}::jsonb,
        ${jsonArrayParam(this.sql, input.relevantGraphNodes)}::jsonb,
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, claim, status, confidence, relevant_domains, relevant_graph_nodes, payload, created_at, updated_at
    `
    return mapHypothesis(rows[0]!)
  }

  async update(id: string, patch: HypothesisUpdate): Promise<HypothesisRow> {
    const rows = await this.sql<RawHypothesis[]>`
      update hypotheses
      set
        claim = coalesce(${patch.claim ?? null}, claim),
        status = coalesce(${patch.status ?? null}, status),
        confidence = coalesce(${patch.confidence ?? null}, confidence),
        relevant_domains = coalesce(${patch.relevantDomains ? jsonArrayParam(this.sql, patch.relevantDomains) : null}::jsonb, relevant_domains),
        relevant_graph_nodes = coalesce(${patch.relevantGraphNodes ? jsonArrayParam(this.sql, patch.relevantGraphNodes) : null}::jsonb, relevant_graph_nodes),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, task_id, claim, status, confidence, relevant_domains, relevant_graph_nodes, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`Hypothesis not found: ${id}`)
    return mapHypothesis(rows[0]!)
  }

  async get(id: string): Promise<HypothesisRow | undefined> {
    const rows = await this.sql<RawHypothesis[]>`
      select id, task_id, claim, status, confidence, relevant_domains, relevant_graph_nodes, payload, created_at, updated_at
      from hypotheses where id = ${id}
    `
    return rows[0] ? mapHypothesis(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<HypothesisRow[]> {
    const rows = await this.sql<RawHypothesis[]>`
      select id, task_id, claim, status, confidence, relevant_domains, relevant_graph_nodes, payload, created_at, updated_at
      from hypotheses where task_id = ${taskId} order by confidence desc, created_at asc
    `
    return rows.map(mapHypothesis)
  }

  async listByStatus(taskId: string, status: string): Promise<HypothesisRow[]> {
    const rows = await this.sql<RawHypothesis[]>`
      select id, task_id, claim, status, confidence, relevant_domains, relevant_graph_nodes, payload, created_at, updated_at
      from hypotheses where task_id = ${taskId} and status = ${status}
      order by confidence desc, created_at asc
    `
    return rows.map(mapHypothesis)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from hypotheses where id = ${id} returning id
    `
    return rows.length > 0
  }
}
