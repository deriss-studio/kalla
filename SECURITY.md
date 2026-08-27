# Security

This project makes claims about protecting personal data. That raises the stakes
on getting reports privately: a working path through one of the invariants is,
in the hands of anyone using this on real data, a route to disclosing someone's
information. Please do not open a public issue for one.

## Reporting

**security@deriss.com**

If you would rather encrypt it, say so in a first message with no detail and I
will send a key.

Please include enough to reproduce: the commands or the test, what you expected
the substrate to refuse, and what it did instead. A failing test is the ideal
form — it is unambiguous, and it becomes the regression test.

## What you can expect

This is maintained by one person, so the commitments here are ones that can
actually be kept rather than ones that sound reassuring.

- **Acknowledgement within 3 working days.** If you have not heard back by
  then, assume the mail went astray and chase it.
- **An assessment within 14 days** — whether it is confirmed, what it affects,
  and a rough timeline.
- **Credit in the fix**, by whatever name you want, unless you would rather not
  be named.
- **No legal threats, ever**, for good-faith research against your own data or a
  local clone. That includes research that finds nothing and research that finds
  something embarrassing.

If a report reveals a path that leaks personal data in a deployment I know
about, I will say so publicly once there is a fix, including what was exposed
and for how long. A tool that argues for accountability does not get to be
quiet about its own failures.

## What counts as a security report here

More than usual, and this is the important part of this file.

**A path that defeats an invariant is a security report, not a bug report.**
The thirteen invariants in `test/invariants/` are the load-bearing claims. If
you find a route around one, that is a vulnerability even when nothing crashes
and no code executes. Concretely, any of these:

- Writing a cell value that ends up with no provenance row.
- Renewing a retention clock through a refresh, or getting expired data to
  survive a sweep.
- Reading, exporting or otherwise surfacing a value after it was erased,
  expired or refused — including through an error message, a log line or a
  timing difference.
- Getting special-category data to persist anywhere, including in a reasoning
  trace, a proposal, a contest or a report.
- Reaching data across a workspace boundary.
- Fetching a blocked domain, or laundering one in as human-supplied evidence.
- Making a subject access response incomplete, or an erasure receipt claim
  something that is not true.
- Resolving a contest without a named human against it.

The last two are worth calling out. **An artifact that overstates its own
completeness is the most serious class of bug this project has**, because it is
handed to a person as evidence. An erasure receipt saying "nothing survived"
when something did is worse than no receipt at all.

## What is already known

These are documented rather than hidden, so please do not spend time on them
unless you have found something worse than what is described:

- **One human can be two entities.** A person resolved by name and the same
  person resolved by their email are separate records, so an access response
  and an erasure receipt can both be confidently incomplete. This is the largest
  known correctness problem here and is written up in full in the issue tracker.
- **Detection is a judgement.** It is held to a measured floor in both
  directions by `test/identity-corpus.ts`, and it will still be wrong about data
  the corpus does not cover. A case it gets wrong is a welcome corpus
  contribution, not a security report — unless the error lets data escape one of
  the guarantees above.
- **There is no authentication.** The CLI operates on a local database as
  whoever is running it. Workspace scoping is a correctness boundary, not an
  access-control one, and it is not a substitute for file permissions.
- **Hosting is not yet EU-owned.** The region pin records intent; it does not
  enforce anything about where a deployment actually runs.

## Scope

In scope: this repository, and any deployment I run.

Out of scope: dependencies (report those upstream, though I would like to know),
and anything requiring an attacker who already has read access to the database
file — at that point the substrate has already lost, and it does not pretend
otherwise.
