/**
 * INVARIANT 6 — Special-category data is refused, not stored.
 *
 * Article 9 data must not land anywhere: not in the cell, not in a provenance
 * quote, not in a log line, not in a reasoning trace. The refusal records the
 * CATEGORY and nothing else.
 *
 * The test scans every text column in the database for the value afterwards,
 * so a new table that happens to store agent output cannot quietly become a
 * leak.
 */

import { describe, it, expect } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { fixture, type Fixture } from '../harness.js'
import { writeCellValue, type AgentResult } from '../../src/lib/write.js'
import { cell } from '../../src/db/schema.js'
import { checkSpecialCategory } from '../../src/lib/special.js'
import { syntheticReceipt } from '../../src/lib/collection.js'
import { scanForValue } from '../../src/lib/audit.js'

let f: Fixture

const CASES: { label: string; value: string; category: string }[] = [
  { label: 'health', value: 'On sick leave following a cancer diagnosis', category: 'health' },
  { label: 'trade union', value: 'Union member since 2019 (Unionen)', category: 'trade_union' },
  { label: 'religion', value: 'Practising Muslim, active in the mosque board', category: 'religion' },
  {
    label: 'criminal offence',
    value: 'Convicted of tax fraud in 2021',
    category: 'criminal_offence',
  },
  {
    label: 'sexual orientation',
    value: 'Openly gay, speaks at Pride events',
    category: 'sexual_orientation',
  },
]

describe('invariant: special categories are refused', () => {
  for (const c of CASES) {
    it(`refuses ${c.label} and stores nothing`, async () => {
      f = await fixture({ columnName: 'Founder note', dataClass: 'personal' })

      const result: AgentResult = {
        value: c.value,
        state: 'filled',
        sources: [{ receipt: syntheticReceipt('https://example.com/profile') }],
      }

      const outcome = await writeCellValue(
        { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
        result,
      )

      expect(outcome.state).toBe('refused')
      expect(outcome.refusedCategory).toBe(c.category)

      const [row] = await f.db.select().from(cell).where(eq(cell.id, outcome.cellId))
      expect(row!.value).toBeNull()
      expect(row!.refusalReason).toBe(`special_category:${c.category}`)

      const hits = (await scanForValue(f.db, c.value)).found
      expect(hits, `special-category value leaked into: ${hits.join(', ')}`).toHaveLength(0)
    })
  }

  it('refuses when the value is clean but a source quote is not', async () => {
    // The quote is the easy place to leak. An agent that returns a harmless
    // value with an Article 9 excerpt attached is the realistic failure.
    f = await fixture({ columnName: 'Founder note', dataClass: 'personal' })

    const outcome = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      {
        value: 'Active in industry associations',
        state: 'filled',
        sources: [
          {
            receipt: syntheticReceipt('https://example.com/profile'),
            quote: 'Union member since 2019',
          },
        ],
      },
    )

    expect(outcome.state).toBe('refused')
    expect((await scanForValue(f.db, 'Union member since 2019')).found).toHaveLength(0)
  })

  it('does not refuse ordinary business facts', async () => {
    const clean = checkSpecialCategory(
      'Series B, €40M, led by Sequoia. Headquartered in Stockholm.',
    )
    expect(clean.special).toBe(false)
  })
})
