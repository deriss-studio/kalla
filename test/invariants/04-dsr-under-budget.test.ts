/**
 * INVARIANT 4 — "Everything we hold about this person" returns fast.
 *
 * This is the demo that wins the room, so it has a budget rather than a hope.
 * If it degrades, the architecture is failing and no amount of interface work
 * will rescue it.
 *
 * NOTE ON SCALE: CLAUDE.md specifies 100k cells across 200 sheets. That figure
 * is for real Postgres. These tests run on PGlite (Postgres compiled to WASM,
 * in process) which is roughly an order of magnitude slower, so CI uses a
 * scaled proxy and the full-scale run belongs in a nightly job against a real
 * instance. Do not "fix" a slow full-scale run by lowering the CI numbers.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { sql } from 'drizzle-orm'
import { fixture, type Fixture } from '../harness.js'
import { subjectAccessPack } from '../../src/lib/dsr.js'
import { person } from '../../src/db/schema.js'

let f: Fixture
afterEach(async () => f?.close())

const SHEETS = 20
const ROWS_PER_SHEET = 100
const SUBJECT_APPEARANCES = 60
const BUDGET_MS = 2_000

describe('invariant: subject access returns within budget', () => {
  it(`finds a subject across ${SHEETS} sheets in under ${BUDGET_MS}ms`, async () => {
    f = await fixture({ columnName: 'Founder', dataClass: 'personal' })

    const [subject] = await f.db
      .insert(person)
      .values({
        workspaceId: f.workspaceId,
        canonicalKey: 'needle@example.com',
        displayName: 'The Needle',
      })
      .returning({ id: person.id })

    // Bulk seed. Provenance is written alongside every value, and marked
    // synthetic — fixtures never get to skip the invariant, only to label
    // themselves honestly.
    await f.db.execute(sql`
      WITH new_sheets AS (
        INSERT INTO sheet (workspace_id, name, purpose, declared_use, ai_act_class)
        SELECT ${f.workspaceId}::uuid, 'seed sheet ' || g, 'load fixture',
               'market_mapping', 'transparency_only'
        FROM generate_series(1, ${SHEETS}) g
        RETURNING id
      ),
      new_columns AS (
        INSERT INTO "column" (sheet_id, key, name, prompt, data_class)
        SELECT id, 'founder', 'Founder', 'Who founded it?', 'personal'
        FROM new_sheets
        RETURNING id, sheet_id
      ),
      new_rows AS (
        INSERT INTO row_entity (sheet_id, label, kind)
        SELECT c.sheet_id, 'org ' || g, 'organisation'
        FROM new_columns c, generate_series(1, ${ROWS_PER_SHEET}) g
        RETURNING id, sheet_id
      ),
      new_cells AS (
        INSERT INTO cell (row_id, column_id, value, state, subject_id, retention_expires_at)
        SELECT r.id, c.id,
               'Person ' || row_number() OVER (),
               'filled',
               CASE WHEN row_number() OVER () % ${Math.floor(
                 (SHEETS * ROWS_PER_SHEET) / SUBJECT_APPEARANCES,
               )} = 0 THEN ${subject!.id}::uuid ELSE NULL END,
               now() + interval '180 days'
        FROM new_rows r JOIN new_columns c ON c.sheet_id = r.sheet_id
        RETURNING id
      ),
      new_provenance AS (
        INSERT INTO provenance
          (cell_id, source_url, source_domain, retrieved_at, crawler_id,
           robots_state, ai_txt_state, synthetic)
        SELECT id, 'https://example.com/seed', 'example.com', now(), 'seed',
               'allowed', 'absent', true
        FROM new_cells
        RETURNING cell_id
      )
      INSERT INTO authorship (cell_id, origin, actor_ref)
      SELECT cell_id, 'machine', 'seed' FROM new_provenance
    `)

    const started = performance.now()
    const pack = await subjectAccessPack(f.db, subject!.id)
    const elapsed = performance.now() - started

    expect(pack.holdings.length).toBeGreaterThan(0)
    expect(pack.holdings[0]!.sources.length).toBeGreaterThan(0)
    expect(pack.holdings[0]!.sheetPurpose).toBeTruthy()
    expect(
      elapsed,
      `subject access took ${elapsed.toFixed(0)}ms against a ${
        SHEETS * ROWS_PER_SHEET
      }-cell fixture`,
    ).toBeLessThan(BUDGET_MS)
  })
})
