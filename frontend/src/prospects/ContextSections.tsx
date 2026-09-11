import { useCompany } from '../api/companies'
import type { Prospect, ProspectSource } from '../api/prospects'
import { useCompanyEditor } from '../companies/CompanyEditorProvider'
import { formatDay } from '../prospection/labels'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { TextAreaField, TextField } from '../ui/fields'
import { AlertIcon, BuildingIcon } from '../ui/icons'
import { EditorSection } from './EditorSection'
import type { SectionProps } from './EmploymentSections'

// The company as context (Company editor for any change: no company field is duplicated here).
export function CompanySection({ companyId }: { companyId: string | null }) {
  const openCompanyEditor = useCompanyEditor()
  const company = useCompany(companyId)
  const data = company.data
  const primary = data?.establishments.find((establishment) => establishment.is_primary)
  const facts = data
    ? [
        data.legal_name && data.legal_name !== data.display_name ? data.legal_name : null,
        data.siren ? `SIREN ${data.siren.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3')}` : null,
        data.commercial_segment?.label ?? null,
        primary?.city ?? null,
      ].filter(Boolean)
    : []
  return (
    <EditorSection title="Entreprise">
      {!companyId && <p className="prospect-editor__muted">Aucune entreprise choisie pour l’instant.</p>}
      {companyId && !data && <p className="prospect-editor__muted">Chargement de l’entreprise…</p>}
      {data && (
        <div className="prospect-company">
          <p className="prospect-company__name">
            <BuildingIcon size={18} />
            {data.display_name}
          </p>
          {facts.length > 0 && <p className="prospect-editor__muted">{facts.join(' · ')}</p>}
          <dl className="prospect-company__facts">
            <dt>Domaine e-mail</dt>
            <dd>{data.email_domain ?? <span className="prospect-editor__muted">non renseigné</span>}</dd>
            <dt>Site web</dt>
            <dd>{data.website_url ?? <span className="prospect-editor__muted">non renseigné</span>}</dd>
            <dt>Prospects</dt>
            <dd>{data.prospect_count}</dd>
          </dl>
          <div>
            <Button
              size="sm"
              icon={BuildingIcon}
              onClick={() => {
                openCompanyEditor(data.id)
              }}
            >
              Ouvrir la fiche entreprise
            </Button>
          </div>
        </div>
      )}
    </EditorSection>
  )
}

const SOURCE_TYPES: Record<ProspectSource['source_type'], string> = {
  excel_import: 'Import Excel',
  manual: 'Saisie manuelle',
  future_agent: 'Agent',
  other: 'Autre source',
}

function SourceItem({ source }: { source: ProspectSource }) {
  const reference = source.source_reference ?? source.import_filename
  return (
    <li className="prospect-sources__item">
      <span className="prospect-sources__title">
        {SOURCE_TYPES[source.source_type]}
        {reference ? ` · ${reference}` : ''}
      </span>
      <span className="prospect-editor__muted">
        Collecté le {formatDay(source.collected_at)}
        {source.actor_display ? ` · par ${source.actor_display}` : ''}
      </span>
      {source.legal_basis_or_collection_context && (
        <span className="prospect-editor__muted">Contexte : {source.legal_basis_or_collection_context}</span>
      )}
    </li>
  )
}

interface ProvenanceProps extends SectionProps {
  prospect: Prospect | null
}

// Where the data came from. A new prospect records its manual provenance with the save; an existing one lists its
// sources (the change history of Task 19 will sit below).
export function ProvenanceSection({ draft, errors, fieldId, onChange, prospect }: ProvenanceProps) {
  return (
    <EditorSection title="Provenance">
      {prospect ? (
        <>
          {prospect.sources.length === 0 ? (
            <p className="prospect-editor__note">
              <AlertIcon size={16} />
              Aucune provenance enregistrée.
            </p>
          ) : (
            <ul className="prospect-sources">
              {prospect.sources.map((source) => (
                <SourceItem key={source.id} source={source} />
              ))}
            </ul>
          )}
          <p className="prospect-editor__muted">
            Fiche créée le {formatDay(prospect.created_at)} · modifiée le {formatDay(prospect.updated_at)}
          </p>
        </>
      ) : (
        <>
          <TextAreaField
            id={fieldId('provenance.legal_basis_or_collection_context')}
            label="Contexte de collecte ou base légale"
            required
            rows={2}
            value={draft.legal_context}
            error={errors['provenance.legal_basis_or_collection_context']}
            onChange={(event) => {
              onChange({ legal_context: event.target.value })
            }}
          />
          <TextField
            id={fieldId('provenance.source_reference')}
            label="Où avez-vous trouvé ce contact ?"
            hint="Facultatif : salon, site de l’entreprise, recommandation…"
            value={draft.source_reference}
            error={errors['provenance.source_reference']}
            onChange={(event) => {
              onChange({ source_reference: event.target.value })
            }}
          />
        </>
      )}
    </EditorSection>
  )
}

interface DeleteDialogProps {
  prospect: Prospect
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count > 1 ? many : one}`
}

// Deleting is possible only without an opposition (the database refuses too): erasing it would let a later import
// recreate the person as contactable. The dialog lists what goes with the person.
export function DeleteProspectDialog({ prospect, busy, error, onClose, onConfirm }: DeleteDialogProps) {
  const blocked = prospect.contactability_status === 'do_not_contact'
  const parts = [
    prospect.emails.length > 0 && plural(prospect.emails.length, 'e-mail', 'e-mails'),
    prospect.phones.length > 0 && plural(prospect.phones.length, 'téléphone', 'téléphones'),
    prospect.tracking && 'le suivi de contact et son historique',
    prospect.sources.length > 0 && plural(prospect.sources.length, 'trace de provenance', 'traces de provenance'),
    prospect.import_row_count > 0 && plural(prospect.import_row_count, 'ligne d’import d’origine', 'lignes d’import d’origine'),
  ].filter((part): part is string => Boolean(part))
  const name = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ')
  return (
    <Modal
      open
      size="sm"
      title={blocked ? 'Suppression impossible' : `Supprimer « ${name} » ?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{blocked ? 'Fermer' : 'Annuler'}</Button>
          {!blocked && (
            <Button variant="danger" loading={busy} onClick={onConfirm}>
              Supprimer définitivement
            </Button>
          )}
        </>
      }
    >
      <div className="prospect-editor__dialog">
        {blocked ? (
          <p>
            Ce prospect est en opposition. Le supprimer effacerait l’opposition : un import ultérieur pourrait le recréer
            comme contactable. Levez d’abord l’opposition, avec son motif, si la suppression est vraiment voulue.
          </p>
        ) : (
          <>
            <p>
              {parts.length > 0 ? `Seront supprimés avec la fiche : ${parts.join(', ')}.` : 'La fiche sera supprimée.'}
            </p>
            <p className="prospect-editor__muted">L’entreprise est conservée. La suppression reste tracée dans l’historique.</p>
          </>
        )}
        {error && (
          <p className="prospect-editor__status prospect-editor__status--error" role="alert">
            <AlertIcon size={16} />
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
