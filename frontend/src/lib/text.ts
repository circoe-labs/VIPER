// Text comparison matching the backend's `label_key` (migration 0005): trimmed, inner whitespace collapsed,
// accents and ligatures folded, lowercase. Used to filter pickers and to tell whether a typed value already exists.
export function foldText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim()
}

// Every word of `query` appears in `text`, both folded (same rule as the API's `q` search).
export function matchesWords(text: string, query: string): boolean {
  const haystack = foldText(text)
  return foldText(query)
    .split(' ')
    .every((word) => haystack.includes(word))
}
