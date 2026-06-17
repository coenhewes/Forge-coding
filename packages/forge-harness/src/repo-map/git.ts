import { execSync } from 'node:child_process'
import { join } from 'node:path'
import type { GitHistory, GitCommit } from '@forge/types'

export function discoverGitHistory(root: string): GitHistory | undefined {
  try {
    const recentCommits = getRecentCommits(root)
    const activeBranch = getActiveBranch(root)
    const changedFiles = getChangedFiles(root)

    return {
      recentCommits,
      activeBranch,
      changedFiles,
    }
  } catch {
    return undefined
  }
}

function getRecentCommits(root: string, count = 10): GitCommit[] {
  try {
    const output = execSync(
      `git log --oneline -${count} --format="%H||%s||%an||%aI"`,
      { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 },
    )

    return output.trim().split('\n').filter(Boolean).map((line) => {
      const parts = line.split('||')
      const hash = parts[0] ?? ''
      const message = parts[1] ?? ''
      const author = parts[2] ?? ''
      const date = parts[3] ?? ''

      let files: string[] = []
      try {
        const fileOutput = execSync(
          `git diff-tree --no-commit-id --name-only -r ${hash}`,
          { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 },
        )
        files = fileOutput.trim().split('\n').filter(Boolean)
      } catch {
        // files not always available
      }

      return { hash, message, author, date, files }
    })
  } catch {
    return []
  }
}

function getActiveBranch(root: string): string {
  try {
    return execSync(
      'git branch --show-current',
      { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 },
    ).trim()
  } catch {
    return 'unknown'
  }
}

function getChangedFiles(root: string): string[] {
  try {
    const output = execSync(
      'git diff --name-only HEAD~5 HEAD',
      { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 },
    )
    return output.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}
