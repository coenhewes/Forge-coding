/**
 * Typed repository for `commands` and `artifacts`.
 *
 * Each command run is a row in `commands`; its stdout/stderr bytes live
 * as separate `artifacts` rows (with `artifact_type = 'stdout' |
 * 'stderr'`), and the command row holds the FK references. The
 * `artifacts` table also stores diffs, screenshots, and other binary
 * evidence — anything too large for Postgres proper but small enough
 * to keep on local disk.
 */
import { jsonArrayParam, jsonParam, type Db } from './base.js'

export interface CommandRow {
  id: string
  taskId: string
  command: string
  cwd: string | null
  status: string
  exitCode: number | null
  startedAt: string
  completedAt: string | null
  stdoutArtifactId: string | null
  stderrArtifactId: string | null
  summary: string | null
  payload: Record<string, unknown>
}

export interface ArtifactRow {
  id: string
  taskId: string | null
  artifactType: string
  path: string
  contentHash: string | null
  sizeBytes: number | null
  mime: string | null
  summary: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export type CommandInsert = Omit<CommandRow, 'completedAt'>
export type CommandUpdate = Partial<
  Pick<CommandRow, 'status' | 'exitCode' | 'completedAt' | 'stdoutArtifactId' | 'stderrArtifactId' | 'summary'>
>

export type ArtifactInsert = Omit<ArtifactRow, 'createdAt'>
export type ArtifactUpdate = Partial<Omit<ArtifactInsert, 'id'>>

interface RawCommand {
  id: string
  task_id: string
  command: string
  cwd: string | null
  status: string
  exit_code: number | null
  started_at: Date | string
  completed_at: Date | string | null
  stdout_artifact_id: string | null
  stderr_artifact_id: string | null
  summary: string | null
  payload: Record<string, unknown>
}

interface RawArtifact {
  id: string
  task_id: string | null
  artifact_type: string
  path: string
  content_hash: string | null
  size_bytes: number | string | null
  mime: string | null
  summary: string | null
  payload: Record<string, unknown>
  created_at: Date | string
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : value
}

function mapCommand(row: RawCommand): CommandRow {
  return {
    id: row.id,
    taskId: row.task_id,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    exitCode: row.exit_code,
    startedAt: toIso(row.started_at)!,
    completedAt: toIso(row.completed_at),
    stdoutArtifactId: row.stdout_artifact_id,
    stderrArtifactId: row.stderr_artifact_id,
    summary: row.summary,
    payload: row.payload ?? {},
  }
}

function mapArtifact(row: RawArtifact): ArtifactRow {
  const size = row.size_bytes
  return {
    id: row.id,
    taskId: row.task_id,
    artifactType: row.artifact_type,
    path: row.path,
    contentHash: row.content_hash,
    sizeBytes: size === null || size === undefined ? null : typeof size === 'string' ? Number(size) : size,
    mime: row.mime,
    summary: row.summary,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at)!,
  }
}

export class CommandRepo {
  constructor(private sql: Db) {}

  async insert(input: CommandInsert): Promise<CommandRow> {
    const rows = await this.sql<RawCommand[]>`
      insert into commands (
        id, task_id, command, cwd, status, exit_code,
        started_at, stdout_artifact_id, stderr_artifact_id, summary, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.command},
        ${input.cwd},
        ${input.status},
        ${input.exitCode},
        ${input.startedAt},
        ${input.stdoutArtifactId},
        ${input.stderrArtifactId},
        ${input.summary},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, command, cwd, status, exit_code, started_at, completed_at, stdout_artifact_id, stderr_artifact_id, summary, payload
    `
    return mapCommand(rows[0]!)
  }

  async update(id: string, patch: CommandUpdate): Promise<CommandRow> {
    const rows = await this.sql<RawCommand[]>`
      update commands
      set
        status = coalesce(${patch.status ?? null}, status),
        exit_code = coalesce(${patch.exitCode ?? null}, exit_code),
        completed_at = coalesce(${patch.completedAt ?? null}, completed_at),
        stdout_artifact_id = coalesce(${patch.stdoutArtifactId ?? null}, stdout_artifact_id),
        stderr_artifact_id = coalesce(${patch.stderrArtifactId ?? null}, stderr_artifact_id),
        summary = coalesce(${patch.summary ?? null}, summary)
      where id = ${id}
      returning id, task_id, command, cwd, status, exit_code, started_at, completed_at, stdout_artifact_id, stderr_artifact_id, summary, payload
    `
    if (!rows.length) throw new Error(`Command not found: ${id}`)
    return mapCommand(rows[0]!)
  }

  async get(id: string): Promise<CommandRow | undefined> {
    const rows = await this.sql<RawCommand[]>`
      select id, task_id, command, cwd, status, exit_code, started_at, completed_at, stdout_artifact_id, stderr_artifact_id, summary, payload
      from commands where id = ${id}
    `
    return rows[0] ? mapCommand(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<CommandRow[]> {
    const rows = await this.sql<RawCommand[]>`
      select id, task_id, command, cwd, status, exit_code, started_at, completed_at, stdout_artifact_id, stderr_artifact_id, summary, payload
      from commands where task_id = ${taskId} order by started_at asc
    `
    return rows.map(mapCommand)
  }

  async listByStatus(taskId: string, status: string): Promise<CommandRow[]> {
    const rows = await this.sql<RawCommand[]>`
      select id, task_id, command, cwd, status, exit_code, started_at, completed_at, stdout_artifact_id, stderr_artifact_id, summary, payload
      from commands where task_id = ${taskId} and status = ${status} order by started_at asc
    `
    return rows.map(mapCommand)
  }
}

export class ArtifactRepo {
  constructor(private sql: Db) {}

  async insert(input: ArtifactInsert): Promise<ArtifactRow> {
    const rows = await this.sql<RawArtifact[]>`
      insert into artifacts (
        id, task_id, artifact_type, path, content_hash, size_bytes,
        mime, summary, payload
      )
      values (
        ${input.id},
        ${input.taskId},
        ${input.artifactType},
        ${input.path},
        ${input.contentHash},
        ${input.sizeBytes},
        ${input.mime},
        ${input.summary},
        ${jsonParam(this.sql, input.payload)}::jsonb
      )
      returning id, task_id, artifact_type, path, content_hash, size_bytes, mime, summary, payload, created_at
    `
    return mapArtifact(rows[0]!)
  }

  async update(id: string, patch: ArtifactUpdate): Promise<ArtifactRow> {
    const rows = await this.sql<RawArtifact[]>`
      update artifacts
      set
        task_id = coalesce(${patch.taskId ?? null}, task_id),
        artifact_type = coalesce(${patch.artifactType ?? null}, artifact_type),
        path = coalesce(${patch.path ?? null}, path),
        content_hash = coalesce(${patch.contentHash ?? null}, content_hash),
        size_bytes = coalesce(${patch.sizeBytes ?? null}, size_bytes),
        mime = coalesce(${patch.mime ?? null}, mime),
        summary = coalesce(${patch.summary ?? null}, summary),
        payload = coalesce(${patch.payload ? jsonParam(this.sql, patch.payload) : null}::jsonb, payload)
      where id = ${id}
      returning id, task_id, artifact_type, path, content_hash, size_bytes, mime, summary, payload, created_at
    `
    if (!rows.length) throw new Error(`Artifact not found: ${id}`)
    return mapArtifact(rows[0]!)
  }

  async get(id: string): Promise<ArtifactRow | undefined> {
    const rows = await this.sql<RawArtifact[]>`
      select id, task_id, artifact_type, path, content_hash, size_bytes, mime, summary, payload, created_at
      from artifacts where id = ${id}
    `
    return rows[0] ? mapArtifact(rows[0]) : undefined
  }

  async listByTask(taskId: string): Promise<ArtifactRow[]> {
    const rows = await this.sql<RawArtifact[]>`
      select id, task_id, artifact_type, path, content_hash, size_bytes, mime, summary, payload, created_at
      from artifacts where task_id = ${taskId} order by created_at asc
    `
    return rows.map(mapArtifact)
  }

  async listByType(taskId: string, artifactType: string): Promise<ArtifactRow[]> {
    const rows = await this.sql<RawArtifact[]>`
      select id, task_id, artifact_type, path, content_hash, size_bytes, mime, summary, payload, created_at
      from artifacts where task_id = ${taskId} and artifact_type = ${artifactType}
      order by created_at asc
    `
    return rows.map(mapArtifact)
  }

  /**
   * Returns paths that exist on disk under `stateDir` but have no
   * matching `artifacts` row. Used by `ForgeStateStore.orphanArtifacts()`
   * to drive `pruneOrphans`.
   */
  async listOrphanPaths(stateDir: string): Promise<{ path: string; sizeBytes: number | null }[]> {
    const rows = await this.sql<{ path: string; size_bytes: number | string | null }[]>`
      select path, size_bytes from artifacts
    `
    const indexed = new Set(rows.map((r: { path: string }) => r.path))
    const orphans: { path: string; sizeBytes: number | null }[] = []
    const { readdir, stat } = await import('node:fs/promises')
    const { join } = await import('node:path')
    // Dirent is imported lazily here only — we don't want a top-level
    // node:fs import in this typed module just for one helper.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function walk(dir: string): Promise<void> {
      let entries: any[]
      try {
        entries = (await readdir(dir, { withFileTypes: true })) as any[]
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile() && !indexed.has(full)) {
          try {
            const st = await stat(full)
            orphans.push({ path: full, sizeBytes: st.size })
          } catch {
            orphans.push({ path: full, sizeBytes: null })
          }
        }
      }
    }
    await walk(stateDir)
    return orphans
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from artifacts where id = ${id} returning id
    `
    return rows.length > 0
  }
}
