// Where each campaign cohort stands (as given by the Humain, 2026-10-06): the follow-up already sent to it, or the
// Monday its first send is planned for. `S0` (refuses emailing) and unknown cohorts have no mark. Shared by the
// import's « Envoi » column and the Home campaign statistics.
export interface SendMark {
  label: string
  tone: 'sent' | 'planned'
}

const SEND_MARKS: Record<string, SendMark> = {
  S37: { label: 'R2', tone: 'sent' },
  S39: { label: 'R1', tone: 'sent' },
  S40: { label: 'Envoyé', tone: 'sent' },
  S41: { label: '12 octobre', tone: 'planned' },
  S42: { label: '19 octobre', tone: 'planned' },
  S43: { label: '26 octobre', tone: 'planned' },
}

export function sendMarkOf(cohortCode: string | null | undefined): SendMark | null {
  const code = cohortCode?.toUpperCase()
  return code ? (SEND_MARKS[code] ?? null) : null
}
