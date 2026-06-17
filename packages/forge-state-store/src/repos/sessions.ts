/**
 * Typed repository for `sessions` and `prompts`.
 *
 * Sessions capture a contiguous slice of work on a task — a run with a
 * specific model, a series of prompts and completions, and the
 * generated state changes. The `prompts` table stores the prompts
 * Forge actually sent to the model so we can replay them on resume
 * without re-reading the entire trace_events stream.
 *
 * Track 4 will add the `sessions` and `prompts` tables to the schema
 * migration. For now this module is a stub that returns `[]` so the
 * `ForgeStateStore` facade surface compiles. Track 4 replaces the
 * stubs with real migrations and CRUD.
 */
import type { Db } from './base.js'

export class SessionRepo {
  constructor(private sql: Db) {}

  /** @stub Returns `[]` — Track 4 will add the `sessions` table. */
  async listByTask(_taskId: string): Promise<unknown[]> {
    void this.sql
    return []
  }
}

export class PromptRepo {
  constructor(private sql: Db) {}

  /** @stub Returns `[]` — Track 4 will add the `prompts` table. */
  async listBySession(_sessionId: string): Promise<unknown[]> {
    void this.sql
    return []
  }
}
