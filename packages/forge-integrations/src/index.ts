/**
 * @forge/integrations — typed adapter registry for external systems.
 *
 * This package hosts Forge's adapter implementations for GitHub, GitLab,
 * Linear, Jira, Slack, CI providers, and other external systems. Downstream
 * tracks will register concrete adapters against the IntegrationRegistry.
 *
 * This file is a placeholder scaffold. Subsequent tracks will populate the
 * registry with real adapters. The exported types here are stable so the
 * harness and the agent loop can wire against them without churn.
 */

import type {
  ChatAdapter,
  CiAdapter,
  IssueTrackerAdapter,
  PullRequestAdapter,
} from '@forge/types'

/** Names of every integration adapter the registry can hold. */
export type IntegrationName =
  | 'github'
  | 'gitlab'
  | 'linear'
  | 'jira'
  | 'slack'
  | 'circleci'
  | 'github-actions'

/** Typed empty registry — later tracks add concrete adapters here. */
export interface IntegrationRegistry {
  readonly issueTracker?: IssueTrackerAdapter
  readonly pullRequest?: PullRequestAdapter
  readonly chat?: ChatAdapter
  readonly ci?: CiAdapter
  /** Future slot for additional adapters keyed by integration name. */
  readonly extras?: Partial<Record<IntegrationName, unknown>>
}

/** Default empty registry — a frozen handle with no adapters wired in yet. */
export const INTEGRATION_REGISTRY: IntegrationRegistry = Object.freeze({
  extras: {},
})

export const INTEGRATIONS_VERSION = '0.0.1'