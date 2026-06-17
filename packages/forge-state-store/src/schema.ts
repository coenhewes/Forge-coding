export const REQUIRED_SCHEMA_VERSION = 2

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'forge_state_store_initial',
    sql: `
create extension if not exists "uuid-ossp";

create table if not exists schema_migrations (
  version integer primary key,
  name text not null,
  applied_at timestamptz not null default now()
);

create table if not exists repos (
  id uuid primary key,
  root_path text not null,
  name text not null,
  current_branch text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (root_path)
);

create table if not exists tasks (
  id uuid primary key,
  repo_id uuid not null references repos(id),
  title text not null,
  original_request text not null,
  interpreted_goal text,
  status text not null,
  mode text not null,
  active_branch text,
  active_patch_candidate_id uuid,
  current_summary text,
  next_action text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists task_snapshots (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  snapshot_type text not null,
  summary text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists acceptance_criteria (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  text text not null,
  status text not null,
  risk_level text,
  requires_human_review boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists repo_nodes (
  id uuid primary key,
  repo_id uuid not null references repos(id),
  node_type text not null,
  stable_key text not null,
  name text not null,
  path text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo_id, stable_key)
);

create table if not exists repo_edges (
  id uuid primary key,
  repo_id uuid not null references repos(id),
  source_node_id uuid not null references repo_nodes(id),
  target_node_id uuid not null references repo_nodes(id),
  edge_type text not null,
  confidence numeric,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists domains (
  id uuid primary key,
  repo_id uuid not null references repos(id),
  name text not null,
  description text,
  owns jsonb not null default '[]'::jsonb,
  allowed_reads jsonb not null default '[]'::jsonb,
  allowed_writes jsonb not null default '[]'::jsonb,
  related_domains jsonb not null default '[]'::jsonb,
  forbidden_by_default jsonb not null default '[]'::jsonb,
  risk_profile jsonb not null default '[]'::jsonb,
  verification jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo_id, name)
);

create table if not exists beliefs (
  id uuid primary key,
  task_id uuid references tasks(id),
  repo_id uuid not null references repos(id),
  belief_type text not null,
  claim text not null,
  status text not null,
  confidence numeric,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists hypotheses (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  claim text not null,
  status text not null,
  confidence numeric not null,
  relevant_domains jsonb not null default '[]'::jsonb,
  relevant_graph_nodes jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists claims (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  acceptance_criterion_id uuid references acceptance_criteria(id),
  text text not null,
  status text not null,
  confidence numeric,
  risk_level text,
  reviewer_guidance text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists artifacts (
  id uuid primary key,
  task_id uuid references tasks(id),
  artifact_type text not null,
  path text not null,
  content_hash text,
  size_bytes bigint,
  summary text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists evidence (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  evidence_type text not null,
  summary text not null,
  status text,
  source_type text not null,
  source_ref text,
  artifact_id uuid references artifacts(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists claim_evidence_links (
  id uuid primary key,
  claim_id uuid not null references claims(id),
  evidence_id uuid not null references evidence(id),
  link_type text not null,
  created_at timestamptz not null default now(),
  unique (claim_id, evidence_id, link_type)
);

create table if not exists failures (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  hypothesis_id uuid references hypotheses(id),
  failure_type text not null,
  summary text not null,
  lesson text,
  artifact_id uuid references artifacts(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists decisions (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  decision text not null,
  rationale text not null,
  alternatives_rejected jsonb not null default '[]'::jsonb,
  verification_required jsonb not null default '[]'::jsonb,
  decided_by text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists probes (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  capability text not null,
  status text not null,
  expected_information_gain text,
  cost text,
  risk text,
  reason text,
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists patch_candidates (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  name text not null,
  base_commit text not null,
  status text not null,
  hypothesis_id uuid references hypotheses(id),
  diff_artifact_id uuid references artifacts(id),
  summary text,
  verification_status text,
  promotion_decision text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists checkpoints (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  patch_candidate_id uuid references patch_candidates(id),
  status text not null,
  base_commit text,
  snapshot_artifact_id uuid references artifacts(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists verification_checks (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  acceptance_criterion_id uuid references acceptance_criteria(id),
  claim_id uuid references claims(id),
  check_type text not null,
  command text,
  status text not null,
  evidence_id uuid references evidence(id),
  risk_level text,
  reason text,
  stale_reason text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists verification_actions (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  action_type text not null,
  command text,
  capability text,
  status text not null,
  expected_evidence_value numeric,
  selection_reason text,
  estimated_runtime_ms integer,
  estimated_cost text,
  flakiness_risk text,
  setup_cost text,
  evidence_quality text,
  review_usefulness text,
  result_evidence_id uuid references evidence(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists verification_action_claim_links (
  id uuid primary key,
  verification_action_id uuid not null references verification_actions(id),
  claim_id uuid not null references claims(id),
  link_type text not null,
  expected_confidence_delta numeric,
  actual_confidence_delta numeric,
  created_at timestamptz not null default now(),
  unique (verification_action_id, claim_id, link_type)
);

create table if not exists verification_action_scores (
  id uuid primary key,
  verification_action_id uuid not null references verification_actions(id),
  total_score numeric not null,
  claim_importance numeric not null,
  expected_confidence_shift numeric not null,
  risk_weight numeric not null,
  hypothesis_discrimination numeric not null,
  evidence_quality numeric not null,
  review_usefulness numeric not null,
  runtime_penalty numeric not null,
  flakiness_penalty numeric not null,
  setup_penalty numeric not null,
  context_penalty numeric not null,
  explanation text not null,
  created_at timestamptz not null default now()
);

create table if not exists verification_history (
  id uuid primary key,
  repo_id uuid not null references repos(id),
  action_signature text not null,
  action_type text not null,
  command text,
  domain text,
  average_runtime_ms integer,
  failure_rate numeric,
  flake_rate numeric,
  historical_detection_value numeric,
  last_run_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo_id, action_signature)
);

create table if not exists commands (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  command text not null,
  cwd text,
  status text not null,
  exit_code integer,
  started_at timestamptz not null,
  completed_at timestamptz,
  stdout_artifact_id uuid references artifacts(id),
  stderr_artifact_id uuid references artifacts(id),
  summary text,
  payload jsonb not null default '{}'::jsonb
);

create table if not exists trace_events (
  id uuid primary key,
  task_id uuid references tasks(id),
  repo_id uuid not null references repos(id),
  event_type text not null,
  actor text not null,
  summary text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists review_comments (
  id uuid primary key,
  task_id uuid references tasks(id),
  pr_id text,
  source text not null,
  body text not null,
  file_path text,
  line integer,
  category text,
  status text not null,
  author text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists human_approvals (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  reason text not null,
  risk_level text not null,
  status text not null,
  decided_by text,
  decided_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists pr_state (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  title text not null,
  url text,
  branch text not null,
  base text,
  status text not null,
  body_artifact_id uuid references artifacts(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists integration_events (
  id uuid primary key,
  task_id uuid references tasks(id),
  integration text not null,
  event_type text not null,
  status text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_tasks_repo_status on tasks(repo_id, status);
create index if not exists idx_repo_nodes_path on repo_nodes(repo_id, path);
create index if not exists idx_repo_edges_source on repo_edges(source_node_id);
create index if not exists idx_repo_edges_target on repo_edges(target_node_id);
create index if not exists idx_hypotheses_task_status on hypotheses(task_id, status);
create index if not exists idx_claims_task_status on claims(task_id, status);
create index if not exists idx_evidence_task_type on evidence(task_id, evidence_type);
create index if not exists idx_verification_checks_task_status on verification_checks(task_id, status);
create index if not exists idx_trace_events_task_time on trace_events(task_id, created_at desc);
create index if not exists idx_commands_task_status on commands(task_id, status);
create index if not exists idx_beliefs_payload_gin on beliefs using gin(payload);
create index if not exists idx_verification_actions_payload_gin on verification_actions using gin(payload);
`,
  },
  {
    version: 2,
    name: 'add_artifact_mime_column',
    sql: `
-- Track 10: add a mime column to artifacts so the typed
-- ArtifactStore can store content-type alongside path/size/hash.
-- The column is nullable so existing rows (which had mime inferred
-- from file extension at read time) keep working.
alter table artifacts add column if not exists mime text;
`,
  },
]

export function fullSchemaSql(): string {
  return MIGRATIONS.map((m) => m.sql).join('\n\n')
}
