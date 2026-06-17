import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type { TraceEvent, TraceEventType, TraceLog } from '@forge/types'

export interface TraceRecorderOptions {
  stateDir?: string
}

let eventCounter = 0

function nextId(): string {
  eventCounter++
  return `evt-${Date.now()}-${eventCounter}`
}

export class TraceRecorder {
  private stateDir: string
  private logs = new Map<string, TraceLog>()
  private activeTimers = new Map<string, number>()

  constructor(options?: TraceRecorderOptions) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  async initTask(taskId: string): Promise<void> {
    const log: TraceLog = {
      taskId,
      events: [],
      startedAt: new Date().toISOString(),
      totalToolCalls: 0,
      totalCommands: 0,
      totalFilesRead: 0,
      totalFilesEdited: 0,
    }
    this.logs.set(taskId, log)
    await this.persist(taskId, log)
  }

  async record(
    taskId: string,
    type: TraceEventType,
    description: string,
    options?: {
      payload?: Record<string, unknown>
      parentEventId?: string
    },
  ): Promise<TraceEvent> {
    let log = this.logs.get(taskId)
    if (!log) {
      log = {
        taskId,
        events: [],
        startedAt: new Date().toISOString(),
        totalToolCalls: 0,
        totalCommands: 0,
        totalFilesRead: 0,
        totalFilesEdited: 0,
      }
      this.logs.set(taskId, log)
    }

    const event: TraceEvent = {
      id: nextId(),
      type,
      timestamp: new Date().toISOString(),
      description,
      payload: options?.payload,
      taskId,
      parentEventId: options?.parentEventId,
    }

    // Update counters
    if (type === 'tool_called') log.totalToolCalls++
    if (type === 'command_run') log.totalCommands++
    if (type === 'file_read') log.totalFilesRead++
    if (type === 'file_edited') log.totalFilesEdited++

    log.events.push(event)
    await this.persist(taskId, log)

    return event
  }

  async recordWithDuration(
    taskId: string,
    type: TraceEventType,
    description: string,
    fn: () => Promise<void>,
    options?: {
      payload?: Record<string, unknown>
      parentEventId?: string
    },
  ): Promise<TraceEvent> {
    const start = performance.now()
    const event = await this.record(taskId, type, description, options)

    try {
      await fn()
    } finally {
      const durationMs = Math.round(performance.now() - start)
      event.durationMs = durationMs

      const log = this.logs.get(taskId)
      if (log) {
        const idx = log.events.findIndex((e) => e.id === event.id)
        if (idx >= 0) {
          log.events[idx] = event
        }
        await this.persist(taskId, log)
      }
    }

    return event
  }

  startTimer(label: string): void {
    this.activeTimers.set(label, performance.now())
  }

  endTimer(taskId: string, type: TraceEventType, description: string, label: string): Promise<TraceEvent> {
    const start = this.activeTimers.get(label)
    const durationMs = start ? Math.round(performance.now() - start) : 0
    this.activeTimers.delete(label)

    return this.record(taskId, type, description, {
      payload: { durationMs, timerLabel: label },
    })
  }

  async completeTask(taskId: string): Promise<void> {
    const log = this.logs.get(taskId)
    if (log) {
      log.completedAt = new Date().toISOString()
      await this.persist(taskId, log)
    }
  }

  async getLog(taskId: string): Promise<TraceLog | undefined> {
    if (this.logs.has(taskId)) return this.logs.get(taskId)
    return this.load(taskId)
  }

  async getEvents(taskId: string): Promise<TraceEvent[]> {
    const log = await this.getLog(taskId)
    return log?.events ?? []
  }

  async getEventsByType(taskId: string, type: TraceEventType): Promise<TraceEvent[]> {
    const events = await this.getEvents(taskId)
    return events.filter((e) => e.type === type)
  }

  async getSummary(taskId: string): Promise<{
    totalEvents: number
    toolCalls: number
    commands: number
    filesRead: number
    filesEdited: number
    durationMs?: number
    startedAt?: string
    completedAt?: string
  }> {
    const log = await this.getLog(taskId)
    if (!log) {
      return { totalEvents: 0, toolCalls: 0, commands: 0, filesRead: 0, filesEdited: 0 }
    }

    let durationMs: number | undefined
    if (log.startedAt && log.completedAt) {
      durationMs = new Date(log.completedAt).getTime() - new Date(log.startedAt).getTime()
    }

    return {
      totalEvents: log.events.length,
      toolCalls: log.totalToolCalls,
      commands: log.totalCommands,
      filesRead: log.totalFilesRead,
      filesEdited: log.totalFilesEdited,
      durationMs,
      startedAt: log.startedAt,
      completedAt: log.completedAt,
    }
  }

  private tracePath(taskId: string): string {
    return join(this.stateDir, 'traces', `${taskId}.json`)
  }

  private async persist(taskId: string, log: TraceLog): Promise<void> {
    const filePath = this.tracePath(taskId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(log, null, 2), 'utf-8')
  }

  private async load(taskId: string): Promise<TraceLog | undefined> {
    try {
      const filePath = this.tracePath(taskId)
      const content = await readFile(filePath, 'utf-8')
      const log = JSON.parse(content) as TraceLog
      this.logs.set(taskId, log)
      return log
    } catch {
      return undefined
    }
  }
}
