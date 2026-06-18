/**
 * Verification-bar tests: command detection + running checks against a real
 * temp project. These back the done-gate (a criterion is only verified once
 * its checks pass here).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectChecks, runVerification } from '@forge/agent'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function project(pkg: Record<string, unknown>, files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verbar-'))
  dirs.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(root, rel, '..'), { recursive: true }).catch(() => {})
    await writeFile(join(root, rel), content)
  }
  return root
}

describe('detectChecks', () => {
  it('maps package.json scripts to check commands', async () => {
    const root = await project({ scripts: { test: 'node --test', build: 'tsc', start: 'node server.js' } })
    const checks = detectChecks(root)
    expect(checks.test).toBe('npm test')
    expect(checks.build).toBe('npm run build')
    expect(checks.boot).toBe('npm start')
  })

  it('falls back to tsc --noEmit when a tsconfig exists but no typecheck script', async () => {
    const root = await project({ scripts: {} }, { 'tsconfig.json': '{}' })
    expect(detectChecks(root).typecheck).toBe('npx tsc --noEmit')
  })

  it('returns null for absent checks', async () => {
    const root = await project({ scripts: {} })
    const checks = detectChecks(root)
    expect(checks.test).toBeNull()
    expect(checks.build).toBeNull()
    expect(checks.boot).toBeNull()
  })
})

describe('runVerification', () => {
  it('reports pass for a passing test command and fail for a failing one', async () => {
    const passing = await project(
      { type: 'module', scripts: { test: 'node --test' } },
      { 'x.test.mjs': "import {test} from 'node:test'; import assert from 'node:assert'; test('ok',()=>assert.equal(1,1))" },
    )
    const passRes = await runVerification(passing, ['test'])
    expect(passRes).toHaveLength(1)
    expect(passRes[0]!.passed).toBe(true)

    const failing = await project(
      { type: 'module', scripts: { test: 'node --test' } },
      { 'x.test.mjs': "import {test} from 'node:test'; import assert from 'node:assert'; test('bad',()=>assert.equal(1,2))" },
    )
    const failRes = await runVerification(failing, ['test'])
    expect(failRes[0]!.passed).toBe(false)
  })

  it('skips checks with no detected command', async () => {
    const root = await project({ scripts: {} })
    expect(await runVerification(root, ['test', 'build'])).toEqual([])
  })
})
