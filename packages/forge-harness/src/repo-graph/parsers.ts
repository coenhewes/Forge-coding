import type { SymbolDefinition, SymbolReference, CallSite } from '@forge/types'

export function parseImports(content: string, _file: string): ImportInfo[] {
  const imports: ImportInfo[] = []
  let match: RegExpExecArray | null

  // Static ES imports: import ... from '...'
  const staticImportRe = /^import\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*(?:\{[^}]*\}|\w+))?)\s+from\s+['"]([^'"]+)['"];?$/gm
  while ((match = staticImportRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'static' })
  }

  // Dynamic imports: import('...')
  const dynamicImportRe = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  while ((match = dynamicImportRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'dynamic' })
  }

  // CJS require: require('...')
  const cjsRe = /(?:const|let|var)\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((match = cjsRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'cjs' })
  }

  // Side-effect imports: import '...'
  const sideEffectRe = /^import\s+['"]([^'"]+)['"];?$/gm
  while ((match = sideEffectRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'static' })
  }

  // Re-exports: export ... from '...'
  const reexportRe = /^export\s+(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"];?$/gm
  while ((match = reexportRe.exec(content)) !== null) {
    imports.push({ source: match[1]!, line: countLines(content, match.index), type: 'static' })
  }

  return imports
}

export function parseExports(content: string, file: string): SymbolDefinition[] {
  const definitions: SymbolDefinition[] = []
  let match: RegExpExecArray | null

  // Named exports: export function/class/interface/type/const
  const namedExportPatterns: { re: RegExp; kind: SymbolDefinition['kind'] }[] = [
    { re: /^export\s+(?:default\s+)?(?:async\s+)?function\s+(?:\*\s+)?(\w+)/gm, kind: 'function' },
    { re: /^export\s+(?:default\s+)?class\s+(\w+)/gm, kind: 'class' },
    { re: /^export\s+interface\s+(\w+)/gm, kind: 'interface' },
    { re: /^export\s+type\s+(\w+)\s*=/gm, kind: 'type' },
    { re: /^export\s+(?:const|let|var)\s+(\w+)/gm, kind: 'variable' },
    { re: /^export\s+default\s+(?:function\s+)?(\w+)/gm, kind: 'variable' },
  ]

  for (const { re, kind } of namedExportPatterns) {
    while ((match = re.exec(content)) !== null) {
      definitions.push({
        name: match[1]!,
        kind,
        file,
        exported: true,
        line: countLines(content, match.index),
        column: match.index - content.lastIndexOf('\n', match.index) - 1,
        nodeId: `sym:${file}:${match[1]!}`,
      })
    }
  }

  // Named exports in braces: export { name1, name2 }
  const namedBracesRe = /^export\s+\{([^}]+)\}/gm
  while ((match = namedBracesRe.exec(content)) !== null) {
    const rawNames = match[1]!
    const names = rawNames.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean)
    for (const name of names) {
      if (name) {
        definitions.push({
          name,
          kind: 'variable' as const,
          file,
          exported: true,
          line: countLines(content, match.index),
          column: match.index - content.lastIndexOf('\n', match.index) - 1,
          nodeId: `sym:${file}:${name}`,
        })
      }
    }
  }

  // Local declarations (non-exported, for reference resolution)
  const localPatterns: { re: RegExp; kind: SymbolDefinition['kind'] }[] = [
    { re: /^(?:async\s+)?function\s+(\w+)/gm, kind: 'function' },
    { re: /^class\s+(\w+)/gm, kind: 'class' },
    { re: /^(?:const|let|var)\s+(\w+)\s*=/gm, kind: 'variable' },
    { re: /^interface\s+(\w+)/gm, kind: 'interface' },
    { re: /^type\s+(\w+)\s*=/gm, kind: 'type' },
  ]
  for (const { re, kind } of localPatterns) {
    while ((match = re.exec(content)) !== null) {
      const name = match[1]!
      if (!definitions.some((d) => d.name === name && d.file === file)) {
        definitions.push({
          name,
          kind,
          file,
          exported: false,
          line: countLines(content, match.index),
          column: match.index - content.lastIndexOf('\n', match.index) - 1,
          nodeId: `sym:${file}:${name}`,
        })
      }
    }
  }

  return definitions
}

export function parseReferences(content: string, file: string, defs: SymbolDefinition[]): SymbolReference[] {
  const refs: SymbolReference[] = []
  const defNames = new Set(defs.map((d) => d.name))
  let match: RegExpExecArray | null

  for (const def of defs) {
    const nameRe = new RegExp(`\\b${escapeRegex(def.name)}\\b`, 'g')
    while ((match = nameRe.exec(content)) !== null) {
      const line = countLines(content, match.index)
      if (line === def.line) continue
      refs.push({
        name: def.name,
        file,
        line,
        column: match.index - content.lastIndexOf('\n', match.index) - 1,
        sourceNodeId: `file:${file}`,
        targetNodeId: def.nodeId,
      })
    }
  }

  return refs
}

export function parseCallSites(content: string, file: string, defs: SymbolDefinition[]): CallSite[] {
  const calls: CallSite[] = []
  const defNames = new Set(defs.map((d) => d.name))
  let match: RegExpExecArray | null

  const callRe = /(\w+)\s*\(/g
  while ((match = callRe.exec(content)) !== null) {
    const name = match[1]!
    if (defNames.has(name)) {
      calls.push({
        caller: file,
        callee: name,
        file,
        line: countLines(content, match.index),
      })
    }
  }

  return calls
}

export interface ImportInfo {
  source: string
  line: number
  type: 'static' | 'dynamic' | 'cjs'
}

function countLines(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
