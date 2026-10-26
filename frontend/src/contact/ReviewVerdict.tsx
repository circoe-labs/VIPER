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
      <span className="contact-mail__review-label">Texte du mail :</span>
      <Button
        size="sm"
        icon={CheckIcon}
        variant={verdict === 'correct' ? 'primary' : 'secondary'}
        aria-pressed={verdict === 'correct'}
        loading={loading === 'correct'}
        disabled={disabled}
        onClick={() => {
          choose('correct')
        }}
      >
        Correct
      </Button>
      <Button
        size="sm"
        icon={CloseIcon}
        variant={verdict === 'to_revise' ? 'primary' : 'secondary'}
        aria-pressed={verdict === 'to_revise'}
        loading={loading === 'to_revise'}
        disabled={disabled}
        onClick={() => {
          choose('to_revise')
        }}
      >
        À revoir
      </Button>
      {verdict && reviewedBy && <span className="contact-mail__review-by">relu par {reviewedBy}</span>}
    </div>
  )
}
