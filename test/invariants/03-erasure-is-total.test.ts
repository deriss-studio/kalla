/**
 * INVARIANT 3 — Erasure is total.
 *
 * Erase a person and assert their data survives in no cell, no provenance
 * quote, no source URL that could reconstruct it, and no person row. The
 * tombstone that proves the erasure happened is allowed; identifying content
 * is not.
 *
 * The test scans the whole database rather than the tables we remember, so that
 * adding a table which stores a value cannot silently escape it.
 *
 * Scanning was never the weak point. The fixture was: it wrote a cell and
 * nothing else, so `proposal` and `contest` were empty when the scan ran and
 * the columns that actually leaked were never populated. A subject's name
 * survived erasure in proposal.value for as long as this test was green. The
 * fixture now builds every kind of row that can hold their data, and the
 * registry the erasure walks is itself checked for completeness below.
 */

import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fixture, sourced, type Fixture } from '../harness.js'
import { writeCellValue } from '../../src/lib/write.js'
import { erasePerson } from '../../src/lib/person.js'
import { cell, contest, person, proposal, sheet } from '../../src/db/schema.js'
import { SUBJECT_REACH, VALUE_BEARING } from '../../src/db/value-bearing.js'
import { scanForValue } from '../../src/lib/audit.js'

let f: Fixture

const SUBJECT = 'Vera Exempel Testsson'


/**
 * Everything that can hold the subject's data: the cell and its provenance,
 * an agent's proposal over it, and a contest raised against it.
 */
async function holdingsFor(f: Fixture): Promise<string> {
  const { cellId, subjectId } = await writeCellValue(
    { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
    sourced(SUBJECT),
  )
  expect(subjectId).toBeTruthy()

  await f.db.insert(proposal).values({
    cellId,
    value: SUBJECT,
    evidence: [{ url: 'https://example.com/team', quote: `${SUBJECT}, co-founder` }],
  })

  await f.db.insert(contest).values({
    cellId,
    raisedBy: 'subject',
    raiserRef: 'dsr-inbox',
    claim: `${SUBJECT} says this is out of date`,
    counterEvidence: [{ url: 'https://example.com/now', note: `no longer ${SUBJECT}` }],
    priorValue: SUBJECT,
    note: `raised on behalf of ${SUBJECT}`,
  })

  return subjectId!
}

describe('invariant: erasure is total', () => {
  it('removes every trace of a person across every table', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })
    const subjectId = await holdingsFor(f)

    // The subject is genuinely in there before we erase, and in more than one
    // table — otherwise this test proves nothing about the ones it forgot.
    const before = (await scanForValue(f.db, SUBJECT)).found
    expect(before).toEqual(
      expect.arrayContaining([
        'cell.value',
        'provenance.quote',
        'proposal.value',
        'contest.claim',
        // A jsonb column, and not incidentally: proposal.evidence is where the
        // subject's name survived erasure for as long as this test was green.
        // If the scan ever stops looking inside jsonb, it stops looking where
        // the leak actually was.
        'proposal.evidence',
        'contest.counter_evidence',
      ]),
    )

    await erasePerson(f.db, subjectId)

    const hits = (await scanForValue(f.db, SUBJECT)).found
    expect(hits, `subject data survived in: ${hits.join(', ')}`).toHaveLength(0)
  })

  it('refuses to scan for nothing', async () => {
    // An empty needle matches every row of every column. Whichever way the
    // result were read — "found everywhere" or "the scan ran" — it would be a
    // lie about an erasure, so it is refused rather than answered.
    f = await fixture()
    await expect(scanForValue(f.db, '   ')).rejects.toThrow(/empty value/)
  })

  it('classifies every column that could hold a value', async () => {
    // The registry is what erasure walks, so a column missing from it is a
    // column erasure will not reach. Adding a table is therefore a decision
    // about erasure, taken here rather than discovered later.
    f = await fixture()

    const cols = await f.db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('text','character varying','jsonb','json')
    `)

    const inSchema = cols.rows.map((c) => `${c.table_name}.${c.column_name}`)
    const registered = new Set(VALUE_BEARING.map((c) => `${c.table}.${c.column}`))

    const unclassified = inSchema.filter((k) => !registered.has(k))
    expect(
      unclassified,
      `classify these in src/db/value-bearing.ts: ${unclassified.join(', ')}`,
    ).toHaveLength(0)

    const stale = [...registered].filter((k) => !inSchema.includes(k))
    expect(stale, `no longer in the schema: ${stale.join(', ')}`).toHaveLength(0)

    expect(VALUE_BEARING).toHaveLength(registered.size) // no duplicates
  })

  it('gives every subject column erasure walks something to become', async () => {
    // A NOT NULL column cannot simply be nulled, and finding that out when a
    // real erasure runs is the wrong time. Declared instead.
    f = await fixture()

    const notNull = await f.db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND is_nullable = 'NO'
        AND data_type IN ('text','character varying','jsonb','json')
    `)
    const required = new Set(
      notNull.rows.map((c) => `${c.table_name}.${c.column_name}`),
    )

    const missing = VALUE_BEARING.filter(
      (c) =>
        c.classification === 'subject' &&
        c.table in SUBJECT_REACH &&
        required.has(`${c.table}.${c.column}`) &&
        c.redactTo === undefined,
    ).map((c) => `${c.table}.${c.column}`)

    expect(
      missing,
      `these are NOT NULL and need a redactTo: ${missing.join(', ')}`,
    ).toHaveLength(0)
  })

  it('keeps a retained column through an erasure, and nothing else', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })
    const subjectId = await holdingsFor(f)

    // A purpose that names the subject. Unusual, but it is precisely the case
    // the classification exists for: the assessment of whether we may research
    // this person is evidence we have to keep in order to defend having done
    // it, and erasing it would destroy the proof that it was lawful.
    await f.db
      .update(sheet)
      .set({ purpose: `Assess ${SUBJECT} for board suitability.` })
      .where(eq(sheet.id, f.sheetId))

    await erasePerson(f.db, subjectId)

    // Exactly the retained column, and no other. This is the strong form: it
    // proves the retention AND that everything else still went.
    expect((await scanForValue(f.db, SUBJECT)).found).toEqual(['sheet.purpose'])
  })

  it('records a ground for every column retained through an erasure', () => {
    // A retention without a ground is not a retention, it is a leak with a
    // classification in front of it.
    const ungrounded = VALUE_BEARING.filter(
      (c) => c.classification === 'retained' && !c.ground?.trim(),
    ).map((c) => `${c.table}.${c.column}`)

    expect(
      ungrounded,
      `retained without a lawful ground: ${ungrounded.join(', ')}`,
    ).toHaveLength(0)
  })

  it('has no columns erasure cannot reach, and lets the list shrink only', () => {
    // Empty, and pinned that way. A gap that is written down can be argued
    // with; one that is not gets rediscovered by somebody's regulator.
    const unreachable = VALUE_BEARING.filter(
      (c) => c.classification === 'unreachable',
    ).map((c) => `${c.table}.${c.column}`)

    expect(unreachable).toEqual([])
  })

  it('leaves a tombstone proving the erasure happened', async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })
    const { subjectId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced(SUBJECT),
    )

    await erasePerson(f.db, subjectId!)

    const [tomb] = await f.db.select().from(person).where(eq(person.id, subjectId!))
    expect(tomb!.erasureState).toBe('erased')
    expect(tomb!.erasedAt).toBeInstanceOf(Date)
    expect(tomb!.displayName).toBeNull()

    const [c] = await f.db.select().from(cell).where(eq(cell.subjectId, subjectId!))
    expect(c).toBeUndefined() // no cell still points at them
  })
})
