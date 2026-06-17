export type TraceEventType =
  | 'file_read'
  | 'file_edited'
  | 'command_run'
  | 'tool_called'
  | 'domain_selected'
  | 'domain_expanded'
  | 'graph_inspected'
  | 'test_run'
  | 'failure_observed'
  | 'checkpoint_created'
  | 'patch_candidate'
  | 'state_transition'
  | 'human_intervention'
  | 'verification_result'
  | 'domain_expansion'
  | 'review_comment'
  | 'pr_update'
  | 'subtask_completed'
  | 'error'

export interface TraceEvent {
  id: string
  type: TraceEventType
  timestamp: string
  description: string
  payload?: Record<string, unknown>
  taskId?: string
  parentEventId?: string
  durationMs?: number
}

export interface TraceLog {
  taskId: string
  events: TraceEvent[]
  startedAt: string
  completedAt?: string
  totalToolCalls: number
  totalCommands: number
  totalFilesRead: number
  totalFilesEdited: number
}
