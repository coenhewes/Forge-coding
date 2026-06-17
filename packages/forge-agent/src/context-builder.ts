import type {
  Message,
  ToolDefinition,
  TaskState,
  DomainSelection,
  AcceptanceContract,
} from '@forge/types'
import type { BoundedContext } from '@forge/harness'

export interface AgentContext {
  systemPrompt: string
  messages: Message[]
  tools: ToolDefinition[]
}

export interface ContextBuilderOptions {
  taskId: string
  task: string
  taskState?: TaskState
  domainSelection?: DomainSelection
  boundedContext?: BoundedContext
  acceptanceContract?: AcceptanceContract
  tools: ToolDefinition[]
  mode?: string
  warnings?: string[]
}

export class AgentContextBuilder {
  build(options: ContextBuilderOptions): AgentContext {
    const systemPrompt = this.buildSystemPrompt(options)
    const userMessage = this.buildUserMessage(options)
    return {
      systemPrompt,
      messages: [userMessage],
      tools: options.tools,
    }
  }

  private buildSystemPrompt(options: ContextBuilderOptions): string {
    const parts: string[] = [
      `You are Forge, a long-horizon software engineering agent operating in ${options.mode ?? 'implement'} mode.`,
      '',
      '## Core Principles',
      '- You own the task from ticket to verified PR.',
      '- Treat the repository as a mapped software system, not a flat filesystem.',
      '- Localize before editing. Understand before patching. Verify before declaring done.',
      '- Use evidence-backed claims. Every completion-relevant claim needs supporting evidence.',
      '- Record failures so you do not repeat disproven hypotheses.',
      '- Record decisions so your reasoning is reviewable and resumable.',
      '- Ask the user only when genuinely blocked on product ambiguity, architecture forks, or irreversible changes.',
      '',
      '## Operating Constraints',
      '- You have bounded context. You cannot see the entire repo.',
      '- Use search tools to find relevant files before editing.',
      '- Create checkpoints before risky changes so you can roll back.',
      '- Run tests to verify your changes. Do not claim completion without verification.',
      '- If a hypothesis fails, record the failure and try a different approach.',
    ]

    if (options.acceptanceContract) {
      const contract = options.acceptanceContract
      parts.push('', '## Acceptance Criteria')
      parts.push('The following criteria define what "done" means:')
      for (const criterion of contract.criteria) {
        const icon = criterion.status === 'verified' ? '✓' : criterion.status === 'failed' ? '✗' : '○'
        parts.push(`- ${icon} [${criterion.id}] ${criterion.description}`)
      }
    }

    if (options.warnings && options.warnings.length > 0) {
      parts.push('', '## Active Warnings')
      for (const w of options.warnings) parts.push(`- ${w}`)
    }

    if (options.boundedContext) {
      const bc = options.boundedContext
      parts.push('', '## Repository Facts')
      const rf = bc.repoFacts
      parts.push(`- ${rf.packages} packages, ${rf.apps} apps, ${rf.routes} routes, ${rf.testSuites} test suites`)
      if (rf.databaseType) parts.push(`- Database: ${rf.databaseType}`)
      if (rf.primaryFramework) parts.push(`- Primary framework: ${rf.primaryFramework}`)
      if (rf.isMonorepo) parts.push('- Monorepo detected')

      const gf = bc.graphFacts
      parts.push('', '## Graph Facts')
      parts.push(`- ${gf.totalFiles} files, ${gf.totalSymbols} symbols, ${gf.totalEdges} edges`)
      if (gf.regions.length > 0) parts.push(`- Regions: ${gf.regions.join(', ')}`)
      if (gf.crossDomainEdges > 0) parts.push(`- ${gf.crossDomainEdges} cross-domain edges`)
      if (gf.testRelationships > 0) parts.push(`- ${gf.testRelationships} test relationships`)

      if (bc.selectedDomains.length > 0) {
        parts.push('', '## Selected Domains')
        parts.push(`- Primary: ${bc.selectedDomains.join(', ')}`)
      }

      if (bc.evidence) {
        parts.push('', '## Evidence Summary')
        parts.push(`- Total: ${bc.evidence.totalEntries} | Verified: ${bc.evidence.verified} | Unverified: ${bc.evidence.unverified} | Needs review: ${bc.evidence.needsReview}`)
      }

      if (bc.verificationStatus) {
        parts.push('', '## Verification Status')
        parts.push(`- Passed: ${bc.verificationStatus.passed} | Failed: ${bc.verificationStatus.failed} | Remaining: ${bc.verificationStatus.remaining}`)
      }

      if (bc.failureWarnings && bc.failureWarnings.length > 0) {
        parts.push('', '## Failure Warnings (from previous attempts)')
        for (const w of bc.failureWarnings) parts.push(`- ${w}`)
      }

      if (bc.openQuestions && bc.openQuestions.length > 0) {
        parts.push('', '## Open Questions')
        for (const q of bc.openQuestions) parts.push(`- ${q}`)
      }

      if (bc.riskConstraints && bc.riskConstraints.length > 0) {
        parts.push('', '## Risk Constraints')
        for (const rc of bc.riskConstraints) parts.push(`- ${rc}`)
      }
    }

    if (options.taskState) {
      const ts = options.taskState
      parts.push('', '## Task State')
      parts.push(`- Status: ${ts.status}`)
      parts.push(`- Next action: ${ts.nextAction}`)
      if (ts.filesTouched.length > 0) parts.push(`- Files touched: ${ts.filesTouched.join(', ')}`)
      if (ts.remainingWork.length > 0) {
        parts.push('- Remaining work:')
        for (const rw of ts.remainingWork) parts.push(`  - ${rw}`)
      }
      if (ts.reviewBlockers.length > 0) {
        parts.push('- Review blockers:')
        for (const rb of ts.reviewBlockers) parts.push(`  - ${rb}`)
      }
    }

    parts.push(
      '',
      '## CRITICAL INSTRUCTION: Tool Usage',
      'You MUST use the available tools to complete this task. You can read files, write code, search code, run commands, and record state.',
      'Do NOT apologize for lacking access or capabilities. You have all the tools you need.',
      'If you need to understand the codebase, use search_code or glob_files. Then read specific files. Then make changes.',
      'Always run the relevant build/test/lint commands after making changes to verify they work correctly.',
      '',
      '## Available Tools',
      'Use these tools to explore, edit, verify, and track your work.',
    )

    return parts.join('\n')
  }

  private buildUserMessage(options: ContextBuilderOptions): Message {
    let content = options.task

    if (options.taskState) {
      const ts = options.taskState
      if (ts.completedWork.length > 0) {
        content += '\n\nAlready completed:\n' + ts.completedWork.map((w) => `- ${w}`).join('\n')
      }
    }

    return { role: 'user', content }
  }
}
