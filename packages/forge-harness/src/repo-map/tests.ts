import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { walkDir, isTestFile } from './walker.js'

import type { TestSuiteInfo } from '@forge/types'

const FRAMEWORK_INDICATORS: Record<string, string[]> = {
  vitest: ['vitest.config', 'vite.config'],
  jest: ['jest.config', 'jest.config.js', 'jest.config.ts'],
  mocha: ['.mocharc', 'mocha.opts'],
  playwright: ['playwright.config', 'playwright-ct.config'],
  cypress: ['cypress.config', 'cypress.json'],
  ava: ['ava.config'],
  uvu: [],
}

export async function discoverTests(root: string): Promise<TestSuiteInfo[]> {
  const testSuites: Map<string, TestSuiteInfo> = new Map()

  // Detect framework from config files
  const framework = await detectTestFramework(root)

  for await (const entry of walkDir(root)) {
    if (entry.isDirectory) continue
    if (!isTestFile(entry.relativePath)) continue

    const relPath = entry.relativePath
    const className = deriveTestSuiteName(relPath)
    const baseDir = findTestBaseDir(relPath)

    if (baseDir) {
      const existing = testSuites.get(baseDir)
      if (existing) {
        existing.files.push(entry.path)
      } else {
        const suiteType = deriveTestType(relPath)
        testSuites.set(baseDir, {
          name: className,
          path: baseDir,
          framework,
          type: suiteType,
          files: [entry.path],
        })
      }
    }
  }

  return Array.from(testSuites.values())
}

async function detectTestFramework(root: string): Promise<string> {
  for (const [framework, indicators] of Object.entries(FRAMEWORK_INDICATORS)) {
    for (const indicator of indicators) {
      for await (const entry of walkDir(root, { depth: 3 })) {
        if (!entry.isDirectory && entry.relativePath.includes(indicator)) {
          return framework
        }
      }
    }
  }
  // Check package.json for test dependencies
  try {
    const content = await readFile(join(root, 'package.json'), 'utf-8')
    const json = JSON.parse(content) as Record<string, unknown>
    const deps = { ...(json.dependencies as Record<string, unknown> ?? {}), ...(json.devDependencies as Record<string, unknown> ?? {}) }
    if ('vitest' in deps) return 'vitest'
    if ('jest' in deps) return 'jest'
    if ('playwright' in deps) return 'playwright'
    if ('cypress' in deps) return 'cypress'
    if ('mocha' in deps) return 'mocha'
  } catch {
    // fall through
  }
  return 'unknown'
}

function deriveTestSuiteName(relPath: string): string {
  const parts = relPath.split('/')
  // Look for __tests__ or test directory as the suite name
  const testDirIndex = parts.findIndex((p) => p === '__tests__' || p === 'test' || p === 'tests')
  if (testDirIndex >= 0) {
    return parts.slice(0, testDirIndex + 1).join('/')
  }
  // Otherwise use file name
  return parts[parts.length - 1]?.replace(/\.(test|spec|e2e)\.\w+$/, '') ?? 'unknown'
}

function findTestBaseDir(relPath: string): string | null {
  const parts = relPath.split('/')
  const testDirIndex = parts.findIndex((p) => p === '__tests__' || p === 'test' || p === 'tests')
  if (testDirIndex >= 0) {
    return parts.slice(0, testDirIndex + 1).join('/')
  }
  // For co-located test files, use the parent directory
  return parts.slice(0, -1).join('/') || null
}

function deriveTestType(relPath: string): TestSuiteInfo['type'] {
  if (relPath.includes('/e2e/') || relPath.endsWith('.e2e.ts') || relPath.endsWith('.e2e.tsx')) {
    return 'e2e'
  }
  if (relPath.includes('/integration/') || relPath.endsWith('.integration.ts')) {
    return 'integration'
  }
  if (relPath.includes('/visual/') || relPath.includes('/screenshot/')) {
    return 'visual'
  }
  return 'unit'
}
