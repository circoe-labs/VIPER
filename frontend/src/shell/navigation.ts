export interface NavigationItem {
  path: string
  label: string
}

export const NAVIGATION: readonly NavigationItem[] = [
  { path: '/', label: 'Accueil' },
  { path: '/prospection', label: 'Prospection' },
  { path: '/exploitation', label: 'Exploitation' },
  { path: '/database', label: 'Base de données' },
  { path: '/settings', label: 'Paramètres' },
]
