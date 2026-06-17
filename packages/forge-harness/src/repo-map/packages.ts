import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { walkDir, type FileEntry } from './walker.js'

import type {
  PackageInfo,
  AppInfo,
  EntrypointInfo,
  CommandInfo,
} from '@forge/types'

export async function discoverPackages(root: string): Promise<{
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

  const visited = new Set<string>()
  const packageJsonFiles: FileEntry[] = []

  for await (const entry of walkDir(root, { depth: 8 })) {
    if (!entry.isDirectory && entry.relativePath.endsWith('package.json')) {
      packageJsonFiles.push(entry)
    }
  }

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

      if (json.private === true && pkgDir === root) {
        continue
      }

      // Detect package type
      const hasNextConfig = json.scripts && typeof json.scripts === 'object' && (
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

      // Discover entrypoints
      const entryFiles = await discoverEntrypoints(pkgDir)
      entrypoints.push(...entryFiles)
    } catch {
      // skip unreadable package.json files
    }
  }

  return { packages, apps, entrypoints, buildCommands, lintCommands, typecheckCommands }
}

function isAppPackage(pkgDir: string): boolean {
  const dirName = pkgDir.split('/').pop() ?? pkgDir
  return dirName === 'app' || dirName.endsWith('-app') || dirName.endsWith('-web')
}

function isCLIPackage(json: Record<string, unknown>): boolean {
  return !!(json.bin || (json.name as string ?? '').includes('-cli') || (json.name as string ?? '').includes('cli-'))
}

function detectFramework(pkgDir: string, json: Record<string, unknown>): string | undefined {
  const deps = { ...(json.dependencies as Record<string, unknown> ?? {}), ...(json.devDependencies as Record<string, unknown> ?? {}) }
  if ('next' in deps) return 'next'
  if ('@remix-run/react' in deps) return 'remix'
  if ('@sveltejs/kit' in deps) return 'sveltekit'
  if ('nuxt' in deps || 'nuxt3' in deps) return 'nuxt'
  if ('express' in deps) return 'express'
  if ('@nestjs/core' in deps) return 'nestjs'
  if ('hono' in deps) return 'hono'
  return undefined
}

async function discoverEntrypoints(pkgDir: string): Promise<EntrypointInfo[]> {
  const entries: EntrypointInfo[] = []

  for await (const entry of walkDir(pkgDir, { depth: 4 })) {
    if (entry.isDirectory) continue
    const rel = entry.relativePath

    // Next.js App Router pages
    if (/^app\/.*\/page\.(tsx|jsx|js|ts)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'page' })
    }
    // Next.js App Router route handlers
    if (/^app\/.*\/route\.(ts|js)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'api' })
    }
    // Next.js Pages Router
    if (/^pages\/.*\.(tsx|jsx|js|ts)$/.test(rel) && !rel.includes('/api/')) {
      entries.push({ path: entry.path, type: 'page' })
    }
    // Next.js API routes
    if (/^pages\/api\/.*\.(ts|js)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'api' })
    }
    // Server entrypoints
    if (/^(src\/)?index\.(ts|js|mjs)$/.test(rel) || /^(src\/)?main\.(ts|js)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'other' })
    }
    // Middleware
    if (/^(src\/)?middleware\.(ts|js)$/.test(rel)) {
      entries.push({ path: entry.path, type: 'middleware' })
    }
    // Workers
    if (/^(src\/)?worker\.(ts|js)$/.test(rel) || rel.includes('/workers/')) {
      entries.push({ path: entry.path, type: 'worker' })
    }
  }

  return entries
}
