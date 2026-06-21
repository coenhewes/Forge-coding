/**
 * Result writer — writes RESULT.md per test and updates SUMMARY.md.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Write RESULT.md for a single test.
 */
export function writeResult(gauntletDir, testId, result) {
  const dir = join(gauntletDir, testId)
  mkdirSync(dir, { recursive: true })

  const lines = [
    `# ${testId} Result`,
    '',
    `**Repo:** ${result.repo}`,
    `**Issue:** ${result.issueUrl}`,
    `**Verify command:** \`${result.verifyCommand}\``,
    '',
    '## Results',
    '',
    '### opencode',
    `**Status:** ${result.opencode.status}`,
    `**Input tokens:** ${result.opencode.tokens?.inputTokens ?? 'N/A'}`,
    `**Output tokens:** ${result.opencode.tokens?.outputTokens ?? 'N/A'}`,
    `**Total:** ${(result.opencode.tokens?.inputTokens ?? 0) + (result.opencode.tokens?.outputTokens ?? 0)}`,
    `**Calls:** ${result.opencode.tokens?.calls ?? 'N/A'}`,
    '',
    '### Forge',
    `**Status:** ${result.forge.status}`,
    `**Input tokens:** ${result.forge.tokens?.inputTokens ?? 'N/A'}`,
    `**Output tokens:** ${result.forge.tokens?.outputTokens ?? 'N/A'}`,
    `**Total:** ${(result.forge.tokens?.inputTokens ?? 0) + (result.forge.tokens?.outputTokens ?? 0)}`,
    `**Calls:** ${result.forge.tokens?.calls ?? 'N/A'}`,
    `**Iterations:** ${result.forge.iterations ?? 'N/A'}`,
    '',
    '## Scoring',
    `**Winner:** ${result.winner}`,
    '',
    '### Quality notes',
    ...(result.forge.notes ?? []).map(n => `- Forge: ${n}`),
    ...(result.opencode.notes ?? []).map(n => `- opencode: ${n}`),
    '',
    '### Forge defect found',
    result.forge.defect ? result.forge.defect : 'None',
    '',
    '### Forge fix applied',
    result.forge.fixApplied ? result.forge.fixApplied : 'None',
    '',
    '### Rerun required',
    result.rerunRequired ? 'yes' : 'no',
    '',
    '### Gate',
    result.gatePassed ? 'PASS' : 'FAIL',
    '',
    '## Verify output',
    '',
    '### opencode verify',
    '```',
    result.opencode.verifyOutput?.stdoutTail ?? 'N/A',
    '```',
    result.opencode.verifyOutput?.stderrTail ? `stderr:\n\`\`\`\n${result.opencode.verifyOutput.stderrTail}\n\`\`\`` : '',
    '',
    '### Forge verify',
    '```',
    result.forge.verifyOutput?.stdoutTail ?? 'N/A',
    '```',
    result.forge.verifyOutput?.stderrTail ? `stderr:\n\`\`\`\n${result.forge.verifyOutput.stderrTail}\n\`\`\`` : '',
    '',
  ]

  writeFileSync(join(dir, 'RESULT.md'), lines.join('\n'))
}

/**
 * Update SUMMARY.md with the current scoreboard.
 */
export function updateSummary(gauntletDir, allResults) {
  const lines = [
    '# Real-Issue Gauntlet Summary',
    '',
    '| ID | Repo | Issue | opencode | Forge | Winner | Gate |',
    '|----|------|-------|----------|-------|--------|------|',
    ...allResults.map(r => {
      const ocTokens = r.opencode.tokens
        ? (r.opencode.tokens.inputTokens + r.opencode.tokens.outputTokens)
        : 'N/A'
      const fTokens = r.forge.tokens
        ? (r.forge.tokens.inputTokens + r.forge.tokens.outputTokens)
        : 'N/A'
      return `| ${r.id} | ${r.repo} | ${r.issueUrl.split('/').pop()} | ${r.opencode.status} (${ocTokens}) | ${r.forge.status} (${fTokens}) | ${r.winner} | ${r.gatePassed ? '✅' : '❌'} |`
    }),
    '',
    '## Scoring Rules',
    '',
    '- Forge PASS + fewer tokens → Forge wins',
    '- Both PASS / Forge more tokens → opencode wins',
    '- Both FAIL → no winner',
    '- Forge FAIL / opencode PASS → opencode wins',
    '',
    `Generated: ${new Date().toISOString()}`,
  ]

  writeFileSync(join(gauntletDir, 'SUMMARY.md'), lines.join('\n'))
}

/**
 * Read the current manifest and update statuses.
 */
export function updateManifest(manifestPath, testId, status) {
  let manifest = []
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch {
    return
  }

  const entry = manifest.find(e => e.id === testId)
  if (entry) {
    entry.status = status
    entry.lastRun = new Date().toISOString()
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
