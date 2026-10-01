import { z } from 'zod';
import { getContactMessage, listContactMessages } from './contactMessageStore.js';
import { ContactMessageError, createContactMessageService } from './contactMessageService.js';
import { buildMailPrompt, MAIL_PROMPT_VERSION, MAX_USER_INSTRUCTIONS_LENGTH } from './mailGenerationPrompt.js';
import { AiGenerationError, notConfiguredError } from './openaiMailGenerator.js';
import { contactMessageStatusLabels, contactMessageSteps, isContactSequenceClosed } from '../shared/contactWorkflow.js';
/** Corps de `POST /api/prospects/:id/messages/:step/generate`. */
export const generateRequestSchema = z.object({
    expected_revision: z.number().int().min(1).nullable().optional(),
    instructions: z.string().max(MAX_USER_INSTRUCTIONS_LENGTH).optional()
}).strict();
export function parseGenerateRequest(body) {
    const parsed = generateRequestSchema.safeParse(body ?? {});
    if (parsed.success)
        return parsed.data;
    if (parsed.error.issues[0]?.path[0] === 'expected_revision')
        throw new ContactMessageError('revision_required', 'Révision attendue invalide');
    throw new ContactMessageError('invalid_payload', `Demande de génération invalide (consigne limitée à ${MAX_USER_INSTRUCTIONS_LENGTH} caractères)`);
}
/** Lien de prise de rendez-vous : URL http(s) valide seulement, sinon ignoré. */
export function normalizeBookingUrl(value) {
    const raw = value?.trim();
    if (!raw)
        return null;
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    }
    catch {
        return null;
    }
}
/** Données minimales du prompt (aucune coordonnée) ; messages précédents enregistrés hors annulés. */
export function loadMailGenerationContext(db, prospectId, step, extra) {
    const row = db.prepare(`SELECT p.civility,p.first_name,p.last_name,p.exact_job_title,r.label role,c.id company_id,c.display_name,c.website_url,c.size_label,
      s.label segment,c.project_done_with_circoe,c.project_type,c.circoe_references,c.client_approach
    FROM prospects p JOIN companies c ON c.id=p.company_id LEFT JOIN roles r ON r.id=p.role_id LEFT JOIN commercial_segments s ON s.id=c.commercial_segment_id WHERE p.id=?`)
        .get(prospectId);
    if (!row)
        throw new ContactMessageError('prospect_not_found', 'Prospect introuvable');
    const categories = db.prepare('SELECT a.label FROM company_activity_categories ca JOIN activity_categories a ON a.id=ca.category_id WHERE ca.company_id=? ORDER BY a.label')
        .all(row.company_id).map(c => c.label);
    const messages = listContactMessages(db, prospectId);
    const index = contactMessageSteps.indexOf(step);
    const previousMessages = contactMessageSteps.slice(0, index)
        .map(s => messages.find(m => m.step === s))
        .filter((m) => !!m && m.status !== 'cancelled' && !!(m.subject.trim() || m.body_text.trim()))
        .map(m => ({ step: m.step, statusLabel: contactMessageStatusLabels[m.status], subject: m.subject, body: m.body_text }));
    const current = messages.find(m => m.step === step);
    return {
        step,
        prospect: { civility: row.civility, firstName: row.first_name, lastName: row.last_name, jobTitle: row.exact_job_title, role: row.role },
        company: {
            name: row.display_name, website: row.website_url, sizeLabel: row.size_label, segment: row.segment, activityCategories: categories,
            projectDoneWithCircoe: row.project_done_with_circoe, projectType: row.project_type, circoeReferences: row.circoe_references, clientApproach: row.client_approach
        },
        previousMessages,
        currentVersion: current ? { subject: current.subject, body: current.body_text } : null,
        userInstructions: extra.userInstructions,
        bookingUrl: extra.bookingUrl
    };
}
export function createContactMailGenerationService(db, deps) {
    const messages = createContactMessageService(db, deps);
    const bookingUrl = normalizeBookingUrl(deps.bookingUrl);
    /** Refus identiques à la machine d'état, levés avant tout appel IA. */
    function precheck(prospectId, step, request) {
        const row = db.prepare('SELECT p.contactability_status,ct.status FROM prospects p LEFT JOIN contact_tracking ct ON ct.prospect_id=p.id WHERE p.id=?')
            .get(prospectId);
        if (!row)
            throw new ContactMessageError('prospect_not_found', 'Prospect introuvable');
        const doNotContact = row.contactability_status === 'do_not_contact';
        if (doNotContact)
            throw new ContactMessageError('prospect_do_not_contact', 'Prospect à ne plus contacter : aucun message possible');
        if (isContactSequenceClosed(row.status, doNotContact))
            throw new ContactMessageError('prospect_sequence_closed', 'Séquence fermée par l’état du prospect : aucun message possible');
        const existing = getContactMessage(db, prospectId, step);
        const expected = request.expected_revision ?? null;
        if (!existing) {
            if (expected !== null)
                throw new ContactMessageError('message_not_found', 'Message introuvable');
            return;
        }
        if (existing.status === 'sent')
            throw new ContactMessageError('message_sent_immutable', 'Un message envoyé ne peut plus être modifié');
        if (existing.status === 'cancelled')
            throw new ContactMessageError('message_cancelled', 'Message annulé : le rouvrir avant de le régénérer');
        if (existing.dispatch_claim_id)
            throw new ContactMessageError('dispatch_in_progress', 'Envoi en cours : message verrouillé');
        if (expected === null)
            throw new ContactMessageError('message_exists', 'Le message de cette étape existe déjà : recharger avant de continuer');
        if (expected !== existing.revision)
            throw new ContactMessageError('revision_conflict', 'Le message a été modifié entre-temps : recharger avant de continuer');
        if (existing.status === 'scheduled')
            throw new ContactMessageError('invalid_transition', 'Message programmé : le déprogrammer avant de le régénérer');
    }
    return {
        generate: async (prospectId, step, request, actor) => {
            precheck(prospectId, step, request);
            if (!deps.generator)
                throw notConfiguredError(deps.missingSettings ?? []);
            const context = loadMailGenerationContext(db, prospectId, step, { userInstructions: request.instructions?.trim() || null, bookingUrl });
            let mail;
            try {
                mail = await deps.generator.generate(buildMailPrompt(context));
            }
            catch (e) {
                const error = e instanceof AiGenerationError ? e : new AiGenerationError('ai_upstream_error', 'Génération IA impossible : rien n’a été enregistré.');
                // Diagnostic sans PII : étape, code, statut/type amont seulement (ni prompt, ni réponse, ni clé).
                console.warn(`[ai] génération ${step} échouée : ${error.code}${error.upstreamStatus ? ` HTTP ${error.upstreamStatus}` : ''}${error.upstreamCode ? ` (${error.upstreamCode})` : ''}`);
                throw error;
            }
            const result = messages.saveGeneratedContent(prospectId, step, {
                subject: mail.subject, body_text: mail.body, model: mail.model, prompt_version: MAIL_PROMPT_VERSION, expected_revision: request.expected_revision ?? null
            }, actor, { replaceScheduled: false });
            return { ...result, generation: { model: mail.model, prompt_version: MAIL_PROMPT_VERSION } };
        }
    };
}
