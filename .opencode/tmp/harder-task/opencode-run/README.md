# codex_project_inspector

An MCP-style, agent-accessible tool that speaks **JSON-RPC 2.0 over stdio**.
It is self-contained and provides three callable tools:

| Tool                | Purpose                                                                            |
|---------------------|------------------------------------------------------------------------------------|
| `inspect_tree`      | Walk a directory tree (configurable depth) and return a compact JSON summary.     |
| `summarize_package` | Read `package.json` from a directory and return a structured package summary.      |
| `run_command_safe`  | Run a small allow-listed command (e.g. `ls`, `cat`, `node`, `npm`) with a timeout. |

The server is implemented in TypeScript, has no third-party runtime
dependencies, and is designed to be spawned by another coding agent over stdio.

## Project layout

```
.opencode/tmp/forge-long-horizon-mcp-tool-trial-2/
├── package.json
├── tsconfig.json
├── README.md
├── .gitignore
├── src/
│   ├── index.ts        # JSON-RPC dispatcher and stdio server
│   ├── tools.ts        # inspect_tree, summarize_package, run_command_safe
│   └── types.ts        # JSON-RPC type definitions
└── test/
    └── server.test.ts  # spawn-based JSON-RPC round-trip tests (no Playwright)
```

## Build

```bash
npm install        # install dev dependencies (typescript, tsx, @types/node)
npm run build      # compile TypeScript to dist/
```

## Run

The server is a plain stdio program. You normally don't run it by hand —
another agent spawns it as a child process. To try it interactively:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npm start
```

## Test

```bash
npm test
```

The test suite spawns the compiled server as a child process and exchanges
JSON-RPC messages with it on real stdio pipes. It does **not** use Playwright.

## JSON-RPC protocol

* One JSON object per line on stdin, one JSON object per line on stdout.
* Diagnostics go to **stderr** only.
* Standard JSON-RPC 2.0 envelopes (`jsonrpc`, `id`, `method`, `params`).
* Notifications (no `id`) are accepted but produce no response.

### Methods

* `initialize` — returns server info and capabilities.
* `ping` — returns `{ pong: true }`.
* `tools/list` — returns the list of tool definitions.
* `tools/call` — invokes a tool. Params shape:
  ```json
  { "name": "inspect_tree", "arguments": { "path": "/tmp", "maxDepth": 2 } }
  ```
* `shutdown` — replies, then exits cleanly.

### Tool error handling

Each tool handler returns either `{ ok: true, data }` or
`{ ok: false, error: { message, code? } }`. A tool-level error is reported
as a JSON-RPC error with code `-32603` (Internal error) and the original
`code` string included in `data.code`.

## Tool reference

### `inspect_tree`

```jsonc
{
  "path": "/abs/path",          // optional, defaults to CWD
  "maxDepth": 3,                 // 0..32, default 3
  "includeHidden": false         // default false
}
```

Returns:

```jsonc
{
  "root": "/abs/path",
  "entries": [
    { "name": "src", "type": "directory", "children": [...] },
    { "name": "package.json", "type": "file", "size": 736 }
  ],
  "truncated": false
}
```

### `summarize_package`

```jsonc
{
  "path": "/abs/path",                   // optional, defaults to CWD
  "maxDescriptionLength": 240             // 16..4000
}
```

Returns a `PackageSummary` with name, version, description, scripts,
dependencies, devDependencies, engines, license, plus `hasTsConfig`,
`hasReadme`, and `entryFile`.

### `run_command_safe`

```jsonc
{
  "command": "ls",                        // required, must be in allow-list
  "args": ["-la"],                        // optional string[]
  "cwd": "/abs/path",                     // optional
  "timeoutMs": 10000,                     // 1..60000, default 10000
  "maxOutputBytes": 16384                 // 64..1048576, default 16384
}
```

Returns:

```jsonc
{
  "command": "ls",
  "args": ["-la"],
  "cwd": "/abs/path",
  "exitCode": 0,
  "signal": null,
  "stdout": "...",
  "stderr": "",
  "timedOut": false,
  "durationMs": 12,
  "truncated": false
}
```

The allow-list includes: `ls cat head tail wc grep find echo pwd stat file
node npm npx pnpm yarn git tsc tsx jq tr cut sort uniq`. Arguments
containing shell metacharacters (`; & | ` $ < > \n \r \\`) are rejected.

## Example agent client (pseudocode)

```python
import json, subprocess

proc = subprocess.Popen(
    ["node", "dist/index.js"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)

def call(method, params=None, id=1):
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}}) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())

print(call("tools/list"))
print(call("tools/call", {"name": "inspect_tree", "arguments": {"maxDepth": 2}}))
```

## Why stdio JSON-RPC?

* It is the lowest-common-denominator transport: any agent that can spawn a
  process and read/write its stdio can use this server.
* One request, one response, one line each — easy to multiplex and log.
* The protocol is identical in spirit to MCP's stdio transport, so this
  server can be wrapped by an MCP adapter with no behavior changes.
