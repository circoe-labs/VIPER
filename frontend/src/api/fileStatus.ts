// « Statut de la fiche » of a company or a warehouse (backend `app.services.file_status`): computed from the record,
// never typed in. verified > usable > incomplete; `missing` lists what keeps a file from its next level.
export const FILE_STATUSES = ['verified', 'usable', 'incomplete'] as const
export type FileStatus = (typeof FILE_STATUSES)[number]

export const FILE_STATUS_LABELS: Record<FileStatus, string> = {
  verified: 'Vérifié',
  usable: 'Exploitable',
  incomplete: 'Incomplet',
}

export const FILE_STATUS_HINTS: Record<'company' | 'warehouse', Record<FileStatus, string>> = {
  company: {
    verified: 'Exploitable, avec SIREN, raison sociale, effectif, segment et catégorie d’activité renseignés.',
    usable: 'Nom, site web ou domaine e-mail, SIREN ou site localisé, type, et au moins une personne exploitable dans la société.',
    incomplete: 'Il manque une information essentielle : la société ne doit pas être utilisée en l’état.',
  },
  warehouse: {
    verified: 'Exploitable, avec SIRET, adresse complète et un interlocuteur joignable (nom et e-mail).',
    usable: 'Nom, localisation, catégorie de prospection, et rattaché à un bâtiment d’une société exploitable.',
    incomplete: 'Il manque une information essentielle ou le rattachement à une société exploitable.',
  },
}

const MISSING_LABELS: Record<string, string> = {
  name: 'nom',
  channel: 'site web ou domaine e-mail',
  identity: 'SIREN ou établissement localisé',
  kind: 'type',
  person: 'personne exploitable',
  siren: 'SIREN',
  legal_name: 'raison sociale',
  size: 'effectif',
  segment: 'segment',
  activity: 'catégorie d’activité',
  location: 'code postal et ville',
  category: 'catégorie de prospection',
  company: 'société exploitable (bâtiment)',
  siret: 'SIRET',
  address: 'adresse',
  interlocutor: 'interlocuteur joignable',
}

export function missingText(missing: readonly string[]): string {
  return missing.map((code) => MISSING_LABELS[code] ?? code).join(', ')
}

export const FILE_STATUS_TONES = { verified: 'success', usable: 'info', incomplete: 'warning' } as const
