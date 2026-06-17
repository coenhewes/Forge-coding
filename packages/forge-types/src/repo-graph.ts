import type { DomainBoundary } from './repo-map.js'

export interface RepoGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  regions: GraphRegion[]
  symbolDefinitions: SymbolDefinition[]
  symbolReferences: SymbolReference[]
  callSites: CallSite[]
}

export interface GraphNode {
  id: string
  type: 'file' | 'package' | 'app' | 'symbol' | 'route' | 'test' | 'migration' | 'table'
  name: string
  path?: string
  metadata?: Record<string, unknown>
}

export interface GraphEdge {
  source: string
  target: string
  type:
    | 'imports'
    | 'exports'
    | 'calls'
    | 'defines'
    | 'references'
    | 'routes'
    | 'tests'
    | 'depends_on'
    | 'owned_by'
    | 'connects_to'
  metadata?: Record<string, unknown>
}

export interface GraphRegion {
  id: string
  label: string
  domain?: string
  nodeIds: string[]
  edgeIds: string[]
  subregions?: GraphRegion[]
}

export interface SymbolDefinition {
  name: string
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'component'
  file: string
  exported: boolean
  line: number
  column: number
  nodeId: string
}

export interface SymbolReference {
  name: string
  file: string
  line: number
  column: number
  sourceNodeId: string
  targetNodeId?: string
}

export interface CallSite {
  caller: string
  callee: string
  file: string
  line: number
}

export type DomainEdge = DomainBoundary & {
  dependsOn: string[]
  dependedBy: string[]
}
