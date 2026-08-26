/**
 * INVARIANT 1 — No value without provenance.
 *
 * Insert a cell value by every available code path and assert each one produces
 * a provenance record. If you add a write path, extend this test in the same
 * pull request. A pull request that adds a write path without extending this
 * test is incomplete.
 */

import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fixture, sourced, rejectionMessage, type Fixture } from '../harness.js'
import { writeCellValue, humanCorrectCell } from '../../src/lib/write.js'
import { cell, provenance } from '../../src/db/schema.js'

let f: Fixture

describe('invariant: no value without provenance', () => {
  it('the agent write path produces provenance', async () => {
    f = await fixture()
    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm, Sweden'),
    )

    const rows = await f.db
      .select()
      .from(provenance)
      .where(eq(provenance.cellId, cellId))

    expect(rows).toHaveLength(1)
    expect(rows[0]!.sourceUrl).toBe('https://testbolaget.example/about')
    expect(rows[0]!.sourceDomain).toBe('testbolaget.example')
    expect(rows[0]!.modelRegion).toBe('eu-west-1')
    expect(rows[0]!.synthetic).toBe(false)
  })

  it('the human correction path produces provenance', async () => {
    f = await fixture()
    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm, Sweden'),
    )
    await humanCorrectCell(f.db, cellId, 'Stockholm, SE', 'soheill')

    const rows = await f.db
      .select()
      .from(provenance)
      .where(eq(provenance.cellId, cellId))

    expect(rows).toHaveLength(2)
    expect(rows.some((r) => r.crawlerId === 'human')).toBe(true)
  })

  it('a filled result with no source is rejected before it reaches the database', async () => {
    f = await fixture()
    await expect(
      writeCellValue(
        { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
        { value: 'Stockholm', state: 'filled', sources: [] },
      ),
    ).rejects.toThrow(/no source/i)

    const cells = await f.db.select().from(cell)
    expect(cells).toHaveLength(0)
  })

  it('the database refuses a filled cell inserted directly, bypassing the write path', async () => {
    f = await fixture()
    // This is the important one. Application code can be routed around; the
    // deferred constraint trigger cannot.
    const message = await rejectionMessage(() =>
      f.db.execute(sql`
        INSERT INTO cell (row_id, column_id, value, state)
        VALUES (${f.rowId}::uuid, ${f.columnId}::uuid, 'Stockholm', 'filled')
      `),
    )
    expect(message).toMatch(/no provenance record/i)
  })
})
