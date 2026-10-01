import type { ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router'

import { useReferents, useTaxonomyValues } from '../api/settings'
import { useToolboxStatus } from '../api/toolbox'
import { StatusBadge } from '../ui/Badge'
import { PageHeader } from '../ui/PageHeader'
import { ConnectionsSection } from './ConnectionsSection'
import { ReferentSection } from './ReferentSection'
import { TaxonomySection, type TaxonomySectionConfig } from './TaxonomySection'
import { STATE_BADGES } from './toolboxCopy'
import './settings.css'

const TAXONOMY_SECTIONS: TaxonomySectionConfig[] = [
  {
    kind: 'roles',
    title: 'Rôles',
    description:
      'Rôle d’un prospect dans son entreprise (le poste exact reste saisi à part sur la fiche). Les formulaires peuvent aussi créer un rôle à la volée.',
    addLabel: 'Nouveau rôle',
    placeholder: 'Ex. Responsable qualité',
    searchLabel: 'Rechercher un rôle',
    listLabel: 'Liste des rôles',
    emptyTitle: 'Aucun rôle pour l’instant',
    usageNoun: 'prospects',
  },
  {
    kind: 'activity-categories',
    title: 'Catégories d’activité',
    description: 'Activités d’une entreprise ; une entreprise peut en avoir plusieurs.',
    addLabel: 'Nouvelle catégorie',
    placeholder: 'Ex. Transport frigorifique',
    searchLabel: 'Rechercher une catégorie',
    listLabel: 'Liste des catégories d’activité',
    emptyTitle: 'Aucune catégorie pour l’instant',
    usageNoun: 'companies',
  },
  {
    kind: 'commercial-segments',
    title: 'Segments commerciaux',
    description: 'Segment principal d’une entreprise : un seul par entreprise.',
    addLabel: 'Nouveau segment',
    placeholder: 'Ex. Commissionnaire',
    searchLabel: 'Rechercher un segment',
    listLabel: 'Liste des segments commerciaux',
    emptyTitle: 'Aucun segment pour l’instant',
    usageNoun: 'companies',
  },
]

const REFERENTS_PATH = 'referents'
// Also the OAuth return page of the CIRCOE Toolbox (`VIPER_TOOLBOX_OAUTH_REDIRECT_URI`, Contact port S6).
const CONNECTIONS_PATH = 'connections'

// Paramètres (Task 06): the four administrable lists behind the record editors' pickers, then the external
// connections (S6). `/settings` shows the first section; `/settings/<section>` deep-links to one.
export function SettingsPage() {
  const { section = TAXONOMY_SECTIONS[0]?.kind } = useParams()
  const taxonomy = TAXONOMY_SECTIONS.find((config) => config.kind === section)
  if (!taxonomy && section !== REFERENTS_PATH && section !== CONNECTIONS_PATH) {
    return <Navigate to="/settings" replace />
  }
  const panelLabel = taxonomy?.title ?? (section === CONNECTIONS_PATH ? 'Connexions' : 'Référents internes')

  return (
    <>
      <PageHeader
        title="Paramètres"
        description="Listes de valeurs communes aux fiches entreprises et prospects, référents internes Circoe et connexions aux services externes. Chaque modification est tracée dans l’historique."
      />
      <nav className="settings-tabs" aria-label="Sections des paramètres">
        {TAXONOMY_SECTIONS.map((config) => (
          <SectionLink key={config.kind} path={config.kind} title={config.title} current={section === config.kind}>
            <TaxonomyCount config={config} />
          </SectionLink>
        ))}
        <SectionLink path={REFERENTS_PATH} title="Référents internes" current={section === REFERENTS_PATH}>
          <ReferentCount />
        </SectionLink>
        <SectionLink path={CONNECTIONS_PATH} title="Connexions" current={section === CONNECTIONS_PATH}>
          <ConnectionState />
        </SectionLink>
      </nav>
      <section className="settings-panel" aria-label={panelLabel}>
        {taxonomy ? (
          <TaxonomySection key={taxonomy.kind} config={taxonomy} />
        ) : section === CONNECTIONS_PATH ? (
          <ConnectionsSection />
        ) : (
          <ReferentSection />
        )}
      </section>
    </>
  )
}

function SectionLink({
  path,
  title,
  current,
  children,
}: {
  path: string
  title: string
  current: boolean
  children: ReactNode
}) {
  return (
    <Link to={`/settings/${path}`} className="settings-tabs__link" aria-current={current ? 'page' : undefined}>
      <span>{title}</span>
      {children}
    </Link>
  )
}

function Count({ total }: { total: number | undefined }) {
  return total === undefined ? null : (
    <span className="settings-tabs__count">
      {total}
      <span className="visually-hidden"> valeurs</span>
    </span>
  )
}

function TaxonomyCount({ config }: { config: TaxonomySectionConfig }) {
  return <Count total={useTaxonomyValues(config.kind).data?.length} />
}

function ReferentCount() {
  return <Count total={useReferents().data?.length} />
}

// Only the states that ask for something are flagged on the tab (connected or disabled say nothing).
function ConnectionState() {
  const state = useToolboxStatus().data?.state
  return state === 'expired' ? <StatusBadge tone="warning">{STATE_BADGES.expired.label}</StatusBadge> : null
}
