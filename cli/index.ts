#!/usr/bin/env node
/**
 * kalla — make a spreadsheet you already have accountable.
 *
 * Every command here is a thin shell over a function in src/. That is the
 * point: the CLI is an interface to the substrate, not a second
 * implementation of it, and if a command needed something the library did not
 * have then the library was missing something. Three things were, and they were
 * built properly rather than reached around — createSheet, createColumn and the
 * read path, each with an invariant behind it.
 *
 * State lives in .kalla/ next to wherever you run it: a PGlite data directory
 * and a config file naming the workspace, its region, its retention default
 * and who you are. Nothing leaves the machine.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { and, eq } from 'drizzle-orm'

import { openDatabase, type Db } from '../src/db/client.js'
import { cell, sheet, workspace } from '../src/db/schema.js'
import { scanForValue } from '../src/lib/audit.js'
import { typedReceipt } from '../src/lib/collection.js'
import { contestsFor, raiseContest, resolveContest } from '../src/lib/contest.js'
import { findPeople, subjectAccessPack } from '../src/lib/dsr.js'
import { importCsv, suggestPlan, type ImportPlan } from '../src/lib/import.js'
import { parseCsv } from '../src/lib/csv.js'
import { erasePerson } from '../src/lib/person.js'
import { expiredCells, sweepExpired } from '../src/lib/retention.js'
import { createColumn, createSheet, readCell, readSheet } from '../src/lib/sheets.js'
import { createRow, writeCellValue } from '../src/lib/write.js'
import { findTemplate, TEMPLATES } from './templates.js'
import { amber, bold, bullet, cyan, dim, fail, green, heading, kv, ok, red, say, table, warn, when } from './out.js'

/**
 * How to tell someone to run the next command.
 *
 * Until this is published, it is run through an npm script, and a hint that
 * says `kalla new ...` is a hint that does not work. Print what the reader can
 * actually paste.
 */
const HOW = process.env.npm_lifecycle_event === 'kalla' ? 'npm run kalla --' : 'kalla'

const ROOT = resolve(process.env.KALLA_HOME ?? '.kalla')
const CONFIG = join(ROOT, 'config.json')
const DATA = join(ROOT, 'data')

interface Config {
  workspaceId: string
  workspaceName: string
  region: string
  retentionDays: number
  actor: string
}

/* ------------------------------------------------------------------ state */

async function config(): Promise<Config> {
  if (!existsSync(CONFIG)) {
    fail('no workspace here. run `kalla init` first.')
  }
  return JSON.parse(await readFile(CONFIG, 'utf8')) as Config
}

async function open(): Promise<{ db: Db; cfg: Config; close: () => Promise<void> }> {
  const cfg = await config()
  const { db, client } = await openDatabase(DATA)
  return { db, cfg, close: () => client.close() }
}

/** A sheet by name, or by the start of its id; null when there is none. */
async function findSheet(db: Db, workspaceId: string, ref: string): Promise<string | null> {
  const all = await db
    .select({ id: sheet.id, name: sheet.name })
    .from(sheet)
    .where(eq(sheet.workspaceId, workspaceId))

  const byName = all.filter((s) => s.name.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return byName[0]!.id
  const byId = all.filter((s) => s.id.startsWith(ref))
  if (byId.length === 1) return byId[0]!.id
  return null
}

/** A sheet by name, or by the start of its id. */
async function resolveSheet(db: Db, workspaceId: string, ref: string): Promise<string> {
  const all = await db
    .select({ id: sheet.id, name: sheet.name })
    .from(sheet)
    .where(eq(sheet.workspaceId, workspaceId))

  const byName = all.filter((s) => s.name.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return byName[0]!.id

  const byId = all.filter((s) => s.id.startsWith(ref))
  if (byId.length === 1) return byId[0]!.id

  if (byName.length + byId.length === 0) {
    fail(`no sheet matching "${ref}". known: ${all.map((s) => s.name).join(', ') || 'none'}`)
  }
  return fail(`"${ref}" matches more than one sheet. use the id.`)
}

/** One person, or a refusal to guess which. */
async function resolveSubject(db: Db, workspaceId: string, query: string) {
  const found = await findPeople(db, workspaceId, query)
  const live = found.filter((p) => p.erasureState === 'active')

  if (live.length === 0) fail(`nobody matching "${query}".`)
  if (live.length > 1) {
    say(`"${query}" matches ${live.length} people:`)
    table(
      ['Name', 'Key'],
      live.map((p) => [p.displayName ?? dim('(no name)'), p.canonicalKey]),
    )
    fail('be more specific. an erasure cannot be taken back.')
  }
  return live[0]!
}

/* --------------------------------------------------------------- commands */

async function cmdInit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      region: { type: 'string' },
      retention: { type: 'string' },
      actor: { type: 'string' },
    },
    allowPositionals: true,
  })

  if (existsSync(CONFIG)) fail(`a workspace already exists at ${ROOT}`)

  const actor = values.actor
  if (!actor) {
    fail('--actor is required: every human decision in here is recorded against a name.')
  }

  await mkdir(ROOT, { recursive: true })
  const { db, client } = await openDatabase(DATA)

  const region = values.region ?? 'eu-north-1'
  const retentionDays = Number(values.retention ?? 180)
  const workspaceName = values.name ?? basename(process.cwd())

  const [created] = await db
    .insert(workspace)
    .values({ name: workspaceName, regionPin: region, defaultRetentionDays: retentionDays })
    .returning({ id: workspace.id })

  const cfg: Config = {
    workspaceId: created!.id,
    workspaceName,
    region,
    retentionDays,
    actor,
  }
  await writeFile(CONFIG, JSON.stringify(cfg, null, 2) + '\n')
  await client.close()

  ok(`workspace "${workspaceName}" created in ${ROOT}`)
  kv('Region', region)
  kv('Retention default', `${retentionDays} days`)
  kv('Decisions recorded as', actor)
  say()
  say(dim(`next:  ${HOW} new market-map --name "Nordic climate tech"`))
  say(dim(`  or:  ${HOW} import leads.csv --sheet "..." --purpose "..."`))
}

async function cmdNew(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { name: { type: 'string' }, purpose: { type: 'string' } },
    allowPositionals: true,
  })

  const key = positionals[0]
  if (!key) {
    heading('templates')
    for (const t of TEMPLATES) {
      say('  ' + bold(t.key.padEnd(22)) + dim(t.summary))
    }
    say()
    say(dim(`${HOW} new <template> --name "..." [--purpose "..."]`))
    return
  }

  const template = findTemplate(key)
  if (!template) fail(`no template "${key}". try: ${TEMPLATES.map((t) => t.key).join(', ')}`)

  const { db, cfg, close } = await open()
  const created = await createSheet(db, cfg.workspaceId, {
    name: values.name ?? template.name,
    purpose: values.purpose ?? template.purpose,
    declaredUse: template.declaredUse,
  })

  for (const [position, col] of template.columns.entries()) {
    await createColumn(db, cfg.workspaceId, created.sheetId, { ...col, position })
  }
  await close()

  ok(`sheet "${values.name ?? template.name}" created`)
  kv('Declared use', template.declaredUse)
  kv('AI Act class', created.aiActClass === 'high_risk' ? amber(bold(created.aiActClass)) : created.aiActClass)
  kv('Rows are', template.rowKind === 'person' ? amber('people') : 'organisations')

  if (created.aiActClass === 'high_risk') {
    say()
    warn('This declared use is Annex III high risk. The stricter regime applies:')
    for (const o of created.obligations) bullet(o)
    say()
    say(dim('Nobody chose this class. It follows from the use you declared.'))
  }
}

async function cmdImport(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      sheet: { type: 'string' },
      plan: { type: 'string' },
      purpose: { type: 'string' },
      use: { type: 'string' },
    },
    allowPositionals: true,
  })

  const file = positionals[0]
  if (!file) fail('usage: kalla import <file.csv> --sheet <name> [--plan <plan.json>]')
  if (!values.sheet) fail('--sheet is required: values need a surface with a declared purpose.')

  const contents = await readFile(file, 'utf8')
  const { db, cfg, close } = await open()

  // A sheet the import creates still needs a declared purpose. That is not
  // ceremony: it is what the assessment is written against, and what a subject
  // is told when they ask why you hold their data.
  let sheetId = await findSheet(db, cfg.workspaceId, values.sheet)
  if (!sheetId) {
    if (!values.purpose) {
      await close()
      fail(
        `no sheet "${values.sheet}". To create it, add --purpose "why you are holding this" (and optionally --use, default market_mapping).`,
      )
    }
    const made = await createSheet(db, cfg.workspaceId, {
      name: values.sheet,
      purpose: values.purpose,
      declaredUse: (values.use as never) ?? 'market_mapping',
    })
    sheetId = made.sheetId
    ok(`sheet "${values.sheet}" created  (${made.aiActClass})`)
  }

  // Without a plan, propose one and stop. What a column holds decides how it
  // is handled for as long as it is held, and that is a person's decision.
  if (!values.plan) {
    const table_ = parseCsv(contents)
    const plan = suggestPlan(table_.headers)
    const planPath = join(ROOT, 'plans', `${basename(file, '.csv')}.json`)
    await mkdir(join(ROOT, 'plans'), { recursive: true })
    await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n')
    await close()

    heading(`${table_.rows.length} rows, ${table_.headers.length} columns`)
    table(
      ['Column', 'Proposed class'],
      plan.columns.map((c) => [
        c.header,
        c.dataClass === 'personal' || c.dataClass === 'special'
          ? amber(c.dataClass)
          : c.dataClass,
      ]),
    )
    say()
    say('  ' + dim('label column: ') + plan.labelColumn)
    say()
    warn('Nothing imported yet. This is a proposal, not a decision.')
    say(`  Review ${cyan(planPath)} — correct any class it got wrong — then:`)
    say()
    say(`  ${bold(`${HOW} import ${file} --sheet "${values.sheet}" --plan ${planPath}`)}`)
    say()
    say(dim('It guesses low on purpose. A column of cities classified personal'))
    say(dim('would manufacture a person per city, and that degrades every'))
    say(dim('question you would later ask about a real one.'))
    return
  }

  const plan = JSON.parse(await readFile(values.plan, 'utf8')) as ImportPlan
  const report = await importCsv(
    db,
    cfg.workspaceId,
    sheetId,
    { path: basename(file), contents },
    plan,
    cfg.actor,
  )
  await close()

  ok(`imported ${report.rowsWritten} of ${report.rowsRead} rows`)
  kv('Values held', String(report.cellsWritten))
  kv('People resolved', String(report.peopleResolved))
  kv('Columns not held', report.skipped.length ? report.skipped.join(', ') : dim('none'))

  if (report.refused.length > 0) {
    say()
    warn(`${report.refused.length} values refused as special category, and not stored:`)
    table(
      ['Row', 'Column', 'Category'],
      report.refused.map((r) => [r.rowLabel, r.columnKey, r.category]),
    )
    say(dim('  The category is recorded. The value is not, anywhere.'))
  }

  if (report.uncertain.length > 0) {
    say()
    warn(`${report.uncertain.length} values need a human. They were not guessed either way:`)
    table(
      ['Row', 'Column', 'Why'],
      report.uncertain.map((r) => [r.rowLabel, r.columnKey, r.reason]),
    )
  }

  say()
  say(dim('Every value now carries a source, a clock and, where it names'))
  say(dim(`someone, an entity. Try: ${HOW} subject "<a name from the file>"`))
}

async function cmdShow(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      sheet: { type: 'string' },
      row: { type: 'string' },
      column: { type: 'string' },
    },
    allowPositionals: true,
  })
  if (!values.sheet) fail('usage: kalla show --sheet <name> [--row <label> --column <key>]')

  const { db, cfg, close } = await open()
  const sheetId = await resolveSheet(db, cfg.workspaceId, values.sheet)

  if (values.row && values.column) {
    const view = await readCell(db, cfg.workspaceId, sheetId, values.row, values.column)
    await close()
    if (!view) fail('no such cell.')

    heading(`${view.rowLabel} / ${view.columnKey}`)
    kv('Value', view.value ?? dim(`(none — ${view.state})`))
    kv('State', view.state)
    kv('Retention expires', when(view.retentionExpiresAt))
    if (view.uncertainty) kv('Needs review', amber(view.uncertainty))
    if (view.openContests > 0) kv('Open contests', amber(String(view.openContests)))
    say()
    say(dim('  sources'))
    table(
      ['Source', 'Retrieved', 'By'],
      view.sources_detail.map((s) => [s.url, when(s.retrievedAt), s.crawlerId]),
    )
    return
  }

  const view = await readSheet(db, cfg.workspaceId, sheetId)
  await close()
  if (!view) fail('no such sheet.')

  heading(view.sheet.name)
  kv('Purpose', view.sheet.purpose)
  kv('Declared use', view.sheet.declaredUse)
  kv('AI Act class', view.sheet.aiActClass === 'high_risk' ? amber(view.sheet.aiActClass) : view.sheet.aiActClass)
  say()

  const cellFor = (rowId: string, key: string) =>
    view.cells.find((c) => c.rowId === rowId && c.columnKey === key)

  table(
    ['Row', ...view.columns.map((c) => c.name)],
    view.rows.map((r) => [
      r.label + (r.uncertainty ? ' ' + amber('?') : ''),
      ...view.columns.map((c) => {
        const found = cellFor(r.id, c.key)
        if (!found) return dim('empty')
        if (found.value === null) return amber(found.state)
        return found.value + (found.uncertainty ? ' ' + amber('?') : '')
      }),
    ]),
  )

  const review = view.cells.filter((c) => c.uncertainty).length
  if (review > 0) {
    say()
    warn(`${review} values marked ${amber('?')} need a human: identity could not be settled.`)
  }
}

async function cmdSet(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      sheet: { type: 'string' },
      row: { type: 'string' },
      column: { type: 'string' },
      value: { type: 'string' },
    },
    allowPositionals: true,
  })
  if (!values.sheet || !values.row || !values.column || values.value === undefined) {
    fail('usage: kalla set --sheet <name> --row <label> --column <key> --value <text>')
  }

  const { db, cfg, close } = await open()
  const sheetId = await resolveSheet(db, cfg.workspaceId, values.sheet)
  const view = await readSheet(db, cfg.workspaceId, sheetId)
  if (!view) fail('no such sheet.')

  const col = view.columns.find((c) => c.key === values.column)
  if (!col) fail(`no column "${values.column}". known: ${view.columns.map((c) => c.key).join(', ')}`)

  let row = view.rows.find((r) => r.label === values.row)
  if (!row) {
    const made = await createRow(db, cfg.workspaceId, sheetId, { label: values.row! })
    row = { id: made.rowId, label: values.row!, kind: 'organisation', uncertainty: made.uncertainty }
  }

  const outcome = await writeCellValue(
    { db, workspaceId: cfg.workspaceId, rowId: row.id, columnId: col.id },
    {
      value: values.value!,
      state: 'filled',
      sources: [{ receipt: typedReceipt(cfg.actor) }],
    },
  )
  await close()

  if (outcome.state === 'refused') {
    warn(`refused: ${outcome.refusedCategory}. the value was not stored, anywhere.`)
    return
  }
  if (outcome.proposalId) {
    ok('recorded as a proposal — this cell was corrected by a human and is not overwritten')
    return
  }

  ok(`${values.row} / ${values.column} = ${values.value}`)
  if (outcome.subjectId) kv('Resolved to', 'a person entity')
  if (outcome.uncertainty) kv('Needs review', amber(outcome.uncertainty))
}

async function cmdSubject(args: string[]): Promise<void> {
  const { positionals } = parseArgs({ args, allowPositionals: true })
  const query = positionals.join(' ')
  if (!query) fail('usage: kalla subject <name or email>')

  const { db, cfg, close } = await open()
  const subject = await resolveSubject(db, cfg.workspaceId, query)
  const started = Date.now()
  const pack = await subjectAccessPack(db, subject.id)
  const elapsed = Date.now() - started
  await close()

  heading(`Everything held about ${pack.subject.displayName ?? subject.canonicalKey}`)
  kv('Lawful basis', pack.subject.lawfulBasis)
  kv('First seen', when(pack.subject.firstSeenAt))
  kv('Answered in', `${elapsed} ms`)

  say()
  say(dim('  values held'))
  table(
    ['Sheet', 'Column', 'Value', 'Sources', 'Expires'],
    pack.holdings.map((h) => [
      h.sheetName,
      h.columnName,
      h.value ?? dim(`(${h.state})`),
      String(h.sources.length),
      when(h.retentionExpiresAt),
    ]),
  )

  if (pack.rows.length > 0) {
    say()
    say(dim('  rows that are this person'))
    table(['Sheet', 'Label', 'Kind'], pack.rows.map((r) => [r.sheetName, r.label, r.kind]))
  }

  const args_ = pack.holdings.flatMap((h) => h.contests)
  if (args_.length > 0) {
    say()
    say(dim('  arguments recorded against those values'))
    table(
      ['Claim', 'Raised by', 'Resolution'],
      args_.map((c) => [c.claim, c.raisedBy, c.resolution ?? amber('open')]),
    )
  }

  say()
  say(dim('  would survive an erasure request'))
  if (pack.retained.length === 0) {
    say('    ' + green('nothing') + dim('  -  every field naming them is erasable'))
  } else {
    table(
      ['Held', 'In sheet', 'Ground'],
      pack.retained.map((r) => [`${r.table}.${r.column}`, r.sheetName, r.ground]),
    )
  }
}

async function cmdErase(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' }, confirm: { type: 'boolean' } },
    allowPositionals: true,
  })
  const query = positionals.join(' ')
  if (!query) fail('usage: kalla erase <name or email> --confirm')

  const { db, cfg, close } = await open()
  const subject = await resolveSubject(db, cfg.workspaceId, query)
  const pack = await subjectAccessPack(db, subject.id)

  const name = pack.subject.displayName ?? subject.canonicalKey
  const predicted = [...new Set(pack.retained.map((r) => `${r.table}.${r.column}`))].sort()

  if (!values.confirm) {
    heading(`Erasing ${name} would remove`)
    kv('Values', String(pack.holdings.length))
    kv('Rows that are them', String(pack.rows.length))
    say()
    say(dim('  and would leave'))
    if (predicted.length === 0) {
      say('    ' + green('nothing'))
    } else {
      for (const p of predicted) say('    ' + amber(p))
      say()
      say('    ' + dim(pack.retained[0]!.ground))
    }
    await close()
    say()
    warn('Nothing has been erased. Re-run with --confirm.')
    return
  }

  await erasePerson(db, subject.id)

  // The same shape the walkthrough uses: predict, then check. A receipt that
  // only says "done" is worth nothing to the person holding it.
  const needles = [pack.subject.displayName, subject.canonicalKey.replace(/^\w+:/, '')]
    .filter((n): n is string => !!n?.trim())

  const scans = await Promise.all(needles.map((n) => scanForValue(db, n)))
  const found = [...new Set(scans.flatMap((s) => s.found))].sort()
  const scanned = scans[0]?.scanned ?? 0
  await close()

  const exact = found.join(',') === predicted.join(',')
  const receipt = {
    subject: name,
    workspace: cfg.workspaceName,
    erasedAt: new Date().toISOString(),
    erasedBy: cfg.actor,
    valuesRemoved: pack.holdings.length,
    rowsRemoved: pack.rows.length,
    columnsScanned: scanned,
    predictedToSurvive: predicted,
    actuallySurvived: found,
    predictionExact: exact,
    ground: pack.retained[0]?.ground ?? null,
  }

  const out = values.out ?? join(ROOT, 'receipts', `erasure-${Date.now()}.json`)
  await mkdir(join(out, '..'), { recursive: true })
  await writeFile(out, JSON.stringify(receipt, null, 2) + '\n')

  ok(`${name} erased`)
  kv('Scanned', `${found.length} of ${scanned} text columns still hold anything`)
  kv('Predicted to survive', predicted.join(', ') || 'nothing')
  kv('Actually survived', found.join(', ') || 'nothing')
  say()
  if (exact) {
    say('  ' + green(bold('The prediction was exact. Nothing survived that was not named.')))
  } else {
    say('  ' + amber(bold('MISMATCH — the system did not know itself.')))
    for (const f of found.filter((x) => !predicted.includes(x))) {
      say('    ' + amber(`unexpected survivor: ${f}`))
    }
  }
  say()
  kv('Receipt', cyan(out))
}

async function cmdContest(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      sheet: { type: 'string' },
      row: { type: 'string' },
      column: { type: 'string' },
      claim: { type: 'string' },
      by: { type: 'string' },
      evidence: { type: 'string' },
    },
    allowPositionals: true,
  })
  if (!values.sheet || !values.row || !values.column || !values.claim) {
    fail('usage: kalla contest --sheet <name> --row <label> --column <key> --claim "..." [--by subject|user|reviewer]')
  }

  const { db, cfg, close } = await open()
  const sheetId = await resolveSheet(db, cfg.workspaceId, values.sheet)
  const view = await readSheet(db, cfg.workspaceId, sheetId)
  const row = view?.rows.find((r) => r.label === values.row)
  const col = view?.columns.find((c) => c.key === values.column)
  if (!row || !col) fail('no such cell.')

  const [target] = await db
    .select({ id: cell.id })
    .from(cell)
    .where(and(eq(cell.rowId, row.id), eq(cell.columnId, col.id)))
  if (!target) fail('no such cell.')

  const raised = await raiseContest(db, cfg.workspaceId, target.id, {
    raisedBy: (values.by as 'user' | 'subject' | 'reviewer') ?? 'user',
    raiserRef: cfg.actor,
    claim: values.claim,
    counterEvidence: values.evidence ? [{ url: values.evidence }] : [],
  })
  await close()

  ok('contest recorded')
  kv('Contest', raised.contestId)
  say(dim('  The value has not moved. The disagreement sits beside it.'))
  say()
  say(dim(`  ${HOW} resolve ${raised.contestId} --outcome corrected --value "..."`))
}

async function cmdResolve(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      outcome: { type: 'string' },
      value: { type: 'string' },
      note: { type: 'string' },
    },
    allowPositionals: true,
  })
  const id = positionals[0]
  const outcome = values.outcome
  if (!id || !outcome) {
    fail('usage: kalla resolve <contest-id> --outcome upheld|corrected|withdrawn [--value "..."]')
  }
  if (outcome === 'corrected' && !values.value) {
    fail('--value is required to correct: a correction is a value, not a verdict.')
  }

  const { db, cfg, close } = await open()
  const decision =
    outcome === 'corrected'
      ? { resolution: 'corrected' as const, resolvedByHuman: cfg.actor, value: values.value!, note: values.note }
      : outcome === 'upheld'
        ? { resolution: 'upheld' as const, resolvedByHuman: cfg.actor, note: values.note }
        : { resolution: 'withdrawn' as const, resolvedByHuman: cfg.actor, note: values.note }

  const { cellId } = await resolveContest(db, cfg.workspaceId, id, decision)
  const all = await contestsFor(db, cellId)
  await close()

  ok(`contest ${outcome}`)
  kv('Resolved by', cfg.actor)
  kv('Still recorded', `${all.length} argument${all.length === 1 ? '' : 's'} against this cell`)
  say(dim('  The claim is kept. Resolution does not erase the disagreement.'))
}

async function cmdSweep(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { confirm: { type: 'boolean' } },
    allowPositionals: true,
  })

  const { db, cfg, close } = await open()

  if (!values.confirm) {
    const due = await expiredCells(db)
    await close()
    heading(`${due.length} values are past their retention`)
    say(dim('  Sweeping deletes them. Not archives, not marks — deletes.'))
    say()
    warn('Nothing removed. Re-run with --confirm.')
    return
  }

  const result = await sweepExpired(db, cfg.workspaceId)
  await close()

  ok('swept')
  kv('Values deleted', String(result.cellsDeleted))
  kv('People with nothing left', String(result.peopleDeleted))
  say(dim('  Logged in expiry_log: identifiers and timestamps, no text.'))
}

/* ------------------------------------------------------------------- main */

const USAGE = `
${bold('kalla')} — make a spreadsheet you already have accountable

${dim(`  run as:  ${HOW} <command>`)}

  ${bold('init')}      --actor <you> [--name ...] [--region ...] [--retention <days>]
  ${bold('new')}       <template> [--name ...]        ${dim('templates: ' + TEMPLATES.map((t) => t.key).join(', '))}
  ${bold('import')}    <file.csv> --sheet <name> [--purpose ...] [--plan <plan.json>]
  ${bold('show')}      --sheet <name> [--row <label> --column <key>]
  ${bold('set')}       --sheet <name> --row <label> --column <key> --value <text>
  ${bold('subject')}   <name or email>
  ${bold('erase')}     <name or email> [--confirm] [--out <file>]
  ${bold('contest')}   --sheet <name> --row <label> --column <key> --claim "..."
  ${bold('resolve')}   <contest-id> --outcome upheld|corrected|withdrawn [--value ...]
  ${bold('sweep')}     [--confirm]

${dim('State lives in .kalla/ and nothing leaves this machine.')}
`

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)

  switch (command) {
    case 'init': return cmdInit(rest)
    case 'new': return cmdNew(rest)
    case 'import': return cmdImport(rest)
    case 'show': return cmdShow(rest)
    case 'set': return cmdSet(rest)
    case 'subject': return cmdSubject(rest)
    case 'erase': return cmdErase(rest)
    case 'contest': return cmdContest(rest)
    case 'resolve': return cmdResolve(rest)
    case 'sweep': return cmdSweep(rest)
    default:
      say(USAGE)
      if (command && command !== '--help' && command !== '-h') process.exit(1)
  }
}

/**
 * Drizzle wraps a driver error, so what Postgres actually said is on `cause`.
 * A CLI whose point is that the database refuses things should print what the
 * database said, not the query it said it about.
 */
function deepest(err: unknown): string {
  let message = String((err as Error)?.message ?? err)
  let current: unknown = err
  while (current instanceof Error && (current as { cause?: unknown }).cause) {
    current = (current as { cause?: unknown }).cause
    if (current instanceof Error && current.message) message = current.message
  }
  return message
}

main().catch((err) => {
  console.error('')
  console.error(red('x ') + deepest(err))
  process.exit(1)
})
