import { useState } from 'react'

import { type CommitResult, commitImport, type PreviewResult } from '../api/imports'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { Checkbox, TextAreaField, TextField } from '../ui/fields'
import { AlertIcon } from '../ui/icons'
import { type CommitSummary, DEFAULT_LEGAL_BASIS, decisionsPayload, type ReviewDecisions } from './importPlan'
import { importErrorMessage, plural, refusalOf, rowsText } from './messages'

interface CommitDialogProps {
  file: File
  preview: PreviewResult
  decisions: ReviewDecisions
  summary: CommitSummary
  onClose: () => void
  onReanalyse: () => void
  onCommitted: (result: CommitResult) => void
}

// Last look before writing: what will be created, completed and skipped, and the provenance recorded on every
// imported prospect. One transaction: all or nothing.
export function CommitDialog({ file, preview, decisions, summary, onClose, onReanalyse, onCommitted }: CommitDialogProps) {
  const [legalBasis, setLegalBasis] = useState(DEFAULT_LEGAL_BASIS)
  const [sourceReference, setSourceReference] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  const reimport = preview.previous_imports.length > 0
  const basisError = legalBasis.trim() ? undefined : 'Indiquez la base légale ou le contexte de collecte.'
  const stale = refusalOf(failure)?.code === 'preview_outdated'

  async function confirm() {
    setPending(true)
    setFailure(null)
    try {
      const payload = decisionsPayload(preview.review, decisions, {
        legalBasis,
        sourceReference,
        acknowledgeReimport: acknowledged,
      })
      onCommitted(await commitImport(file, payload))
    } catch (error) {
      setFailure(error)
      setPending(false)
    }
  }

  const lines = [
    plural(summary.created, 'nouveau prospect', 'nouveaux prospects'),
    summary.attachedRows > 0 &&
      `${rowsText(summary.attachedRows)} complétant ${plural(summary.attachedProspects, 'prospect existant', 'prospects existants')} (champs vides uniquement, rien n’est écrasé)`,
    summary.merged > 0 && `${rowsText(summary.merged)} fusionnée(s) avec une autre ligne du fichier`,
    `${plural(summary.companiesCreated, 'entreprise créée', 'entreprises créées')}, ${plural(summary.companiesLinked, 'entreprise existante complétée', 'entreprises existantes complétées')}`,
    summary.rolesCreated.length > 0 && `Rôles créés : ${summary.rolesCreated.map((label) => `« ${label} »`).join(', ')}`,
    summary.categoriesCreated.length > 0 &&
      `Catégories créées : ${summary.categoriesCreated.map((label) => `« ${label} »`).join(', ')}`,
    summary.weeksDated + summary.weeksUndated > 0 &&
      `Semaines sans année : ${String(summary.weeksDated)} datée(s), ${String(summary.weeksUndated)} laissée(s) sans date`,
    plural(summary.excluded, 'ligne exclue (non importée)', 'lignes exclues (non importées)'),
  ].filter((line): line is string => typeof line === 'string')

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title="Confirmer l’import"
      description={`« ${preview.review.preview.summary.file_name} » — ${rowsText(summary.imported)} à importer en une seule opération.`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Annuler
          </Button>
          {stale ? (
            <Button variant="primary" onClick={onReanalyse}>
              Relancer l’analyse
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={pending}
              disabled={Boolean(basisError) || (reimport && !acknowledged)}
              onClick={() => void confirm()}
            >
              Importer {rowsText(summary.imported)}
            </Button>
          )}
        </>
      }
    >
      <div className="import-commit">
        <ul className="import-commit__summary" aria-label="Ce qui sera enregistré">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="import-muted">
          Les adresses e-mail et numéros importés sont enregistrés « non vérifiés » ; aucun prospect « Ne pas contacter »
          n’est réactivé. Chaque ligne importée garde sa source (fichier, feuille, ligne) et ses valeurs d’origine non
          reprises.
        </p>
        <TextAreaField
          label="Base légale ou contexte de collecte"
          required
          rows={2}
          value={legalBasis}
          error={basisError}
          hint="Enregistré sur la provenance de chaque prospect importé."
          onChange={(event) => {
            setLegalBasis(event.target.value)
          }}
        />
        <TextField
          label="Référence de la source (facultatif)"
          value={sourceReference}
          placeholder="Ex. : export du fichier commercial de mars"
          onChange={(event) => {
            setSourceReference(event.target.value)
          }}
        />
        {reimport && (
          <Checkbox
            label="Ce fichier a déjà été importé : je confirme vouloir l’importer à nouveau."
            checked={acknowledged}
            onChange={(event) => {
              setAcknowledged(event.target.checked)
            }}
          />
        )}
        {failure !== null && (
          <p className="import-alert import-alert--danger" role="alert">
            <AlertIcon size={18} />
            {importErrorMessage(failure)}
          </p>
        )}
      </div>
    </Modal>
  )
}
