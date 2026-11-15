import { useEffect, useMemo, useState } from 'react'

import { ApiError } from '../api/client'
import { type CleanupGroup, type TaxonomyKind, useTaxonomyCleanup } from '../api/settings'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { TextField } from '../ui/fields'
import { AlertIcon, CloseIcon, SaveIcon, SparklesIcon, SpinnerIcon } from '../ui/icons'

interface Row {
  key: string
  label: string
  members: CleanupGroup['members']
}

// « Brest » = « brest »: what the server compares (case, accents and spacing ignored).
function sameKey(label: string): string {
  return label.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function mostUsed(members: Row['members']) {
  return members.reduce((best, member) => (member.usage_count > best.usage_count ? member : best))
}

// Two rows given the same final label are one group: that is how a person merges by hand.
function toGroups(rows: Row[]): { label: string; ids: string[] }[] {
  const byLabel = new Map<string, { label: string; ids: string[] }>()
  for (const row of rows) {
    const label = row.label.trim()
    const key = sameKey(label)
    const found = byLabel.get(key) ?? { label, ids: [] }
    found.ids.push(...row.members.map((member) => member.id))
    byLabel.set(key, found)
  }
  return [...byLabel.values()]
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const { detail } = error
    if (typeof detail === 'object' && detail !== null && 'message' in detail && typeof detail.message === 'string') {
      return detail.message
    }
  }
  return fallback
}

// « Nettoyer »: the AI proposes a cleaner list (homogenised labels, duplicates grouped); the person edits it, then
// applies it — each group becomes one value and the records that used the merged ones follow.
export function TaxonomyCleanup({ kind, noun, onClose, onDone }: { kind: TaxonomyKind; noun: string; onClose: () => void; onDone: (text: string) => void }) {
  const { propose, apply } = useTaxonomyCleanup(kind)
  const [rows, setRows] = useState<Row[] | null>(null)
  const { mutate: ask } = propose

  useEffect(() => {
    ask(undefined, {
      onSuccess: (proposal) => {
        setRows(proposal.groups.map((group, index) => ({ key: `${String(index)}-${group.members[0]?.id ?? ''}`, label: group.label, members: group.members })))
      },
    })
  }, [ask])

  const summary = useMemo(() => {
    const groups = toGroups(rows ?? [])
    const byId = new Map((rows ?? []).flatMap((row) => row.members.map((member) => [member.id, member] as const)))
    let merged = 0
    let renamed = 0
    let affected = 0
    for (const group of groups) {
      const members = group.ids.flatMap((id) => byId.get(id) ?? [])
      if (members.length === 0) continue
      const kept = mostUsed(members)
      merged += members.length - 1
      affected += members.reduce((sum, member) => sum + member.usage_count, 0) - kept.usage_count
      if (kept.label !== group.label) renamed += 1
    }
    return { merged, renamed, affected, groups }
  }, [rows])

  const blank = (rows ?? []).some((row) => row.label.trim() === '')
  const unchanged = summary.merged === 0 && summary.renamed === 0

  function update(key: string, patch: Partial<Row>) {
    setRows((current) => (current ?? []).map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  // Take one value out of a group: it keeps its own current label.
  function detach(key: string, id: string) {
    setRows((current) =>
      (current ?? []).flatMap((row) => {
        if (row.key !== key) return [row]
        const member = row.members.find((item) => item.id === id)
        if (!member) return [row]
        return [
          { ...row, members: row.members.filter((item) => item.id !== id) },
          { key: `${key}-${id}`, label: member.label, members: [member] },
        ]
      }),
    )
  }

  function submit() {
    apply.mutate(summary.groups, {
      onSuccess: (result) => {
        const parts = [
          result.renamed > 0 ? `${String(result.renamed)} renommé${result.renamed > 1 ? 's' : ''}` : null,
          result.merged > 0 ? `${String(result.merged)} fusionné${result.merged > 1 ? 's' : ''}` : null,
          result.moved > 0 ? `${String(result.moved)} ${noun} mis à jour` : null,
        ].filter(Boolean)
        onDone(parts.length > 0 ? `Nettoyage appliqué : ${parts.join(', ')}.` : 'Rien à changer : la liste est déjà propre.')
      },
    })
  }

  return (
    <Modal
      open
      size="xl"
      title="Nettoyer la liste"
      description="L’IA propose une liste plus propre : écriture homogène, doublons regroupés. Modifiez-la avant de l’appliquer."
      onClose={onClose}
      footer={
        <>
          <Button disabled={apply.isPending} onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" icon={SaveIcon} loading={apply.isPending} disabled={!rows || blank || unchanged} onClick={submit}>
            Appliquer
          </Button>
        </>
      }
    >
      {propose.isPending && (
        <p className="settings-state" role="status">
          <SpinnerIcon size={18} className="btn__spinner" />
          L’IA analyse la liste…
        </p>
      )}
      {propose.isError && (
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          {errorText(propose.error, 'La proposition n’a pas pu être obtenue.')}
          <Button
            size="sm"
            onClick={() => {
              ask(undefined, {
                onSuccess: (proposal) => {
                  setRows(proposal.groups.map((group, index) => ({ key: `${String(index)}-${group.members[0]?.id ?? ''}`, label: group.label, members: group.members })))
                },
              })
            }}
          >
            Réessayer
          </Button>
        </div>
      )}
      {rows && rows.length === 0 && <p className="settings-state">Aucune valeur à nettoyer.</p>}
      {rows && rows.length > 0 && (
        <div className="cleanup">
          <p className="cleanup__summary" role="status">
            <SparklesIcon size={16} aria-hidden="true" />
            {unchanged
              ? 'Aucun changement proposé.'
              : `${String(summary.renamed)} renommé${summary.renamed > 1 ? 's' : ''}, ${String(summary.merged)} fusionné${summary.merged > 1 ? 's' : ''} — ${String(summary.affected)} ${noun} mis à jour.`}
            <span className="cleanup__hint"> Donnez le même libellé à deux lignes pour les fusionner.</span>
          </p>
          <ul className="cleanup__list" aria-label="Liste proposée">
            {rows.map((row) => {
              const changed = row.members.length > 1 || row.label.trim() !== row.members[0]?.label
              return (
                <li key={row.key} className="cleanup__row" data-changed={changed ? '' : undefined}>
                  <TextField
                    label="Libellé final"
                    value={row.label}
                    maxLength={255}
                    onChange={(event) => {
                      update(row.key, { label: event.target.value })
                    }}
                  />
                  <ul className="cleanup__members" aria-label={`Remplace (${row.label})`}>
                    {row.members.map((member) => (
                      <li key={member.id} className="cleanup__member">
                        <span>{member.label}</span>
                        <span className="cleanup__usage">{member.usage_count}</span>
                        {row.members.length > 1 && (
                          <button
                            type="button"
                            className="cleanup__detach"
                            aria-label={`Séparer « ${member.label} »`}
                            title="Séparer : garde son libellé actuel"
                            onClick={() => {
                              detach(row.key, member.id)
                            }}
                          >
                            <CloseIcon size={14} />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
          {apply.isError && (
            <p role="alert" className="settings-state settings-state--error">
              <AlertIcon size={18} />
              {errorText(apply.error, 'Le nettoyage n’a pas pu être appliqué : rien n’a été modifié.')}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
