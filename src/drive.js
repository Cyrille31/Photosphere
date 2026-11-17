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

export const DIRECT = 'https://lh3.googleusercontent.com/d/';
async function direct(id) {
  let last;
  for (const wait of [0, 1500, 4000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(`${DIRECT}${encodeURIComponent(id)}=d`);
      if (res.ok) return await res.blob();
      last = new Error(`erreur ${res.status}`);
      if (res.status === 404 || res.status === 403) break;
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error('réseau indisponible');
}

// Erreur passagère (réseau coupé, trop de requêtes, serveur occupé) : on réessaie (jusqu'à 4 fois,
// après 1, 3, 8 puis 15 s : Google ralentit parfois les téléchargements pendant quelques secondes).
const RETRY_DELAYS = [1000, 3000, 8000, 15000];
async function call(url, key, tries = RETRY_DELAYS.length) {
  let res;
  for (let k = 0; ; k++) {
    try {
      res = await fetch(url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key));
      if (res.ok || !(res.status === 429 || res.status >= 500 || (res.status === 403 && /rate|quota/i.test(await res.clone().text().catch(() => '')))) || k >= tries) break;
    } catch (e) {
      if (k >= tries) throw new Error('réseau indisponible (' + e.message + ')');
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAYS[k]));
  }
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
    const url = `${API}?q=${q}&fields=nextPageToken,files(id,name,size,mimeType,modifiedTime)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${page ? '&pageToken=' + page : ''}`;
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
  // Deux fichiers du même nom (Drive l'autorise, ex. photosphere.json envoyé deux fois) : le plus récent.
  const keep = (f) => {
    const k = f.name.toLowerCase(), prev = byName.get(k);
    if (!prev || String(f.modifiedTime || '') >= String(prev.modifiedTime || '')) byName.set(k, f);
  };
  for (const f of files) if (f.mimeType !== FOLDER) keep(f);
  const relief = files.find((f) => f.mimeType === FOLDER && f.name === RELIEF_DIR);
  if (relief) for (const f of await listFolder(relief.id, key)) if (f.mimeType !== FOLDER) keep(f);
  return {
    name: 'Google Drive',
    has: (n) => byName.has(String(n).toLowerCase()),
    get: async (n) => {
      const f = byName.get(String(n).toLowerCase());
      if (!f) throw new Error(`fichier « ${n} » introuvable dans le dossier`);
      // Fichier d'origine, intact, servi par le réseau d'images de Google (comme dans Florilège) : pas
      // soumis au freinage des téléchargements anonymes de l'API Drive. En cas d'échec, l'API prend le relais.
      try {
        if (/\.json$/i.test(n)) throw new Error('pas une image'); // servi seulement par l'API
        return await direct(f.id);
      } catch (e) {
        return (await call(`${API}/${f.id}?alt=media&supportsAllDrives=true`, key, 2)).blob();
      }
    },
  };
}
