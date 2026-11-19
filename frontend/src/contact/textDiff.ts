// A simple line diff for the « Versions » comparison: the longest common subsequence of lines, shown side by side.
// A text is a mail (a few dozen lines), so the quadratic table is fine; beyond `MAX_LINES` the comparison says so
// instead of freezing the page.

export type DiffKind = 'same' | 'removed' | 'added'

export interface DiffRow {
  kind: DiffKind
  // The line of the older text (`before`) and of the newer one (`after`); null on the side where the line is absent.
  before: string | null
  after: string | null
}

export const MAX_LINES = 1500

export function diffLines(before: string, after: string): DiffRow[] | null {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null
  // lcs(i, j) = length of the longest common subsequence of a[i..] and b[j..]
  const width = b.length + 1
  const table = new Array<number>((a.length + 1) * width).fill(0)
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1))
    }
  }
  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    const left = a[i]
    const right = b[j]
    if (left !== undefined && right !== undefined && left === right) {
      rows.push({ kind: 'same', before: left, after: right })
      i += 1
      j += 1
    } else if (right !== undefined && (left === undefined || lcs(i, j + 1) >= lcs(i + 1, j))) {
      rows.push({ kind: 'added', before: null, after: right })
      j += 1
    } else if (left !== undefined) {
      rows.push({ kind: 'removed', before: left, after: null })
      i += 1
    }
  }
  return rows
}

// Pairs a run of removed lines with the added lines of the same run, so a reworded line reads on one row.
export function pairChanges(rows: readonly DiffRow[]): DiffRow[] {
  const out: DiffRow[] = []
  let index = 0
  while (index < rows.length) {
    const row = rows[index]
    if (row === undefined) break
    if (row.kind === 'same') {
      out.push(row)
      index += 1
      continue
    }
    const removed: string[] = []
    const added: string[] = []
    // A run of changes: removed and added lines, in whatever order the walk met them.
    while (index < rows.length && rows[index]?.kind !== 'same') {
      const change = rows[index]
      if (change?.before != null) removed.push(change.before)
      if (change?.after != null) added.push(change.after)
      index += 1
    }
    const count = Math.max(removed.length, added.length)
    for (let k = 0; k < count; k += 1) {
      const before = removed[k] ?? null
      const after = added[k] ?? null
      out.push({ kind: after === null ? 'removed' : before === null ? 'added' : 'removed', before, after })
    }
  }
  return out
}
