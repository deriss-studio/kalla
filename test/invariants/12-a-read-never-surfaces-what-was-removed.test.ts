/**
 * INVARIANT 12 — A read never surfaces what the substrate removed.
 *
 * Erasure and refusal are promises about what leaves the system, and a read is
 * how things leave. An erased value that a query still serves has not been
 * erased; a refused special-category value that a grid still renders was not
 * refused. Every write path in this repository had an invariant behind it and
 * the read side had neither a function nor a test, which for a product whose
 * deliverable is a grid was the wrong way round.
 *
 * Two halves, and both are needed. A value is surfaced only for the states
 * allowed to carry one, so a value that somehow survived in the column would
 * still not be rendered; and a read is scoped to its workspace, because a read
 * is also how data escapes a tenant.
 */

import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fixture, sourced, type Fixture } from '../harness.js'
import { writeCellValue } from '../../src/lib/write.js'
import { erasePerson } from '../../src/lib/person.js'
import { sweepExpired } from '../../src/lib/retention.js'
import { readCell, readSheet } from '../../src/lib/sheets.js'
import { syntheticReceipt } from '../../src/lib/collection.js'
import { cell, workspace } from '../../src/db/schema.js'

let f: Fixture

const SUBJECT = 'Vera Exempel Testsson'

/** Every value the view hands out, whatever shape it is in. */
function surfaced(view: Awaited<ReturnType<typeof readSheet>>): string[] {
  if (!view) return []
  return [
    ...view.cells.map((c) => c.value),
    ...view.rows.map((r) => r.label),
  ].filter((v): v is string => v !== null)
}

describe('invariant: a read never surfaces what was removed', () => {
  it('does not surface an erased value', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    const { subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )
    expect(surfaced(await readSheet(f.db, f.workspaceId, f.sheetId))).toContain(SUBJECT)

    await erasePerson(f.db, subjectId!)

    const view = await readSheet(f.db, f.workspaceId, f.sheetId)
    expect(surfaced(view), 'an erased value was served by the read path').not.toContain(
      SUBJECT,
    )
    // The cell still exists and says why it is empty. A blank would be a lie.
    expect(view!.cells[0]!.state).toBe('expired')
  })

  it('does not surface a refused special-category value', async () => {
    f = await fixture({ columnName: 'Founder note', dataClass: 'personal' })
    const secret = 'On sick leave following a cancer diagnosis'

    const outcome = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      {
        value: secret,
        state: 'filled',
        sources: [{ receipt: syntheticReceipt('https://example.test/profile') }],
      },
    )
    expect(outcome.state).toBe('refused')

    const view = await readSheet(f.db, f.workspaceId, f.sheetId)
    expect(surfaced(view).join(' ')).not.toContain('cancer')
    expect(view!.cells[0]!.state).toBe('refused')
  })

  it('would still not render a value the state says it should not have', async () => {
    // The second half of the guard. The database nulls a refused value, so
    // reach past the write path and put one back: the read must still refuse
    // to serve it, because a state and a value that disagree are not something
    // a grid should resolve in favour of the value.
    f = await fixture()

    await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )
    await f.db.execute(sql`
      UPDATE cell SET state = 'refused', refusal_reason = 'special_category:health'
      WHERE row_id = ${f.rowId}::uuid
    `)

    const view = await readSheet(f.db, f.workspaceId, f.sheetId)
    expect(view!.cells[0]!.value, 'a refused cell rendered its value').toBeNull()
    expect(view!.cells[0]!.state).toBe('refused')
  })

  it('does not surface a swept cell at all', async () => {
    f = await fixture({ retentionDays: 30 })

    await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.retention_override', 'on', true)`)
      await tx.execute(sql`UPDATE cell SET retention_expires_at = now() - interval '1 day'`)
    })
    await sweepExpired(f.db, f.workspaceId)

    const view = await readSheet(f.db, f.workspaceId, f.sheetId)
    expect(view!.cells).toHaveLength(0)
    expect(await readCell(f.db, f.workspaceId, f.sheetId, 'Testbolaget', 'test_column')).toBeNull()
  })

  it('returns nothing for a sheet in another workspace', async () => {
    // "Not yours" and "not there" look identical from outside on purpose.
    f = await fixture()
    await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )

    const [them] = await f.db
      .insert(workspace)
      .values({ name: 'Another tenant' })
      .returning({ id: workspace.id })

    expect(await readSheet(f.db, them!.id, f.sheetId)).toBeNull()
    expect(
      await readCell(f.db, them!.id, f.sheetId, 'Testbolaget', 'test_column'),
    ).toBeNull()
  })

  it('still shows a value that is merely contested', async () => {
    // The guard has to stop what was removed without hiding what is disputed.
    // A contested cell keeps its value; that is the whole of commitment 4.
    f = await fixture()

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )
    await f.db.update(cell).set({ state: 'contested' }).where(eq(cell.id, cellId))

    const view = await readSheet(f.db, f.workspaceId, f.sheetId)
    expect(view!.cells[0]!.value).toBe('Stockholm')
    expect(view!.cells[0]!.state).toBe('contested')
  })
})
