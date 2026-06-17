/**
 * Shared types for the typed repositories under `@forge/state-store`.
 *
 * Every repository class accepts a `Sql` instance at construction. That
 * instance is either the live connection (for reads / autocommit writes)
 * or a transaction handle (for writes that must be co-transactional with
 * other state changes and trace events).
 *
 * The postgres.js library treats both the same way at the query level —
 * `tx.unsafe(...)` works on the connection just as well as it does inside
 * a `sql.begin` block — so repositories don't need to know which one they
 * got. This is the basis for the "co-transactional trace" guarantee in
 * `ForgeStateStore.tx`.
 */
/**
 * A postgres.js client OR a transaction handle returned by `sql.begin`.
 * Both implement the `ISql` query surface (select/insert/unsafe/json/
 * begin), so repositories can be constructed against either — that's
 * the basis for the co-transactional trace guarantee in
 * `ForgeStateStore.tx`.
 *
 * We deliberately type this as `any` here. The upstream `Sql` and
 * `TransactionSql` types differ in their `types` parameterisation and
 * TypeScript can't unify them; using `any` lets the same repository
 * class accept either without unsafe casts at every call site. Runtime
 * correctness is enforced by postgres.js, and the repository methods
 * only ever use the documented query surface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any

/**
 * Mirror of postgres.js's `JSONValue` type, but exposed under our own
 * name so callers and tests can name the contract without importing the
 * third-party types. We use it everywhere a JSONB payload is accepted.
 */
export type JsonValue =
  | null
  | string
  | number
  | boolean
  | Date
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }

/** `Record<string, unknown>` shim that the postgres driver accepts. */
export type JsonObject = { [key: string]: JsonValue | undefined }

/**
 * Subset of options every repository recognises. Most methods only need
 * the connection (held on the instance). The optional `now` lets callers
 * override the timestamp used for `created_at` / `updated_at` columns —
 * useful for deterministic tests.
 */
export interface RepoBaseOptions {
  now?: () => Date
}

export interface TraceEventInput {
  type: string
  taskId?: string | null
  repoId?: string | null
  actor?: string
  summary: string
  payload?: Record<string, unknown>
}

/**
 * Trace helper bound to a single transaction. The store facade exposes
 * `tx.trace(event)` so callers never have to write raw SQL for the
 * trace_events table — and so the trace row lives or dies with the
 * surrounding transaction.
 */
export interface TraceWriter {
  trace(event: TraceEventInput): Promise<{ id: string; createdAt: string }>
}

/**
 * Cast a `Record<string, unknown>` (the ergonomic shape callers use)
 * into the `JSONValue` postgres.js requires. We trust the runtime
 * payload to be JSON-serialisable — postgres.js will throw at execute
 * time if a value is actually non-serialisable, which is the right
 * failure mode.
 */
export function toJsonb(value: Record<string, unknown> | null | undefined): JsonValue {
  if (value === null || value === undefined) return {}
  return value as unknown as JsonValue
}

/**
 * Cast an array of `Record<string, unknown>` (or string) into JSON.
 * Used for the array-typed JSONB columns on `decisions`, `hypotheses`,
 * etc.
 */
export function toJsonbArray<T>(value: readonly T[] | null | undefined): JsonValue[] {
  if (!value) return []
  return value as unknown as JsonValue[]
}

/**
 * `sql.json(...)` requires postgres.js's internal `JSONValue` type. The
 * repos accept `Record<string, unknown>` from callers (the ergonomic
 * shape) and need a single place to convert. We use a small `any` cast
 * at the boundary — the runtime values are JSON-serialisable plain
 * objects in every supported caller path, and postgres.js will throw
 * at execute time if a value is actually non-serialisable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jsonParam(sql: Db, value: Record<string, unknown> | null | undefined): any {
  return sql.json(toJsonb(value) as any)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jsonArrayParam<T>(sql: Db, value: readonly T[] | null | undefined): any {
  return sql.json(toJsonbArray(value) as any)
}
