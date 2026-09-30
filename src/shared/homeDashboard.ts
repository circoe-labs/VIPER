// Accueil (retour « PARTIE PROSPECTION », fusion avec main) : définitions partagées client/serveur, sur le modèle Contact.
// Aucun ancien statut (relances 3 à 5, « Défaillant » automatique, devis) : seuls les états de `contactWorkflow.ts` sont lus.
import type { ProspectState } from './contactWorkflow.js';

/**
 * Activité de contact (3 cases ; « Devis envoyé » n'existe pas dans le modèle Contact et n'est pas inventé) :
 * - `inSequence` : « À contacter » = séquence en cours, hors blocage durable : `contacted`, `r1`, `r2`, ou `neutral` avec une
 *   prochaine semaine planifiée (premier contact prévu) ;
 * - `withoutResponse` : « Sans réponse » = déjà contacté (`contacted`, `r1`, `r2`), aucune réponse enregistrée ;
 * - `appointments` : « RDV » = état courant `appointment_obtained` (même définition que « RDV pris » du dashboard Contact).
 */
export type HomeActivity = { inSequence: number; withoutResponse: number; appointments: number };

/** Réponses (passage humain à « Réponse reçue » ou « RDV pris ») sur les 7 derniers jours vs les 7 jours précédents. */
export type ResponseTrend = { current: number; previous: number };

/** Catégories du camembert du mois : état courant posé par un humain depuis le 1er du mois (UTC). */
export const monthOutcomeKeys = ['sequence', 'response_received', 'appointment_obtained', 'failure', 'ignored'] as const;
export type MonthOutcomeKey = typeof monthOutcomeKeys[number];
export const monthOutcomeStates: Readonly<Record<MonthOutcomeKey, readonly ProspectState[]>> = {
  sequence: ['contacted', 'r1', 'r2'], response_received: ['response_received'], appointment_obtained: ['appointment_obtained'],
  failure: ['failure'], ignored: ['ignored']
};
export type MonthOutcomes = Record<MonthOutcomeKey, number>;

/** Ligne du journal des 24 dernières heures. */
export type HomeAuditEntry = { id: string; entity_type: string; entity_id: string; action: string; actor_display: string | null; created_at: string };

/**
 * Réponse de `GET /api/dashboard`. BASE : `total`, `appointments` (RDV confirmé = RDV pris), `failures` (état humain
 * `failure`, « Défaillants »), `incompleteContact` (email ou téléphone principal manquant), `responseTrend`.
 */
export type HomeDashboard = {
  total: number; appointments: number; failures: number; incompleteContact: number; responseTrend: ResponseTrend;
  activity: HomeActivity; month: MonthOutcomes; recent: HomeAuditEntry[];
};
