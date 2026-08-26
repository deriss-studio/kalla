/**
 * INVARIANT 13 — A sheet's risk class is derived, never declared.
 *
 * Commitment 3: if a compliance artifact requires a user to type something the
 * system could have known, the substrate is incomplete. An AI Act risk class
 * that arrives as a parameter is the clearest possible case — it is the field a
 * hurried person sets to `minimal` to make a warning go away, and the field a
 * regulator reads first.
 *
 * So createSheet takes a declared *use* and works the class out. There is no
 * argument to get wrong, and a sheet that screens candidates cannot be created
 * as though it mapped a market.
 *
 * The same reasoning makes a column's data class required rather than
 * defaulted. What a column holds governs retention, special-category scanning
 * and disclosure; a default is a guess, and the guess that hurts is the
 * personal column silently handled as a business one.
 */

import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { fixture, type Fixture } from '../harness.js'
import { createColumn, createSheet } from '../../src/lib/sheets.js'
import { classifySheet } from '../../src/lib/classify.js'
import { column, sheet, workspace } from '../../src/db/schema.js'

let f: Fixture

/** Every use the product offers, and what the Act makes of it. */
const USES = [
  'market_mapping',
  'supplier_screening',
  'deal_sourcing',
  'competitive_research',
  'employment_screening',
  'creditworthiness',
  'education_access',
  'essential_services',
  'other',
] as const

describe('invariant: a sheet knows its own risk class', () => {
  it('derives the class from the declared use, for every use there is', async () => {
    f = await fixture()

    for (const use of USES) {
      const created = await createSheet(f.db, f.workspaceId, {
        name: `Sheet for ${use}`,
        purpose: 'A declared purpose.',
        declaredUse: use,
      })

      const [stored] = await f.db
        .select()
        .from(sheet)
        .where(eq(sheet.id, created.sheetId))

      expect(
        stored!.aiActClass,
        `${use} was stored with a class that does not match its use`,
      ).toBe(classifySheet(use).aiActClass)
    }
  })

  it('turns on the stricter regime for the Annex III uses', async () => {
    f = await fixture()

    const screening = await createSheet(f.db, f.workspaceId, {
      name: 'Candidate screening',
      purpose: 'Assess candidates for a role.',
      declaredUse: 'employment_screening',
    })
    expect(screening.aiActClass).toBe('high_risk')
    expect(screening.obligations.join(' ')).toMatch(/human oversight/i)
    expect(screening.obligations.join(' ')).toMatch(/sign-off/i)

    const mapping = await createSheet(f.db, f.workspaceId, {
      name: 'Market map',
      purpose: 'Map a market.',
      declaredUse: 'market_mapping',
    })
    expect(mapping.aiActClass).toBe('transparency_only')
    expect(mapping.obligations).toHaveLength(1)
  })

  it('refuses a sheet with no declared purpose', async () => {
    // The purpose is what the legitimate interest assessment is written
    // against, and what a subject is told when they ask why. A sheet without
    // one cannot produce either.
    f = await fixture()

    await expect(
      createSheet(f.db, f.workspaceId, {
        name: 'Nameless intent',
        purpose: '   ',
        declaredUse: 'market_mapping',
      }),
    ).rejects.toThrow(/declared purpose/)

    expect(await f.db.select().from(sheet).where(eq(sheet.name, 'Nameless intent'))).toHaveLength(0)
  })

  it('refuses a column in a sheet belonging to another workspace', async () => {
    f = await fixture()
    const [them] = await f.db
      .insert(workspace)
      .values({ name: 'Another tenant' })
      .returning({ id: workspace.id })

    await expect(
      createColumn(f.db, them!.id, f.sheetId, {
        key: 'smuggled',
        name: 'Smuggled',
        prompt: 'anything',
        dataClass: 'personal',
      }),
    ).rejects.toThrow(/does not belong to workspace/)

    expect(await f.db.select().from(column).where(eq(column.key, 'smuggled'))).toHaveLength(0)
  })

  it('records the data class it was given, on every column', async () => {
    f = await fixture()

    for (const dataClass of ['none', 'business', 'personal', 'special'] as const) {
      const { columnId } = await createColumn(f.db, f.workspaceId, f.sheetId, {
        key: `col_${dataClass}`,
        name: dataClass,
        prompt: 'anything',
        dataClass,
      })
      const [stored] = await f.db.select().from(column).where(eq(column.id, columnId))
      expect(stored!.dataClass).toBe(dataClass)
    }
  })
})
