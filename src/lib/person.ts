/**
 * Commitment 2: personal data is an entity, never a string.
 *
 * Three responsibilities live here.
 *
 *   assess         — the two questions below: does this cell need
 *                    personal-data handling, and does anything in it identify
 *                    a specific human?
 *   resolveSubject — the one place a value becomes a person, for every write
 *                    path there is.
 *   erasePerson    — and the one place they stop being one.
 *
 * The same human across forty sheets is ONE row here with forty references.
 */

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { cell, person, rowEntity } from '../db/schema.js'
import { SUBJECT_REACH, redactableColumns } from '../db/value-bearing.js'

/**
 * Two questions, deliberately separate.
 *
 *   CONTEXT — does this cell need personal-data handling at all? Retention,
 *   special-category scanning, disclosure. Answered by the column's data class
 *   and the row's kind. Context never mints an entity on its own: a column
 *   declared `personal` full of city names must not manufacture a person per
 *   city, because every junk entity degrades the very queries the person table
 *   exists to make fast.
 *
 *   IDENTIFICATION — is there something here that identifies a specific human,
 *   stably enough to resolve them across sheets? Answered by the value alone.
 *   An email, a profile URL, a phone number, a name.
 *
 * A hint from the column's NAME lowers the identification threshold rather
 * than sitting inert: "J Smith" in a column called Founder identifies someone;
 * the same string in a column called Notes does not. A row whose kind is
 * `person` lowers it the same way — declaring the row to BE an individual is a
 * claim about the label, not merely handling context. It still mints nothing
 * on its own: a person-kind row labelled "Candidate 4" identifies nobody.
 *
 * Where the value looks identifying but yields no stable key, neither answer
 * is guessed. The doubt is recorded on the cell for a human.
 */

export type IdentityKind = 'email' | 'profile' | 'phone' | 'name'

export interface Identity {
  kind: IdentityKind
  /**
   * The key resolution uses. Derived from an identifier, never from raw text —
   * keying on the raw value split "Vera Exempel Testsson" from "Vera Exempel
   * Testsson, CEO" into two people, which makes an Article 15 answer look
   * complete while missing half of what is held.
   */
  key: string
  displayName: string | null
}

export type UncertaintyReason = 'ambiguous_identity' | 'context_without_identity'

export interface Assessment {
  /** Retention, special-category scanning, disclosure. */
  personalHandling: boolean
  /** Non-null when a specific human can be resolved from this value. */
  identity: Identity | null
  /** Non-null when neither answer could be settled, and a human should look. */
  uncertainty: UncertaintyReason | null
}

export interface DataContext {
  columnName?: string
  columnDataClass?: string
  rowKind?: string
}

const EMAIL = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/
const PROFILE =
  /(?:https?:\/\/)?(?:[\w-]+\.)?(linkedin\.com\/in|x\.com|twitter\.com|github\.com)\/([A-Za-z0-9._-]+)/i
/** At least seven digits, optionally internationalised. */
const PHONE = /\+?\d[\d\s().-]{5,}\d/
/** Two or more capitalised words: "Vera Exempel Testsson". */
const NAME_STRICT =
  /\b[A-ZÅÄÖÉ][a-zåäöé]+(?:\s+[A-ZÅÄÖÉ][a-zåäöé'\u2019-]+)+\b/
/** An initial and a surname: "J Smith", "J. Smith". Only where a hint applies. */
const NAME_WEAK = /\b[A-ZÅÄÖÉ]\.?\s+[A-ZÅÄÖÉ][a-zåäöé'\u2019-]{2,}\b/

/** Column names that make a person the expected content of the column. */
const PERSON_COLUMN_HINT =
  /\b(founder|ceo|cto|chair|contact|owner|manager|director|employee|candidate|person|name|email|phone|linkedin)\b/i

/** Does the column or row say this cell needs personal-data handling? */
export function contextIsPersonal(ctx: DataContext): boolean {
  return (
    ctx.columnDataClass === 'personal' ||
    ctx.columnDataClass === 'special' ||
    ctx.rowKind === 'person'
  )
}

/** Does the surrounding structure lower the bar for identifying someone? */
export function identificationHint(ctx: DataContext): boolean {
  return (
    (ctx.columnName ? PERSON_COLUMN_HINT.test(ctx.columnName) : false) ||
    ctx.rowKind === 'person'
  )
}

function digits(value: string): string {
  return value.replace(/\D/g, '')
}

/**
 * What, if anything, in this value identifies a specific human.
 *
 * Emails and profile URLs identify on their own. Names and phone numbers do
 * not: "New York" has the shape of a name and a switchboard number belongs to
 * a company, so both need a hint from the surrounding structure before they
 * are treated as identifying.
 */
export function identify(value: string, hinted: boolean): Identity | null {
  const name = value.match(NAME_STRICT)?.[0] ?? null

  const email = value.match(EMAIL)?.[0]
  if (email) {
    return { kind: 'email', key: `email:${email.toLowerCase()}`, displayName: name }
  }

  const profile = value.match(PROFILE)
  if (profile) {
    const platform = profile[1]!.toLowerCase()
    const handle = profile[2]!.toLowerCase()
    return { kind: 'profile', key: `profile:${platform}/${handle}`, displayName: name }
  }

  if (!hinted) return null

  if (name) {
    return {
      kind: 'name',
      key: `name:${name.toLowerCase().replace(/\s+/g, ' ').trim()}`,
      displayName: name,
    }
  }

  const weak = value.match(NAME_WEAK)?.[0]
  if (weak) {
    const normalised = weak.replace(/\./g, '').toLowerCase().replace(/\s+/g, ' ').trim()
    return { kind: 'name', key: `name:${normalised}`, displayName: weak }
  }

  const phone = value.match(PHONE)?.[0]
  if (phone && digits(phone).length >= 7) {
    return { kind: 'phone', key: `phone:${digits(phone)}`, displayName: name }
  }

  return null
}

/** Both questions, answered together. */
export function assess(value: string | null, ctx: DataContext = {}): Assessment {
  const handling = contextIsPersonal(ctx)
  if (!value?.trim()) {
    return { personalHandling: handling, identity: null, uncertainty: null }
  }

  const hinted = identificationHint(ctx)
  const identity = identify(value, hinted)
  if (identity) {
    return { personalHandling: true, identity, uncertainty: null }
  }

  // Nothing resolved. Say so out loud where there was reason to expect someone,
  // rather than choosing a side.
  const looksIdentifying =
    NAME_STRICT.test(value) || value.includes('@') || PROFILE.test(value)

  let uncertainty: UncertaintyReason | null = null
  if (looksIdentifying) {
    uncertainty = 'ambiguous_identity'
  } else if (handling || hinted) {
    uncertainty = 'context_without_identity'
  }

  return {
    personalHandling: handling || uncertainty !== null,
    identity: null,
    uncertainty,
  }
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
 * Returns the person's id when one could be identified, and the reason when
 * one could not be settled either way. Callers record the second on the cell.
 */
export async function resolveSubject(
  db: Db,
  workspaceId: string,
  input: DataContext & { value: string | null },
  retentionExpiresAt: Date | null,
): Promise<{ subjectId: string | null; uncertainty: UncertaintyReason | null }> {
  const { value, ...ctx } = input
  const assessment = assess(value, ctx)

  if (!assessment.identity) {
    return { subjectId: null, uncertainty: assessment.uncertainty }
  }

  const subjectId = await resolvePerson(
    db,
    workspaceId,
    assessment.identity,
    retentionExpiresAt,
  )
  return { subjectId, uncertainty: null }
}

export async function resolvePerson(
  db: Db,
  workspaceId: string,
  identity: Identity,
  retentionExpiresAt: Date | null,
): Promise<string> {
  const existing = await db
    .select({ id: person.id })
    .from(person)
    .where(
      and(
        eq(person.workspaceId, workspaceId),
        eq(person.canonicalKey, identity.key),
      ),
    )
    .limit(1)

  if (existing[0]) return existing[0].id

  const [created] = await db
    .insert(person)
    .values({
      workspaceId,
      canonicalKey: identity.key,
      displayName: identity.displayName,
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
