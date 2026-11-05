import { useRef } from 'react'

import { useDeleteMission } from '../api/missions'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { TrashIcon } from '../ui/icons'

interface DeleteMissionDialogProps {
  open: boolean
  missionId: string
  name: string
  onClose: () => void
  // After the server deleted it (e.g. leave its page).
  onDeleted?: () => void
}

// « Supprimer cette mission ? »: shared by the mission page and the list's context menu.
export function DeleteMissionDialog({ open, missionId, name, onClose, onDeleted }: DeleteMissionDialogProps) {
  const remove = useDeleteMission(missionId)
  const backRef = useRef<HTMLButtonElement>(null)
  const close = () => {
    remove.reset()
    onClose()
  }
  return (
    <Modal
      open={open}
      size="sm"
      title="Supprimer cette mission ?"
      initialFocusRef={backRef}
      onClose={close}
      footer={
        <>
          <Button ref={backRef} disabled={remove.isPending} onClick={close}>
            Retour
          </Button>
          <Button
            variant="danger"
            icon={TrashIcon}
            loading={remove.isPending}
            onClick={() => {
              remove.mutate(undefined, {
                onSuccess: () => {
                  onClose()
                  onDeleted?.()
                },
              })
            }}
          >
            Supprimer la mission
          </Button>
        </>
      }
    >
      <div className="mission-dialog">
        <p>
          « {name} » est supprimée avec ses données liées et l’historique de ses exécutions. Les tâches encore en
          attente, en cours ou à relire sont annulées : les agents ne les traiteront pas.
        </p>
        <p>Les modifications déjà acceptées sur les fiches ne changent pas.</p>
        {remove.isError && (
          <p className="missions-error" role="alert">
            La mission n’a pas pu être supprimée : réessayez.
          </p>
        )}
      </div>
    </Modal>
  )
}
