/**
 * The write path. There is exactly one, and this is it.
 *
 * Everything the four commitments promise is either enforced here or by the
 * triggers in src/db/triggers.sql. Adding a second way to put a value into a
 * cell is the single most damaging change anyone could make to this codebase.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import {
  authorship,
  cell,
  column,
  provenance,
  proposal,
  rowEntity,
  sheet,
} from '../db/schema.js'
import { checkSpecialCategory } from './special.js'
import { detectPersonalData, resolvePerson } from './person.js'
import { domainOf } from './collection.js'

/** What a cell agent returns. See the cell agent contract in the strategy doc. */
export interface AgentResult {
  value: string | null
  state: 'filled' | 'not_found' | 'refused' | 'blocked'
  sources: {
    url: string
    retrievedAt: Date
    quote?: string
    crawlerId?: string
    robotsState?: string
    aiTxtState?: string
  }[]
  confidence?: number
  modelId?: string
  modelRegion?: string
  notes?: string
}

export interface WriteContext {
  db: Db
  workspaceId: string
  rowId: string
  columnId: string
}

export interface WriteOutcome {
  cellId: string
  state: string
  proposalId?: string
  refusedCategory?: string
  subjectId?: string
}

/**
 * Write an agent result into a cell.
 *
 * Refuses special-category values outright. Resolves personal data to a person
 * entity. Sets the retention clock on first write and never again. Records
 * provenance and authorship in the same transaction as the value, so the
 * deferred constraint trigger can prove the invariant held at COMMIT.
 */
export async function writeCellValue(
  ctx: WriteContext,
  result: AgentResult,
): Promise<WriteOutcome> {
  const { db, workspaceId, rowId, columnId } = ctx

  const meta = await loadCellMeta(db, workspaceId, rowId, columnId)

  // --- refuse before anything is persisted ---------------------------------
  const special = checkSpecialCategory(
    result.value,
    ...result.sources.map((s) => s.quote),
  )
  if (special.special) {
    const cellId = await upsertRefusal(db, rowId, columnId, special.category)
    return { cellId, state: 'refused', refusedCategory: special.category }
  }

  if (result.state !== 'filled' || result.value === null) {
    const cellId = await upsertNonValue(db, rowId, columnId, result)
    return { cellId, state: result.state }
  }

  if (result.sources.length === 0) {
    throw new Error(
      'invariant violated: filled result carries no source. NOT_FOUND is a correct answer; a sourceless value is not.',
    )
  }

  // --- a human's correction stands ----------------------------------------
  const existing = await currentCell(db, rowId, columnId)
  if (existing?.authorOrigin === 'human' || existing?.authorOrigin === 'machine_then_human') {
    const [p] = await db
      .insert(proposal)
      .values({
        cellId: existing.id,
        value: result.value,
        evidence: result.sources.map((s) => ({ url: s.url, quote: s.quote })),
      })
      .returning({ id: proposal.id })
    return { cellId: existing.id, state: existing.state, proposalId: p!.id }
  }

  // --- personal data becomes an entity -------------------------------------
  const personal = detectPersonalData({
    value: result.value,
    columnName: meta.columnName,
    columnDataClass: meta.dataClass,
    rowKind: meta.rowKind,
  })

  const retentionDays = meta.retentionDays ?? meta.workspaceRetentionDays
  const firstWriteExpiry = new Date(Date.now() + retentionDays * 86_400_000)

  return db.transaction(async (tx) => {
    const subjectId = personal.personal
      ? await resolvePerson(tx as unknown as Db, workspaceId, personal, firstWriteExpiry)
      : null

    let cellId: string
    if (existing) {
      // A refresh. The value moves; the clock does not.
      await tx
        .update(cell)
        .set({
          value: result.value,
          state: 'filled',
          subjectId,
          updatedAt: new Date(),
        })
        .where(eq(cell.id, existing.id))
      cellId = existing.id
    } else {
      const [created] = await tx
        .insert(cell)
        .values({
          rowId,
          columnId,
          value: result.value,
          state: 'filled',
          subjectId,
          retentionExpiresAt: firstWriteExpiry,
        })
        .returning({ id: cell.id })
      cellId = created!.id
    }

    for (const s of result.sources) {
      await tx.insert(provenance).values({
        cellId,
        sourceUrl: s.url,
        sourceDomain: domainOf(s.url),
        retrievedAt: s.retrievedAt,
        crawlerId: s.crawlerId ?? 'kalla/0.1',
        robotsState: s.robotsState ?? 'allowed',
        aiTxtState: s.aiTxtState ?? 'absent',
        modelId: result.modelId ?? null,
        modelRegion: result.modelRegion ?? null,
        confidence: result.confidence ?? null,
        quote: s.quote ?? null,
      })
    }

    await tx
      .insert(authorship)
      .values({ cellId, origin: 'machine', actorRef: result.modelId ?? 'agent' })
      .onConflictDoUpdate({
        target: authorship.cellId,
        set: { origin: 'machine', at: new Date() },
      })

    return { cellId, state: 'filled', subjectId: subjectId ?? undefined }
  })
}

/**
 * A person corrects a cell. Their value stands until they change it, and the
 * authorship record says so.
 *
 * Takes the workspace for the same reason the agent path does: a write is only
 * permitted against a cell this workspace actually holds.
 */
export async function humanCorrectCell(
  db: Db,
  workspaceId: string,
  cellId: string,
  value: string,
  actorRef: string,
  evidenceUrl?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertCellInWorkspace(tx as unknown as Db, workspaceId, cellId)

    await tx.execute(sql`SELECT set_config('app.human_edit', 'on', true)`)

    await tx
      .update(cell)
      .set({ value, state: 'filled', updatedAt: new Date() })
      .where(eq(cell.id, cellId))

    await tx.insert(provenance).values({
      cellId,
      sourceUrl: evidenceUrl ?? `human:${actorRef}`,
      sourceDomain: evidenceUrl ? domainOf(evidenceUrl) : 'human',
      retrievedAt: new Date(),
      crawlerId: 'human',
      robotsState: 'n/a',
      aiTxtState: 'n/a',
      quote: null,
    })

    await tx
      .insert(authorship)
      .values({ cellId, origin: 'machine_then_human', actorRef })
      .onConflictDoUpdate({
        target: authorship.cellId,
        set: { origin: 'machine_then_human', actorRef, at: new Date() },
      })
  })
}

/* ------------------------------------------------------------- internals */

/**
 * Load the column and row a write is aimed at, and prove they belong together
 * and to the caller's workspace.
 *
 * Both halves matter. The row and the column must sit in the same sheet, and
 * that sheet must sit in this workspace — check only the second and a caller
 * can still pair a column from one tenant with a row from another, because
 * the column alone satisfies the workspace test.
 *
 * The consequence of getting this wrong is not a mis-filed cell. Person
 * entities are workspace-scoped, so a value written under the wrong workspace
 * resolves its subject into the wrong tenant: one person's data placed beyond
 * the reach of their own workspace's access and erasure queries, by a caller
 * that merely passed the wrong argument.
 */
async function loadCellMeta(
  db: Db,
  workspaceId: string,
  rowId: string,
  columnId: string,
) {
  const [meta] = await db
    .select({
      columnName: column.name,
      dataClass: column.dataClass,
      retentionDays: column.retentionDays,
      rowKind: rowEntity.kind,
      workspaceRetentionDays: sql<number>`180`,
    })
    .from(column)
    .innerJoin(sheet, eq(sheet.id, column.sheetId))
    .innerJoin(
      rowEntity,
      and(eq(rowEntity.id, rowId), eq(rowEntity.sheetId, column.sheetId)),
    )
    .where(and(eq(column.id, columnId), eq(sheet.workspaceId, workspaceId)))
    .limit(1)

  if (!meta) {
    throw new Error(
      `refusing to write row ${rowId} / column ${columnId} in workspace ${workspaceId}: ` +
        'the row and column must belong to the same sheet, and that sheet to this workspace',
    )
  }
  return meta
}

/**
 * The same guard, for a path that names a cell directly rather than a row and
 * a column. A cell's tenancy is derived, never trusted from the argument.
 */
async function assertCellInWorkspace(
  db: Db,
  workspaceId: string,
  cellId: string,
): Promise<void> {
  const [owned] = await db
    .select({ id: cell.id })
    .from(cell)
    .innerJoin(column, eq(column.id, cell.columnId))
    .innerJoin(sheet, eq(sheet.id, column.sheetId))
    .where(and(eq(cell.id, cellId), eq(sheet.workspaceId, workspaceId)))
    .limit(1)

  if (!owned) {
    throw new Error(
      `refusing to write cell ${cellId} in workspace ${workspaceId}: the cell belongs to another workspace, or does not exist`,
    )
  }
}

async function currentCell(db: Db, rowId: string, columnId: string) {
  const [row] = await db
    .select({
      id: cell.id,
      state: cell.state,
      value: cell.value,
      authorOrigin: authorship.origin,
    })
    .from(cell)
    .leftJoin(authorship, eq(authorship.cellId, cell.id))
    .where(and(eq(cell.rowId, rowId), eq(cell.columnId, columnId)))
    .limit(1)
  return row ?? null
}

async function upsertRefusal(
  db: Db,
  rowId: string,
  columnId: string,
  category: string,
): Promise<string> {
  const [row] = await db
    .insert(cell)
    .values({
      rowId,
      columnId,
      value: null,
      state: 'refused',
      refusalReason: `special_category:${category}`,
    })
    .onConflictDoUpdate({
      target: [cell.rowId, cell.columnId],
      set: {
        value: null,
        state: 'refused',
        refusalReason: `special_category:${category}`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: cell.id })
  return row!.id
}

async function upsertNonValue(
  db: Db,
  rowId: string,
  columnId: string,
  result: AgentResult,
): Promise<string> {
  const state = result.state === 'blocked' ? 'refused' : 'not_found'
  const [row] = await db
    .insert(cell)
    .values({
      rowId,
      columnId,
      value: null,
      state,
      refusalReason: result.state === 'blocked' ? 'domain_blocked' : result.notes ?? null,
    })
    .onConflictDoUpdate({
      target: [cell.rowId, cell.columnId],
      set: { value: null, state, updatedAt: new Date() },
    })
    .returning({ id: cell.id })
  return row!.id
}
