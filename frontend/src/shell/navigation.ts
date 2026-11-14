import {
  BoltIcon,
  BuildingIcon,
  CalendarIcon,
  ClockIcon,
  CpuIcon,
  DatabaseIcon,
  HomeIcon,
  type IconComponent,
  LinkIcon,
  MailIcon,
  SlidersIcon,
  SparklesIcon,
  TagIcon,
  UsersIcon,
} from '../ui/icons'

export type NavigationSectionId = 'main' | 'configuration' | 'admin'

export interface NavigationItem {
  path: string
  label: string
  icon: IconComponent
  // Hidden from non-administrators (the route is guarded the same way).
  adminOnly?: boolean
}

export interface NavigationSection {
  id: NavigationSectionId
  // Heading of the group (read by assistive technology even when the sidebar is collapsed).
  label: string
  // Administration is shown to administrators only; the routes are guarded the same way (auth/RequireAdmin).
  adminOnly?: boolean
  items: readonly NavigationItem[]
}

// Product grouping of the sidebar: daily work, configuration of the workspace, administration of VIPER itself.
// Categories / skills / sources are administered by organisation admins (the API checks every write), so they are
// flagged per item; the whole Administration group is admin-only.
export const NAVIGATION_SECTIONS: readonly NavigationSection[] = [
  {
    id: 'main',
    label: 'Principal',
    items: [
      { path: '/', label: 'Accueil', icon: HomeIcon },
      { path: '/prospection', label: 'Prospection', icon: UsersIcon },
      { path: '/contact', label: 'Contact', icon: MailIcon },
      { path: '/missions', label: 'Missions', icon: SparklesIcon },
      { path: '/agenda', label: 'Agenda', icon: CalendarIcon },
    ],
  },
  {
    id: 'configuration',
    label: 'Configuration',
    items: [
      { path: '/organisation', label: 'Organisation', icon: BuildingIcon },
      { path: '/configuration/categories', label: 'Catégories de mission', icon: TagIcon, adminOnly: true },
      { path: '/configuration/skills', label: 'Skills', icon: BoltIcon, adminOnly: true },
      { path: '/configuration/sources', label: 'Sources', icon: LinkIcon, adminOnly: true },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    adminOnly: true,
    items: [
      { path: '/database', label: 'Base de données', icon: DatabaseIcon },
      { path: '/historique-agents', label: 'Historique agents', icon: ClockIcon },
      { path: '/settings', label: 'Paramètres', icon: SlidersIcon },
      { path: '/config-ai', label: 'Config AI', icon: CpuIcon },
    ],
  },
]
