/**
 * `forge checkpoint <taskId>` — list patch candidates (and checkpoints).
 *
 *   - Reads from the file-based `CheckpointManager.comparePatches` to
 *     return promoted / failed / all patch candidates.
 *   - The full checkpoint tree is also returned so a reviewer can
 *     see what attempts were made and which one won.
 *
 * Output:
 *   --json   → { ok, exitCode, data: { taskId, checkpoints, patches, promoted, failed } }
 *   --text   → human-readable per-checkpoint + per-patch listing
 *
 * Exit codes:
 *   0  ok
 *   1  taskId missing
 */
import { loadConfig, initConfig } from '../config.js'
import { CheckpointManager } from '@forge/verification'
import type { Checkpoint, PatchCandidate } from '@forge/types'
import type { CommandResult, ParsedArgs } from './output.js'

export interface CheckpointData {
  taskId: string
  checkpoints: Checkpoint[]
  patches: PatchCandidate[]
  promoted?: PatchCandidate
  failed: PatchCandidate[]
}

export async function runCheckpoint(parsed: ParsedArgs): Promise<CommandResult<CheckpointData>> {
  const taskId = parsed.positional[0]
  if (!taskId) {
    return {
      ok: false,
      exitCode: 1,
      message: 'forge checkpoint requires a taskId. Usage: forge checkpoint <taskId>',
      textLines: ['Error: task ID required. Usage: forge checkpoint <taskId>'],
    }
  }

  let config = await loadConfig()
  if (!config) config = await initConfig()
  const cm = new CheckpointManager({ stateDir: config.stateDir, workDir: config.workDir })
  const checkpoints = await cm.getCheckpointTree(taskId)
  const { patches, promoted, failed } = await cm.comparePatches(taskId)

  const data: CheckpointData = {
    taskId,
    checkpoints,
    patches,
    promoted,
    failed,
  }

  const cpIcon = (c: Checkpoint) =>
    c.promotionDecision === 'promoted' ? '✓' : c.promotionDecision === 'rejected' ? '✗' : '○'
  const patchIcon = (p: PatchCandidate) => (p.promoted ? '✓' : p.verificationOutcome === 'failed' ? '✗' : '○')

  const textLines = [
    `Checkpoints for ${taskId}:`,
    ...(checkpoints.length === 0
      ? ['  (no checkpoints)']
      : checkpoints.flatMap((cp) => [
          `  ${cpIcon(cp)} ${cp.id} — ${cp.hypothesis}`,
          `      Files: ${cp.filesChanged.join(', ')}`,
          `      Reason: ${cp.reason}`,
          `      Verdict: ${cp.promotionDecision ?? 'pending'}`,
          ...(cp.failureReason ? [`      Failure: ${cp.failureReason}`] : []),
        ])),
    '',
    `Patch candidates: ${patches.length}`,
    `  Promoted: ${promoted ? `${promoted.id} (${promoted.hypothesis})` : 'none'}`,
    `  Failed: ${failed.length}`,
    ...(patches.length > 0
      ? ['', 'Patches:', ...patches.map((p) => `  ${patchIcon(p)} ${p.id} (${p.verificationOutcome}) — ${p.hypothesis.slice(0, 80)}`)]
      : []),
  ]

  return {
    ok: true,
    exitCode: 0,
    data,
    message: `${taskId}: ${patches.length} patch candidate(s), ${promoted ? 'one promoted' : 'none promoted'}`,
    textLines,
  }
}
