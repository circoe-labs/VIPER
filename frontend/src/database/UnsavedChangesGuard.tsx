import { useEffect } from 'react'
import { useBlocker } from 'react-router'

import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'

interface UnsavedChangesGuardProps {
  // Something is staged and would be lost.
  dirty: boolean
  table: string
  summary: string
}

// Warns before staged changes are lost: leaving the table (rail, relationship link, Back, another page) asks for
// confirmation; reloading or closing the tab triggers the browser's own prompt. Grid criteria (filters, sort, page)
// stay on the same table and keep the changes.
export function UnsavedChangesGuard({ dirty, table, summary }: UnsavedChangesGuardProps) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
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

  if (blocker.state !== 'blocked') return null
  return (
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
            Rester sur {table}
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
        {summary} sur <strong>{table}</strong>. Si vous quittez cette table maintenant, elles seront perdues.
      </p>
    </Modal>
  )
}
