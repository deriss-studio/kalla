# CLAUDE.md

Read this before writing any code in this repository. It is not background
context — it is the specification the code must satisfy.

## What this is

Kalla makes a spreadsheet you already have accountable. Import a CSV and every
value carries provenance, every person becomes an entity, retention expires,
and a subject access request and an erasure both come with proof. The interface
is a CLI; the data never leaves the machine.

That is the honest description of what exists, and it is the stronger one. The
eventual product is an agentic spreadsheet — prompts as columns, agents filling
cells from the web — and the category already exists (Paradigm, Clay, Apollo).
The runtime is the next chapter, not the missing half: the accountability could
not have been added afterwards, and it is worth having on its own.

What differs, in either chapter, is one thing, and the difference is the entire
company:

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

Detection asks two separate questions and must not confuse them. **Context** —
the column's data class, the row's kind — governs *handling*: retention,
special-category scanning, disclosure. **Identification** — an email, a profile
URL, a phone number, a name — governs *resolution*. Context never mints an
entity on its own. A column declared `personal` full of city names must not
manufacture a person per city. A hint from the column's name lowers the
identification threshold rather than sitting inert: "J Smith" in a column
called Founder identifies someone; the same string in a column called Notes
does not.

Detection has two failure directions and neither of them is cheap.

- **Under-flagging is a compliance failure.** A person we hold and cannot
  answer for: absent from an access response, surviving an erasure.
- **Over-flagging is a data-quality failure**, and it degrades the compliance
  queries themselves. "Everything we hold about this person" means nothing if
  half the person table is cities and job titles.
- **Uncertainty is surfaced, not guessed.** Where a value looks identifying and
  yields no stable key, record the doubt on the cell and let a human decide.
  Picking a side to avoid an awkward state is how both failures above get made.

Resolution keys on an identifier, never on raw text. Keying on the raw value
split "Vera Exempel Testsson" from "Vera Exempel Testsson, CEO" into two
people, which is the worst failure of the three because it makes an Article 15
answer look complete while missing half of what is held.

Detection is a judgement rather than a constraint, so it is held to a measured
floor in both directions — see `test/identity-corpus.ts` and invariant 9. The
floors may be raised. They must never be lowered to make a change pass.

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

Never hardcode a provider. All model calls go through `src/lib/models.ts`.
Every call records `model_id` and `model_region` into provenance. A provider
that cannot report its processing region is not eligible.

## Invariant tests

These live in `test/invariants/` and run in CI. They are not ordinary unit
tests — they exist to make the four commitments mechanically enforced rather
than remembered. Do not weaken them to make a feature pass.

Five of them are enforced by the database rather than by discipline, so the
invariant survives a code path that forgets it, a migration written at
midnight, or a well-meaning refactor. Four are triggers in
`src/db/triggers.sql`; the structural half of invariant 8 is a pair of
composite foreign keys on `cell`, which is better still — a constraint cannot
be dropped by a code path the way a trigger can, and it takes a join out of
every sheet-scoped query. Prefer a constraint where the invariant is
structural; reach for a trigger when it is conditional.

Each of those tests has a case that bypasses the application layer entirely and
asserts the database still refuses. Keep that pattern when you add one.

1. `no-value-without-provenance` — insert a cell value by every available code
   path; assert each produces a provenance row.
2. `refresh-preserves-retention` — refresh a cell; assert
   `retention_expires_at` is unchanged. And the other half of the same
   finding: sweep expired cells and assert the value survives nowhere, by the
   whole-database scan invariant 3 uses. A clock that cannot be renewed but is
   never acted on leaves Kaspr half-fixed. Expiry deletes rather than archives
   — "archived", "tombstoned" and "soft-deleted" are all ways of keeping a
   value while describing it differently.
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
8. `cell-belongs-to-workspace` — write with a mismatched workspace, and with a
   row and a column from different sheets; assert both are refused and nothing
   is persisted. Person entities are workspace-scoped, so a value written
   under the wrong workspace resolves its subject into the wrong tenant, where
   the owning workspace's access and erasure queries can no longer reach it.
9. `personal-data-is-an-entity` — introduce the same individual by every write
   path there is: an agent write, a human correction, an accepted proposal, a
   person-kind row. Assert each resolves to a person entity, and that all of
   them resolve to the *same* one.

10. `subject-access-is-complete` — assert the pack carries every kind of
    holding: cells with sources, rows that ARE the person, proposals over them,
    contests against them, and everything classified `retained`, with the
    ground it is kept on. Speed is invariant 4's job; this one is scope.
11. `a-cell-can-be-argued-with` — raise a contest, assert the value is not
    replaced by it, and resolve it three ways. Assert no resolution is possible
    without a named human, and that a cell with another argument still running
    stays contested.
12. `a-read-never-surfaces-what-was-removed` — erase, refuse and sweep, then
    read. Assert nothing removed comes back, that a state and a value which
    disagree resolve in favour of the state, and that a read is scoped to its
    workspace. Erasure is a promise about what leaves; a read is how things
    leave.
13. `risk-class-is-derived` — create a sheet for every declared use; assert the
    AI Act class is worked out rather than accepted, and that a sheet without a
    declared purpose is refused. A risk class that arrives as a parameter is
    the field a hurried person sets to `minimal`.

A pull request that adds a write path without extending tests 1 and 9 is
incomplete. Test 1 proves the value has an origin; test 9 proves the person in
it is an entity rather than a string.

### What earns a number

A test earns a number when its failure breaks a commitment, not when a feature
regresses. The distinction is not seniority — an invariant is not a test we
happen to care about more. It is that the four commitments are the reason this
system is worth building instead of buying, so a failure that leaves one of
them untrue is a failure that makes the product pointless rather than worse.

Applied: tenancy became invariant 8 because a value written under the wrong
workspace puts a person beyond the reach of their own access and erasure
queries — commitment 2, silently untrue. Contest became invariant 11 because a
contest that resolves without a name is not a weaker contest, it is commitment
4 not holding. A regression in how fast the grid paints is a bug; it belongs
in an ordinary test.

Ordinary tests are not lesser and there should be many more of them. They just
answer a different question.

### Proving a new invariant test

An invariant test that has never failed has not been shown to test anything.
Before adding one, remove the predicate it depends on, watch it fail, confirm
it failed for the reason you intended rather than by accident, then restore
the predicate and watch it pass.

Where a guard has several predicates, remove them one at a time. A guard with
two halves needs both proven separately, because the case that only the second
half catches is precisely the one a reviewer assumes the first half already
covered.

Name the predicate you removed in the commit message. "Tested" is not a claim
a reader can check; "removing the same-sheet predicate fails these two cases"
is.

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
- **Verifying that an artifact looks correct is not verifying that it does its
  job.** The two questions are different and the second is the one that
  matters. A lockfile was reviewed line by line — no top-level packages
  removed, every binary CI needs still present — pronounced benign, and
  committed. All of that was true. It still broke CI, because nobody asked the
  only question that counted: does `npm ci` succeed from it, under the
  toolchain CI actually runs? Reading an artifact tells you what it contains.
  Running it tells you whether it works, and those come apart precisely where
  the artifact is machine-generated and its consumer is a different version of
  the machine.

  So: exercise the artifact the way its consumer will. Restore the backup,
  apply the migration, install from the lockfile, render the export, parse the
  file. Where that check can be made mechanical, make it — the CI matrix on two
  Node versions is this lesson turned into a job that fails on the next push
  rather than a habit that has to be remembered. Where it cannot, say plainly
  in review which of the two questions you answered.

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
