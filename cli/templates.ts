/**
 * Sheet templates.
 *
 * A template is a declared use with columns attached, and the declared use is
 * the whole point: it is what decides the risk class, and the class is worked
 * out rather than typed. The candidate-screening template is here so that the
 * stricter regime is something you can see turn on in one command, rather than
 * a paragraph in a compliance page nobody reads.
 */

import type { DeclaredUse } from '../src/lib/classify.js'
import type { DataClass } from '../src/lib/sheets.js'

export interface Template {
  key: string
  name: string
  summary: string
  purpose: string
  declaredUse: DeclaredUse
  rowKind: 'organisation' | 'person'
  columns: {
    key: string
    name: string
    prompt: string
    dataClass: DataClass
    retentionDays?: number
  }[]
}

export const TEMPLATES: Template[] = [
  {
    key: 'market-map',
    name: 'Market map',
    summary: 'Companies in a segment. Business facts, one named contact.',
    purpose:
      'Map companies in a market segment to identify candidates for advisory introductions.',
    declaredUse: 'market_mapping',
    rowKind: 'organisation',
    columns: [
      { key: 'hq', name: 'Headquarters', prompt: 'Where is the company headquartered?', dataClass: 'business' },
      { key: 'employees', name: 'Employees', prompt: 'Roughly how many people work there?', dataClass: 'business' },
      { key: 'last_round', name: 'Last round', prompt: 'What was the most recent funding round?', dataClass: 'business' },
      { key: 'founder', name: 'Founder', prompt: 'Who founded the company?', dataClass: 'personal' },
    ],
  },
  {
    key: 'supplier-screening',
    name: 'Supplier screening',
    summary: 'Due diligence on suppliers. Business facts and a named owner.',
    purpose:
      'Screen prospective suppliers for procurement due diligence before contracting.',
    declaredUse: 'supplier_screening',
    rowKind: 'organisation',
    columns: [
      { key: 'jurisdiction', name: 'Jurisdiction', prompt: 'Where is the supplier registered?', dataClass: 'business' },
      { key: 'certifications', name: 'Certifications', prompt: 'What certifications does the supplier hold?', dataClass: 'business' },
      { key: 'ubo', name: 'Beneficial owner', prompt: 'Who is the ultimate beneficial owner?', dataClass: 'personal' },
      { key: 'contact', name: 'Contact', prompt: 'Who is the named commercial contact?', dataClass: 'personal' },
    ],
  },
  {
    key: 'candidate-screening',
    name: 'Candidate screening',
    summary:
      'People, assessed for a role. Annex III high risk: the stricter regime turns on.',
    purpose:
      'Assess named candidates for a role, on the instruction of the hiring client.',
    declaredUse: 'employment_screening',
    rowKind: 'person',
    columns: [
      // Rows in this template ARE people, so the retention here is deliberately
      // shorter than the workspace default: a rejected candidate should not sit
      // in a file for six months because nobody chose a number.
      { key: 'current_role', name: 'Current role', prompt: 'What is their current role?', dataClass: 'personal', retentionDays: 90 },
      { key: 'employer', name: 'Employer', prompt: 'Who is their current employer?', dataClass: 'personal', retentionDays: 90 },
      { key: 'public_profile', name: 'Public profile', prompt: 'What is their public professional profile?', dataClass: 'personal', retentionDays: 90 },
      { key: 'assessment', name: 'Assessment note', prompt: 'How do they compare to the role requirements?', dataClass: 'personal', retentionDays: 90 },
    ],
  },
]

export function findTemplate(key: string): Template | undefined {
  return TEMPLATES.find((t) => t.key === key)
}
