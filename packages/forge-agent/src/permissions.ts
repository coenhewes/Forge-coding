/**
 * Permission engine — gates tool calls before they hit the executor.
 *
 * The engine evaluates a `PermissionRule[]` against every (toolName,
 * toolInput) pair. Rules are ordered: the first match wins. Default
 * rule set covers the "obvious" allow/deny/ask patterns called out in
 * the product brief:
 *
 *   - allow read_file anywhere
 *   - allow write_file in active domain's allowed_writes
 *   - ask run_command if command matches destructive patterns
 *   - deny anything outside active domains' allowed_writes
 *
 * In read-only modes (explore/review/research) the engine denies ALL
 * write tools regardless of path.
 *
 * The engine is intentionally pure — `evaluate()` returns a decision,
 * never throws. Callers can surface the decision to the user (via the
 * ask_question tool result) or short-circuit silently.
 */
import type { DomainManifest } from '@forge/types'

export type PermissionAction = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  /** Tool name to match (e.g. 'write_file', 'run_command', '*'). */
  tool: string
  /**
   * Optional glob pattern matched against the tool's `path` argument
   * (file tools) or `command` argument (run_command). Uses simple
   * `*` wildcards — no full glob syntax. A pattern of `*` matches all.
   */
  pattern?: string
  action: PermissionAction
  /** Human-readable explanation surfaced when the rule fires. */
  reason: string
}

export interface PermissionDecision {
  action: PermissionAction
  reason: string
  matchedRule: PermissionRule | null
}

export interface PermissionContext {
  /**
   * Active engineering domains. Their `allowedWrites` are used to
   * build dynamic allow rules for write_file/edit_file.
   */
  domains: DomainManifest[]
  /** True when the agent is in a read-only mode (plan/review/etc). */
  readOnly: boolean
}

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\bgit\s+push\b/,
  /\brm\s+-rf?\b/,
  /\bsudo\b/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bchmod\s+777\b/,
  /\bchown\s+-R\b/,
  /\bkill\s+-9\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bcurl\s+[^|]*\|\s*(?:sh|bash)\b/,
  /\bwget\s+[^|]*\|\s*(?:sh|bash)\b/,
]

/**
 * Match a simple `*`-wildcard pattern against a string. Returns true
 * when `pattern` is undefined or '*' (matches everything).
 */
export function matchPattern(pattern: string | undefined, value: string): boolean {
  if (!pattern || pattern === '*') return true
  // Convert glob to regex: `*` → `.*`, escape other regex chars.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

/** Test whether a shell command looks destructive. */
export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND_PATTERNS.some((re) => re.test(command))
}

export class PermissionEngine {
  private rules: PermissionRule[]

  constructor(rules: PermissionRule[]) {
    // Stable order — caller-supplied rules evaluate in the order given.
    this.rules = [...rules]
  }

  /** Add a rule at the END of the chain (lowest priority). */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule)
  }

  /**
   * Build a sensible default rule chain for a given context. The
   * chain is conservative — it never grants write access to paths
   * outside `allowedWrites`, and it asks for human approval before
   * running any destructive shell command.
   */
  static defaultRules(ctx: PermissionContext): PermissionRule[] {
    const rules: PermissionRule[] = []

    // 1. Read-only mode blanket-deny all write tools.
    if (ctx.readOnly) {
      rules.push({
        tool: 'write_file',
        pattern: '*',
        action: 'deny',
        reason: 'Read-only mode: write_file is disabled',
      })
      rules.push({
        tool: 'edit_file',
        pattern: '*',
        action: 'deny',
        reason: 'Read-only mode: edit_file is disabled',
      })
      rules.push({
        tool: 'run_command',
        pattern: '*',
        action: 'ask',
        reason: 'Read-only mode: shell access requires explicit approval',
      })
      // Reads are still allowed.
      rules.push({
        tool: 'read_file',
        pattern: '*',
        action: 'allow',
        reason: 'read_file is always allowed',
      })
      return rules
    }

    // 2. Reads are always allowed.
    rules.push({
      tool: 'read_file',
      pattern: '*',
      action: 'allow',
      reason: 'read_file is always allowed',
    })
    rules.push({
      tool: 'search_code',
      pattern: '*',
      action: 'allow',
      reason: 'search_code is always allowed',
    })
    rules.push({
      tool: 'glob_files',
      pattern: '*',
      action: 'allow',
      reason: 'glob_files is always allowed',
    })

    // 3. Non-destructive shell commands are allowed by default.
    //    Destructive ones are escalated to 'ask'.
    rules.push({
      tool: 'run_command',
      pattern: '*',
      action: 'allow',
      reason: 'Non-destructive shell command allowed',
    })

    // 4. Build allow rules from each active domain's `allowedWrites`.
    for (const domain of ctx.domains) {
      for (const allowed of domain.allowedWrites ?? []) {
        rules.push({
          tool: 'write_file',
          pattern: allowed,
          action: 'allow',
          reason: `write_file inside domain "${domain.domain}" allowedWrites`,
        })
        rules.push({
          tool: 'edit_file',
          pattern: allowed,
          action: 'allow',
          reason: `edit_file inside domain "${domain.domain}" allowedWrites`,
        })
      }
    }

    // 5. Default-deny: anything that didn't match an allow rule above.
    //    We achieve this by leaving the unmatched request to the chain's
    //    terminal rule, set below. Order matters — the caller can override
    //    by appending rules with `addRule`.

    return rules
  }

  /**
   * Evaluate a tool call against the rule chain. The first matching
   * rule decides. If no rule matches, the default is `deny` (fail-closed).
   *
   * Special-case: `run_command` always escalates to `ask` when the
   * command looks destructive — even if an `allow` rule matched.
   */
  evaluate(toolName: string, input: Record<string, unknown>): PermissionDecision {
    const candidate = pickPatternValue(toolName, input)
    if (toolName === 'run_command' && typeof candidate === 'string' && isDestructiveCommand(candidate)) {
      return {
        action: 'ask',
        reason: `Shell command matches a destructive pattern: ${candidate}`,
        matchedRule: null,
      }
    }
    for (const rule of this.rules) {
      if (rule.tool !== toolName && rule.tool !== '*') continue
      if (candidate === undefined) continue
      if (matchPattern(rule.pattern, candidate)) {
        return { action: rule.action, reason: rule.reason, matchedRule: rule }
      }
    }
    return {
      action: 'deny',
      reason: 'No rule matched (default deny)',
      matchedRule: null,
    }
  }
}

function pickPatternValue(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === 'run_command') return typeof input.command === 'string' ? input.command : undefined
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'read_file') {
    return typeof input.path === 'string' ? input.path : undefined
  }
  // For tools without a path/command, treat any call as pattern '*'.
  return '*'
}
