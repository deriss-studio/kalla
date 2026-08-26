/**
 * Risk class belongs to the SHEET, by its declared use — not to us as vendor.
 *
 * A sheet screening restaurants and a sheet screening job candidates are the
 * same software doing legally different things. Paradigm ships a "Technical
 * Recruiting Dashboard" and a "PE Executive Scorecard" with no classification
 * anywhere. That is the gap.
 *
 * Annex III obligations were deferred to 2 December 2027 by the Digital
 * Omnibus. Article 50 transparency is live now. We classify at creation so the
 * regime is already in place when it binds.
 */

import type { aiActClass, declaredUse } from '../db/schema.js'

export type DeclaredUse = (typeof declaredUse.enumValues)[number]
export type AiActClass = (typeof aiActClass.enumValues)[number]

/** Annex III uses, as they apply to a research and screening tool. */
const HIGH_RISK: DeclaredUse[] = [
  'employment_screening', // Annex III(4) — recruitment, selection, evaluation
  'creditworthiness', // Annex III(5)(b)
  'education_access', // Annex III(3)
  'essential_services', // Annex III(5)(a)
]

export interface Classification {
  aiActClass: AiActClass
  obligations: string[]
  humanSignOffRequired: boolean
}

export function classifySheet(use: DeclaredUse): Classification {
  if (HIGH_RISK.includes(use)) {
    return {
      aiActClass: 'high_risk',
      humanSignOffRequired: true,
      obligations: [
        'human oversight recorded per decision (Art. 14)',
        'accuracy, robustness and logging records retained (Art. 15, 12)',
        'transparency notice generated for affected persons (Art. 50)',
        'named human sign-off before any output leaves the system',
        'contest route offered to the affected person',
      ],
    }
  }

  return {
    aiActClass: 'transparency_only',
    humanSignOffRequired: false,
    obligations: ['disclosure that output is AI-generated (Art. 50)'],
  }
}
