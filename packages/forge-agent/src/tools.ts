import { readFile, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import type { ToolDefinition, ToolCall, EvidenceKind, TaskStatus } from '@forge/types'
import type { TaskStateEngine } from '@forge/state'
import type { AcceptanceContractEngine } from '@forge/state'
import type { EvidenceLedgerEngine } from '@forge/state'
import type { FailureLedgerEngine } from '@forge/state'
import type { DecisionLedgerEngine } from '@forge/state'
import type { VerificationMatrixEngine } from '@forge/verification'
import type { CheckpointManager } from '@forge/verification'

export type ToolHandler = (
  input: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<{ content: string; metadata?: Record<string, unknown> }>

export interface ToolExecutionContext {
  workDir: string
  repoMap?: import('@forge/types').RepoMap
  repoGraph?: import('@forge/types').RepoGraph
  domainManifests?: import('@forge/types').DomainManifest[]
  taskId: string
  taskEngine: TaskStateEngine
  acceptanceEngine: AcceptanceContractEngine
  evidenceEngine: EvidenceLedgerEngine
  failureEngine: FailureLedgerEngine
  decisionEngine: DecisionLedgerEngine
  verificationEngine: VerificationMatrixEngine
  checkpointManager: CheckpointManager
}

export function createToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file from the repository. Returns content with line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from repo root' },
          offset: { type: 'number', description: 'Starting line (1-indexed)', default: 1 },
          limit: { type: 'number', description: 'Max lines to read', default: 100 },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file. Overwrites existing content.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from repo root' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Apply a surgical text replacement in a file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from repo root' },
          old_string: { type: 'string', description: 'Text to replace (must exist exactly once)' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'search_code',
      description: 'Search file contents using a regex pattern. Returns matching files and line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          include: { type: 'string', description: 'File glob pattern (e.g. "*.ts")' },
          max_results: { type: 'number', description: 'Max results to return', default: 30 },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'glob_files',
      description: 'Find files by glob pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts")' },
          max_results: { type: 'number', description: 'Max results to return', default: 50 },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'run_command',
      description: 'Run a shell command in the repo root. Use for build, test, lint, typecheck, and git operations.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          description: { type: 'string', description: 'Brief description of what this does' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds', default: 60000 },
        },
        required: ['command', 'description'],
      },
    },
    {
      name: 'create_checkpoint',
      description: 'Create a checkpoint before making risky changes. Lets you roll back if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          hypothesis: { type: 'string', description: 'What you expect to achieve' },
          files_changed: { type: 'array', items: { type: 'string' }, description: 'Files you plan to change' },
          reason: { type: 'string', description: 'Why this change is needed' },
          risk_assessment: { type: 'string', description: 'Risk level and reasoning' },
        },
        required: ['hypothesis', 'files_changed', 'reason'],
      },
    },
    {
      name: 'record_evidence',
      description: 'Record a claim with supporting evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          claim: { type: 'string', description: 'The claim being made' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence strings or references' },
          kind: { type: 'string', description: 'Kind of evidence', enum: ['observed_fact', 'inferred_fact', 'test_result', 'code_change', 'runtime_output'] },
          source: { type: 'string', description: 'Source of the evidence' },
        },
        required: ['claim', 'evidence'],
      },
    },
    {
      name: 'record_failure',
      description: 'Record a failed hypothesis so you avoid repeating it.',
      inputSchema: {
        type: 'object',
        properties: {
          hypothesis: { type: 'string', description: 'What was tried' },
          action: { type: 'string', description: 'What was done' },
          result: { type: 'string', description: 'What happened' },
          lesson: { type: 'string', description: 'Why it failed and what it proves' },
          next_hypothesis: { type: 'string', description: 'What to try next instead' },
        },
        required: ['hypothesis', 'action', 'result', 'lesson'],
      },
    },
    {
      name: 'get_failure_reflection',
      description: 'Check if a hypothesis has already failed. Use before trying something.',
      inputSchema: {
        type: 'object',
        properties: {
          hypothesis: { type: 'string', description: 'The hypothesis to check' },
        },
        required: ['hypothesis'],
      },
    },
    {
      name: 'record_decision',
      description: 'Record an important engineering decision.',
      inputSchema: {
        type: 'object',
        properties: {
          decision: { type: 'string', description: 'What was decided' },
          rationale: { type: 'string', description: 'Why this decision was made' },
          alternatives_rejected: { type: 'array', items: { type: 'string' }, description: 'Alternatives considered and rejected' },
          domain: { type: 'string', description: 'The domain this decision belongs to' },
        },
        required: ['decision', 'rationale', 'alternatives_rejected'],
      },
    },
    {
      name: 'run_tests',
      description: 'Run tests and record results.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Test command to run' },
          suite_name: { type: 'string', description: 'Name of the test suite' },
          check_name: { type: 'string', description: 'Verification check name for the matrix' },
        },
        required: ['command', 'suite_name'],
      },
    },
    {
      name: 'update_acceptance',
      description: 'Mark an acceptance criterion as verified, failed, or needs_review.',
      inputSchema: {
        type: 'object',
        properties: {
          criterion_id: { type: 'string', description: 'The criterion ID' },
          status: { type: 'string', enum: ['verified', 'failed', 'needs_review', 'skipped', 'blocked'] },
          evidence_ref: { type: 'string', description: 'Reference to supporting evidence' },
        },
        required: ['criterion_id', 'status'],
      },
    },
    {
      name: 'update_task_status',
      description: 'Update the overall task status.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'exploring', 'implementing', 'verifying', 'completed', 'failed', 'blocked', 'needs_review'] },
          next_action: { type: 'string', description: 'What to do next' },
        },
        required: ['status'],
      },
    },
    {
      name: 'ask_question',
      description: 'Ask the user a question when you need human input.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question' },
          options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } } }, description: 'Suggested options' },
          recommendation: { type: 'string', description: 'Your recommended option' },
        },
        required: ['question'],
      },
    },
    {
      name: 'add_subtask',
      description: 'Add a subtask to track progress.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short label' },
          description: { type: 'string', description: 'What this subtask involves' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'Subtask IDs this depends on' },
        },
        required: ['label', 'description'],
      },
    },
    {
      name: 'complete_subtask',
      description: 'Mark a subtask as completed.',
      inputSchema: {
        type: 'object',
        properties: {
          subtask_id: { type: 'string', description: 'Subtask ID to complete' },
          result: { type: 'string', description: 'What was accomplished' },
        },
        required: ['subtask_id'],
      },
    },
    {
      name: 'verify_check',
      description: 'Add or update a verification check entry.',
      inputSchema: {
        type: 'object',
        properties: {
          check: { type: 'string', description: 'Check name' },
          status: { type: 'string', enum: ['passed', 'failed', 'skipped', 'not_applicable', 'blocked', 'needs_human_review'] },
          evidence_ref: { type: 'string', description: 'Reference to supporting evidence' },
          notes: { type: 'string', description: 'Additional notes' },
        },
        required: ['check', 'status'],
      },
    },
    {
      name: 'request_domain_expansion',
      description:
        'Expand the task scope to additional engineering domains when evidence shows the change must cross domain boundaries (e.g. an auth change also needs database work). This unlocks those domains’ semantic capabilities and records the reason.',
      inputSchema: {
        type: 'object',
        properties: {
          domains: { type: 'array', items: { type: 'string' }, description: 'Domains to add (e.g. ["database","frontend"])' },
          reason: { type: 'string', description: 'Why the scope must expand' },
        },
        required: ['domains', 'reason'],
      },
    },
    {
      name: 'rollback_checkpoint',
      description:
        'Roll the working tree back to a checkpoint, discarding changes made after it, and mark that checkpoint rejected. Use this to abandon a failed attempt before trying a different approach.',
      inputSchema: {
        type: 'object',
        properties: {
          checkpoint_id: { type: 'string', description: 'The checkpoint ID to roll back to' },
          reason: { type: 'string', description: 'Why this attempt is being abandoned' },
        },
        required: ['checkpoint_id', 'reason'],
      },
    },
    {
      name: 'finish_task',
      description:
        'Declare the task finished. Call this exactly once when all acceptance criteria are satisfied and verified (status "completed"), when you are permanently blocked on human input (status "blocked"), or when the task cannot be completed (status "failed"). This ends the run, so do not call it prematurely.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['completed', 'blocked', 'failed'],
            description: 'Terminal status for the task. Defaults to "completed".',
          },
          summary: { type: 'string', description: 'Concise summary of what was accomplished or why the task ended.' },
        },
        required: ['summary'],
      },
    },
  ]
}

export class ToolExecutor {
  async execute(
    toolCall: ToolCall,
    context: ToolExecutionContext,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const handler = this.getHandler(toolCall.name)
    if (!handler) {
      return { content: `Unknown tool: ${toolCall.name}` }
    }
    return handler(toolCall.input, context)
  }

  private getHandler(name: string): ToolHandler | undefined {
    const handlers: Record<string, ToolHandler> = {
      read_file: this.handleReadFile.bind(this),
      write_file: this.handleWriteFile.bind(this),
      edit_file: this.handleEditFile.bind(this),
      search_code: this.handleSearchCode.bind(this),
      glob_files: this.handleGlobFiles.bind(this),
      run_command: this.handleRunCommand.bind(this),
      create_checkpoint: this.handleCreateCheckpoint.bind(this),
      record_evidence: this.handleRecordEvidence.bind(this),
      record_failure: this.handleRecordFailure.bind(this),
      get_failure_reflection: this.handleGetFailureReflection.bind(this),
      record_decision: this.handleRecordDecision.bind(this),
      run_tests: this.handleRunTests.bind(this),
      update_acceptance: this.handleUpdateAcceptance.bind(this),
      update_task_status: this.handleUpdateTaskStatus.bind(this),
      ask_question: this.handleAskQuestion.bind(this),
      add_subtask: this.handleAddSubtask.bind(this),
      complete_subtask: this.handleCompleteSubtask.bind(this),
      verify_check: this.handleVerifyCheck.bind(this),
      rollback_checkpoint: this.handleRollbackCheckpoint.bind(this),
      request_domain_expansion: this.handleRequestExpansion.bind(this),
      finish_task: this.handleFinishTask.bind(this),
    }
    return handlers[name]
  }

  private async handleReadFile(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const path = input.path as string
    const offset = (input.offset as number) ?? 1
    const limit = (input.limit as number) ?? 100
    const fullPath = `${ctx.workDir}/${path}`
    const content = await readFile(fullPath, 'utf-8')
    const lines = content.split('\n')
    const start = Math.max(0, offset - 1)
    const sliced = lines.slice(start, start + limit)
    const result = sliced.map((line, i) => `${start + i + 1}: ${line}`).join('\n')
    return { content: result || '(empty file)' }
  }

  private async handleWriteFile(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const path = input.path as string
    const content = input.content as string
    const fullPath = `${ctx.workDir}/${path}`
    await writeFile(fullPath, content, 'utf-8')
    await ctx.taskEngine.addFileTouched(ctx.taskId, path)
    return { content: `Wrote ${path} (${content.length} bytes)` }
  }

  private async handleEditFile(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const path = input.path as string
    const oldStr = input.old_string as string
    const newStr = input.new_string as string
    const fullPath = `${ctx.workDir}/${path}`
    const current = await readFile(fullPath, 'utf-8')

    if (!current.includes(oldStr)) {
      return { content: `Error: old_string not found in ${path}` }
    }

    const updated = current.replace(oldStr, newStr)
    await writeFile(fullPath, updated, 'utf-8')
    await ctx.taskEngine.addFileTouched(ctx.taskId, path)
    return { content: `Applied edit to ${path}` }
  }

  private async handleSearchCode(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const pattern = input.pattern as string
    const include = input.include as string | undefined
    const maxResults = (input.max_results as number) ?? 30

    const includeFlag = include ? ` --include '${include}'` : ''
    const linesCommand = `rg -n '${pattern}'${includeFlag} 2>/dev/null | head -${maxResults * 3}`
    try {
      const linesResult = execSync(linesCommand, { cwd: ctx.workDir, encoding: 'utf-8', timeout: 10000 })
      return { content: linesResult.trim() || 'No matches found.' }
    } catch {
      return { content: 'No matches found.' }
    }
  }

  private async handleGlobFiles(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const pattern = input.pattern as string
    const maxResults = (input.max_results as number) ?? 50

    const command = `find . -path '${pattern}' -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.git/*' 2>/dev/null | head -${maxResults}`
    try {
      const result = execSync(command, { cwd: ctx.workDir, encoding: 'utf-8', timeout: 10000 })
      const files = result.trim().split('\n').filter(Boolean)
      return { content: files.length > 0 ? files.join('\n') : 'No files found.' }
    } catch {
      return { content: 'No files found.' }
    }
  }

  private async handleRunCommand(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const command = input.command as string
    const desc = input.description as string
    const timeoutMs = (input.timeout_ms as number) ?? 60000

    try {
      const result = execSync(command, { cwd: ctx.workDir, encoding: 'utf-8', timeout: timeoutMs })
      await ctx.taskEngine.addCommandRun(ctx.taskId, command)
      const output = result.trim() || '(no output)'
      return { content: output }
    } catch (err: unknown) {
      const error = err as { stderr?: string; stdout?: string; status?: number }
      const output = error.stderr || error.stdout || String(err)
      return { content: (output as string).trim() || String(err) }
    }
  }

  private async handleCreateCheckpoint(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const checkpoint = await ctx.checkpointManager.createCheckpoint(
      ctx.taskId,
      input.hypothesis as string,
      input.files_changed as string[],
      input.reason as string,
      { riskAssessment: input.risk_assessment as string },
    )
    return { content: `Created checkpoint ${checkpoint.id}: ${checkpoint.hypothesis}` }
  }

  private async handleRecordEvidence(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const claim = input.claim as string
    const evidence = input.evidence as string[]
    const kind = (input.kind as string) || 'observed_fact'
    const source = input.source as string | undefined

    const entry = await ctx.evidenceEngine.addEntry(ctx.taskId, claim, kind as EvidenceKind, {
      evidence,
      source,
    })
    return { content: `Recorded evidence entry ${entry.id}: ${entry.claim} (${entry.status})` }
  }

  private async handleRecordFailure(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const entry = await ctx.failureEngine.addEntry(
      ctx.taskId,
      input.hypothesis as string,
      input.action as string,
      input.result as string,
      input.lesson as string,
      { nextHypothesis: input.next_hypothesis as string },
    )
    await ctx.taskEngine.addFailure(ctx.taskId, entry.hypothesis)
    return { content: `Recorded failure ${entry.id}: ${entry.hypothesis}` }
  }

  private async handleGetFailureReflection(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const hypothesis = input.hypothesis as string
    const reflection = await ctx.failureEngine.getReflection(ctx.taskId, hypothesis)
    if (!reflection) {
      return { content: `No prior failed attempts for "${hypothesis}".` }
    }
    const lines = [
      `Previous attempt found:`,
      `  What was tried: ${reflection.whatWasTried}`,
      `  Why it failed: ${reflection.whyItFailed}`,
      `  Lesson: ${reflection.whatDisprovedIt}`,
      `  Actions to avoid: ${reflection.shouldNotRepeat.join(', ')}`,
    ]
    if (reflection.newlyPlausible.length > 0) {
      lines.push(`  Newly plausible: ${reflection.newlyPlausible.join(', ')}`)
    }
    lines.push(`  Next best hypothesis: ${reflection.nextBestHypothesis}`)
    return { content: lines.join('\n') }
  }

  private async handleRecordDecision(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const entry = await ctx.decisionEngine.addEntry(
      ctx.taskId,
      input.decision as string,
      input.rationale as string,
      input.alternatives_rejected as string[],
      { domain: input.domain as string },
    )
    await ctx.taskEngine.addDecision(ctx.taskId, entry.decision)
    return { content: `Recorded decision ${entry.id}: ${entry.decision}` }
  }

  private async handleRunTests(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const command = input.command as string
    const suiteName = input.suite_name as string
    const checkName = input.check_name as string

    try {
      const result = execSync(command, { cwd: ctx.workDir, encoding: 'utf-8', timeout: 120000 })
      await ctx.taskEngine.addTestRun(ctx.taskId, command)

      const output = result.trim() || '(no output)'
      const passed = !result.toLowerCase().includes('fail') && !result.toLowerCase().includes('error')

      if (checkName) {
        await ctx.verificationEngine.updateStatus(ctx.taskId, checkName, passed ? 'passed' : 'failed', {
          notes: output.slice(0, 500),
        })
      }

      return { content: output }
    } catch (err: unknown) {
      const error = err as { stderr?: string; stdout?: string; status?: number }
      const output = error.stderr || error.stdout || String(err)

      if (checkName) {
        await ctx.verificationEngine.updateStatus(ctx.taskId, checkName, 'failed', {
          notes: (output as string).slice(0, 500),
        })
      }

      return { content: (output as string).trim() || String(err) }
    }
  }

  private async handleUpdateAcceptance(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const contract = await ctx.acceptanceEngine.getContract(ctx.taskId)
    if (!contract) return { content: 'No acceptance contract found.' }

    await ctx.acceptanceEngine.updateCriterionStatus(
      ctx.taskId,
      input.criterion_id as string,
      input.status as 'verified' | 'failed' | 'needs_review' | 'skipped' | 'blocked',
      input.evidence_ref as string,
    )
    return { content: `Updated acceptance criterion ${input.criterion_id} → ${input.status}` }
  }

  private async handleUpdateTaskStatus(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    await ctx.taskEngine.updateStatus(ctx.taskId, input.status as TaskStatus)
    if (input.next_action) {
      await ctx.taskEngine.setNextAction(ctx.taskId, input.next_action as string)
    }
    return { content: `Task status updated to: ${input.status}` }
  }

  private async handleAskQuestion(input: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const question = input.question as string
    const options = input.options as Array<{ label: string; description: string }> | undefined
    const recommendation = input.recommendation as string | undefined

    const lines = ['[QUESTION]', `Q: ${question}`]
    if (options) {
      lines.push('Options:')
      for (const opt of options) {
        lines.push(`  - ${opt.label}: ${opt.description}`)
      }
    }
    if (recommendation) lines.push(`Recommendation: ${recommendation}`)
    lines.push('[/QUESTION]')

    return { content: lines.join('\n'), metadata: { type: 'question', question, options, recommendation } }
  }

  private async handleAddSubtask(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const label = input.label as string
    const desc = input.description as string
    const dependsOn = input.depends_on as string[] | undefined

    await ctx.taskEngine.addSubtask(ctx.taskId, {
      id: `sub-${Date.now()}`,
      label,
      description: desc,
      status: 'pending',
      dependsOn: dependsOn ?? [],
    })
    return { content: `Added subtask: ${label}` }
  }

  private async handleCompleteSubtask(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    await ctx.taskEngine.completeSubtask(ctx.taskId, input.subtask_id as string, input.result as string)
    return { content: `Completed subtask ${input.subtask_id}` }
  }

  private async handleVerifyCheck(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const check = input.check as string
    const status = input.status as string
    const evidenceRef = input.evidence_ref as string | undefined
    const notes = input.notes as string | undefined

    const existing = await ctx.verificationEngine.getEntries(ctx.taskId)
    const found = existing.find((e) => e.check === check)

    if (found) {
      await ctx.verificationEngine.updateStatus(ctx.taskId, check, status as any, { evidenceRef, notes })
    } else {
      await ctx.verificationEngine.addEntry(ctx.taskId, check, {
        status: status as any,
        evidenceRef,
        notes,
      })
    }
    return { content: `Verification check "${check}" → ${status}` }
  }

  private async handleRollbackCheckpoint(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<{ content: string }> {
    const checkpointId = input.checkpoint_id as string
    const reason = input.reason as string
    const result = await ctx.checkpointManager.restoreCheckpoint(ctx.taskId, checkpointId)
    if (!result) {
      return { content: `Could not roll back checkpoint ${checkpointId} (not found or no working dir).` }
    }
    await ctx.checkpointManager.rejectCheckpoint(ctx.taskId, checkpointId, reason)
    const parts = [`Rolled back to checkpoint ${checkpointId} (rejected: ${reason}).`]
    if (result.restored.length > 0) parts.push(`Restored: ${result.restored.join(', ')}`)
    if (result.deleted.length > 0) parts.push(`Removed: ${result.deleted.join(', ')}`)
    return { content: parts.join('\n') }
  }

  private async handleRequestExpansion(
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const domains = (input.domains as string[]) ?? []
    const reason = (input.reason as string) ?? ''
    const known = new Set((ctx.domainManifests ?? []).map((m) => m.domain))
    const valid = domains.filter((d) => known.has(d))
    const unknown = domains.filter((d) => !known.has(d))
    await ctx.decisionEngine.addEntry(
      ctx.taskId,
      `Expand scope to domain(s): ${valid.join(', ') || '(none valid)'}`,
      reason,
      [],
      { domain: 'cross-domain' },
    )
    const parts = [`Scope expansion recorded: ${valid.join(', ') || 'none'}.`]
    if (unknown.length > 0) parts.push(`Unknown domains ignored: ${unknown.join(', ')}.`)
    return { content: parts.join(' '), metadata: { type: 'expansion', domains: valid } }
  }

  private async handleFinishTask(
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const status = (input.status as string) || 'completed'
    const summary = (input.summary as string) ?? ''
    await ctx.taskEngine.updateStatus(ctx.taskId, status as TaskStatus)
    if (summary) await ctx.taskEngine.setNextAction(ctx.taskId, summary)
    return {
      content: `Task marked "${status}": ${summary}`,
      metadata: { type: 'finish', status, summary },
    }
  }
}
