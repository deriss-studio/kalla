import { createDb, type Db } from '../src/db/client.js'
import { classifySheet, type DeclaredUse } from '../src/lib/classify.js'
import { column, rowEntity, sheet, workspace } from '../src/db/schema.js'
import type { AgentResult } from '../src/lib/write.js'

export interface Fixture {
  db: Db
  workspaceId: string
  sheetId: string
  columnId: string
  rowId: string
  close: () => Promise<void>
}

export async function fixture(
  opts: {
    declaredUse?: DeclaredUse
    columnName?: string
    dataClass?: 'none' | 'business' | 'personal' | 'special'
    retentionDays?: number
  } = {},
): Promise<Fixture> {
  const { db, client } = await createDb()

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

  let closed = false
  return {
    db,
    workspaceId: ws!.id,
    sheetId: sh!.id,
    columnId: col!.id,
    rowId: row!.id,
    // Idempotent: a test file may close explicitly and again in afterEach.
    close: async () => {
      if (closed) return
      closed = true
      await client.close()
    },
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
