const DB_NAME = 'viper-local-state';
const DB_VERSION = 1;
const STORE = 'snapshots';
const LATEST_KEY = 'latest';

type CachedState = {
  key: string;
  savedAt: string;
  bytes: ArrayBuffer;
};

function openCacheDb(): Promise<IDBDatabase> {
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

async function putState(payload: CachedState) {
  const db = await openCacheDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Sauvegarde locale impossible'));
    tx.onabort = () => reject(tx.error || new Error('Sauvegarde locale interrompue'));
  });
  db.close();
}

async function getState(): Promise<CachedState | null> {
  const db = await openCacheDb();
  const payload = await new Promise<CachedState | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(LATEST_KEY);
    request.onsuccess = () => resolve(request.result as CachedState | undefined);
    request.onerror = () => reject(request.error || new Error('Lecture locale impossible'));
  });
  db.close();
  return payload || null;
}

export async function requestPersistentBrowserStorage() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    // Le navigateur peut refuser la persistance explicite ; IndexedDB reste utilisable.
  }
}

export async function saveCurrentViperState() {
  const response = await fetch('/api/state/backup', { cache: 'no-store' });
  if (!response.ok) throw new Error('Sauvegarde VIPER impossible');
  await putState({
    key: LATEST_KEY,
    savedAt: new Date().toISOString(),
    bytes: await response.arrayBuffer()
  });
}

let backupTimer: number | null = null;
export function scheduleStateBackup() {
  if (backupTimer != null) window.clearTimeout(backupTimer);
  backupTimer = window.setTimeout(() => {
    backupTimer = null;
    saveCurrentViperState().catch(() => undefined);
  }, 250);
}

export async function restoreLatestViperState() {
  const cached = await getState();
  if (!cached?.bytes?.byteLength) return false;
  const form = new FormData();
  form.append('backup', new Blob([cached.bytes], { type: 'application/vnd.sqlite3' }), 'viper-state.sqlite');
  const response = await fetch('/api/state/restore', { method: 'POST', body: form });
  if (response.status === 409) return false;
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Restauration VIPER impossible');
  }
  return true;
}

export async function hasServerBusinessState() {
  const response = await fetch('/api/dashboard', { cache: 'no-store' });
  if (!response.ok) return true;
  const body = await response.json();
  return Number(body.total || 0) > 0;
}
