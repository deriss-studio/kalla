/**
 * INVARIANT 9 — Personal data is an entity at every write path.
 *
 * Commitment 2 is not "the agent resolves people". It is that a human named in
 * this system is one row with many references, however they got here. Before
 * this invariant existed, resolution lived inside writeCellValue: a name an
 * agent found became an entity, and the identical name typed by a colleague
 * stayed a string — no person row, no retention clock, invisible to a subject
 * access request and untouched by an erasure.
 *
 * Row labels were the same failure one level up, and worse placed. A sheet
 * whose rows are people is an employment_screening or education_access sheet,
 * which is to say an Annex III high-risk use: the substrate was weakest exactly
 * where the regime is strictest.
 *
 * Every path that can introduce an individual is exercised here. Adding a new
 * one means adding a case.
 */

import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fixture, sourced, type Fixture } from '../harness.js'
import {
  acceptProposal,
  createRow,
  humanCorrectCell,
  writeCellValue,
} from '../../src/lib/write.js'
import { assess, erasePerson } from '../../src/lib/person.js'
import {
  FLOORS,
  IDENTIFYING,
  JUNK,
  UNCERTAIN,
  VARIANTS,
} from '../identity-corpus.js'
import { cell, person, proposal, rowEntity } from '../../src/db/schema.js'

let f: Fixture

const SUBJECT = 'Vera Exempel Testsson'

async function people(f: Fixture) {
  return f.db.select().from(person)
}

describe('invariant: personal data is an entity at every write path', () => {
  it('the agent write path resolves a person', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    const { subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )

    expect(subjectId).toBeTruthy()
    expect(await people(f)).toHaveLength(1)
  })

  it('a human correction resolves a person', async () => {
    // The regression this invariant exists for. A colleague typing a name is
    // introducing an individual just as much as an agent finding one.
    //
    // A hinted column — "Founder" — so a name is identifying here. The
    // starting value resolves nobody, so the person who appears can only have
    // come from the human's write.
    f = await fixture({ columnName: 'Founder' })

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )
    expect(await people(f)).toHaveLength(0)

    await humanCorrectCell(f.db, f.workspaceId, cellId, SUBJECT, 'soheill')

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.subjectId).toBeTruthy()

    const all = await people(f)
    expect(all).toHaveLength(1)
    expect(all[0]!.displayName).toBe(SUBJECT)
  })

  it('accepting a proposal resolves a person', async () => {
    f = await fixture({ columnName: 'Founder' })
    const ctx = {
      db: f.db,
      workspaceId: f.workspaceId,
      rowId: f.rowId,
      columnId: f.columnId,
    }

    const { cellId } = await writeCellValue(ctx, sourced('Stockholm'))
    await humanCorrectCell(f.db, f.workspaceId, cellId, 'Gothenburg', 'soheill')

    // The agent finds a person where the human had left a place.
    const outcome = await writeCellValue(ctx, sourced(SUBJECT))
    expect(outcome.proposalId).toBeTruthy()
    expect(await people(f)).toHaveLength(0) // a proposal is not yet a holding

    await acceptProposal(f.db, f.workspaceId, outcome.proposalId!, 'soheill')

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.value).toBe(SUBJECT)
    expect(row!.subjectId).toBeTruthy()
    expect(await people(f)).toHaveLength(1)

    const [p] = await f.db.select().from(proposal)
    expect(p!.state).toBe('accepted')
    expect(p!.decidedBy).toBe('soheill')
  })

  it('creating a person-kind row resolves a person', async () => {
    f = await fixture()

    const { rowId, subjectId } = await createRow(
      f.db,
      f.workspaceId,
      f.sheetId,
      { label: SUBJECT, kind: 'person' },
    )

    expect(subjectId).toBeTruthy()
    const [row] = await f.db.select().from(rowEntity).where(eq(rowEntity.id, rowId))
    expect(row!.subjectId).toBe(subjectId)
    expect(await people(f)).toHaveLength(1)
  })

  it('an organisation row resolves nobody', async () => {
    // The resolution point has to stay quiet where there is no individual, or
    // over-flagging turns every company into a data subject.
    f = await fixture()

    const { subjectId } = await createRow(f.db, f.workspaceId, f.sheetId, {
      label: 'Testbolaget AB',
      kind: 'organisation',
    })

    expect(subjectId).toBeNull()
    expect(await people(f)).toHaveLength(0)
  })

  it('the same human reached by different paths is one entity', async () => {
    // The whole of commitment 2 in one assertion: one row, many references,
    // whoever put them there.
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )

    const { subjectId: fromRow } = await createRow(
      f.db,
      f.workspaceId,
      f.sheetId,
      { label: SUBJECT, kind: 'person' },
    )

    const all = await people(f)
    expect(all, 'the same name reached twice produced two people').toHaveLength(1)
    expect(fromRow).toBe(all[0]!.id)
  })

  it('erasure reaches a person who only ever appeared as a row label', async () => {
    f = await fixture()

    const { rowId, subjectId } = await createRow(
      f.db,
      f.workspaceId,
      f.sheetId,
      { label: SUBJECT, kind: 'person' },
    )

    await erasePerson(f.db, subjectId!)

    const [row] = await f.db.select().from(rowEntity).where(eq(rowEntity.id, rowId))
    expect(row!.label).not.toContain(SUBJECT)
    expect(row!.subjectId).toBeNull()

    const found = await f.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM row_entity WHERE label ILIKE ${'%' + SUBJECT + '%'}`,
    )
    expect(found.rows[0]!.n).toBe(0)
  })
})

/**
 * The corpus. Detection is a judgement, so it is measured rather than
 * asserted — in both directions, because under-flagging loses a person and
 * over-flagging manufactures one, and the second degrades every query the
 * first was supposed to protect.
 */
describe('invariant: detection is held to a measured floor', () => {
  it(`resolves every identifying value (floor ${FLOORS.identifyingResolved})`, () => {
    const missed = IDENTIFYING.filter((c) => !assess(c.value, c.context).identity)
    const rate = (IDENTIFYING.length - missed.length) / IDENTIFYING.length

    expect(
      rate,
      `not identified: ${missed.map((m) => `"${m.value}" (${m.why})`).join('; ')}`,
    ).toBeGreaterThanOrEqual(FLOORS.identifyingResolved)
  })

  it(`leaves every junk value alone (floor ${FLOORS.junkDisturbed})`, () => {
    const disturbed = JUNK.filter((c) => {
      const a = assess(c.value, c.context)
      return a.identity !== null || a.uncertainty !== null
    })
    const rate = disturbed.length / JUNK.length

    expect(
      rate,
      `treated as personal: ${disturbed
        .map((d) => `"${d.value}" (${d.why})`)
        .join('; ')}`,
    ).toBeLessThanOrEqual(FLOORS.junkDisturbed)
  })

  it(`surfaces every genuine doubt (floor ${FLOORS.uncertaintySurfaced})`, () => {
    const guessed = UNCERTAIN.filter((c) => {
      const a = assess(c.value, c.context)
      return a.identity !== null || a.uncertainty === null
    })
    const rate = (UNCERTAIN.length - guessed.length) / UNCERTAIN.length

    expect(
      rate,
      `guessed instead of surfaced: ${guessed
        .map((g) => `"${g.value}" (${g.why})`)
        .join('; ')}`,
    ).toBeGreaterThanOrEqual(FLOORS.uncertaintySurfaced)
  })

  it(`collapses every variant of one human (floor ${FLOORS.variantsCollapsed})`, () => {
    const split = VARIANTS.filter((group) => {
      const keys = new Set(
        group.forms.map((f) => assess(f.value, f.context).identity?.key ?? f.value),
      )
      return keys.size !== 1
    })
    const rate = (VARIANTS.length - split.length) / VARIANTS.length

    expect(
      rate,
      `split across entities: ${split.map((s) => s.why).join('; ')}`,
    ).toBeGreaterThanOrEqual(FLOORS.variantsCollapsed)
  })

  it('never keys a person on raw text', async () => {
    // The defect this replaced: "Vera Exempel Testsson, CEO" and "Vera Exempel Testsson"
    // became two people, and an Article 15 answer looked complete while
    // missing half of what was held.
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })
    const ctx = {
      db: f.db,
      workspaceId: f.workspaceId,
      rowId: f.rowId,
      columnId: f.columnId,
    }

    const first = await writeCellValue(ctx, sourced('Vera Exempel Testsson, CEO'))
    await humanCorrectCell(f.db, f.workspaceId, first.cellId, 'Vera Exempel Testsson', 'soheill')

    const all = await people(f)
    expect(all, 'one human became two entities').toHaveLength(1)
    expect(all[0]!.canonicalKey).not.toContain('ceo')
  })

  it('records the doubt on the cell rather than choosing a side', async () => {
    f = await fixture()

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Vera Exempel Testsson'),
    )

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.subjectId, 'guessed a person from an unhinted column').toBeNull()
    expect(row!.subjectUncertainty).toBe('ambiguous_identity')
    expect(await people(f)).toHaveLength(0)
  })
})
