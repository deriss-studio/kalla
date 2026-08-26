/**
 * Commitment 2: personal data is an entity, never a string.
 *
 * Two responsibilities live here.
 *
 *   detectPersonalData — is this value about an identifiable individual?
 *                        When uncertain, say yes. Over-flagging is cheap;
 *                        under-flagging is the failure mode that ends the
 *                        company.
 *
 *   resolvePerson      — the same human across forty sheets is ONE row.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { cell, person, rowEntity } from '../db/schema.js'
import { SUBJECT_REACH, redactableColumns } from '../db/value-bearing.js'

export type PersonalDataCheck =
  | { personal: false }
  | { personal: true; canonicalKey: string; displayName: string | null }

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/
const PHONE = /(\+\d{1,3}[\s-]?)?(\(?\d{2,4}\)?[\s-]?){2,4}\d{2,4}/
const PROFILE = /linkedin\.com\/in\/|x\.com\/|twitter\.com\/|github\.com\//i
/** Two or more capitalised words, the crude shape of a personal name. */
const NAME_SHAPE = /\b[A-ZÅÄÖÉ][a-zåäöé]+(?:\s+[A-ZÅÄÖÉ][a-zåäöé'-]+)+\b/

/** Columns whose data class already tells us, without looking at the value. */
const PERSON_COLUMN_HINT =
  /\b(founder|ceo|cto|chair|contact|owner|manager|director|employee|candidate|person|name|email|phone|linkedin)\b/i

export function detectPersonalData(input: {
  value: string | null
  columnName?: string
  columnDataClass?: string
  rowKind?: string
}): PersonalDataCheck {
  const { value, columnName, columnDataClass, rowKind } = input
  if (!value?.trim()) return { personal: false }

  const declared =
    columnDataClass === 'personal' ||
    columnDataClass === 'special' ||
    rowKind === 'person'

  const hinted = columnName ? PERSON_COLUMN_HINT.test(columnName) : false
  const looksPersonal =
    EMAIL.test(value) ||
    PROFILE.test(value) ||
    NAME_SHAPE.test(value) ||
    (hinted && PHONE.test(value))

  if (!declared && !hinted && !looksPersonal) return { personal: false }
  if (!declared && !looksPersonal) return { personal: false }

  const email = value.match(EMAIL)?.[0]?.toLowerCase()
  const name = value.match(NAME_SHAPE)?.[0]
  const profile = value.match(PROFILE) ? value.trim().toLowerCase() : undefined

  // Prefer a stable identifier for resolution; fall back to the name.
  const canonicalKey = (email ?? profile ?? name ?? value).trim().toLowerCase()

  return { personal: true, canonicalKey, displayName: name ?? null }
}

/**
 * The one place a value becomes a person.
 *
 * Every write path that can introduce an individual goes through here: agent
 * writes, human corrections, accepted proposals and row creation. It used to
 * live inside writeCellValue, which meant a name typed by a human stayed a
 * string — commitment 2 held for the agent and quietly failed for everyone
 * else.
 *
 * Returns the person's id, or null when the value is not about an individual.
 */
export async function resolveSubject(
  db: Db,
  workspaceId: string,
  input: {
    value: string | null
    columnName?: string
    columnDataClass?: string
    rowKind?: string
  },
  retentionExpiresAt: Date | null,
): Promise<string | null> {
  const check = detectPersonalData(input)
  if (!check.personal) return null
  return resolvePerson(db, workspaceId, check, retentionExpiresAt)
}

export async function resolvePerson(
  db: Db,
  workspaceId: string,
  check: Extract<PersonalDataCheck, { personal: true }>,
  retentionExpiresAt: Date | null,
): Promise<string> {
  const existing = await db
    .select({ id: person.id })
    .from(person)
    .where(
      and(
        eq(person.workspaceId, workspaceId),
        eq(person.canonicalKey, check.canonicalKey),
      ),
    )
    .limit(1)

  if (existing[0]) return existing[0].id

  const [created] = await db
    .insert(person)
    .values({
      workspaceId,
      canonicalKey: check.canonicalKey,
      displayName: check.displayName,
      retentionExpiresAt,
    })
    .returning({ id: person.id })

  return created!.id
}

/**
 * Erasure is total, and it is logged.
 *
 * What counts as the subject's data is declared in src/db/value-bearing.ts,
 * not decided here. This function walks that declaration, so a column added to
 * the registry is erased without anyone editing this code — and a column added
 * to the schema and left out of the registry fails invariant 3 rather than
 * quietly surviving erasure.
 *
 * The person row is tombstoned rather than deleted, because the proof that an
 * erasure happened has to outlive the data. The tombstone keeps no identifying
 * content.
 */
export async function erasePerson(db: Db, personId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.erasure_in_progress', 'on', true)`)

    // Resolved before anything is cleared: once cell.subject_id is null, the
    // rows hanging off those cells can no longer be found.
    const cells = await tx
      .select({ id: cell.id })
      .from(cell)
      .where(eq(cell.subjectId, personId))
    const cellIds = cells.map((c) => c.id)

    for (const [table, columns] of redactableColumns()) {
      const scope = SUBJECT_REACH[table]
      if (scope === 'by_cell_id' && cellIds.length === 0) continue

      const where =
        scope === 'by_subject_id'
          ? sql`subject_id = ${personId}::uuid`
          : sql`cell_id IN (${sql.join(
              cellIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`

      const setters = columns.map(
        (c) => sql`${sql.identifier(c.column)} = ${c.redactTo ?? null}`,
      )

      await tx.execute(
        sql`UPDATE ${sql.identifier(table)} SET ${sql.join(setters, sql`, `)} WHERE ${where}`,
      )
    }

    // The state change is not a redaction, so it stays here rather than in the
    // registry: the cell still exists, and says why it is empty.
    if (cellIds.length > 0) {
      await tx
        .update(cell)
        .set({ state: 'expired', subjectId: null, updatedAt: new Date() })
        .where(eq(cell.subjectId, personId))
    }

    // Rows that were this person. Their label is redacted by the loop above;
    // the reference goes here, after it, or the loop would not have found them.
    await tx
      .update(rowEntity)
      .set({ subjectId: null })
      .where(eq(rowEntity.subjectId, personId))

    await tx
      .update(person)
      .set({
        erasureState: 'erased',
        erasedAt: new Date(),
        displayName: null,
        identifiers: {},
        canonicalKey: `erased:${personId}`,
      })
      .where(eq(person.id, personId))
  })
}
