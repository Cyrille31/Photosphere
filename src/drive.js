// Source « dossier Google Drive partagé » pour les parcours : un dossier partagé en « Tous les
// utilisateurs qui ont le lien » se lit avec l'interface publique de Drive et une clé d'accès (aucune
// connexion du visiteur). La clé, restreinte au site de PhotoSphère et à l'API Drive, ne permet de lire
// que des fichiers déjà partagés publiquement.
import { RELIEF_DIR } from './relief-files.js';

// Clé d'accès à l'API Google Drive (console.cloud.google.com, restreinte au site de PhotoSphère).
export const GOOGLE_API_KEY = 'AIzaSyCA0MY58YEDkMQNgxpPXjG3RAHA4kq_Vag';
const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

// Identifiant du dossier d'après son lien de partage (ou l'identifiant lui-même).
export function driveFolderId(link) {
  const s = String(link || '').trim();
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || s.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : null;
}

// Lien à envoyer aux visiteurs : ouvre PhotoSphère directement sur le parcours.
export function parcoursLink(folderId, base = location.origin + location.pathname) {
  return `${base}#/parcours?drive=${encodeURIComponent(folderId)}`;
}

async function call(url, key) {
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key));
  if (!res.ok) {
    let msg = `erreur ${res.status}`;
    try {
      const j = await res.json();
      if (j.error && j.error.message) msg = j.error.message;
    } catch (e) {
      // réponse non JSON
    }
    if (res.status === 404) msg = 'dossier introuvable : vérifiez le lien et le partage « Tous les utilisateurs qui ont le lien »';
    if (res.status === 403) msg = 'accès refusé (' + msg + ') : le dossier est-il partagé à « Tous les utilisateurs qui ont le lien » ?';
    throw new Error(msg);
  }
  return res;
}

async function listFolder(id, key) {
  const out = [];
  let page = '';
  do {
    const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
    const url = `${API}?q=${q}&fields=nextPageToken,files(id,name,size,mimeType)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${page ? '&pageToken=' + page : ''}`;
    const j = await (await call(url, key)).json();
    out.push(...(j.files || []));
    page = j.nextPageToken || '';
  } while (page);
  return out;
}

// Source pour openParcours : { name, has(nom), get(nom) → Promise<Blob> }.
// Clé : celle de l'application, ou une clé enregistrée sur cet appareil (copie personnelle, essais).
function storedKey() {
  try {
    return localStorage.getItem('ps-google-key') || '';
  } catch (e) {
    return '';
  }
}

export async function driveSource(link, key = storedKey() || GOOGLE_API_KEY) {
  if (!key) throw new Error('Lecture des dossiers Google Drive pas encore configurée (clé d’accès manquante).');
  const id = driveFolderId(link);
  if (!id) throw new Error('Lien de dossier Google Drive non reconnu.');
  const files = await listFolder(id, key);
  const byName = new Map();
  for (const f of files) if (f.mimeType !== FOLDER) byName.set(f.name.toLowerCase(), f);
  const relief = files.find((f) => f.mimeType === FOLDER && f.name === RELIEF_DIR);
  if (relief) for (const f of await listFolder(relief.id, key)) if (f.mimeType !== FOLDER) byName.set(f.name.toLowerCase(), f);
  return {
    name: 'Google Drive',
    has: (n) => byName.has(String(n).toLowerCase()),
    get: async (n) => {
      const f = byName.get(String(n).toLowerCase());
      if (!f) throw new Error(`fichier « ${n} » introuvable dans le dossier`);
      return (await call(`${API}/${f.id}?alt=media&supportsAllDrives=true`, key)).blob();
    },
  };
}
