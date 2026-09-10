// Derives web-sized copies of the accepted VIPER logos (doc/design/visual-manifest.md) using Node's stdlib only.
// Crop to the alpha bounding box, box-downsample by an integer factor with premultiplied alpha, re-encode as
// 8-bit RGBA PNG without ancillary chunks. Alpha is preserved; nothing is ever painted behind the artwork.
// Usage (from frontend/): npm run brand:assets
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'

const SOURCE_DIR = '../tasks/viper_v1_implementation_handoff_reviewed/visuals'
const ASSET_DIR = 'src/assets/brand'
const PUBLIC_DIR = 'public'
const LOGOS = [
  'viper-mark-black',
  'viper-mark-white',
  'viper-lockup-black',
  'viper-lockup-white',
  'viper-mark-black-neon-green',
  'viper-mark-neon-green-black',
]
const MAX_SIDE = 640 // after cropping; covers a 320 px hero at 2x DPR
const FAVICON_SIDE = 64
const FAVICONS = { 'favicon-dark': 'viper-mark-white', 'favicon-light': 'viper-mark-black' }
const MARGIN_RATIO = 0.02 // transparent breathing room around the artwork so anti-aliased tips never touch the edge
const NOISE_ALPHA = 2// source files carry invisible alpha 1-2 haze; cleared so the background is truly empty
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function readPng(path) {
  const buf = readFileSync(path)
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${path}: not a PNG`)
  let offset = 8
  let header
  const idat = []
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  if (header?.depth !== 8 || header.colorType !== 6 || header.interlace !== 0) {
    throw new Error(`${path}: expected non-interlaced 8-bit RGBA`)
  }
  const { width, height } = header
  const stride = width * 4
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]
      const a = x >= 4 ? pixels[y * stride + x - 4] : 0
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0
      pixels[y * stride + x] = (value + predict(filter, a, b, c)) & 255
    }
  }
  return { width, height, pixels }
}

function predict(filter, a, b, c) {
  switch (filter) {
    case 0: return 0
    case 1: return a
    case 2: return b
    case 3: return (a + b) >> 1
    case 4: {
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    default: throw new Error(`unknown PNG filter ${String(filter)}`)
  }
}

function alphaBounds({ width, height, pixels }) {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] > NOISE_ALPHA) {
        left = Math.min(left, x); right = Math.max(right, x)
        top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
    }
  }
  const margin = Math.round(MARGIN_RATIO * Math.max(right - left, bottom - top))
  return { left: left - margin, top: top - margin, width: right - left + 1 + 2 * margin, height: bottom - top + 1 + 2 * margin }
}

// Averages `factor`×`factor` source blocks over `box` (optionally padded to a square); padding stays transparent.
function downsample(image, box, factor, square = false) {
  const outWidth = Math.ceil((square ? Math.max(box.width, box.height) : box.width) / factor)
  const outHeight = square ? outWidth : Math.ceil(box.height / factor)
  const originX = box.left - Math.floor((outWidth * factor - box.width) / 2)
  const originY = box.top - Math.floor((outHeight * factor - box.height) / 2)
  const out = Buffer.alloc(outWidth * outHeight * 4)
  for (let oy = 0; oy < outHeight; oy++) {
    for (let ox = 0; ox < outWidth; ox++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const x = originX + ox * factor + dx
          const y = originY + oy * factor + dy
          if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue
          const i = (y * image.width + x) * 4
          const alpha = image.pixels[i + 3] > NOISE_ALPHA ? image.pixels[i + 3] : 0
          r += image.pixels[i] * alpha; g += image.pixels[i + 1] * alpha; b += image.pixels[i + 2] * alpha; a += alpha
        }
      }
      const o = (oy * outWidth + ox) * 4
      const alpha = Math.round(a / (factor * factor))
      if (alpha > 0) {
        out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); out[o + 3] = alpha
      }
    }
  }
  return { width: outWidth, height: outHeight, pixels: out }
}

function encodePng({ width, height, pixels }) {
  const stride = width * 4
  const rows = []
  for (let y = 0; y < height; y++) {
    let best
    for (let filter = 0; filter <= 4; filter++) {
      const row = Buffer.alloc(stride + 1)
      row[0] = filter
      let cost = 0
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? pixels[y * stride + x - 4] : 0
        const b = y > 0 ? pixels[(y - 1) * stride + x] : 0
        const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0
        const value = (pixels[y * stride + x] - predict(filter, a, b, c)) & 255
        row[x + 1] = value
        cost += value < 128 ? value : 256 - value
      }
      if (!best || cost < best.cost) best = { row, cost }
    }
    rows.push(best.row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const idat = deflateSync(Buffer.concat(rows), { level: 9, memLevel: 9 })
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

mkdirSync(ASSET_DIR, { recursive: true })
mkdirSync(PUBLIC_DIR, { recursive: true })
const sources = new Map(LOGOS.map((name) => [name, readPng(`${SOURCE_DIR}/${name}.png`)]))

for (const [name, image] of sources) {
  const box = alphaBounds(image)
  const factor = Math.ceil(Math.max(box.width, box.height) / MAX_SIDE)
  const png = encodePng(downsample(image, box, factor))
  writeFileSync(`${ASSET_DIR}/${name}.png`, png)
  console.log(`${ASSET_DIR}/${name}.png  ${String(png.length)} bytes`)
}

for (const [favicon, name] of Object.entries(FAVICONS)) {
  const image = sources.get(name)
  const box = alphaBounds(image)
  const factor = Math.ceil(Math.max(box.width, box.height) / FAVICON_SIDE)
  const png = encodePng(downsample(image, box, factor, true))
  writeFileSync(`${PUBLIC_DIR}/${favicon}.png`, png)
  console.log(`${PUBLIC_DIR}/${favicon}.png  ${String(png.length)} bytes`)
}
