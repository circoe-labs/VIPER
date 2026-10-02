import { useCallback, useEffect, useState } from 'react'
import { useBlocker, useLocation, useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import { useProspect } from '../api/prospects'
import { SequenceSection } from '../prospects/SequenceSection'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, SpinnerIcon } from '../ui/icons'
import { FROM_LIST, openedFromList } from './criteria'
import { MailSequence } from './MailSequence'
import { ProspectSheet } from './ProspectSheet'
import { TrackingPanel } from './TrackingPanel'

export interface Neighbours {
  // 1-based position in the list page, and its size.
  position: number
  count: number
  previous: string | null
  next: string | null
}

interface WorkbenchProps {
  prospectId: string
  // The list URL (the workbench closed), and the URL opening another prospect.
  listHref: string
  openHref: (id: string) => string
  // Where the prospect sits in the list shown before; null when it is not in it (filters changed, state moved…).
  neighbours: Neighbours | null
}

// The prospect of a URL: the workbench is open on one prospect at a time.
function prospectOf(search: string): string | null {
  return new URLSearchParams(search).get('prospect')
}

// The Contact workbench (decision 19): the prospect sheet on the left — read-mostly, with the manual state and week —
// and the mail sequence on the right. It replaces the list while open (Back or « Liste » return to it, focus on the
// person); « Précédent » / « Suivant » walk the list. Leaving the prospect with unsaved text (a mail or the follow-up)
// asks first; reloading or closing the tab triggers the browser's own prompt.
export function Workbench({ prospectId, listHref, openHref, neighbours }: WorkbenchProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const fromList = openedFromList(location.state)
  const loaded = useProspect(prospectId)
  const [dirtyMail, setDirtyMail] = useState(false)
  const [dirtyTracking, setDirtyTracking] = useState(false)
  const dirty = dirtyMail || dirtyTracking
  const onMailDirty = useCallback((value: boolean) => {
    setDirtyMail(value)
  }, [])
  const onTrackingDirty = useCallback((value: boolean) => {
    setDirtyTracking(value)
  }, [])

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        prospectOf(currentLocation.search) !== prospectOf(nextLocation.search)),
  )
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
    }
  }, [dirty])

  // Back is « Retour à la liste »: opened from the list, returning goes back to its entry; the walk replaces the
  // current entry, so Back never reopens a prospect that was left.
  const backToList = () => {
    if (fromList) void navigate(-1)
    else void navigate(listHref, { replace: true })
  }
  const walk = (id: string) => {
    void navigate(openHref(id), { replace: true, state: fromList ? FROM_LIST : null })
  }

  return (
    <div className="contact-bench">
      <nav className="contact-bench__bar" aria-label="Parcours de la liste">
        <Button
          size="sm"
          variant="ghost"
          icon={ArrowLeftIcon}
          onClick={backToList}
        >
          Retour à la liste
        </Button>
        {neighbours && (
          <div className="contact-bench__walk">
            <span className="contact-bench__position">
              {neighbours.position} sur {neighbours.count}
            </span>
            <Button
              size="sm"
              icon={ChevronLeftIcon}
              disabled={!neighbours.previous}
              onClick={() => {
                if (neighbours.previous) walk(neighbours.previous)
              }}
            >
              Précédent
            </Button>
            <Button
              size="sm"
              icon={ChevronRightIcon}
              disabled={!neighbours.next}
              onClick={() => {
                if (neighbours.next) walk(neighbours.next)
              }}
            >
              Suivant
            </Button>
          </div>
        )}
        {!neighbours && loaded.data && (
          <span className="contact-bench__position">Hors de la liste affichée (filtres ou état changés)</span>
        )}
      </nav>

      {/* The sheet and the mail sequence load side by side. */}
      <div className="contact-bench__panels">
        <aside className="contact-bench__prospect" aria-label="Fiche du prospect">
          {loaded.isPending && (
            <p className="contact-panel__status" role="status">
              <SpinnerIcon size={18} className="btn__spinner" />
              Chargement de la fiche…
            </p>
          )}
          {loaded.isError && (
            <div className="contact-panel__error" role="alert">
              <AlertIcon size={16} />
              <span>
                {loaded.error instanceof ApiError && loaded.error.status === 404
                  ? 'Ce prospect n’existe plus : il a peut-être été supprimé entre-temps.'
                  : `La fiche n’a pas pu être lue (${loaded.error.message}).`}
              </span>
              <Button size="sm" onClick={() => void loaded.refetch()}>
                Réessayer
              </Button>
            </div>
          )}
          {loaded.data && (
            <>
              <ProspectSheet prospect={loaded.data} />
              <TrackingPanel key={loaded.data.id} prospect={loaded.data} onDirtyChange={onTrackingDirty} />
              <SequenceSection key={`sequence-${loaded.data.id}`} prospect={loaded.data} />
            </>
          )}
        </aside>
        <div className="contact-bench__mail">
          <MailSequence key={prospectId} prospectId={prospectId} onDirtyChange={onMailDirty} />
        </div>
      </div>

      {blocker.state === 'blocked' && (
        <Modal
          open
          size="sm"
          title="Modifications non enregistrées"
          onClose={() => {
            blocker.reset()
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  blocker.reset()
                }}
              >
                Rester sur ce prospect
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  blocker.proceed()
                }}
              >
                Quitter sans enregistrer
              </Button>
            </>
          }
        >
          <p>
            {dirtyMail && dirtyTracking
              ? 'Un message et le suivi de contact ont des modifications non enregistrées.'
              : dirtyMail
                ? 'Un message a des modifications non enregistrées.'
                : 'Le suivi de contact a des modifications non enregistrées.'}{' '}
            Si vous quittez ce prospect maintenant, elles seront perdues.
          </p>
        </Modal>
      )}
    </div>
  )
}
