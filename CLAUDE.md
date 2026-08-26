# CLAUDE.md

Read this before writing any code in this repository. It is not background
context — it is the specification the code must satisfy.

## What this is

A European agentic spreadsheet. Prompts act as columns; agents fill cells by
researching the web; the results are structured, sourced and auditable.

The category already exists (Paradigm, Clay, Apollo). This one differs in one
respect, and the difference is the entire company:

> **Every value in this system knows where it came from, what it is, when it
> expires, who put it there, and how to argue with it.**

That is not a feature. It is an invariant. If a change makes it possible to
violate the invariant, the change is wrong — even if it is faster, simpler, or
what the user asked for. Say so and propose an alternative.

## The four commitments

These are architectural, not aspirational. Every design decision is checked
against them.

### 1. Provenance is the substrate

A cell value cannot exist without a provenance record: source URL, retrieval
timestamp, the crawler that fetched it, the model that derived it, the model's
region, and the robots/ai.txt state of the source domain at fetch time.

There is no code path that writes a value without provenance. Not for tests,
not for seeds, not for imports, not for "just this once". Seed data gets
synthetic provenance marked as such.

### 2. Personal data is an entity, never a string

A cell containing a person's name, email, phone, role, or free text about an
identifiable individual resolves to a `person` record. The same human across
forty sheets is one entity with forty references.

Consequences that must hold:

- "Everything we hold about this person, across all sheets, with sources"
  is a single query that returns in under two seconds.
- Erasure propagates to every reference and is itself logged.
- Retention is per-cell and expires by default. **A refresh updates a value
  without resetting the retention clock.** This is the specific failure the
  CNIL penalised in its Kaspr decision; treat it as a regression test, not a
  guideline.

When personal-data detection is uncertain, flag it as personal. Over-flagging
is cheap. Under-flagging is the failure mode that ends the company.

### 3. Compliance is emergent, never a module

There is no "compliance mode", no `/compliance` directory, no feature flag that
turns auditability on. Legitimate interest assessments, Article 14 notices,
subject access responses and processing logs are all *derived* from the
substrate. If a compliance artifact requires the user to type something the
system could have known, the substrate is incomplete — fix the substrate.

### 4. Every cell can be argued with

Any cell can be contested by a colleague, a reviewer or the data subject. A
contest states a claim, attaches counter-evidence, and is recorded beside the
value rather than replacing it. Resolution is a human act with a name against
it.

Two rules that follow and are easy to break by accident:

- **A cell a human corrected is never silently overwritten by a later agent
  run.** New evidence produces a *proposal*, and the human decides.
- The record always distinguishes machine judgment from human judgment.
  `authorship.origin` is `machine`, `human`, or `machine_then_human`.

## Stack

Chosen for one reason each. Do not substitute without saying why.

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript, strict | One language across API and UI |
| Framework | Next.js, App Router | Server actions keep write paths on the server |
| Database | PostgreSQL | Relational integrity is the product |
| Dev/test DB | PGlite (Postgres in WASM, in process) | Same SQL, no Docker, isolated per test file |
| Schema | Drizzle, migrations in git | The schema is a compliance artifact; it belongs in review |
| Queue | Graphile Worker (Postgres-backed) | No new infrastructure, EU-hosted by definition |
| Grid | TanStack Table + virtualiser | Never hand-roll a data grid |
| Auth | Auth.js, Postgres adapter | Self-hosted, no third-country dependency |
| Models | Adapter interface, EU-hosted inference default | Vendor swappable by design |
| Tests | Vitest, plus invariant tests (below) | The invariants are the test suite |

Hosting starts wherever is fastest and moves to EU-owned infrastructure before
any certification claim is made. Do not let sovereignty purity block V0, and do
not make a sovereignty claim the hosting does not support.

## Model access

Never hardcode a provider. All model calls go through `lib/models/adapter.ts`.
Every call records `model_id` and `model_region` into provenance. A provider
that cannot report its processing region is not eligible.

## Invariant tests

These live in `test/invariants/` and run in CI. They are not ordinary unit
tests — they exist to make the four commitments mechanically enforced rather
than remembered. Do not weaken them to make a feature pass.

Four of them are backed by database triggers in `src/db/triggers.sql`, so the
invariant survives a code path that forgets it, a migration written at
midnight, or a well-meaning refactor. Each of those tests has a case that
bypasses the application layer entirely and asserts the database still refuses.
Keep that pattern when you add one.

1. `no-value-without-provenance` — insert a cell value by every available code
   path; assert each produces a provenance row.
2. `refresh-preserves-retention` — refresh a cell; assert
   `retention_expires_at` is unchanged.
3. `erasure-is-total` — erase a person; assert no cell, index, cache, log
   payload or export contains their data.
4. `dsr-under-2s` — assert the subject access query returns within budget.
   CI runs a scaled proxy (2k cells) because PGlite is roughly an order of
   magnitude slower than server Postgres; the full 100k-cell run belongs in a
   nightly job against a real instance. Never "fix" a slow full-scale run by
   lowering the CI numbers.
5. `human-value-not-overwritten` — human-correct a cell, run the agent again;
   assert the value stands and a proposal was created.
6. `special-category-refused` — feed values in each special category; assert
   the cell is refused and the value appears in no store, including reasoning
   traces and logs.
7. `blocked-domain-not-fetched` — mark a domain blocked; assert no fetch, no
   cached read, no mirror.

A pull request that adds a write path without extending test 1 is incomplete.

### How the harness runs them

One PGlite per test *file*, truncated between tests — not one per test. Booting
Postgres-in-WASM dominates the cost of this suite, and a database per test made
CI time out rather than fail.

Two things keep it fast, and both are easy to undo by accident:

- **The schema is built once per run.** `test/global-setup.ts` migrates one
  database, dumps its data directory, and every file restores from that dump.
  `initdb` is the expensive half of starting PGlite and restoring skips it;
  across the suite that is the difference between a ~10s slowest test and a
  ~2s one.
- **`pool: 'threads'`, capped at four workers.** Threads share a process, so
  the WebAssembly is compiled once rather than once per worker. The cap is
  there because the scarce resource is concurrent Postgres instances, not
  cores: past four, wall time stops improving while the slowest test grows
  several-fold — and it is the slowest test that has to stay clear of
  `testTimeout`.

If you meet a 13-second boot, the snapshot is not being used; check that
`globalSetup` still runs. A missing snapshot is a legitimate fallback — a file
run outside this config — and costs only speed. Any other failure to read it is
raised rather than absorbed, because a silent downgrade to the slow path would
hide a real fault.

Isolation lives in the truncation, which is derived from the catalogue so a new
table is covered without anyone remembering it. Assert it with
`vitest --sequence.shuffle`, and do not answer a flaky test by giving it its own
database again.

## How to work in this repo

- **Schema before screens.** If a change touches both, propose the migration
  first and stop for review.
- **Small commits, real messages.** This repository is likely to be published;
  the history is part of the argument.
- **Ask before adding a dependency.** Supply-chain transparency is a
  certification requirement here, not a preference. Every package is a claim we
  have to be able to make.
- **Never invent a value to fill a cell.** `NOT_FOUND` is a correct answer and
  must be as easy to produce as a filled cell.
- **Say when the invariant is in the way.** Sometimes it genuinely is. That is a
  conversation, not a thing to route around quietly.

## Vocabulary

Use these words consistently in code, UI and commits.

- **cell** — one value, at a row/column intersection
- **provenance** — the immutable origin record of a value
- **authorship** — who put a value here: machine, human, or both
- **contest** — a recorded disagreement with a value
- **person** — an identified individual referenced by cells
- **sheet** — a research surface with a declared purpose and use
- **underlag** — the decision document a sheet resolves into

Cell states are a closed set. Never render a blank where a state exists:
`empty · queued · running · filled · not_found · refused · expired · contested`

## Out of scope for now

Multiplayer editing. Mobile. Anything that requires a cell to exist without
provenance in order to be fast.
