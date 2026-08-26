/**
 * INVARIANT 10 — A subject access response is complete.
 *
 * Invariant 4 holds the pack to a time budget. This holds it to a scope, which
 * is the harder of the two: a response that returns in 280ms and omits half of
 * what we hold is worse than a slow one, because it is wrong in a direction
 * nobody notices. Article 15 is answered by what comes back, not by how fast.
 *
 * It earns a number because its failure breaks commitment 3. If the pack has
 * to be assembled by hand rather than derived, the substrate is incomplete —
 * and a holding that erasure knows about but disclosure does not is the exact
 * shape of that incompleteness. The `retained` classification depends on this
 * test existing: keeping data through an erasure is only defensible while the
 * subject is told what was kept and on what ground.
 */

import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { fixture, sourced, type Fixture } from '../harness.js'
import {
  createRow,
  humanCorrectCell,
  writeCellValue,
} from '../../src/lib/write.js'
import { subjectAccessPack } from '../../src/lib/dsr.js'
import { column, contest, person, sheet } from '../../src/db/schema.js'
import { RETAINED_REACH, VALUE_BEARING } from '../../src/db/value-bearing.js'

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

    // And only what mentions them. A prompt is retained and survives an
    // erasure, but "Where is the company headquartered?" holds nothing about
    // this person; listing it here would bury the line that does.
    expect(
      pack.retained.map((r) => `${r.table}.${r.column}`),
      'a retained field that does not mention the subject was disclosed',
    ).toEqual(['sheet.purpose'])
  })

  it('discloses a retained field that names them, wherever it lives', async () => {
    // The rule is about the content, not the table. A prompt that names
    // someone is as disclosable as a purpose that does.
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    await f.db
      .update(column)
      .set({ prompt: `Confirm whether ${SUBJECT} still holds the role.` })
      .where(eq(column.id, f.columnId))

    const { subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )

    const pack = await subjectAccessPack(f.db, subjectId!)
    const prompt = pack.retained.find((r) => r.column === 'prompt')

    expect(prompt, 'a retained prompt naming the subject was not disclosed').toBeTruthy()
    expect(prompt!.value).toContain(SUBJECT)
    expect(prompt!.ground).toMatch(/Art\. 17\(3\)/)
  })

  it('discloses a retained field naming someone who has no name', async () => {
    // A person resolved by email carries no display name at all. If the only
    // needle were the name, they would silently receive an empty retained
    // section — the failure mode the whole section exists to prevent.
    f = await fixture({ columnName: 'Contact', dataClass: 'personal' })

    await f.db
      .update(sheet)
      .set({ purpose: 'Follow up with vera@example.test about the mandate.' })
      .where(eq(sheet.id, f.sheetId))

    const { subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('vera@example.test'),
    )

    const [subject] = await f.db.select().from(person).where(eq(person.id, subjectId!))
    expect(subject!.displayName, 'this case needs a person with no name').toBeNull()

    const pack = await subjectAccessPack(f.db, subjectId!)
    const purpose = pack.retained.find((r) => r.column === 'purpose')

    expect(purpose, 'a person with no display name was disclosed nothing').toBeTruthy()
    expect(purpose!.value).toContain('vera@example.test')
  })

  it('discloses the purpose of the processing whether or not it names them', async () => {
    // Article 15(1)(a) asks for the purposes regardless. They ride on each
    // holding, so narrowing the retained section does not lose them.
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    const { subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )

    const pack = await subjectAccessPack(f.db, subjectId!)

    expect(pack.retained, 'nothing here mentions them').toHaveLength(0)
    expect(pack.holdings[0]!.sheetPurpose).toBeTruthy()
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
