/**
 * What a subject access response actually contains.
 *
 * Invariant 4 holds the pack to a time budget. This holds it to a scope: a
 * response that returns in 280ms and omits half of what we hold is worse than
 * a slow one, because it is wrong in a direction nobody notices.
 *
 * An ordinary test rather than an invariant, on the same reasoning as the
 * tenancy guard before it was promoted: whether Article 15 completeness
 * belongs in the numbered list is a decision about the specification. It has a
 * fair claim — "everything we hold about this person" is commitment 2's own
 * wording, and the retained classification is only defensible if the subject
 * is told what survived.
 */

import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { fixture, sourced, type Fixture } from './harness.js'
import {
  createRow,
  humanCorrectCell,
  writeCellValue,
} from '../src/lib/write.js'
import { subjectAccessPack } from '../src/lib/dsr.js'
import { contest, sheet } from '../src/db/schema.js'
import { RETAINED_REACH, VALUE_BEARING } from '../src/db/value-bearing.js'

let f: Fixture

const SUBJECT = 'Vera Exempel Testsson'

describe('the subject access pack', () => {
  it('carries the proposals and contests attached to a holding', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })
    const ctx = {
      db: f.db,
      workspaceId: f.workspaceId,
      rowId: f.rowId,
      columnId: f.columnId,
    }

    const { cellId, subjectId } = await writeCellValue(ctx, sourced(SUBJECT))
    await humanCorrectCell(f.db, f.workspaceId, cellId, SUBJECT, 'soheill')

    // An agent offers a different value; the human has not decided yet.
    const outcome = await writeCellValue(ctx, sourced('Someone Else'))
    expect(outcome.proposalId).toBeTruthy()

    await f.db.insert(contest).values({
      cellId,
      raisedBy: 'subject',
      claim: 'This is out of date',
    })

    const pack = await subjectAccessPack(f.db, subjectId!)

    expect(pack.holdings).toHaveLength(1)
    const [holding] = pack.holdings
    expect(holding!.proposals.map((p) => p.value)).toEqual(['Someone Else'])
    expect(holding!.proposals[0]!.state).toBe('open')
    expect(holding!.contests.map((c) => c.claim)).toEqual(['This is out of date'])
    expect(holding!.contests[0]!.raisedBy).toBe('subject')
  })

  it('carries rows that are the person, not only cells about them', async () => {
    // A candidate whose name is the row label and who has no cell about them
    // would otherwise come back an empty pack — and that is precisely the
    // employment_screening case.
    f = await fixture({ declaredUse: 'employment_screening' })

    const { subjectId } = await createRow(f.db, f.workspaceId, f.sheetId, {
      label: SUBJECT,
      kind: 'person',
    })

    const pack = await subjectAccessPack(f.db, subjectId!)

    expect(pack.holdings).toHaveLength(0)
    expect(pack.rows).toHaveLength(1)
    expect(pack.rows[0]!.label).toBe(SUBJECT)
    expect(pack.rows[0]!.kind).toBe('person')
  })

  it('discloses what would survive an erasure, and the ground for keeping it', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    await f.db
      .update(sheet)
      .set({ purpose: `Assess ${SUBJECT} for board suitability.` })
      .where(eq(sheet.id, f.sheetId))

    const { subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )

    const pack = await subjectAccessPack(f.db, subjectId!)

    const purpose = pack.retained.find(
      (r) => r.table === 'sheet' && r.column === 'purpose',
    )
    expect(purpose, 'the retained purpose was not disclosed').toBeTruthy()
    expect(purpose!.value).toContain(SUBJECT)
    expect(purpose!.ground).toMatch(/Art\. 17\(3\)/)

    // The prompt that produced the value is retained too, and disclosed.
    expect(
      pack.retained.some((r) => r.table === 'column' && r.column === 'prompt'),
    ).toBe(true)
  })

  it('gives every retained table a route to the subject', async () => {
    // A retained table with no route would be kept through an erasure and
    // never disclosed, which is the worst of both. Declared, not discovered.
    const unreachable = [
      ...new Set(
        VALUE_BEARING.filter((c) => c.classification === 'retained').map(
          (c) => c.table,
        ),
      ),
    ].filter((t) => !RETAINED_REACH[t])

    expect(
      unreachable,
      `retained but undisclosable: ${unreachable.join(', ')}`,
    ).toHaveLength(0)
  })
})
