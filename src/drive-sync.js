// Copie du dossier de travail vers un dossier Google Drive (pour le parcours partagé) : photos d'origine,
// photosphere.json et cartes de relief (sous-dossier « photosphere-relief »). Seul ce qui a changé est
// envoyé ; ce qui n'existe plus dans le dossier de travail est mis à la corbeille de Drive (récupérable).
// Les autres fichiers du dossier Drive ne sont jamais touchés.
// Écrire sur Drive demande la connexion du propriétaire du dossier (Google, « OAuth ») : la clé d'API
// du parcours ne permet que la lecture.
import { RELIEF_DIR } from './relief-files.js';
import { SETTINGS_FILE_NAME } from './settings-file.js';

// Identifiant client OAuth (public, comme la clé d'API) de l'application PhotoSphère dans Google Cloud.
// Un identifiant enregistré sur l'appareil (réglage « ps-google-client ») est prioritaire.
export const GOOGLE_CLIENT_ID = '';
export const clientId = () => {
  try {
    return localStorage.getItem('ps-google-client') || GOOGLE_CLIENT_ID;
  } catch (e) {
    return GOOGLE_CLIENT_ID;
  }
};

const SCOPE = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

let token = null, tokenExp = 0;

function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('connexion à Google impossible (réseau ?)'));
    document.head.appendChild(s);
  });
}

// Jeton d'accès (fenêtre de connexion Google la première fois, puis réutilisé pendant une heure).
// À appeler directement depuis un clic : le navigateur bloque sinon la fenêtre de connexion.
export async function signIn() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const id = clientId();
  if (!id) throw new Error('identifiant Google (OAuth) non configuré');
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        token = r.access_token;
        tokenExp = Date.now() + (r.expires_in || 3600) * 1000;
        resolve(token);
      },
      error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? 'connexion annulée' : (e && (e.message || e.type)) || 'connexion refusée')),
    });
    client.requestAccessToken();
  });
}

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  if (!res.ok) {
    let msg = `erreur ${res.status}`;
    try {
      const j = await res.json();
      if (j.error && j.error.message) msg = j.error.message;
    } catch (e) {
      // réponse non JSON
    }
    if (res.status === 404) msg = 'dossier Google Drive introuvable (vérifiez le lien et que vous en êtes propriétaire ou éditeur)';
    throw new Error(msg);
  }
  return res;
}

async function listFolder(id) {
  const out = [];
  let page = '';
  do {
    const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
    const r = await (await api(`${API}?q=${q}&fields=nextPageToken,files(id,name,size,mimeType,modifiedTime)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true${page ? '&pageToken=' + page : ''}`)).json();
    out.push(...(r.files || []));
    page = r.nextPageToken || '';
  } while (page);
  return out;
}

const trash = (id) => api(`${API}/${id}?supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });

async function createFolder(name, parent) {
  return (await api(`${API}?supportsAllDrives=true&fields=id,name`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) })).json();
}

// Envoi (création ou remplacement du contenu) en mode « reprise » : adapté aux photos de 10 Mo et plus.
// La date de modification du fichier local est reportée sur Drive : elle sert à repérer ce qui a changé.
async function upload(file, { name, parent, id }) {
  const meta = id ? { modifiedTime: new Date(file.lastModified).toISOString() } : { name, parents: [parent], modifiedTime: new Date(file.lastModified).toISOString() };
  const init = await api(`${id ? UPLOAD + '/' + id : UPLOAD}?uploadType=resumable&supportsAllDrives=true`, {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': file.type || 'application/octet-stream' },
    body: JSON.stringify(meta),
  });
  const loc = init.headers.get('Location');
  if (!loc) throw new Error('envoi refusé par Google Drive');
  const res = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  if (!res.ok) throw new Error(`envoi de « ${name} » interrompu (erreur ${res.status})`);
}

// Fichiers gérés par PhotoSphère dans le dossier Drive (les autres ne sont jamais touchés).
const isPhoto = (n) => /\.jpe?g$/i.test(n) && !/\.fond\.jpe?g$/i.test(n);
const managedTop = (n) => isPhoto(n) || n === SETTINGS_FILE_NAME;
const managedRelief = (n) => /\.(profondeur\.png|fond\.jpe?g)$/i.test(n);

// Même fichier : même taille et, sauf pour les photos d'origine (jamais modifiées : celles déjà copiées
// à la main sur Drive ne sont pas renvoyées), même date de modification (à 2 s près).
const same = (file, remote) => remote && +remote.size === file.size && (isPhoto(file.name) || Math.abs(Date.parse(remote.modifiedTime) - file.lastModified) < 2000);

async function localFiles(dir, accept) {
  const out = new Map();
  for await (const e of dir.values()) if (e.kind === 'file' && accept(e.name)) out.set(e.name, await e.getFile());
  return out;
}

// Plan de synchronisation entre un dossier local (poignée) et un dossier Drive, puis exécution.
// onProgress(fait, total, nom) ; renvoie { sent, updated, trashed, unchanged }.
export async function syncToDrive(dirHandle, folderId, { onProgress = () => {} } = {}) {
  if (!token) throw new Error('non connecté à Google');
  const localTop = await localFiles(dirHandle, managedTop);
  let localRelief = new Map();
  try {
    localRelief = await localFiles(await dirHandle.getDirectoryHandle(RELIEF_DIR), managedRelief);
  } catch (e) {
    // pas de relief
  }
  const remoteTop = await listFolder(folderId);
  // Dossier du relief sur Drive (créé si besoin ; les doublons du même nom vont à la corbeille).
  const reliefFolders = remoteTop.filter((f) => f.mimeType === FOLDER && f.name === RELIEF_DIR);
  let reliefId = reliefFolders[0] ? reliefFolders[0].id : null;
  const remoteRelief = reliefId ? await listFolder(reliefId) : [];

  const tasks = [];
  const plan = (local, remote, managed, parent) => {
    const byName = new Map();
    for (const f of remote) {
      if (f.mimeType === FOLDER || !managed(f.name)) continue;
      if (!byName.has(f.name)) byName.set(f.name, []);
      byName.get(f.name).push(f);
    }
    for (const [name, file] of local) {
      const copies = byName.get(name) || [];
      const keep = copies.find((r) => same(file, r)) || copies[0];
      copies.filter((r) => r !== keep).forEach((r) => tasks.push({ kind: 'trash', name, id: r.id }));
      if (!keep) tasks.push({ kind: 'send', name, file, parent });
      else if (!same(file, keep)) tasks.push({ kind: 'update', name, file, id: keep.id });
      else tasks.push({ kind: 'same', name });
      byName.delete(name);
    }
    for (const [name, copies] of byName) copies.forEach((r) => tasks.push({ kind: 'trash', name, id: r.id }));
  };
  plan(localTop, remoteTop, managedTop, folderId);
  plan(localRelief, remoteRelief, managedRelief, () => reliefId);
  reliefFolders.slice(1).forEach((f) => tasks.push({ kind: 'trash', name: f.name, id: f.id }));

  const stats = { sent: 0, updated: 0, trashed: 0, unchanged: 0 };
  const work = tasks.filter((t) => t.kind !== 'same');
  stats.unchanged = tasks.length - work.length;
  // photosphere.json en dernier : le parcours ne voit jamais des réglages qui renvoient à des photos
  // pas encore arrivées.
  work.sort((a, b) => (a.name === SETTINGS_FILE_NAME) - (b.name === SETTINGS_FILE_NAME));
  for (let i = 0; i < work.length; i++) {
    const t = work[i];
    onProgress(i, work.length, t.name);
    if (t.kind === 'trash') {
      await trash(t.id);
      stats.trashed++;
    } else {
      let parent = typeof t.parent === 'function' ? t.parent() : t.parent;
      if (t.kind === 'send' && !parent) {
        reliefId = (await createFolder(RELIEF_DIR, folderId)).id;
        parent = reliefId;
      }
      await upload(t.file, { name: t.name, parent, id: t.id });
      stats[t.kind === 'send' ? 'sent' : 'updated']++;
    }
  }
  onProgress(work.length, work.length, '');
  return stats;
}
