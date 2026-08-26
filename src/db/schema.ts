/**
 * The schema IS the compliance artifact.
 *
 * Read CLAUDE.md before changing anything here. Every table below exists to
 * make one of the four commitments mechanically true rather than remembered:
 *
 *   provenance   — no value exists without an origin record
 *   person       — personal data is an entity, not a string
 *   authorship   — machine judgment and human judgment stay distinguishable
 *   contest      — every cell can be argued with
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  foreignKey,
  index,
  uniqueIndex,
  real,
} from 'drizzle-orm/pg-core'

/* ------------------------------------------------------------------ enums */

export const dataClass = pgEnum('data_class', [
  'none',
  'business',
  'personal',
  'special',
])

/** Closed set. Never render a blank where a state exists. */
export const cellState = pgEnum('cell_state', [
  'empty',
  'queued',
  'running',
  'filled',
  'not_found',
  'refused',
  'expired',
  'contested',
])

export const declaredUse = pgEnum('declared_use', [
  'market_mapping',
  'supplier_screening',
  'deal_sourcing',
  'competitive_research',
  'employment_screening', // AI Act Annex III(4)
  'creditworthiness', // AI Act Annex III(5)
  'education_access', // AI Act Annex III(3)
  'essential_services', // AI Act Annex III(5)
  'other',
])

export const aiActClass = pgEnum('ai_act_class', [
  'minimal',
  'transparency_only',
  'high_risk',
])

export const authorshipOrigin = pgEnum('authorship_origin', [
  'machine',
  'human',
  'machine_then_human',
])

export const contestRaiser = pgEnum('contest_raiser', [
  'user',
  'subject',
  'reviewer',
])

export const contestResolution = pgEnum('contest_resolution', [
  'upheld',
  'corrected',
  'withdrawn',
])

export const collectionDecision = pgEnum('collection_decision', [
  'allowed',
  'blocked',
])

export const erasureState = pgEnum('erasure_state', ['active', 'erased'])

/**
 * Why a cell's subject could not be settled either way. A closed set, and an
 * enum rather than free text so it can never carry the value it is uncertain
 * about.
 *
 *   ambiguous_identity       — the value looks like it identifies someone, but
 *                              produced no stable key to resolve on.
 *   context_without_identity — the column or row says personal, and nothing in
 *                              the value identifies anyone.
 */
export const subjectUncertainty = pgEnum('subject_uncertainty', [
  'ambiguous_identity',
  'context_without_identity',
])

export const dsrType = pgEnum('dsr_type', [
  'access',
  'rectify',
  'erase',
  'object',
])

export const proposalState = pgEnum('proposal_state', [
  'open',
  'accepted',
  'rejected',
])

/* ------------------------------------------------------------- workspace */

export const workspace = pgTable('workspace', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Where processing is pinned. Claimed levels must match reality. */
  regionPin: text('region_pin').notNull().default('eu'),
  dpoContact: text('dpo_contact'),
  defaultRetentionDays: integer('default_retention_days').notNull().default(180),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/* ----------------------------------------------------------------- sheet */

export const sheet = pgTable(
  'sheet',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Required. Feeds the legitimate interest assessment. */
    purpose: text('purpose').notNull(),
    declaredUse: declaredUse('declared_use').notNull(),
    /** Derived from declaredUse — risk class belongs to the sheet, not us. */
    aiActClass: aiActClass('ai_act_class').notNull(),
    personalDataExpected: boolean('personal_data_expected')
      .notNull()
      .default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('sheet_workspace_idx').on(t.workspaceId)],
)

/* ---------------------------------------------------------------- column */

export const column = pgTable(
  'column',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sheetId: uuid('sheet_id')
      .notNull()
      .references(() => sheet.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** The cell prompt. Runs once per row. */
    prompt: text('prompt').notNull(),
    outputType: text('output_type').notNull().default('text'),
    enumValues: jsonb('enum_values').$type<string[] | null>(),
    modelPolicy: text('model_policy').notNull().default('default'),
    dataClass: dataClass('data_class').notNull().default('business'),
    retentionDays: integer('retention_days'),
    sourcePolicy: jsonb('source_policy').$type<Record<string, unknown> | null>(),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    uniqueIndex('column_sheet_key_idx').on(t.sheetId, t.key),
    /** Referenced by cell's composite foreign key. See the cell table. */
    uniqueIndex('column_id_sheet_idx').on(t.id, t.sheetId),
  ],
)

/* ------------------------------------------------------------ row entity */

export const rowEntity = pgTable(
  'row_entity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sheetId: uuid('sheet_id')
      .notNull()
      .references(() => sheet.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('organisation'),
    label: text('label').notNull(),
    /**
     * Non-null whenever this row IS an identifiable individual — a candidate,
     * a student, a borrower. Without it the label was personal data with no
     * entity behind it, and erasure could not reach it. Commitment 2 applies
     * to rows exactly as it applies to cells.
     */
    subjectId: uuid('subject_id').references(() => person.id, {
      onDelete: 'set null',
    }),
    /**
     * The same doubt a cell can record, for the same reason. A person-kind row
     * that resolved nobody used to carry nothing at all, which reads exactly
     * like a row that is not about a person — and an unresolved row is a
     * silent miss in a subject access response.
     */
    subjectUncertainty: subjectUncertainty('subject_uncertainty'),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    index('row_sheet_idx').on(t.sheetId),
    index('row_subject_idx').on(t.subjectId),
    /** Referenced by cell's composite foreign key. See the cell table. */
    uniqueIndex('row_id_sheet_idx').on(t.id, t.sheetId),
  ],
)

/* ---------------------------------------------------------------- person */

/**
 * Commitment 2. A person appearing in forty sheets is ONE row here with forty
 * cell references. Everything GDPR asks of us is answerable only because this
 * table exists.
 */
export const person = pgTable(
  'person',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    /** Normalised identity key used for resolution across sheets. */
    canonicalKey: text('canonical_key').notNull(),
    displayName: text('display_name'),
    identifiers: jsonb('identifiers').$type<Record<string, string>>(),
    lawfulBasis: text('lawful_basis').notNull().default('legitimate_interest'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    retentionExpiresAt: timestamp('retention_expires_at', {
      withTimezone: true,
    }),
    noticeSentAt: timestamp('notice_sent_at', { withTimezone: true }),
    noticeLanguage: text('notice_language'),
    erasureState: erasureState('erasure_state').notNull().default('active'),
    erasedAt: timestamp('erased_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('person_workspace_key_idx').on(t.workspaceId, t.canonicalKey),
  ],
)

/* ------------------------------------------------------------------ cell */

export const cell = pgTable(
  'cell',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rowId: uuid('row_id').notNull(),
    columnId: uuid('column_id').notNull(),
    /**
     * The sheet this cell sits in, carried on the row so that the composite
     * foreign keys below can insist the row and the column agree about it.
     * Also spares every sheet-scoped query a join.
     */
    sheetId: uuid('sheet_id').notNull(),
    value: text('value'),
    state: cellState('state').notNull().default('empty'),
    refusalReason: text('refusal_reason'),
    /**
     * Set once, when the value is first written. A refresh MUST NOT move it.
     * Enforced by trigger — see src/db/triggers.sql.
     */
    retentionExpiresAt: timestamp('retention_expires_at', {
      withTimezone: true,
    }),
    /** Non-null whenever this cell concerns an identifiable individual. */
    subjectId: uuid('subject_id').references(() => person.id, {
      onDelete: 'set null',
    }),
    /**
     * Set when detection could settle neither way. Guessing "person" mints a
     * junk entity that degrades every query built on the person table;
     * guessing "not a person" loses them from access and erasure. Neither is
     * acceptable, so the doubt is written down for a human instead.
     */
    subjectUncertainty: subjectUncertainty('subject_uncertainty'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('cell_row_column_idx').on(t.rowId, t.columnId),
    /** The index that makes the subject access request fast. */
    index('cell_subject_idx').on(t.subjectId),
    /**
     * The structural half of invariant 8, declared rather than enforced by a
     * trigger. A cell's row and its column must belong to the same sheet, and
     * because both keys carry the same sheet_id there is no pairing across
     * sheets — or across workspaces, since a sheet belongs to exactly one.
     *
     * A constraint cannot be forgotten by a new code path the way a check in
     * the write path can, and unlike a trigger it cannot be dropped by one
     * either.
     */
    foreignKey({
      name: 'cell_row_in_sheet_fk',
      columns: [t.rowId, t.sheetId],
      foreignColumns: [rowEntity.id, rowEntity.sheetId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'cell_column_in_sheet_fk',
      columns: [t.columnId, t.sheetId],
      foreignColumns: [column.id, column.sheetId],
    }).onDelete('cascade'),
  ],
)

/* ------------------------------------------------------------ provenance */

/**
 * Commitment 1. Append-only. There is no code path that writes a cell value
 * without writing one of these in the same transaction, and a deferred
 * constraint trigger checks it at COMMIT.
 */
export const provenance = pgTable(
  'provenance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cellId: uuid('cell_id')
      .notNull()
      .references(() => cell.id, { onDelete: 'cascade' }),
    sourceUrl: text('source_url').notNull(),
    sourceDomain: text('source_domain').notNull(),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
    crawlerId: text('crawler_id').notNull(),
    robotsState: text('robots_state').notNull(),
    aiTxtState: text('ai_txt_state').notNull(),
    modelId: text('model_id'),
    modelRegion: text('model_region'),
    confidence: real('confidence'),
    quote: text('quote'),
    /** True for seed and fixture data. Never true in production writes. */
    synthetic: boolean('synthetic').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('provenance_cell_idx').on(t.cellId)],
)

/* ------------------------------------------------------------- authorship */

export const authorship = pgTable(
  'authorship',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cellId: uuid('cell_id')
      .notNull()
      .references(() => cell.id, { onDelete: 'cascade' }),
    origin: authorshipOrigin('origin').notNull(),
    actorRef: text('actor_ref'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('authorship_cell_idx').on(t.cellId)],
)

/* ---------------------------------------------------------------- contest */

export const contest = pgTable(
  'contest',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cellId: uuid('cell_id')
      .notNull()
      .references(() => cell.id, { onDelete: 'cascade' }),
    raisedBy: contestRaiser('raised_by').notNull(),
    raiserRef: text('raiser_ref'),
    claim: text('claim').notNull(),
    counterEvidence: jsonb('counter_evidence').$type<
      { url: string; note?: string }[]
    >(),
    raisedAt: timestamp('raised_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: contestResolution('resolution'),
    /** Resolution is a human act with a name against it. */
    resolvedByHuman: text('resolved_by_human'),
    priorValue: text('prior_value'),
    note: text('note'),
  },
  (t) => [index('contest_cell_idx').on(t.cellId)],
)

/* --------------------------------------------------------------- proposal */

/**
 * When an agent finds newer evidence for a cell a human corrected, it does not
 * overwrite. It proposes, and the person decides.
 */
export const proposal = pgTable(
  'proposal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cellId: uuid('cell_id')
      .notNull()
      .references(() => cell.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
    evidence: jsonb('evidence').$type<{ url: string; quote?: string }[]>(),
    state: proposalState('state').notNull().default('open'),
    proposedAt: timestamp('proposed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
  },
  (t) => [index('proposal_cell_idx').on(t.cellId)],
)

/* --------------------------------------------------------- collection log */

export const collectionLog = pgTable(
  'collection_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    decision: collectionDecision('decision').notNull(),
    reason: text('reason').notNull(),
    /**
     * What was actually observed at the domain, so a later write can carry the
     * state rather than assert one. Null means the decision predates state
     * recording, which forces a fresh check instead of a guess.
     */
    robotsState: text('robots_state'),
    aiTxtState: text('ai_txt_state'),
    decidedAt: timestamp('decided_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('collection_domain_idx').on(t.workspaceId, t.domain)],
)

/* -------------------------------------------------------------------- lia */

export const lia = pgTable(
  'lia',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sheetId: uuid('sheet_id')
      .notNull()
      .references(() => sheet.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    purpose: text('purpose').notNull(),
    necessity: text('necessity').notNull(),
    balancing: text('balancing').notNull(),
    mitigations: jsonb('mitigations').$type<string[]>(),
    reviewedBy: text('reviewed_by'),
    validFrom: timestamp('valid_from', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when a higher data class is added to the sheet. */
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('lia_sheet_version_idx').on(t.sheetId, t.version)],
)

/* ------------------------------------------------------------- expiry log */

/**
 * Proof that expired data was deleted, and when.
 *
 * Deliberately built from identifiers and timestamps alone. There is no text
 * column here and there must never be one: a log that records the deletion of
 * personal data must not become the last place that personal data survives.
 * The value is gone; what remains is that a cell existed, that its clock ran
 * out, and that it was removed.
 */
export const expiryLog = pgTable(
  'expiry_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    /** No foreign key: the cell is gone, which is the point. */
    cellId: uuid('cell_id').notNull(),
    sheetId: uuid('sheet_id').notNull(),
    /** Whether the deleted cell concerned an identifiable individual. */
    hadSubject: boolean('had_subject').notNull().default(false),
    retentionExpiredAt: timestamp('retention_expired_at', {
      withTimezone: true,
    }).notNull(),
    sweptAt: timestamp('swept_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('expiry_workspace_idx').on(t.workspaceId)],
)

/* -------------------------------------------------------------------- dsr */

export const dsr = pgTable(
  'dsr',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id').references(() => person.id, {
      onDelete: 'set null',
    }),
    type: dsrType('type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    responsePack: jsonb('response_pack').$type<Record<string, unknown> | null>(),
  },
  (t) => [index('dsr_subject_idx').on(t.subjectId)],
)
