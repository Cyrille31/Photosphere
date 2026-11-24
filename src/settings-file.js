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

const withoutStart = ({ start, startYaw, ...rest }) => rest;

export function buildSettings(photos, plan = null) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  return {
    format: FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    // Photo de départ du parcours (choisie sur le plan), désignée par son nom de fichier.
    ...(plan && plan.start && byId.has(plan.start) ? { start: byId.get(plan.start).fileName, ...(plan.startYaw != null ? { startYaw: plan.startYaw } : {}) } : {}),
    ...(plan && (plan.lines.length || plan.texts.length || plan.ceilingH || (plan.rooms || []).length || plan.north || plan.pxPerM) ? { plan: withoutStart(plan) } : {}),
    // Ordre de prise de vue (puis nom) : un parcours partagé commence par la première photo prise.
    photos: [...photos].sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0) || String(a.name).localeCompare(String(b.name))).map((p) => ({
      file: p.fileName,
      ...(p.takenAt ? { takenAt: p.takenAt } : {}),
      size: p.fileSize,
      name: p.name,
      srcType: p.srcType,
      params: p.params,
      ...(p.mapPos ? { mapPos: p.mapPos } : {}),
      ...(p.mapRot ? { mapRot: p.mapRot } : {}),
      ...(p.mapPlaced ? { mapPlaced: true } : {}),
      ...(p.mapHidden ? { mapHidden: true } : {}),
      ...(p.room && (p.room.none || p.room.name || (p.room.corners || []).length) ? { room: p.room } : {}),
      ...(p.relief ? { relief: p.relief } : {}),
      ...(p.kind === 'video' ? { kind: 'video', video: p.video || {} } : {}),
      hotspots: (p.hotspots || [])
        .filter((h) => byId.has(h.target))
        .map((h) => ({ target: byId.get(h.target).fileName, yaw: h.yaw, pitch: h.pitch, label: h.label || '', ...(h.arrive ? { arrive: h.arrive } : {}), ...(h.auto ? { auto: true } : {}) })),
    })),
  };
}

// Empreinte d'un fichier de réglages (sans sa date d'export) : deux fichiers de même empreinte
// décrivent le même travail.
export function settingsSignature(data) {
  const photos = [...((data && data.photos) || [])].sort((a, b) => String(a.file).localeCompare(String(b.file)));
  return JSON.stringify({ photos, plan: (data && data.plan) || null, start: (data && data.start) || null, startYaw: data && data.startYaw != null ? data.startYaw : null });
}

// Résumé lisible d'un fichier de réglages : nombre de photos, de liens, de photos redressées, de pièces.
export function settingsSummary(data) {
  const photos = (data && data.photos) || [];
  const leveled = photos.filter((e) => e.params && (Math.abs(e.params.pitch || 0) + Math.abs(e.params.roll || 0) > 0.05 || Math.abs(e.params.yaw || 0) > 0.05)).length;
  return {
    photos: photos.length,
    links: photos.reduce((n, e) => n + ((e.hotspots || []).length), 0),
    leveled,
    rooms: ((data && data.plan && data.plan.rooms) || []).length,
  };
}

// Sauvegardes automatiques du travail (dans le navigateur) : une avant chaque chargement d'un fichier
// de réglages, et une à chaque ouverture de l'application. Les 12 plus récentes sont gardées.
const BACKUP_KEY = 'backups';
export async function backupNow(reason) {
  const photos = await db.listPhotos();
  if (!photos.length) return false;
  const data = buildSettings(photos, await db.getPlanDrawing());
  const list = (await db.getSetting(BACKUP_KEY)) || [];
  if (list[0] && settingsSignature(list[0].data) === settingsSignature(data)) return false;
  list.unshift({ at: Date.now(), reason, data });
  await db.putSetting(BACKUP_KEY, list.slice(0, 12));
  return true;
}
// Garde aussi un fichier qu'on a choisi de ne pas charger (pour pouvoir y revenir).
export async function backupData(data, reason) {
  const list = (await db.getSetting(BACKUP_KEY)) || [];
  list.unshift({ at: Date.now(), reason, data });
  await db.putSetting(BACKUP_KEY, list.slice(0, 12));
}
export async function listBackups() {
  return (await db.getSetting(BACKUP_KEY)) || [];
}

export function settingsBlob(photos, plan = null) {
  return new Blob([JSON.stringify(buildSettings(photos, plan), null, 1)], { type: 'application/json' });
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
  if (data.plan && (Array.isArray(data.plan.lines) || Array.isArray(data.plan.texts))) await db.putPlanDrawing(data.plan);
  if (data.start && idOf.has(key(data.start))) {
    const d = await db.getPlanDrawing();
    await db.putPlanDrawing({ ...d, start: idOf.get(key(data.start)), ...(data.startYaw != null ? { startYaw: data.startYaw } : {}) });
  }
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
      ...(e.mapRot != null ? { mapRot: e.mapRot } : {}),
      ...(e.mapPlaced ? { mapPlaced: true } : {}),
      ...(e.mapHidden ? { mapHidden: true } : {}),
      ...(e.room ? { room: e.room } : {}),
      ...(e.relief ? { relief: e.relief } : {}),
      ...(e.video && cur.kind === 'video' ? { video: { ...(cur.video || {}), ...e.video } } : {}),
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
