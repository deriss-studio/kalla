/**
 * INVARIANT 5 — A human's correction is never silently overwritten.
 *
 * Commitment 4 in one behaviour. An agent that finds newer evidence for a cell
 * a person corrected does not replace it; it records a proposal, and the person
 * decides. This is what makes "human-centric" an architectural property rather
 * than a marketing one, and it is the first thing a scheduled refresh would
 * break if nothing stopped it.
 */

import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fixture, sourced, rejectionMessage, type Fixture } from '../harness.js'
import { writeCellValue, humanCorrectCell } from '../../src/lib/write.js'
import { authorship, cell, proposal } from '../../src/db/schema.js'

let f: Fixture

describe('invariant: a human-authored value stands', () => {
  it('an agent re-run proposes instead of overwriting', async () => {
    f = await fixture()
    const ctx = {
      db: f.db,
      workspaceId: f.workspaceId,
      rowId: f.rowId,
      columnId: f.columnId,
    }

    const { cellId } = await writeCellValue(ctx, sourced('Stockholm'))
    await humanCorrectCell(f.db, f.workspaceId, cellId, 'Stockholm, Sweden', 'soheill')

    const outcome = await writeCellValue(ctx, sourced('Gothenburg'))

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.value).toBe('Stockholm, Sweden') // the human's value stands

    expect(outcome.proposalId).toBeTruthy()
    const proposals = await f.db
      .select()
      .from(proposal)
      .where(eq(proposal.cellId, cellId))
    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.value).toBe('Gothenburg')
    expect(proposals[0]!.state).toBe('open')
  })

  it('authorship records that a person touched this cell', async () => {
    f = await fixture()
    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )

    const [before] = await f.db
      .select()
      .from(authorship)
      .where(eq(authorship.cellId, cellId))
    expect(before!.origin).toBe('machine')

    await humanCorrectCell(f.db, f.workspaceId, cellId, 'Stockholm, Sweden', 'soheill')

    const [after] = await f.db
      .select()
      .from(authorship)
      .where(eq(authorship.cellId, cellId))
    expect(after!.origin).toBe('machine_then_human')
    expect(after!.actorRef).toBe('soheill')
  })

  it('the database refuses a direct overwrite of a human-authored cell', async () => {
    f = await fixture()
    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )
    await humanCorrectCell(f.db, f.workspaceId, cellId, 'Stockholm, Sweden', 'soheill')

    const message = await rejectionMessage(() =>
      f.db.execute(sql`UPDATE cell SET value = 'Gothenburg' WHERE id = ${cellId}::uuid`),
    )
    expect(message).toMatch(/overwrite human-authored cell/i)
  })
})
