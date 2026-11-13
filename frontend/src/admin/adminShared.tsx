import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { ApiError } from '../api/client'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, SpinnerIcon, TrashIcon } from '../ui/icons'
import './admin.css'

// The server's own refusal sentence (403 « Only an administrator… », 409 in use, 422 invalid field), else a fallback.
export function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback
}

export function ErrorNote({ error, fallback }: { error: unknown; fallback: string }) {
  if (!error) return null
  return (
    <p className="adm-error" role="alert">
      <AlertIcon size={16} />
      {errorText(error, fallback)}
    </p>
  )
}

// Loading / failed (with retry) / loaded, for one list query. A legitimately empty list is the caller's own state.
export function QueryState<T>({
  query,
  what,
  children,
}: {
  query: UseQueryResult<T>
  what: string
  children: (data: T) => ReactNode
}) {
  if (query.isPending) {
    return (
      <p className="adm-state" role="status">
        <SpinnerIcon size={18} /> Chargement…
      </p>
    )
  }
  if (query.isError) {
    return (
      <div className="adm-state adm-state--error" role="alert">
        <AlertIcon size={18} />
        {errorText(query.error, `${what} : chargement impossible.`)}
        <Button
          size="sm"
          onClick={() => {
            void query.refetch()
          }}
        >
          Réessayer
        </Button>
      </div>
    )
  }
  return <>{children(query.data)}</>
}

interface ConfirmDeleteProps {
  title: string
  confirmLabel: string
  pending: boolean
  error: unknown
  onConfirm: () => void
  onClose: () => void
  children: ReactNode
}

// « Supprimer … ? »: a confirmation that states the consequence; the server's refusal (in use…) stays in the dialog.
export function ConfirmDelete({ title, confirmLabel, pending, error, onConfirm, onClose, children }: ConfirmDeleteProps) {
  return (
    <Modal
      open
      size="sm"
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button disabled={pending} onClick={onClose}>
            Retour
          </Button>
          <Button variant="danger" icon={TrashIcon} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="adm-confirm">
        {children}
        <ErrorNote error={error} fallback="La suppression a échoué : réessayez." />
      </div>
    </Modal>
  )
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count > 1 ? many : one}`
}
