/**
 * A labelled corpus for personal-data detection.
 *
 * Detection is the one part of this substrate that cannot be made true by a
 * constraint. It is a judgement, so it is held to a measured floor instead of
 * a stated intention — and to a floor in *both* directions, because the two
 * failures are different failures:
 *
 *   under-flagging  — a person we hold and cannot answer for. A compliance
 *                     failure: they are missing from access and survive
 *                     erasure.
 *   over-flagging   — a junk entity. A data-quality failure that degrades the
 *                     compliance queries themselves, because "everything about
 *                     this person" is only meaningful if the person is real.
 *
 * Neither is cheap, so where the answer is genuinely unclear the corpus
 * demands that the doubt be *recorded* rather than resolved by guessing. That
 * is what UNCERTAIN is: not a dumping ground for hard cases, but the labelled
 * expectation that we say "a human should look at this".
 *
 * Add a case whenever detection surprises you in the wild. The floors below
 * may be raised. They must not be lowered to make a change pass.
 */

import type { DataContext } from '../src/lib/person.js'

export interface Case {
  value: string
  context?: DataContext
  why: string
}

/** A column whose name makes a person the expected content. */
const FOUNDER: DataContext = { columnName: 'Founder', columnDataClass: 'personal' }
/** A column that expects a fact about a company. */
const HQ: DataContext = { columnName: 'Headquarters', columnDataClass: 'business' }
/** A row that IS an individual. */
const CANDIDATE: DataContext = { rowKind: 'person' }

/**
 * Must resolve to a person. Every one of these is a human we would have to
 * answer for under Article 15.
 */
export const IDENTIFYING: Case[] = [
  {
    value: 'Vera Exempel Testsson',
    context: FOUNDER,
    why: 'a full name where a person is expected',
  },
  {
    value: 'J Smith',
    context: FOUNDER,
    why: 'an initial and a surname — the hint lowers the bar, and should',
  },
  {
    value: 'J. Smith',
    context: FOUNDER,
    why: 'the same, punctuated',
  },
  {
    value: 'vera@example.test',
    context: HQ,
    why: 'an email identifies on its own, whatever the column expects',
  },
  {
    value: 'Contact: sara.lindqvist@example.co.uk',
    context: HQ,
    why: 'an email embedded in a sentence',
  },
  {
    value: 'https://www.linkedin.com/in/vtestsson',
    context: HQ,
    why: 'a profile URL identifies on its own',
  },
  {
    value: 'github.com/vtestsson',
    context: HQ,
    why: 'a profile URL without a scheme',
  },
  {
    value: '+46 70 123 45 67',
    context: { columnName: 'Phone', columnDataClass: 'personal' },
    why: 'a phone number where a phone number is expected',
  },
  {
    value: 'Sara Lindqvist',
    context: CANDIDATE,
    why: 'a person-kind row is a claim about its label',
  },
  {
    value: 'Anna-Karin Öberg',
    context: FOUNDER,
    why: 'Nordic characters and a hyphen are ordinary, not exotic',
  },
]

/**
 * Must resolve to nobody, and must not be flagged uncertain either. These are
 * unremarkable business facts; treating them as doubtful would bury the real
 * doubts in noise.
 */
export const JUNK: Case[] = [
  { value: 'Stockholm', context: HQ, why: 'a city' },
  { value: 'Stockholm, Sweden', context: HQ, why: 'a city and a country' },
  { value: 'Testbolaget AB', context: HQ, why: 'a company with a legal form' },
  { value: 'SEK 40,000,000', context: HQ, why: 'an amount' },
  { value: '2019', context: HQ, why: 'a year' },
  { value: 'Series B', context: HQ, why: 'a funding stage' },
  { value: 'NOT_FOUND', context: HQ, why: 'the correct answer to an unanswerable prompt' },
  { value: 'SaaS', context: HQ, why: 'a category' },
]

/**
 * Must resolve to nobody, and must be flagged for a human. Each of these has a
 * reason to think a person is involved and no stable way to say which person.
 */
export const UNCERTAIN: Case[] = [
  {
    value: 'Vera Exempel Testsson',
    context: HQ,
    why: 'a name where a company fact was expected — worth a look, not a guess',
  },
  {
    value: 'the founder',
    context: FOUNDER,
    why: 'a person is expected and nothing here says which one',
  },
  {
    value: 'Candidate 4',
    context: CANDIDATE,
    why: 'a person-kind row that identifies nobody must not mint an entity',
  },
  {
    value: 'contact@',
    context: FOUNDER,
    why: 'the shape of an email, and not an email',
  },
  {
    value: 'Vera Exempel Testsson',
    context: { columnName: 'Notes', columnDataClass: 'personal' },
    why:
      'the case that keeps context honest: a personal data class is a ' +
      'statement about handling, and must not on its own be enough to mint ' +
      'an entity from a name-shaped string',
  },
  {
    value: 'Stockholm',
    context: { columnName: 'Notes', columnDataClass: 'personal' },
    why: 'declared personal and identifies nobody — worth telling a human',
  },
]

/**
 * Every form of one human must reach one entity. A person split across two
 * rows makes an Article 15 answer look complete while missing half of what is
 * held, which is the most dangerous failure in this file because it looks
 * like success.
 */
export const VARIANTS: { forms: Case[]; why: string }[] = [
  {
    why: 'a name with a title, a role, or punctuation around it',
    forms: [
      { value: 'Vera Exempel Testsson', context: FOUNDER, why: 'bare' },
      { value: 'Vera Exempel Testsson, CEO', context: FOUNDER, why: 'with a role appended' },
      { value: 'CEO Vera Exempel Testsson', context: FOUNDER, why: 'with a role in front' },
      {
        value: 'Vera Exempel Testsson (co-founder)',
        context: FOUNDER,
        why: 'with a parenthetical',
      },
      { value: '  Vera   Exempel   Testsson  ', context: FOUNDER, why: 'loosely spaced' },
    ],
  },
  {
    why: 'an email in any casing or surrounded by words',
    forms: [
      { value: 'vera@example.test', context: HQ, why: 'bare' },
      { value: 'Vera@Example.test', context: HQ, why: 'cased' },
      { value: 'Email: vera@example.test', context: HQ, why: 'labelled' },
    ],
  },
  {
    why: 'a profile URL with or without scheme, host prefix, trailing slash or query',
    forms: [
      { value: 'https://www.linkedin.com/in/vtestsson', context: HQ, why: 'full' },
      { value: 'linkedin.com/in/vtestsson', context: HQ, why: 'bare' },
      { value: 'https://linkedin.com/in/vtestsson/', context: HQ, why: 'trailing slash' },
      {
        value: 'https://www.linkedin.com/in/vtestsson?trk=public',
        context: HQ,
        why: 'with tracking',
      },
    ],
  },
]

/** The floors. They may be raised; they must not be lowered to pass a change. */
export const FLOORS = {
  /** Of IDENTIFYING, the share that must resolve to a person. */
  identifyingResolved: 1,
  /** Of JUNK, the share that may resolve or be flagged. */
  junkDisturbed: 0,
  /** Of UNCERTAIN, the share that must be flagged rather than guessed. */
  uncertaintySurfaced: 1,
  /** Of VARIANT groups, the share that must collapse to one entity. */
  variantsCollapsed: 1,
}
