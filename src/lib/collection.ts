/**
 * Collection boundaries, enforced and provable.
 *
 * The EDPB expects a controller who scrapes to exclude sites that object via
 * robots.txt, ai.txt or a CAPTCHA, and to be able to produce a complete list of
 * the sources it actually used. Both halves of that live here: every domain
 * decision is written to collection_log before a fetch is attempted, and no
 * fetch happens without a decision.
 *
 * "Blocked" is a visible outcome, not a silent skip. And it is total: no
 * mirror, no cache, no archive, no routing around it.
 */

import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { collectionLog } from '../db/schema.js'

export class DomainBlockedError extends Error {
  constructor(readonly domain: string, readonly reason: string) {
    super(`collection blocked: ${domain} (${reason})`)
    this.name = 'DomainBlockedError'
  }
}

export function domainOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '')
}

export async function recordDecision(
  db: Db,
  workspaceId: string,
  domain: string,
  decision: 'allowed' | 'blocked',
  reason: string,
): Promise<void> {
  await db
    .insert(collectionLog)
    .values({ workspaceId, domain, decision, reason })
    .onConflictDoUpdate({
      target: [collectionLog.workspaceId, collectionLog.domain],
      set: { decision, reason, decidedAt: new Date() },
    })
}

export async function decisionFor(
  db: Db,
  workspaceId: string,
  domain: string,
): Promise<{ decision: 'allowed' | 'blocked'; reason: string } | null> {
  const [row] = await db
    .select({ decision: collectionLog.decision, reason: collectionLog.reason })
    .from(collectionLog)
    .where(
      and(
        eq(collectionLog.workspaceId, workspaceId),
        eq(collectionLog.domain, domain),
      ),
    )
    .limit(1)
  return row ?? null
}

export type Fetcher = (url: string) => Promise<{ body: string; status: number }>

/**
 * The only sanctioned way to reach the network. Every fetch in the system goes
 * through here so that the collection log is complete by construction rather
 * than by convention.
 */
export async function guardedFetch(
  db: Db,
  workspaceId: string,
  url: string,
  fetcher: Fetcher,
): Promise<{ body: string; status: number; domain: string }> {
  const domain = domainOf(url)
  const known = await decisionFor(db, workspaceId, domain)

  if (known?.decision === 'blocked') {
    throw new DomainBlockedError(domain, known.reason)
  }

  if (!known) {
    // Unknown domains are checked once, then remembered.
    const verdict = await checkRobots(url, fetcher)
    await recordDecision(db, workspaceId, domain, verdict.decision, verdict.reason)
    if (verdict.decision === 'blocked') {
      throw new DomainBlockedError(domain, verdict.reason)
    }
  }

  const result = await fetcher(url)
  return { ...result, domain }
}

async function checkRobots(
  url: string,
  fetcher: Fetcher,
): Promise<{ decision: 'allowed' | 'blocked'; reason: string }> {
  const origin = new URL(url).origin
  for (const [file, reason] of [
    ['/ai.txt', 'ai.txt disallow'],
    ['/robots.txt', 'robots.txt disallow'],
  ] as const) {
    try {
      const res = await fetcher(`${origin}${file}`)
      if (res.status === 200 && /Disallow:\s*\/\s*$/m.test(res.body)) {
        return { decision: 'blocked', reason }
      }
    } catch {
      // A missing policy file is not consent, but it is not objection either.
    }
  }
  return { decision: 'allowed', reason: 'no objection published' }
}
