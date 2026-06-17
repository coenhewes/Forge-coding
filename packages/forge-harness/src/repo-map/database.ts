import { readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { walkDir, findFiles } from './walker.js'

import type { DatabaseInfo, MigrationInfo, TableInfo } from '@forge/types'

export async function discoverDatabase(root: string): Promise<{
  database: DatabaseInfo | null
  migrations: MigrationInfo[]
}> {
  const database = await findDatabaseSchema(root)
  const migrations = await discoverMigrations(root)
  return { database, migrations }
}

async function findDatabaseSchema(root: string): Promise<DatabaseInfo | null> {
  // Prisma
  const prismaFiles = await findFiles(root, (e) =>
    !e.isDirectory && e.relativePath.endsWith('schema.prisma') && !e.relativePath.includes('node_modules'),
  )
  if (prismaFiles.length > 0) {
    return parsePrismaSchema(prismaFiles[0]!.path)
  }

  // Knex
  const knexFiles = await findFiles(root, (e) =>
    !e.isDirectory &&
    (e.relativePath.endsWith('knexfile.ts') || e.relativePath.endsWith('knexfile.js')),
  )
  if (knexFiles.length > 0) {
    return { type: 'postgres', tables: [], orm: 'knex' }
  }

  // Drizzle
  const drizzleFiles = await findFiles(root, (e) =>
    !e.isDirectory &&
    (e.relativePath.includes('drizzle.config') || e.relativePath.includes('drizzle/')),
  )
  if (drizzleFiles.length > 0) {
    return { type: 'postgres', tables: [], orm: 'drizzle' }
  }

  return null
}

async function parsePrismaSchema(schemaPath: string): Promise<DatabaseInfo> {
  try {
    const content = await readFile(schemaPath, 'utf-8')
    const tables: TableInfo[] = []

    // Detect database provider
    const providerMatch = content.match(/provider\s*=\s*["'](\w+)["']/)
    const provider = providerMatch?.[1]?.toLowerCase() ?? 'postgres'
    const dbType = provider === 'mysql' ? 'mysql' as const
      : provider === 'sqlite' ? 'sqlite' as const
      : provider === 'mongodb' ? 'mongodb' as const
      : 'postgres' as const

    // Parse models
    const modelRegex = /model\s+(\w+)\s*\{([^}]+\})\s*\}/gs
    let modelMatch: RegExpExecArray | null
    while ((modelMatch = modelRegex.exec(content)) !== null) {
      const tableName = modelMatch[1]!
      const block = modelMatch[2]!
      const columns = parsePrismaFields(block)
      tables.push({ name: tableName, columns })
    }

    return { type: dbType, tables, orm: 'prisma' }
  } catch {
    return { type: 'postgres', tables: [], orm: 'prisma' }
  }
}

function parsePrismaFields(block: string): TableInfo['columns'] {
  const columns: TableInfo['columns'] = []
  const fieldRegex = /^\s{2,}(\w+)\s+(\w+(?:\[\])?)\s*(@\w+(?:\([^)]*\))?)?/gm
  let match: RegExpExecArray | null
  while ((match = fieldRegex.exec(block)) !== null) {
    const name = match[1]!
    const type = match[2]!
    const attrs = match[3] ?? ''
    columns.push({
      name,
      type,
      nullable: !attrs.includes('@required'),
      primaryKey: attrs.includes('@id'),
      foreignKey: attrs.includes('@relation') ? name : undefined,
    })
  }
  return columns
}

async function discoverMigrations(root: string): Promise<MigrationInfo[]> {
  const migrations: MigrationInfo[] = []

  // Prisma migrations
  for await (const entry of walkDir(root)) {
    if (entry.isDirectory && entry.relativePath.includes('prisma/migrations/')) {
      const migrationName = basename(entry.path)
      // A valid migration directory has a migration.sql file
      const migrationDir = entry.path
      try {
        const files = await readFile(join(migrationDir, 'migration.sql'), 'utf-8').then(() => true).catch(() => false)
        if (files) {
          migrations.push({
            name: migrationName,
            path: migrationDir,
            timestamp: migrationName.split('_')[0] ?? migrationName,
            state: 'applied',
            tablesTouched: extractTablesFromSql(
              await readFile(join(migrationDir, 'migration.sql'), 'utf-8').catch(() => ''),
            ),
          })
        }
      } catch {
        // skip
      }
    }
  }

  return migrations
}

function extractTablesFromSql(sql: string): string[] {
  const tables = new Set<string>()
  const tableRegex = /(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["'`]?\w+["'`]?\.)?["'`]?(\w+)["'`]?/gi
  let match: RegExpExecArray | null
  while ((match = tableRegex.exec(sql)) !== null) {
    if (match[1]) tables.add(match[1])
  }
  return Array.from(tables)
}
