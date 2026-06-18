/**
 * Live run renderer — turns the agent's `onEvent` stream into a readable,
 * opencode-inspired live view for `forge run`. Without this, `forge run` is
 * silent until the end, which is unusable for long-horizon runs.
 *
 * Writes to stderr (so `--json` stdout stays clean). Uses concise, color-coded
 * lines: a stage header, three-state tool rendering (pending → done/error),
 * trimmed model thoughts, and errors.
 */
import type { AgentEvent } from '@forge/agent'

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
}

const STAGE_COLOR: Record<string, string> = {
  LOCALIZE: C.cyan,
  PROBE: C.magenta,
  EDIT: C.green,
  VERIFY: C.yellow,
  REPAIR: C.red,
  FINALIZE: C.bold + C.green,
}

const TOOL_ICON: Record<string, string> = {
  read_file: '→',
  write_file: '✎',
  edit_file: '✎',
  run_command: '$',
  run_tests: '✓',
  run_verification: '✓',
  search_code: '⌕',
  glob_files: '⌕',
  add_acceptance_criterion: '◈',
  add_subtask: '☐',
  complete_subtask: '☑',
  update_acceptance: '◆',
  record_evidence: '※',
  record_failure: '⚠',
  create_checkpoint: '⚑',
  finish_task: '★',
}

export function createRunRenderer(enabled: boolean): (e: AgentEvent) => void {
  if (!enabled) return () => {}
  const w = (s: string) => process.stderr.write(s + '\n')
  return (e: AgentEvent) => {
    switch (e.type) {
      case 'stage': {
        const color = STAGE_COLOR[e.stage ?? ''] ?? C.cyan
        w(`\n${color}● ${e.stage}${C.reset} ${C.gray}#${e.iteration}${C.reset}`)
        break
      }
      case 'tool_call': {
        const icon = TOOL_ICON[e.toolName ?? ''] ?? '•'
        const detail = (e.detail ?? '').replace(/\s+/g, ' ').slice(0, 100)
        w(`  ${C.dim}${icon} ${e.toolName}${C.reset} ${C.gray}${detail}${C.reset}`)
        break
      }
      case 'tool_result': {
        w(`    ${C.gray}↳ ${e.message}${C.reset}`)
        break
      }
      case 'thinking': {
        const first = String(e.message ?? '').split('\n').find((l) => l.trim()) ?? ''
        if (first) w(`  ${C.gray}${first.slice(0, 120)}${C.reset}`)
        break
      }
      case 'error': {
        w(`  ${C.red}✗ ${e.message}${C.reset}`)
        break
      }
      case 'status': {
        if (e.message) w(`  ${C.gray}${e.message}${C.reset}`)
        break
      }
    }
  }
}
