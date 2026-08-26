/**
 * Importing a spreadsheet you already have.
 *
 * This is the point of the whole substrate for anyone without a runtime. A CSV
 * of leads is a file full of personal data with no provenance, no retention,
 * no way to answer an access request and no way to prove an erasure. Put it
 * through here and every value arrives with an origin, every person becomes an
 * entity, and the clock starts.
 *
 * It goes through writeCellValue like everything else. There is no bulk path
 * that skips the checks: the same import that would be fastest as a COPY is the
 * one carrying the data most likely to be someone's name, so it takes the same
 * route an agent's answer takes. Special categories are refused, personal data
 * resolves to a person, retention is set once, provenance is written.
 *
 * What it will not do is guess. A value that looks identifying and cannot be
 * resolved is reported as needing review rather than quietly made into a person
 * or quietly ignored.
 */

import type { Db } from '../db/client.js'
import { importReceipt } from './collection.js'
import { parseCsv } from './csv.js'
import { createColumn, type DataClass } from './sheets.js'
import { createRow, writeCellValue } from './write.js'
import type { UncertaintyReason } from './person.js'

export interface ColumnMapping {
  /** The header in the file. */
  header: string
  /** The column key in the sheet. Defaults to a slug of the header. */
  key?: string
  dataClass: DataClass
  retentionDays?: number | null
  /** Skip this column entirely: some exports carry fields nobody wants held. */
  skip?: boolean
}

export interface ImportPlan {
  /** The header whose value labels each row. */
  labelColumn: string
  /** Whether each row is an organisation or a person. */
  rowKind?: 'organisation' | 'person'
  columns: ColumnMapping[]
}

export interface ImportReport {
  file: string
  rowsRead: number
  rowsWritten: number
  cellsWritten: number
  /** Values refused outright, by Article 9 category. Never the value itself. */
  refused: { rowLabel: string; columnKey: string; category: string }[]
  /** Where detection could settle neither way. A human decides these. */
  uncertain: { rowLabel: string; columnKey: string; reason: UncertaintyReason }[]
  /** People the import resolved, deduplicated across the file. */
  peopleResolved: number
  /** Columns in the file that the plan chose not to hold. */
  skipped: string[]
}

export function slug(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

/**
 * Suggest a plan for a file, to be corrected by a person before it runs.
 *
 * The suggestion is deliberately timid about `personal`: it proposes it only
 * where the header says so outright. Guessing high would classify a column of
 * cities as personal and manufacture a person per city; guessing low is worse.
 * Neither is a decision the file gets to make on its own, which is why this
 * returns a proposal rather than importing anything.
 */
export function suggestPlan(headers: string[]): ImportPlan {
  const PERSONAL =
    /\b(name|first|last|surname|email|e-mail|phone|mobile|tel|linkedin|contact|owner|founder|ceo|manager|director|candidate|person)\b/i
  const SPECIAL = /\b(health|medical|religion|union|ethnic|race|sexual|criminal|conviction|biometric)\b/i

  return {
    labelColumn: headers[0] ?? '',
    rowKind: 'organisation',
    columns: headers.map((header) => ({
      header,
      key: slug(header),
      dataClass: SPECIAL.test(header)
        ? 'special'
        : PERSONAL.test(header)
          ? 'personal'
          : 'business',
    })),
  }
}

export async function importCsv(
  db: Db,
  workspaceId: string,
  sheetId: string,
  file: { path: string; contents: string },
  plan: ImportPlan,
  importedBy: string,
): Promise<ImportReport> {
  const table = parseCsv(file.contents)

  if (!table.headers.includes(plan.labelColumn)) {
    throw new Error(
      `the label column "${plan.labelColumn}" is not in the file: ${table.headers.join(', ')}`,
    )
  }

  const held = plan.columns.filter((c) => !c.skip)
  const unknown = held.filter((c) => !table.headers.includes(c.header))
  if (unknown.length > 0) {
    throw new Error(
      `these columns are not in the file: ${unknown.map((c) => c.header).join(', ')}`,
    )
  }

  // The sheet's columns, created once, before any value is written.
  const columnIds = new Map<string, string>()
  for (const [position, mapping] of held.entries()) {
    const key = mapping.key ?? slug(mapping.header)
    const { columnId } = await createColumn(db, workspaceId, sheetId, {
      key,
      name: mapping.header,
      prompt: `Imported from ${file.path}, column "${mapping.header}".`,
      dataClass: mapping.dataClass,
      retentionDays: mapping.retentionDays ?? null,
      position,
    })
    columnIds.set(key, columnId)
  }

  const report: ImportReport = {
    file: file.path,
    rowsRead: table.rows.length,
    rowsWritten: 0,
    cellsWritten: 0,
    refused: [],
    uncertain: [],
    peopleResolved: 0,
    skipped: plan.columns.filter((c) => c.skip).map((c) => c.header),
  }

  const labelAt = table.headers.indexOf(plan.labelColumn)
  const people = new Set<string>()

  for (const [position, values] of table.rows.entries()) {
    const rowLabel = (values[labelAt] ?? '').trim()
    if (!rowLabel) continue

    const { rowId, subjectId: rowSubject } = await createRow(
      db,
      workspaceId,
      sheetId,
      { label: rowLabel, kind: plan.rowKind ?? 'organisation', position },
    )
    if (rowSubject) people.add(rowSubject)
    report.rowsWritten += 1

    for (const mapping of held) {
      const key = mapping.key ?? slug(mapping.header)
      const value = (values[table.headers.indexOf(mapping.header)] ?? '').trim()
      if (!value) continue

      // A file is not a fetch. The receipt says so rather than asserting a
      // collection state nobody obtained.
      const outcome = await writeCellValue(
        { db, workspaceId, rowId, columnId: columnIds.get(key)! },
        {
          value,
          state: 'filled',
          sources: [{ receipt: importReceipt(file.path, importedBy) }],
        },
      )

      report.cellsWritten += 1
      if (outcome.refusedCategory) {
        report.refused.push({ rowLabel, columnKey: key, category: outcome.refusedCategory })
      }
      if (outcome.uncertainty) {
        report.uncertain.push({ rowLabel, columnKey: key, reason: outcome.uncertainty })
      }
      if (outcome.subjectId) people.add(outcome.subjectId)
    }
  }

  report.peopleResolved = people.size
  return report
}
