import type { ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router'

import { useReferents, useTaxonomyValues } from '../api/settings'
import { PageHeader } from '../ui/PageHeader'
import { ReferentSection } from './ReferentSection'
import { TaxonomySection, type TaxonomySectionConfig } from './TaxonomySection'
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

// Paramètres (Task 06): the four administrable lists behind the record editors' pickers. `/settings` shows the
// first section; `/settings/<section>` deep-links to one.
export function SettingsPage() {
  const { section = TAXONOMY_SECTIONS[0]?.kind } = useParams()
  const taxonomy = TAXONOMY_SECTIONS.find((config) => config.kind === section)
  if (!taxonomy && section !== REFERENTS_PATH) return <Navigate to="/settings" replace />

  return (
    <>
      <PageHeader
        title="Paramètres"
        description="Listes de valeurs communes aux fiches entreprises et prospects, et référents internes Circoe. Chaque modification est tracée dans l’historique."
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
      </nav>
      <section className="settings-panel" aria-label={taxonomy?.title ?? 'Référents internes'}>
        {taxonomy ? <TaxonomySection key={taxonomy.kind} config={taxonomy} /> : <ReferentSection />}
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
