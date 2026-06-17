import { describe, it, expect, afterEach } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  scanRepository,
  buildGraph,
  getDomainManifests,
  routeTask,
  buildCapabilityRegistry,
  CapabilityExecutor,
} from '@forge/harness'
import { tmpStateDir, cleanup } from './helpers.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(cleanup))
})

async function fixtureRepo(): Promise<string> {
  const root = await tmpStateDir()
  dirs.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'src/util.ts'),
    'export function formatName(first: string, last: string): string {\n  return `${first} ${last}`.trim()\n}\n',
  )
  await writeFile(
    join(root, 'src/a.ts'),
    "import { formatName } from './util'\nexport const greetA = (f: string, l: string) => `Hi ${formatName(f, l)}`\n",
  )
  await writeFile(
    join(root, 'src/b.ts'),
    "import { formatName } from './util'\nexport const greetB = (f: string, l: string) => `Hello ${formatName(f, l)}`\n",
  )
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
  return root
}

describe('semantic capabilities (graph-backed)', () => {
  it('find_definitions and find_callers resolve cross-file usage', async () => {
    const root = await fixtureRepo()
    const map = await scanRepository(root)
    const graph = await buildGraph(map, root)
    const manifests = getDomainManifests()
    const selection = routeTask('modify util helper', map, graph)
    const registry = buildCapabilityRegistry(selection.selectedDomains, manifests, {
      hasDatabase: !!map.database,
    })
    const exec = new CapabilityExecutor(registry, manifests, {
      repoRoot: root,
      repoMap: map,
      repoGraph: graph,
      taskState: null,
      evidence: null,
      failureLedger: null,
      decisionLedger: null,
    })

    const defs = await exec.execute('repo.find_definitions', { symbol: 'formatName' }, { bypassPermissions: true })
    expect(defs.success).toBe(true)
    expect((defs.data as { count: number }).count).toBe(1)

    const callers = await exec.execute('repo.find_callers', { symbol: 'formatName' }, { bypassPermissions: true })
    expect(callers.success).toBe(true)
    // Called from a.ts and b.ts — not from its own declaration.
    const callerFiles = (callers.data as { callers: { file: string }[] }).callers.map((c) => c.file)
    expect(callerFiles.some((f) => f.endsWith('a.ts'))).toBe(true)
    expect(callerFiles.some((f) => f.endsWith('b.ts'))).toBe(true)
    expect(callerFiles.some((f) => f.endsWith('util.ts'))).toBe(false)
  })

  it('exposes a semantic tool surface for the selected domains', async () => {
    const root = await fixtureRepo()
    const map = await scanRepository(root)
    const manifests = getDomainManifests()
    const registry = buildCapabilityRegistry(['shared'], manifests, { hasDatabase: false })
    const names = registry.toToolDefinitions().map((t) => t.name)
    expect(names).toContain('repo.find_callers')
    expect(names).toContain('repo.find_definitions')
    expect(names).toContain('tests.find_related_tests')
  })
})
