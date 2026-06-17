import { describe, it, expect, afterEach } from 'vitest'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { VerificationMatrixEngine, CheckpointManager } from '@forge/verification'
import { tmpStateDir, cleanup } from './helpers.js'

const dirs: string[] = []
async function stateDir(): Promise<string> {
  const d = await tmpStateDir()
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

describe('VerificationMatrixEngine', () => {
  it('adds and updates checks and reports full-pass state', async () => {
    const engine = new VerificationMatrixEngine({ stateDir: await stateDir() })
    await engine.addEntry('t', 'unit', { status: 'passed' })
    await engine.addEntry('t', 'lint', { status: 'failed' })

    let entries = await engine.getEntries('t')
    expect(entries).toHaveLength(2)
    expect(await engine.isFullyPassed('t')).toBe(false)

    await engine.updateStatus('t', 'lint', 'passed')
    expect(await engine.isFullyPassed('t')).toBe(true)
  })
})

describe('CheckpointManager', () => {
  it('creates, promotes, and rejects checkpoints', async () => {
    const cm = new CheckpointManager({ stateDir: await stateDir() })
    const cp = await cm.createCheckpoint('t', 'try approach A', ['src/a.ts'], 'fix bug', {
      riskAssessment: 'low',
    })
    expect(cp.verificationStatus).toBe('pending')

    await cm.promoteCheckpoint('t', cp.id)
    const promoted = await cm.getPromotedCheckpoints('t')
    expect(promoted.map((c) => c.id)).toContain(cp.id)

    const cp2 = await cm.createCheckpoint('t', 'try approach B', ['src/b.ts'], 'alt fix')
    await cm.rejectCheckpoint('t', cp2.id, 'tests failed')
    const all = await cm.getCheckpoints('t')
    expect(all.find((c) => c.id === cp2.id)?.promotionDecision).toBe('rejected')
  })

  it('snapshots files and rolls them back on restore', async () => {
    const workDir = await tmpStateDir()
    dirs.push(workDir)
    const stateDir = join(workDir, '.forge')
    await mkdir(join(workDir, 'src'), { recursive: true })
    const file = join(workDir, 'src/x.ts')
    await writeFile(file, 'export const x = 1\n')
    const newFile = join(workDir, 'src/new.ts')

    const cm = new CheckpointManager({ stateDir, workDir })
    const cp = await cm.createCheckpoint('t', 'edit x', ['src/x.ts', 'src/new.ts'], 'change behavior')

    // Make the risky changes.
    await writeFile(file, 'export const x = 999 // broken\n')
    await writeFile(newFile, 'export const created = true\n')

    const result = await cm.restoreCheckpoint('t', cp.id)
    expect(result).toBeDefined()
    // Pre-existing file restored to original; newly created file removed.
    expect(await readFile(file, 'utf-8')).toBe('export const x = 1\n')
    expect(existsSync(newFile)).toBe(false)
  })

  it('compares patch candidates and promotes one', async () => {
    const cm = new CheckpointManager({ stateDir: await stateDir() })
    const cp = await cm.createCheckpoint('t', 'h', ['src/a.ts'], 'r')
    const patch = await cm.createPatch('t', cp.id, 'h', 'diff --git a b', [
      { path: 'src/a.ts', changeType: 'modify', hunks: 1 },
    ])
    await cm.promotePatch('t', patch.id)
    const compared = await cm.comparePatches('t')
    expect(compared.promoted?.id).toBe(patch.id)
  })
})
