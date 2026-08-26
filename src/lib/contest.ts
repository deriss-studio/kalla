/**
 * Commitment 4: every cell can be argued with.
 *
 * A contest states a claim, attaches counter-evidence, and is recorded beside
 * the value rather than replacing it. The value the contest was raised against
 * is captured at that moment, so the record still makes sense after the value
 * moves.
 *
 * Resolution is a human act with a name against it. There is no automatic
 * resolution, no timeout that closes a contest quietly, and no path that
 * resolves one without recording who decided. `resolvedByHuman` is not
 * optional anywhere in this file.
 *
 * The three outcomes are the closed set from the schema:
 *
 *   upheld    — the value stands. The disagreement is kept, not erased.
 *   corrected — the value changes, by the hand of the person resolving it.
 *   withdrawn — the claim is taken back by whoever raised it.
 *
 * `corrected` is the only one that writes a value, and it goes down the same
 * path as any other human write: authored machine_then_human, provenance
 * recorded, personal data resolved to an entity.
 */

import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { cell, contest } from '../db/schema.js'
import { applyHumanValue, loadCellForWrite } from './write.js'

export type ContestRaiser = 'user' | 'subject' | 'reviewer'

export interface ContestClaim {
  raisedBy: ContestRaiser
  /** Who raised it. A subject's own contest arrives through the DSR route. */
  raiserRef?: string
  claim: string
  counterEvidence?: { url: string; note?: string }[]
}

/**
 * Resolution outcomes, as a discriminated union: `corrected` cannot be
 * recorded without the value that replaces the old one, and none of them can
 * be recorded without a name.
 */
export type ContestDecision =
  | { resolution: 'upheld'; resolvedByHuman: string; note?: string }
  | { resolution: 'withdrawn'; resolvedByHuman: string; note?: string }
  | {
      resolution: 'corrected'
      resolvedByHuman: string
      value: string
      note?: string
      evidenceUrl?: string
    }

export async function raiseContest(
  db: Db,
  workspaceId: string,
  cellId: string,
  claim: ContestClaim,
): Promise<{ contestId: string }> {
  if (!claim.claim.trim()) {
    throw new Error('a contest must state a claim')
  }

  return db.transaction(async (tx) => {
    // Same tenancy guard as any other write against a named cell.
    await loadCellForWrite(tx as unknown as Db, workspaceId, cellId)

    const [current] = await tx
      .select({ value: cell.value })
      .from(cell)
      .where(eq(cell.id, cellId))
      .limit(1)

    const [raised] = await tx
      .insert(contest)
      .values({
        cellId,
        raisedBy: claim.raisedBy,
        raiserRef: claim.raiserRef ?? null,
        claim: claim.claim,
        counterEvidence: claim.counterEvidence ?? [],
        // What was actually being argued with, captured now rather than
        // inferred later from a value that may since have moved.
        priorValue: current?.value ?? null,
      })
      .returning({ id: contest.id })

    // The cell says so. `contested` is in the closed set of states precisely
    // so a disagreement is visible in the grid rather than hidden in a table.
    await tx
      .update(cell)
      .set({ state: 'contested', updatedAt: new Date() })
      .where(eq(cell.id, cellId))

    return { contestId: raised!.id }
  })
}

export async function resolveContest(
  db: Db,
  workspaceId: string,
  contestId: string,
  decision: ContestDecision,
): Promise<{ cellId: string }> {
  if (!decision.resolvedByHuman.trim()) {
    throw new Error('a contest is resolved by a person, and the record says who')
  }

  return db.transaction(async (tx) => {
    const [open] = await tx
      .select({
        id: contest.id,
        cellId: contest.cellId,
        resolvedAt: contest.resolvedAt,
      })
      .from(contest)
      .where(eq(contest.id, contestId))
      .limit(1)

    if (!open) throw new Error(`unknown contest ${contestId}`)
    if (open.resolvedAt) {
      throw new Error(`contest ${contestId} was already resolved`)
    }

    // Tenancy, and proof the cell is still reachable from this workspace.
    await loadCellForWrite(tx as unknown as Db, workspaceId, open.cellId)

    if (decision.resolution === 'corrected') {
      await applyHumanValue(
        tx as unknown as Db,
        workspaceId,
        open.cellId,
        decision.value,
        decision.resolvedByHuman,
        [{ url: decision.evidenceUrl ?? `human:${decision.resolvedByHuman}` }],
      )
    }

    await tx
      .update(contest)
      .set({
        resolution: decision.resolution,
        resolvedByHuman: decision.resolvedByHuman,
        resolvedAt: new Date(),
        note: decision.note ?? null,
      })
      .where(eq(contest.id, contestId))

    // A cell with another argument still running stays contested. Resolving
    // one disagreement does not settle the others.
    const [stillOpen] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(contest)
      .where(and(eq(contest.cellId, open.cellId), isNull(contest.resolvedAt)))

    if ((stillOpen?.n ?? 0) === 0) {
      await tx
        .update(cell)
        .set({ state: 'filled', updatedAt: new Date() })
        .where(eq(cell.id, open.cellId))
    }

    return { cellId: open.cellId }
  })
}

/** Every argument recorded against a cell, resolved or not. */
export async function contestsFor(db: Db, cellId: string) {
  return db
    .select()
    .from(contest)
    .where(eq(contest.cellId, cellId))
    .orderBy(contest.raisedAt)
}
