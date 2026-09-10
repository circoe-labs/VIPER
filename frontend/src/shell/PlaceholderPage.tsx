import type { ReactNode } from 'react'

import { EmptyState } from '../ui/EmptyState'
import type { IconComponent } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'

interface PlaceholderPageProps {
  title: string
  icon: IconComponent
  description?: ReactNode
}

// Empty route placeholder until the owning feature task replaces it. Shows no data by design.
export function PlaceholderPage({
  title,
  icon,
  description = 'Cette section sera construite dans une prochaine étape. Aucune donnée n’est affichée pour l’instant.',
}: PlaceholderPageProps) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState icon={icon} title="Bientôt disponible" description={description} />
    </>
  )
}
