import { BoltIcon, DatabaseIcon, HomeIcon, type IconComponent, SlidersIcon, UsersIcon } from '../ui/icons'

export interface NavigationItem {
  path: string
  label: string
  icon: IconComponent
}

export const NAVIGATION: readonly NavigationItem[] = [
  { path: '/', label: 'Accueil', icon: HomeIcon },
  { path: '/prospection', label: 'Prospection', icon: UsersIcon },
  { path: '/exploitation', label: 'Exploitation', icon: BoltIcon },
  { path: '/database', label: 'Base de données', icon: DatabaseIcon },
  { path: '/settings', label: 'Paramètres', icon: SlidersIcon },
]
