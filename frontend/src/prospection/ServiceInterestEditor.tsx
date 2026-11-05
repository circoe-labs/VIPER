import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiRequest } from '../api/client'
import { refreshAfterWrite } from '../api/refresh'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { CheckIcon } from '../ui/icons'
import { SERVICES } from './services'

interface Interests {
  company_id: string
  services: string[]
}

// Explicit dialog and labelled buttons: row navigation never changes a company's needs.
export function ServiceInterestEditor({
  id,
  name,
  onClose,
}: {
  id: string
  name: string
  onClose: () => void
}) {
  const client = useQueryClient()
  const key = ['companies', 'services', id]
  const interests = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiGet<Interests>(`/companies/${id}/services`, signal),
  })
  const edit = useMutation({
    mutationFn: ({ code, identified }: { code: string; identified: boolean }) =>
      apiRequest<Interests>('PUT', `/companies/${id}/services/${code}`, { body: { identified } }),
    onSuccess: async (data) => {
      client.setQueryData(key, data)
      await refreshAfterWrite(client, [['prospection'], ['companies'], ['history']])
    },
  })
  return (
    <Modal
      open
      title={`Prestations · ${name}`}
      onClose={onClose}
      footer={<Button onClick={onClose}>Terminer</Button>}
    >
      <p>
        Les besoins identifiés sont partagés par tous les contacts de cette entreprise. Plusieurs choix sont
        possibles.
      </p>
      <p className="muted">Un tiret signifie qu’aucun besoin n’est identifié. Il ne confirme pas un refus.</p>
      {interests.isPending && <p role="status">Chargement des prestations…</p>}
      {interests.isError && (
        <p role="alert">
          Impossible de charger les prestations.{' '}
          <Button onClick={() => void interests.refetch()}>Réessayer</Button>
        </p>
      )}
      {interests.data && (
        <div className="service-editor">
          {SERVICES.map(({ code, label, icon: Icon }) => {
            const selected = interests.data.services.includes(code)
            return (
              <button
                key={code}
                type="button"
                className={`service-choice service-choice--${code}`}
                aria-pressed={selected}
                disabled={edit.isPending}
                onClick={() => {
                  edit.mutate({ code, identified: !selected })
                }}
              >
                <Icon size={20} />
                <span>{label}</span>
                {selected ? <CheckIcon size={18} /> : <span>—</span>}
              </button>
            )
          })}
        </div>
      )}
      {edit.isPending && <p role="status">Enregistrement…</p>}
      {edit.isError && <p role="alert">Enregistrement impossible : {edit.error.message}</p>}
    </Modal>
  )
}
