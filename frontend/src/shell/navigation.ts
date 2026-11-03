import {
  BuildingIcon,
  CalendarIcon,
  DatabaseIcon,
  HomeIcon,
  type IconComponent,
  MailIcon,
  SlidersIcon,
  SparklesIcon,
  UsersIcon,
} from '../ui/icons'

export interface NavigationItem {
  path: string
  label: string
  icon: IconComponent
}

export const NAVIGATION: readonly NavigationItem[] = [
  { path: '/', label: 'Accueil', icon: HomeIcon },
  { path: '/prospection', label: 'Prospection', icon: UsersIcon },
  { path: '/contact', label: 'Contact', icon: MailIcon },
  { path: '/missions', label: 'Missions', icon: SparklesIcon },
  { path: '/agenda', label: 'Agenda', icon: CalendarIcon },
  { path: '/database', label: 'Base de données', icon: DatabaseIcon },
  { path: '/organisation', label: 'Organisation', icon: BuildingIcon },
  { path: '/settings', label: 'Paramètres', icon: SlidersIcon },
]
