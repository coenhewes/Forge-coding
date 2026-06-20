import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

/**
 * Tool result envelope. All tool methods return either
 * `{ ok: true, data }` or `{ ok: false, error: { message, code? } }`.
 */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; code?: string } };

// ---------------------------------------------------------------------------
// inspect_tree
// ---------------------------------------------------------------------------

export interface InspectTreeParams {
  /** Absolute path to the directory to inspect. Defaults to the agent's CWD. */
  path?: string;
  /** Maximum recursion depth. Defaults to 3. */
  maxDepth?: number;
  /** If true, hidden files (dotfiles) are included. Defaults to false. */
  includeHidden?: boolean;
}

export interface TreeEntry {
  name: string;
  /** "file" or "directory" */
  type: "file" | "directory";
  /** Size in bytes (files only). */
  size?: number;
  children?: TreeEntry[];
}

export interface InspectTreeResult {
  root: string;
  entries: TreeEntry[];
  truncated: boolean;
}

async function buildTree(
  dir: string,
  currentDepth: number,
  maxDepth: number,
  includeHidden: boolean
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  let truncated = false;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    throw new Error(
      `inspect_tree: cannot read directory '${dir}': ${(err as Error).message}`
    );
  }

  const filtered = includeHidden
    ? names
    : names.filter((n) => !n.startsWith("."));

  filtered.sort();

  const entries: TreeEntry[] = [];
  for (const name of filtered) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (currentDepth >= maxDepth) {
        entries.push({ name, type: "directory" });
        truncated = true;
        continue;
      }
      const sub = await buildTree(full, currentDepth + 1, maxDepth, includeHidden);
      if (sub.truncated) truncated = true;
      entries.push({ name, type: "directory", children: sub.entries });
    } else if (stat.isFile()) {
      entries.push({ name, type: "file", size: stat.size });
    }
  }
  return { entries, truncated };
}

export async function inspectTree(
  params: InspectTreeParams
): Promise<ToolResult<InspectTreeResult>> {
  const root = params?.path ? path.resolve(params.path) : process.cwd();
  const maxDepth = params?.maxDepth ?? 3;
  const includeHidden = params?.includeHidden ?? false;

  if (typeof maxDepth !== "number" || maxDepth < 0 || maxDepth > 32) {
    return {
      ok: false,
      error: {
        code: "INVALID_PARAM",
        message: "maxDepth must be a number between 0 and 32",
      },
    };
  }

  let stat;
  try {
    stat = await fs.stat(root);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `inspect_tree: path does not exist: '${root}' (${(err as Error).message})`,
      },
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: {
        code: "NOT_A_DIRECTORY",
        message: `inspect_tree: path is not a directory: '${root}'`,
      },
    };
  }

  try {
    const { entries, truncated } = await buildTree(
      root,
      0,
      maxDepth,
      includeHidden
    );
    return {
      ok: true,
      data: { root, entries, truncated },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "READ_ERROR",
        message: (err as Error).message,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// summarize_package
// ---------------------------------------------------------------------------

export interface SummarizePackageParams {
  /** Absolute path to the directory containing a package.json. */
  path?: string;
  /** Optional max length of the description in the summary. */
  maxDescriptionLength?: number;
}

export interface PackageSummary {
  name: string;
  version: string;
  description?: string;
  descriptionTruncated?: boolean;
  main?: string;
  bin?: Record<string, string> | string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines?: Record<string, string>;
  type?: string;
  license?: string;
  hasTsConfig: boolean;
  hasReadme: boolean;
  entryFile?: string;
}

async function readJsonSafe<T = unknown>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): { value: string; truncated: boolean } {
  if (s.length <= max) return { value: s, truncated: false };
  return { value: s.slice(0, Math.max(0, max - 1)) + "\u2026", truncated: true };
}

export async function summarizePackage(
  params: SummarizePackageParams
): Promise<ToolResult<PackageSummary>> {
  const dir = params?.path ? path.resolve(params.path) : process.cwd();
  const maxLen = params?.maxDescriptionLength ?? 240;

  const pkgPath = path.join(dir, "package.json");
  const pkg = await readJsonSafe<Record<string, unknown>>(pkgPath);
  if (!pkg) {
    return {
      ok: false,
      error: {
        code: "PACKAGE_JSON_MISSING",
        message: `summarize_package: no readable package.json at '${pkgPath}'`,
      },
    };
  }

  const name = typeof pkg.name === "string" ? pkg.name : "(unnamed)";
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";

  let description: string | undefined;
  let descriptionTruncated: boolean | undefined;
  if (typeof pkg.description === "string") {
    const t = truncate(pkg.description, maxLen);
    description = t.value;
    descriptionTruncated = t.truncated;
  }

  const main = typeof pkg.main === "string" ? pkg.main : undefined;
  const bin =
    typeof pkg.bin === "string" || (pkg.bin && typeof pkg.bin === "object")
      ? (pkg.bin as Record<string, string> | string)
      : undefined;

  const scripts =
    pkg.scripts && typeof pkg.scripts === "object"
      ? (pkg.scripts as Record<string, string>)
      : {};
  const dependencies =
    pkg.dependencies && typeof pkg.dependencies === "object"
      ? (pkg.dependencies as Record<string, string>)
      : {};
  const devDependencies =
    pkg.devDependencies && typeof pkg.devDependencies === "object"
      ? (pkg.devDependencies as Record<string, string>)
      : {};
  const engines =
    pkg.engines && typeof pkg.engines === "object"
      ? (pkg.engines as Record<string, string>)
      : undefined;
  const type = typeof pkg.type === "string" ? pkg.type : undefined;
  const license = typeof pkg.license === "string" ? pkg.license : undefined;

  // Probe for tsconfig and README.
  const [hasTsConfig, hasReadme] = await Promise.all([
    readJsonSafe(path.join(dir, "tsconfig.json")).then((v) => v !== null),
    (async () => {
      for (const name of ["README.md", "README.MD", "README", "readme.md"]) {
        try {
          await fs.access(path.join(dir, name));
          return true;
        } catch {
          /* try next */
        }
      }
      return false;
    })(),
  ]);

  const entryFile =
    main && typeof main === "string"
      ? main
      : typeof bin === "string"
        ? bin
        : undefined;

  const summary: PackageSummary = {
    name,
    version,
    description,
    descriptionTruncated,
    main,
    bin,
    scripts,
    dependencies,
    devDependencies,
    engines,
    type,
    license,
    hasTsConfig,
    hasReadme,
    entryFile,
  };
  return { ok: true, data: summary };
}

// ---------------------------------------------------------------------------
// run_command_safe
// ---------------------------------------------------------------------------

export interface RunCommandSafeParams {
  /** The executable to run (resolved against PATH and common bin dirs). */
  command: string;
  /** Arguments to pass. */
  args?: string[];
  /** Working directory. Defaults to the current working directory. */
  cwd?: string;
  /** Timeout in milliseconds. Defaults to 10_000. Hard cap of 60_000. */
  timeoutMs?: number;
  /** Maximum bytes of stdout to capture. Defaults to 16_384, hard cap 1_048_576. */
  maxOutputBytes?: number;
}

export interface RunCommandSafeResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

/**
 * A small allow-list to keep this tool safe for agent use. We resolve
 * the executable against PATH, but only allow running common, low-risk
 * utilities that agents typically need (ls, cat, head, grep, node, npm,
 * etc). Direct shell metacharacters in args are also rejected.
 */
const COMMAND_ALLOWLIST = new Set<string>([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "find",
  "echo",
  "pwd",
  "stat",
  "file",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "git",
  "tsc",
  "tsx",
  "jq",
  "tr",
  "cut",
  "sort",
  "uniq",
]);

const SHELL_METACHARS = /[;&|`$<>\n\r\\]/;

function resolveExecutable(name: string): string | null {
  if (name.includes("/")) return name; // explicit path
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  // Also check the standard node_modules/.bin locations relative to cwd.
  dirs.push(
    path.join(process.cwd(), "node_modules", ".bin"),
    path.join(process.cwd(), ".opencode", "tmp", "node_modules", ".bin")
  );
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    // We can't stat synchronously here easily without blocking; the
    // spawn ENOENT error will give a clear message if it's missing.
    // We still try to verify with fs.existsSync to give a friendlier error.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fsSync = require("node:fs");
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function runCommandSafe(
  params: RunCommandSafeParams
): Promise<ToolResult<RunCommandSafeResult>> {
  if (!params || typeof params.command !== "string" || !params.command) {
    return {
      ok: false,
      error: { code: "INVALID_PARAM", message: "command is required" },
    };
  }
  const command = params.command;
  const args = Array.isArray(params.args) ? params.args.map(String) : [];
  const cwd = params.cwd ? path.resolve(params.cwd) : process.cwd();
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 10_000, 1), 60_000);
  const maxOutputBytes = Math.min(
    Math.max(params.maxOutputBytes ?? 16_384, 64),
    1_048_576
  );

  if (!COMMAND_ALLOWLIST.has(command)) {
    return {
      ok: false,
      error: {
        code: "COMMAND_NOT_ALLOWED",
        message: `run_command_safe: command '${command}' is not in the allow-list`,
      },
    };
  }
  for (const a of args) {
    if (SHELL_METACHARS.test(a)) {
      return {
        ok: false,
        error: {
          code: "SHELL_METACHARS_NOT_ALLOWED",
          message: `run_command_safe: argument contains shell metacharacter: '${a}'`,
        },
      };
    }
  }

  const resolved = resolveExecutable(command);
  if (!resolved) {
    return {
      ok: false,
      error: {
        code: "COMMAND_NOT_FOUND",
        message: `run_command_safe: could not resolve '${command}' on PATH`,
      },
    };
  }

  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    let child;
    try {
      child = spawn(resolved, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        ok: false,
        error: {
          code: "SPAWN_ERROR",
          message: `run_command_safe: failed to spawn '${command}': ${(err as Error).message}`,
        },
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxOutputBytes) {
        const room = maxOutputBytes - stdout.length;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        stdout += slice.toString("utf8");
        if (chunk.length > room) truncated = true;
      } else {
        truncated = true;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxOutputBytes) {
        const room = maxOutputBytes - stderr.length;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        stderr += slice.toString("utf8");
        if (chunk.length > room) truncated = true;
      } else {
        truncated = true;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: {
          code: "SPAWN_ERROR",
          message: `run_command_safe: '${command}' errored: ${err.message}`,
        },
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: true,
        data: {
          command,
          args,
          cwd,
          exitCode: code,
          signal: signal as NodeJS.Signals | null,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - start,
          truncated,
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export interface ToolDefinition<P, R> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: P) => Promise<ToolResult<R>>;
}

export const TOOLS = {
  inspect_tree: {
    name: "inspect_tree",
    description:
      "Walk a directory tree up to a configurable depth and return a compact, JSON-friendly summary of files and directories. Hidden files (dotfiles) are skipped unless includeHidden is true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to inspect. Defaults to CWD." },
        maxDepth: {
          type: "integer",
          minimum: 0,
          maximum: 32,
          description: "Maximum recursion depth. Default 3.",
        },
        includeHidden: {
          type: "boolean",
          description: "Include dotfiles. Default false.",
        },
      },
    },
    handler: inspectTree,
  } as ToolDefinition<InspectTreeParams, InspectTreeResult>,
  summarize_package: {
    name: "summarize_package",
    description:
      "Read package.json from a directory and return a structured summary including scripts, dependencies, devDependencies, engines, license, and whether tsconfig/README exist.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory containing package.json. Defaults to CWD." },
        maxDescriptionLength: {
          type: "integer",
          minimum: 16,
          maximum: 4000,
          description: "Cap on description length. Default 240.",
        },
      },
    },
    handler: summarizePackage,
  } as ToolDefinition<SummarizePackageParams, PackageSummary>,
  run_command_safe: {
    name: "run_command_safe",
    description:
      "Run a small set of allow-listed commands (ls, cat, grep, node, npm, etc.) with a timeout and output cap. Arguments containing shell metacharacters are rejected.",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "Executable name. Must be in allow-list." },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string", description: "Working directory. Defaults to CWD." },
        timeoutMs: { type: "integer", minimum: 1, maximum: 60000, description: "Timeout in ms. Default 10000." },
        maxOutputBytes: { type: "integer", minimum: 64, maximum: 1048576, description: "Max stdout+stderr captured. Default 16384." },
      },
    },
    handler: runCommandSafe,
  } as ToolDefinition<RunCommandSafeParams, RunCommandSafeResult>,
} as const;

export type ToolName = keyof typeof TOOLS;

export function listToolNames(): string[] {
  return Object.keys(TOOLS);
}
