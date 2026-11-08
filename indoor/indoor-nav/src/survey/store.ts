/** IndexedDB persistence of survey sessions (one record per session_id). Never throws. */
import type { Session } from './session'

const DB = 'tpnav-survey'
const STORE = 'sessions'

let dbp: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'session_id' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbp
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction(STORE, mode)
          const req = fn(t.objectStore(STORE))
          t.oncomplete = () => resolve(req.result ?? null)
          t.onerror = () => resolve(null)
          t.onabort = () => resolve(null)
        } catch (err) {
          console.warn('[survey] idb', err)
          resolve(null)
        }
      }),
  )
}

/** Returns false if the write failed (the caller warns the surveyor). */
export async function saveSession(s: Session): Promise<boolean> {
  const r = await tx('readwrite', (st) => st.put(s))
  return r !== null
}

/** Most recently started session, or null. */
export async function loadLatestSession(): Promise<Session | null> {
  const all = await tx<Session[]>('readonly', (st) => st.getAll())
  if (!all?.length) return null
  return all.reduce((a, b) => (b.started_at > a.started_at ? b : a))
}

export async function listSessionIds(): Promise<string[]> {
  return ((await tx<IDBValidKey[]>('readonly', (st) => st.getAllKeys())) ?? []).map(String)
}
