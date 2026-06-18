/**
 * Shared output helper for the Forge CLI.
 *
 * Each command produces a {@link CommandResult} that bundles:
 *   - the structured data the command wants to expose (e.g. the
 *     task list, evidence entries, doctor probe results), and
 *   - a list of text lines for human-readable output.
 *
 * `emit()` decides whether to print JSON or text based on the
 * `--json` / `--text` flags parsed out of the argv. `--text` is the
 * default when neither flag is present. `--json` makes the command
 * output a single JSON object to stdout (pretty-printed when
 * stdout is a TTY, compact when piped). Exit codes come from
 * `result.exitCode`; tests assert against `result` directly without
 * touching stdio.
 *
 * This split keeps every command unit-testable: the command body
 * does not call `process.exit` or `console.log`; it only returns a
 * {@link CommandResult}. The CLI dispatcher and tests are the only
 * places that decide how to render.
 */

export interface CommandResult<T = unknown> {
  /** True if the command succeeded. */
  ok: boolean
  /** Process exit code. 0 on success, non-zero on error. */
  exitCode: number
  /** Structured payload — emitted as JSON when --json is set. */
  data?: T
  /** Optional message describing success/failure when --text mode. */
  message?: string
  /** Pre-formatted text lines for human-readable output. */
  textLines?: string[]
  /** Per-line log lines (printed to stderr in text mode). */
  logLines?: string[]
}

export interface ParsedArgs {
  /** Original argv minus the subcommand name. */
  args: string[]
  /** True if --json was passed. */
  json: boolean
  /** True if --text was passed. */
  text: boolean
  /** Map of `--flag value` pairs. */
  options: Map<string, string>
  /** Positional arguments. */
  positional: string[]
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv]
  let json = false
  let text = false
  const options = new Map<string, string>()
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--json') {
      json = true
      continue
    }
    if (a === '--text') {
      text = true
      continue
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        const k = a.slice(2, eq)
        const v = a.slice(eq + 1)
        options.set(k, v)
      } else {
        const k = a.slice(2)
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          options.set(k, next)
          i++
        } else {
          options.set(k, 'true')
        }
      }
      continue
    }
    positional.push(a)
  }

  return { args, json, text, options, positional }
}

export function getOption(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.options.get(name)
}

export function getOptionWithDefault(parsed: ParsedArgs, name: string, fallback: string): string {
  return parsed.options.get(name) ?? fallback
}

/**
 * Format a {@link CommandResult} for the chosen output mode and
 * print it. Returns the result so the caller can `process.exit`
 * with the right code.
 *
 * In `--json` mode, prints a single JSON object to stdout.
 * In `--text` mode (default), prints `textLines` to stdout and
 * `logLines` to stderr, falling back to `message` when no text
 * is provided.
 */
export function emit(result: CommandResult<unknown>, parsed: ParsedArgs): CommandResult<unknown> {
  if (parsed.json) {
    const payload = {
      ok: result.ok,
      exitCode: result.exitCode,
      ...(result.message !== undefined ? { message: result.message } : {}),
      ...(result.data !== undefined ? { data: result.data } : {}),
    }
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  } else {
    const lines = result.textLines ?? (result.message !== undefined ? [result.message] : [])
    if (lines.length > 0) {
      process.stdout.write(lines.join('\n') + '\n')
    }
    if (result.logLines && result.logLines.length > 0) {
      process.stderr.write(result.logLines.join('\n') + '\n')
    }
  }
  return result
}
