/**
 * npm run demo — a rehearsable walkthrough of the six moments.
 *
 * This is not a feature and it is not a test. It is the argument, in the order
 * a person makes it, with pauses so they can talk over it. `--fast` skips the
 * pauses for rehearsal.
 *
 * Everything here calls the real code path. Two things are stubbed, both at
 * seams that exist in the design rather than for the demo's convenience: the
 * network, through the Fetcher that guardedFetch already takes, and model
 * inference, through the adapter interface in src/lib/models.ts. The banner
 * says so out loud, because a walkthrough shown to a DPO that quietly fakes
 * its own subject matter is worth less than no walkthrough.
 *
 * Where a moment could NOT be shown through a real path, it is not staged.
 * It is reported at the end, under FINDINGS.
 */

import { eq, sql } from 'drizzle-orm'
import { createDb, type Db } from '../src/db/client.js'
import {
  cell,
  column,
  contest,
  person,
  provenance,
  rowEntity,
  sheet,
  workspace,
} from '../src/db/schema.js'
import { classifySheet, type DeclaredUse } from '../src/lib/classify.js'
import { guardedFetch, type Fetcher } from '../src/lib/collection.js'
import { raiseContest, resolveContest } from '../src/lib/contest.js'
import { subjectAccessPack } from '../src/lib/dsr.js'
import { erasePerson } from '../src/lib/person.js'
import { scanForValue } from '../src/lib/audit.js'
import { registerAdapter, selectAdapter } from '../src/lib/models.js'
import { createRow, writeCellValue } from '../src/lib/write.js'
import {
  amber,
  banner,
  rule,
  tableWrapped,
  when,
  blank,
  bold,
  cyan,
  dim,
  field,
  fieldWrapped,
  green,
  note,
  pause,
  point,
  step,
  table,
  truncate,
} from './format.js'

const SUBJECT = 'Vera Exempel Testsson'

/* ------------------------------------------------------------ the stubs */

/** The pages this walkthrough's "web" serves. */
const WEB: Record<string, string> = {
  'https://testbolaget.example/robots.txt': 'User-agent: *\nAllow: /',
  'https://testbolaget.example/about':
    `<h1>Testbolaget AB</h1><p>Founded in Stockholm by ${SUBJECT}.</p>`,
  'https://testbolaget.example/team': `<p>${SUBJECT}, chief executive.</p>`,
  'https://vindkraft.example/about': '<h1>Vindkraft Nordic AB</h1><p>Based in Malmö.</p>',
  'https://solstrale.example/about': '<h1>Solstrale Energi AB</h1><p>Based in Uppsala.</p>',
}

const fetcher: Fetcher = async (url) => {
  const body = WEB[url]
  return body ? { body, status: 200 } : { body: '', status: 404 }
}

/* ------------------------------------------------------------- the seed */

interface Seed {
  db: Db
  workspaceId: string
  marketSheet: string
  boardSheet: string
  founderCellId: string
  hqCellOf: Record<string, string>
  subjectId: string
}

async function seed(): Promise<Seed> {
  const { db } = await createDb()

  // The adapter interface is real; this adapter answers from a fixture. A
  // provider that cannot report its processing region is not eligible, so the
  // region below is not decoration — writeCellValue records it per cell.
  registerAdapter({
    id: 'mistral-large-2411',
    region: 'eu-west-1',
    async complete() {
      return { text: '', modelId: 'mistral-large-2411', modelRegion: 'eu-west-1' }
    },
  })
  const model = selectAdapter('default')

  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Deriss Advisory', regionPin: 'eu-north-1', defaultRetentionDays: 180 })
    .returning({ id: workspace.id })
  const workspaceId = ws!.id

  const makeSheet = async (name: string, purpose: string, use: DeclaredUse) => {
    const [s] = await db
      .insert(sheet)
      .values({
        workspaceId,
        name,
        purpose,
        declaredUse: use,
        aiActClass: classifySheet(use).aiActClass,
        personalDataExpected: true,
      })
      .returning({ id: sheet.id })
    return s!.id
  }

  const makeColumn = async (
    sheetId: string,
    key: string,
    name: string,
    prompt: string,
    dataClass: 'business' | 'personal',
    position: number,
  ) => {
    const [c] = await db
      .insert(column)
      .values({ sheetId, key, name, prompt, dataClass, position, modelPolicy: 'default' })
      .returning({ id: column.id })
    return c!.id
  }

  const marketSheet = await makeSheet(
    'Nordic climate-tech scale-ups',
    'Map Nordic climate-tech scale-ups to introduce them to advisory clients.',
    'market_mapping',
  )
  const boardSheet = await makeSheet(
    'Advisory board candidates',
    'Assess candidates for a client advisory board appointment.',
    'employment_screening',
  )

  const hqCol = await makeColumn(
    marketSheet, 'hq', 'Headquarters', 'Where is the company headquartered?', 'business', 0,
  )
  const founderCol = await makeColumn(
    marketSheet, 'founder', 'Founder', 'Who founded the company?', 'personal', 1,
  )
  const notesCol = await makeColumn(
    marketSheet, 'notes', 'Notes', 'Anything else of interest?', 'business', 2,
  )

  const companies = [
    { label: 'Testbolaget AB', url: 'https://testbolaget.example/about', hq: 'Stockholm', founder: SUBJECT },
    { label: 'Vindkraft Nordic AB', url: 'https://vindkraft.example/about', hq: 'Malmö', founder: 'Nora Testberg' },
    { label: 'Solstråle Energi AB', url: 'https://solstrale.example/about', hq: 'Uppsala', founder: 'Anna-Karin Övningsson' },
  ]

  const hqCellOf: Record<string, string> = {}
  let founderCellId = ''
  let subjectId = ''

  for (const [i, co] of companies.entries()) {
    const { rowId } = await createRow(db, workspaceId, marketSheet, {
      label: co.label,
      kind: 'organisation',
      position: i,
    })

    // Every source goes through the gate. The receipt it issues is the only
    // way a value can carry a robots or ai.txt state at all.
    const fetched = await guardedFetch(db, workspaceId, co.url, fetcher)

    const hq = await writeCellValue(
      { db, workspaceId, rowId, columnId: hqCol },
      {
        value: co.hq,
        state: 'filled',
        sources: [{ receipt: fetched.receipt, quote: `Based in ${co.hq}.` }],
        confidence: 0.94,
        modelId: model.id,
        modelRegion: model.region,
      },
    )
    hqCellOf[co.label] = hq.cellId

    const founder = await writeCellValue(
      { db, workspaceId, rowId, columnId: founderCol },
      {
        value: co.founder,
        state: 'filled',
        sources: [{ receipt: fetched.receipt, quote: `Founded by ${co.founder}.` }],
        confidence: 0.88,
        modelId: model.id,
        modelRegion: model.region,
      },
    )
    if (i === 0) {
      founderCellId = founder.cellId
      subjectId = founder.subjectId!
    }

    await writeCellValue(
      { db, workspaceId, rowId, columnId: notesCol },
      { value: null, state: 'not_found', sources: [], notes: 'no further detail published' },
    )
  }

  // The same human, in a second sheet, as a row rather than a value. This is
  // what makes the access request span sheets.
  await createRow(db, workspaceId, boardSheet, {
    label: SUBJECT,
    kind: 'person',
    position: 0,
  })

  return { db, workspaceId, marketSheet, boardSheet, founderCellId, hqCellOf, subjectId }
}

/* ----------------------------------------------------------- the moments */

/**
 * Demo-local. There is no library function that reads a sheet for display —
 * see FINDINGS.
 */
async function readSheet(db: Db, sheetId: string) {
  const cols = await db
    .select()
    .from(column)
    .where(eq(column.sheetId, sheetId))
    .orderBy(column.position)
  const rows = await db
    .select()
    .from(rowEntity)
    .where(eq(rowEntity.sheetId, sheetId))
    .orderBy(rowEntity.position)
  const cells = await db.select().from(cell).where(eq(cell.sheetId, sheetId))
  return { cols, rows, cells }
}


async function momentSheet(s: Seed): Promise<void> {
  step('A SHEET, FILLED')

  const [sh] = await s.db.select().from(sheet).where(eq(sheet.id, s.marketSheet))
  field('Sheet', bold(sh!.name))
  field('Purpose', truncate(sh!.purpose, 64))
  field('Declared use', `${sh!.declaredUse}${dim('   ->   AI Act: ')}${sh!.aiActClass}`)
  blank()

  const { cols, rows, cells } = await readSheet(s.db, s.marketSheet)

  // Value and state are padded independently so the states line up down the
  // column. Ragged state markers are unreadable from the back of a room.
  const cellAt = (rowId: string, columnId: string) =>
    cells.find((x) => x.rowId === rowId && x.columnId === columnId)

  // A bare value is a filled value. Repeating "filled" down every column
  // buries the two states that are actually saying something.
  const header = ['Company', ...cols.map((c) => c.name)]
  const body = rows.map((r) => [
    r.label,
    ...cols.map((c) => {
      const found = cellAt(r.id, c.id)
      if (!found) return amber('empty')
      if (found.state === 'filled') return truncate(found.value ?? '', 26)
      return amber(found.state)
    }),
  ])
  table(header, body)

  point('Every cell carries a state. Nothing here is blank, including what was not found.')
  note('empty . queued . running . filled . not_found . refused . expired . contested')
}

async function momentCell(s: Seed): Promise<void> {
  step('ONE CELL, OPENED')

  const [c] = await s.db.select().from(cell).where(eq(cell.id, s.founderCellId))
  const [p] = await s.db
    .select()
    .from(provenance)
    .where(eq(provenance.cellId, s.founderCellId))

  field('Value', bold(c!.value ?? ''))
  blank()
  field('Source', p!.sourceUrl)
  field('Retrieved', when(p!.retrievedAt))
  field('Fetched by', p!.crawlerId)
  field('robots.txt at fetch', p!.robotsState)
  field('ai.txt at fetch', p!.aiTxtState)
  blank()
  field('Model', p!.modelId ?? '')
  field('Model region', green(p!.modelRegion ?? ''))
  blank()
  field('Retention expires', when(c!.retentionExpiresAt))
  field('Concerns a person', c!.subjectId ? green('yes, resolved to an entity') : 'no')

  point('None of this was typed by anyone. It is the record the value was written with.')
  note('There is no code path that writes a value without it.')
}

async function momentAccess(s: Seed): Promise<void> {
  step('EVERYTHING WE HOLD ABOUT ONE PERSON')

  const pack = await subjectAccessPack(s.db, s.subjectId)

  field('Subject', bold(pack.subject.displayName ?? ''))
  field('Lawful basis', pack.subject.lawfulBasis)
  field('First seen', when(pack.subject.firstSeenAt))
  blank()

  note('Values held about them')
  table(
    ['Sheet', 'Column', 'Value', 'Sources'],
    pack.holdings.map((h) => [
      truncate(h.sheetName, 30),
      h.columnName,
      truncate(h.value ?? '-', 24),
      String(h.sources.length),
    ]),
  )
  blank()

  note('Rows that ARE them, rather than values about them')
  table(
    ['Sheet', 'Label', 'Kind'],
    pack.rows.map((r) => [truncate(r.sheetName, 30), r.label, r.kind]),
  )
  blank()

  note('Kept even through an erasure request')
  if (pack.retained.length === 0) {
    console.log('    ' + green('nothing') + dim('  -  every field naming this person is erasable'))
  } else {
    tableWrapped(
      ['Held', 'In sheet', 'Which reads'],
      pack.retained.map((r) => [`${r.table}.${r.column}`, r.sheetName, r.value]),
    )
    blank()
    for (const ground of new Set(pack.retained.map((r) => r.ground))) {
      fieldWrapped('Ground', ground.replace(/ — /, ' - '))
    }
  }

  point('One query, every sheet: values, rows, arguments, and what would outlive an erasure.')
  note('Nobody assembled this. It is derived from the substrate.')
}

async function momentErasure(s: Seed): Promise<void> {
  step('ERASURE, AND THE PROOF')

  const before = await scanForValue(s.db, SUBJECT)
  note(`Before: the name appears in ${bold(String(before.found.length))} places`)
  for (const hit of before.found) console.log('    ' + amber(hit))
  blank()

  await erasePerson(s.db, s.subjectId)

  const { scanned, found: after } = await scanForValue(s.db, SUBJECT)
  note(
    `After erasure, scanning all ${bold(String(scanned))} text columns in the database:`,
  )
  blank()
  if (after.length === 0) {
    console.log('    ' + green(bold('0 places. no table, no column, no row.')))
  } else {
    for (const hit of after) console.log('    ' + amber(hit))
  }
  blank()

  const [tomb] = await s.db.select().from(person).where(eq(person.id, s.subjectId))
  field('Person record', `${tomb!.erasureState}, name removed`)
  field('Erased at', when(tomb!.erasedAt))

  point('The scan is the whole database, not the tables we remembered to clear.')
  note('What survives is the tombstone: proof the erasure happened, holding nothing about them.')
}

async function momentContest(s: Seed): Promise<void> {
  step('A CELL, ARGUED WITH')

  const cellId = s.hqCellOf['Vindkraft Nordic AB']!

  const { contestId } = await raiseContest(s.db, s.workspaceId, cellId, {
    raisedBy: 'subject',
    raiserRef: 'dsr-inbox',
    claim: 'The head office moved to Gothenburg in 2025.',
    counterEvidence: [{ url: 'https://vindkraft.example/contact', note: 'current address' }],
  })

  const [contested] = await s.db.select().from(cell).where(eq(cell.id, cellId))
  const [raised] = await s.db.select().from(contest).where(eq(contest.id, contestId))

  field('Value', bold(contested!.value ?? ''))
  field('Cell state', amber(contested!.state))
  field('Claim', raised!.claim)
  field('Raised by', raised!.raisedBy)
  field('Value argued with', raised!.priorValue ?? '')
  blank()
  note('The value did not move. The disagreement is recorded beside it.')

  await pause('Enter to resolve it')

  await resolveContest(s.db, s.workspaceId, contestId, {
    resolution: 'corrected',
    resolvedByHuman: 'soheill@deriss.com',
    value: 'Gothenburg',
    note: 'Confirmed against the register.',
  })

  const [resolved] = await s.db.select().from(cell).where(eq(cell.id, cellId))
  const [outcome] = await s.db.select().from(contest).where(eq(contest.id, contestId))

  blank()
  field('Value', bold(resolved!.value ?? ''))
  field('Cell state', resolved!.state)
  field('Resolution', outcome!.resolution ?? '')
  field('Resolved by', green(outcome!.resolvedByHuman ?? ''))
  field('Still shows', `the original claim, and that it was "${outcome!.priorValue}"`)

  point('A person resolved it, and the record carries their name.')
  note('No timeout closes a contest. There is no path that resolves one without a name.')
}

async function momentUncertain(s: Seed): Promise<void> {
  step('A CELL THAT SAYS IT DOES NOT KNOW')

  const { rows, cols } = await readSheet(s.db, s.marketSheet)
  const notesCol = cols.find((c) => c.key === 'notes')!
  const row = rows.find((r) => r.label === 'Solstråle Energi AB')!

  const fetched = await guardedFetch(
    s.db,
    s.workspaceId,
    'https://solstrale.example/about',
    fetcher,
  )

  const written = await writeCellValue(
    { db: s.db, workspaceId: s.workspaceId, rowId: row.id, columnId: notesCol.id },
    {
      value: 'Ingrid Vasastan',
      state: 'filled',
      sources: [{ receipt: fetched.receipt, quote: 'Ingrid Vasastan, mentioned in passing.' }],
      modelId: 'mistral-large-2411',
      modelRegion: 'eu-west-1',
    },
  )

  const [c] = await s.db.select().from(cell).where(eq(cell.id, written.cellId))
  const people = await s.db.select().from(person)

  field('Column', `${notesCol.name}${dim('   (data class: ' + notesCol.dataClass + ')')}`)
  field('Value written', bold(c!.value ?? ''))
  blank()
  field('Resolved to a person', c!.subjectId ? 'yes' : bold('no'))
  field('Recorded instead', amber(c!.subjectUncertainty ?? ''))
  field('People in the workspace', String(people.length) + dim('   (unchanged)'))

  point('It looks like a name. In a column called Notes, that is not enough to be sure.')
  note('Guessing "a person" invents an entity. Guessing "nobody" loses one. It records the doubt.')
}

/* -------------------------------------------------------------- findings */

function findings(): void {
  console.log('')
  console.log('')
  rule()
  console.log('  ' + bold('FINDINGS  ') + dim('- what this walkthrough could not show through a real path'))
  rule()
  blank()

  const items = [
    [
      'There is no read path.',
      'Nothing in src/ reads a sheet for display. This walkthrough queries the',
      'tables directly to draw the grid. Every write path is covered by an',
      'invariant; the read side has no function and no test.',
    ],
    [
      'Sheets and columns are configured by hand.',
      'There is no createSheet or createColumn, so the seed inserts rows into',
      'the tables directly. Both are configuration rather than values, so no',
      'invariant is bypassed, but the asymmetry with createRow is worth closing.',
    ],
  ]

  for (const [title, ...lines] of items) {
    console.log('  ' + amber('- ') + bold(title!))
    for (const l of lines) console.log('    ' + dim(l))
    blank()
  }
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  banner('KALLA', [
    'Every value knows where it came from, what it is, when it expires,',
    'who put it there, and how to argue with it.',
    '',
    'The network and model inference are stubbed, at the two seams the design',
    'already has. Everything else below is the code path that runs in anger.',
  ])

  const s = await seed()

  await momentSheet(s)
  await pause()
  await momentCell(s)
  await pause()
  await momentAccess(s)
  await pause()
  await momentErasure(s)
  await pause()
  await momentContest(s)
  await pause()
  await momentUncertain(s)

  if (process.argv.includes('--findings')) findings()
  process.exit(0)
}

main().catch((err) => {
  console.error('\n  demo failed:', err)
  process.exit(1)
})
