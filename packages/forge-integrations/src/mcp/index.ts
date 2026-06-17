/**
 * MCP module — Forge acting as an MCP server (and a small client).
 *
 *   - `server.ts` — JSON-RPC 2.0 server over stdio. Exposes
 *     `task.get_current_state`, `belief.get_top_hypotheses`,
 *     `verification.plan_next_action`.
 *   - `client.ts` — JSON-RPC 2.0 client over stdio (spawns a
 *     `forge mcp serve` subprocess) plus an in-process client that
 *     drives the same surface without spawning a child.
 *
 * The CLI uses these in `packages/forge-cli/src/cli.ts`:
 *   - `forge mcp serve` — `runMcpServeFromEnv()`
 *   - `forge mcp list`  — `spawnStdioMcpClient(...)` + `listTools()`
 */
export * from './server.js'
export * from './client.js'
