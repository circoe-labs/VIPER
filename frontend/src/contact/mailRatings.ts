// « Mails sauvegardés »: a text kept with the config it was generated with and a human note (0-10 and a comment).
import type { MessageVersion } from '../api/contact'
import type { StatusTone } from '../ui/Badge'

export const RATING_MIN = 0
export const RATING_MAX = 10
export const RATING_VALUES: readonly number[] = Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, index) => index)
// The meaning of the ends of the scale, said on hover.
export const RATING_ENDS = {
  low: 'Vraiment de la merde, ne fais plus jamais ça',
  high: 'Super, garde ce style',
} as const

// 0-3 bad, 4-6 so-so, 7-10 good: the tone of a rating chip (shape + number, never colour alone).
export function ratingTone(rating: number): StatusTone {
  if (rating <= 3) return 'danger'
  if (rating <= 6) return 'warning'
  return 'success'
}

const SENDERS = { ai: 'expéditeur IA', person: 'expéditeur personne' } as const

// « Ton 3 · expéditeur IA · gpt-5 · humanizer 82 »: the config of a version, short.
export function configSummary(config: MessageVersion['config']): string {
  const parts: string[] = []
  if (config.tone !== undefined) parts.push(`ton ${String(config.tone)}`)
  if (config.sender) parts.push(SENDERS[config.sender])
  if (config.model) parts.push(config.model)
  if (config.humanizer_score !== undefined) parts.push(`humanizer ${String(config.humanizer_score)}`)
  const text = parts.join(' · ')
  // « Ton 2 · expéditeur IA… » starts with a capital; a model name keeps its own spelling.
  return config.tone !== undefined || config.sender ? text.charAt(0).toUpperCase() + text.slice(1) : text
}
