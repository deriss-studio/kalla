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

/**
 * Proof that a URL went through the gate, and what was found there.
 *
 * A provenance row asserts the robots and ai.txt state of a source at fetch
 * time. That assertion used to be a default — `?? 'allowed'` — so a value
 * could claim a domain permitted collection when nothing had ever looked. The
 * claim is now unforgeable in the only two ways that matter: the object cannot
 * be constructed outside this module, and a non-synthetic receipt is checked
 * against the collection log before it is written, so the assertion is backed
 * by a decision that actually happened.
 *
 * This does not yet prove that guardedFetch is the ONLY way to reach the
 * network — nothing can, until there is a runtime to audit. What it proves is
 * that a source which skipped the gate cannot be written with a collection
 * state at all.
 */
const RECEIPT = Symbol('collection.receipt')

export interface CollectionReceipt {
  readonly [RECEIPT]: true
  readonly url: string
  readonly domain: string
  readonly robotsState: string
  readonly aiTxtState: string
  readonly crawlerId: string
  readonly retrievedAt: Date
  /** True for fixtures and seeds. Marks the provenance row it produces. */
  readonly synthetic: boolean
}

export function isCollectionReceipt(value: unknown): value is CollectionReceipt {
  return typeof value === 'object' && value !== null && RECEIPT in value
}

function mint(fields: Omit<CollectionReceipt, typeof RECEIPT>): CollectionReceipt {
  return { [RECEIPT]: true, ...fields }
}

/**
 * For fixtures and seeds only. CLAUDE.md permits synthetic provenance provided
 * it is marked as such, and this is what marks it: the provenance row lands
 * with synthetic = true, which is never true of a production write.
 */
export function syntheticReceipt(
  url: string,
  fields: { robotsState?: string; aiTxtState?: string; crawlerId?: string } = {},
): CollectionReceipt {
  return mint({
    url,
    domain: domainOf(url),
    robotsState: fields.robotsState ?? 'synthetic',
    aiTxtState: fields.aiTxtState ?? 'synthetic',
    crawlerId: fields.crawlerId ?? 'fixture',
    retrievedAt: new Date(),
    synthetic: true,
  })
}

/**
 * The sentinel domain for anything the controller supplied rather than the
 * system collected: a file they imported, a value they typed.
 */
export const SUPPLIED = 'supplied-by-controller'

/**
 * A receipt for a value that arrived in a file rather than off the web.
 *
 * An import is not a fetch, so it asserts no collection state: robots and
 * ai.txt are recorded as `n/a` because nothing was crawled and nothing
 * objected. That is the honest record, and it is what keeps the guarantee
 * meaningful — you still cannot claim a fetched state you did not obtain,
 * because this claims none.
 *
 * It is not synthetic. The data is real, the controller supplied it, and the
 * provenance row names the file and the person who ran the import.
 */
export function importReceipt(file: string, importedBy: string): CollectionReceipt {
  return mint({
    url: `file://${file}`,
    domain: SUPPLIED,
    robotsState: 'n/a',
    aiTxtState: 'n/a',
    crawlerId: `import:${importedBy}`,
    retrievedAt: new Date(),
    synthetic: false,
  })
}

/**
 * A receipt for a value a person typed. The same category as an import: the
 * controller supplied it, nothing was fetched, and it asserts no collection
 * state.
 */
export function typedReceipt(actor: string): CollectionReceipt {
  return mint({
    url: `human://${actor}`,
    domain: SUPPLIED,
    robotsState: 'n/a',
    aiTxtState: 'n/a',
    crawlerId: `typed:${actor}`,
    retrievedAt: new Date(),
    synthetic: false,
  })
}

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
  observed: { robotsState?: string; aiTxtState?: string } = {},
): Promise<void> {
  const robotsState = observed.robotsState ?? null
  const aiTxtState = observed.aiTxtState ?? null
  await db
    .insert(collectionLog)
    .values({ workspaceId, domain, decision, reason, robotsState, aiTxtState })
    .onConflictDoUpdate({
      target: [collectionLog.workspaceId, collectionLog.domain],
      set: { decision, reason, robotsState, aiTxtState, decidedAt: new Date() },
    })
}

/**
 * Human-supplied evidence — a URL pasted onto a contest, a proposal, or a
 * correction — is not a fetch, so it needs no receipt. It is still subject to
 * the objection: a domain that told us not to collect from it does not become
 * admissible because a person pasted the link by hand.
 */
export async function assertNotBlockedEvidence(
  db: Db,
  workspaceId: string,
  urls: (string | undefined | null)[],
): Promise<void> {
  for (const url of urls) {
    if (!url || url.startsWith('human:')) continue

    let domain: string
    try {
      domain = domainOf(url)
    } catch {
      continue // not a URL; nothing to launder
    }

    const known = await decisionFor(db, workspaceId, domain)
    if (known?.decision === 'blocked') {
      throw new DomainBlockedError(
        domain,
        `${known.reason} (offered as evidence rather than fetched)`,
      )
    }
  }
}

export async function decisionFor(
  db: Db,
  workspaceId: string,
  domain: string,
): Promise<{
  decision: 'allowed' | 'blocked'
  reason: string
  robotsState: string | null
  aiTxtState: string | null
} | null> {
  const [row] = await db
    .select({
      decision: collectionLog.decision,
      reason: collectionLog.reason,
      robotsState: collectionLog.robotsState,
      aiTxtState: collectionLog.aiTxtState,
    })
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
  crawlerId = 'kalla/0.1',
): Promise<{ body: string; status: number; domain: string; receipt: CollectionReceipt }> {
  const domain = domainOf(url)
  const known = await decisionFor(db, workspaceId, domain)

  if (known?.decision === 'blocked') {
    throw new DomainBlockedError(domain, known.reason)
  }

  let robotsState = known?.robotsState ?? null
  let aiTxtState = known?.aiTxtState ?? null

  // Unknown domains are checked once, then remembered. A remembered decision
  // that never recorded what it observed is re-checked rather than guessed at:
  // the receipt has to carry a state that was actually seen.
  if (!known || robotsState === null || aiTxtState === null) {
    const verdict = await checkRobots(url, fetcher)
    await recordDecision(db, workspaceId, domain, verdict.decision, verdict.reason, {
      robotsState: verdict.robotsState,
      aiTxtState: verdict.aiTxtState,
    })
    if (verdict.decision === 'blocked') {
      throw new DomainBlockedError(domain, verdict.reason)
    }
    robotsState = verdict.robotsState
    aiTxtState = verdict.aiTxtState
  }

  const result = await fetcher(url)

  return {
    ...result,
    domain,
    receipt: mint({
      url,
      domain,
      robotsState,
      aiTxtState,
      crawlerId,
      retrievedAt: new Date(),
      synthetic: false,
    }),
  }
}

async function checkRobots(
  url: string,
  fetcher: Fetcher,
): Promise<{
  decision: 'allowed' | 'blocked'
  reason: string
  robotsState: string
  aiTxtState: string
}> {
  const origin = new URL(url).origin
  const observed: Record<string, string> = { '/ai.txt': 'absent', '/robots.txt': 'absent' }
  let blockedBy: string | null = null

  for (const file of ['/ai.txt', '/robots.txt'] as const) {
    try {
      const res = await fetcher(`${origin}${file}`)
      if (res.status !== 200) continue
      if (/Disallow:\s*\/\s*$/m.test(res.body)) {
        observed[file] = 'disallow'
        blockedBy ??= file
        // Stop at the first objection. Reading further is still collecting.
        break
      }
      observed[file] = 'allowed'
    } catch {
      // A missing policy file is not consent, but it is not objection either.
    }
  }

  const robotsState = observed['/robots.txt']!
  const aiTxtState = observed['/ai.txt']!

  if (blockedBy) {
    return {
      decision: 'blocked',
      reason: blockedBy === '/ai.txt' ? 'ai.txt disallow' : 'robots.txt disallow',
      robotsState,
      aiTxtState,
    }
  }

  return {
    decision: 'allowed',
    reason: 'no objection published',
    robotsState,
    aiTxtState,
  }
}
