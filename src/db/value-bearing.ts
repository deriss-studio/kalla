/**
 * Which columns can hold a data subject's information.
 *
 * Erasure used to know about `cell`, `provenance` and `person` because someone
 * remembered them. It did not reach `proposal`, so an agent's proposal over a
 * human-corrected cell kept the subject's name after they had been erased.
 * That is not a bug in `erasePerson` so much as a missing declaration: nothing
 * in the substrate said which columns bear a subject's data, so nothing could
 * check that erasure covered them all.
 *
 * This is that declaration. Every text-ish column in the schema appears here
 * exactly once, and `test/invariants/03-erasure-is-total` fails if one does
 * not — so a table added next year cannot quietly escape erasure. The
 * classification is the interesting part; the erasure code is downstream of it.
 */

/**
 * - `subject`      — can hold the subject's own data. Erasure must reach it.
 * - `unreachable`  — can hold the subject's data, and there is no path from a
 *                    person to it. A gap, named rather than hidden. This list
 *                    is pinned by the test: it may shrink, never grow.
 * - `actor`        — identifies a user of the system, not the person being
 *                    researched. Deliberately preserved: erasure has to stay
 *                    provable, and a resolution has to keep a name against it.
 * - `structural`   — schema or process metadata, holding no individual's data.
 */
export type Classification = 'subject' | 'unreachable' | 'actor' | 'structural'

export interface ColumnClass {
  table: string
  column: string
  classification: Classification
  /** For NOT NULL subject columns, which cannot simply be nulled. */
  redactTo?: string
  /** Recorded wherever the classification was a judgement rather than obvious. */
  note?: string
}

export const VALUE_BEARING: ColumnClass[] = [
  /* ---------------------------------------------------------------- cell */
  { table: 'cell', column: 'value', classification: 'subject' },
  {
    table: 'cell',
    column: 'refusal_reason',
    classification: 'subject',
    redactTo: 'erased_on_request',
    note: 'carries an agent\'s free-text notes on a not_found, which can name the subject',
  },

  /* ---------------------------------------------------------- provenance */
  { table: 'provenance', column: 'quote', classification: 'subject' },
  {
    table: 'provenance',
    column: 'source_url',
    classification: 'subject',
    redactTo: 'redacted:erasure',
    note: 'a profile URL identifies the subject on its own',
  },
  { table: 'provenance', column: 'source_domain', classification: 'structural' },
  { table: 'provenance', column: 'crawler_id', classification: 'structural' },
  { table: 'provenance', column: 'robots_state', classification: 'structural' },
  { table: 'provenance', column: 'ai_txt_state', classification: 'structural' },
  { table: 'provenance', column: 'model_id', classification: 'structural' },
  { table: 'provenance', column: 'model_region', classification: 'structural' },

  /* ------------------------------------------------------------ proposal */
  {
    table: 'proposal',
    column: 'value',
    classification: 'subject',
    redactTo: 'redacted:erasure',
  },
  { table: 'proposal', column: 'evidence', classification: 'subject' },
  {
    table: 'proposal',
    column: 'decided_by',
    classification: 'actor',
    note: 'the colleague who accepted or rejected the proposal',
  },

  /* ------------------------------------------------------------- contest */
  {
    table: 'contest',
    column: 'claim',
    classification: 'subject',
    redactTo: 'redacted:erasure',
  },
  { table: 'contest', column: 'counter_evidence', classification: 'subject' },
  { table: 'contest', column: 'prior_value', classification: 'subject' },
  { table: 'contest', column: 'note', classification: 'subject' },
  { table: 'contest', column: 'raiser_ref', classification: 'actor' },
  {
    table: 'contest',
    column: 'resolved_by_human',
    classification: 'actor',
    note: 'commitment 4 requires a name against every resolution',
  },

  /* ----------------------------------------------------------------- dsr */
  {
    table: 'dsr',
    column: 'response_pack',
    classification: 'subject',
    note: 'a stored access response is a copy of everything held about them',
  },

  /* -------------------------------------------------------------- person */
  { table: 'person', column: 'canonical_key', classification: 'subject' },
  { table: 'person', column: 'display_name', classification: 'subject' },
  { table: 'person', column: 'identifiers', classification: 'subject' },
  { table: 'person', column: 'lawful_basis', classification: 'structural' },
  {
    table: 'person',
    column: 'notice_language',
    classification: 'structural',
    note: 'a language code, kept so the tombstone can show a notice was owed',
  },

  /* ---------------------------------------------------------- row entity */
  {
    table: 'row_entity',
    column: 'label',
    classification: 'unreachable',
    note:
      'a row whose kind is "person" IS an individual, but row_entity has no ' +
      'subject_id, so erasure cannot reach it. Closing this needs the same ' +
      'treatment cells got: resolve person-kind rows to a person entity.',
  },
  { table: 'row_entity', column: 'kind', classification: 'structural' },

  /* ----------------------------------------------------------- authorship */
  {
    table: 'authorship',
    column: 'actor_ref',
    classification: 'actor',
    note: 'the colleague who edited, not the person researched',
  },

  /* --------------------------------------------------------------- sheet */
  { table: 'sheet', column: 'name', classification: 'structural' },
  {
    table: 'sheet',
    column: 'purpose',
    classification: 'structural',
    note:
      'controller-authored, not derived from research. It can name someone, ' +
      'but redacting it would destroy the legitimate interest assessment ' +
      'that depends on it. Governed as an input, not as a holding.',
  },

  /* -------------------------------------------------------------- column */
  { table: 'column', column: 'key', classification: 'structural' },
  { table: 'column', column: 'name', classification: 'structural' },
  {
    table: 'column',
    column: 'prompt',
    classification: 'structural',
    note: 'controller-authored, on the same reasoning as sheet.purpose',
  },
  { table: 'column', column: 'output_type', classification: 'structural' },
  { table: 'column', column: 'enum_values', classification: 'structural' },
  { table: 'column', column: 'model_policy', classification: 'structural' },
  { table: 'column', column: 'source_policy', classification: 'structural' },

  /* ----------------------------------------------------------- workspace */
  { table: 'workspace', column: 'name', classification: 'structural' },
  { table: 'workspace', column: 'region_pin', classification: 'structural' },
  { table: 'workspace', column: 'dpo_contact', classification: 'actor' },

  /* ------------------------------------------------------ collection log */
  { table: 'collection_log', column: 'domain', classification: 'structural' },
  { table: 'collection_log', column: 'reason', classification: 'structural' },

  /* ----------------------------------------------------------------- lia */
  { table: 'lia', column: 'purpose', classification: 'structural' },
  { table: 'lia', column: 'necessity', classification: 'structural' },
  { table: 'lia', column: 'balancing', classification: 'structural' },
  { table: 'lia', column: 'mitigations', classification: 'structural' },
  { table: 'lia', column: 'reviewed_by', classification: 'actor' },
]

/**
 * How a table's rows reach the person they concern.
 *
 * `person` is absent deliberately: its row is tombstoned rather than redacted,
 * because the proof that an erasure happened has to outlive the data.
 */
export const SUBJECT_REACH: Record<string, 'by_subject_id' | 'by_cell_id'> = {
  cell: 'by_subject_id',
  dsr: 'by_subject_id',
  provenance: 'by_cell_id',
  proposal: 'by_cell_id',
  contest: 'by_cell_id',
}

/** Subject columns grouped by table, for the tables erasure can reach. */
export function redactableColumns(): Map<string, ColumnClass[]> {
  const byTable = new Map<string, ColumnClass[]>()
  for (const c of VALUE_BEARING) {
    if (c.classification !== 'subject') continue
    if (!(c.table in SUBJECT_REACH)) continue
    const list = byTable.get(c.table) ?? []
    list.push(c)
    byTable.set(c.table, list)
  }
  return byTable
}
