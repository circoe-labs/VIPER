// Navigation principale du client (Task 08) : pur, testable.
// Pas de routeur d'URL : la page courante est mémorisée dans localStorage (`viper.ui.page`).
// Ancienne page « Exploitation » (décision 15) : la valeur `exploitation` mémorisée est redirigée vers `contact`.

export type Page = 'home' | 'prospection' | 'contact' | 'database' | 'settings';

export const PAGE_STORAGE_KEY = 'viper.ui.page';

export const nav: readonly (readonly [Page, string])[] = [
  ['home', 'Accueil'], ['prospection', 'Prospection'], ['contact', 'Contact'], ['database', 'Base de données'], ['settings', 'Paramètres']
];

/** Anciens identifiants de page encore présents dans des navigateurs déjà utilisés. */
const legacyPages: ReadonlyMap<string, Page> = new Map([['exploitation', 'contact']]);

const isPage = (value: string): value is Page => nav.some(([id]) => id === value);

/** Page à afficher au chargement depuis la valeur mémorisée (absente, inconnue ou ancienne). */
export function resolveStoredPage(saved: string | null | undefined): Page {
  if (!saved) return 'home';
  if (isPage(saved)) return saved;
  return legacyPages.get(saved) ?? 'home';
}

/** Lit la page mémorisée ; réécrit immédiatement une ancienne valeur (`exploitation` → `contact`). */
export function loadStoredPage(storage: Pick<Storage, 'getItem' | 'setItem'>): Page {
  let saved: string | null;
  try { saved = storage.getItem(PAGE_STORAGE_KEY); } catch { return 'home'; }
  const page = resolveStoredPage(saved);
  if (saved && legacyPages.has(saved)) {
    try { storage.setItem(PAGE_STORAGE_KEY, page); } catch { /* stockage indisponible : la page reste résolue */ }
  }
  return page;
}

export function storePage(storage: Pick<Storage, 'setItem'>, page: Page) {
  try { storage.setItem(PAGE_STORAGE_KEY, page); } catch { /* stockage indisponible : navigation non mémorisée */ }
}
