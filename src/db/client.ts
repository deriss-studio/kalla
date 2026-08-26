import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from './schema.js'

const here = dirname(fileURLToPath(import.meta.url))

export type Db = ReturnType<typeof drizzle<typeof schema>>

/**
 * Development and test databases run on PGlite — real Postgres, compiled to
 * WebAssembly, in process. No Docker, no connection string, no shared state
 * between test files. Production points at a managed Postgres in an EU region;
 * the SQL is identical.
 */
export async function createDb(): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await applySchema(client)
  return { db, client }
}

async function applySchema(client: PGlite) {
  const migrationsDir = join(here, '../../drizzle')
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    // Drizzle separates statements with this marker.
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.exec(trimmed)
    }
  }

  // Triggers are applied after the tables exist. They are the invariants.
  const triggers = await readFile(join(here, 'triggers.sql'), 'utf8')
  await client.exec(triggers)
}

export { schema }
