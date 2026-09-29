// Adapter OpenAI de rédaction (Task 14, décisions 22/26, docs/07 § OpenAI) : appel serveur uniquement, via `fetch` natif sur
// l'API Responses (`POST {OPENAI_BASE_URL}/responses`, sortie structurée `text.format` = `json_schema` strict `{ subject, body }`).
// Documentation vérifiée le 2026-09-29 : developers.openai.com/api/docs/guides/structured-outputs et /guides/text.
//
// - configuration par variables d'environnement, relue à chaque requête : `OPENAI_API_KEY` et `OPENAI_MODEL` obligatoires (aucun
//   modèle codé en dur, docs/08 §4) ; `OPENAI_BASE_URL` (défaut API officielle), `OPENAI_TIMEOUT_MS`, `OPENAI_MAX_RETRIES` optionnels ;
// - timeout par tentative (AbortController) ; retries bornés sur erreurs transitoires seulement (réseau, 408/409/429 hors quota,
//   5xx), backoff exponentiel avec `Retry-After` plafonné ; un timeout n'est pas rejoué (l'attente utilisateur reste bornée) ;
// - erreurs typées `AiGenerationError` (code stable + statut HTTP) ; jamais la clé, le prompt ni la réponse brute dans un
//   message d'erreur ou un log (seulement code, statut amont, type d'erreur amont) ;
// - `store: false` : la requête n'est pas conservée côté OpenAI pour une réutilisation ultérieure ;
// - la sortie est validée (JSON, schéma, bornes) avant tout retour : l'appelant ne persiste qu'une sortie valide.
import { z } from 'zod';

export const aiGenerationErrorStatus = {
  ai_not_configured: 503,
  ai_timeout: 504,
  ai_rate_limited: 429,
  ai_auth_failed: 502,
  ai_upstream_error: 502,
  ai_refused: 422,
  ai_invalid_output: 502
} as const;
export type AiGenerationErrorCode = keyof typeof aiGenerationErrorStatus;
export class AiGenerationError extends Error {
  readonly code: AiGenerationErrorCode;
  readonly httpStatus: number;
  /** Diagnostic non sensible : statut HTTP amont et type/code d'erreur OpenAI éventuels. */
  readonly upstreamStatus?: number;
  readonly upstreamCode?: string;
  constructor(code: AiGenerationErrorCode, message: string, upstream: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'AiGenerationError';
    this.code = code;
    this.httpStatus = aiGenerationErrorStatus[code];
    if (upstream.status !== undefined) this.upstreamStatus = upstream.status;
    if (upstream.code) this.upstreamCode = upstream.code;
  }
}

// --- Port injectable (tests : faux générateur) ---
export type MailPrompt = { instructions: string; input: string };
export type GeneratedMail = { subject: string; body: string; model: string };
export type MailGeneratorPort = { generate(prompt: MailPrompt): Promise<GeneratedMail> };

// --- Configuration ---
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export type OpenAiConfig = { apiKey: string; model: string; baseUrl: string; timeoutMs: number; maxRetries: number };
const intIn = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(raw);
  return raw?.trim() && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
/** Configuration lue depuis l'environnement ; `null` si la clé ou le modèle manquent (=> `ai_not_configured`). */
export function openAiConfigFromEnv(env: Record<string, string | undefined> = process.env): OpenAiConfig | null {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  if (!apiKey || !model) return null;
  return {
    apiKey, model,
    baseUrl: (env.OPENAI_BASE_URL?.trim() || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: intIn(env.OPENAI_TIMEOUT_MS, 60_000, 1_000, 300_000),
    maxRetries: intIn(env.OPENAI_MAX_RETRIES, 2, 0, 5)
  };
}
/** Explication de configuration sans valeur (jamais la clé). */
export function missingOpenAiSettings(env: Record<string, string | undefined> = process.env): string[] {
  return (['OPENAI_API_KEY', 'OPENAI_MODEL'] as const).filter(name => !env[name]?.trim());
}
export const notConfiguredError = (missing: string[]) =>
  new AiGenerationError('ai_not_configured', `Génération IA non configurée côté serveur (variable manquante : ${missing.join(', ') || 'OPENAI_API_KEY, OPENAI_MODEL'}).`);

// --- Sortie structurée ---
export const MAIL_OUTPUT_SCHEMA_NAME = 'contact_mail';
/** JSON Schema envoyé à OpenAI (mode strict : tous les champs requis, aucune propriété additionnelle). */
export const mailOutputJsonSchema = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'Objet du mail, une seule ligne, sans préfixe « Objet : ».' },
    body: { type: 'string', description: 'Corps du mail en texte brut, paragraphes séparés par une ligne vide, sans signature nominative.' }
  },
  required: ['subject', 'body'],
  additionalProperties: false
} as const;
/** Validation serveur de la sortie, indépendante du mode strict amont. */
export const generatedMailSchema = z.object({
  subject: z.string().trim().min(1).max(200).refine(v => !/[\r\n]/.test(v), 'objet sur une seule ligne'),
  body: z.string().trim().min(1).max(10_000)
}).strict();
export function parseGeneratedMail(text: string): { subject: string; body: string } {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new AiGenerationError('ai_invalid_output', 'Réponse IA illisible (JSON invalide) : rien n’a été enregistré.'); }
  const parsed = generatedMailSchema.safeParse(json);
  if (!parsed.success) throw new AiGenerationError('ai_invalid_output', 'Réponse IA incomplète ou hors format (objet/corps) : rien n’a été enregistré.');
  return parsed.data;
}

type ResponseContent = { type?: string; text?: unknown; refusal?: unknown };
type ResponsesPayload = {
  status?: string; model?: unknown; error?: { code?: string } | null; incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: ResponseContent[] }[];
};
/** Extrait le texte de sortie d'une réponse `/responses` (refus et réponse incomplète typés). */
export function extractOutputText(payload: ResponsesPayload): string {
  const contents = (payload.output ?? []).filter(item => item?.type === 'message').flatMap(item => item.content ?? []);
  if (contents.some(c => c?.type === 'refusal')) throw new AiGenerationError('ai_refused', 'L’IA a refusé de rédiger ce message : rien n’a été enregistré.');
  if (payload.status && payload.status !== 'completed') {
    throw new AiGenerationError('ai_invalid_output', 'Réponse IA incomplète : rien n’a été enregistré.', { code: payload.incomplete_details?.reason ?? payload.status });
  }
  const text = contents.filter(c => c?.type === 'output_text' && typeof c.text === 'string').map(c => c.text as string).join('');
  if (!text.trim()) throw new AiGenerationError('ai_invalid_output', 'Réponse IA vide : rien n’a été enregistré.');
  return text;
}

// --- Implémentation réelle ---
export type OpenAiDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 10_000;
const timeoutError = (config: OpenAiConfig) =>
  new AiGenerationError('ai_timeout', `L’IA n’a pas répondu dans le délai (${Math.round(config.timeoutMs / 1000)} s) : rien n’a été enregistré.`);
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_DELAY_MS, seconds * 1000);
  return Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** attempt);
}
async function upstreamErrorCode(res: Response): Promise<string | undefined> {
  const body = await res.json().catch(() => null) as { error?: { code?: unknown; type?: unknown } } | null;
  const code = body?.error?.code ?? body?.error?.type;
  return typeof code === 'string' ? code.slice(0, 80) : undefined;
}

export function createOpenAiMailGenerator(config: OpenAiConfig, deps: OpenAiDeps = {}): MailGeneratorPort {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  return {
    async generate(prompt: MailPrompt): Promise<GeneratedMail> {
      const body = JSON.stringify({
        model: config.model,
        instructions: prompt.instructions,
        input: prompt.input,
        store: false,
        text: { format: { type: 'json_schema', name: MAIL_OUTPUT_SCHEMA_NAME, schema: mailOutputJsonSchema, strict: true } }
      });
      for (let attempt = 0; ; attempt++) {
        const canRetry = attempt < config.maxRetries;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        let res: Response;
        try {
          res = await doFetch(`${config.baseUrl}/responses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
            body, signal: controller.signal
          });
        } catch (e) {
          clearTimeout(timer);
          if (controller.signal.aborted) throw timeoutError(config);
          if (canRetry) { await sleep(retryDelay(attempt, null)); continue; }
          throw new AiGenerationError('ai_upstream_error', 'Service IA injoignable : rien n’a été enregistré.', { code: e instanceof Error ? e.name : undefined });
        }
        try {
          if (!res.ok) {
            const code = await upstreamErrorCode(res);
            const quota = code === 'insufficient_quota';
            if (canRetry && RETRYABLE_STATUSES.has(res.status) && !quota) { await sleep(retryDelay(attempt, res.headers.get('retry-after'))); continue; }
            if (res.status === 401 || res.status === 403) throw new AiGenerationError('ai_auth_failed', 'Clé API OpenAI refusée : vérifier la configuration serveur.', { status: res.status, code });
            if (res.status === 429) throw new AiGenerationError('ai_rate_limited', quota ? 'Quota OpenAI épuisé : génération impossible pour le moment.' : 'Limite de requêtes OpenAI atteinte : réessayer dans un moment.', { status: res.status, code });
            throw new AiGenerationError('ai_upstream_error', `Erreur du service IA (HTTP ${res.status}) : rien n’a été enregistré.`, { status: res.status, code });
          }
          let payload: ResponsesPayload;
          try { payload = await res.json() as ResponsesPayload; } catch {
            if (controller.signal.aborted) throw timeoutError(config);
            throw new AiGenerationError('ai_invalid_output', 'Réponse du service IA illisible : rien n’a été enregistré.');
          }
          const mail = parseGeneratedMail(extractOutputText(payload));
          return { ...mail, model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim().slice(0, 200) : config.model };
        } finally {
          clearTimeout(timer);
        }
      }
    }
  };
}
