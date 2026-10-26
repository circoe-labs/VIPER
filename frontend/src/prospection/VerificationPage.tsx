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
  type AliasKind,
  draftFromProspect,
  newAlias,
  type ProspectDraft,
  suggestedPhoneType,
  toInput,
  validate,
} from '../prospects/prospectForm'
import { StatusBadge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Card } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { SelectField, TextField } from '../ui/fields'
import type { Point } from '../ui/floating'
import { AlertIcon, BanIcon, CheckCircleIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, CopyIcon, PlusIcon } from '../ui/icons'
import { Menu, type MenuSection } from '../ui/Menu'
import { PageHeader } from '../ui/PageHeader'
import { type FicheSnapshot, toExcelRow, toJson, toPlainText, toPrompt } from './verificationCopy'
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

  // What the last « Incertain » did, shown until the next action.
  const [notice, setNotice] = useState<string | null>(null)

  function leave(id: string) {
    setTrail((ids) => (ids.at(-1) === id ? ids : [...ids, id]))
    setRevisit(null)
    setNotice(null)
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
      {notice && (
        <p role="status" className="verification__notice">
          <StatusBadge tone="success">{notice}</StatusBadge>
        </p>
      )}
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
          onUncertain={(message) => {
            leave(shownId)
            setSkipped((ids) => [...ids, shownId])
            setNotice(message)
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
  onUncertain: (message: string) => void
  // Back to the fiche seen just before; absent on the first one.
  onBack: (() => void) | undefined
}

// Loads the full prospect, then hands it to the form (which owns its draft).
function VerificationCard({ id, onValidated, onSkip, onUncertain, onBack }: CardProps) {
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
  return (
    <VerificationForm
      prospect={prospect.data}
      onValidated={onValidated}
      onSkip={onSkip}
      onUncertain={onUncertain}
      onBack={onBack}
    />
  )
}

function primaryOf(aliases: AliasDraft[]): AliasDraft | undefined {
  return aliases.find((alias) => alias.is_primary && alias.is_active) ?? aliases.find((alias) => alias.is_active)
}

// A fiche without any address / number still shows one empty line to type into (an empty new line is never saved).
function withBlankLines(draft: ProspectDraft): ProspectDraft {
  const ensured = (kind: AliasKind, aliases: AliasDraft[]) =>
    aliases.some((alias) => alias.is_active) ? aliases : [...aliases, newAlias(kind, true)]
  return { ...draft, emails: ensured('emails', draft.emails), phones: ensured('phones', draft.phones) }
}

interface AliasFieldsProps {
  kind: AliasKind
  label: string
  addLabel: string
  aliases: AliasDraft[]
  // « À compléter » when the whole kind is empty and the person was warned; undefined otherwise.
  incomplete: string | undefined
  messages: Record<string, string>
  onEdit: (kind: AliasKind, key: string, value: string) => void
  onAdd: (kind: AliasKind) => void
  onRemove: (kind: AliasKind, key: string) => void
}

// Every active address / number of the fiche, one line each (the first is the main one), and a button to add another.
function AliasFields({ kind, label, addLabel, aliases, incomplete, messages, onEdit, onAdd, onRemove }: AliasFieldsProps) {
  const lines = aliases.filter((alias) => alias.is_active)
  return (
    <div className="verification__aliases">
      {lines.map((alias, position) => {
        const path = `${kind}.${String(aliases.indexOf(alias))}.${kind === 'emails' ? 'address' : 'number'}`
        return (
          <div key={alias.key} className="verification__alias">
            <TextField
              label={position === 0 ? label : `${label} ${String(position + 1)}`}
              value={alias.value}
              error={messages[path] ?? (position === 0 ? incomplete : undefined)}
              onChange={(event) => {
                onEdit(kind, alias.key, event.target.value)
              }}
            />
            {position > 0 && (
              <IconButton
                icon={CloseIcon}
                label={`Retirer ${label.toLowerCase()} ${String(position + 1)}`}
                onClick={() => {
                  onRemove(kind, alias.key)
                }}
              />
            )}
          </div>
        )
      })}
      <Button variant="ghost" size="sm" icon={PlusIcon} onClick={() => { onAdd(kind) }}>
        {addLabel}
      </Button>
    </div>
  )
}

interface FormProps {
  prospect: Prospect
  onValidated: () => void
  onSkip: () => void
  // The doubt is recorded on the fiche: says what was written, then moves on.
  onUncertain: (message: string) => void
  onBack: (() => void) | undefined
}

function VerificationForm({ prospect, onValidated, onSkip, onUncertain, onBack }: FormProps) {
  const [draft, setDraft] = useState<ProspectDraft>(() => withBlankLines(draftFromProspect(prospect)))
  const [cohortId, setCohortId] = useState('')
  const [note, setNote] = useState('')
  const [confirmIgnore, setConfirmIgnore] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyMenuAt, setCopyMenuAt] = useState<Point | null>(null)
  const [warned, setWarned] = useState(false)
  const [companyName, setCompanyName] = useState(prospect.company?.display_name ?? '')
  const [error, setError] = useState<string | null>(null)
  const companies = useCompanyMutations()
  const mutations = useProspectMutations()
  const sequence = useSequenceMutations(prospect.id)
  const cohorts = useCohorts()
  const alerts = useProspectAlerts(prospect.id)
  const busy = companies.update.isPending || mutations.update.isPending || mutations.tracking.isPending || sequence.changeCohort.isPending || sequence.raiseAlert.isPending

  const openAlerts = (alerts.data?.items ?? []).filter((alert) => alert.open)
  const source = prospect.sources[0]
  // What is on screen (not what is saved), in the shapes the « Copier » menu offers.
  const listOf = (aliases: AliasDraft[]) =>
    aliases.filter((alias) => alias.is_active && alias.value.trim() !== '').map((alias) => alias.value.trim())
  const snapshot: FicheSnapshot = {
    entreprise: companyName,
    ville: prospect.company?.city ?? '',
    site_web: prospect.company?.website_url ?? '',
    domaine_email: prospect.company?.email_domain ?? '',
    civilite: draft.civility === 'mr' ? 'M.' : draft.civility === 'ms' ? 'Mme' : '',
    prenom: draft.first_name,
    nom: draft.last_name,
    fonction: draft.exact_job_title,
    emails: listOf(draft.emails),
    telephones: listOf(draft.phones),
    source: source ? (source.import_filename ?? source.source_reference ?? 'saisie manuelle') : '',
    doutes: openAlerts.map((alert) => alert.note ?? 'Alerte ouverte'),
  }
  const copyItems: MenuSection[] = [
    {
      items: [
        { id: 'excel', label: 'Ligne Excel (tabulations)', hint: 'nom, prénom, e-mail…', build: toExcelRow },
        { id: 'text', label: 'Texte brut', build: toPlainText },
        { id: 'json', label: 'JSON', build: toJson },
        { id: 'prompt', label: 'Prompt pour un agent IA', hint: 'vérifier + compléter', build: toPrompt },
      ].map(({ id, label, hint, build }) => ({
        id,
        label,
        hint,
        icon: CopyIcon,
        onSelect: () => {
          void navigator.clipboard.writeText(build(snapshot)).then(() => {
            setCopied(true)
          })
        },
      })),
    },
  ]
  const messages = validate(draft, { isNew: false, today: prospect.today })

  // Empty boxes: shown in red once « Valider » was pressed with some missing (a second press validates anyway).
  const blank = (value: string) => value.trim() === ''
  const filled = (aliases: AliasDraft[]) => aliases.some((alias) => alias.is_active && !blank(alias.value))
  const allGaps = [
    { key: 'company', label: 'entreprise', empty: blank(companyName) },
    { key: 'civility', label: 'civilité', empty: draft.civility === '' },
    { key: 'first', label: 'prénom', empty: blank(draft.first_name) },
    { key: 'last', label: 'nom', empty: blank(draft.last_name) },
    { key: 'job', label: 'fonction', empty: blank(draft.exact_job_title) },
    { key: 'email', label: 'e-mail', empty: !filled(draft.emails) },
    { key: 'phone', label: 'téléphone', empty: !filled(draft.phones) },
  ]
  const gaps = allGaps.filter((gap) => gap.empty)
  const redIf = (key: string) => (warned && gaps.some((gap) => gap.key === key) ? 'À compléter' : undefined)

  function patch(changes: Partial<ProspectDraft>) {
    setDraft((current) => ({ ...current, ...changes }))
  }

  function typed(kind: AliasKind, alias: AliasDraft, value: string): AliasDraft {
    return {
      ...alias,
      value,
      type: kind === 'phones' && !alias.typeChosen ? (suggestedPhoneType(value) ?? 'other') : alias.type,
    }
  }

  function editAlias(kind: AliasKind, key: string, value: string) {
    setDraft((current) => ({
      ...current,
      [kind]: current[kind].map((alias) => (alias.key === key ? typed(kind, alias, value) : alias)),
    }))
  }

  // A new empty line; the first one of a kind is the main one. Empty new lines are left out of the save.
  function addAlias(kind: AliasKind) {
    setDraft((current) => ({
      ...current,
      [kind]: [...current[kind], newAlias(kind, !primaryOf(current[kind]))],
    }))
  }

  // A new line is dropped; a stored one becomes an old address / number (inactive), never deleted. The main one stays
  // main: if it is retired, the next active one takes over.
  function removeAlias(kind: AliasKind, key: string) {
    setDraft((current) => {
      const list = current[kind]
        .filter((alias) => !(alias.key === key && alias.id === null))
        .map((alias) => (alias.key === key ? { ...alias, is_active: false, is_primary: false } : alias))
      const heir = list.find((alias) => alias.is_active)
      const withMain =
        heir && !list.some((alias) => alias.is_active && alias.is_primary)
          ? list.map((alias) => (alias === heir ? { ...alias, is_primary: true } : alias))
          : list
      return { ...current, [kind]: withMain }
    })
  }

  function verified(aliases: AliasDraft[]): AliasDraft[] {
    return aliases.map((alias) =>
      alias.is_active && alias.value.trim() !== '' && alias.verification_status !== 'invalid'
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
    if (gaps.length > 0 && !warned) {
      setWarned(true)
      setError(`Il manque : ${gaps.map((gap) => gap.label).join(', ')}. Complète-les, ou clique à nouveau pour valider quand même.`)
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
    const who = [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') || 'ce contact'
    if (openAlerts.some((item) => item.type === 'function_to_check')) {
      onUncertain(`Incertitude déjà notée sur la fiche de ${who}.`)
      return
    }
    try {
      await renameCompany()
      await sequence.raiseAlert.mutateAsync({
        type: 'function_to_check',
        note: note.trim() || 'Incertitude sur ce contact : à contacter pour vérifier si on le garde.',
      })
      onUncertain(`Incertitude notée sur la fiche de ${who} (alerte « Fonction à vérifier »).`)
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
        <div className="verification__head">
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
          <Button
            className="verification__btn--copy"
            icon={copied ? CheckCircleIcon : CopyIcon}
            aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setCopyMenuAt({ x: rect.right, y: rect.bottom + 4 })
            }}
          >
            {copied ? 'Copié' : 'Copier'}
          </Button>
          {copyMenuAt && (
            <Menu
              label="Copier les informations"
              position={copyMenuAt}
              alignRight
              sections={copyItems}
              onClose={() => {
                setCopyMenuAt(null)
              }}
            />
          )}
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
            error={redIf('company') ?? messages.company_id}
            disabled={!prospect.company}
            onChange={(event) => {
              setCompanyName(event.target.value)
            }}
          />
          <SelectField
            label="Civilité"
            value={draft.civility}
            error={redIf('civility')}
            onChange={(event) => { patch({ civility: event.target.value as ProspectDraft['civility'] }); }}
          >
            <option value="">—</option>
            <option value="mr">M.</option>
            <option value="ms">Mme</option>
          </SelectField>
          <TextField label="Prénom" value={draft.first_name} error={messages.first_name ?? redIf('first')} onChange={(event) => { patch({ first_name: event.target.value }); }} />
          <TextField label="Nom" value={draft.last_name} error={messages.last_name ?? redIf('last')} onChange={(event) => { patch({ last_name: event.target.value }); }} />
          <TextField label="Fonction" value={draft.exact_job_title} error={redIf('job')} onChange={(event) => { patch({ exact_job_title: event.target.value }); }} />
          <AliasFields
            kind="emails"
            label="E-mail"
            addLabel="Ajouter un e-mail"
            aliases={draft.emails}
            incomplete={redIf('email')}
            messages={messages}
            onEdit={editAlias}
            onAdd={addAlias}
            onRemove={removeAlias}
          />
          <AliasFields
            kind="phones"
            label="Téléphone"
            addLabel="Ajouter un téléphone"
            aliases={draft.phones}
            incomplete={redIf('phone')}
            messages={messages}
            onEdit={editAlias}
            onAdd={addAlias}
            onRemove={removeAlias}
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

        {error && <p role="alert" className="verification__error">{error}</p>}

        <div className="verification__actions">
          <Button type="submit" variant="primary" icon={CheckCircleIcon} loading={busy} disabled={busy}>
            {warned && gaps.length > 0 ? 'Valider quand même' : 'Valider et suivant'}
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
