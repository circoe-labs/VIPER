const DB_NAME = 'viper-local-cache';
const DB_VERSION = 1;
const STORE = 'workbooks';
const LAST_IMPORT_KEY = 'last-import';

type CachedWorkbook = {
  key: string;
  name: string;
  type: string;
  lastModified: number;
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

export async function saveLastImportedWorkbook(file: File) {
  const db = await openCacheDb();
  const payload: CachedWorkbook = {
    key: LAST_IMPORT_KEY,
    name: file.name,
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now(),
    savedAt: new Date().toISOString(),
    bytes: await file.arrayBuffer()
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Sauvegarde locale impossible'));
    tx.onabort = () => reject(tx.error || new Error('Sauvegarde locale interrompue'));
  });
  db.close();
}

export async function loadLastImportedWorkbook(): Promise<File | null> {
  const db = await openCacheDb();
  const payload = await new Promise<CachedWorkbook | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(LAST_IMPORT_KEY);
    request.onsuccess = () => resolve(request.result as CachedWorkbook | undefined);
    request.onerror = () => reject(request.error || new Error('Lecture locale impossible'));
  });
  db.close();
  if (!payload?.bytes) return null;
  return new File([payload.bytes], payload.name, { type: payload.type, lastModified: payload.lastModified });
}

export async function previewWorkbook(file: File) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const response = await fetch('/api/import/preview', { method: 'POST', body: fd });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Import impossible');
  return body;
}

export async function commitWorkbookPreview(preview: any) {
  const response = await fetch('/api/import/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preview)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Import impossible');
  return body;
}

export async function restoreLastImportedWorkbook() {
  const file = await loadLastImportedWorkbook();
  if (!file) return false;
  const preview = await previewWorkbook(file);
  await commitWorkbookPreview(preview);
  return true;
}
