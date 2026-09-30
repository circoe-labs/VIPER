import { DatabaseIcon, HomeIcon, type IconComponent, MailIcon, SlidersIcon, UsersIcon } from '../ui/icons'

export interface NavigationItem {
  path: string
  label: string
  icon: IconComponent
}

export const NAVIGATION: readonly NavigationItem[] = [
  { path: '/', label: 'Accueil', icon: HomeIcon },
  { path: '/prospection', label: 'Prospection', icon: UsersIcon },
  { path: '/contact', label: 'Contact', icon: MailIcon },
  { path: '/database', label: 'Base de données', icon: DatabaseIcon },
  { path: '/settings', label: 'Paramètres', icon: SlidersIcon },
]
