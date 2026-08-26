/**
 * Data subject requests, derived rather than assembled.
 *
 * "Everything we hold about this person, across every sheet, with sources."
 * Under two seconds, or the architecture has failed and no amount of UI will
 * rescue it. This is the demo that wins the room — nobody else in the category
 * can run it, because nobody else modelled the person.
 *
 * What counts as a holding is declared in src/db/value-bearing.ts, not decided
 * here. Erasure walks that registry; so does this. A column classified
 * `retained` survives an erasure request, which makes disclosing it more
 * important rather than less: the subject is entitled to know what we kept and
 * on what ground. Adding a retained column therefore adds it to this pack
 * without anyone editing this file.
 */

import { eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import {
  cell,
  column,
  contest,
  dsr,
  person,
  proposal,
  provenance,
  rowEntity,
  sheet,
} from '../db/schema.js'
import { RETAINED_REACH, retainedColumns } from '../db/value-bearing.js'

export interface SubjectAccessPack {
  subject: {
    id: string
    displayName: string | null
    lawfulBasis: string
    firstSeenAt: Date
    retentionExpiresAt: Date | null
    erasureState: string
  }
  holdings: {
    sheetName: string
    sheetPurpose: string
    columnName: string
    rowLabel: string
    value: string | null
    state: string
    retentionExpiresAt: Date | null
    sources: { url: string; retrievedAt: Date; crawlerId: string }[]
    /** Values an agent has offered for this cell, awaiting a human decision. */
    proposals: { value: string; state: string; proposedAt: Date }[]
    /** Disagreements recorded beside this value, including the subject's own. */
    contests: {
      claim: string
      raisedBy: string
      raisedAt: Date
      resolution: string | null
    }[]
  }[]
  /** Rows that ARE this person, rather than cells about them. */
  rows: { sheetName: string; label: string; kind: string }[]
  /**
   * Holdings that would survive an erasure request, and why. Derived from the
   * registry, so this cannot fall behind what erasure actually keeps.
   */
  retained: {
    sheetName: string
    table: string
    column: string
    value: string
    ground: string
  }[]
  generatedAt: Date
}

export async function subjectAccessPack(
  db: Db,
  personId: string,
): Promise<SubjectAccessPack> {
  const [subject] = await db
    .select({
      id: person.id,
      displayName: person.displayName,
      lawfulBasis: person.lawfulBasis,
      firstSeenAt: person.firstSeenAt,
      retentionExpiresAt: person.retentionExpiresAt,
      erasureState: person.erasureState,
    })
    .from(person)
    .where(eq(person.id, personId))
    .limit(1)

  if (!subject) throw new Error(`unknown subject ${personId}`)

  const rows = await db
    .select({
      cellId: cell.id,
      value: cell.value,
      state: cell.state,
      retentionExpiresAt: cell.retentionExpiresAt,
      columnName: column.name,
      rowLabel: rowEntity.label,
      sheetId: cell.sheetId,
      sheetName: sheet.name,
      sheetPurpose: sheet.purpose,
      sources: sql<
        { url: string; retrievedAt: string; crawlerId: string }[]
      >`coalesce(json_agg(json_build_object(
            'url', ${provenance.sourceUrl},
            'retrievedAt', ${provenance.retrievedAt},
            'crawlerId', ${provenance.crawlerId}
          )) filter (where ${provenance.id} is not null), '[]')`,
    })
    .from(cell)
    .innerJoin(column, eq(column.id, cell.columnId))
    .innerJoin(rowEntity, eq(rowEntity.id, cell.rowId))
    .innerJoin(sheet, eq(sheet.id, cell.sheetId))
    .leftJoin(provenance, eq(provenance.cellId, cell.id))
    .where(eq(cell.subjectId, personId))
    .groupBy(
      cell.id,
      cell.value,
      cell.state,
      cell.retentionExpiresAt,
      column.name,
      rowEntity.label,
      sheet.name,
      sheet.purpose,
    )

  const cellIds = rows.map((r) => r.cellId)

  // Rows that ARE this person. Without these, a candidate whose name is the
  // row label and who has no cell about them would come back an empty pack.
  const subjectRows = await db
    .select({ sheetId: rowEntity.sheetId, sheetName: sheet.name, label: rowEntity.label, kind: rowEntity.kind })
    .from(rowEntity)
    .innerJoin(sheet, eq(sheet.id, rowEntity.sheetId))
    .where(eq(rowEntity.subjectId, personId))

  const proposals = cellIds.length
    ? await db
        .select({
          cellId: proposal.cellId,
          value: proposal.value,
          state: proposal.state,
          proposedAt: proposal.proposedAt,
        })
        .from(proposal)
        .where(inArray(proposal.cellId, cellIds))
    : []

  const contests = cellIds.length
    ? await db
        .select({
          cellId: contest.cellId,
          claim: contest.claim,
          raisedBy: contest.raisedBy,
          raisedAt: contest.raisedAt,
          resolution: contest.resolution,
        })
        .from(contest)
        .where(inArray(contest.cellId, cellIds))
    : []

  const retained = await retainedHoldings(db, [
    ...new Set([...rows.map((r) => r.sheetId), ...subjectRows.map((r) => r.sheetId)]),
  ])

  return {
    subject,
    holdings: rows.map((r) => ({
      sheetName: r.sheetName,
      sheetPurpose: r.sheetPurpose,
      columnName: r.columnName,
      rowLabel: r.rowLabel,
      value: r.value,
      state: r.state,
      retentionExpiresAt: r.retentionExpiresAt,
      sources: (r.sources ?? []).map((s) => ({
        url: s.url,
        retrievedAt: new Date(s.retrievedAt),
        crawlerId: s.crawlerId,
      })),
      proposals: proposals
        .filter((p) => p.cellId === r.cellId)
        .map((p) => ({ value: p.value, state: p.state, proposedAt: p.proposedAt })),
      contests: contests
        .filter((c) => c.cellId === r.cellId)
        .map((c) => ({
          claim: c.claim,
          raisedBy: c.raisedBy,
          raisedAt: c.raisedAt,
          resolution: c.resolution,
        })),
    })),
    rows: subjectRows.map((r) => ({
      sheetName: r.sheetName,
      label: r.label,
      kind: r.kind,
    })),
    retained,
    generatedAt: new Date(),
  }
}

/**
 * Everything the registry marks `retained`, for the sheets this person appears
 * in, with the ground it is kept on. Driven entirely by the declaration: a
 * column reclassified as retained shows up here without this code changing.
 */
async function retainedHoldings(
  db: Db,
  sheetIds: string[],
): Promise<SubjectAccessPack['retained']> {
  if (sheetIds.length === 0) return []

  const out: SubjectAccessPack['retained'] = []

  for (const [table, columns] of retainedColumns()) {
    const reach = RETAINED_REACH[table]
    if (!reach) {
      throw new Error(
        `retained table ${table} has no route to a sheet: it would be kept through an erasure and never disclosed. Add it to RETAINED_REACH.`,
      )
    }

    for (const c of columns) {
      const found = await db.execute<{
        sheet_id: string
        sheet_name: string
        value: string | null
      }>(sql`
        SELECT t.${sql.identifier(reach)}::text AS sheet_id,
               s.name AS sheet_name,
               t.${sql.identifier(c.column)}::text AS value
          FROM ${sql.identifier(table)} t
          JOIN sheet s ON s.id = t.${sql.identifier(reach)}
         WHERE t.${sql.identifier(reach)} IN (${sql.join(
           sheetIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
           AND t.${sql.identifier(c.column)} IS NOT NULL
      `)

      for (const r of found.rows) {
        out.push({
          sheetName: r.sheet_name,
          table,
          column: c.column,
          value: r.value ?? '',
          ground: c.ground ?? '',
        })
      }
    }
  }

  return out
}

export async function recordRequest(
  db: Db,
  workspaceId: string,
  personId: string,
  type: 'access' | 'rectify' | 'erase' | 'object',
  pack?: unknown,
): Promise<void> {
  await db.insert(dsr).values({
    workspaceId,
    subjectId: personId,
    type,
    resolvedAt: new Date(),
    responsePack: (pack ?? null) as Record<string, unknown> | null,
  })
}
