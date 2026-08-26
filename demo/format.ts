/**
 * Formatting for a shared screen, read at a distance.
 *
 * Wide, labelled, spaced out. Each moment prints the one thing that matters
 * and nothing else: no ids, no elapsed times, no debug noise. Anything a
 * person in the third row has to squint at is a line that should not be there.
 */

const FAST = process.argv.includes('--fast')
const COLOUR = !process.env.NO_COLOR

const W = Math.min(Math.max(process.stdout.columns ?? 96, 84), 100)
const ESC = String.fromCharCode(27)

const wrap = (code: string) => (s: string) =>
  COLOUR ? `${ESC}[${code}m${s}${ESC}[0m` : s

export const bold = wrap('1')
export const dim = wrap('2')
export const cyan = wrap('36')
export const green = wrap('32')
export const amber = wrap('33')

export function banner(title: string, lines: string[]): void {
  console.log('')
  console.log(cyan('  ' + '='.repeat(W - 4)))
  console.log('  ' + bold(title))
  for (const l of lines) console.log('  ' + dim(l))
  console.log(cyan('  ' + '='.repeat(W - 4)))
}

let stepNo = 0
export function step(title: string): void {
  stepNo += 1
  const label = `  ${stepNo} / 6   ${title}`
  console.log('')
  console.log('')
  console.log('  ' + cyan('+' + '-'.repeat(W - 6) + '+'))
  console.log('  ' + cyan('|') + bold(label.padEnd(W - 6)) + cyan('|'))
  console.log('  ' + cyan('+' + '-'.repeat(W - 6) + '+'))
  console.log('')
}

/** The single sentence a moment exists to land. */
export function point(text: string): void {
  console.log('')
  console.log('  ' + green('>>') + '  ' + bold(text))
}

export function note(text: string): void {
  console.log('  ' + dim(text))
}

export function field(label: string, value: string, width = 26): void {
  console.log('  ' + dim(label.padEnd(width)) + value)
}

/** A long value, wrapped to the screen with a hanging indent under the label. */
export function fieldWrapped(label: string, value: string, width = 26): void {
  const room = W - width - 4
  const words = value.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current && (current + ' ' + word).length > room) {
      lines.push(current)
      current = word
    } else {
      current = current ? current + ' ' + word : word
    }
  }
  if (current) lines.push(current)

  lines.forEach((line, i) => {
    console.log('  ' + dim((i === 0 ? label : '').padEnd(width)) + line)
  })
}

export function rule(): void {
  console.log('  ' + cyan('='.repeat(W - 4)))
}

export function blank(): void {
  console.log('')
}

/** A plain aligned table. Inner borders cost legibility at a distance. */
export function table(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log('    ' + dim('none'))
    return
  }
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const render = (cells: string[], paint: (s: string) => string) =>
    '  ' + cells.map((c, i) => paint((c ?? '').padEnd(widths[i]!))).join('   ')

  console.log(render(headers.map((h) => h.toUpperCase()), dim))
  console.log('  ' + widths.map((w) => dim('-'.repeat(w))).join('   '))
  for (const r of rows) console.log(render(r, (s) => s))
}

export async function pause(label = 'Enter to continue'): Promise<void> {
  if (FAST || !process.stdin.isTTY) {
    console.log('')
    return
  }
  process.stdout.write('\n  ' + dim(`${label} >`) + ' ')
  await new Promise<void>((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', () => {
      process.stdin.pause()
      resolve()
    })
  })
}

/** For a reader, not a log. 2026-08-26 23:08 UTC. */
export function when(value: Date | null | undefined): string {
  if (!value) return '--'
  const iso = value.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/**
 * A table whose last column wraps instead of truncating, for content that is
 * a sentence rather than a label. Continuation lines are indented under the
 * column so the eye can follow one row down the page.
 */
export function tableWrapped(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log('    ' + dim('none'))
    return
  }
  const last = headers.length - 1
  const fixed = headers.slice(0, last).map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const used = fixed.reduce((a, b) => a + b + 3, 0)
  const room = Math.max(24, W - used - 6)

  const lead = (cells: string[], paint: (s: string) => string) =>
    cells.map((c, i) => paint((c ?? '').padEnd(fixed[i]!))).join('   ')

  console.log('  ' + lead(headers.slice(0, last).map((h) => h.toUpperCase()), dim) +
    '   ' + dim(headers[last]!.toUpperCase()))
  console.log('  ' + fixed.map((w) => dim('-'.repeat(w))).join('   ') +
    '   ' + dim('-'.repeat(room)))

  for (const r of rows) {
    const words = (r[last] ?? '').split(/\s+/)
    const lines: string[] = []
    let current = ''
    for (const word of words) {
      if (current && (current + ' ' + word).length > room) {
        lines.push(current)
        current = word
      } else {
        current = current ? current + ' ' + word : word
      }
    }
    lines.push(current)

    lines.forEach((line, i) => {
      const cells = i === 0 ? r.slice(0, last) : fixed.map(() => '')
      console.log('  ' + lead(cells, (x) => x) + '   ' + line)
    })
  }
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - 1) + '...'
}
