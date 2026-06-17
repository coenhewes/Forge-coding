import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type {
  TaskState,
  TaskStatus,
  Subtask,
  SubtaskStatus,
  OpenQuestion,
} from '@forge/types'

export interface TaskEngineOptions {
  stateDir?: string
}

export class TaskStateEngine {
  private stateDir: string
  private cache = new Map<string, TaskState>()

  constructor(options?: TaskEngineOptions) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  async createTask(
    taskId: string,
    request: string,
    overrides?: Partial<TaskState>,
  ): Promise<TaskState> {
    const now = new Date().toISOString()
    const state: TaskState = {
      taskId,
      originalRequest: request,
      currentInterpretation: request,
      status: 'pending',
      acceptanceCriteria: [],
      assumptions: [],
      openQuestions: [],
      subtasks: [],
      dependencies: [],
      completedWork: [],
      remainingWork: [],
      filesTouched: [],
      commandsRun: [],
      testsRun: [],
      failuresEncountered: [],
      decisionsMade: [],
      risks: [],
      verificationStatus: {},
      evidenceLinks: [],
      failedHypotheses: [],
      patchCandidates: [],
      reviewBlockers: [],
      nextAction: 'Understand the task',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }

    this.cache.set(taskId, state)
    await this.persist(state)
    return state
  }

  async getTask(taskId: string): Promise<TaskState | undefined> {
    if (this.cache.has(taskId)) return this.cache.get(taskId)
    return this.load(taskId)
  }

  async updateTask(taskId: string, updates: Partial<TaskState>): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)

    const updated: TaskState = {
      ...state,
      ...updates,
      updatedAt: new Date().toISOString(),
    }

    this.cache.set(taskId, updated)
    await this.persist(updated)
    return updated
  }

  async updateStatus(taskId: string, status: TaskStatus): Promise<TaskState> {
    return this.updateTask(taskId, { status })
  }

  async setInterpretation(taskId: string, interpretation: string): Promise<TaskState> {
    return this.updateTask(taskId, { currentInterpretation: interpretation })
  }

  async addCompletedWork(taskId: string, work: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      completedWork: [...state.completedWork, work],
      remainingWork: state.remainingWork.filter((w) => w !== work),
    })
  }

  async addRemainingWork(taskId: string, work: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    if (!state.remainingWork.includes(work)) {
      return this.updateTask(taskId, {
        remainingWork: [...state.remainingWork, work],
      })
    }
    return state
  }

  async addFileTouched(taskId: string, file: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    if (!state.filesTouched.includes(file)) {
      return this.updateTask(taskId, {
        filesTouched: [...state.filesTouched, file],
      })
    }
    return state
  }

  async addCommandRun(taskId: string, command: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      commandsRun: [...state.commandsRun, command],
    })
  }

  async addTestRun(taskId: string, testName: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      testsRun: [...state.testsRun, testName],
    })
  }

  async addFailure(taskId: string, failure: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      failuresEncountered: [...state.failuresEncountered, failure],
    })
  }

  async addDecision(taskId: string, decision: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      decisionsMade: [...state.decisionsMade, decision],
    })
  }

  async addRisk(taskId: string, risk: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      risks: [...state.risks, risk],
    })
  }

  async setNextAction(taskId: string, action: string): Promise<TaskState> {
    return this.updateTask(taskId, { nextAction: action })
  }

  // Subtasks

  async addSubtask(taskId: string, subtask: Subtask): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      subtasks: [...state.subtasks, subtask],
    })
  }

  async updateSubtaskStatus(
    taskId: string,
    subtaskId: string,
    status: SubtaskStatus,
  ): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      subtasks: state.subtasks.map((s) =>
        s.id === subtaskId ? { ...s, status } : s,
      ),
    })
  }

  async completeSubtask(taskId: string, subtaskId: string, result?: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      subtasks: state.subtasks.map((s) =>
        s.id === subtaskId ? { ...s, status: 'completed', result } : s,
      ),
    })
  }

  // Open questions

  async addQuestion(taskId: string, question: OpenQuestion): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      openQuestions: [...state.openQuestions, question],
    })
  }

  async resolveQuestion(taskId: string, questionId: string, answer: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      openQuestions: state.openQuestions.map((q) =>
        q.question === questionId ? { ...q, resolved: true, answer } : q,
      ),
    })
  }

  // Acceptance criteria

  async addAcceptanceCriterion(taskId: string, criterion: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    if (!state.acceptanceCriteria.includes(criterion)) {
      return this.updateTask(taskId, {
        acceptanceCriteria: [...state.acceptanceCriteria, criterion],
      })
    }
    return state
  }

  async setAcceptanceCriteria(taskId: string, criteria: string[]): Promise<TaskState> {
    return this.updateTask(taskId, { acceptanceCriteria: criteria })
  }

  // Hypothesis tracking

  async addFailedHypothesis(taskId: string, hypothesis: string): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      failedHypotheses: [...state.failedHypotheses, hypothesis],
    })
  }

  // Verification

  async setVerificationStatus(
    taskId: string,
    check: string,
    status: string,
  ): Promise<TaskState> {
    const state = await this.getTask(taskId)
    if (!state) throw new Error(`Task ${taskId} not found`)
    return this.updateTask(taskId, {
      verificationStatus: {
        ...state.verificationStatus,
        [check]: status,
      },
    })
  }

  // Persistence

  private stateFilePath(taskId: string): string {
    return join(this.stateDir, 'tasks', `${taskId}.json`)
  }

  private async persist(state: TaskState): Promise<void> {
    const filePath = this.stateFilePath(state.taskId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8')
  }

  private async load(taskId: string): Promise<TaskState | undefined> {
    try {
      const filePath = this.stateFilePath(taskId)
      const content = await readFile(filePath, 'utf-8')
      const state = JSON.parse(content) as TaskState
      this.cache.set(taskId, state)
      return state
    } catch {
      return undefined
    }
  }

  async resumeTask(taskId: string): Promise<TaskState | undefined> {
    const state = await this.load(taskId)
    if (state) {
      state.status = 'pending'
      state.nextAction = 'Resume from previous state'
      state.updatedAt = new Date().toISOString()
      await this.persist(state)
    }
    return state
  }

  async listTasks(): Promise<string[]> {
    try {
      const { readdir } = await import('node:fs/promises')
      const tasksDir = join(this.stateDir, 'tasks')
      const files = await readdir(tasksDir)
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
    } catch {
      return []
    }
  }

  clearCache(): void {
    this.cache.clear()
  }
}
