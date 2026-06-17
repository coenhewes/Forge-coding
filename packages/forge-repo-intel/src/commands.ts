import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  PackageInfo,
  AppInfo,
  EntrypointInfo,
  CommandInfo,
} from '@forge/types'
import { findEntries, isSourceFile, walkRepoIntel } from './walker.js'

/**
 * Commands discovered by reading `package.json` `scripts` blocks. We
 * pick out anything that smells like a build, lint, typecheck, or
 * test command so the agent loop can target the right package.
 */
export interface DiscoveredCommands {
  build: CommandInfo[]
  lint: CommandInfo[]
  typecheck: CommandInfo[]
  test: CommandInfo[]
  /** All other scripts (for general introspection). */
  other: CommandInfo[]
}

/**
 * Options accepted by `discoverPackages`.
 */
export interface DiscoverPackagesOptions {
  /** Maximum depth to search for `package.json` files. Defaults to 8. */
  maxDepth?: number
  /** Skip the root `package.json` if `private === true`. Defaults to true. */
  skipPrivateRoot?: boolean
}

/**
 * Walk the workspace, read every `package.json`, and emit the
 * canonical `PackageInfo` / `AppInfo` / `EntrypointInfo` shapes.
 *
 * The function is deliberately permissive: malformed JSON or a
 * missing file is silently skipped rather than aborting the whole
 * scan. The walker ignores the same directories as `walkRepoIntel`
 * (node_modules, dist, .git, …) so monorepos with vendor trees do
 * not pollute the result.
 */
export async function discoverPackages(
  root: string,
  options?: DiscoverPackagesOptions,
): Promise<{
  packages: PackageInfo[]
  apps: AppInfo[]
  entrypoints: EntrypointInfo[]
  buildCommands: CommandInfo[]
  lintCommands: CommandInfo[]
  typecheckCommands: CommandInfo[]
}> {
  const packages: PackageInfo[] = []
  const apps: AppInfo[] = []
  const entrypoints: EntrypointInfo[] = []
  const buildCommands: CommandInfo[] = []
  const lintCommands: CommandInfo[] = []
  const typecheckCommands: CommandInfo[] = []
  const skipPrivateRoot = options?.skipPrivateRoot ?? true

  const packageJsonFiles = await findEntries(
    root,
    (e) => !e.isDirectory && e.relativePath.endsWith('package.json'),
    { maxDepth: options?.maxDepth ?? 8 },
  )

  for (const file of packageJsonFiles) {
    try {
      const content = await readFile(file.path, 'utf-8')
      const json = JSON.parse(content) as Record<string, unknown>
      if (!json.name) continue
      const pkgDir = dirname(file.path)
      const pkgName = json.name as string

      const pkg: PackageInfo = {
        name: pkgName,
        path: pkgDir,
        type: 'library',
        version: (json.version as string) ?? '0.0.0',
        dependencies: (json.dependencies as Record<string, string>) ?? {},
        devDependencies: (json.devDependencies as Record<string, string>) ?? {},
      }

      if (skipPrivateRoot && json.private === true && pkgDir === root) {
        continue
      }

      const hasNextStyle = !!json.scripts && typeof json.scripts === 'object' && (
        'dev' in json.scripts || 'build' in json.scripts
      )
      if (isAppPackage(pkgDir)) {
        pkg.type = 'application'
        apps.push({
          name: pkgName,
          path: pkgDir,
          packageName: pkgName,
          entrypoints: [],
          framework: detectFramework(pkgDir, json),
        })
      } else if (isCLIPackage(json)) {
        pkg.type = 'tool'
      }
      void hasNextStyle

      packages.push(pkg)

      // Extract commands from scripts
      const scripts = (json.scripts as Record<string, string>) ?? {}
      for (const [name, command] of Object.entries(scripts)) {
        const cmdInfo: CommandInfo = {
          name: `${pkgName}:${name}`,
          command,
          workingDirectory: pkgDir,
        }
        if (/^build/i.test(name)) buildCommands.push(cmdInfo)
        else if (/^lint/i.test(name)) lintCommands.push(cmdInfo)
        else if (/^type.?check|^type-check/i.test(name)) typecheckCommands.push(cmdInfo)
      }

      // Discover entrypoints inside the package directory
      const entryFiles = await discoverEntrypoints(pkgDir)
      entrypoints.push(...entryFiles)
    } catch {
      // skip unreadable / malformed package.json files
    }
  }

  return { packages, apps, entrypoints, buildCommands, lintCommands, typecheckCommands }
}

/**
 * Top-level command discovery. Reads the workspace `package.json`,
 * every workspace `package.json`, AND every `turbo.json` it can
 * find. Returns canonical `DiscoveredCommands` buckets ready for
 * the verification planner to schedule.
 *
 * `turbo.json` is treated as an overlay: when it defines a pipeline
 * task (`build`, `lint`, `typecheck`, `test`) we synthesize a
 * `CommandInfo` that invokes `turbo run <task>` from the repo root
 * so the agent can fall back to the orchestrator when the
 * per-package command isn't appropriate.
 */
export async function discoverCommands(
  root: string,
  options?: DiscoverPackagesOptions,
): Promise<DiscoveredCommands> {
  const packages = await discoverPackages(root, options)
  const build = [...packages.buildCommands]
  const lint = [...packages.lintCommands]
  const typecheck = [...packages.typecheckCommands]
  const test: CommandInfo[] = []
  const other: CommandInfo[] = []

  for (const file of await findEntries(
    root,
    (e) => !e.isDirectory && /turbo\.json$/.test(e.relativePath),
    { maxDepth: 4 },
  )) {
    try {
      const content = await readFile(file.path, 'utf-8')
      const json = JSON.parse(content) as Record<string, unknown>
      const pipeline = (json.pipeline as Record<string, Record<string, unknown>> | undefined) ?? {}
      for (const task of ['build', 'lint', 'typecheck', 'test'] as const) {
        if (task in pipeline) {
          const cmd: CommandInfo = {
            name: `turbo:${task}`,
            command: `pnpm turbo run ${task}`,
            workingDirectory: root,
          }
          if (task === 'build') build.push(cmd)
          else if (task === 'lint') lint.push(cmd)
          else if (task === 'typecheck') typecheck.push(cmd)
          else test.push(cmd)
        }
      }
    } catch {
      // ignore malformed turbo.json
    }
  }

  // Lift any package-level `test`/`vitest`/`jest` script we found
  // during discoverPackages so the verification planner can pick
  // the right command for a given test suite.
  const allPackageJsons = await findEntries(
    root,
    (e) => !e.isDirectory && e.relativePath.endsWith('package.json'),
    { maxDepth: options?.maxDepth ?? 8 },
  )
  for (const file of allPackageJsons) {
    try {
      const content = await readFile(file.path, 'utf-8')
      const json = JSON.parse(content) as Record<string, unknown>
      if (!json.name) continue
      const scripts = (json.scripts as Record<string, string> | undefined) ?? {}
      const pkgDir = dirname(file.path)
      const pkgName = json.name as string
      for (const [name, command] of Object.entries(scripts)) {
        if (/^test/i.test(name)) {
          test.push({ name: `${pkgName}:${name}`, command, workingDirectory: pkgDir })
        } else if (!/^(build|lint|type.?check|type-check)/i.test(name)) {
          other.push({ name: `${pkgName}:${name}`, command, workingDirectory: pkgDir })
        }
      }
    } catch {
      // ignore
    }
  }

  return { build, lint, typecheck, test, other }
}

/**
 * Walk a package directory and emit `EntrypointInfo` records for
 * the well-known Next.js / server-entrypoint shapes. The function
 * is conservative — it only matches what we can recognize, and
 * silently drops anything that doesn't fit a known pattern.
 */
export async function discoverEntrypoints(pkgDir: string): Promise<EntrypointInfo[]> {
  const entries: EntrypointInfo[] = []
  for await (const entry of walkRepoIntel(pkgDir, { maxDepth: 4 })) {
    if (entry.isDirectory) continue
    const rel = entry.relativePath

    if (/^app\/.*\/page\.(tsx|jsx|js|ts)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'page' })
    } else if (/^app\/.*\/route\.(ts|js)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'api' })
    } else if (/^pages\/.*\.(tsx|jsx|js|ts)$/.test(rel) && !rel.includes('/api/')) {
      entries.push({ path: entry.path, type: 'page' })
    } else if (/^pages\/api\/.*\.(ts|js)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'api' })
    } else if (/^(src\/)?index\.(ts|js|mjs)$/.test(rel) || /^(src\/)?main\.(ts|js)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'other' })
    } else if (/^(src\/)?middleware\.(ts|js)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'middleware' })
    } else if (/^(src\/)?worker\.(ts|js)$/.test(rel) || rel.includes('/workers/')) {
      entries.push({ path: entry.path, type: 'worker' })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
//  Internal helpers
// ---------------------------------------------------------------------------

function isAppPackage(pkgDir: string): boolean {
  const dirName = pkgDir.split('/').pop() ?? pkgDir
  return dirName === 'app' || dirName.endsWith('-app') || dirName.endsWith('-web')
}

function isCLIPackage(json: Record<string, unknown>): boolean {
  return !!(
    json.bin ||
    ((json.name as string | undefined) ?? '').includes('-cli') ||
    ((json.name as string | undefined) ?? '').includes('cli-')
  )
}

function detectFramework(pkgDir: string, json: Record<string, unknown>): string | undefined {
  const deps = {
    ...((json.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((json.devDependencies as Record<string, unknown> | undefined) ?? {}),
  }
  if ('next' in deps) return 'next'
  if ('@remix-run/react' in deps) return 'remix'
  if ('@sveltejs/kit' in deps) return 'sveltekit'
  if ('nuxt' in deps || 'nuxt3' in deps) return 'nuxt'
  if ('express' in deps) return 'express'
  if ('@nestjs/core' in deps) return 'nestjs'
  if ('hono' in deps) return 'hono'
  void join
  void pkgDir
  return undefined
}

void isSourceFile