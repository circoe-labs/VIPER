import type { MissionHue } from './missionAccent'

// Pure arithmetic of the Mission donut (no React: unit-tested). See CONTRACT.md §2.5 for when a donut is allowed.

export interface DonutInput {
  key: string
  label: string
  value: number
  hue: MissionHue
}

export interface DonutSegment extends DonutInput {
  // 0-1 share of the total; 0 when the total is 0.
  share: number
  // Arc start and length on a circle of pathLength 100.
  start: number
  length: number
}

export interface DonutModel {
  total: number
  segments: DonutSegment[]
  // True when the smallest categories were folded into « Autres ».
  folded: boolean
}

// More categories than this stop being comparable by angle: the tail is folded into « Autres ».
export const DONUT_MAX_SEGMENTS = 6
const PERCENT = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 })
const COUNT = new Intl.NumberFormat('fr-FR')

export function formatShare(share: number): string {
  return PERCENT.format(share)
}

export function formatDonutCount(value: number): string {
  return COUNT.format(value)
}

function clean(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function donutModel(inputs: DonutInput[], maxSegments: number = DONUT_MAX_SEGMENTS): DonutModel {
  let rows = inputs.map((input) => ({ ...input, value: clean(input.value) }))
  let folded = false
  if (rows.length > maxSegments) {
    const ranked = [...rows].sort((a, b) => b.value - a.value)
    const kept = new Set(ranked.slice(0, maxSegments - 1).map((row) => row.key))
    const tail = rows.filter((row) => !kept.has(row.key))
    rows = [
      ...rows.filter((row) => kept.has(row.key)),
      { key: 'other', label: 'Autres', value: tail.reduce((sum, row) => sum + row.value, 0), hue: 'neutral' as const },
    ]
    folded = true
  }
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  let start = 0
  const segments = rows.map((row) => {
    const share = total === 0 ? 0 : row.value / total
    const segment = { ...row, share, start, length: share * 100 }
    start += segment.length
    return segment
  })
  return { total, segments, folded }
}

// Text alternative of the ring: every category with its figure and share, then the total.
export function donutSummary(title: string, model: DonutModel, unit: string): string {
  if (model.total === 0) return `${title} : aucune donnée.`
  const parts = model.segments.map(
    (segment) => `${segment.label} ${formatDonutCount(segment.value)} (${formatShare(segment.share)})`,
  )
  return `${title} : ${parts.join(', ')}. Total : ${formatDonutCount(model.total)} ${unit}.`
}
