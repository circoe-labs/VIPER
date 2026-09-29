export type DraftRecord<T = unknown> = {
  key: string;
  updatedAt: string;
  value: T;
};

export async function saveDraft<T>(key: string, value: T): Promise<DraftRecord<T>> {
  const response = await fetch('/api/drafts/' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Sauvegarde du brouillon impossible');
  return body as DraftRecord<T>;
}

export async function loadDraft<T>(key: string): Promise<DraftRecord<T> | null> {
  const response = await fetch('/api/drafts/' + encodeURIComponent(key), { cache: 'no-store' });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Lecture du brouillon impossible');
  return body as DraftRecord<T>;
}

export async function deleteDraft(key: string) {
  const response = await fetch('/api/drafts/' + encodeURIComponent(key), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Suppression du brouillon impossible');
  }
}

export async function hasDraft(key: string) {
  return Boolean(await loadDraft(key));
}
