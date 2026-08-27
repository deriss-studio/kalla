# Contributing

## The most useful thing you can send

**A corpus case from your own messy data.** Nobody guesses this, so it goes
first.

Personal-data detection is the one part of this system that cannot be made true
by a constraint. It is a judgement, and it is wrong in ways that only show up
against real exports — the CRM field that is a name in one row and a department
in the next, the "contact" column that is a shared inbox, the naming convention
in your language that the regexes have never seen.

`test/identity-corpus.ts` is where that becomes measurable. It holds four
labelled buckets:

- `IDENTIFYING` — must resolve to a person
- `JUNK` — must resolve to nobody, and must not even be flagged
- `UNCERTAIN` — must be flagged for a human rather than guessed either way
- `VARIANTS` — every form of one human that must reach one entity

Add a case with a one-line `why`, **anonymised** — invent the name, keep the
shape. If it fails, that is the point: it means detection is wrong and now
there is a test saying so. Open the PR even if you have not fixed it.

The floors in that file may be raised. They must never be lowered to make a
change pass.

## Proposing a new invariant

The numbered tests in `test/invariants/` are not "tests we care about more".
The criterion is:

> A test earns a number when its failure breaks a commitment, not when a
> feature regresses.

The four commitments are in `CLAUDE.md`. A failure that leaves one of them
untrue makes the product pointless rather than worse — that is the bar. A
regression in how fast the grid paints is a bug; it belongs in an ordinary test,
and ordinary tests are not lesser. There should be many more of them.

Worked examples: tenancy became invariant 8 because a value written under the
wrong workspace puts a person beyond reach of their own access and erasure
queries — commitment 2, silently untrue. Contest became invariant 11 because a
contest that resolves without a name is not a weaker contest, it is commitment 4
not holding.

If it is structural, prefer a database constraint over a trigger, and a trigger
over application code. A constraint cannot be dropped by a code path the way a
check can.

## A new assertion is not finished until you have watched it fail

This is the rule that matters most, and it applies to every test, not only the
numbered ones.

An assertion that has never failed has not been shown to test anything. Before
you open the PR:

1. Remove the predicate the test depends on.
2. Watch it fail.
3. Read the failure and confirm it failed **for the reason you intended**,
   rather than by accident.
4. Restore the predicate. Watch it pass.

Where a guard has several predicates, remove them one at a time. A guard with
two halves needs both proven separately, because the case only the second half
catches is exactly the one a reviewer assumes the first half already covered.

**Name the predicate you removed in the commit message.** "Tested" is not a
claim a reader can check; "removing the same-sheet predicate fails these two
cases" is. Every invariant in this repository was proved this way and the
commit messages say how, so the work can be checked rather than taken on trust.

Twice while building this, a mutation passed that should not have — and both
times the test was wrong rather than the code. That is what the step is for.

## The ordinary things

```bash
npm install
npm test          # the thirteen invariants and the rest
npm run typecheck
npm run demo      # the walkthrough, if you want to see the shape
```

- Read `CLAUDE.md` first. It is the specification the code has to satisfy, not
  background.
- Schema before screens: if a change touches both, propose the migration first.
- Small commits, real messages. This history is part of the argument.
- **Ask before adding a dependency.** Supply-chain transparency is a
  certification requirement here rather than a preference — every package is a
  claim that has to be defensible. The CSV reader is hand-written for exactly
  this reason.
- Never invent a value to fill a cell. `NOT_FOUND` is a correct answer.
- **Say when an invariant is in the way.** Sometimes it genuinely is. That is a
  conversation, not something to route around quietly, and the answer is
  sometimes that the invariant was wrong.

## Security

A path that defeats an invariant is a security report rather than a bug report.
See [SECURITY.md](SECURITY.md) — please do not open a public issue for one.
