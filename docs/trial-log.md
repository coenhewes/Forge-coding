# Live Trial Log

This page records live attempts to run Forge as a long-horizon coding agent from a blank directory to a usable project.

## Environment

- Date: 2026-06-20
- Machine: 32 GB Apple Silicon M4 Mac mini
- Main model: MiniMax M3 from the project `.env` / `.forge/config.json`
- Local models: Ollama through Forge local-model layer
- State store: local Postgres at `localhost:54329`
- Target style: agent-accessible stdio JSON-RPC tool, avoiding browser or Playwright brittleness

## Preflight Results

Verified before the trial:

```bash
node -r dotenv/config packages/forge-cli/dist/cli.js doctor
node -r dotenv/config packages/forge-cli/dist/cli.js local test
node -r dotenv/config packages/forge-cli/dist/cli.js providers test minimax
```

Results:

- Postgres reachable and schema v4 healthy.
- State store reported 34 tables present.
- MiniMax provider models endpoint returned 200 through Forge.
- Ollama local model layer used real local summarize and embeddings with no fallback.

## Trial 1: Blank Directory MCP-Style Tool

Prompt target:

```text
Build an agent-accessible MCP-style JSON-RPC stdio server from a blank directory.
Expose inspect_tree, summarize_package, and run_command_safe.
Include package.json, TypeScript source, README, and node:test coverage.
Verify npm install, npm run build, and npm test.
```

Generated project:

```text
.opencode/tmp/forge-long-horizon-mcp-tool-trial-2
```

Outcome:

- Forge created a complete TypeScript package.
- `npm run build` passed.
- `npm test` passed: 11/11 tests.
- Manual Codex smoke confirmed `initialize` and `tools/list` worked over stdio.
- Manual pipelined smoke exposed a quality bug: `shutdown` could exit before earlier async tool calls completed.

Quality rating:

```text
7/10
```

Why not higher:

- The project was real, built, and tested.
- The tests were meaningful but missed pipelined stdio ordering.
- Forge blocked on a safe manual smoke command because permission detection treated quoted JSON `"shutdown"` as a destructive shell command.
- Resume worked, but spent too many turns rediscovering already-known files instead of following the blocked next action directly.
- Semantic probe selection was noisy for a blank tmp project.

## Harness Issues Found and Fixed

1. `forge doctor` checked stale table names.
   - Fixed required table list to match the current Postgres schema.

2. Local model smoke was too brittle.
   - Default local instruct model changed to an installed lighter Ollama model.
   - Timeout increased.
   - Summary parser now accepts useful plain text from local models that ignore JSON formatting.

3. `ask_question` blocked all autonomy.
   - Low/medium-risk questions now record the recommended default as a durable decision and continue.
   - High/critical or explicitly human-required questions still block.

4. Probe IDs crashed Postgres.
   - Planner probe IDs remain semantic in payload.
   - Durable probe rows now use stable UUIDs.
   - Probe persistence failure records a failure lesson instead of crashing the run.

5. `write_file` could not create nested files in a blank directory.
   - `write_file` now creates parent directories before writing.
   - Added regression coverage.

6. Safe JSON-RPC smoke command was misclassified as destructive.
   - Permission classifier now strips quoted shell payloads before matching destructive command names.
   - `bash -c` / `sh -c` remains approval-required.

7. `retrieve_artifact` was denied.
   - Added it to default read-only evidence access permissions.

8. Resume import hit stale build output.
   - Clean rebuild of `@forge/integrations` restored missing `dist/mcp/server.js`.

## Harder Task Designed

The next task should improve the generated MCP-style tool:

```text
Fix pipelined JSON-RPC request ordering. When initialize, tools/list,
tools/call, run_command_safe, and shutdown are written to stdin in one burst,
all prior responses must be emitted before shutdown exits.

Implement a serialized request queue or equivalent.
Add a node:test case that writes all requests without awaiting and asserts
responses for ids 1 through 5.
Run npm run build, npm test, and the manual pipeline smoke.
```

This is a better quality gate than screenshot/browser tests because another coding agent can exercise it directly through stdio.

## Blocked Comparison

`opencode` is installed locally:

```text
opencode 1.4.0
```

The planned side-by-side comparison is:

1. Run Forge on the harder pipelined-stdio task using MiniMax M3.
2. Run `opencode run` on the same task and target directory using the same main model.
3. Score both on:
   - task completion
   - tests added
   - behavioral correctness under manual stdio smoke
   - repair loop quality
   - amount of redundant rediscovery
   - clarity of final evidence

The actual harder Forge rerun was blocked by the app approval-credit gate before execution. It should be rerun once escalation is available again.

## Current Evidence Commands

Commands that passed:

```bash
pnpm test
pnpm -r typecheck
pnpm vitest run tests/agent-loop.test.ts tests/retrieve-artifact-tool.test.ts
cd .opencode/tmp/forge-long-horizon-mcp-tool-trial-2 && npm run build && npm test
```

Manual smoke that exposed the generated-tool quality gap:

```bash
cd .opencode/tmp/forge-long-horizon-mcp-tool-trial-2
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"inspect_tree","arguments":{"path":".","maxDepth":1}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"run_command_safe","arguments":{"command":"node","args":["-e","process.stdout.write(\"hello\")"]}}}' \
  '{"jsonrpc":"2.0","id":5,"method":"shutdown"}' \
  | node dist/index.js
```

Expected for the harder task: responses for ids 1, 2, 3, 4, and 5 before exit.
