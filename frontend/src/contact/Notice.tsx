import { AlertIcon, CheckCircleIcon } from '../ui/icons'

// The outcome of the last action of a panel: announced by an always-present live region (hidden), and shown under the
// form only once there is something to say (so an empty line takes no room). `warning`: the action succeeded but
// something around it did not (a validation whose Infomaniak draft could not be created).
// `quiet`: only the live region — the caller shows the outcome some other way (an icon with its detail).
export function Notice({ text, tone = 'success', quiet = false }: { text: string | null; tone?: 'success' | 'warning'; quiet?: boolean }) {
  return (
    <>
      <p className="visually-hidden" role="status">
        {text ?? ''}
      </p>
      {text && !quiet && (
        <p className={`contact-panel__notice contact-panel__notice--${tone}`} aria-hidden="true">
          {tone === 'warning' ? <AlertIcon size={16} /> : <CheckCircleIcon size={16} />}
          {text}
        </p>
      )}
    </>
  )
}
