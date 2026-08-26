# kalla

A European agentic spreadsheet. Prompts act as columns, agents fill cells by
researching the web, and the results are structured and sourced.

The category already exists. This one differs in one respect:

> Every value in this system knows where it came from, what it is, when it
> expires, who put it there, and how to argue with it.

That is not a feature list. It is an invariant, enforced by the database.

## What is here

This repository is the **substrate** — the part everything else depends on and
the part that cannot be retrofitted later. There is no interface yet, and that
is deliberate: an inspector over a table with no provenance rows teaches
nothing and hides the gap.

```
src/db/schema.ts        the data model — the compliance artifact
src/db/triggers.sql     the invariants, as database constraints
src/db/value-bearing.ts which columns can hold a subject's data
src/lib/write.ts        the single write path
src/lib/person.ts       personal data as an entity; erasure
src/lib/collection.ts   robots.txt / ai.txt gate, and the collection log
src/lib/special.ts      Article 9 refusal
src/lib/contest.ts      arguing with a value; resolution with a name on it
src/lib/dsr.ts          "everything we hold about this person", in one query
src/lib/classify.ts     AI Act risk class, per sheet, by declared use
test/invariants/        the nine tests that are the specification
```

`AGENTS.md` is a symlink to `CLAUDE.md`, so the two cannot drift. Coding agents
look for one name or the other; the specification only exists once.

## Running it

```bash
npm install
npm test          # the seven invariants
npm run typecheck
```

No database to install. Development and test run on PGlite — real Postgres
compiled to WebAssembly, in process, isolated per test file. Production points
at managed Postgres in an EU region; the SQL is identical.

```bash
npm run db:generate   # after changing src/db/schema.ts
```

## The four commitments

Read `CLAUDE.md` before changing anything. In short:

1. **Provenance is the substrate.** No code path writes a value without a
   source, a timestamp, and the model and region that produced it.
2. **Personal data is an entity, never a string.** One person, one row, however
   many sheets they appear in — which is the only reason access, rectification
   and erasure are answerable at all.
3. **Compliance is emergent, never a module.** Assessments, notices and
   response packs are derived from the substrate. If an artifact needs a human
   to type what the system could have known, the substrate is incomplete.
4. **Every cell can be argued with.** Contests are recorded beside values, not
   instead of them, and a human's correction is never silently overwritten.

## Why the triggers

Application code gets refactored around. A constraint does not.

Four of the seven invariants are enforced in `src/db/triggers.sql`, and each of
those tests includes a case that bypasses the application entirely and asserts
the database still refuses. The retention trigger is the clearest example: it
exists because the CNIL fined Kaspr €240,000 in part for retaining contacts
"five years from each update", so every automatic refresh renewed the clock and
nothing was ever deleted. A scheduled-refresh product gets that wrong by
default. Here it raises an exception.

## Status

Pre-V0. The substrate is real and tested; the grid, the runtime and the
interface are not built yet. See the strategy document for the build order and
what each stage has to prove.

## Licence

Apache 2.0. Vendor the full licence text before any public release.
