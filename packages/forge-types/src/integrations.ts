export interface ReviewComment {
  id: string
  source: 'github' | 'gitlab' | 'linear' | 'jira' | 'manual'
  body: string
  file?: string
  line?: number
  category?: 'bug' | 'missing_test' | 'security' | 'style' | 'unclear_requirement' | 'verification_gap' | 'claim_evidence_gap'
  status: 'open' | 'addressed' | 'resolved' | 'wont_fix'
  author?: string
  createdAt: string
}

export interface PullRequestState {
  id: string
  title: string
  url?: string
  branch: string
  base?: string
  status: 'draft' | 'ready' | 'blocked' | 'merged' | 'closed'
  reviewComments: ReviewComment[]
}

export interface IssueTrackerAdapter {
  name: string
  getIssue(id: string): Promise<{ id: string; title: string; body: string; url?: string }>
  updateIssue(id: string, body: string): Promise<void>
}

export interface PullRequestAdapter {
  name: string
  getPullRequest(id: string): Promise<PullRequestState>
  createOrUpdatePullRequest(state: PullRequestState, body: string): Promise<PullRequestState>
  listReviewComments(id: string): Promise<ReviewComment[]>
  replyToReviewComment(id: string, body: string): Promise<void>
}

export interface ChatAdapter {
  name: string
  notify(channel: string, message: string): Promise<void>
}

export interface CiAdapter {
  name: string
  getStatus(ref: string): Promise<{ status: 'pending' | 'passed' | 'failed'; url?: string }>
  publishReport(ref: string, report: string): Promise<void>
}
