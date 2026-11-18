import type { TaxonomySectionConfig } from '../settings/TaxonomySection'

// The administrable lists of « Organisation » (sub-tabs managed by the organisation's administrators): they feed
// the pickers of the prospect and company editors. `kind` doubles as the tab's path segment.
export const TAXONOMY_SECTIONS: TaxonomySectionConfig[] = [
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
