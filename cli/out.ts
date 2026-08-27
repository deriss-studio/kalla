/**
 * CLI output.
 *
 * Terser than the walkthrough's: this is a tool someone uses, not a thing they
 * present. Two rules it keeps from the walkthrough, because they are about
 * honesty rather than presentation — a state is never rendered as a blank, and
 * a count is never printed without what it is out of.
 */

const ESC = String.fromCharCode(27)
const COLOUR = !process.env.NO_COLOR && process.env.TERM !== 'dumb'

const paint = (code: string) => (s: string) =>
  COLOUR ? `${ESC}[${code}m${s}${ESC}[0m` : s

export const bold = paint('1')
export const dim = paint('2')
export const green = paint('32')
export const amber = paint('33')
export const red = paint('31')
export const cyan = paint('36')

export function say(line = ''): void {
  console.log(line)
}

export function heading(text: string): void {
  console.log('')
  console.log(bold(text))
}

export function kv(label: string, value: string, width = 22): void {
  console.log('  ' + dim(label.padEnd(width)) + value)
}

export function bullet(text: string): void {
  console.log('  ' + dim('-') + ' ' + text)
}

export function ok(text: string): void {
  console.log('')
  console.log(green('* ') + text)
}

export function warn(text: string): void {
  console.log(amber('! ') + text)
}

export function fail(text: string): never {
  console.error('')
  console.error(red('x ') + text)
  process.exit(1)
}

export function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log('  ' + dim('none'))
    return
  }
  const w = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const line = (cells: string[], p: (s: string) => string) =>
    '  ' + cells.map((c, i) => p((c ?? '').padEnd(w[i]!))).join('  ')

  console.log(line(headers.map((h) => h.toUpperCase()), dim))
  console.log('  ' + w.map((n) => dim('-'.repeat(n))).join('  '))
  for (const r of rows) console.log(line(r, (s) => s))
}

/** For a reader: 2026-08-26 23:08 UTC. */
export function when(value: Date | null | undefined): string {
  if (!value) return '--'
  const iso = value.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}
