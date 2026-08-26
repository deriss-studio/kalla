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
import { cell } from '../../src/db/schema.js'

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
