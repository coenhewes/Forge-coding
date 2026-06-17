/**
 * Public surface for the typed repositories. Every class in this folder
 * takes a postgres.js `Sql` instance (or a transaction handle from
 * `sql.begin(...)`) and returns typed rows. No raw SQL is exposed to
 * callers — only CRUD + query methods.
 */
export * from './base.js'
export * from './repos.js'
export * from './tasks.js'
export * from './acceptance.js'
export * from './beliefs.js'
export * from './evidence.js'
export * from './failures.js'
export * from './decisions.js'
export * from './probes.js'
export * from './verification.js'
export * from './commands.js'
export * from './trace.js'
export * from './sessions.js'

import type { Db } from './base.js'
import { RepoRepo, RepoNodeRepo, RepoEdgeRepo } from './repos.js'
import { TaskRepo, TaskSnapshotRepo } from './tasks.js'
import { AcceptanceRepo } from './acceptance.js'
import { BeliefRepo, HypothesisRepo } from './beliefs.js'
import { ClaimRepo, EvidenceRepo, ClaimEvidenceLinkRepo } from './evidence.js'
import { FailureRepo } from './failures.js'
import { DecisionRepo } from './decisions.js'
import { ProbeRepo, PatchCandidateRepo } from './probes.js'
import {
  VerificationCheckRepo,
  VerificationActionRepo,
  VerificationActionClaimLinkRepo,
  VerificationActionScoreRepo,
  VerificationHistoryRepo,
} from './verification.js'
import { CommandRepo, ArtifactRepo } from './commands.js'
import { TraceEventRepo } from './trace.js'
import { SessionRepo, PromptRepo } from './sessions.js'

/**
 * One bag of every typed repository, constructed against a single
 * `Sql` (or transaction handle). `ForgeStateStore` exposes a `repos`
 * field with this shape so callers can do `store.repos.tasks.get(id)`
 * or, inside a transaction, `tx.repos.tasks.update(...)`.
 */
export class Repos {
  readonly repos: RepoRepo
  readonly repoNodes: RepoNodeRepo
  readonly repoEdges: RepoEdgeRepo
  readonly tasks: TaskRepo
  readonly taskSnapshots: TaskSnapshotRepo
  readonly acceptance: AcceptanceRepo
  readonly beliefs: BeliefRepo
  readonly hypotheses: HypothesisRepo
  readonly claims: ClaimRepo
  readonly evidence: EvidenceRepo
  readonly claimEvidenceLinks: ClaimEvidenceLinkRepo
  readonly failures: FailureRepo
  readonly decisions: DecisionRepo
  readonly probes: ProbeRepo
  readonly patchCandidates: PatchCandidateRepo
  readonly verificationChecks: VerificationCheckRepo
  readonly verificationActions: VerificationActionRepo
  readonly verificationActionClaimLinks: VerificationActionClaimLinkRepo
  readonly verificationActionScores: VerificationActionScoreRepo
  readonly verificationHistory: VerificationHistoryRepo
  readonly commands: CommandRepo
  readonly artifacts: ArtifactRepo
  readonly trace: TraceEventRepo
  readonly sessions: SessionRepo
  readonly prompts: PromptRepo

  constructor(sql: Db) {
    this.repos = new RepoRepo(sql)
    this.repoNodes = new RepoNodeRepo(sql)
    this.repoEdges = new RepoEdgeRepo(sql)
    this.tasks = new TaskRepo(sql)
    this.taskSnapshots = new TaskSnapshotRepo(sql)
    this.acceptance = new AcceptanceRepo(sql)
    this.beliefs = new BeliefRepo(sql)
    this.hypotheses = new HypothesisRepo(sql)
    this.claims = new ClaimRepo(sql)
    this.evidence = new EvidenceRepo(sql)
    this.claimEvidenceLinks = new ClaimEvidenceLinkRepo(sql)
    this.failures = new FailureRepo(sql)
    this.decisions = new DecisionRepo(sql)
    this.probes = new ProbeRepo(sql)
    this.patchCandidates = new PatchCandidateRepo(sql)
    this.verificationChecks = new VerificationCheckRepo(sql)
    this.verificationActions = new VerificationActionRepo(sql)
    this.verificationActionClaimLinks = new VerificationActionClaimLinkRepo(sql)
    this.verificationActionScores = new VerificationActionScoreRepo(sql)
    this.verificationHistory = new VerificationHistoryRepo(sql)
    this.commands = new CommandRepo(sql)
    this.artifacts = new ArtifactRepo(sql)
    this.trace = new TraceEventRepo(sql)
    this.sessions = new SessionRepo(sql)
    this.prompts = new PromptRepo(sql)
  }
}
