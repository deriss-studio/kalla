/**
 * Creating and reading research surfaces.
 *
 * Two things live here that the substrate needed and did not have.
 *
 * CREATION. A sheet cannot be made without a declared purpose and a declared
 * use, and its AI Act risk class is *derived* from that use rather than typed
 * alongside it. Commitment 3 says a compliance artifact must never ask a user
 * for something the system could have worked out; a risk classification that
 * arrives as a parameter is exactly that, and it is the field a hurried person
 * would set to `minimal` to make a warning go away.
 *
 * READING. Every write path in this repository has an invariant behind it and
 * the read side had neither a function nor a test, which is a strange place
 * for a product whose deliverable is a grid. A read is also how data leaves:
 * erasure and expiry are worth nothing if a query serves the value anyway.
 *
 * So the read path derives what it shows. It is scoped to a workspace, and a
 * value is surfaced only for the states that are allowed to have one. The
 * database already nulls a refused or erased value; this refuses to render one
 * even if it were there, which is the same belt-and-braces the invariants use
 * everywhere else.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { cell, column, provenance, rowEntity, sheet } from '../db/schema.js'
import { classifySheet, type DeclaredUse } from './classify.js'
import type { UncertaintyReason } from './person.js'

export type DataClass = 'none' | 'business' | 'personal' | 'special'

/** The only states permitted to carry a value out of the substrate. */
const STATES_WITH_VALUE = new Set(['filled', 'contested'])

export interface NewSheet {
  name: string
  /** Required. The legitimate interest assessment is written against it. */
  purpose: string
  declaredUse: DeclaredUse
}

export async function createSheet(
  db: Db,
  workspaceId: string,
  input: NewSheet,
): Promise<{ sheetId: string; aiActClass: string; obligations: string[] }> {
  if (!input.name.trim()) throw new Error('a sheet needs a name')
  if (!input.purpose.trim()) {
    throw new Error(
      'a sheet needs a declared purpose: it is what the legitimate interest assessment is written against, and what a subject is told when they ask why',
    )
  }

  // Derived, never accepted. See the header.
  const classification = classifySheet(input.declaredUse)

  const [created] = await db
    .insert(sheet)
    .values({
      workspaceId,
      name: input.name.trim(),
      purpose: input.purpose.trim(),
      declaredUse: input.declaredUse,
      aiActClass: classification.aiActClass,
    })
    .returning({ id: sheet.id })

  return {
    sheetId: created!.id,
    aiActClass: classification.aiActClass,
    obligations: classification.obligations,
  }
}

export interface NewColumn {
  key: string
  name: string
  prompt: string
  /**
   * Required. There is no default: what a column holds governs retention,
   * special-category scanning and disclosure, and guessing it is how a
   * personal column ends up handled as a business one.
   */
  dataClass: DataClass
  retentionDays?: number | null
  position?: number
}

export async function createColumn(
  db: Db,
  workspaceId: string,
  sheetId: string,
  input: NewColumn,
): Promise<{ columnId: string }> {
  const [owner] = await db
    .select({ id: sheet.id })
    .from(sheet)
    .where(and(eq(sheet.id, sheetId), eq(sheet.workspaceId, workspaceId)))
    .limit(1)

  if (!owner) {
    throw new Error(
      `refusing to add a column to sheet ${sheetId}: it does not belong to workspace ${workspaceId}`,
    )
  }
  if (!input.key.trim() || !input.name.trim()) {
    throw new Error('a column needs a key and a name')
  }

  const [created] = await db
    .insert(column)
    .values({
      sheetId,
      key: input.key.trim(),
      name: input.name.trim(),
      prompt: input.prompt,
      dataClass: input.dataClass,
      retentionDays: input.retentionDays ?? null,
      position: input.position ?? 0,
    })
    .returning({ id: column.id })

  return { columnId: created!.id }
}

/* ------------------------------------------------------------- the read path */

export interface CellView {
  rowId: string
  columnKey: string
  state: string
  /**
   * Null unless the state is one that may carry a value. An erased or expired
   * or refused cell has no value to show, and this will not show one.
   */
  value: string | null
  /** Recorded when detection could settle neither way. */
  uncertainty: UncertaintyReason | null
  sources: number
  retentionExpiresAt: Date | null
  openContests: number
}

export interface SheetView {
  sheet: {
    id: string
    name: string
    purpose: string
    declaredUse: string
    aiActClass: string
  }
  columns: { id: string; key: string; name: string; dataClass: string }[]
  rows: {
    id: string
    label: string
    kind: string
    uncertainty: UncertaintyReason | null
  }[]
  cells: CellView[]
}

/**
 * A sheet, as it may be shown.
 *
 * Scoped to the workspace: a read is how data escapes a tenant, so the same
 * guard the write path carries applies here, and returns nothing rather than
 * throwing, because "not yours" and "not there" should look identical from
 * outside.
 */
export async function readSheet(
  db: Db,
  workspaceId: string,
  sheetId: string,
): Promise<SheetView | null> {
  const [found] = await db
    .select({
      id: sheet.id,
      name: sheet.name,
      purpose: sheet.purpose,
      declaredUse: sheet.declaredUse,
      aiActClass: sheet.aiActClass,
    })
    .from(sheet)
    .where(and(eq(sheet.id, sheetId), eq(sheet.workspaceId, workspaceId)))
    .limit(1)

  if (!found) return null

  const columns = await db
    .select({
      id: column.id,
      key: column.key,
      name: column.name,
      dataClass: column.dataClass,
    })
    .from(column)
    .where(eq(column.sheetId, sheetId))
    .orderBy(column.position, column.key)

  const rows = await db
    .select({
      id: rowEntity.id,
      label: rowEntity.label,
      kind: rowEntity.kind,
      uncertainty: rowEntity.subjectUncertainty,
    })
    .from(rowEntity)
    .where(eq(rowEntity.sheetId, sheetId))
    .orderBy(rowEntity.position, rowEntity.label)

  const raw = await db
    .select({
      id: cell.id,
      rowId: cell.rowId,
      columnId: cell.columnId,
      value: cell.value,
      state: cell.state,
      uncertainty: cell.subjectUncertainty,
      retentionExpiresAt: cell.retentionExpiresAt,
      sources: sql<number>`(
        SELECT count(*)::int FROM provenance p WHERE p.cell_id = ${cell.id}
      )`,
      openContests: sql<number>`(
        SELECT count(*)::int FROM contest c
         WHERE c.cell_id = ${cell.id} AND c.resolved_at IS NULL
      )`,
    })
    .from(cell)
    .where(eq(cell.sheetId, sheetId))

  const keyOf = new Map(columns.map((c) => [c.id, c.key]))

  return {
    sheet: found,
    columns,
    rows,
    cells: raw.map((c) => ({
      rowId: c.rowId,
      columnKey: keyOf.get(c.columnId) ?? '',
      state: c.state,
      // The one line this whole module exists for.
      value: STATES_WITH_VALUE.has(c.state) ? c.value : null,
      uncertainty: c.uncertainty,
      sources: c.sources,
      retentionExpiresAt: c.retentionExpiresAt,
      openContests: c.openContests,
    })),
  }
}

/** One cell, by row and column key, with the same guarantees. */
export async function readCell(
  db: Db,
  workspaceId: string,
  sheetId: string,
  rowLabel: string,
  columnKey: string,
): Promise<(CellView & { rowLabel: string; sources_detail: { url: string; retrievedAt: Date; crawlerId: string }[] }) | null> {
  const view = await readSheet(db, workspaceId, sheetId)
  if (!view) return null

  const row = view.rows.find((r) => r.label === rowLabel)
  if (!row) return null

  const found = view.cells.find(
    (c) => c.rowId === row.id && c.columnKey === columnKey,
  )
  if (!found) return null

  const columnId = view.columns.find((c) => c.key === columnKey)?.id
  const detail = columnId
    ? await db
        .select({
          url: provenance.sourceUrl,
          retrievedAt: provenance.retrievedAt,
          crawlerId: provenance.crawlerId,
        })
        .from(provenance)
        .innerJoin(cell, eq(cell.id, provenance.cellId))
        .where(and(eq(cell.rowId, row.id), eq(cell.columnId, columnId)))
    : []

  return { ...found, rowLabel: row.label, sources_detail: detail }
}

/** Rows whose subject could not be settled, for a human to look at. */
export async function needsReview(
  db: Db,
  workspaceId: string,
  sheetId: string,
): Promise<{ rowLabel: string; columnKey: string; reason: UncertaintyReason }[]> {
  const view = await readSheet(db, workspaceId, sheetId)
  if (!view) return []

  const labelOf = new Map(view.rows.map((r) => [r.id, r.label]))
  return view.cells
    .filter((c) => c.uncertainty !== null)
    .map((c) => ({
      rowLabel: labelOf.get(c.rowId) ?? '',
      columnKey: c.columnKey,
      reason: c.uncertainty!,
    }))
}
