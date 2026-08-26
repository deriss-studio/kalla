/**
 * INVARIANT 2 — A refresh moves the value, never the clock.
 *
 * This is the CNIL's finding against Kaspr, written as a test. They retained
 * contacts "five years from each update", so every automatic refresh renewed
 * the clock and nothing was ever deleted. A scheduled-refresh product gets this
 * wrong by default; that is exactly why it is enforced rather than documented.
 */

import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fixture, sourced, rejectionMessage, type Fixture } from '../harness.js'
import { writeCellValue } from '../../src/lib/write.js'
import { erasePerson } from '../../src/lib/person.js'
import { sweepExpired } from '../../src/lib/retention.js'
import { cell, expiryLog, person } from '../../src/db/schema.js'

let f: Fixture

async function expiryOf(f: Fixture, cellId: string) {
  const [row] = await f.db
    .select({ at: cell.retentionExpiresAt })
    .from(cell)
    .where(eq(cell.id, cellId))
  return row!.at
}

describe('invariant: refresh preserves retention', () => {
  it('a refreshed cell keeps its original expiry', async () => {
    f = await fixture({ retentionDays: 30 })
    const ctx = {
      db: f.db,
      workspaceId: f.workspaceId,
      rowId: f.rowId,
      columnId: f.columnId,
    }

    const { cellId } = await writeCellValue(ctx, sourced('Stockholm'))
    const first = await expiryOf(f, cellId)
    expect(first).toBeInstanceOf(Date)

    await new Promise((r) => setTimeout(r, 25))
    await writeCellValue(ctx, sourced('Stockholm, Sweden'))

    const after = await expiryOf(f, cellId)
    expect(after!.getTime()).toBe(first!.getTime())

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.value).toBe('Stockholm, Sweden') // the value did move
  })

  it('a column with no retention of its own uses the workspace default', async () => {
    // The period the system reports has to be the period it applied. This read
    // was a hardcoded 180 until the workspace was joined in, so a workspace
    // that had chosen thirty days was silently given six months.
    f = await fixture({ retentionDays: null, workspaceRetentionDays: 30 })

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )

    const expiry = await expiryOf(f, cellId)
    const days = (expiry!.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29)
    expect(days).toBeLessThan(31)
  })

  it('the database refuses a direct update that renews the clock', async () => {
    f = await fixture({ retentionDays: 30 })
    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )

    const message = await rejectionMessage(() =>
      f.db.execute(sql`
        UPDATE cell SET retention_expires_at = now() + interval '5 years'
        WHERE id = ${cellId}::uuid
      `),
    )
    expect(message).toMatch(/refresh moved retention_expires_at/i)
  })

  it('an explicit, auditable override can still extend retention', async () => {
    // Extending retention is sometimes legitimate — a changed lawful basis, a
    // documented review. It is never something a background job does silently.
    f = await fixture({ retentionDays: 30 })
    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )
    const before = await expiryOf(f, cellId)

    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.retention_override', 'on', true)`)
      await tx.execute(sql`
        UPDATE cell SET retention_expires_at = now() + interval '1 year'
        WHERE id = ${cellId}::uuid
      `)
    })

    const after = await expiryOf(f, cellId)
    expect(after!.getTime()).toBeGreaterThan(before!.getTime())
  })
})

/**
 * The other half of Kaspr. The trigger above stops the clock being renewed;
 * this stops the clock being decorative. A retention period that nothing acts
 * on is not a retention period — Kaspr's contacts were kept "five years from
 * each update", and the finding was as much that nothing was ever deleted as
 * that the clock kept moving.
 *
 * Expiry deletes. The proof is the same whole-database scan the erasure test
 * uses, because "archived", "tombstoned" and "soft-deleted" are all ways of
 * keeping a value while describing it differently.
 */
describe('invariant: retention that has expired is deleted', () => {
  const SUBJECT = 'Vera Exempel Testsson'

  /** Every text-ish column in every table, scanned for the value. */
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

  /** Move a cell's clock into the past, through the auditable override. */
  async function backdate(f: Fixture, cellId: string) {
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.retention_override', 'on', true)`)
      await tx.execute(sql`
        UPDATE cell SET retention_expires_at = now() - interval '1 day'
        WHERE id = ${cellId}::uuid
      `)
    })
  }

  it('deletes an expired cell, and its value survives nowhere', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })
    const ctx = {
      db: f.db,
      workspaceId: f.workspaceId,
      rowId: f.rowId,
      columnId: f.columnId,
    }

    const { cellId, subjectId } = await writeCellValue(ctx, sourced(SUBJECT))
    expect(subjectId).toBeTruthy()

    // Present in more than one table before the sweep, or this proves nothing
    // about the tables it forgot.
    expect(await databaseContains(f, SUBJECT)).toEqual(
      expect.arrayContaining(['cell.value', 'provenance.quote', 'person.display_name']),
    )

    await backdate(f, cellId)
    const swept = await sweepExpired(f.db, f.workspaceId)
    expect(swept.cellsDeleted).toBe(1)

    const hits = await databaseContains(f, SUBJECT)
    expect(hits, `expired value survived in: ${hits.join(', ')}`).toHaveLength(0)

    // Deleted, not marked. There is no row left to describe.
    expect(await f.db.select().from(cell)).toHaveLength(0)
  })

  it('logs the deletion without becoming the last place the data lives', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )
    await backdate(f, cellId)
    await sweepExpired(f.db, f.workspaceId)

    const [logged] = await f.db.select().from(expiryLog)
    expect(logged!.cellId).toBe(cellId)
    expect(logged!.sheetId).toBe(f.sheetId)
    expect(logged!.hadSubject).toBe(true)
    expect(logged!.sweptAt).toBeInstanceOf(Date)

    // The log records that a holding existed and went. It carries no text at
    // all, so it cannot carry what the holding said.
    const textColumns = await f.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'expiry_log'
        AND data_type IN ('text','character varying','jsonb','json')
    `)
    expect(textColumns.rows[0]!.n).toBe(0)
  })

  it('leaves a cell whose clock has not run out', async () => {
    f = await fixture({ retentionDays: 30 })

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )

    const swept = await sweepExpired(f.db, f.workspaceId)
    expect(swept.cellsDeleted).toBe(0)

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.value).toBe('Stockholm')
    expect(await f.db.select().from(expiryLog)).toHaveLength(0)
  })

  it('keeps an erasure tombstone through a sweep', async () => {
    // An orphaned person goes. A person who was erased on request does not:
    // their row is the proof the erasure happened, and it has to outlive the
    // data it describes.
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    const { cellId, subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )
    await erasePerson(f.db, subjectId!)
    await backdate(f, cellId)

    await sweepExpired(f.db, f.workspaceId)

    const [tomb] = await f.db.select().from(person)
    expect(tomb, 'the erasure tombstone was swept away').toBeTruthy()
    expect(tomb!.erasureState).toBe('erased')
  })
})
