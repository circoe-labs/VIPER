import * as XLSX from 'xlsx';
import crypto from 'node:crypto';
import { inferRoleSlug, roleLabelForSlug } from './roleTaxonomy.js';
const knownHeaderKeys = new Set([
    'statut verification', 'referent', 'a contacter', 'entreprise', 'rdv obtenu', 'rendez vous obtenu', 'devis envoye', 'suivi',
    'relance 1', 'relance 2', 'mode de contact', 'categorie', 'civilite', 'nom', 'prenom', 'fonction', 'mail',
    'email', 'telephone', 'mobile', 'adresse', 'projet deja realise avec l entreprise', 'type de projet',
    'liste des fiches projets references circoe csv', 'references circoe', 'approche client', 'verification',
    'verifie', 'verifie ?', 'verification emploi', 'verification contact', 'email verifie', 'verification email',
    'date verification', 'date de verification', 'contact planifie', 'date contact', 'date de contact'
]);
const civMap = {
    m: 'M.', mr: 'M.', monsieur: 'M.', 'm.': 'M.', mme: 'Mme', 'mme.': 'Mme', madame: 'Mme', mlle: 'Mlle'
};
const verifiedTokens = new Set(['v', 'oui', 'yes', 'ok', 'fait', 'verifie', 'vérifié', 'valide', 'validé']);
const unverifiedTokens = new Set(['non', 'no', '?', '??', '???', 'x', 'xx', 'xxx', 'a verifier', 'à vérifier', 'inconnu']);
function text(value) {
    return value == null ? '' : String(value).trim();
}
function key(value) {
    return text(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[_/]+/g, ' ')
        .replace(/[^a-z0-9?]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}
function findKey(raw, aliases) {
    for (const alias of aliases)
        if (Object.prototype.hasOwnProperty.call(raw, alias))
            return alias;
    const wanted = new Set(aliases.map(key));
    return Object.keys(raw).find(k => wanted.has(key(k)));
}
function read(raw, aliases) {
    const k = findKey(raw, aliases);
    return k == null ? undefined : raw[k];
}
function hasHeader(raw, aliases) {
    return findKey(raw, aliases) != null;
}
function isoDate(value) {
    return value.toISOString().slice(0, 10);
}
function excelDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime()))
        return value;
    if (typeof value === 'number') {
        const parts = XLSX.SSF.parse_date_code(value);
        if (parts)
            return new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
    }
    const s = text(value);
    if (!s)
        return null;
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m)
        return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (m)
        return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    return null;
}
export function resolveLegacyWeek(value) {
    const s = text(value).toLowerCase().replace(/\s+/g, '');
    const m = s.match(/^s(?:emaine)?(\d{1,2})$/i);
    if (!m)
        return null;
    const week = Number(m[1]);
    if (week < 1 || week > 53)
        return null;
    return { week, year: 2026 };
}
function verificationFrom(value, importedAt) {
    const explicitDate = excelDate(value);
    if (explicitDate)
        return { verified: true, verifiedAt: explicitDate.toISOString(), raw: text(value) };
    const normalized = key(value);
    if (verifiedTokens.has(normalized))
        return { verified: true, verifiedAt: importedAt.toISOString(), raw: text(value) };
    if (!normalized || unverifiedTokens.has(normalized))
        return { verified: false, verifiedAt: null, raw: text(value) };
    return { verified: false, verifiedAt: null, raw: text(value), unknown: true };
}
function statusVerificationFrom(value, importedAt) {
    const raw = text(value);
    const normalized = key(value);
    if (!normalized)
        return { state: 'unverified', verifiedAt: null, activityStatus: '', emailStatus: 'unverified', emailVerifiedAt: null, raw };
    if (verifiedTokens.has(normalized)) {
        return {
            state: 'verified',
            verifiedAt: importedAt.toISOString(),
            activityStatus: 'active',
            emailStatus: 'verified',
            emailVerifiedAt: importedAt.toISOString(),
            raw
        };
    }
    if (normalized === 'inactif' || normalized === 'inactive') {
        return {
            state: 'inactive',
            verifiedAt: importedAt.toISOString(),
            activityStatus: 'inactive',
            emailStatus: 'invalid',
            emailVerifiedAt: null,
            raw
        };
    }
    if (normalized === 'inconnu' || normalized === 'inconnus' || normalized === 'unknown') {
        return {
            state: 'unknown',
            verifiedAt: importedAt.toISOString(),
            activityStatus: 'unknown',
            emailStatus: 'unknown',
            emailVerifiedAt: null,
            raw
        };
    }
    return { state: 'unverified', verifiedAt: null, activityStatus: '', emailStatus: 'unverified', emailVerifiedAt: null, raw, unknown: true };
}
function truthyLegacy(value) {
    const s = key(value);
    return Boolean(s) && !['non', 'no', '0', 'false', 'n a'].includes(s);
}
function explicitTrackingFromLegacy(raw) {
    const suivi = key(read(raw, ['Suivi']));
    const labels = [
        ['won', ['commande passee', 'gagne', 'gagnee', 'won']],
        ['quote_follow_up', ['devis relance', 'relance devis']],
        ['quote_sent', ['devis envoye']],
        ['appointment_obtained', ['rdv obtenu', 'rendez vous obtenu', 'rendez vous pris']],
        ['response_received', ['reponse recue', 'reponse']],
        ['follow_up_2', ['relance 2']],
        ['follow_up_1', ['relance 1']],
        ['contacted', ['contacte', 'contactee']]
    ];
    for (const [status, variants] of labels)
        if (variants.includes(suivi))
            return status;
    if (truthyLegacy(read(raw, ['Devis envoyé', 'Devis envoye'])))
        return 'quote_sent';
    if (truthyLegacy(read(raw, ['rdv obtenu', 'RDV obtenu', 'Rendez-vous obtenu'])))
        return 'appointment_obtained';
    if (truthyLegacy(read(raw, ['relance 2', 'Relance 2'])))
        return 'follow_up_2';
    if (truthyLegacy(read(raw, ['Relance 1', 'relance 1'])))
        return 'follow_up_1';
    return null;
}
function trackingFromLegacy(raw, plannedContactAt, verificationState, referenceDate) {
    const explicit = explicitTrackingFromLegacy(raw);
    if (explicit)
        return explicit;
    const today = isoDate(referenceDate);
    if (plannedContactAt) {
        if (plannedContactAt < today)
            return 'contacted';
        if (plannedContactAt > today)
            return 'to_contact';
        return verificationState === 'verified' ? 'contacted' : 'to_contact';
    }
    return verificationState === 'verified' ? 'contacted' : 'to_contact';
}
function normalizeCategory(value) {
    const s = text(value).replace(/^\d+\.\s*/, '').trim();
    if (!s || key(s) === 'non')
        return '';
    const k = key(s);
    if (k.includes('transport') && k.includes('logistique'))
        return 'Transport & logistique';
    if (k === 'logistique')
        return 'Logistique';
    return s;
}
function isReferentName(value) {
    const k = key(value);
    if (!k || verifiedTokens.has(k) || unverifiedTokens.has(k))
        return false;
    if (value.includes('@'))
        return false;
    if (/(retrait|deced|décéd|mort|rdv|rendez)/i.test(value))
        return false;
    const parts = value.split(/\s+/).filter(Boolean);
    return parts.length >= 1 && parts.length <= 4 && parts.every(p => /^[A-Za-zÀ-ÿ'’-]+$/.test(p));
}
function verificationAliases() {
    return [
        'Statut_verification', 'Statut vérification', 'Statut verification',
        'Vérification', 'Verification', 'Vérifié', 'Verifie', 'Vérifié ?', 'Verifie ?',
        'Vérification emploi', 'Verification emploi', 'Vérification contact'
    ];
}
function hasProspectHeaders(sheet) {
    const ref = sheet?.['!ref'];
    if (!ref)
        return false;
    const range = XLSX.utils.decode_range(ref);
    const headers = new Set();
    for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c })];
        const normalized = key(cell?.v);
        if (normalized)
            headers.add(normalized);
    }
    return headers.has('entreprise') && (headers.has('nom') || headers.has('prenom') || headers.has('mail') || headers.has('email'));
}
export function parseWorkbook(buffer, filename = 'import.xlsx', referenceDate = new Date()) {
    const importedAt = new Date(referenceDate);
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheets = wb.SheetNames.filter(n => key(n) !== 'actualite' && hasProspectHeaders(wb.Sheets[n]));
    const skippedSheets = wb.SheetNames.filter(n => !sheets.includes(n));
    const rows = [];
    for (const sheet of sheets) {
        const data = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { defval: '' });
        data.forEach((raw, i) => {
            const diagnostics = [];
            const company = text(read(raw, ['Entreprise']));
            const first = text(read(raw, ['Prénom', 'Prenom']));
            const last = text(read(raw, ['Nom']));
            const email = text(read(raw, ['Mail', 'Email'])).toLowerCase();
            const jobTitle = text(read(raw, ['Fonction']));
            const roleSlug = inferRoleSlug(jobTitle);
            const roleLabel = roleLabelForSlug(roleSlug);
            const civRaw = text(read(raw, ['Civilité ', 'Civilité', 'Civilite']));
            const civ = civMap[key(civRaw)] || civRaw;
            const referentRaw = text(read(raw, ['Référent', 'Referent']));
            const verificationHeader = findKey(raw, verificationAliases());
            const explicitVerification = verificationHeader != null;
            const statusVerificationColumn = verificationHeader != null && key(verificationHeader) === 'statut verification';
            const verificationRaw = verificationHeader == null ? undefined : raw[verificationHeader];
            const legacyVerificationMarker = !explicitVerification && key(referentRaw) === 'v';
            const statusVerification = statusVerificationColumn ? statusVerificationFrom(verificationRaw, importedAt) : null;
            const legacyVerification = explicitVerification && !statusVerificationColumn
                ? verificationFrom(verificationRaw, importedAt)
                : legacyVerificationMarker
                    ? { verified: true, verifiedAt: importedAt.toISOString(), raw: referentRaw }
                    : { verified: false, verifiedAt: null, raw: '' };
            let verificationState = statusVerification?.state || (legacyVerification.verified ? 'verified' : 'unverified');
            let employmentVerifiedAt = statusVerification?.verifiedAt || legacyVerification.verifiedAt;
            const legacyPlannedRaw = Object.prototype.hasOwnProperty.call(raw, 'A contacter ') ? text(raw['A contacter ']) : '';
            const plannedRaw = legacyPlannedRaw || text(read(raw, ['Contact planifié', 'Contact planifie', 'Date contact', 'Date de contact']));
            const plannedWeek = resolveLegacyWeek(plannedRaw);
            const legacyCampaignWeek = plannedWeek && [37, 39, 40].includes(plannedWeek.week) ? plannedWeek : null;
            const plannedDate = excelDate(plannedRaw);
            const plannedContactAt = plannedDate ? isoDate(plannedDate) : null;
            if (legacyCampaignWeek) {
                verificationState = 'verified';
                employmentVerifiedAt = employmentVerifiedAt || importedAt.toISOString();
            }
            const categoryRaw = text(read(raw, ['Catégorie', 'Categorie']));
            const category = normalizeCategory(categoryRaw);
            const emailVerificationAliases = ['Email vérifié', 'Email verifie', 'Vérification email', 'Verification email'];
            const explicitEmailVerification = hasHeader(raw, emailVerificationAliases);
            const emailVerificationRaw = read(raw, emailVerificationAliases);
            const emailVerification = explicitEmailVerification
                ? verificationFrom(emailVerificationRaw, importedAt)
                : { verified: false, verifiedAt: null, raw: '' };
            let emailVerificationStatus = explicitEmailVerification
                ? (emailVerification.verified ? 'verified' : 'unverified')
                : statusVerification?.emailStatus || 'unverified';
            let emailVerifiedAt = explicitEmailVerification
                ? emailVerification.verifiedAt
                : statusVerification?.emailVerifiedAt || null;
            if (legacyCampaignWeek) {
                emailVerificationStatus = 'verified';
                emailVerifiedAt = emailVerifiedAt || importedAt.toISOString();
            }
            const trackingStatus = legacyCampaignWeek?.week === 37 || legacyCampaignWeek?.week === 39
                ? 'contacted'
                : legacyCampaignWeek?.week === 40
                    ? 'to_contact'
                    : trackingFromLegacy(raw, plannedContactAt, verificationState, importedAt);
            const statusActivity = statusVerification?.activityStatus || '';
            const activityStatusSuggestion = statusActivity || (/retrait/i.test(plannedRaw) ? 'inactive' : '');
            if (!company)
                diagnostics.push({ code: 'missing_company', level: 'error', message: 'Entreprise manquante' });
            if (!first && !last)
                diagnostics.push({ code: 'missing_identity', level: 'warning', message: 'Identité inconnue : prospect conservé dans « Inconnus »' });
            if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
                diagnostics.push({ code: 'invalid_email', level: 'warning', message: 'Email à vérifier' });
            if (civRaw && civ === civRaw && !['M.', 'Mme', 'Mlle'].includes(civ))
                diagnostics.push({ code: 'unknown_civility', level: 'warning', message: `Civilité non reconnue: ${civRaw}` });
            if (categoryRaw && !category)
                diagnostics.push({ code: 'invalid_category', level: 'warning', message: `Catégorie à vérifier: ${categoryRaw}` });
            if (roleLabel)
                diagnostics.push({ code: 'role_suggested', level: 'info', message: `Rôle suggéré : ${roleLabel}` });
            if (statusVerification?.unknown || (!statusVerificationColumn && explicitVerification && legacyVerification.unknown))
                diagnostics.push({ code: 'unknown_verification', level: 'warning', message: `Valeur de vérification non reconnue: ${text(verificationRaw)}` });
            if (plannedWeek)
                diagnostics.push({ code: 'planned_week_resolved', level: 'info', message: `Semaine ${plannedWeek.week} conservée comme semaine d’envoi ${plannedWeek.year}` });
            else if (/^s\d{1,2}$/i.test(plannedRaw))
                diagnostics.push({ code: 'invalid_week', level: 'warning', message: `Semaine invalide: ${plannedRaw}` });
            if (/retrait/i.test(plannedRaw))
                diagnostics.push({ code: 'legacy_anomaly', level: 'warning', message: 'Valeur retraité détectée : activité suggérée inactive' });
            if (referentRaw && !isReferentName(referentRaw) && !legacyVerificationMarker && !unverifiedTokens.has(key(referentRaw)))
                diagnostics.push({ code: 'ambiguous_referent', level: 'warning', message: 'Référent historique ambigu : conservé en métadonnées' });
            const unknown = Object.keys(raw).filter(k => {
                if (!text(raw[k]))
                    return false;
                const normalized = key(k);
                return normalized && !knownHeaderKeys.has(normalized);
            });
            if (unknown.length)
                diagnostics.push({ code: 'unknown_columns', level: 'info', message: `Métadonnées conservées: ${unknown.join(', ')}` });
            rows.push({
                row: i + 2,
                raw,
                normalized: {
                    sheet,
                    company,
                    first_name: first,
                    last_name: last,
                    identity_unknown: !first && !last,
                    civility: civ,
                    job_title: jobTitle,
                    role_slug: roleSlug,
                    role_label: roleLabel,
                    email,
                    email_verification_status: emailVerificationStatus,
                    email_verified_at: emailVerifiedAt,
                    phone: text(read(raw, ['Téléphone', 'Telephone'])),
                    mobile: text(read(raw, ['Mobile'])),
                    address: text(read(raw, ['Adresse ', 'Adresse'])),
                    category,
                    category_raw: categoryRaw,
                    referent: isReferentName(referentRaw) ? referentRaw : '',
                    referent_raw: referentRaw,
                    verification_state: verificationState,
                    employment_verified_at: employmentVerifiedAt,
                    verification_source: statusVerificationColumn ? 'excel_status_column' : explicitVerification ? 'excel_column' : legacyVerificationMarker ? 'legacy_marker' : 'none',
                    planned_contact_raw: plannedRaw,
                    planned_contact_at: plannedContactAt,
                    contact_year: plannedWeek?.year || null,
                    contact_week: plannedWeek?.week || null,
                    tracking_status: trackingStatus,
                    activity_status_suggestion: activityStatusSuggestion,
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
