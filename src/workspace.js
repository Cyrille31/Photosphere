// Dossier de travail (PC, Chrome / Edge) : l'application reçoit l'accès au dossier des photos
// d'origine, y lit les photos et y tient « photosphere.json » à jour automatiquement. Elle peut aussi,
// en option, renommer le fichier d'une photo quand on la renomme. Les autres navigateurs (Firefox,
// Safari, smartphones) ne permettent pas cet accès : l'export manuel du fichier reste disponible.
import * as db from './db.js';
import { settingsBlob, SETTINGS_FILE_NAME } from './settings-file.js';
import { RELIEF_DIR, reliefNames, HEADERS_FILE, HEADERS_CONTENT } from './relief-files.js';
import { reliefKey } from './depth.js';

const HANDLE_KEY = 'workspace-handle';
const SAVE_DELAY = 1500;

let handle = null;
let granted = false;
let saveTimer = 0;
let saving = null;
let lastSaved = null;
let lastError = null;
const listeners = new Set();

export const isSupported = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

function emit() {
  listeners.forEach((fn) => fn(getStatus()));
}

const unsavedListeners = new Set();
export function onUnsaved(fn) {
  unsavedListeners.add(fn);
  return () => unsavedListeners.delete(fn);
}

export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Poignée du dossier lié (synchronisation vers Google Drive), si l'accès est accordé.
export const getHandle = () => (handle && granted ? handle : null);

export function getStatus() {
  return { supported: isSupported(), linked: !!handle, granted, name: handle ? handle.name : '', lastSaved, lastError };
}

async function permission(h, request) {
  if (!h.queryPermission) return true; // poignées sans gestion de permission (stockage privé)
  const opts = { mode: 'readwrite' };
  if ((await h.queryPermission(opts)) === 'granted') return true;
  if (!request) return false;
  return (await h.requestPermission(opts)) === 'granted';
}

// Au démarrage : retrouve le dossier lié (l'accès doit souvent être reconfirmé d'un clic).
export async function init() {
  if (!isSupported()) return getStatus();
  try {
    handle = (await db.getSetting(HANDLE_KEY)) || null;
    granted = handle ? await permission(handle, false) : false;
  } catch (e) {
    handle = null;
    granted = false;
  }
  db.onPhotosChanged(() => {
    // Dossier lié mais accès à reconfirmer : les modifications ne vont pas dans photosphere.json.
    if (handle && !granted) unsavedListeners.forEach((fn) => fn());
    scheduleSave();
  });
  emit();
  return getStatus();
}

export async function link() {
  const h = await window.showDirectoryPicker({ id: 'photosphere', mode: 'readwrite' });
  handle = h;
  granted = await permission(h, true);
  await db.putSetting(HANDLE_KEY, h);
  emit();
  return getStatus();
}

export async function reconnect() {
  if (!handle) return getStatus();
  granted = await permission(handle, true);
  emit();
  return getStatus();
}

export async function unlink() {
  clearTimeout(saveTimer);
  handle = null;
  granted = false;
  await db.putSetting(HANDLE_KEY, null);
  emit();
}

const isPhoto = (name) => /\.(jpe?g|mp4|m4v|mov)$/i.test(name);

// Photos JPEG du dossier (et de ses sous-dossiers, ex. DCIM/100PHOTO) et fichier de réglages.
export async function listFiles(maxDepth = 3) {
  if (!handle || !granted) return [];
  const files = [];
  const walk = async (dir, depth) => {
    for await (const entry of dir.values()) {
      if (entry.kind === 'file' && (isPhoto(entry.name) || (depth === 0 && entry.name === SETTINGS_FILE_NAME))) {
        files.push(await entry.getFile());
      } else if (entry.kind === 'directory' && depth < maxDepth && !entry.name.startsWith('.') && entry.name !== RELIEF_DIR) {
        await walk(entry, depth + 1);
      }
    }
  };
  await walk(handle, 0);
  // Le fichier de réglages en dernier : il s'applique aux photos importées.
  return files.sort((a, b) => (a.name === SETTINGS_FILE_NAME) - (b.name === SETTINGS_FILE_NAME));
}

export function scheduleSave() {
  if (!handle || !granted) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow().catch(() => {}), SAVE_DELAY);
}

// Écrit photosphere.json à la racine du dossier de travail.
export async function saveNow() {
  if (!handle || !granted) return false;
  if (saving) await saving;
  saving = (async () => {
    try {
      const photos = await db.listPhotos();
      const blob = settingsBlob(photos, await db.getPlanDrawing());
      const fh = await handle.getFileHandle(SETTINGS_FILE_NAME, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      await saveReliefs(photos);
      // Fichier « _headers » (une fois) : le dossier peut être publié tel quel sur un hébergement web.
      try {
        await handle.getFileHandle(HEADERS_FILE);
      } catch (e) {
        const hw = await (await handle.getFileHandle(HEADERS_FILE, { create: true })).createWritable();
        await hw.write(HEADERS_CONTENT);
        await hw.close();
      }
      lastSaved = new Date();
      lastError = null;
    } catch (e) {
      lastError = e.message;
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') granted = false;
    }
    emit();
  })();
  await saving;
  saving = null;
  return !lastError;
}

// Cartes de relief à jour, rangées dans le sous-dossier « photosphere-relief » (une seule écriture
// par carte et par session : on retient ce qui a déjà été écrit).
const reliefWritten = new Set();
async function saveReliefs(photos) {
  let dir = null;
  for (const p of photos) {
    if (!p.relief || p.relief.kind !== 'ai' || p.relief.key !== reliefKey(p.params) || !p.fileName) continue;
    const depth = await db.getBlob(p.id + ':depth');
    if (!depth) continue;
    const tag = `${p.id}|${p.fileName}|${p.relief.key}|${depth.size}`;
    if (reliefWritten.has(tag)) continue;
    if (!dir) dir = await handle.getDirectoryHandle(RELIEF_DIR, { create: true });
    const names = reliefNames(p.fileName);
    const files = [[names.depth, depth], [names.bg, await db.getBlob(p.id + ':depthbg')]];
    for (const [name, b] of files) {
      if (!b) continue;
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(b);
      await w.close();
    }
    reliefWritten.add(tag);
  }
  // Cartes de relief d'une photo qui n'est plus dans le dossier (fichier renommé ou supprimé) : effacées,
  // pour ne pas encombrer le dossier ni la copie Google Drive.
  try {
    const rd = dir || (await handle.getDirectoryHandle(RELIEF_DIR));
    const present = new Set();
    const walk = async (d, depth) => {
      for await (const e of d.values()) {
        if (e.kind === 'file') present.add(e.name.toLowerCase());
        else if (depth < 3 && !e.name.startsWith('.') && e.name !== RELIEF_DIR) await walk(e, depth + 1);
      }
    };
    await walk(handle, 0);
    const stale = [];
    for await (const e of rd.values()) {
      const m = e.kind === 'file' && e.name.match(/^(.*)\.(profondeur\.png|fond\.jpe?g)$/i);
      if (m && !present.has(m[1].toLowerCase())) stale.push(e.name);
    }
    for (const n of stale) await rd.removeEntry(n);
  } catch (e) {
    // pas de dossier de relief
  }
}

async function findFile(dir, name, depth = 0) {
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && entry.name.toLowerCase() === name.toLowerCase()) return { dir, entry };
    if (entry.kind === 'directory' && depth < 3 && !entry.name.startsWith('.')) {
      const found = await findFile(entry, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'photo';
}

// Renomme le fichier d'origine d'une photo d'après son nouveau nom (extension conservée).
// Renvoie le nouveau nom de fichier, ou null si rien n'a été fait.
export async function renameFile(oldFileName, newName) {
  if (!handle || !granted || !oldFileName) return null;
  const ext = (oldFileName.match(/\.[^.]+$/) || ['.JPG'])[0];
  const target = safeFileName(newName) + ext;
  if (target === oldFileName) return null;
  const found = await findFile(handle, oldFileName);
  if (!found) throw new Error(`« ${oldFileName} » introuvable dans le dossier de travail`);
  if (target.toLowerCase() !== oldFileName.toLowerCase()) {
    const exists = await found.dir.getFileHandle(target).then(() => true, () => false);
    if (exists) throw new Error(`un fichier « ${target} » existe déjà`);
  }
  // Copie à l'identique sous le nouveau nom, vérification de la taille, puis suppression de l'ancien
  // fichier (la méthode de déplacement native n'est pas fiable partout).
  const file = await found.entry.getFile();
  const nh = await found.dir.getFileHandle(target, { create: true });
  const w = await nh.createWritable();
  await w.write(file);
  await w.close();
  const copy = await nh.getFile();
  if (copy.size !== file.size) {
    await found.dir.removeEntry(target).catch(() => {});
    throw new Error('copie incomplète, fichier d’origine conservé');
  }
  if (target.toLowerCase() !== found.entry.name.toLowerCase()) await found.dir.removeEntry(found.entry.name);
  return target;
}
