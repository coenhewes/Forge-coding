/**
 * Public surface for `@forge/state-store`.
 *
 * The two main exports are:
 *   - `ForgeStateStore` — the facade that owns the Postgres
 *     connection, runs migrations, exposes the typed repositories
 *     via `store.repos.*`, and offers the `store.tx(...)` wrapper
 *     that makes trace events co-transactional with writes.
 *   - `Repos` (and the individual repo classes) — typed CRUD over
 *     the schema. Each repo accepts a `postgres.js` `Sql` instance
 *     or a transaction handle from `sql.begin(...)`.
 */
export { REQUIRED_SCHEMA_VERSION, MIGRATIONS, fullSchemaSql } from './schema.js'
export type { Migration } from './schema.js'

export {
  ForgeStateStore,
  defaultStateStoreConfig,
  defaultStateDir,
} from './store.js'
export type { ForgeStateStoreOptions, StateRecord, TxContext } from './store.js'

export { ArtifactStore } from './artifact-store.js'
export type { ArtifactStoreOptions, ArtifactWithBytes, WriteArtifactOptions } from './artifact-store.js'

export { Repos } from './repos/index.js'
export * from './repos/index.js'
