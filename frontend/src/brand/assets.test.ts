import { describe, expect, it } from 'vitest'

// The committed logo files, decoded for real: each must be RGBA with a fully transparent outer ring (no background
// box baked in) and actual artwork inside.
const LOGOS = import.meta.glob<string>('../assets/brand/*.png', { query: '?inline', import: 'default', eager: true })

const ACCEPTED = [
  'viper-lockup-black.png',
  'viper-lockup-white.png',
  'viper-mark-black-neon-green.png',
  'viper-mark-black.png',
  'viper-mark-neon-green-black.png',
  'viper-mark-white.png',
]

interface Rgba {
  width: number
  height: number
  alpha: (x: number, y: number) => number
}

async function decodePng(dataUrl: string): Promise<Rgba> {
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1] ?? ''), (char) => char.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  let offset = 8
  let width = 0
  let height = 0
  const idat: Uint8Array[] = []
  while (offset < bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      expect([bytes[offset + 16], bytes[offset + 17], bytes[offset + 20]], 'depth / colour type / interlace').toEqual([8, 6, 0])
    }
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const joined = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0))
  let at = 0
  for (const chunk of idat) {
    joined.set(chunk, at)
    at += chunk.length
  }
  const compressed = new Response(joined).body
  if (!compressed) throw new Error('empty PNG stream')
  const raw = new Uint8Array(await new Response(compressed.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())

  const stride = width * 4
  const pixels = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0
      const a = x >= 4 ? (pixels[y * stride + x - 4] ?? 0) : 0
      const b = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0
      const c = x >= 4 && y > 0 ? (pixels[(y - 1) * stride + x - 4] ?? 0) : 0
      const p = a + b - c
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter ?? 0] ?? 0
      pixels[y * stride + x] = (value + predictor) & 255
    }
  }
  return { width, height, alpha: (x, y) => pixels[y * stride + x * 4 + 3] ?? 0 }
}

describe('brand assets', () => {
  it('ships exactly the six accepted logo variants', () => {
    expect(Object.keys(LOGOS).map((path) => path.split('/').pop()).sort()).toEqual(ACCEPTED)
  })

  it.each(Object.entries(LOGOS))('%s keeps a transparent background around real artwork', async (_path, dataUrl) => {
    const image = await decodePng(dataUrl)
    let transparent = 0
    let solid = 0
    let ring = 0
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const alpha = image.alpha(x, y)
        if (alpha === 0) transparent++
        if (alpha >= 250) solid++
        if ((x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) && alpha !== 0) ring++
      }
    }
    const total = image.width * image.height
    expect(ring, 'opaque pixels on the outer edge').toBe(0)
    expect(transparent / total).toBeGreaterThan(0.5)
    expect(solid / total).toBeGreaterThan(0.1)
  })
})
