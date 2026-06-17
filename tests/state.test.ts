import { describe, it, expect, afterEach } from 'vitest'
import {
  TaskStateEngine,
  AcceptanceContractEngine,
  EvidenceLedgerEngine,
  FailureLedgerEngine,
  DecisionLedgerEngine,
} from '@forge/state'
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

describe('TaskStateEngine', () => {
  it('creates, mutates, and persists a task across instances', async () => {
    const stateDirPath = await stateDir()
    const engine = new TaskStateEngine({ stateDir: stateDirPath })

    await engine.createTask('t1', 'Do the thing')
    await engine.updateStatus('t1', 'implementing')
    await engine.addFileTouched('t1', 'src/a.ts')
    await engine.addCommandRun('t1', 'npm test')

    const task = await engine.getTask('t1')
    expect(task?.status).toBe('implementing')
    expect(task?.filesTouched).toContain('src/a.ts')
    expect(task?.commandsRun).toContain('npm test')

    // Re-read from a fresh instance to prove disk persistence.
    const reloaded = await new TaskStateEngine({ stateDir: stateDirPath }).getTask('t1')
    expect(reloaded?.filesTouched).toContain('src/a.ts')
  })

  it('lists tasks', async () => {
    const engine = new TaskStateEngine({ stateDir: await stateDir() })
    await engine.createTask('a', 'one')
    await engine.createTask('b', 'two')
    const ids = await engine.listTasks()
    expect(ids.sort()).toEqual(['a', 'b'])
  })

  it('deduplicates touched files', async () => {
    const engine = new TaskStateEngine({ stateDir: await stateDir() })
    await engine.createTask('t', 'x')
    await engine.addFileTouched('t', 'src/a.ts')
    await engine.addFileTouched('t', 'src/a.ts')
    const task = await engine.getTask('t')
    expect(task?.filesTouched.filter((f) => f === 'src/a.ts')).toHaveLength(1)
  })
})

describe('AcceptanceContractEngine', () => {
  it('generates criteria from domains and computes completion', async () => {
    const engine = new AcceptanceContractEngine({ stateDir: await stateDir() })
    const contract = await engine.generateContract('t', 'Add auth', ['auth'])
    expect(contract.criteria.length).toBeGreaterThan(0)

    let status = await engine.getCompletionStatus('t')
    expect(status.allVerified).toBe(false)

    for (const c of contract.criteria) {
      await engine.updateCriterionStatus('t', c.id, 'verified')
    }
    status = await engine.getCompletionStatus('t')
    expect(status.allVerified).toBe(true)
    expect(status.percentComplete).toBe(100)
  })

  it('persists the contract to disk', async () => {
    const dir = await stateDir()
    await new AcceptanceContractEngine({ stateDir: dir }).generateContract('t', 'Add API', ['backend'])
    const reloaded = await new AcceptanceContractEngine({ stateDir: dir }).getContract('t')
    expect(reloaded).toBeDefined()
    expect(reloaded?.criteria.length).toBeGreaterThan(0)
  })
})

describe('EvidenceLedgerEngine', () => {
  it('records evidence and summarizes', async () => {
    const engine = new EvidenceLedgerEngine({ stateDir: await stateDir() })
    await engine.addEntry('t', 'Build passes', 'test_result', { evidence: ['tsc exit 0'] })
    const summary = await engine.getSummary('t')
    expect(summary.total).toBe(1)
    const ledger = await engine.getLedger('t')
    expect(ledger?.entries[0]?.claim).toBe('Build passes')
  })
})

describe('FailureLedgerEngine', () => {
  it('records a failure and reflects on a matching hypothesis', async () => {
    const engine = new FailureLedgerEngine({ stateDir: await stateDir() })
    await engine.addEntry(
      't',
      'Bumping timeout fixes the flake',
      'set timeout=5000',
      'still flaky',
      'the flake is not timing related',
      { nextHypothesis: 'investigate shared global state' },
    )
    const entries = await engine.getEntries('t')
    expect(entries).toHaveLength(1)
    const reflection = await engine.getReflection('t', 'Bumping timeout fixes the flake')
    expect(reflection).toBeDefined()
  })
})

describe('DecisionLedgerEngine', () => {
  it('records decisions with rejected alternatives', async () => {
    const engine = new DecisionLedgerEngine({ stateDir: await stateDir() })
    await engine.addEntry('t', 'Use JWT', 'stateless and simple', ['server sessions'], { domain: 'auth' })
    const entries = await engine.getEntries('t')
    expect(entries[0]?.decision).toBe('Use JWT')
    expect(entries[0]?.alternativesRejected).toContain('server sessions')
  })
})
