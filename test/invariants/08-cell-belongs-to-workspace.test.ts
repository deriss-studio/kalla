/**
 * INVARIANT 8 — A cell belongs to the caller's workspace.
 *
 * Person entities are workspace-scoped, so a value written under the wrong
 * workspace resolves its subject into the wrong tenant, where the owning
 * workspace's access and erasure queries can no longer reach it. That is
 * commitment 2 failing quietly, from nothing worse than a caller passing the
 * wrong argument.
 *
 * The guard has two halves and needs both. The row and the column must share
 * a sheet, and that sheet must belong to the workspace: a workspace-only
 * check still admits a column from one tenant paired with a row from another,
 * because the column on its own satisfies it. Each half is proven separately
 * below, and each was verified by removing its predicate and watching only
 * the matching cases fail.
 */

import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fixture, rejectionMessage, sourced, type Fixture } from '../harness.js'
import { writeCellValue, humanCorrectCell } from '../../src/lib/write.js'
import { cell, column, rowEntity, sheet, workspace } from '../../src/db/schema.js'

let f: Fixture

/** A second sheet, with its own row and column, inside a given workspace. */
async function sheetIn(f: Fixture, workspaceId: string, name: string) {
  const [sh] = await f.db
    .insert(sheet)
    .values({
      workspaceId,
      name,
      purpose: 'A separate research surface.',
      declaredUse: 'market_mapping',
      aiActClass: 'transparency_only',
    })
    .returning({ id: sheet.id })

  const [col] = await f.db
    .insert(column)
    .values({
      sheetId: sh!.id,
      key: 'hq',
      name: 'Headquarters',
      prompt: 'Where is it headquartered?',
    })
    .returning({ id: column.id })

  const [row] = await f.db
    .insert(rowEntity)
    .values({ sheetId: sh!.id, label: 'Another org' })
    .returning({ id: rowEntity.id })

  return { sheetId: sh!.id, columnId: col!.id, rowId: row!.id }
}

async function otherWorkspace(f: Fixture) {
  const [ws] = await f.db
    .insert(workspace)
    .values({ name: 'Another tenant' })
    .returning({ id: workspace.id })
  return { workspaceId: ws!.id, ...(await sheetIn(f, ws!.id, 'Their sheet')) }
}

describe('the write path refuses a cell outside its workspace', () => {
  it('refuses a column belonging to another workspace, and writes nothing', async () => {
    f = await fixture()
    const them = await otherWorkspace(f)

    await expect(
      writeCellValue(
        { db: f.db, workspaceId: f.workspaceId, rowId: them.rowId, columnId: them.columnId },
        sourced('Oslo, Norway'),
      ),
    ).rejects.toThrow(/must belong to the same sheet, and that sheet to this workspace/)

    expect(await f.db.select().from(cell)).toHaveLength(0)
  })

  it('refuses a row and a column that live in different sheets', async () => {
    f = await fixture()
    // Same workspace both sides, so only the same-sheet half of the guard can
    // catch this one.
    const second = await sheetIn(f, f.workspaceId, 'A second sheet')

    await expect(
      writeCellValue(
        { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: second.columnId },
        sourced('Oslo, Norway'),
      ),
    ).rejects.toThrow(/must belong to the same sheet/)

    expect(await f.db.select().from(cell)).toHaveLength(0)
  })

  it('refuses a pairing that a workspace-only check would have allowed', async () => {
    // Their column satisfies the workspace test on its own. The row does not
    // belong to its sheet, which is the case a workspace-only guard misses.
    f = await fixture()
    const them = await otherWorkspace(f)

    await expect(
      writeCellValue(
        { db: f.db, workspaceId: them.workspaceId, rowId: f.rowId, columnId: them.columnId },
        sourced('Oslo, Norway'),
      ),
    ).rejects.toThrow(/must belong to the same sheet/)

    expect(await f.db.select().from(cell)).toHaveLength(0)
  })

  it('refuses a human correction to another workspace\'s cell, leaving the value alone', async () => {
    f = await fixture()
    const them = await otherWorkspace(f)

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: them.workspaceId, rowId: them.rowId, columnId: them.columnId },
      sourced('Oslo, Norway'),
    )

    await expect(
      humanCorrectCell(f.db, f.workspaceId, cellId, 'Bergen', 'soheill'),
    ).rejects.toThrow(/belongs to another workspace/)

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.value).toBe('Oslo, Norway')
  })

  it('the database refuses a cross-sheet pairing inserted directly, bypassing the write path', async () => {
    // The structural half is a pair of composite foreign keys, so it holds for
    // a migration written at midnight and a code path nobody remembered. Both
    // directions are checked: whichever sheet the row claims, the other key is
    // the one that catches it.
    f = await fixture()
    const second = await sheetIn(f, f.workspaceId, 'A second sheet')

    const claimingTheRowsSheet = await rejectionMessage(() =>
      f.db.execute(sql`
        INSERT INTO cell (row_id, column_id, sheet_id, value, state)
        VALUES (${f.rowId}::uuid, ${second.columnId}::uuid, ${f.sheetId}::uuid,
                'Stockholm', 'filled')
      `),
    )
    expect(claimingTheRowsSheet).toMatch(/cell_column_in_sheet_fk/i)

    const claimingTheColumnsSheet = await rejectionMessage(() =>
      f.db.execute(sql`
        INSERT INTO cell (row_id, column_id, sheet_id, value, state)
        VALUES (${f.rowId}::uuid, ${second.columnId}::uuid, ${second.sheetId}::uuid,
                'Stockholm', 'filled')
      `),
    )
    expect(claimingTheColumnsSheet).toMatch(/cell_row_in_sheet_fk/i)

    expect(await f.db.select().from(cell)).toHaveLength(0)
  })

  it('deleting a sheet still removes its cells', async () => {
    // The composite keys replaced the single-column ones, and the cascade came
    // with them. Had it been lost in the rewrite, deleting a sheet would fail
    // on its own cells instead of taking them with it.
    f = await fixture()
    await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm, Sweden'),
    )
    expect(await f.db.select().from(cell)).toHaveLength(1)

    await f.db.delete(sheet).where(eq(sheet.id, f.sheetId))

    expect(await f.db.select().from(cell)).toHaveLength(0)
  })

  it('still writes when the row, the column and the workspace agree', async () => {
    // The guard has to refuse the wrong tenant without refusing the right one.
    f = await fixture()

    const { cellId, state } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm, Sweden'),
    )
    expect(state).toBe('filled')

    await humanCorrectCell(f.db, f.workspaceId, cellId, 'Stockholm, SE', 'soheill')

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.value).toBe('Stockholm, SE')
  })
})
