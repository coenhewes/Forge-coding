import { readFile } from 'node:fs/promises'
import { walkDir, isSourceFile } from './walker.js'

import type { RouteInfo, ServiceInfo, ComponentInfo } from '@forge/types'

export async function discoverRoutes(root: string): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = []

  for await (const entry of walkDir(root)) {
    if (entry.isDirectory || !isSourceFile(entry.path)) continue
    const rel = entry.relativePath

    try {
      const content = await readFile(entry.path, 'utf-8')

      // Next.js App Router: file-based routes
      if (rel.includes('/app/') && (rel.endsWith('/page.tsx') || rel.endsWith('/page.js') || rel.endsWith('/page.jsx'))) {
        const routePath = '/' + rel
          .replace(/^.*?\/app\//, '')
          .replace(/\/page\.(tsx|jsx|js|ts)$/, '')
          .replace(/\[\.\.\.(\w+)\]/g, ':$1*')
          .replace(/\[(\w+)\]/g, ':$1')
          .replace(/\/\(.*?\)/g, '') // remove route groups
          .replace(/\/index$/, '') || '/'

        routes.push({
          path: routePath,
          handler: rel.split('/').pop() ?? 'page',
          file: entry.path,
          middleware: [],
        })
      }

      // Next.js App Router API routes
      if (rel.includes('/app/') && (rel.endsWith('/route.ts') || rel.endsWith('/route.js'))) {
        const routePath = '/' + rel
          .replace(/^.*?\/app\//, '')
          .replace(/\/route\.(ts|js)$/, '')
          .replace(/\[\.\.\.(\w+)\]/g, ':$1*')
          .replace(/\[(\w+)\]/g, ':$1')
          .replace(/\/\(.*?\)/g, '')

        const methods = extractHttpMethods(content)
        for (const method of methods) {
          routes.push({
            method,
            path: routePath,
            handler: `${method} ${rel.split('/').pop() ?? 'route'}`,
            file: entry.path,
          })
        }
      }

      // Express-style route discovery
      const expressRoutePattern = /(app|router)\.(get|post|put|patch|delete|options)\s*\(\s*['"`]([^'"`]+)['"`]/g
      let match: RegExpExecArray | null
      while ((match = expressRoutePattern.exec(content)) !== null) {
        routes.push({
          method: match[2]!.toUpperCase(),
          path: match[3]!,
          handler: match[0]!.split(',')[1]?.trim() ?? 'handler',
          file: entry.path,
        })
      }
    } catch {
      // skip unreadable files
    }
  }

  return routes
}

export async function discoverServices(root: string): Promise<ServiceInfo[]> {
  const services: ServiceInfo[] = []

  for await (const entry of walkDir(root)) {
    if (entry.isDirectory || !isSourceFile(entry.path)) continue
    const rel = entry.relativePath

    const isServiceDir = rel.includes('/services/') || rel.includes('/service/')
    const isServiceFile = rel.endsWith('.service.ts') || rel.endsWith('.service.js')
    const isLibDir = rel.includes('/lib/')

    if (isServiceDir || isServiceFile || isLibDir) {
      try {
        const content = await readFile(entry.path, 'utf-8')
        const exports = extractExports(content)
        if (exports.length > 0) {
          services.push({
            name: entry.relativePath.split('/').pop()?.replace(/\.(ts|js)$/, '') ?? 'unknown',
            path: entry.path,
            exportedNames: exports,
          })
        }
      } catch {
        // skip
      }
    }
  }

  return services
}

export async function discoverComponents(root: string): Promise<ComponentInfo[]> {
  const components: ComponentInfo[] = []

  for await (const entry of walkDir(root)) {
    if (entry.isDirectory) continue
    const ext = entry.path.split('.').pop()
    if (ext !== 'tsx' && ext !== 'jsx') continue

    const rel = entry.relativePath
    // Skip test files, config files
    if (rel.includes('test') || rel.includes('spec') || rel.includes('config')) continue

    try {
      const content = await readFile(entry.path, 'utf-8')
      const componentName = extractComponentName(content, entry.path)
      if (componentName) {
        components.push({
          name: componentName,
          path: entry.path,
          framework: 'react',
        })
      }
    } catch {
      // skip
    }
  }

  return components
}

function extractHttpMethods(content: string): string[] {
  const methods: string[] = []
  const pattern = /\bexport\s+(async\s+)?(function\s+)?(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    methods.push(match[3]!)
  }
  if (methods.length === 0) methods.push('GET')
  return methods
}

function extractExports(content: string): string[] {
  const exports: string[] = []
  const exportPattern = /export\s+(?:async\s+)?(?:function|const|class|default\s+(?:function|class)?\s*)?(\w+)/g
  let match: RegExpExecArray | null
  while ((match = exportPattern.exec(content)) !== null) {
    if (match[1]) exports.push(match[1])
  }
  return exports
}

function extractComponentName(content: string, filePath: string): string | undefined {
  const exportDefault = content.match(/export\s+default\s+(?:function\s+)?(\w+)/)
  if (exportDefault?.[1]) return exportDefault[1]

  const namedExport = content.match(/export\s+(?:const|function)\s+(\w+)/)
  if (namedExport?.[1]) return namedExport[1]

  // Infer from filename
  const fileName = filePath.split('/').pop()?.replace(/\.(tsx|jsx)$/, '')
  if (fileName && /^[A-Z]/.test(fileName)) return fileName

  return undefined
}
