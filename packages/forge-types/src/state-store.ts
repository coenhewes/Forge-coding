export type StateStoreActor = 'model' | 'system' | 'human' | 'tool' | 'ci' | 'reviewer' | 'verifier'

export interface StateStoreConfig {
  connectionString?: string
  schemaVersion: number
  artifactsDir: string
  localFirst: boolean
}

export interface StateStoreHealth {
  ok: boolean
  schemaVersion?: number
  requiredSchemaVersion: number
  postgresReachable: boolean
  artifactStoreWritable: boolean
  warnings: string[]
}

export interface ArtifactRecord {
  id: string
  taskId?: string
  artifactType: string
  path: string
  contentHash?: string
  sizeBytes?: number
  summary?: string
  createdAt: string
}

export interface DurableWriteReceipt {
  id: string
  kind: string
  actor: StateStoreActor
  traceEventId: string
  createdAt: string
}

export interface ContextSlice<T = unknown> {
  capability: string
  taskId?: string
  data: T
  sources: string[]
  relevanceScore?: number
  warnings: string[]
  stale: boolean
  missing: string[]
}

export interface HumanApproval {
  id: string
  taskId: string
  reason: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  status: 'requested' | 'approved' | 'rejected'
  decidedBy?: string
  decidedAt?: string
}
