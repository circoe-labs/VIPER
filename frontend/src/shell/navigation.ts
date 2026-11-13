import {
  BoltIcon,
  BuildingIcon,
  CalendarIcon,
  ClockIcon,
  DatabaseIcon,
  HomeIcon,
  type IconComponent,
  LinkIcon,
  SlidersIcon,
  SparklesIcon,
  TagIcon,
  UsersIcon,
  WarehouseIcon,
} from '../ui/icons'

export type NavigationSectionId = 'main' | 'configuration' | 'admin'

export interface NavigationItem {
  path: string
  label: string
  icon: IconComponent
}

export interface NavigationSection {
  id: NavigationSectionId
  // Heading of the group (read by assistive technology even when the sidebar is collapsed).
  label: string
  // Administration is shown to administrators only; the routes are guarded the same way (auth/RequireAdmin).
  adminOnly?: boolean
  items: readonly NavigationItem[]
}

// Product grouping of the sidebar: daily work, configuration of the workspace, administration of mission building blocks.
export const NAVIGATION_SECTIONS: readonly NavigationSection[] = [
  {
    id: 'main',
    label: 'Principal',
    items: [
      { path: '/', label: 'Accueil', icon: HomeIcon },
      { path: '/prospection', label: 'Prospection', icon: UsersIcon },
      { path: '/warehouses', label: 'Entrepôts', icon: WarehouseIcon },
      { path: '/missions', label: 'Missions', icon: SparklesIcon },
      { path: '/agenda', label: 'Agenda', icon: CalendarIcon },
      { path: '/database', label: 'Base de données', icon: DatabaseIcon },
    ],
  },
  {
    id: 'configuration',
    label: 'Configuration',
    items: [
      { path: '/organisation', label: 'Organisation', icon: BuildingIcon },
      { path: '/historique-agents', label: 'Historique agents', icon: ClockIcon },
      { path: '/settings', label: 'Paramètres', icon: SlidersIcon },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    adminOnly: true,
    items: [
      { path: '/administration/categories', label: 'Catégories', icon: TagIcon },
      { path: '/administration/skills', label: 'Skills', icon: BoltIcon },
      { path: '/administration/sources', label: 'Sources', icon: LinkIcon },
    ],
  },
]
