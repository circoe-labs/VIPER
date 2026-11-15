import { Navigate, useParams } from 'react-router'

import { PageHeader } from '../ui/PageHeader'
import { CategoriesAdmin } from './CategoriesAdmin'
import { SkillsAdmin } from './SkillsAdmin'
import { SourcesAdmin } from './SourcesAdmin'

const SECTIONS = {
  categories: {
    title: 'Catégories de mission',
    description: 'Ce que l’on choisit en créant une mission : icône, couleur, consigne, skills et sources.',
    Section: CategoriesAdmin,
  },
  skills: {
    title: 'Skills',
    description: 'Blocs de consignes réutilisables, rattachés à des catégories ou à des missions.',
    Section: SkillsAdmin,
  },
  sources: {
    title: 'Sources',
    description: 'Bibliothèque des sources externes que les agents consultent, avec leurs sous-sources.',
    Section: SourcesAdmin,
  },
} as const

// `/administration/<section>`: reached from the sidebar's Administration group, which only administrators see (the
// route itself is guarded by RequireAdmin in routes.tsx and the API checks every write again).
export function AdministrationPage() {
  const { section } = useParams()
  if (section !== 'categories' && section !== 'skills' && section !== 'sources') {
    return <Navigate to="/administration/categories" replace />
  }
  const { title, description, Section } = SECTIONS[section]
  return (
    <>
      <PageHeader title={title} description={description} />
      <Section />
    </>
  )
}
