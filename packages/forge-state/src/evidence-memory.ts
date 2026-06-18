import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export type ArtifactKind =
  | 'command_output'
  | 'test_failure'
  | 'test_pass'
  | 'diff'
  | 'log'
  | 'screenshot'
  | 'error_trace'
  | 'tool_result'
  | 'graph_fact'
  | 'human_decision'
  | 'local_model_input'
  | 'local_model_output'

export interface EvidenceArtifact {
  id: string
  kind: ArtifactKind
  taskId: string
  description: string
  content: string
  contentType: 'text' | 'json' | 'diff'
  createdAt: string
  metadata?: Record<string, unknown>
}

export interface ArtifactQuery {
  taskId?: string
  kind?: ArtifactKind
  limit?: number
}

export class EvidenceMemory {
  private stateDir: string
  private cache = new Map<string, EvidenceArtifact>()

  constructor(options?: { stateDir?: string }) {
    this.stateDir = options?.stateDir ?? '.forge'
  }

  async store(artifact: Omit<EvidenceArtifact, 'id' | 'createdAt'>): Promise<EvidenceArtifact> {
    const id = `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const stored: EvidenceArtifact = {
      ...artifact,
      id,
      createdAt: new Date().toISOString(),
    }

    this.cache.set(id, stored)
    await this.persist(stored)
    return stored
  }

  async storeCommandOutput(
    taskId: string,
    command: string,
    output: string,
    success: boolean,
  ): Promise<EvidenceArtifact> {
    return this.store({
      taskId,
      kind: success ? 'tool_result' : 'command_output',
      description: `Command: ${command}`,
      content: output,
      contentType: 'text',
      metadata: { command, success },
    })
  }

  async storeDiff(
    taskId: string,
    description: string,
    diff: string,
  ): Promise<EvidenceArtifact> {
    return this.store({
      taskId,
      kind: 'diff',
      description,
      content: diff,
      contentType: 'diff',
      metadata: { fileCount: (diff.match(/^diff --git/gm) ?? []).length },
    })
  }

  async storeTestResult(
    taskId: string,
    suite: string,
    passed: number,
    failed: number,
    output: string,
  ): Promise<EvidenceArtifact> {
    const kind = failed > 0 ? 'test_failure' : 'test_pass'
    return this.store({
      taskId,
      kind,
      description: `Test suite: ${suite} (${passed} passed, ${failed} failed)`,
      content: output,
      contentType: 'text',
      metadata: { suite, passed, failed },
    })
  }

  async storeGraphFact(
    taskId: string,
    fact: string,
    data: Record<string, unknown>,
  ): Promise<EvidenceArtifact> {
    return this.store({
      taskId,
      kind: 'graph_fact',
      description: fact,
      content: JSON.stringify(data, null, 2),
      contentType: 'json',
      metadata: data,
    })
  }

  async storeHumanDecision(
    taskId: string,
    decision: string,
    rationale: string,
  ): Promise<EvidenceArtifact> {
    return this.store({
      taskId,
      kind: 'human_decision',
      description: decision,
      content: rationale,
      contentType: 'text',
    })
  }

  async get(id: string): Promise<EvidenceArtifact | undefined> {
    if (this.cache.has(id)) return this.cache.get(id)
    return this.load(id)
  }

  async query(query: ArtifactQuery): Promise<EvidenceArtifact[]> {
    let results = Array.from(this.cache.values())

    if (query.taskId) {
      results = results.filter((a) => a.taskId === query.taskId)
    }
    if (query.kind) {
      results = results.filter((a) => a.kind === query.kind)
    }

    // Sort by creation date, newest first
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    if (query.limit && query.limit > 0) {
      results = results.slice(0, query.limit)
    }

    return results
  }

  async queryByTask(taskId: string, limit?: number): Promise<EvidenceArtifact[]> {
    return this.query({ taskId, limit })
  }

  async getRecentDiffs(taskId: string, count = 5): Promise<EvidenceArtifact[]> {
    return this.query({ taskId, kind: 'diff', limit: count })
  }

  async getRecentTestResults(taskId: string, count = 5): Promise<EvidenceArtifact[]> {
    return this.query({ taskId, kind: 'test_pass', limit: count })
  }

  async getFailedTests(taskId: string): Promise<EvidenceArtifact[]> {
    return this.query({ taskId, kind: 'test_failure' })
  }

  private artifactPath(id: string): string {
    return join(this.stateDir, 'evidence', 'artifacts', `${id}.json`)
  }

  private async persist(artifact: EvidenceArtifact): Promise<void> {
    const filePath = this.artifactPath(artifact.id)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(artifact, null, 2), 'utf-8')
  }

  private async load(id: string): Promise<EvidenceArtifact | undefined> {
    try {
      const filePath = this.artifactPath(id)
      const content = await readFile(filePath, 'utf-8')
      const artifact = JSON.parse(content) as EvidenceArtifact
      this.cache.set(id, artifact)
      return artifact
    } catch {
      return undefined
    }
  }
}
