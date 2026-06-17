import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Create a unique temp state dir for an engine test. */
export async function tmpStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'forge-test-'))
}

/** Recursively remove a temp dir created by tmpStateDir. */
export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
