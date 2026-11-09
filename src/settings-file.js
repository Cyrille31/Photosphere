// Fichier de réglages « photosphere.json » : tout ce qu'il faut pour retrouver une visite à partir des
// photos d'origine (non modifiées) — nom, type, redressement, calibrage, liens. Les photos y sont
// désignées par leur nom de fichier, les liens aussi : le fichier se range avec les originaux.
import * as db from './db.js';
import { newId } from './importer.js';

export const SETTINGS_FILE_NAME = 'photosphere.json';
const FORMAT = 'photosphere-reglages';

export function isSettingsFile(file) {
  return /\.json$/i.test(file.name);
}

export function buildSettings(photos) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  return {
    format: FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    photos: photos.map((p) => ({
      file: p.fileName,
      size: p.fileSize,
      name: p.name,
      srcType: p.srcType,
      params: p.params,
      ...(p.mapPos ? { mapPos: p.mapPos } : {}),
      hotspots: (p.hotspots || [])
        .filter((h) => byId.has(h.target))
        .map((h) => ({ target: byId.get(h.target).fileName, yaw: h.yaw, pitch: h.pitch, label: h.label || '', ...(h.arrive ? { arrive: h.arrive } : {}), ...(h.auto ? { auto: true } : {}) })),
    })),
  };
}

export function settingsBlob(photos) {
  return new Blob([JSON.stringify(buildSettings(photos), null, 1)], { type: 'application/json' });
}

// Applique un fichier de réglages aux photos de la bibliothèque, reconnues par leur nom de fichier.
// Renvoie { applied, unmatched: [noms de fichiers absents de la bibliothèque] }.
export async function applySettings(data) {
  if (!data || data.format !== FORMAT || !Array.isArray(data.photos)) {
    throw new Error('Ce fichier n’est pas un fichier de réglages PhotoSphère.');
  }
  const photos = await db.listPhotos();
  const key = (name) => String(name || '').toLowerCase();
  const find = (entry) => {
    const same = photos.filter((p) => key(p.fileName) === key(entry.file));
    return same.find((p) => p.fileSize === entry.size) || same[0] || null;
  };
  const idOf = new Map();
  data.photos.forEach((e) => {
    const p = find(e);
    if (p) idOf.set(key(e.file), p.id);
  });
  let applied = 0;
  const unmatched = [];
  for (const e of data.photos) {
    const cur = find(e);
    if (!cur) {
      unmatched.push(e.file);
      continue;
    }
    const hotspots = (e.hotspots || [])
      .filter((h) => idOf.has(key(h.target)))
      .map((h) => ({ id: newId(), target: idOf.get(key(h.target)), yaw: h.yaw, pitch: h.pitch, label: h.label || '', ...(h.arrive ? { arrive: h.arrive } : {}), ...(h.auto ? { auto: true } : {}) }));
    const srcType = e.srcType || cur.srcType;
    const params = { ...cur.params, ...(e.params || {}) };
    const imageChanged = srcType !== cur.srcType || JSON.stringify(params) !== JSON.stringify(cur.params);
    await db.putPhoto({
      ...cur,
      name: e.name || cur.name,
      ...(e.mapPos ? { mapPos: e.mapPos } : {}),
      srcType,
      params,
      hotspots,
      layout: 2,
      status: imageChanged || cur.status !== 'done' ? 'pending' : 'done',
    });
    applied++;
  }
  return { applied, unmatched };
}

export async function readSettingsFile(file) {
  try {
    return JSON.parse(await file.text());
  } catch (e) {
    throw new Error('Fichier de réglages illisible : ' + e.message);
  }
}
