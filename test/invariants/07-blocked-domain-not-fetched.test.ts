/**
 * INVARIANT 7 — A blocked domain is not fetched. At all.
 *
 * No mirror, no cache, no archive, no routing around it. The EDPB expects a
 * controller to honour objections published via robots.txt, ai.txt or a
 * CAPTCHA, and to be able to show which domains it decided about and why.
 *
 * The test uses a fetcher that records every URL it is asked for, so "we did
 * not fetch it" is proven rather than asserted.
 */

import { describe, it, expect } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { fixture, sourced, type Fixture } from '../harness.js'
import {
  guardedFetch,
  recordDecision,
  syntheticReceipt,
  DomainBlockedError,
  type Fetcher,
} from '../../src/lib/collection.js'
import {
  acceptProposal,
  humanCorrectCell,
  writeCellValue,
} from '../../src/lib/write.js'
import { raiseContest } from '../../src/lib/contest.js'
import { cell, collectionLog, contest, provenance } from '../../src/db/schema.js'

let f: Fixture

function recordingFetcher(
  responses: Record<string, { body: string; status: number }> = {},
): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = []
  const fetcher: Fetcher = async (url) => {
    calls.push(url)
    return responses[url] ?? { body: '', status: 404 }
  }
  return { fetcher, calls }
}

describe('invariant: blocked domains are never fetched', () => {
  it('refuses a known-blocked domain without touching the network', async () => {
    f = await fixture()
    await recordDecision(f.db, f.workspaceId, 'blocked.example', 'blocked', 'ai.txt disallow')

    const { fetcher, calls } = recordingFetcher()

    await expect(
      guardedFetch(f.db, f.workspaceId, 'https://blocked.example/team', fetcher),
    ).rejects.toBeInstanceOf(DomainBlockedError)

    expect(calls, `network was touched: ${calls.join(', ')}`).toHaveLength(0)
  })

  it('does not accept a mirror, cache or subdomain workaround', async () => {
    f = await fixture()
    await recordDecision(f.db, f.workspaceId, 'blocked.example', 'blocked', 'robots.txt disallow')

    const { fetcher, calls } = recordingFetcher()

    for (const url of [
      'https://www.blocked.example/team',
      'https://blocked.example/team?utm=1',
    ]) {
      await expect(
        guardedFetch(f.db, f.workspaceId, url, fetcher),
      ).rejects.toBeInstanceOf(DomainBlockedError)
    }
    expect(calls).toHaveLength(0)
  })

  it('discovers an objection, records it, and blocks from then on', async () => {
    f = await fixture()
    const { fetcher, calls } = recordingFetcher({
      'https://objecting.example/ai.txt': { body: 'User-agent: *\nDisallow: /', status: 200 },
    })

    await expect(
      guardedFetch(f.db, f.workspaceId, 'https://objecting.example/about', fetcher),
    ).rejects.toBeInstanceOf(DomainBlockedError)

    // It checked the policy file, and stopped there.
    expect(calls).toEqual(['https://objecting.example/ai.txt'])

    const [logged] = await f.db
      .select()
      .from(collectionLog)
      .where(
        and(
          eq(collectionLog.workspaceId, f.workspaceId),
          eq(collectionLog.domain, 'objecting.example'),
        ),
      )
    expect(logged!.decision).toBe('blocked')
    expect(logged!.reason).toBe('ai.txt disallow')

    // Second attempt does not even check again.
    calls.length = 0
    await expect(
      guardedFetch(f.db, f.workspaceId, 'https://objecting.example/team', fetcher),
    ).rejects.toBeInstanceOf(DomainBlockedError)
    expect(calls).toHaveLength(0)
  })

  it('allows a domain that published no objection, and logs the decision', async () => {
    f = await fixture()
    const { fetcher, calls } = recordingFetcher({
      'https://open.example/about': { body: '<h1>About</h1>', status: 200 },
    })

    const res = await guardedFetch(f.db, f.workspaceId, 'https://open.example/about', fetcher)
    expect(res.status).toBe(200)
    expect(res.domain).toBe('open.example')
    expect(calls).toContain('https://open.example/about')

    const [logged] = await f.db
      .select()
      .from(collectionLog)
      .where(eq(collectionLog.domain, 'open.example'))
    expect(logged!.decision).toBe('allowed')
    expect(logged!.reason).toBe('no objection published')
  })
})

/**
 * The other half of the objection: a domain that told us not to collect from
 * it must not become admissible by a route that never fetches. A person can
 * paste a URL onto a contest, a proposal or a correction, and nothing about
 * that is a fetch — but the objection is about the domain, not the mechanism.
 */
describe('invariant: a blocked domain cannot be laundered in as evidence', () => {
  it('refuses a blocked domain pasted as contest counter-evidence', async () => {
    f = await fixture()
    await recordDecision(f.db, f.workspaceId, 'blocked.example', 'blocked', 'ai.txt disallow')

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )

    await expect(
      raiseContest(f.db, f.workspaceId, cellId, {
        raisedBy: 'user',
        claim: 'Wrong, see here.',
        counterEvidence: [{ url: 'https://blocked.example/team', note: 'their team page' }],
      }),
    ).rejects.toBeInstanceOf(DomainBlockedError)

    expect(await f.db.select().from(contest)).toHaveLength(0)
  })

  it('refuses a blocked domain pasted as correction evidence', async () => {
    f = await fixture()
    await recordDecision(f.db, f.workspaceId, 'blocked.example', 'blocked', 'robots.txt disallow')

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )

    await expect(
      humanCorrectCell(
        f.db,
        f.workspaceId,
        cellId,
        'Gothenburg',
        'soheill',
        'https://blocked.example/contact',
      ),
    ).rejects.toBeInstanceOf(DomainBlockedError)

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.value, 'the value moved on laundered evidence').toBe('Stockholm')
  })

  it('refuses a proposal whose evidence points at a blocked domain', async () => {
    f = await fixture()

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Stockholm'),
    )
    await humanCorrectCell(f.db, f.workspaceId, cellId, 'Stockholm, SE', 'soheill')

    const outcome = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      sourced('Gothenburg', 'https://blocked.example/about'),
    )
    expect(outcome.proposalId).toBeTruthy()

    // The objection arrives after the proposal was raised. Accepting it is a
    // human write, and the check is at the point of the write.
    await recordDecision(f.db, f.workspaceId, 'blocked.example', 'blocked', 'ai.txt disallow')

    await expect(
      acceptProposal(f.db, f.workspaceId, outcome.proposalId!, 'soheill'),
    ).rejects.toBeInstanceOf(DomainBlockedError)

    const [row] = await f.db.select().from(cell).where(eq(cell.id, cellId))
    expect(row!.value).toBe('Stockholm, SE')
  })
})

/**
 * A provenance row asserts what was found at a domain. That assertion must be
 * obtained, never defaulted: `?? 'allowed'` let a value claim a domain
 * permitted collection when nothing had ever looked.
 */
describe('invariant: a collection state cannot be asserted without being obtained', () => {
  it('refuses a source with a fabricated receipt', async () => {
    f = await fixture()

    const forged = {
      url: 'https://never-checked.example/about',
      domain: 'never-checked.example',
      robotsState: 'allowed',
      aiTxtState: 'absent',
      crawlerId: 'kalla/0.1',
      retrievedAt: new Date(),
      synthetic: false,
    }

    await expect(
      writeCellValue(
        { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
        {
          value: 'Stockholm',
          state: 'filled',
          // Right shape, no provenance in the sense that matters.
          sources: [{ receipt: forged as never }],
        },
      ),
    ).rejects.toThrow(/without a collection receipt/)

    expect(await f.db.select().from(cell)).toHaveLength(0)
  })

  it('refuses a real receipt for a domain that never passed the gate', async () => {
    // Synthetic receipts are honest about themselves. A receipt claiming a
    // real fetch has to be backed by a decision in the collection log.
    f = await fixture()

    const unbacked = syntheticReceipt('https://never-checked.example/about')
    const claimsReal = { ...unbacked, synthetic: false } as typeof unbacked

    await expect(
      writeCellValue(
        { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
        { value: 'Stockholm', state: 'filled', sources: [{ receipt: claimsReal }] },
      ),
    ).rejects.toThrow(/no recorded collection decision/)

    expect(await f.db.select().from(cell)).toHaveLength(0)
  })

  it('carries the state a real fetch actually observed', async () => {
    f = await fixture()
    const { fetcher } = recordingFetcher({
      'https://open.example/about': { body: '<h1>About</h1>', status: 200 },
      'https://open.example/robots.txt': { body: 'User-agent: *\nAllow: /', status: 200 },
    })

    const fetched = await guardedFetch(
      f.db,
      f.workspaceId,
      'https://open.example/about',
      fetcher,
    )

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      {
        value: 'Stockholm',
        state: 'filled',
        sources: [{ receipt: fetched.receipt, quote: '…Stockholm…' }],
      },
    )

    const [p] = await f.db.select().from(provenance).where(eq(provenance.cellId, cellId))
    expect(p!.synthetic).toBe(false)
    expect(p!.aiTxtState).toBe('absent') // no ai.txt was served
    expect(p!.robotsState).toBe('allowed') // robots.txt was, and permitted it
    expect(p!.sourceDomain).toBe('open.example')
  })

  it('carries a state that is not the one the old defaults assumed', async () => {
    // The previous defaults were robots 'allowed' and ai.txt 'absent'. A test
    // that only ever sees those two cannot tell an obtained state from a
    // defaulted one, so this domain serves the opposite of both: an ai.txt
    // that permits, and no robots.txt at all.
    f = await fixture()
    const { fetcher } = recordingFetcher({
      'https://permits.example/about': { body: '<h1>About</h1>', status: 200 },
      'https://permits.example/ai.txt': { body: 'User-agent: *\nAllow: /', status: 200 },
    })

    const fetched = await guardedFetch(
      f.db,
      f.workspaceId,
      'https://permits.example/about',
      fetcher,
    )

    const { cellId } = await writeCellValue(
      { db: f.db, workspaceId: f.workspaceId, rowId: f.rowId, columnId: f.columnId },
      { value: 'Stockholm', state: 'filled', sources: [{ receipt: fetched.receipt }] },
    )

    const [p] = await f.db.select().from(provenance).where(eq(provenance.cellId, cellId))
    expect(p!.aiTxtState).toBe('allowed')
    expect(p!.robotsState).toBe('absent')

    // And the log carries what was seen, so a later write need not guess.
    const [logged] = await f.db
      .select()
      .from(collectionLog)
      .where(eq(collectionLog.domain, 'permits.example'))
    expect(logged!.aiTxtState).toBe('allowed')
    expect(logged!.robotsState).toBe('absent')
  })
})
