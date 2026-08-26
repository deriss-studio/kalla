/**
 * Data subject requests, in one query.
 *
 * "Everything we hold about this person, across every sheet, with sources."
 * Under two seconds, or the architecture has failed and no amount of UI will
 * rescue it. This is the demo that wins the room — nobody else in the category
 * can run it, because nobody else modelled the person.
 */

import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { cell, column, dsr, person, provenance, rowEntity, sheet } from '../db/schema.js'

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
    .innerJoin(sheet, eq(sheet.id, column.sheetId))
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
    })),
    generatedAt: new Date(),
  }
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
