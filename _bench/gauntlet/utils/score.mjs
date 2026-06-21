/**
 * Score runner — executes verify commands and inspects diffs.
 *
 * Usage: node utils/score.mjs <workDir> "<verifyCommand>"
 * Returns JSON to stdout.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function main() {
  const workDir = process.argv[2]
  const verifyCommand = process.argv[3]

  if (!workDir || !verifyCommand) {
    console.error(JSON.stringify({ error: 'Usage: score.mjs <workDir> "<verifyCommand>"' }))
    process.exit(1)
  }

  // Run verify command
  const start = Date.now()
  let status = 'passed'
  let exitCode = 0
  let stdoutTail = ''
  let stderrTail = ''
  let error = null

  try {
    const out = execFileSync('sh', ['-c', verifyCommand], {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 600_000, // 10 minute timeout
      maxBuffer: 5 * 1024 * 1024,
    })
    stdoutTail = out.slice(-2048)
  } catch (err) {
    status = 'failed'
    exitCode = err.status ?? 1
    stdoutTail = (err.stdout ?? '').slice(-2048)
    stderrTail = (err.stderr ?? '').slice(-2048)
    error = err.message
  }

  const durationMs = Date.now() - start

  // Inspect diff for test weakening
  let diffSummary = ''
  let testWarnings = []
  try {
    const diff = execFileSync('git', ['diff', '--stat'], {
      cwd: workDir,
      encoding: 'utf-8',
    })
    diffSummary = diff.trim()

    // Check for deleted test files
    const deletedTests = execFileSync('git', ['diff', '--diff-filter=D', '--name-only'], {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim().split('\n').filter(Boolean).filter(f => f.includes('test') || f.includes('spec') || f.includes('__tests__'))
    if (deletedTests.length > 0) {
      testWarnings.push(`Deleted test file(s): ${deletedTests.join(', ')}`)
    }

    // Check for skipped tests
    const diffContent = execFileSync('git', ['diff'], {
      cwd: workDir,
      encoding: 'utf-8',
    })
    if (diffContent.includes('.skip') || diffContent.includes('.todo') || diffContent.includes('test.skip') || diffContent.includes('it.skip')) {
      testWarnings.push('Diff contains skipped/todo tests (test weakening detected)')
    }
  } catch {
    // git may not be available
  }

  const result = {
    status,
    exitCode,
    durationMs,
    stdoutTail,
    stderrTail,
    error,
    diffSummary,
    testWarnings,
    gatePassed: status === 'passed' && testWarnings.length === 0,
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

main()
