/**
 * Typed repository for `repos`, `repo_nodes`, and `repo_edges`.
 *
 * Repos represent the codebase Forge is operating on. Repo nodes are
 * the typed graph nodes (files, packages, routes, symbols, …) and
 * repo edges are typed relationships between nodes. The schema enforces
 * uniqueness on `(repo_id, stable_key)` for nodes and source/target
 * FK integrity on edges.
 *
 * Every method here returns rows typed against the schema columns —
 * no raw SQL is exposed to callers.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface RepoRow {
  id: string
  rootPath: string
  name: string
  currentBranch: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface RepoNodeRow {
  id: string
  repoId: string
  nodeType: string
  stableKey: string
  name: string
  path: string | null
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface RepoEdgeRow {
  id: string
  repoId: string
  sourceNodeId: string
  targetNodeId: string
  edgeType: string
  confidence: number | null
  payload: Record<string, unknown>
  createdAt: string
}

export type RepoInsert = Omit<RepoRow, 'createdAt' | 'updatedAt'>
export type RepoUpdate = Partial<Omit<RepoInsert, 'id'>>

export type RepoNodeInsert = Omit<RepoNodeRow, 'createdAt' | 'updatedAt'>
export type RepoNodeUpdate = Partial<Omit<RepoNodeInsert, 'id' | 'repoId'>>

export type RepoEdgeInsert = Omit<RepoEdgeRow, 'createdAt'>
export type RepoEdgeUpdate = Partial<Omit<RepoEdgeInsert, 'id' | 'repoId'>>

interface RawRepo {
  id: string
  root_path: string
  name: string
  current_branch: string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

interface RawRepoNode {
  id: string
  repo_id: string
  node_type: string
  stable_key: string
  name: string
  path: string | null
  payload: Record<string, unknown>
  created_at: Date | string
  updated_at: Date | string
}

interface RawRepoEdge {
  id: string
  repo_id: string
  source_node_id: string
  target_node_id: string
  edge_type: string
  confidence: number | string | null
  payload: Record<string, unknown>
  created_at: Date | string
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function mapRepo(row: RawRepo): RepoRow {
  return {
    id: row.id,
    rootPath: row.root_path,
    name: row.name,
    currentBranch: row.current_branch,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapRepoNode(row: RawRepoNode): RepoNodeRow {
  return {
    id: row.id,
    repoId: row.repo_id,
    nodeType: row.node_type,
    stableKey: row.stable_key,
    name: row.name,
    path: row.path,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }
}

function mapRepoEdge(row: RawRepoEdge): RepoEdgeRow {
  const confidence =
    row.confidence === null || row.confidence === undefined
      ? null
      : typeof row.confidence === 'string'
        ? Number(row.confidence)
        : row.confidence
  return {
    id: row.id,
    repoId: row.repo_id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    edgeType: row.edge_type,
    confidence,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at),
  }
}

export class RepoRepo {
  constructor(private sql: Db) {}

  async insert(input: RepoInsert): Promise<RepoRow> {
    const rows = await this.sql<RawRepo[]>`
      insert into repos (id, root_path, name, current_branch, payload)
      values (
        ${input.id},
        ${input.rootPath},
        ${input.name},
        ${input.currentBranch},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, root_path, name, current_branch, payload, created_at, updated_at
    `
    return mapRepo(rows[0]!)
  }

  async update(id: string, patch: RepoUpdate): Promise<RepoRow> {
    const rows = await this.sql<RawRepo[]>`
      update repos
      set
        root_path = coalesce(${patch.rootPath ?? null}, root_path),
        name = coalesce(${patch.name ?? null}, name),
        current_branch = coalesce(${patch.currentBranch ?? null}, current_branch),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, root_path, name, current_branch, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`Repo not found: ${id}`)
    return mapRepo(rows[0]!)
  }

  async get(id: string): Promise<RepoRow | undefined> {
    const rows = await this.sql<RawRepo[]>`
      select id, root_path, name, current_branch, payload, created_at, updated_at
      from repos where id = ${id}
    `
    return rows[0] ? mapRepo(rows[0]) : undefined
  }

  async getByRootPath(rootPath: string): Promise<RepoRow | undefined> {
    const rows = await this.sql<RawRepo[]>`
      select id, root_path, name, current_branch, payload, created_at, updated_at
      from repos where root_path = ${rootPath}
    `
    return rows[0] ? mapRepo(rows[0]) : undefined
  }

  async list(): Promise<RepoRow[]> {
    const rows = await this.sql<RawRepo[]>`
      select id, root_path, name, current_branch, payload, created_at, updated_at
      from repos order by created_at asc
    `
    return rows.map(mapRepo)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from repos where id = ${id} returning id
    `
    return rows.length > 0
  }
}

export class RepoNodeRepo {
  constructor(private sql: Db) {}

  async upsertByStableKey(input: RepoNodeInsert): Promise<RepoNodeRow> {
    const rows = await this.sql<RawRepoNode[]>`
      insert into repo_nodes (id, repo_id, node_type, stable_key, name, path, payload)
      values (
        ${input.id},
        ${input.repoId},
        ${input.nodeType},
        ${input.stableKey},
        ${input.name},
        ${input.path},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      on conflict (repo_id, stable_key) do update
        set node_type = excluded.node_type,
            name = excluded.name,
            path = excluded.path,
            payload = excluded.payload,
            updated_at = now()
      returning id, repo_id, node_type, stable_key, name, path, payload, created_at, updated_at
    `
    return mapRepoNode(rows[0]!)
  }

  async get(id: string): Promise<RepoNodeRow | undefined> {
    const rows = await this.sql<RawRepoNode[]>`
      select id, repo_id, node_type, stable_key, name, path, payload, created_at, updated_at
      from repo_nodes where id = ${id}
    `
    return rows[0] ? mapRepoNode(rows[0]) : undefined
  }

  async getByStableKey(repoId: string, stableKey: string): Promise<RepoNodeRow | undefined> {
    const rows = await this.sql<RawRepoNode[]>`
      select id, repo_id, node_type, stable_key, name, path, payload, created_at, updated_at
      from repo_nodes where repo_id = ${repoId} and stable_key = ${stableKey}
    `
    return rows[0] ? mapRepoNode(rows[0]) : undefined
  }

  async listByRepo(repoId: string): Promise<RepoNodeRow[]> {
    const rows = await this.sql<RawRepoNode[]>`
      select id, repo_id, node_type, stable_key, name, path, payload, created_at, updated_at
      from repo_nodes where repo_id = ${repoId} order by stable_key asc
    `
    return rows.map(mapRepoNode)
  }

  async update(id: string, patch: RepoNodeUpdate): Promise<RepoNodeRow> {
    const rows = await this.sql<RawRepoNode[]>`
      update repo_nodes
      set
        node_type = coalesce(${patch.nodeType ?? null}, node_type),
        name = coalesce(${patch.name ?? null}, name),
        path = coalesce(${patch.path ?? null}, path),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload),
        updated_at = now()
      where id = ${id}
      returning id, repo_id, node_type, stable_key, name, path, payload, created_at, updated_at
    `
    if (!rows.length) throw new Error(`RepoNode not found: ${id}`)
    return mapRepoNode(rows[0]!)
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from repo_nodes where id = ${id} returning id
    `
    return rows.length > 0
  }
}

export class RepoEdgeRepo {
  constructor(private sql: Db) {}

  async insert(input: RepoEdgeInsert): Promise<RepoEdgeRow> {
    const rows = await this.sql<RawRepoEdge[]>`
      insert into repo_edges (id, repo_id, source_node_id, target_node_id, edge_type, confidence, payload)
      values (
        ${input.id},
        ${input.repoId},
        ${input.sourceNodeId},
        ${input.targetNodeId},
        ${input.edgeType},
        ${input.confidence},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, repo_id, source_node_id, target_node_id, edge_type, confidence, payload, created_at
    `
    return mapRepoEdge(rows[0]!)
  }

  async get(id: string): Promise<RepoEdgeRow | undefined> {
    const rows = await this.sql<RawRepoEdge[]>`
      select id, repo_id, source_node_id, target_node_id, edge_type, confidence, payload, created_at
      from repo_edges where id = ${id}
    `
    return rows[0] ? mapRepoEdge(rows[0]) : undefined
  }

  async listByRepo(repoId: string): Promise<RepoEdgeRow[]> {
    const rows = await this.sql<RawRepoEdge[]>`
      select id, repo_id, source_node_id, target_node_id, edge_type, confidence, payload, created_at
      from repo_edges where repo_id = ${repoId} order by created_at asc
    `
    return rows.map(mapRepoEdge)
  }

  async listFromSource(sourceNodeId: string): Promise<RepoEdgeRow[]> {
    const rows = await this.sql<RawRepoEdge[]>`
      select id, repo_id, source_node_id, target_node_id, edge_type, confidence, payload, created_at
      from repo_edges where source_node_id = ${sourceNodeId} order by created_at asc
    `
    return rows.map(mapRepoEdge)
  }

  async listToTarget(targetNodeId: string): Promise<RepoEdgeRow[]> {
    const rows = await this.sql<RawRepoEdge[]>`
      select id, repo_id, source_node_id, target_node_id, edge_type, confidence, payload, created_at
      from repo_edges where target_node_id = ${targetNodeId} order by created_at asc
    `
    return rows.map(mapRepoEdge)
  }
}
