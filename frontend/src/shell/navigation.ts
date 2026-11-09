import { BuildingIcon, CalendarIcon, ClockIcon, DatabaseIcon, HomeIcon, type IconComponent, MailIcon, SlidersIcon, SparklesIcon, UsersIcon, WarehouseIcon } from '../ui/icons'

export interface NavigationItem {
  path: string
  label: string
  icon: IconComponent
}

export const NAVIGATION: readonly NavigationItem[] = [
  { path: '/', label: 'Accueil', icon: HomeIcon },
  { path: '/prospection', label: 'Prospection', icon: UsersIcon },
  { path: '/warehouses', label: 'Entrepôts', icon: WarehouseIcon },
  { path: '/contact', label: 'Contacts', icon: MailIcon },
  { path: '/missions', label: 'Missions', icon: SparklesIcon },
  { path: '/agenda', label: 'Agenda', icon: CalendarIcon },
  { path: '/database', label: 'Base de données', icon: DatabaseIcon },
  { path: '/organisation', label: 'Organisation', icon: BuildingIcon },
  { path: '/historique-agents', label: 'Historique agents', icon: ClockIcon },
  { path: '/settings', label: 'Paramètres', icon: SlidersIcon },
]
