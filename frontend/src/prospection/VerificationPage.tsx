import { type SyntheticEvent, useDeferredValue, useState } from 'react'
import { Link } from 'react-router'

import { ApiError, apiGet } from '../api/client'
import { type Company, useCompanyMutations } from '../api/companies'
import { useProspectPage } from '../api/prospection'
import { type Prospect, useProspect, useProspectMutations } from '../api/prospects'
import { useProspectAlerts, useSequenceMutations } from '../api/sequences'
import { useCohorts } from '../api/settings'
import {
  type AliasDraft,
  draftFromProspect,
  type ProspectDraft,
  toInput,
  validate,
} from '../prospects/prospectForm'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { SelectField, TextField } from '../ui/fields'
import { AlertIcon, BanIcon, CheckCircleIcon, ChevronLeftIcon, ChevronRightIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { IgnoredReading, VerificationOverview, VerifiedReading } from './VerificationOverview'
import {
  todoCriteria,
  useVerificationFigures,
  type VerificationFigures,
  type VerificationTab,
} from './verificationFigures'
import './verification.css'

// Espace de vérification : les fiches « À vérifier » une par une, avec ce qu'il faut pour trancher en quelques clics —
// Valider (emploi + e-mail + téléphone vérifiés, cohorte au choix), Incertain (alerte « Fonction à vérifier »),
// Ignorer (inactif + « Ignoré », définitif) ou Passer. Réutilise les écritures de l'éditeur de prospect.

const PAGE_SIZE = 50

function problem(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return 'L’enregistrement a échoué. Réessayez.'
}

export function VerificationPage() {
  const [tab, setTab] = useState<VerificationTab>('todo')
  const figures = useVerificationFigures()

  return (
    <div className="verification">
      <PageHeader
        title="Vérification"
        description="Où en est la base, et les fiches à vérifier une par une : valider, signaler un doute, ignorer ou passer."
        actions={
          <Link to="/prospection" className="btn btn--ghost btn--md">
            Retour à la prospection
          </Link>
        }
      />
      <VerificationOverview figures={figures} tab={tab} onTab={setTab} />
      {tab === 'verified' && <VerifiedReading figures={figures} />}
      {tab === 'ignored' && <IgnoredReading figures={figures} />}
      {tab === 'todo' && <Queue key="todo" kind="todo" figures={figures} />}
      {tab === 'uncertain' && <Queue key="uncertain" kind="uncertain" figures={figures} />}
    </div>
  )
}

// The fiches of one box, one at a time. `skipped` stay in the box (they keep their place at the head of the list);
// `done` are hidden until the lists refresh.
function Queue({ kind, figures }: { kind: 'todo' | 'uncertain'; figures: VerificationFigures }) {
  const [search, setSearch] = useState('')
  const [cohort, setCohort] = useState('')
  const q = useDeferredValue(search)
  const cohorts = useCohorts()
  const [skipped, setSkipped] = useState<string[]>([])
  const [done, setDone] = useState<string[]>([])
  const todo = kind === 'todo'
  const page = Math.floor(skipped.length / PAGE_SIZE) + 1
  const list = useProspectPage(todoCriteria({ q, cohort: cohort || null }), page)
  const hidden = new Set([...skipped, ...done, ...(todo ? figures.uncertainIds : [])])
  const currentId = todo
    ? (list.data?.items.find((row) => !hidden.has(row.id))?.id ?? null)
    : (figures.uncertainIds.find((id) => !hidden.has(id)) ?? null)
  const waiting = todo ? list.isPending : figures.loading
  const left = todo ? figures.todo : figures.uncertain

  // « Retour » : the fiches left behind, most recent last; going back shows one again (even if already validated).
  const [trail, setTrail] = useState<string[]>([])
  const [revisit, setRevisit] = useState<string | null>(null)
  const shownId = revisit ?? currentId
  const previous = trail.at(-1)

  function leave(id: string) {
    setTrail((ids) => (ids.at(-1) === id ? ids : [...ids, id]))
    setRevisit(null)
  }

  function goBack() {
    if (!previous) return
    setTrail((ids) => ids.slice(0, -1))
    setRevisit(previous)
  }

  return (
    <>
      <div className="verification__bar">
        {todo && (
          <>
            <TextField
              label="Rechercher (nom, entreprise, e-mail)"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setSkipped([])
              }}
            />
            <SelectField
              label="Cohorte"
              value={cohort}
              onChange={(event) => {
                setCohort(event.target.value)
                setSkipped([])
              }}
            >
              <option value="">Toutes</option>
              <option value="none">Sans cohorte</option>
              {(cohorts.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {`${item.code} (${String(item.current_count)})`}
                </option>
              ))}
            </SelectField>
          </>
        )}
        <p className="verification__count" aria-live="polite">
          <strong>{left}</strong> fiche{left > 1 ? 's' : ''} {todo ? 'à vérifier' : 'avec un doute'}
          {skipped.length > 0 && ` · ${String(skipped.length)} passée${skipped.length > 1 ? 's' : ''}`}
        </p>
      </div>
      {list.isError && <p role="alert">Impossible de charger la liste.</p>}
      {!waiting && !currentId && (
        <EmptyState
          icon={CheckCircleIcon}
          title={skipped.length > 0 ? 'Plus de fiche pour le moment' : todo ? 'Tout est vérifié' : 'Aucun doute en attente'}
          description={skipped.length > 0 ? 'Il reste les fiches que vous avez passées.' : 'Rien à traiter ici.'}
          action={
            skipped.length > 0 ? (
              <Button
                onClick={() => {
                  setSkipped([])
                }}
              >
                Reprendre les fiches passées
              </Button>
            ) : undefined
          }
        />
      )}
      {shownId && (
        <VerificationCard
          key={shownId}
          id={shownId}
          onBack={previous ? goBack : undefined}
          onValidated={() => {
            leave(shownId)
            setDone((ids) => [...ids, shownId])
          }}
          onSkip={() => {
            leave(shownId)
            setSkipped((ids) => [...ids, shownId])
          }}
        />
      )}
    </>
  )
}

interface CardProps {
  id: string
  onValidated: () => void
  onSkip: () => void
  // Back to the fiche seen just before; absent on the first one.
  onBack: (() => void) | undefined
}

// Loads the full prospect, then hands it to the form (which owns its draft).
function VerificationCard({ id, onValidated, onSkip, onBack }: CardProps) {
  const prospect = useProspect(id)
  if (prospect.isError) {
    return (
      <Card>
        <p role="alert">Impossible de charger la fiche.</p>
        <Button onClick={onSkip}>Passer</Button>
      </Card>
    )
  }
  if (!prospect.data) return <Card>Chargement…</Card>
  return <VerificationForm prospect={prospect.data} onValidated={onValidated} onSkip={onSkip} onBack={onBack} />
}

function primaryOf(aliases: AliasDraft[]): AliasDraft | undefined {
  return aliases.find((alias) => alias.is_primary && alias.is_active) ?? aliases.find((alias) => alias.is_active)
}

interface FormProps {
  prospect: Prospect
  onValidated: () => void
  onSkip: () => void
  onBack: (() => void) | undefined
}

function VerificationForm({ prospect, onValidated, onSkip, onBack }: FormProps) {
  const [draft, setDraft] = useState<ProspectDraft>(() => draftFromProspect(prospect))
  const [cohortId, setCohortId] = useState('')
  const [note, setNote] = useState('')
  const [confirmIgnore, setConfirmIgnore] = useState(false)
  const [copied, setCopied] = useState(false)
  const [companyName, setCompanyName] = useState(prospect.company?.display_name ?? '')
  const [error, setError] = useState<string | null>(null)
  const companies = useCompanyMutations()
  const mutations = useProspectMutations()
  const sequence = useSequenceMutations(prospect.id)
  const cohorts = useCohorts()
  const alerts = useProspectAlerts(prospect.id)
  const busy = companies.update.isPending || mutations.update.isPending || mutations.tracking.isPending || sequence.changeCohort.isPending || sequence.raiseAlert.isPending

  const email = primaryOf(draft.emails)
  const phone = primaryOf(draft.phones)
  const openAlerts = (alerts.data?.items ?? []).filter((alert) => alert.open)
  const source = prospect.sources[0]
  // What is on screen, one row for a paste: last name, first name, e-mail, phone, job title, company.
  const copyLine = [
    draft.last_name,
    draft.first_name,
    email?.value ?? '',
    phone?.value ?? '',
    draft.exact_job_title,
    companyName,
  ]
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .join('\t')
  const messages = validate(draft, { isNew: false, today: prospect.today })

  function patch(changes: Partial<ProspectDraft>) {
    setDraft((current) => ({ ...current, ...changes }))
  }

  function patchAlias(kind: 'emails' | 'phones', key: string, value: string) {
    setDraft((current) => ({
      ...current,
      [kind]: current[kind].map((alias) => (alias.key === key ? { ...alias, value } : alias)),
    }))
  }

  function verified(aliases: AliasDraft[]): AliasDraft[] {
    const target = primaryOf(aliases)
    return aliases.map((alias) =>
      alias === target && alias.value.trim() !== '' && alias.verification_status !== 'invalid'
        ? { ...alias, verified_now: true }
        : alias,
    )
  }

  // Renames the company (for all its fiches) when the name was edited; the other company fields are sent back as read.
  async function renameCompany() {
    const current = prospect.company
    const name = companyName.replace(/\s+/g, ' ').trim()
    if (!current || !name || name === current.display_name) return
    const company = await apiGet<Company>(`/companies/${encodeURIComponent(current.id)}`)
    await companies.update.mutateAsync({
      id: company.id,
      input: {
        display_name: name,
        legal_name: company.legal_name,
        siren: company.siren,
        website_url: company.website_url,
        email_domain: company.email_domain,
        size_label: company.size_label,
        commercial_segment_id: company.commercial_segment?.id ?? null,
        activity_category_ids: company.activity_categories.map((category) => category.id),
        project_done_with_circoe: company.project_done_with_circoe,
        project_type: company.project_type,
        circoe_references: company.circoe_references,
        client_approach: company.client_approach,
        establishments: company.establishments,
      },
    })
  }

  async function validateAndNext(event?: SyntheticEvent) {
    event?.preventDefault()
    if (Object.keys(messages).length > 0) {
      setError(`À corriger avant de valider : ${Object.values(messages).join(' ')}`)
      return
    }
    setError(null)
    try {
      const next: ProspectDraft = {
        ...draft,
        verification: { action: 'verified_now', day: '' },
        emails: verified(draft.emails),
        phones: verified(draft.phones),
      }
      await mutations.update.mutateAsync({
        id: prospect.id,
        version: prospect.version,
        input: toInput(next, prospect.company?.id ?? null),
      })
      await renameCompany()
      if (cohortId) await sequence.changeCohort.mutateAsync(cohortId)
      for (const alert of openAlerts.filter((item) => item.type === 'function_to_check')) {
        await sequence.resolveAlert.mutateAsync({ id: alert.id, note: 'Vérifié dans l’espace de vérification.' })
      }
      onValidated()
    } catch (failure) {
      setError(problem(failure))
    }
  }

  async function flagUncertain() {
    setError(null)
    if (openAlerts.some((item) => item.type === 'function_to_check')) {
      onSkip()
      return
    }
    try {
      await renameCompany()
      await sequence.raiseAlert.mutateAsync({
        type: 'function_to_check',
        note: note.trim() || 'Incertitude sur ce contact : à contacter pour vérifier si on le garde.',
      })
      onSkip()
    } catch (failure) {
      setError(problem(failure))
    }
  }

  async function ignore() {
    if (!confirmIgnore) {
      setConfirmIgnore(true)
      return
    }
    setError(null)
    try {
      const saved = await mutations.update.mutateAsync({
        id: prospect.id,
        version: prospect.version,
        input: toInput({ ...draft, activity_status: 'inactive' }, prospect.company?.id ?? null),
      })
      await mutations.tracking.mutateAsync({ id: prospect.id, version: saved.version, patch: { status: 'ignored' } })
      onValidated()
    } catch (failure) {
      setError(problem(failure))
      setConfirmIgnore(false)
    }
  }

  return (
    <Card className="verification__card">
      <form className="verification__form" onSubmit={(event) => void validateAndNext(event)}>
        <div className="verification__company">
          <h2>{prospect.company?.display_name ?? 'Sans entreprise'}</h2>
          <p>
            {[prospect.company?.city, prospect.company?.website_url, prospect.company?.email_domain].filter(Boolean).join(' · ')}
          </p>
          {source && (
            <p className="verification__source">
              Source : {source.import_filename ?? source.source_reference ?? 'saisie manuelle'}
            </p>
          )}
          {openAlerts.map((alert) => (
            <StatusBadge key={alert.id} tone="warning" icon={AlertIcon}>
              {alert.note ?? 'Alerte ouverte'}
            </StatusBadge>
          ))}
        </div>

        <div className="verification__grid">
          <TextField
            label="Entreprise"
            value={companyName}
            hint={
              prospect.company && prospect.company.prospect_count > 1
                ? `Renomme l’entreprise pour ses ${String(prospect.company.prospect_count)} fiches.`
                : undefined
            }
            disabled={!prospect.company}
            onChange={(event) => {
              setCompanyName(event.target.value)
            }}
          />
          <SelectField
            label="Civilité"
            value={draft.civility}
            onChange={(event) => { patch({ civility: event.target.value as ProspectDraft['civility'] }); }}
          >
            <option value="">—</option>
            <option value="mr">M.</option>
            <option value="ms">Mme</option>
          </SelectField>
          <TextField label="Prénom" value={draft.first_name} error={messages.first_name} onChange={(event) => { patch({ first_name: event.target.value }); }} />
          <TextField label="Nom" value={draft.last_name} error={messages.last_name} onChange={(event) => { patch({ last_name: event.target.value }); }} />
          <TextField label="Fonction" value={draft.exact_job_title} onChange={(event) => { patch({ exact_job_title: event.target.value }); }} />
          <TextField
            label="E-mail"
            value={email?.value ?? ''}
            error={email ? messages[`emails.${String(draft.emails.indexOf(email))}.address`] : undefined}
            disabled={!email}
            hint={email ? undefined : 'Aucune adresse enregistrée : ajoutez-la depuis la fiche complète.'}
            onChange={(event) => {
              if (email) patchAlias('emails', email.key, event.target.value)
            }}
          />
          <TextField
            label="Téléphone"
            value={phone?.value ?? ''}
            error={phone ? messages[`phones.${String(draft.phones.indexOf(phone))}.number`] : undefined}
            disabled={!phone}
            onChange={(event) => {
              if (phone) patchAlias('phones', phone.key, event.target.value)
            }}
          />
          <SelectField label="Mettre en cohorte (facultatif)" value={cohortId} onChange={(event) => { setCohortId(event.target.value); }}>
            <option value="">Aucune cohorte</option>
            {(cohorts.data ?? []).map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.code}
                {cohort.starts_on ? ` — ${cohort.starts_on}` : ' — hors campagne'}
                {` — ${String(cohort.current_count)} fiche${cohort.current_count > 1 ? 's' : ''}`}
              </option>
            ))}
          </SelectField>
          <TextField label="Note si doute (facultatif)" value={note} onChange={(event) => { setNote(event.target.value); }} />
        </div>

        <div className="verification__copy">
          <TextField
            label="À copier : nom, prénom, e-mail, téléphone, fonction, entreprise"
            hint="Séparés par une tabulation : collez directement dans Excel pour remplir une ligne."
            readOnly
            value={copyLine}
            onFocus={(event) => {
              event.target.select()
            }}
          />
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(copyLine).then(() => {
                setCopied(true)
              })
            }}
          >
            {copied ? 'Copié' : 'Copier'}
          </Button>
        </div>

        {error && <p role="alert" className="verification__error">{error}</p>}

        <div className="verification__actions">
          <Button type="submit" variant="primary" icon={CheckCircleIcon} loading={busy} disabled={busy}>
            Valider et suivant
          </Button>
          <Button
            className="verification__btn--warning"
            icon={AlertIcon}
            disabled={busy}
            onClick={() => void flagUncertain()}
          >
            Incertain
          </Button>
          <Button variant="danger" icon={BanIcon} disabled={busy} onClick={() => void ignore()}>
            {confirmIgnore ? 'Confirmer : ignorer définitivement' : 'Ignorer'}
          </Button>
          <Button icon={ChevronRightIcon} disabled={busy} onClick={onSkip}>
            Passer
          </Button>
          <Button variant="ghost" icon={ChevronLeftIcon} disabled={busy || !onBack} onClick={onBack}>
            Retour
          </Button>
        </div>
        <p className="verification__hint">
          <Link to={`/prospection?prospect=${prospect.id}`}>Ouvrir la fiche complète</Link>
        </p>
      </form>
    </Card>
  )
}
