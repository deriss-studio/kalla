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

import { describe, it, expect, afterEach } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { fixture, type Fixture } from '../harness.js'
import {
  guardedFetch,
  recordDecision,
  DomainBlockedError,
  type Fetcher,
} from '../../src/lib/collection.js'
import { collectionLog } from '../../src/db/schema.js'

let f: Fixture
afterEach(async () => f?.close())

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
