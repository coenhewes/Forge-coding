import { execFileSync } from 'node:child_process'

/**
 * Thin, defensive wrapper around git/gh for the agent's branch → commit → PR
 * flow. Every method is best-effort: it never throws on the unhappy path
 * (no git repo, no remote, gh missing). Callers branch on the boolean/optional
 * return values instead of catching exceptions, so a missing git setup degrades
 * to "no PR" rather than crashing a completed task.
 */
export class GitClient {
  constructor(private workDir: string) {}

  private run(args: string[]): { ok: boolean; out: string } {
    try {
      const out = execFileSync('git', args, {
        cwd: this.workDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, out: out.trim() }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string }
      return { ok: false, out: (e.stderr || e.stdout || String(err)).trim() }
    }
  }

  /** True when workDir is inside a git working tree. */
  isRepo(): boolean {
    const r = this.run(['rev-parse', '--is-inside-work-tree'])
    return r.ok && r.out === 'true'
  }

  /** Current branch name, or undefined (e.g. detached HEAD / not a repo). */
  currentBranch(): string | undefined {
    const r = this.run(['rev-parse', '--abbrev-ref', 'HEAD'])
    return r.ok && r.out && r.out !== 'HEAD' ? r.out : undefined
  }

  /** Create and switch to a new branch from the current HEAD. */
  createBranch(name: string): boolean {
    return this.run(['checkout', '-b', name]).ok
  }

  /** Switch to an existing branch. */
  checkout(name: string): boolean {
    return this.run(['checkout', name]).ok
  }

  /** True if there are staged or unstaged changes. */
  hasChanges(): boolean {
    const r = this.run(['status', '--porcelain'])
    return r.ok && r.out.length > 0
  }

  /** Stage the given paths (relative to repo root), or all changes if omitted. */
  stage(paths?: string[]): boolean {
    if (paths && paths.length > 0) {
      return this.run(['add', '--', ...paths]).ok
    }
    return this.run(['add', '-A']).ok
  }

  /** Commit staged changes. Returns the short SHA, or undefined if nothing committed. */
  commit(message: string): string | undefined {
    const r = this.run(['commit', '-m', message])
    if (!r.ok) return undefined
    const sha = this.run(['rev-parse', '--short', 'HEAD'])
    return sha.ok ? sha.out : undefined
  }

  /** True when an `origin` remote is configured. */
  hasRemote(): boolean {
    const r = this.run(['remote'])
    return r.ok && r.out.split('\n').filter(Boolean).length > 0
  }

  /** Push the branch to origin, setting upstream. */
  push(branch: string): boolean {
    return this.run(['push', '-u', 'origin', branch]).ok
  }

  /** Unified diff of the working tree against a base ref. */
  diff(base?: string): string {
    const args = base ? ['diff', `${base}...HEAD`] : ['diff', 'HEAD']
    return this.run(args).out
  }
}

/** True when the `gh` CLI is installed and authenticated. */
export function ghAvailable(workDir: string): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], {
      cwd: workDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Create a PR via `gh pr create`. Returns the PR URL on success, undefined
 * otherwise. Assumes the branch has been pushed.
 */
export function createGhPr(
  workDir: string,
  options: { title: string; body: string; base?: string },
): string | undefined {
  try {
    const args = ['pr', 'create', '--title', options.title, '--body', options.body]
    if (options.base) args.push('--base', options.base)
    const out = execFileSync('gh', args, {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const url = out.trim().split('\n').find((l) => l.startsWith('http'))
    return url ?? out.trim()
  } catch {
    return undefined
  }
}
