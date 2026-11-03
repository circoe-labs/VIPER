import { type ReactNode, useState } from 'react'

import { ApiError } from '../api/client'
import {
  type Member,
  type OrganizationDetail,
  type OrganizationRole,
  type OrganizationSummary,
  useAddMember,
  useCreateOrganization,
  useOrganization,
  useOrganizations,
  useUpdateMember,
  useUpdateOrganization,
} from '../api/organizations'
import { useCurrentUser } from '../auth/currentUser'
import { StatusBadge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Card } from '../ui/Card'
import { Modal } from '../ui/Dialog'
import { SelectField, TextField } from '../ui/fields'
import {
  BanIcon,
  BuildingIcon,
  CheckCircleIcon,
  ClockIcon,
  type IconComponent,
  KeyIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  UserPlusIcon,
  UsersIcon,
} from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { PageHeader } from '../ui/PageHeader'
import { Table } from '../ui/Table'
import './organization.css'

export const ROLE_LABELS: Record<OrganizationRole, string> = {
  admin: 'Administrateur',
  manager: 'Manager',
  member: 'Membre',
}

const ROLE_HELP: Record<OrganizationRole, string> = {
  admin:
    'Gère les membres de l’organisation : ajoute, donne n’importe quel rôle, désactive. Peut réinitialiser les données de prospection.',
  manager: 'Ajoute des membres (rôle Membre), les désactive ou les réactive. Ne change pas les rôles.',
  member: 'Utilise VIPER et voit la liste des membres.',
}

const ROLES: OrganizationRole[] = ['admin', 'manager', 'member']

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 403) return 'Votre rôle ne permet pas cette action.'
  if (error instanceof ApiError && (error.status === 409 || error.status === 422)) return error.message
  return fallback
}

function SectionHeader({ icon: Icon, title, actions }: { icon: IconComponent; title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="organization-section__header">
      <h2 className="organization-section__title">
        <Icon size={20} />
        {title}
      </h2>
      {actions && <div className="organization-section__actions">{actions}</div>}
    </header>
  )
}

// « Organisation »: the members and their roles. What a person sees and may do follows their role (the server says
// which actions it allows); the platform admin also creates organisations and switches between them.
export function OrganizationPage() {
  const me = useCurrentUser()
  const list = useOrganizations()
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const organizationId = selected ?? me.organization.id
  const detail = useOrganization(organizationId)

  return (
    <div className="organization-page">
      <PageHeader
        title="Organisation"
        actions={
          list.data?.can_create && (
            <Button
              variant="primary"
              icon={PlusIcon}
              onClick={() => {
                setCreating(true)
              }}
            >
              Nouvelle organisation
            </Button>
          )
        }
      />
      {list.data && list.data.organizations.length > 1 && (
        <nav className="organization-switcher" aria-label="Organisations">
          {list.data.organizations.map((organization) => (
            <button
              key={organization.id}
              type="button"
              className="organization-switcher__item"
              aria-current={organization.id === organizationId ? 'page' : undefined}
              onClick={() => {
                setSelected(organization.id)
              }}
            >
              <BuildingIcon size={16} />
              <span>{organization.name}</span>
              <span className="organization-switcher__count" title="Membres">
                {organization.members}
              </span>
            </button>
          ))}
        </nav>
      )}
      {detail.isLoading && <p className="organization-muted">Chargement…</p>}
      {detail.isError && (
        <p className="organization-error" role="alert">
          L’organisation n’a pas pu être chargée.
        </p>
      )}
      {detail.data && <OrganizationView key={detail.data.organization.id} detail={detail.data} meId={me.id} />}
      {creating && (
        <OrganizationDialog
          onClose={() => {
            setCreating(false)
          }}
          onSaved={setSelected}
        />
      )}
    </div>
  )
}

function OrganizationView({ detail, meId }: { detail: OrganizationDetail; meId: string }) {
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const { organization, members, assignable_roles: assignable } = detail
  const active = members.filter((member) => member.is_active).length
  const inactive = members.length - active

  return (
    <>
      <Card className="organization-section">
        <SectionHeader
          icon={BuildingIcon}
          title={organization.name}
          actions={
            detail.can_rename && (
              <IconButton
                icon={PencilIcon}
                size="sm"
                label="Modifier l’organisation"
                onClick={() => {
                  setRenaming(true)
                }}
              />
            )
          }
        />
        <dl className="organization-facts">
          <div>
            <dt>
              <UsersIcon size={16} /> Membres
            </dt>
            <dd>
              {active} actif{active > 1 ? 's' : ''}
              {inactive > 0 && ` · ${String(inactive)} désactivé${inactive > 1 ? 's' : ''}`}
            </dd>
          </div>
          <div>
            <dt>
              <KeyIcon size={16} /> Domaine
              <InfoTip label="Aide : domaine">
                Une première connexion Infomaniak avec une adresse de ce domaine rejoint l’organisation comme Membre.
              </InfoTip>
            </dt>
            <dd>{organization.email_domain ? `@${organization.email_domain}` : 'Aucun'}</dd>
          </div>
          <div>
            <dt>
              <ShieldCheckIcon size={16} /> Rôles
            </dt>
            <dd className="organization-roles">
              {ROLES.map((role) => (
                <span key={role} className={`role-chip role-chip--${role}`}>
                  {ROLE_LABELS[role]}
                  <InfoTip label={`Aide : ${ROLE_LABELS[role]}`} size={14}>
                    {ROLE_HELP[role]}
                  </InfoTip>
                </span>
              ))}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="organization-section">
        <SectionHeader
          icon={UsersIcon}
          title="Membres"
          actions={
            assignable.length > 0 && (
              <Button
                variant="primary"
                size="sm"
                icon={UserPlusIcon}
                onClick={() => {
                  setAdding(true)
                }}
              >
                Ajouter un membre
              </Button>
            )
          }
        />
        <MembersTable organizationId={organization.id} members={members} assignable={assignable} meId={meId} />
      </Card>

      {adding && (
        <AddMemberDialog
          organizationId={organization.id}
          assignable={assignable}
          onClose={() => {
            setAdding(false)
          }}
        />
      )}
      {renaming && (
        <OrganizationDialog
          organization={organization}
          onClose={() => {
            setRenaming(false)
          }}
        />
      )}
    </>
  )
}

function MembersTable({
  organizationId,
  members,
  assignable,
  meId,
}: {
  organizationId: string
  members: Member[]
  assignable: OrganizationRole[]
  meId: string
}) {
  const update = useUpdateMember(organizationId)
  return (
    <>
      {update.isError && (
        <p className="organization-error" role="alert">
          {errorText(update.error, 'La modification n’a pas pu être enregistrée.')}
        </p>
      )}
      <Table caption="Membres de l’organisation">
        <thead>
          <tr>
            <th scope="col">Personne</th>
            <th scope="col">Rôle</th>
            <th scope="col">Statut</th>
            <th scope="col">Dernière connexion</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id} className={member.is_active ? undefined : 'member-row--inactive'}>
              <td>
                <div className="member-cell">
                  <span className="member-cell__name">
                    {member.display_name}
                    {member.id === meId && <span className="member-cell__me">vous</span>}
                    {member.is_superadmin && (
                      <span className="member-cell__badge" title="Administrateur de la plateforme">
                        <LockIcon size={14} /> Plateforme
                      </span>
                    )}
                  </span>
                  <span className="member-cell__email">{member.email}</span>
                </div>
              </td>
              <td>
                {member.can_change_role ? (
                  <select
                    className="member-role-select"
                    aria-label={`Rôle de ${member.display_name}`}
                    value={member.role}
                    disabled={update.isPending}
                    onChange={(event) => {
                      update.mutate({ id: member.id, patch: { role: event.target.value as OrganizationRole } })
                    }}
                  >
                    {ROLES.filter((role) => role === member.role || assignable.includes(role)).map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={`role-chip role-chip--${member.role}`}>{ROLE_LABELS[member.role]}</span>
                )}
              </td>
              <td>
                <span className="member-status">
                  {member.is_active ? (
                    <StatusBadge tone="success">Actif</StatusBadge>
                  ) : (
                    <StatusBadge tone="neutral" icon={BanIcon}>
                      Désactivé
                    </StatusBadge>
                  )}
                  {member.infomaniak_linked ? (
                    <span className="member-status__hint" title="Compte Infomaniak lié">
                      <CheckCircleIcon size={14} /> Infomaniak
                    </span>
                  ) : (
                    <span className="member-status__hint" title="Ne s’est pas encore connecté avec Infomaniak">
                      <ClockIcon size={14} /> En attente
                    </span>
                  )}
                </span>
              </td>
              <td className="member-date">
                {member.last_login_at ? dateFormat.format(new Date(member.last_login_at)) : '—'}
              </td>
              <td className="member-actions">
                {member.can_edit &&
                  (member.is_active ? (
                    <IconButton
                      icon={BanIcon}
                      size="sm"
                      label={`Désactiver ${member.display_name}`}
                      disabled={update.isPending}
                      onClick={() => {
                        update.mutate({ id: member.id, patch: { is_active: false } })
                      }}
                    />
                  ) : (
                    <IconButton
                      icon={CheckCircleIcon}
                      size="sm"
                      label={`Réactiver ${member.display_name}`}
                      disabled={update.isPending}
                      onClick={() => {
                        update.mutate({ id: member.id, patch: { is_active: true } })
                      }}
                    />
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  )
}

function AddMemberDialog({
  organizationId,
  assignable,
  onClose,
}: {
  organizationId: string
  assignable: OrganizationRole[]
  onClose: () => void
}) {
  const add = useAddMember(organizationId)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<OrganizationRole>(
    assignable.includes('member') ? 'member' : (assignable[0] ?? 'member'),
  )
  const ready = email.trim().includes('@') && name.trim() !== ''
  return (
    <Modal
      open
      size="sm"
      title="Ajouter un membre"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button
            variant="primary"
            icon={UserPlusIcon}
            disabled={!ready}
            loading={add.isPending}
            onClick={() => {
              add.mutate({ email: email.trim(), display_name: name.trim(), role }, { onSuccess: onClose })
            }}
          >
            Ajouter
          </Button>
        </>
      }
    >
      <div className="organization-form">
        <TextField
          label="Adresse e-mail"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
          }}
          placeholder="prenom.nom@circoe.com"
        />
        <TextField
          label="Nom affiché"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
        <SelectField
          label="Rôle"
          value={role}
          onChange={(event) => {
            setRole(event.target.value as OrganizationRole)
          }}
        >
          {assignable.map((value) => (
            <option key={value} value={value}>
              {ROLE_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <p className="organization-note">
          <KeyIcon size={16} /> La personne se connecte ensuite avec le compte Infomaniak de cette adresse.
        </p>
        {add.isError && (
          <p className="organization-error" role="alert">
            {errorText(add.error, 'Le membre n’a pas pu être ajouté.')}
          </p>
        )}
      </div>
    </Modal>
  )
}

function OrganizationDialog({
  organization,
  onClose,
  onSaved,
}: {
  organization?: OrganizationSummary
  onClose: () => void
  onSaved?: (id: string) => void
}) {
  const create = useCreateOrganization()
  const update = useUpdateOrganization(organization?.id ?? '')
  const saving = organization ? update : create
  const [name, setName] = useState(organization?.name ?? '')
  const [domain, setDomain] = useState(organization?.email_domain ?? '')
  return (
    <Modal
      open
      size="sm"
      title={organization ? 'Modifier l’organisation' : 'Nouvelle organisation'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button
            variant="primary"
            disabled={name.trim() === ''}
            loading={saving.isPending}
            onClick={() => {
              saving.mutate(
                { name: name.trim(), email_domain: domain.trim() || null },
                {
                  onSuccess: (detail) => {
                    onClose()
                    onSaved?.(detail.organization.id)
                  },
                },
              )
            }}
          >
            {organization ? 'Enregistrer' : 'Créer'}
          </Button>
        </>
      }
    >
      <div className="organization-form">
        <TextField
          label="Nom"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
        <TextField
          label="Domaine e-mail (facultatif)"
          value={domain}
          placeholder="exemple.fr"
          onChange={(event) => {
            setDomain(event.target.value)
          }}
        />
        {saving.isError && (
          <p className="organization-error" role="alert">
            {errorText(saving.error, 'L’organisation n’a pas pu être enregistrée.')}
          </p>
        )}
      </div>
    </Modal>
  )
}
