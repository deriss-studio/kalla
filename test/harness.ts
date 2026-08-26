/**
 * One database per test FILE, truncated between tests.
 *
 * CLAUDE.md specifies PGlite "isolated per test file", and that is the right
 * granularity. Two measurements shape how it is done here:
 *
 *   - A database per *test* meant 24 boots. Under file parallelism every
 *     worker starved and the suite timed out. Hence one per file, emptied
 *     between tests: the same isolation, a seventh of the boots.
 *
 *   - The expensive half of starting Postgres-in-WASM is `initdb`, not loading
 *     the WebAssembly, and restoring a data directory skips it. So the schema
 *     is built once per run in test/global-setup.ts and every file restores
 *     from that. Measured across the suite, it takes the slowest test from
 *     ~10s to ~2s — and the slowest test is the number that has to stay
 *     clear of testTimeout.
 *
 * Isolation between files needs no coordination: vitest gives each test file
 * its own module registry, so the handle below is per file by construction.
 */

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, schema, type Db } from '../src/db/client.js'
import { classifySheet, type DeclaredUse } from '../src/lib/classify.js'
import { column, rowEntity, sheet, workspace } from '../src/db/schema.js'
import type { AgentResult } from '../src/lib/write.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Built fresh by global setup on every run, so it can never go stale. */
const SNAPSHOT = join(here, '../node_modules/.cache/kalla/schema-snapshot.tar')

export interface Fixture {
  db: Db
  workspaceId: string
  sheetId: string
  columnId: string
  rowId: string
}

/**
 * Every table in the schema, emptied. Derived from the catalogue rather than
 * from a list someone has to remember to extend, for the same reason the
 * erasure test scans information_schema: a table added next year is included
 * without anyone thinking about it.
 */
const TRUNCATE_ALL = sql`
  DO $$
  DECLARE
    stmt text;
  BEGIN
    SELECT 'TRUNCATE TABLE ' || string_agg(quote_ident(tablename), ', ')
             || ' RESTART IDENTITY CASCADE'
      INTO stmt
      FROM pg_tables
     WHERE schemaname = 'public';
    IF stmt IS NOT NULL THEN EXECUTE stmt; END IF;
  END $$`

/**
 * Boot one migrated database, snapshot its data directory, throw it away.
 * Called once per run from test/global-setup.ts — this is the only cold
 * `initdb` the suite pays for.
 */
export async function buildSchemaSnapshot(): Promise<void> {
  const { client } = await createDb()
  const dump = await client.dumpDataDir('none')
  await mkdir(dirname(SNAPSHOT), { recursive: true })
  await writeFile(SNAPSHOT, Buffer.from(await dump.arrayBuffer()))
  await client.close()
}

export async function removeSchemaSnapshot(): Promise<void> {
  await rm(dirname(SNAPSHOT), { recursive: true, force: true })
}

async function open(): Promise<{ db: Db; client: PGlite }> {
  // Narrower than a bare `Buffer`, whose backing store may be a
  // SharedArrayBuffer and so is not a valid BlobPart.
  let snapshot: Buffer<ArrayBuffer>
  try {
    snapshot = await readFile(SNAPSHOT)
  } catch (err) {
    // Absent is the one failure with a legitimate meaning: this file is being
    // run outside the project's vitest config, so no global setup built a
    // snapshot. Falling back is correct, only slower — and the triggers hold
    // either way, since invariants 1, 2 and 5 each assert the database refuses
    // a write that bypassed the write path.
    //
    // Every other failure — unreadable, truncated, a permissions problem — is
    // a real fault, and a silent downgrade to a slow path would hide it. An
    // unchecked state must not be quietly given a plausible value.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return createDb()
  }

  const client = new PGlite({ loadDataDir: new Blob([snapshot]) })
  await client.waitReady
  return { db: drizzle(client, { schema }), client }
}

/** Memoised as a promise, so concurrent tests in one file share one boot. */
let booting: Promise<{ db: Db; client: PGlite }> | null = null

function database(): Promise<{ db: Db; client: PGlite }> {
  return (booting ??= open())
}

/** Empty every table. Registered as an afterEach hook in test/setup.ts. */
export async function resetDatabase(): Promise<void> {
  if (!booting) return
  const { db } = await booting
  await db.execute(TRUNCATE_ALL)
}

/** Close the file's database. Registered as an afterAll hook in test/setup.ts. */
export async function closeDatabase(): Promise<void> {
  if (!booting) return
  const pending = booting
  booting = null
  const { client } = await pending
  await client.close()
}

export async function fixture(
  opts: {
    declaredUse?: DeclaredUse
    columnName?: string
    dataClass?: 'none' | 'business' | 'personal' | 'special'
    retentionDays?: number
  } = {},
): Promise<Fixture> {
  const { db } = await database()

  // Also truncated here, not only in the afterEach hook. A test's isolation
  // should not depend on the previous test's teardown having run, in the same
  // way the invariants hold in both the application layer and the triggers.
  await db.execute(TRUNCATE_ALL)

  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Test workspace', regionPin: 'eu-north-1' })
    .returning({ id: workspace.id })

  const use = opts.declaredUse ?? 'market_mapping'
  const [sh] = await db
    .insert(sheet)
    .values({
      workspaceId: ws!.id,
      name: 'Nordic scale-ups',
      purpose: 'Map Nordic scale-ups for advisory business development.',
      declaredUse: use,
      aiActClass: classifySheet(use).aiActClass,
      personalDataExpected: opts.dataClass === 'personal',
    })
    .returning({ id: sheet.id })

  const [col] = await db
    .insert(column)
    .values({
      sheetId: sh!.id,
      key: 'test_column',
      name: opts.columnName ?? 'Headquarters',
      prompt: 'Where is the company headquartered?',
      dataClass: opts.dataClass ?? 'business',
      retentionDays: opts.retentionDays ?? 180,
    })
    .returning({ id: column.id })

  const [row] = await db
    .insert(rowEntity)
    .values({ sheetId: sh!.id, label: 'Testbolaget', kind: 'organisation' })
    .returning({ id: rowEntity.id })

  return {
    db,
    workspaceId: ws!.id,
    sheetId: sh!.id,
    columnId: col!.id,
    rowId: row!.id,
  }
}

/**
 * Drizzle wraps driver errors, so a trigger's message ends up on `cause`.
 * Walk the chain and return every message joined, so an invariant test can
 * assert on what the database actually said.
 */
export async function rejectionMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    const parts: string[] = []
    let current: unknown = err
    while (current instanceof Error) {
      parts.push(current.message)
      current = (current as { cause?: unknown }).cause
    }
    return parts.join(' | ')
  }
  throw new Error('expected the call to be rejected, but it resolved')
}

/** A well-formed agent result: a value with a source attached. */
export function sourced(value: string, url = 'https://testbolaget.example/about'): AgentResult {
  return {
    value,
    state: 'filled',
    sources: [{ url, retrievedAt: new Date(), quote: `…${value}…` }],
    confidence: 0.9,
    modelId: 'test-model',
    modelRegion: 'eu-west-1',
  }
}
