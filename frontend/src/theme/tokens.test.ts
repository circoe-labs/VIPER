import { describe, expect, it } from 'vitest'

import tokensCss from './tokens.css?raw'

type Tokens = Map<string, string>

// Declarations per rule block of tokens.css, keyed by the block's selector.
function parseBlocks(css: string): Map<string, Tokens> {
  const blocks = new Map<string, Tokens>()
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const [, selector = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const key = selector.replace(/\s+/g, ' ').trim()
    const tokens = blocks.get(key) ?? new Map<string, string>()
    for (const [, name = '', value = ''] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(name, value.replace(/\s+/g, ' ').trim())
    }
    blocks.set(key, tokens)
  }
  return blocks
}

const blocks = parseBlocks(tokensCss)
const base = blocks.get(':root') ?? new Map<string, string>()
const darkBlock = blocks.get(":root, :root[data-theme='dark']") ?? new Map<string, string>()
const lightBlock = blocks.get(":root[data-theme='light']") ?? new Map<string, string>()

// Cascade as the browser applies it: the dark block's bare `:root` also matches in light mode.
const THEMES: Record<'dark' | 'light', Tokens> = {
  dark: new Map([...base, ...darkBlock]),
  light: new Map([...base, ...darkBlock, ...lightBlock]),
}

function resolve(tokens: Tokens, name: string): string {
  let value = tokens.get(name)
  for (let depth = 0; value?.startsWith('var(') && depth < 10; depth++) {
    value = tokens.get(value.slice(4, -1).trim())
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} does not resolve to a hex colour: ${String(value)}`)
  return value
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r = 0, g = 0, b = 0] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

const SURFACES = ['canvas', 'surface', 'surface-raised', 'surface-hover', 'field']

// [foreground, background] pairs that carry text: WCAG AA 4.5:1.
const TEXT_PAIRS: [string, string][] = [
  ...SURFACES.flatMap((bg): [string, string][] => [
    ['text', bg],
    ['text-muted', bg],
    ['accent-fg', bg],
    ['danger-fg', bg],
  ]),
  ['accent-fg', 'accent-soft'],
  ['accent-2-fg', 'surface'],
  ['warning-fg', 'surface'],
  ['on-accent', 'accent'],
  ['on-accent', 'accent-hover'],
  ['on-danger', 'danger'],
  ['on-danger', 'danger-fg'],
  ['warning-fg', 'warning-soft'],
  ['danger-fg', 'danger-soft'],
  ['success-fg', 'success-soft'],
  ['info-fg', 'info-soft'],
  ['neutral-fg', 'neutral-soft'],
]

// Non-text UI that must be perceivable (focus ring, field boundaries, switch thumb): WCAG 1.4.11 3:1.
const UI_PAIRS: [string, string][] = [
  ...SURFACES.map((bg): [string, string] => ['focus', bg]),
  ['border-strong', 'field'],
  ['border-strong', 'surface'],
  ['accent-fg', 'accent-soft'],
]

describe.each(['dark', 'light'] as const)('%s theme tokens', (theme) => {
  const tokens = THEMES[theme]

  it.each(TEXT_PAIRS)('--color-%s on --color-%s reaches 4.5:1', (fg, bg) => {
    const ratio = contrast(resolve(tokens, `--color-${fg}`), resolve(tokens, `--color-${bg}`))
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it.each(UI_PAIRS)('--color-%s against --color-%s reaches 3:1', (fg, bg) => {
    const ratio = contrast(resolve(tokens, `--color-${fg}`), resolve(tokens, `--color-${bg}`))
    expect(ratio).toBeGreaterThanOrEqual(3)
  })
})

describe('token structure', () => {
  it('keeps the Neon Command core palette values', () => {
    expect(Object.fromEntries(base)).toMatchObject({
      '--nc-void': '#0A0B0D',
      '--nc-charcoal': '#1B2329',
      '--nc-slate': '#2E3A40',
      '--nc-viper-green': '#00E676',
      '--nc-teal': '#00C2B8',
      '--nc-ice': '#EAF2F1',
      '--nc-deep-emerald': '#10261F',
    })
  })

  it('redefines every dark colour role in the light theme', () => {
    const roles = (tokens: Tokens) => [...tokens.keys()].filter((name) => name.startsWith('--color-')).sort()
    expect(roles(lightBlock)).toEqual(roles(darkBlock))
  })

  it('uses raw colour values only in the palette layer', () => {
    const semantic = [...darkBlock, ...lightBlock].filter(([, value]) => /#[0-9a-f]{3,8}\b/i.test(value))
    expect(semantic).toEqual([])
  })
})

describe('no scattered colours', () => {
  const sources = import.meta.glob<string>(['/src/**/*.{css,ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/theme/tokens.css'], {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  it('scans the source tree', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20)
  })

  it.each(Object.entries(sources))('%s has no raw colour literal', (_path, source) => {
    expect(source).not.toMatch(/#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?\b(?![\w-])/i)
    expect(source).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i)
  })
})
