/**
 * INVARIANT 3 — Erasure is total.
 *
 * Erase a person and assert their data survives in no cell, no provenance
 * quote, no source URL that could reconstruct it, and no person row. The
 * tombstone that proves the erasure happened is allowed; identifying content
 * is not.
 *
 * The test scans the whole database rather than the tables we remember, so that
 * adding a table which stores a value cannot silently escape it.
 */

import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fixture, sourced, type Fixture } from '../harness.js'
import { writeCellValue } from '../../src/lib/write.js'
import { erasePerson } from '../../src/lib/person.js'
import { cell, person } from '../../src/db/schema.js'

let f: Fixture

const SUBJECT = 'Vera Exempel Testsson'

/** Every text-ish column in every table, scanned for the subject's data. */
async function databaseContains(f: Fixture, needle: string): Promise<string[]> {
  const cols = await f.db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type IN ('text','character varying','jsonb','json')
  `)

  const hits: string[] = []
  for (const c of cols.rows) {
    const found = await f.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(c.table_name)}
          WHERE ${sql.identifier(c.column_name)}::text ILIKE ${'%' + needle + '%'}`,
    )
    if ((found.rows[0]?.n ?? 0) > 0) hits.push(`${c.table_name}.${c.column_name}`)
  }
  return hits
}

describe('invariant: erasure is total', () => {
  it('removes every trace of a person across every table', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })
    const ctx = {
      db: f.db,
      workspaceId: f.workspaceId,
      rowId: f.rowId,
      columnId: f.columnId,
    }

    const { subjectId } = await writeCellValue(ctx, sourced(SUBJECT))
    expect(subjectId).toBeTruthy()

    // The subject is genuinely in there before we erase.
    expect(await databaseContains(f, SUBJECT)).not.toHaveLength(0)

    await erasePerson(f.db, subjectId!)

    const hits = await databaseContains(f, SUBJECT)
    expect(hits, `subject data survived in: ${hits.join(', ')}`).toHaveLength(0)
  })

  it('leaves a tombstone proving the erasure happened', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })
    const { subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )

    await erasePerson(f.db, subjectId!)

    const [tomb] = await f.db.select().from(person).where(eq(person.id, subjectId!))
    expect(tomb!.erasureState).toBe('erased')
    expect(tomb!.erasedAt).toBeInstanceOf(Date)
    expect(tomb!.displayName).toBeNull()

    const [c] = await f.db.select().from(cell).where(eq(cell.subjectId, subjectId!))
    expect(c).toBeUndefined() // no cell still points at them
  })
})
