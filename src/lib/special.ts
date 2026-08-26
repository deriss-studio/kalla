/**
 * Special-category detection (GDPR Article 9).
 *
 * A refused cell never holds the value — not in the cell, not in provenance,
 * not in a quote, not in a reasoning trace, not in a log line. The refusal
 * records the CATEGORY and nothing else.
 *
 * This implementation is a deliberately blunt lexical gate. It is the floor,
 * not the ceiling: it exists so the refusal path is real and tested from the
 * first commit. Replace it with a proper classifier before V1 ships, and keep
 * the contract identical — the rest of the system depends on the shape of the
 * answer, not on how the answer is reached.
 */

export type SpecialCategory =
  | 'health'
  | 'political_opinion'
  | 'religion'
  | 'trade_union'
  | 'sexual_orientation'
  | 'racial_or_ethnic_origin'
  | 'biometric'
  | 'criminal_offence'

const SIGNALS: Record<SpecialCategory, RegExp> = {
  health:
    /\b(diagnos\w*|illness|disease|cancer|diabet\w*|hiv|depress\w*|medication|prescription|disabilit\w*|sick\s*leave|therapy|psychiatr\w*)\b/i,
  political_opinion:
    /\b(votes?\s+(for|left|right)|party\s+member|socialist|conservative\s+party|sverigedemokraterna|political\s+(views?|affiliation))\b/i,
  religion:
    /\b(muslim|christian|jewish|hindu|buddhist|catholic|atheist|church\s+member|synagogue|mosque|religio\w*\s+(belief|affiliation))\b/i,
  trade_union: /\b(union\s+(member|membership)|fackförbund\w*|unionen|kommunal)\b/i,
  sexual_orientation: /\b(gay|lesbian|bisexual|heterosexual|queer|sexual\s+orientation)\b/i,
  racial_or_ethnic_origin:
    /\b(ethnicity|ethnic\s+origin|race[:=]|racial\s+origin|caste)\b/i,
  biometric: /\b(fingerprint|facial\s+recognition|iris\s+scan|biometric|dna\s+profile)\b/i,
  criminal_offence:
    /\b(convict\w*|criminal\s+record|prosecut\w*|indict\w*|arrested\s+for|prison\s+sentence)\b/i,
}

export type SpecialCheck =
  | { special: false }
  | { special: true; category: SpecialCategory }

export function checkSpecialCategory(...texts: (string | null | undefined)[]): SpecialCheck {
  const haystack = texts.filter(Boolean).join(' \n ')
  if (!haystack.trim()) return { special: false }

  for (const [category, pattern] of Object.entries(SIGNALS) as [
    SpecialCategory,
    RegExp,
  ][]) {
    if (pattern.test(haystack)) return { special: true, category }
  }
  return { special: false }
}
