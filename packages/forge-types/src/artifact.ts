/**
 * First-class reference to a concrete artifact that the reviewer can open.
 *
 * Promoted from `@forge/pr` (where it lived as a local type) so the rest of the
 * harness — belief graph, evidence ledger, verification planner, MCP server,
 * eval harness — can carry the same shape without circular imports.
 *
 * Two storage locations are supported:
 *
 *   - `path` — file is on disk under the worktree, typically under
 *     `.forge/artifacts/<taskId>/<id>.bin` (or a JSON sibling). The shape
 *     used by the agent loop's `compactToolResult()`.
 *   - `uri`  — file lives at an external location (CDN, S3, object store,
 *     signed URL, MCP resource). Use this for artifacts that are too large
 *     to inline, or that the harness never persisted locally.
 *
 * `path` and `uri` are mutually exclusive at the literal type level — pick
 * one. Either way, `id` is the stable identifier the harness uses to
 * reference the artifact in evidence, claim-evidence graphs, and PR body
 * links. `id` matches the on-disk filename when `path` is set, and matches
 * the resource id when `uri` is set.
 */
export type ArtifactRef =
  | {
      /** Stable identifier (sha256 or ULID). Matches the filename on disk. */
      id: string
      /**
       * Logical kind so reviewers know what they are looking at. Extends
       * `EvidenceKind` with the surface types the PR generator emits
       * (reviewer comments, human decisions, state dumps, diffs).
       */
      kind:
        | 'test_output'
        | 'command_output'
        | 'screenshot'
        | 'log'
        | 'diff'
        | 'reviewer_comment'
        | 'human_decision'
        | 'state_dump'
        | 'other'
      /** Relative path under `.forge/artifacts/` (worktree-relative). */
      path: string
      /** Optional human-readable title for the markdown link. */
      title?: string
      /** What this artifact proves or shows. */
      summary?: string
      /** MIME type when known (e.g. `text/plain`, `image/png`). */
      mime?: string
      /** Size in bytes; pre-computed so reviewers see the cost up front. */
      size?: number
      /** Content hash (sha256 hex) — matches `ArtifactRecord.contentHash`. */
      checksum?: string
    }
  | {
      /** Stable identifier (sha256 or ULID). Matches the remote resource id. */
      id: string
      kind:
        | 'test_output'
        | 'command_output'
        | 'screenshot'
        | 'log'
        | 'diff'
        | 'reviewer_comment'
        | 'human_decision'
        | 'state_dump'
        | 'other'
      /** External URI (CDN, S3, signed URL, MCP resource). */
      uri: string
      title?: string
      summary?: string
      mime?: string
      size?: number
      checksum?: string
    }

/** Narrowing helper — true when the ref points to a local file. */
export function isLocalArtifact(ref: ArtifactRef): ref is Extract<ArtifactRef, { path: string }> {
  return 'path' in ref
}

/** Narrowing helper — true when the ref points to a remote URI. */
export function isRemoteArtifact(ref: ArtifactRef): ref is Extract<ArtifactRef, { uri: string }> {
  return 'uri' in ref
}
