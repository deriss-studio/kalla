/**
 * Retention that actually expires.
 *
 * The Kaspr decision has two halves. The first is that a refresh must not renew
 * the clock, which the trigger in src/db/triggers.sql enforces. The second is
 * that when the clock runs out, the data goes — and until this file existed
 * nothing ever deleted anything, so a cell whose retention had expired sat
 * there indefinitely with a date in the past attached to it. A retention
 * period nothing acts on is not a retention period, it is a comment.
 *
 * Expiry deletes. It does not archive, tombstone or soft-delete: those are all
 * ways of keeping the value while describing it differently, and the value is
 * the thing we no longer have a basis to hold. Deleting the cell takes its
 * provenance, authorship, proposals and contests with it by cascade, which is
 * what makes "the value survives nowhere" true rather than aspirational.
 *
 * What remains is expiry_log — identifiers and timestamps, no text — so that
 * the deletion can be demonstrated without the log becoming the last place the
 * data lives.
 *
 * There is no scheduler here on purpose. This is a function the runtime will
 * call; inventing a cron for it before there is a runtime would be inventing
 * the wrong one.
 */

import { and, eq, lt, notExists, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { cell, expiryLog, person, rowEntity } from '../db/schema.js'

export interface SweepResult {
  /** Cells whose retention had run out, and which no longer exist. */
  cellsDeleted: number
  /**
   * People left with nothing referencing them once those cells were gone.
   * Holding a person record with no remaining holdings is holding personal
   * data for no purpose.
   */
  peopleDeleted: number
}

/**
 * Delete everything whose retention has expired, and record that it happened.
 *
 * Scoped to a workspace when given one, because retention is a controller's
 * decision and a sweep should be answerable per controller.
 */
export async function sweepExpired(
  db: Db,
  workspaceId?: string,
  now: Date = new Date(),
): Promise<SweepResult> {
  return db.transaction(async (tx) => {
    const expired = await tx
      .select({
        id: cell.id,
        sheetId: cell.sheetId,
        subjectId: cell.subjectId,
        retentionExpiresAt: cell.retentionExpiresAt,
        workspaceId: sql<string>`(
          SELECT s.workspace_id FROM sheet s WHERE s.id = ${cell.sheetId}
        )`,
      })
      .from(cell)
      .where(
        and(
          lt(cell.retentionExpiresAt, now),
          workspaceId
            ? sql`EXISTS (
                SELECT 1 FROM sheet s
                 WHERE s.id = ${cell.sheetId} AND s.workspace_id = ${workspaceId}::uuid
              )`
            : sql`true`,
        ),
      )

    if (expired.length === 0) return { cellsDeleted: 0, peopleDeleted: 0 }

    // Logged before the delete, in the same transaction: if the delete fails
    // the log rolls back with it, so the log can never claim a deletion that
    // did not happen.
    await tx.insert(expiryLog).values(
      expired.map((c) => ({
        workspaceId: c.workspaceId,
        cellId: c.id,
        sheetId: c.sheetId,
        hadSubject: c.subjectId !== null,
        retentionExpiredAt: c.retentionExpiresAt!,
      })),
    )

    await tx.execute(
      sql`DELETE FROM cell WHERE id IN (${sql.join(
        expired.map((c) => sql`${c.id}::uuid`),
        sql`, `,
      )})`,
    )

    // A person nothing points at any more. Tombstoned people are exempt: their
    // row is the proof that an erasure was carried out, and that proof has to
    // outlive the data it describes.
    const orphaned = await tx
      .delete(person)
      .where(
        and(
          eq(person.erasureState, 'active'),
          workspaceId ? eq(person.workspaceId, workspaceId) : sql`true`,
          notExists(
            tx.select({ n: sql`1` }).from(cell).where(eq(cell.subjectId, person.id)),
          ),
          notExists(
            tx
              .select({ n: sql`1` })
              .from(rowEntity)
              .where(eq(rowEntity.subjectId, person.id)),
          ),
        ),
      )
      .returning({ id: person.id })

    return { cellsDeleted: expired.length, peopleDeleted: orphaned.length }
  })
}

/** Cells whose clock has already run out but which have not yet been swept. */
export async function expiredCells(db: Db, now: Date = new Date()) {
  return db
    .select({ id: cell.id, retentionExpiresAt: cell.retentionExpiresAt })
    .from(cell)
    .where(lt(cell.retentionExpiresAt, now))
}
