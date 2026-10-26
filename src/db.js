// Stockage local (IndexedDB) : fiches photo, fichiers (original, converti, vignette), réglages.

const DB_NAME = 'photosphere';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('photos', { keyPath: 'id' });
        db.createObjectStore('blobs');
        db.createObjectStore('settings');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result;
    const r = fn(t.objectStore(store));
    if (r) r.onsuccess = () => (result = r.result);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction annulée (espace de stockage plein ?)'));
  });
}

export const listPhotos = () => tx('photos', 'readonly', (s) => s.getAll());
export const getPhoto = (id) => tx('photos', 'readonly', (s) => s.get(id));
export const putPhoto = (p) => tx('photos', 'readwrite', (s) => s.put(p));
export const getBlob = (key) => tx('blobs', 'readonly', (s) => s.get(key));
export const putBlob = (key, blob) => tx('blobs', 'readwrite', (s) => s.put(blob, key));
export const getSetting = (key) => tx('settings', 'readonly', (s) => s.get(key));
export const putSetting = (key, v) => tx('settings', 'readwrite', (s) => s.put(v, key));

export async function deletePhoto(id) {
  await tx('photos', 'readwrite', (s) => s.delete(id));
  for (const k of ['orig', 'out', 'thumb']) await tx('blobs', 'readwrite', (s) => s.delete(`${id}:${k}`));
  // Supprime les liens qui pointaient vers cette photo.
  for (const p of await listPhotos()) {
    const kept = (p.hotspots || []).filter((h) => h.target !== id);
    if (kept.length !== (p.hotspots || []).length) await putPhoto({ ...p, hotspots: kept });
  }
}

export async function storageEstimate() {
  if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate();
  return null;
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) {
    // non supporté
  }
  return false;
}
