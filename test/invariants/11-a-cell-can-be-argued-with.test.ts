/**
 * INVARIANT 11 — Every cell can be argued with.
 *
 * Commitment 4, end to end. Invariant 5 covers its other half — that a human's
 * value is not silently overwritten — and this covers the rest: a claim is
 * recorded beside the value rather than replacing it, and resolution is a
 * human act with a name against it.
 *
 * It earns a number because its failure breaks a commitment rather than a
 * feature. A contest that can be resolved without a name, closed on a timeout,
 * or dropped when the value moves is not a degraded feature; it is the
 * difference between a system a data subject can argue with and one they
 * cannot. For most of this repository's life the contest table existed and
 * nothing wrote to it, which made "every cell can be argued with" the one
 * claim in the README the code did not support.
 */

import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { fixture, sourced, type Fixture } from '../harness.js'
import { writeCellValue } from '../../src/lib/write.js'
import {
  contestsFor,
  raiseContest,
  resolveContest,
} from '../../src/lib/contest.js'
import { authorship, cell, person } from '../../src/db/schema.js'

let f: Fixture

async function filledCell(f: Fixture, value = 'Stockholm') {
  const { cellId } = await writeCellValue(
    { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
    sourced(value),
  )
  return cellId
}

async function stateOf(f: Fixture, cellId: string) {
  const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
  return row!
}

describe('a cell can be argued with', () => {
  it('records the argument beside the value, and says so on the cell', async () => {
    f = await fixture()
    const cellId = await filledCell(f)

    const { contestId } = await raiseContest(f.db, f.workspaceId, cellId, {
      raisedBy: 'reviewer',
      raiserRef: 'anna',
      claim: 'The head office moved to Gothenburg last year.',
      counterEvidence: [{ url: 'https://testbolaget.example/contact', note: 'current address' }],
    })

    const row = await stateOf(f, cellId)
    expect(row.value, 'the contested value was replaced instead of argued with').toBe(
      'Stockholm',
    )
    expect(row.state).toBe('contested')

    const [recorded] = await contestsFor(f.db, cellId)
    expect(recorded!.id).toBe(contestId)
    expect(recorded!.claim).toContain('Gothenburg')
    expect(recorded!.priorValue).toBe('Stockholm')
    expect(recorded!.resolvedAt).toBeNull()
  })

  it('upholds a value without erasing the disagreement', async () => {
    f = await fixture()
    const cellId = await filledCell(f)

    const { contestId } = await raiseContest(f.db, f.workspaceId, cellId, {
      raisedBy: 'user',
      raiserRef: 'lars',
      claim: 'I think this is wrong.',
    })

    await resolveContest(f.db, f.workspaceId, contestId, {
      resolution: 'upheld',
      resolvedByHuman: 'soheill',
      note: 'Registry filing confirms Stockholm.',
    })

    const row = await stateOf(f, cellId)
    expect(row.value).toBe('Stockholm')
    expect(row.state).toBe('filled')

    const [recorded] = await contestsFor(f.db, cellId)
    expect(recorded!.resolution).toBe('upheld')
    expect(recorded!.resolvedByHuman).toBe('soheill')
    expect(recorded!.resolvedAt).toBeInstanceOf(Date)
    expect(recorded!.claim, 'the claim was erased on resolution').toContain(
      'I think this is wrong',
    )
  })

  it('corrects a value by the hand of the person resolving it', async () => {
    f = await fixture()
    const cellId = await filledCell(f)

    const { contestId } = await raiseContest(f.db, f.workspaceId, cellId, {
      raisedBy: 'reviewer',
      raiserRef: 'anna',
      claim: 'Moved to Gothenburg.',
    })

    await resolveContest(f.db, f.workspaceId, contestId, {
      resolution: 'corrected',
      resolvedByHuman: 'soheill',
      value: 'Gothenburg',
      evidenceUrl: 'https://testbolaget.example/contact',
    })

    const row = await stateOf(f, cellId)
    expect(row.value).toBe('Gothenburg')
    expect(row.state).toBe('filled')

    // A correction is a human write, with everything that entails.
    const [author] = await f.db
      .select()
      .from(authorship)
      .where(eq(authorship.cellId, cellId))
    expect(author!.origin).toBe('machine_then_human')
    expect(author!.actorRef).toBe('soheill')

    const [recorded] = await contestsFor(f.db, cellId)
    expect(recorded!.priorValue, 'the value argued with was not kept').toBe(
      'Stockholm',
    )
  })

  it('resolves a subject contesting a value about themselves', async () => {
    // The case the whole commitment exists for, and the one a CRM cannot do:
    // the person the data is about disagrees, and the correction resolves them
    // as an entity rather than leaving a new bare string behind.
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    const { cellId, subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Vera Exempel Testsson'),
    )
    expect(subjectId).toBeTruthy()

    const { contestId } = await raiseContest(f.db, f.workspaceId, cellId, {
      raisedBy: 'subject',
      raiserRef: 'dsr-inbox',
      claim: 'I left the company in 2024 and am not the founder.',
    })
    expect((await stateOf(f, cellId)).state).toBe('contested')

    await resolveContest(f.db, f.workspaceId, contestId, {
      resolution: 'corrected',
      resolvedByHuman: 'soheill',
      value: 'Sara Lindqvist',
      note: 'Confirmed with the company.',
    })

    const row = await stateOf(f, cellId)
    expect(row.value).toBe('Sara Lindqvist')
    expect(row.subjectId, 'the corrected name stayed a string').toBeTruthy()
    expect(row.subjectId).not.toBe(subjectId)

    const all = await f.db.select().from(person)
    expect(all.map((p) => p.displayName).sort()).toEqual([
      'Vera Exempel Testsson',
      'Sara Lindqvist',
    ])
  })

  it('keeps a cell contested while another argument is still running', async () => {
    f = await fixture()
    const cellId = await filledCell(f)

    const first = await raiseContest(f.db, f.workspaceId, cellId, {
      raisedBy: 'user',
      claim: 'Wrong city.',
    })
    await raiseContest(f.db, f.workspaceId, cellId, {
      raisedBy: 'reviewer',
      claim: 'Wrong company entirely.',
    })

    await resolveContest(f.db, f.workspaceId, first.contestId, {
      resolution: 'withdrawn',
      resolvedByHuman: 'lars',
    })

    expect(
      (await stateOf(f, cellId)).state,
      'settling one disagreement settled the others',
    ).toBe('contested')
  })

  it('refuses a resolution with no name against it, and a claim with no claim', async () => {
    f = await fixture()
    const cellId = await filledCell(f)

    await expect(
      raiseContest(f.db, f.workspaceId, cellId, { raisedBy: 'user', claim: '   ' }),
    ).rejects.toThrow(/must state a claim/)

    const { contestId } = await raiseContest(f.db, f.workspaceId, cellId, {
      raisedBy: 'user',
      claim: 'Wrong.',
    })

    await expect(
      resolveContest(f.db, f.workspaceId, contestId, {
        resolution: 'upheld',
        resolvedByHuman: '  ',
      }),
    ).rejects.toThrow(/resolved by a person/)

    await expect(
      resolveContest(f.db, f.workspaceId, contestId, {
        resolution: 'upheld',
        resolvedByHuman: 'soheill',
      }),
    ).resolves.toBeTruthy()

    // And not twice.
    await expect(
      resolveContest(f.db, f.workspaceId, contestId, {
        resolution: 'upheld',
        resolvedByHuman: 'soheill',
      }),
    ).rejects.toThrow(/already resolved/)
  })

  it('refuses a contest against another workspace\'s cell', async () => {
    f = await fixture()
    const cellId = await filledCell(f)

    await expect(
      raiseContest(f.db, '00000000-0000-0000-0000-000000000000', cellId, {
        raisedBy: 'user',
        claim: 'Wrong.',
      }),
    ).rejects.toThrow(/belongs to another workspace/)
  })
})
