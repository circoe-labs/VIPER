const DB_NAME = 'viper-local-drafts';
const DB_VERSION = 1;
const STORE = 'drafts';

type DraftRecord<T = unknown> = {
  key: string;
  updatedAt: string;
  value: T;
};

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB indisponible'));
  });
}

export async function saveDraft<T>(key: string, value: T) {
  const db = await openDraftDb();
  const payload: DraftRecord<T> = { key, updatedAt: new Date().toISOString(), value };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Sauvegarde du brouillon impossible'));
    tx.onabort = () => reject(tx.error || new Error('Sauvegarde du brouillon interrompue'));
  });
  db.close();
}

export async function loadDraft<T>(key: string): Promise<DraftRecord<T> | null> {
  const db = await openDraftDb();
  const payload = await new Promise<DraftRecord<T> | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as DraftRecord<T> | undefined);
    request.onerror = () => reject(request.error || new Error('Lecture du brouillon impossible'));
  });
  db.close();
  return payload || null;
}

export async function deleteDraft(key: string) {
  const db = await openDraftDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Suppression du brouillon impossible'));
  });
  db.close();
}

export async function hasDraft(key: string) {
  return Boolean(await loadDraft(key));
}
