import './score-ring.css'

export type ScoreRingTone = 'danger' | 'warning' | 'success' | 'neutral'

interface ScoreRingProps {
  // 0-100; anything else is clamped and rounded (the ring never draws past its circle).
  value: number
  // The caller decides the tone (a score's band comes from its backend, never from thresholds here).
  tone: ScoreRingTone
  size?: 'md' | 'lg'
}

const RADIUS = 44

// Ring gauge 0-100 with the value as text in its centre: decorative for assistive technologies (`aria-hidden`), the
// owner names the value in words (« 50 sur 100 »). Colour only reinforces the tone; the number and the arc length
// carry the value. Colours are tokens (score-ring.css).
export function ScoreRing({ value, tone, size = 'md' }: ScoreRingProps) {
  const shown = Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0
  return (
    <svg className={`score-ring score-ring--${size}`} data-tone={tone} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle className="score-ring__track" cx="50" cy="50" r={RADIUS} pathLength={100} />
      {shown > 0 && (
        <circle
          className="score-ring__arc"
          cx="50"
          cy="50"
          r={RADIUS}
          pathLength={100}
          strokeDasharray={`${String(shown)} ${String(100 - shown)}`}
          transform="rotate(-90 50 50)"
        />
      )}
      <text className="score-ring__value" x="50" y="50" textAnchor="middle" dominantBaseline="central">
        {shown}
      </text>
    </svg>
  )
}
