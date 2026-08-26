/**
 * A CSV reader, written rather than installed.
 *
 * Every package here is a claim we have to be able to make, and a dependency
 * that parses the file a customer's personal data arrives in is a claim about
 * someone else's code touching the most sensitive input this system has. RFC
 * 4180 is small enough to implement and small enough to review, so it is.
 *
 * Handles what real exports contain: quoted fields, commas and newlines inside
 * quotes, doubled quotes as an escape, CRLF, and a trailing newline. It does
 * not handle a custom delimiter or a byte-order mark beyond stripping it — if
 * a file needs more than this, it should be said out loud rather than guessed
 * at.
 */

export interface CsvTable {
  headers: string[]
  rows: string[][]
}

export function parseCsv(input: string): CsvTable {
  const text = input.replace(/^﻿/, '').replace(/\r\n/g, '\n')

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    const ch = text[i]!

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    if (ch === '"' && field === '') {
      quoted = true
      i += 1
      continue
    }
    if (ch === ',') {
      endField()
      i += 1
      continue
    }
    if (ch === '\n') {
      endRow()
      i += 1
      continue
    }
    field += ch
    i += 1
  }

  // A trailing newline ends the last row; anything else leaves one open.
  if (field !== '' || row.length > 0) endRow()

  if (rows.length === 0) return { headers: [], rows: [] }

  const [headers, ...body] = rows
  return {
    headers: headers!.map((h) => h.trim()),
    // A short row is padded rather than dropped: a missing trailing field is
    // an empty value, not a malformed file.
    rows: body
      .filter((r) => r.some((c) => c.trim() !== ''))
      .map((r) => headers!.map((_, n) => r[n] ?? '')),
  }
}
