import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import type {
  Checkpoint,
  CheckpointStatus,
  PatchCandidate,
  PatchFile,
  PatchTestResult,
} from '@forge/types'

export interface CheckpointManagerOptions {
  stateDir?: string
}

let checkpointCounter = 0
let patchCounter = 0

function nextCheckpointId(): string {
  checkpointCounter++
  return `cp-${Date.now()}-${checkpointCounter}`
}

function nextPatchId(): string {
  patchCounter++
  return `patch-${Date.now()}-${patchCounter}`
}

export class CheckpointManager {
  private stateDir: string
  private checkpointCache = new Map<string, Checkpoint[]>()
  private patchCache = new Map<string, PatchCandidate[]>()

  constructor(options?: CheckpointManagerOptions) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  // ── Checkpoints ──────────────────────────────────────

  async createCheckpoint(
    taskId: string,
    hypothesis: string,
    filesChanged: string[],
    reason: string,
    options?: {
      riskAssessment?: string
      parentCheckpointId?: string
    },
  ): Promise<Checkpoint> {
    const checkpoints = await this.getCheckpoints(taskId)

    const checkpoint: Checkpoint = {
      id: nextCheckpointId(),
      hypothesis,
      filesChanged,
      reason,
      verificationStatus: 'pending',
      riskAssessment: options?.riskAssessment ?? 'unknown',
      parentCheckpointId: options?.parentCheckpointId,
      childCheckpointIds: [],
      createdAt: new Date().toISOString(),
    }

    // Link to parent
    if (options?.parentCheckpointId) {
      const parent = checkpoints.find((c) => c.id === options.parentCheckpointId)
      if (parent) {
        parent.childCheckpointIds.push(checkpoint.id)
      }
    }

    checkpoints.push(checkpoint)
    await this.persistCheckpoints(taskId, checkpoints)
    return checkpoint
  }

  async promoteCheckpoint(
    taskId: string,
    checkpointId: string,
  ): Promise<Checkpoint | undefined> {
    const checkpoints = await this.getCheckpoints(taskId)
    const cp = checkpoints.find((c) => c.id === checkpointId)
    if (!cp) return undefined

    cp.promotionDecision = 'promoted'
    cp.promotedAt = new Date().toISOString()
    cp.verificationStatus = 'passed'
    await this.persistCheckpoints(taskId, checkpoints)
    return cp
  }

  async rejectCheckpoint(
    taskId: string,
    checkpointId: string,
    failureReason: string,
  ): Promise<Checkpoint | undefined> {
    const checkpoints = await this.getCheckpoints(taskId)
    const cp = checkpoints.find((c) => c.id === checkpointId)
    if (!cp) return undefined

    cp.promotionDecision = 'rejected'
    cp.failureReason = failureReason
    cp.verificationStatus = 'failed'
    await this.persistCheckpoints(taskId, checkpoints)
    return cp
  }

  async getCheckpoints(taskId: string): Promise<Checkpoint[]> {
    if (this.checkpointCache.has(taskId)) return this.checkpointCache.get(taskId)!
    return this.loadCheckpoints(taskId)
  }

  async getActiveCheckpoints(taskId: string): Promise<Checkpoint[]> {
    const all = await this.getCheckpoints(taskId)
    return all.filter((c) => !c.promotionDecision || c.promotionDecision === 'pending')
  }

  async getPromotedCheckpoints(taskId: string): Promise<Checkpoint[]> {
    const all = await this.getCheckpoints(taskId)
    return all.filter((c) => c.promotionDecision === 'promoted')
  }

  async getCheckpointTree(taskId: string): Promise<Checkpoint[]> {
    const all = await this.getCheckpoints(taskId)
    // Return in creation order with depth implied by parentCheckpointId
    return all.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
  }

  // ── Patch Candidates ──────────────────────────────────

  async createPatch(
    taskId: string,
    checkpointId: string,
    hypothesis: string,
    diff: string,
    filesChanged: PatchFile[],
    options?: {
      riskScore?: number
    },
  ): Promise<PatchCandidate> {
    const patches = await this.getPatches(taskId)

    const patch: PatchCandidate = {
      id: nextPatchId(),
      checkpointId,
      hypothesis,
      diff,
      filesChanged,
      testResults: [],
      verificationOutcome: 'passed',
      riskScore: options?.riskScore ?? 0,
      promoted: false,
      timestamp: new Date().toISOString(),
    }

    patches.push(patch)
    await this.persistPatches(taskId, patches)
    return patch
  }

  async addTestResults(
    taskId: string,
    patchId: string,
    results: PatchTestResult[],
  ): Promise<PatchCandidate | undefined> {
    const patches = await this.getPatches(taskId)
    const patch = patches.find((p) => p.id === patchId)
    if (!patch) return undefined

    patch.testResults.push(...results)

    // Derive outcome
    const allPassed = results.every((r) => r.failed === 0)
    const anyFailed = results.some((r) => r.failed > 0)
    patch.verificationOutcome = allPassed ? 'passed' : anyFailed ? 'failed' : 'partial'

    await this.persistPatches(taskId, patches)
    return patch
  }

  async promotePatch(
    taskId: string,
    patchId: string,
  ): Promise<PatchCandidate | undefined> {
    const patches = await this.getPatches(taskId)
    const patch = patches.find((p) => p.id === patchId)
    if (!patch) return undefined

    patch.promoted = true
    await this.persistPatches(taskId, patches)
    return patch
  }

  async getPatches(taskId: string): Promise<PatchCandidate[]> {
    if (this.patchCache.has(taskId)) return this.patchCache.get(taskId)!
    return this.loadPatches(taskId)
  }

  async getPromotedPatches(taskId: string): Promise<PatchCandidate[]> {
    const all = await this.getPatches(taskId)
    return all.filter((p) => p.promoted)
  }

  async getFailedPatches(taskId: string): Promise<PatchCandidate[]> {
    const all = await this.getPatches(taskId)
    return all.filter((p) => p.verificationOutcome === 'failed')
  }

  async comparePatches(taskId: string): Promise<{
    patches: PatchCandidate[]
    promoted: PatchCandidate | undefined
    failed: PatchCandidate[]
  }> {
    const all = await this.getPatches(taskId)
    const promoted = all.find((p) => p.promoted)
    const failed = all.filter((p) => p.verificationOutcome === 'failed' && !p.promoted)
    return { patches: all, promoted, failed }
  }

  // ── Persistence ──────────────────────────────────────

  private checkpointPath(taskId: string): string {
    return join(this.stateDir, 'checkpoints', `${taskId}.json`)
  }

  private patchPath(taskId: string): string {
    return join(this.stateDir, 'patches', `${taskId}.json`)
  }

  private async persistCheckpoints(taskId: string, checkpoints: Checkpoint[]): Promise<void> {
    const filePath = this.checkpointPath(taskId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(checkpoints, null, 2), 'utf-8')
  }

  private async loadCheckpoints(taskId: string): Promise<Checkpoint[]> {
    try {
      const filePath = this.checkpointPath(taskId)
      const content = await readFile(filePath, 'utf-8')
      const data = JSON.parse(content) as Checkpoint[]
      this.checkpointCache.set(taskId, data)
      return data
    } catch {
      const empty: Checkpoint[] = []
      this.checkpointCache.set(taskId, empty)
      return empty
    }
  }

  private async persistPatches(taskId: string, patches: PatchCandidate[]): Promise<void> {
    const filePath = this.patchPath(taskId)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(patches, null, 2), 'utf-8')
  }

  private async loadPatches(taskId: string): Promise<PatchCandidate[]> {
    try {
      const filePath = this.patchPath(taskId)
      const content = await readFile(filePath, 'utf-8')
      const data = JSON.parse(content) as PatchCandidate[]
      this.patchCache.set(taskId, data)
      return data
    } catch {
      const empty: PatchCandidate[] = []
      this.patchCache.set(taskId, empty)
      return empty
    }
  }
}
