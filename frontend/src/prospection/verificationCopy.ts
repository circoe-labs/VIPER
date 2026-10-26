// What « Copier » hands out from the verification card: a tab-separated row for Excel, readable text, JSON, or a prompt
// for an AI agent that must check the fiche and fill the gaps.

export interface FicheSnapshot {
  entreprise: string
  ville: string
  site_web: string
  domaine_email: string
  civilite: string
  prenom: string
  nom: string
  fonction: string
  emails: string[]
  telephones: string[]
  source: string
  doutes: string[]
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim()

// Last name, first name, e-mail, phone, job title, company — one row to paste into Excel.
export function toExcelRow(fiche: FicheSnapshot): string {
  return [fiche.nom, fiche.prenom, fiche.emails.join('; '), fiche.telephones.join('; '), fiche.fonction, fiche.entreprise]
    .map(clean)
    .join('\t')
}

const LABELS: [keyof FicheSnapshot, string][] = [
  ['entreprise', 'Entreprise'],
  ['ville', 'Ville'],
  ['site_web', 'Site web'],
  ['domaine_email', 'Domaine e-mail'],
  ['civilite', 'Civilité'],
  ['prenom', 'Prénom'],
  ['nom', 'Nom'],
  ['fonction', 'Fonction'],
  ['emails', 'E-mail'],
  ['telephones', 'Téléphone'],
]

function show(value: string | string[]): string {
  const text = Array.isArray(value) ? value.join(' ; ') : value
  return clean(text)
}

export function missingLabels(fiche: FicheSnapshot): string[] {
  return LABELS.filter(([key]) => show(fiche[key]) === '').map(([, label]) => label)
}

export function toPlainText(fiche: FicheSnapshot): string {
  const lines = LABELS.map(([key, label]) => `${label} : ${show(fiche[key]) || '—'}`)
  if (fiche.source) lines.push(`Source : ${fiche.source}`)
  return lines.join('\n')
}

export function toJson(fiche: FicheSnapshot): string {
  return JSON.stringify(fiche, null, 2)
}

export function toPrompt(fiche: FicheSnapshot): string {
  const missing = missingLabels(fiche)
  const known = LABELS.filter(([key]) => show(fiche[key]) !== '')
    .map(([key, label]) => `- ${label} : ${show(fiche[key])}`)
    .join('\n')
  const parts = [
    'Tu es un agent de recherche chargé de vérifier et de compléter la fiche d’un contact professionnel B2B (prospection commerciale). Utilise la recherche web : site de l’entreprise, LinkedIn, annuaires professionnels, registres officiels.',
    `## Informations dont je dispose\n${known || '(aucune)'}`,
    `## Informations à vérifier\nVérifie que chacune des informations ci-dessus est exacte et à jour, en particulier :\n- que cette personne travaille bien aujourd’hui dans cette entreprise, et sa fonction exacte ;\n- que l’adresse e-mail est valide (format habituel des e-mails de l’entreprise, domaine correct) ;\n- que le numéro de téléphone est le bon (direct, standard ou mobile) ;\n- l’orthographe du nom, du prénom et de l’entreprise.`,
    `## Informations manquantes\n${missing.length > 0 ? `Il manque : ${missing.join(', ')}. Cherche-les et complète-les du mieux que tu peux.` : 'Rien ne manque, mais complète tout ce que tu peux trouver en plus (autre e-mail, autre numéro).'}`,
  ]
  if (fiche.doutes.length > 0) parts.push(`## Doutes déjà signalés\n${fiche.doutes.map((doubt) => `- ${doubt}`).join('\n')}`)
  parts.push(
    '## Règles\n- Ne devine rien : si une information est introuvable ou incertaine, écris « non trouvé » ou « incertain ».\n- Pour chaque information trouvée ou corrigée, donne la source (URL).\n- Si la personne a quitté l’entreprise, dis-le et indique, si tu le trouves, son nouveau poste.',
    '## Réponse attendue\nRéponds par un objet JSON avec les clés : entreprise, civilite, prenom, nom, fonction, emails, telephones, statut (« confirmé », « corrigé », « a quitté l’entreprise » ou « incertain »), corrections (liste), sources (liste d’URL).',
  )
  return parts.join('\n\n')
}
