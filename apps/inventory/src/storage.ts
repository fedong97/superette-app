/**
 * Mémoire du téléphone : IndexedDB (catalogue de plusieurs milliers
 * d'articles, comptages pas encore envoyés). Tout reste sur le téléphone
 * tant que le serveur ne l'a pas reçu, même si l'application est fermée.
 */
const DB_NAME = 'fedonix-inventaire';
const STORE = 'kv';

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (!opening) {
    opening = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return opening;
}

export async function load<T>(key: string, fallback: T): Promise<T> {
  const db = await open();
  if (!db) {
    try {
      const raw = localStorage.getItem(`${DB_NAME}.${key}`);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result === undefined ? fallback : (req.result as T));
    req.onerror = () => resolve(fallback);
  });
}

export async function save(key: string, value: unknown): Promise<void> {
  const db = await open();
  if (!db) {
    try {
      localStorage.setItem(`${DB_NAME}.${key}`, JSON.stringify(value));
    } catch {
      /* mémoire pleine : la valeur reste en mémoire vive */
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function clearAll(): Promise<void> {
  const db = await open();
  if (!db) {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(`${DB_NAME}.`))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* rien */
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
