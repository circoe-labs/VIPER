import { CheckCircleIcon } from '../ui/icons'

// The outcome of the last action of a panel: announced by an always-present live region (hidden), and shown under the
// form only once there is something to say (so an empty line takes no room).
export function Notice({ text }: { text: string | null }) {
  return (
    <>
      <p className="visually-hidden" role="status">
        {text ?? ''}
      </p>
      {text && (
        <p className="contact-panel__notice" aria-hidden="true">
          <CheckCircleIcon size={16} />
          {text}
        </p>
      )}
    </>
  )
}
