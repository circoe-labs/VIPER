import type { ReviewVerdict as Verdict } from '../api/contact'
import { Button } from '../ui/Button'
import { CheckIcon, CloseIcon } from '../ui/icons'

interface ReviewVerdictProps {
  verdict: Verdict | null
  reviewedBy: string | null
  // The text is being edited, or a save is running: the verdict is given on the saved text only.
  disabled: boolean
  loading: Verdict | null
  onChoose: (verdict: Verdict | null) => void
}

// « Texte IA : Correct / À revoir »: a person's quick verdict on the mail as it stands. It validates, schedules and
// sends nothing; pressing the chosen button again takes the verdict back, and any edit of the text starts clean.
export function ReviewVerdictControl({ verdict, reviewedBy, disabled, loading, onChoose }: ReviewVerdictProps) {
  const choose = (next: Verdict) => {
    onChoose(verdict === next ? null : next)
  }
  return (
    <div className="contact-mail__review" role="group" aria-label="Avis sur le texte">
      <span className="visually-hidden">Texte du mail :</span>
      <Button
        size="sm"
        icon={CheckIcon}
        title={verdict === 'correct' && reviewedBy ? `Texte relu et jugé correct par ${reviewedBy}` : 'Texte du mail : correct'}
        variant={verdict === 'correct' ? 'primary' : 'secondary'}
        aria-label="Correct"
        aria-pressed={verdict === 'correct'}
        loading={loading === 'correct'}
        disabled={disabled}
        onClick={() => {
          choose('correct')
        }}
      >
        <span className="mail-bar__label">Correct</span>
      </Button>
      <Button
        size="sm"
        icon={CloseIcon}
        title={verdict === 'to_revise' && reviewedBy ? `Texte à revoir, selon ${reviewedBy}` : 'Texte du mail : à revoir'}
        variant={verdict === 'to_revise' ? 'primary' : 'secondary'}
        aria-label="À revoir"
        aria-pressed={verdict === 'to_revise'}
        loading={loading === 'to_revise'}
        disabled={disabled}
        onClick={() => {
          choose('to_revise')
        }}
      >
        <span className="mail-bar__label">À revoir</span>
      </Button>
      {verdict && reviewedBy && <span className="visually-hidden">relu par {reviewedBy}</span>}
    </div>
  )
}
