# kalla

**Make the spreadsheet you already have accountable.**

Import a CSV of leads and every value in it starts carrying where it came from,
what it is, when it expires and who put it there. The people in the file become
entities rather than strings, so you can answer "everything you hold about me"
in one query and prove an erasure afterwards. No agents, no cloud, no account —
it runs on your machine and the data never leaves it.

[![Six moments: provenance, subject access, and a provable erasure](https://asciinema.org/a/F3jFsQSeV5jdhBxN.svg)](https://asciinema.org/a/F3jFsQSeV5jdhBxN)

```bash
git clone https://github.com/deriss-studio/kalla && cd kalla && npm install

npm run kalla -- init   --actor you@example.com
npm run kalla -- import leads.csv --sheet "Q3 leads" --purpose "Qualify inbound leads"
npm run kalla -- subject "someone@theircompany.com"      # everything held about them
npm run kalla -- erase   "someone@theircompany.com" --confirm
```

That last command writes a receipt: what it predicted would survive the
erasure, what actually survived after scanning every text column in the
database, and whether those two agreed.

The recording above is `npm run demo`, which walks the same ground in six
moments with pauses to talk over. `docs/kalla2.cast` is the source.

---

## Why this exists

Every CRM and enrichment tool holds personal data. Almost none can tell you
where a particular value came from, when it should be deleted, or prove that a
deletion happened. That is not usually malice; it is that provenance, retention
and erasure cannot be bolted on afterwards. They have to be in the shape of the
data from the first row.

So this is that shape, with a CLI on top:

> Every value in this system knows where it came from, what it is, when it
> expires, who put it there, and how to argue with it.

Not a feature list. An invariant, enforced by the database.

## The four commitments

**1. Provenance is the substrate.** No code path writes a value without a
source, a timestamp, and the model and region that produced it. Values imported
from a file say so; values a person typed say so; a value fetched from the web
carries what robots.txt and ai.txt actually said at the time. You cannot assert
a collection state you did not obtain — the receipt that proves it is minted by
the fetcher and checked against the collection log before the write lands.

**2. Personal data is an entity, never a string.** One person, one row, however
many sheets they appear in. That is the only reason access, rectification and
erasure are answerable at all. Detection asks two questions — does this cell
need personal-data handling, and does anything in it identify a specific human
— and where it can settle neither, it records the doubt for a person rather
than guessing.

**3. Compliance is emergent, never a module.** There is no compliance mode.
Subject access responses, risk classifications and erasure receipts are derived
from the substrate. Declare that a sheet screens job candidates and the AI Act
high-risk regime turns on by itself; nobody types the classification, because a
classification you can type is one you can type wrongly.

**4. Every cell can be argued with.** A contest states a claim, attaches
counter-evidence, and sits beside the value rather than replacing it.
Resolution is a human act with a name against it. No timeout closes an
argument.

## Install

```bash
npm install
npm test          # the thirteen invariants
npm run demo      # the six-moment walkthrough
```

No database to install. It runs on PGlite — real Postgres compiled to
WebAssembly, in process. Production points at managed Postgres in an EU region;
the SQL is identical.

## The CLI

Until this is published to npm there is no `kalla` binary, so commands run
through the npm script: `npm run kalla -- init --actor ...`. The CLI prints its
own hints in whichever form you invoked it, so anything it suggests can be
pasted as-is.

```
kalla init      --actor <you> [--name ...] [--region ...] [--retention <days>]
kalla new       <template> [--name ...]
kalla import    <file.csv> --sheet <name> [--purpose ...] [--plan <plan.json>]
kalla show      --sheet <name> [--row <label> --column <key>]
kalla set       --sheet <name> --row <label> --column <key> --value <text>
kalla subject   <name or email>
kalla erase     <name or email> [--confirm] [--out <file>]
kalla contest   --sheet <name> --row <label> --column <key> --claim "..."
kalla resolve   <contest-id> --outcome upheld|corrected|withdrawn [--value ...]
kalla sweep     [--confirm]
```

Three templates ship: `market-map`, `supplier-screening`, and
`candidate-screening` — the last declares an Annex III use, so you can watch
the stricter regime switch on in one command.

**`import` will not classify your data for you.** Run it once and it imports
nothing: it proposes a data class per column, writes the plan to a file, and
asks you to correct it. What a column holds governs how it is handled for as
long as it is held. The proposal guesses low on purpose — a column of cities
classified `personal` would manufacture a person per city, and junk entities
degrade every question you would later ask about a real one.

## The invariants

Thirteen tests in `test/invariants/`. They are not ordinary unit tests: each
exists so a commitment is mechanically true rather than remembered, and a test
earns a number only when its failure would break one.

| # | Invariant |
|---|---|
| 1 | No value exists without provenance |
| 2 | A refresh moves the value, never the clock — and when the clock runs out, the value is deleted |
| 3 | Erasure is total, proven by scanning every text column in the database |
| 4 | "Everything about this person" returns within budget |
| 5 | A human's correction is never silently overwritten |
| 6 | Special-category data is refused, and appears in no store |
| 7 | A blocked domain is never fetched, and cannot be laundered in as evidence |
| 8 | A cell belongs to the caller's workspace |
| 9 | Personal data is an entity at every write path, held to a measured floor |
| 10 | A subject access response is complete |
| 11 | Every cell can be argued with |
| 12 | A read never surfaces what erasure or expiry removed |
| 13 | A sheet's risk class is derived, never declared |

Five are enforced by the database rather than by discipline — four triggers and
a pair of composite foreign keys — and each of those carries a case that
bypasses the application entirely and asserts Postgres still refuses.

**Please try to break them.** That is a genuine invitation, not a formality.
The fastest way is to write a test that violates one and watch what happens; if
you find a path through, that is the most useful bug report this project can
receive. Every invariant here was proved by removing the predicate it depends
on and watching it fail for the right reason — the commit messages name which
predicate, so you can check the work rather than take it on trust.

## Where the design came from

The invariants were derived from enforcement actions, not from principles. That
distinction is the reason they are shaped the way they are: a principle tells
you what to care about, and an enforcement action tells you exactly which
plausible-looking implementation a regulator has already rejected.

**CNIL v. Kaspr** (2024, €240,000) is the closest analogue to this product that
has been decided. The findings run to Article 6 — no lawful basis for the
scraped contact data — and to Articles 12 and 14 on informing the people
concerned, and Article 15 on answering them when they ask. But the one that
shaped the schema is Article 5(1)(e): Kaspr retained contacts for five years
*from each update*, so an automatic refresh renewed the clock and nothing was
ever deleted. A scheduled-refresh product gets that wrong by default. It is
invariant 2, and it is a database trigger rather than a code review comment —
a refresh moves the value and never the clock, and when the clock runs out the
value is deleted rather than archived.

**The EDPB's guidance on web scraping** shapes the collection side. The
expectation that a controller performs and records a legitimate interest
assessment is why a sheet cannot exist without a declared purpose. The
expectation that it can produce a complete list of the sources it actually used
is why the collection log is written before a fetch rather than after. The
expectation that it honours objections published through robots.txt and ai.txt
is invariant 7 — including the part where a blocked domain cannot be laundered
back in as human-pasted evidence. The expectation that special-category data is
filtered out rather than collected and then handled is invariant 6, which
refuses the value rather than storing it with a flag.

**The AI Act** classifies by use, not by vendor, which is why the risk class
belongs to the sheet and is derived from its declared use rather than typed
(invariant 13). Annex III obligations were deferred to 2 December 2027 by the
Digital Omnibus, and Article 50 transparency is live now. Classifying at
creation means the regime is already in place when it binds, rather than
retrofitted onto sheets that have been running for two years.

**CADA's levels of sovereignty** are why the region pin is a field and not a
marketing page. A sovereignty claim is a claim about where processing actually
happens, so the model adapter records its processing region on every value it
produces, and a provider that cannot report one is not eligible. The hosting
does not yet support the strongest claim; the substrate is built so that the
claim can be made honestly when it does, and not before.

## What this does not do yet

Being specific about this, because the gaps matter more than the features.

**There is no runtime.** No agents, no queue, no filling a column by asking the
web. The model adapter and the collection gate are built and tested, but
nothing drives them on a schedule. That is the next chapter rather than the
missing half: what is here is useful without it, and the accountability could
not have been added afterwards.

**One human can still become two entities.** A person resolved by name and the
same person resolved by their email address are separate records until
something links them. You can watch it happen: erase the name and the email
survives, because as far as the system is concerned they are two people. This
is the most important open problem in the repository — it makes an Article 15
answer look complete while missing half of what is held — and identity
resolution across identifier types is the next substantive piece of work.

It is written up in full as [issue #1](https://github.com/deriss-studio/kalla/issues/1), with a proposed design:
identifiers linking to one person, co-occurrence proposing rather than
performing, a human confirming with their name recorded, erasure following the
links, and unconfirmed candidates disclosed rather than silently omitted. It is
the piece I would most like help with, and the design is a proposal rather than
a specification — a better one is welcome.

**Detection is a judgement, not a constraint.** It is held to a stated floor in
both directions by a labelled corpus (`test/identity-corpus.ts`), and the floor
can only be raised. It will still be wrong about your data in ways the corpus
does not cover. When it is, add the case — that is the intended way to
contribute to it.

**No interface beyond the CLI**, no multiplayer, no mobile. The grid is
`kalla show`.

**Hosting is not yet EU-owned.** The SQL, the model adapter and the region pin
are all built to support that claim; the claim itself waits until the hosting
does.

## Open core, stated plainly

The substrate and the CLI in this repository are **Apache 2.0**, permanently.
That covers everything above: the schema, the invariants, the write path,
erasure, the access pack, the audit scan, the import, the CLI.

A hosted runtime — agents filling columns on a schedule, with the queue and
model access that needs — is intended to be a commercial product later. It does
not exist yet, and nothing here is crippled to make room for it. If that
boundary ever starts pulling capability out of the open substrate, that is a
bug worth opening an issue about.

## Who built this, and what it needs

Built at [Deriss](https://deriss.com) by one person.

The runtime is the part this project does not have the hands for. It needs
someone who has run a queue that touches the open web at volume — the fetching,
the backoff, the crawler etiquette, the model calls, the failure modes that only
appear at the thousandth row. The substrate is deliberately shaped to receive
it: the collection gate, the model adapter and the cell agent contract are all
built and tested with nothing driving them.

If that sounds interesting, [open an issue](https://github.com/deriss-studio/kalla/issues) and say so. The same goes
for anyone who wants to argue with the invariants — that is the most useful
contribution this repository can receive, and it is a shorter conversation than
it sounds.

[CONTRIBUTING.md](CONTRIBUTING.md) says what helps most, and it is probably not
what you would guess. A path that defeats an invariant is a security report
rather than a bug report — see [SECURITY.md](SECURITY.md).

## Where things live

```
src/db/schema.ts        the data model — the compliance artifact
src/db/triggers.sql     the invariants, as database constraints
src/db/value-bearing.ts which columns can hold a subject's data
src/lib/write.ts        the single write path
src/lib/person.ts       detection, resolution, erasure
src/lib/sheets.ts       creating a surface, and the read path
src/lib/import.ts       CSV in, accountable data out
src/lib/collection.ts   robots.txt / ai.txt gate, and the collection log
src/lib/special.ts      Article 9 refusal
src/lib/contest.ts      arguing with a value; resolution with a name on it
src/lib/dsr.ts          "everything we hold about this person", in one query
src/lib/retention.ts    expiry: the clock, acted on
src/lib/audit.ts        proving a negative: is this value anywhere at all
cli/                    the interface
test/invariants/        the thirteen tests that are the specification
```

`AGENTS.md` is a symlink to `CLAUDE.md`, so the two cannot drift. Read it before
changing anything: it is the specification the code has to satisfy, not
background.

## Licence

Apache 2.0, in full, in [LICENSE](LICENSE).
