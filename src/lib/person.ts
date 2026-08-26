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
import { cell, person, provenance } from '../db/schema.js'

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
 * Every reference is cleared, the provenance quotes that could reconstruct the
 * value are redacted, and the person row is tombstoned rather than deleted so
 * that we can prove the erasure happened. The tombstone keeps no identifying
 * content.
 */
export async function erasePerson(db: Db, personId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.erasure_in_progress', 'on', true)`)

    const cells = await tx
      .select({ id: cell.id })
      .from(cell)
      .where(eq(cell.subjectId, personId))

    for (const c of cells) {
      await tx
        .update(cell)
        .set({
          value: null,
          state: 'expired',
          refusalReason: 'erased_on_request',
          subjectId: null,
          updatedAt: new Date(),
        })
        .where(eq(cell.id, c.id))

      await tx
        .update(provenance)
        .set({ quote: null, sourceUrl: 'redacted:erasure' })
        .where(eq(provenance.cellId, c.id))
    }

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
