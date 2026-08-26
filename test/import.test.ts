/**
 * Importing a spreadsheet you already have.
 *
 * An ordinary test, but the behaviour it covers is the product's whole claim
 * for anyone without a runtime: a CSV of leads is personal data with no
 * provenance, no retention and no way to answer for it, and one command should
 * be enough to change that. The properties below are what "change that" means.
 */

import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { fixture, type Fixture } from './harness.js'
import { parseCsv } from '../src/lib/csv.js'
import { importCsv, slug, suggestPlan, type ImportPlan } from '../src/lib/import.js'
import { createSheet, readSheet } from '../src/lib/sheets.js'
import { subjectAccessPack } from '../src/lib/dsr.js'
import { cell, person, provenance } from '../src/db/schema.js'

let f: Fixture

const LEADS = [
  'Company,Contact name,Email,Headquarters,Last round',
  'Testbolaget AB,Vera Exempel Testsson,vera@example.test,Stockholm,Series B',
  'Vindkraft Nordic AB,Nora Testberg,nora@example.test,"Malmö, Sweden",Series A',
  'Solstråle Energi AB,,,"Uppsala",Seed',
].join('\n')

async function sheetFor(f: Fixture) {
  const { sheetId } = await createSheet(f.db, f.workspaceId, {
    name: 'Imported leads',
    purpose: 'Qualify inbound leads for advisory introductions.',
    declaredUse: 'market_mapping',
  })
  return sheetId
}

const PLAN: ImportPlan = {
  labelColumn: 'Company',
  rowKind: 'organisation',
  columns: [
    { header: 'Company', dataClass: 'business' },
    { header: 'Contact name', dataClass: 'personal' },
    { header: 'Email', dataClass: 'personal' },
    { header: 'Headquarters', dataClass: 'business' },
    { header: 'Last round', dataClass: 'business' },
  ],
}

describe('the CSV reader', () => {
  it('reads what real exports contain', () => {
    const table = parseCsv(
      'a,b,c\n1,"two, with comma",3\n4,"a ""quoted"" word",6\r\n7,"line\nbreak",9\n',
    )
    expect(table.headers).toEqual(['a', 'b', 'c'])
    expect(table.rows).toEqual([
      ['1', 'two, with comma', '3'],
      ['4', 'a "quoted" word', '6'],
      ['7', 'line\nbreak', '9'],
    ])
  })

  it('pads a short row rather than dropping it', () => {
    // A missing trailing field is an empty value, not a malformed file, and
    // dropping the row would lose a lead without saying so.
    expect(parseCsv('a,b,c\n1,2\n').rows).toEqual([['1', '2', '']])
  })

  it('makes a usable key out of any header', () => {
    expect(slug('Contact name')).toBe('contact_name')
    expect(slug('  E-Mail Address ')).toBe('e_mail_address')
  })
})

describe('importing a CSV', () => {
  it('writes every value through the real write path', async () => {
    f = await fixture()
    const sheetId = await sheetFor(f)

    const report = await importCsv(
      f.db,
      f.workspaceId,
      sheetId,
      { path: 'leads.csv', contents: LEADS },
      PLAN,
      'soheill',
    )

    expect(report.rowsRead).toBe(3)
    expect(report.rowsWritten).toBe(3)

    // Provenance for every value, naming the file and the person who ran it.
    const cells = await f.db.select().from(cell)
    const origins = await f.db.select().from(provenance)
    expect(origins.length).toBe(cells.filter((c) => c.state === 'filled').length)
    expect(origins[0]!.sourceUrl).toBe('file://leads.csv')
    expect(origins[0]!.crawlerId).toBe('import:soheill')
    expect(origins[0]!.synthetic, 'imported data is not fixture data').toBe(false)

    // An import asserts no collection state, because nothing was fetched.
    expect(origins[0]!.robotsState).toBe('n/a')
    expect(origins[0]!.aiTxtState).toBe('n/a')
  })

  it('resolves the people in the file to entities, and deduplicates them', async () => {
    f = await fixture()
    const sheetId = await sheetFor(f)

    await importCsv(
      f.db,
      f.workspaceId,
      sheetId,
      { path: 'leads.csv', contents: LEADS },
      PLAN,
      'soheill',
    )

    const people = await f.db.select().from(person)
    // Two contacts, each named once and emailed once. The name and the email
    // are different identifiers, so they are different entities until
    // something links them — which is honest, and worth seeing.
    expect(people.length).toBeGreaterThanOrEqual(2)

    const byName = people.find((p) => p.displayName === 'Vera Exempel Testsson')
    expect(byName, 'the contact name did not become a person').toBeTruthy()

    // And they are answerable: the access request finds them.
    const pack = await subjectAccessPack(f.db, byName!.id)
    expect(pack.holdings.length).toBeGreaterThan(0)
  })

  it('starts the retention clock on import', async () => {
    f = await fixture({ workspaceRetentionDays: 90 })
    const sheetId = await sheetFor(f)

    await importCsv(
      f.db,
      f.workspaceId,
      sheetId,
      { path: 'leads.csv', contents: LEADS },
      PLAN,
      'soheill',
    )

    const [first] = await f.db.select().from(cell).where(eq(cell.state, 'filled'))
    const days = (first!.retentionExpiresAt!.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(89)
    expect(days).toBeLessThan(91)
  })

  it('refuses a special category in the file rather than importing it', async () => {
    f = await fixture()
    const sheetId = await sheetFor(f)

    const withHealth = [
      'Company,Note',
      'Testbolaget AB,On sick leave following a cancer diagnosis',
    ].join('\n')

    const report = await importCsv(
      f.db,
      f.workspaceId,
      sheetId,
      { path: 'notes.csv', contents: withHealth },
      {
        labelColumn: 'Company',
        columns: [
          { header: 'Company', dataClass: 'business' },
          { header: 'Note', dataClass: 'personal' },
        ],
      },
      'soheill',
    )

    expect(report.refused).toHaveLength(1)
    expect(report.refused[0]!.category).toBe('health')

    // The report names the category and never the value, and neither does the
    // database.
    expect(JSON.stringify(report)).not.toContain('cancer')
    const view = await readSheet(f.db, f.workspaceId, sheetId)
    expect(JSON.stringify(view)).not.toContain('cancer')
  })

  it('reports what it could not settle rather than guessing', async () => {
    f = await fixture()
    const sheetId = await sheetFor(f)

    // A name-shaped value in a column called Notes. Guessing "a person" mints
    // an entity; guessing "nobody" loses one.
    const ambiguous = ['Company,Notes', 'Testbolaget AB,Ingrid Vasastan'].join('\n')

    const report = await importCsv(
      f.db,
      f.workspaceId,
      sheetId,
      { path: 'notes.csv', contents: ambiguous },
      {
        labelColumn: 'Company',
        columns: [
          { header: 'Company', dataClass: 'business' },
          { header: 'Notes', dataClass: 'business' },
        ],
      },
      'soheill',
    )

    expect(report.uncertain).toEqual([
      { rowLabel: 'Testbolaget AB', columnKey: 'notes', reason: 'ambiguous_identity' },
    ])
    expect(await f.db.select().from(person)).toHaveLength(0)
  })

  it('holds nothing from a column the plan skips', async () => {
    f = await fixture()
    const sheetId = await sheetFor(f)

    await importCsv(
      f.db,
      f.workspaceId,
      sheetId,
      { path: 'leads.csv', contents: LEADS },
      {
        ...PLAN,
        columns: PLAN.columns.map((c) =>
          c.header === 'Email' ? { ...c, skip: true } : c,
        ),
      },
      'soheill',
    )

    const view = await readSheet(f.db, f.workspaceId, sheetId)
    expect(view!.columns.map((c) => c.key)).not.toContain('email')
    expect(JSON.stringify(view)).not.toContain('vera@example.test')
  })

  it('refuses a plan that does not match the file', async () => {
    f = await fixture()
    const sheetId = await sheetFor(f)

    await expect(
      importCsv(
        f.db,
        f.workspaceId,
        sheetId,
        { path: 'leads.csv', contents: LEADS },
        { labelColumn: 'Organisation', columns: [] },
        'soheill',
      ),
    ).rejects.toThrow(/not in the file/)
  })

  it('suggests a plan, timidly, for a person to correct', async () => {
    const plan = suggestPlan(['Company', 'Contact name', 'Email', 'Headquarters'])
    const classOf = (h: string) => plan.columns.find((c) => c.header === h)!.dataClass

    expect(classOf('Contact name')).toBe('personal')
    expect(classOf('Email')).toBe('personal')
    // Not guessed upward: a column of cities classified personal would
    // manufacture a person per city.
    expect(classOf('Headquarters')).toBe('business')
    expect(classOf('Company')).toBe('business')
  })
})
