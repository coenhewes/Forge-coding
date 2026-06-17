import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TraceEvent, TraceEventType, TraceLog } from '@forge/types'

export interface TraceViewerOptions {
  stateDir?: string
}

export class TraceViewer {
  private stateDir: string

  constructor(options?: TraceViewerOptions) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  async getLog(taskId: string): Promise<TraceLog | undefined> {
    try {
      const filePath = join(this.stateDir, 'traces', `${taskId}.json`)
      const content = await readFile(filePath, 'utf-8')
      return JSON.parse(content) as TraceLog
    } catch {
      return undefined
    }
  }

  async getEvents(taskId: string): Promise<TraceEvent[]> {
    const log = await this.getLog(taskId)
    return log?.events ?? []
  }

  async getEventsByType(taskId: string, type: TraceEventType): Promise<TraceEvent[]> {
    const events = await this.getEvents(taskId)
    return events.filter((e) => e.type === type)
  }

  async getEventsSince(taskId: string, since: string): Promise<TraceEvent[]> {
    const events = await this.getEvents(taskId)
    const sinceTime = new Date(since).getTime()
    return events.filter((e) => new Date(e.timestamp).getTime() > sinceTime)
  }

  async getRecentEvents(taskId: string, count = 10): Promise<TraceEvent[]> {
    const events = await this.getEvents(taskId)
    return events.slice(-count)
  }

  async getToolCalls(taskId: string): Promise<TraceEvent[]> {
    return this.getEventsByType(taskId, 'tool_called')
  }

  async getCommands(taskId: string): Promise<TraceEvent[]> {
    return this.getEventsByType(taskId, 'command_run')
  }

  async getFileEdits(taskId: string): Promise<TraceEvent[]> {
    return this.getEventsByType(taskId, 'file_edited')
  }

  async getFileReads(taskId: string): Promise<TraceEvent[]> {
    return this.getEventsByType(taskId, 'file_read')
  }

  async getFailures(taskId: string): Promise<TraceEvent[]> {
    return this.getEventsByType(taskId, 'failure_observed')
  }

  async getCheckpoints(taskId: string): Promise<TraceEvent[]> {
    const created = await this.getEventsByType(taskId, 'checkpoint_created')
    const patches = await this.getEventsByType(taskId, 'patch_candidate')
    return [...created, ...patches].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
  }

  async getDomainChanges(taskId: string): Promise<{
    selected: TraceEvent[]
    expanded: TraceEvent[]
  }> {
    const selected = await this.getEventsByType(taskId, 'domain_selected')
    const expanded = await this.getEventsByType(taskId, 'domain_expansion')
    return { selected, expanded }
  }

  async getTimeline(taskId: string): Promise<{
    startedAt?: string
    completedAt?: string
    events: { time: string; type: string; description: string; durationMs?: number }[]
  }> {
    const log = await this.getLog(taskId)
    if (!log) return { events: [] }

    return {
      startedAt: log.startedAt,
      completedAt: log.completedAt,
      events: log.events.map((e) => ({
        time: e.timestamp,
        type: e.type,
        description: e.description,
        durationMs: e.durationMs,
      })),
    }
  }

  async getSummary(taskId: string): Promise<{
    totalEvents: number
    byType: Record<string, number>
    totalDurationMs?: number
    startedAt?: string
    completedAt?: string
  }> {
    const log = await this.getLog(taskId)
    if (!log) return { totalEvents: 0, byType: {} }

    const typeCounts: Record<string, number> = {}
    for (const event of log.events) {
      typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1
    }

    let totalDurationMs: number | undefined
    if (log.startedAt && log.completedAt) {
      totalDurationMs = new Date(log.completedAt).getTime() - new Date(log.startedAt).getTime()
    }

    return {
      totalEvents: log.events.length,
      byType: typeCounts,
      totalDurationMs,
      startedAt: log.startedAt,
      completedAt: log.completedAt,
    }
  }

  async listTraces(): Promise<string[]> {
    try {
      const tracesDir = join(this.stateDir, 'traces')
      const files = await readdir(tracesDir)
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
    } catch {
      return []
    }
  }

  async getCostEstimate(taskId: string): Promise<{
    toolCalls: number
    commands: number
    totalEvents: number
    estimatedInputTokens: number
    estimatedOutputTokens: number
  }> {
    const log = await this.getLog(taskId)
    if (!log) {
      return { toolCalls: 0, commands: 0, totalEvents: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0 }
    }

    // Rough estimate: ~4 chars per token
    let inputTokens = 0
    let outputTokens = 0

    for (const event of log.events) {
      if (event.payload) {
        const payloadStr = JSON.stringify(event.payload)
        inputTokens += Math.ceil(payloadStr.length / 4)
      }
      inputTokens += Math.ceil(event.description.length / 4)
    }

    return {
      toolCalls: log.totalToolCalls,
      commands: log.totalCommands,
      totalEvents: log.events.length,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
    }
  }
}
