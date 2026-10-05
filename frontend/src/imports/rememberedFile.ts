// The last Excel file chosen on the import page, kept in this browser (IndexedDB) so it is not asked for again.
// It never leaves the workstation: it is only read back and sent for analysis like a freshly chosen file.

const DATABASE = 'viper-imports'
const STORE = 'files'
const KEY = 'last'

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      resolve(null)
    }
  })
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const database = await open()
  if (!database) return null
  return new Promise((resolve) => {
    try {
      const request = action(database.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        resolve(null)
      }
    } catch {
      resolve(null)
    }
  })
}

export async function rememberFile(file: File): Promise<void> {
  await run('readwrite', (store) => store.put(file, KEY))
}

export async function recallFile(): Promise<File | null> {
  const stored = await run<unknown>('readonly', (store) => store.get(KEY))
  return stored instanceof File ? stored : null
}

export async function forgetFile(): Promise<void> {
  await run('readwrite', (store) => store.delete(KEY))
}
