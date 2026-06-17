/**
 * Artifact store for Forge.
 *
 * Artifact bytes live on disk under
 * `<rootDir>/<taskId>/<relativePath>` (when a `taskId` is supplied) or
 * `<rootDir>/<relativePath>` (for repo-scoped artifacts). The metadata
 * row (sha256, size, mime, path, summary, …) lives in the `artifacts`
 * table in Postgres.
 *
 * The two-tier layout keeps Postgres small while preserving the exact
 * bytes for replay, debugging, and review. `getArtifact(id)` returns
 * both pieces so callers can verify content integrity against the
 * stored hash.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, extname, join } from 'node:path'
import type { ArtifactRepo, ArtifactRow } from './repos/commands.js'

export interface ArtifactStoreOptions {
  rootDir: string
  /** Source of metadata rows. Typically `store.repos.artifacts`. */
  artifacts: ArtifactRepo
  /**
   * Optional override for sha256 / mime / path computation. Most
   * callers leave this undefined and use the defaults.
   */
  now?: () => Date
}

/** Returned by `getArtifact`. */
export interface ArtifactWithBytes {
  metadata: ArtifactRow
  bytes: Buffer
}

export interface WriteArtifactOptions {
  taskId?: string
  artifactType: string
  relativePath: string
  /** Optional content-type. Derived from extension if omitted. */
  mime?: string
  summary?: string
  payload?: Record<string, unknown>
}

const DEFAULT_MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
}

function defaultMimeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  return DEFAULT_MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export class ArtifactStore {
  constructor(private options: ArtifactStoreOptions) {}

  get rootDir(): string {
    return this.options.rootDir
  }

  /**
   * Write bytes to disk and insert the matching metadata row in the
   * `artifacts` table. The insert happens inside the same database
   * the supplied `artifacts` repo uses, but for autocommit writes
   * outside a transaction there is no atomicity between the disk
   * write and the DB insert — callers that need exactly-once
   * semantics should wrap both in `store.tx(...)` and use the
   * `ArtifactStore.writeBytesForTx(...)` helper instead.
   */
  async write(opts: WriteArtifactOptions, content: string | Uint8Array): Promise<ArtifactWithBytes> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const absPath = this.absPathFor(opts.taskId, opts.relativePath)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, bytes)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const mime = opts.mime ?? defaultMimeFor(opts.relativePath)

    const row = await this.options.artifacts.insert({
      id: randomUUID(),
      taskId: opts.taskId ?? null,
      artifactType: opts.artifactType,
      path: absPath,
      contentHash: sha,
      sizeBytes: bytes.byteLength,
      mime,
      summary: opts.summary ?? null,
      payload: opts.payload ?? {},
    })
    return { metadata: row, bytes }
  }

  /**
   * Variant of `write(...)` for callers that already have an
   * ArtifactRepo bound to a specific transaction handle. Returns the
   * metadata row that the transaction just inserted; if the
   * surrounding transaction rolls back, the metadata row rolls back
   * with it (and the on-disk bytes become orphans for `pruneOrphans`).
   */
  async writeWithRepo(
    repo: ArtifactRepo,
    opts: WriteArtifactOptions,
    content: string | Uint8Array,
  ): Promise<ArtifactWithBytes> {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const absPath = this.absPathFor(opts.taskId, opts.relativePath)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, bytes)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const mime = opts.mime ?? defaultMimeFor(opts.relativePath)

    const row = await repo.insert({
      id: randomUUID(),
      taskId: opts.taskId ?? null,
      artifactType: opts.artifactType,
      path: absPath,
      contentHash: sha,
      sizeBytes: bytes.byteLength,
      mime,
      summary: opts.summary ?? null,
      payload: opts.payload ?? {},
    })
    return { metadata: row, bytes }
  }

  /**
   * Look up artifact metadata by id and read the bytes from disk.
   * Verifies the sha256 matches the stored `contentHash` and throws
   * if it doesn't — a hash mismatch indicates the on-disk file has
   * drifted from the metadata row and the artifact must be treated
   * as corrupt.
   */
  async get(id: string): Promise<ArtifactWithBytes | undefined> {
    const row = await this.options.artifacts.get(id)
    if (!row) return undefined
    const bytes = await readFile(row.path)
    if (row.contentHash) {
      const sha = createHash('sha256').update(bytes).digest('hex')
      if (sha !== row.contentHash) {
        throw new Error(
          `Artifact ${id} hash mismatch: stored=${row.contentHash} actual=${sha} (path=${row.path})`,
        )
      }
    }
    return { metadata: row, bytes }
  }

  /** Read bytes by absolute path. Skips the hash check. */
  async readBytesAt(absPath: string): Promise<Buffer> {
    return readFile(absPath)
  }

  /**
   * Find artifacts whose on-disk bytes exist under `rootDir` but have
   * no matching `artifacts` row in Postgres. Returns paths and sizes.
   */
  async orphans(): Promise<{ path: string; sizeBytes: number | null }[]> {
    return this.options.artifacts.listOrphanPaths(this.options.rootDir)
  }

  /**
   * Remove orphan bytes from disk. With `dryRun = true` (the default),
   * just lists what would be removed and returns it without touching
   * the filesystem — safer for the common "show me first" workflow.
   */
  async pruneOrphans(dryRun = true): Promise<{ removed: string[]; bytes: number }> {
    const list = await this.orphans()
    if (dryRun) {
      return {
        removed: list.map((o) => o.path),
        bytes: list.reduce((sum, o) => sum + (o.sizeBytes ?? 0), 0),
      }
    }
    const { unlink } = await import('node:fs/promises')
    let bytes = 0
    const removed: string[] = []
    for (const o of list) {
      try {
        await unlink(o.path)
        removed.push(o.path)
        bytes += o.sizeBytes ?? 0
      } catch {
        // best-effort: ignore ENOENT and permission errors
      }
    }
    return { removed, bytes }
  }

  async isWritable(): Promise<boolean> {
    const probe = join(this.options.rootDir, '.write-probe')
    try {
      await mkdir(dirname(probe), { recursive: true })
      await writeFile(probe, 'ok', 'utf-8')
      await stat(probe)
      return true
    } catch {
      return false
    }
  }

  private absPathFor(taskId: string | undefined, relativePath: string): string {
    const base = taskId ? join(this.options.rootDir, taskId) : this.options.rootDir
    return join(base, relativePath)
  }
}
