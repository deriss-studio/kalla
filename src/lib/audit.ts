/**
 * Proving a negative.
 *
 * "We erased them" is a claim. This is the only thing that makes it evidence:
 * a scan of every text-bearing column in the database, derived from the
 * catalogue rather than from a list of the tables someone remembered, asking
 * whether a value is anywhere at all.
 *
 * It lived in the tests, written out three times — twice in the invariants and
 * once in the walkthrough — which is the shape of something that belongs in
 * the library. The artifact that proves an erasure is a compliance artifact,
 * and commitment 3 says those are derived from the substrate rather than
 * assembled by hand. A controller answering a supervisory authority should be
 * able to call this, not reimplement it.
 *
 * It is deliberately unclever. It reads the catalogue, then counts matches in
 * every column it names, which is O(columns) queries and a sequential scan
 * apiece. That is fine for what it is — an audit run against a specific
 * question, not a hot path — and being unclever is what lets it stay true when
 * a table is added by someone who has never read this file.
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'

export interface ScanResult {
  /** How wide the search was. A negative result means nothing without it. */
  scanned: number
  /** Every `table.column` still holding the value, in catalogue order. */
  found: string[]
}

/** The column types that can hold a value at all. */
const TEXT_TYPES = ['text', 'character varying', 'jsonb', 'json']

/**
 * Every place in the database where `needle` still appears.
 *
 * Case-insensitive and substring-based on purpose: a name inside a sentence in
 * a quote is the same disclosure as a name in a cell, and an erasure that
 * missed the sentence has missed the person.
 */
export async function scanForValue(db: Db, needle: string): Promise<ScanResult> {
  if (!needle.trim()) {
    throw new Error('refusing to scan for an empty value: it would match everything')
  }

  const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN (${sql.join(
         TEXT_TYPES.map((t) => sql`${t}`),
         sql`, `,
       )})
     ORDER BY table_name, column_name
  `)

  const found: string[] = []
  for (const c of columns.rows) {
    const hit = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n
            FROM ${sql.identifier(c.table_name)}
           WHERE ${sql.identifier(c.column_name)}::text ILIKE ${'%' + needle + '%'}`,
    )
    if ((hit.rows[0]?.n ?? 0) > 0) found.push(`${c.table_name}.${c.column_name}`)
  }

  return { scanned: columns.rows.length, found }
}

/**
 * The same question asked of several strings at once — a person's name and the
 * identifier their entity was keyed on, say, since either alone can be the
 * thing that survived.
 */
export async function scanForAny(
  db: Db,
  needles: string[],
): Promise<ScanResult & { byNeedle: Record<string, string[]> }> {
  const byNeedle: Record<string, string[]> = {}
  const found = new Set<string>()
  let scanned = 0

  for (const needle of needles) {
    const result = await scanForValue(db, needle)
    scanned = result.scanned
    byNeedle[needle] = result.found
    for (const hit of result.found) found.add(hit)
  }

  return { scanned, found: [...found].sort(), byNeedle }
}
