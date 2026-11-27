import { type IdentityDoubt, useConfirmIdentity } from '../api/emailIdentity'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { identitySentence } from './identityCopy'
import './identity.css'

// The flag of the lists and sheets: a badge, the reason on demand.
export function IdentityBadge({ doubt }: { doubt: IdentityDoubt }) {
  return (
    <span className="identity-flag">
      <StatusBadge tone="warning" icon={AlertIcon}>
        Identité e-mail à vérifier
      </StatusBadge>
      <InfoTip label={`Aide : identité de ${doubt.address}`}>
        {doubt.address} : {identitySentence(doubt)} Aucun mail ne part vers cette adresse tant qu’elle n’est pas corrigée
        ou confirmée.
      </InfoTip>
    </span>
  )
}

// One doubtful address with the explicit override (recorded with who and when).
function DoubtRow({ prospectId, doubt }: { prospectId: string; doubt: IdentityDoubt }) {
  const confirm = useConfirmIdentity(prospectId)
  return (
    <li className="identity-notice__row">
      <IdentityBadge doubt={doubt} />
      <span className="identity-notice__text">
        <strong>{doubt.address}</strong> {identitySentence(doubt)}
      </span>
      <Button
        size="sm"
        icon={CheckCircleIcon}
        loading={confirm.isPending}
        disabled={confirm.isPending}
        onClick={() => {
          confirm.mutate(doubt.address)
        }}
      >
        C’est bien son adresse
      </Button>
      {confirm.isError && (
        <span className="field__error" role="alert">
          <AlertIcon size={16} />
          La confirmation n’a pas été enregistrée. Réessayez.
        </span>
      )}
    </li>
  )
}

export function IdentityNotice({ prospectId, doubts }: { prospectId: string; doubts: IdentityDoubt[] }) {
  if (doubts.length === 0) return null
  return (
    <ul className="identity-notice" aria-label="Adresses à vérifier avant tout envoi">
      {doubts.map((doubt) => (
        <DoubtRow key={doubt.address} prospectId={prospectId} doubt={doubt} />
      ))}
    </ul>
  )
}
