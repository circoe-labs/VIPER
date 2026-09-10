import * as XLSX from 'xlsx';
import crypto from 'node:crypto';

export type Diagnostic = { code: string; level: 'info' | 'warning' | 'error'; message: string };
export type PreviewRow = {
  row: number;
  raw: Record<string, unknown>;
  normalized: Record<string, unknown>;
  diagnostics: Diagnostic[];
  excluded: boolean;
};

const knownHeaderKeys = new Set([
  'referent', 'a contacter', 'entreprise', 'rdv obtenu', 'rendez vous obtenu', 'devis envoye', 'suivi',
  'relance 1', 'relance 2', 'mode de contact', 'categorie', 'civilite', 'nom', 'prenom', 'fonction', 'mail',
  'email', 'telephone', 'mobile', 'adresse', 'projet deja realise avec l entreprise', 'type de projet',
  'liste des fiches projets references circoe csv', 'references circoe', 'approche client', 'verification',
  'verifie', 'verifie ?', 'verification emploi', 'verification contact', 'email verifie', 'verification email',
  'date verification', 'date de verification', 'contact planifie', 'date contact', 'date de contact'
]);

const civMap: Record<string, string> = {
  m: 'M.', mr: 'M.', monsieur: 'M.', 'm.': 'M.', mme: 'Mme', 'mme.': 'Mme', madame: 'Mme', mlle: 'Mlle'
};

const verifiedTokens = new Set(['v', 'oui', 'yes', 'ok', 'fait', 'verifie', 'vérifié', 'valide', 'validé']);
const unverifiedTokens = new Set(['non', 'no', '?', '??', '???', 'x', 'xx', 'xxx', 'a verifier', 'à vérifier', 'inconnu']);

function text(value: unknown) {
  return value == null ? '' : String(value).trim();
}

function key(value: unknown) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9?]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function findKey(raw: Record<string, unknown>, aliases: string[]) {
  for (const alias of aliases) if (Object.prototype.hasOwnProperty.call(raw, alias)) return alias;
  const wanted = new Set(aliases.map(key));
  return Object.keys(raw).find(k => wanted.has(key(k)));
}

function read(raw: Record<string, unknown>, aliases: string[]) {
  const k = findKey(raw, aliases);
  return k == null ? undefined : raw[k];
}

function hasHeader(raw: Record<string, unknown>, aliases: string[]) {
  return findKey(raw, aliases) != null;
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function excelDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number') {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts) return new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  }
  const s = text(value);
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return null;
}

function isoWeekMonday(year: number, week: number) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  return monday;
}

export function resolveLegacyWeek(value: unknown, referenceDate: Date) {
  const s = text(value).toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^s(?:emaine)?(\d{1,2})$/i);
  if (!m) return null;
  const week = Number(m[1]);
  if (week < 1 || week > 53) return null;
  const candidates = [referenceDate.getUTCFullYear() - 1, referenceDate.getUTCFullYear(), referenceDate.getUTCFullYear() + 1]
    .map(year => isoWeekMonday(year, week))
    .sort((a, b) => Math.abs(a.getTime() - referenceDate.getTime()) - Math.abs(b.getTime() - referenceDate.getTime()));
  return { week, date: isoDate(candidates[0]) };
}

function verificationFrom(value: unknown, importedAt: Date) {
  const explicitDate = excelDate(value);
  if (explicitDate) return { verified: true, verifiedAt: explicitDate.toISOString(), raw: text(value) };
  const normalized = key(value);
  if (verifiedTokens.has(normalized)) return { verified: true, verifiedAt: importedAt.toISOString(), raw: text(value) };
  if (!normalized || unverifiedTokens.has(normalized)) return { verified: false, verifiedAt: null, raw: text(value) };
  return { verified: false, verifiedAt: null, raw: text(value), unknown: true };
}

function truthyLegacy(value: unknown) {
  const s = key(value);
  return Boolean(s) && !['non', 'no', '0', 'false', 'n a'].includes(s);
}

function trackingFromLegacy(raw: Record<string, unknown>) {
  const suivi = key(read(raw, ['Suivi']));
  const labels: [string, string[]][] = [
    ['won', ['commande passee', 'gagne', 'gagnee', 'won']],
    ['quote_follow_up', ['devis relance', 'relance devis']],
    ['quote_sent', ['devis envoye']],
    ['appointment_obtained', ['rdv obtenu', 'rendez vous obtenu', 'rendez vous pris']],
    ['response_received', ['reponse recue', 'reponse']],
    ['follow_up_2', ['relance 2']],
    ['follow_up_1', ['relance 1']],
    ['contacted', ['contacte', 'contactee']]
  ];
  for (const [status, variants] of labels) if (variants.includes(suivi)) return status;
  if (truthyLegacy(read(raw, ['Devis envoyé', 'Devis envoye']))) return 'quote_sent';
  if (truthyLegacy(read(raw, ['rdv obtenu', 'RDV obtenu', 'Rendez-vous obtenu']))) return 'appointment_obtained';
  if (truthyLegacy(read(raw, ['relance 2', 'Relance 2']))) return 'follow_up_2';
  if (truthyLegacy(read(raw, ['Relance 1', 'relance 1']))) return 'follow_up_1';
  return 'to_contact';
}

function normalizeCategory(value: unknown) {
  const s = text(value).replace(/^\d+\.\s*/, '').trim();
  if (!s || key(s) === 'non') return '';
  const k = key(s);
  if (k.includes('transport') && k.includes('logistique')) return 'Transport & logistique';
  if (k === 'logistique') return 'Logistique';
  return s;
}

function isReferentName(value: string) {
  const k = key(value);
  if (!k || verifiedTokens.has(k) || unverifiedTokens.has(k)) return false;
  if (value.includes('@')) return false;
  if (/(retrait|deced|décéd|mort|rdv|rendez)/i.test(value)) return false;
  const parts = value.split(/\s+/).filter(Boolean);
  return parts.length >= 1 && parts.length <= 4 && parts.every(p => /^[A-Za-zÀ-ÿ'’-]+$/.test(p));
}

function verificationAliases() {
  return ['Vérification', 'Verification', 'Vérifié', 'Verifie', 'Vérifié ?', 'Verifie ?', 'Vérification emploi', 'Verification emploi', 'Vérification contact'];
}

export function parseWorkbook(buffer: Buffer, filename = 'import.xlsx', referenceDate = new Date()) {
  const importedAt = new Date(referenceDate);
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets = wb.SheetNames.filter(n => key(n) !== 'actualite');
  const skippedSheets = wb.SheetNames.filter(n => key(n) === 'actualite');
  const rows: PreviewRow[] = [];

  for (const sheet of sheets) {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' }) as Record<string, unknown>[];
    data.forEach((raw, i) => {
      const diagnostics: Diagnostic[] = [];
      const company = text(read(raw, ['Entreprise']));
      const first = text(read(raw, ['Prénom', 'Prenom']));
      const last = text(read(raw, ['Nom']));
      const email = text(read(raw, ['Mail', 'Email'])).toLowerCase();
      const civRaw = text(read(raw, ['Civilité ', 'Civilité', 'Civilite']));
      const civ = civMap[key(civRaw)] || civRaw;
      const referentRaw = text(read(raw, ['Référent', 'Referent']));
      const explicitVerification = hasHeader(raw, verificationAliases());
      const verificationRaw = explicitVerification ? read(raw, verificationAliases()) : undefined;
      const legacyVerificationMarker = !explicitVerification && key(referentRaw) === 'v';
      const verification = explicitVerification
        ? verificationFrom(verificationRaw, importedAt)
        : legacyVerificationMarker
          ? { verified: true, verifiedAt: importedAt.toISOString(), raw: referentRaw }
          : { verified: false, verifiedAt: null, raw: '' };

      const legacyPlannedRaw = Object.prototype.hasOwnProperty.call(raw, 'A contacter ') ? text(raw['A contacter ']) : '';
      const plannedRaw = legacyPlannedRaw || text(read(raw, ['Contact planifié', 'Contact planifie', 'Date contact', 'Date de contact']));
      const plannedWeek = resolveLegacyWeek(plannedRaw, importedAt);
      const plannedDate = excelDate(plannedRaw);
      const plannedContactAt = plannedWeek?.date || (plannedDate ? isoDate(plannedDate) : null);
      const categoryRaw = text(read(raw, ['Catégorie', 'Categorie']));
      const category = normalizeCategory(categoryRaw);
      const emailVerificationRaw = read(raw, ['Email vérifié', 'Email verifie', 'Vérification email', 'Verification email']);
      const emailVerification = hasHeader(raw, ['Email vérifié', 'Email verifie', 'Vérification email', 'Verification email'])
        ? verificationFrom(emailVerificationRaw, importedAt)
        : { verified: false, verifiedAt: null, raw: '' };

      if (!company) diagnostics.push({ code: 'missing_company', level: 'error', message: 'Entreprise manquante' });
      if (!first && !last) diagnostics.push({ code: 'missing_identity', level: 'error', message: 'Identité manquante' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) diagnostics.push({ code: 'invalid_email', level: 'warning', message: 'Email à vérifier' });
      if (civRaw && civ === civRaw && !['M.', 'Mme', 'Mlle'].includes(civ)) diagnostics.push({ code: 'unknown_civility', level: 'warning', message: `Civilité non reconnue: ${civRaw}` });
      if (categoryRaw && !category) diagnostics.push({ code: 'invalid_category', level: 'warning', message: `Catégorie à vérifier: ${categoryRaw}` });
      if (explicitVerification && (verification as any).unknown) diagnostics.push({ code: 'unknown_verification', level: 'warning', message: `Valeur de vérification non reconnue: ${text(verificationRaw)}` });
      if (plannedWeek) diagnostics.push({ code: 'planned_week_resolved', level: 'info', message: `S${plannedWeek.week} interprétée au lundi ${plannedWeek.date}` });
      else if (/^s\d{1,2}$/i.test(plannedRaw)) diagnostics.push({ code: 'invalid_week', level: 'warning', message: `Semaine invalide: ${plannedRaw}` });
      if (/retrait/i.test(plannedRaw)) diagnostics.push({ code: 'legacy_anomaly', level: 'warning', message: 'Valeur retraité détectée : activité suggérée inactive' });
      if (referentRaw && !isReferentName(referentRaw) && !legacyVerificationMarker && !unverifiedTokens.has(key(referentRaw))) diagnostics.push({ code: 'ambiguous_referent', level: 'warning', message: 'Référent historique ambigu : conservé en métadonnées' });

      const unknown = Object.keys(raw).filter(k => {
        if (!text(raw[k])) return false;
        const normalized = key(k);
        return normalized && !knownHeaderKeys.has(normalized);
      });
      if (unknown.length) diagnostics.push({ code: 'unknown_columns', level: 'info', message: `Métadonnées conservées: ${unknown.join(', ')}` });

      rows.push({
        row: i + 2,
        raw,
        normalized: {
          sheet,
          company,
          first_name: first,
          last_name: last,
          civility: civ,
          job_title: text(read(raw, ['Fonction'])),
          email,
          email_verification_status: emailVerification.verified ? 'verified' : 'unverified',
          email_verified_at: emailVerification.verifiedAt,
          phone: text(read(raw, ['Téléphone', 'Telephone'])),
          mobile: text(read(raw, ['Mobile'])),
          address: text(read(raw, ['Adresse ', 'Adresse'])),
          category,
          category_raw: categoryRaw,
          referent: isReferentName(referentRaw) ? referentRaw : '',
          referent_raw: referentRaw,
          verification_state: verification.verified ? 'verified' : 'unverified',
          employment_verified_at: verification.verifiedAt,
          verification_source: explicitVerification ? 'excel_column' : legacyVerificationMarker ? 'legacy_marker' : 'none',
          planned_contact_raw: plannedRaw,
          planned_contact_at: plannedContactAt,
          tracking_status: trackingFromLegacy(raw),
          activity_status_suggestion: /retrait/i.test(plannedRaw) ? 'inactive' : '',
          project_done_with_circoe: text(read(raw, ["Projet déjà réalisé avec l'entreprise", "Projet deja realise avec l'entreprise"])),
          project_type: text(read(raw, ['Type de projet'])),
          circoe_references: text(read(raw, ['Liste des fiches projets_references_CIRCOE.csv', 'Références Circoe', 'References Circoe'])),
          client_approach: text(read(raw, ['Approche client'])),
          mode_contact_raw: text(read(raw, ['Mode de contact'])),
          legacy_to_contact_raw: text(Object.prototype.hasOwnProperty.call(raw, 'A contacter') ? raw['A contacter'] : '')
        },
        diagnostics,
        excluded: false
      });
    });
  }

  return {
    filename,
    sheets,
    skippedSheets,
    importedAt: importedAt.toISOString(),
    rows,
    fingerprint: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}
