// Visualiser un parcours partagé : le dossier des photos d'origine avec son « photosphere.json »
// (et le sous-dossier « photosphere-relief »), préparé avec PhotoSphère sur PC. Rien n'est importé :
// les photos sont lues à la demande, en pleine définition (assemblées en direct par la carte graphique),
// gardées en mémoire le temps de la visite seulement, et les photos liées à celle qu'on regarde sont
// préchargées pour que le passage par un lien soit immédiat.
import { createPlayer } from './player.js';
import { DEFAULT_LENS_PARAMS } from './gl-source.js';
import { reliefKey } from './depth.js';
import { reliefNames, RELIEF_DIR } from './relief-files.js';
import { SETTINGS_FILE_NAME } from './settings-file.js';

const key = (n) => String(n || '').toLowerCase();

// Source « fichiers choisis sur l'appareil » (dossier sur PC, fichiers sur smartphone, y compris
// depuis l'application OneDrive / Google Drive par le sélecteur de fichiers du téléphone).
// Toute source fournit : name, has(nom), get(nom) → Promise<Blob>.
export function filesSource(files, name = 'Fichiers choisis') {
  const byName = new Map();
  for (const f of files) {
    const path = (f.webkitRelativePath || f.name).split('/');
    // Les cartes de relief sont reconnues à leur nom, rangées ou non dans « photosphere-relief ».
    if (!byName.has(key(f.name)) || path.includes(RELIEF_DIR)) byName.set(key(f.name), f);
  }
  return { name, has: (n) => byName.has(key(n)), get: async (n) => byName.get(key(n)) || Promise.reject(new Error(`fichier « ${n} » introuvable`)) };
}

// Mémoire de la visite : les fichiers déjà lus (au plus `max`, les plus anciens oubliés), effacée en
// sortant. Les préchargements passent l'un après l'autre, sans gêner la photo demandée.
export function sessionCache(source, max = 24) {
  const entries = new Map(); // nom → { p: Promise<Blob>, t }
  let queue = Promise.resolve();
  const get = (n) => {
    const k = key(n);
    let e = entries.get(k);
    if (!e) {
      e = { p: source.get(n) };
      e.p.catch(() => entries.delete(k));
      entries.set(k, e);
    }
    e.t = performance.now();
    if (entries.size > max) {
      const old = [...entries.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, entries.size - max);
      old.forEach(([k2]) => entries.delete(k2));
    }
    return e.p;
  };
  return {
    get,
    has: (n) => entries.has(key(n)),
    prefetch(names) {
      for (const n of names) queue = queue.then(() => get(n).then(() => {}, () => {}));
      return queue;
    },
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };
}

// Photos de la visite d'après le fichier de réglages (seules celles présentes dans la source).
export function tourFromSettings(data, has) {
  if (!data || !Array.isArray(data.photos)) throw new Error('Ce fichier n’est pas un fichier de réglages PhotoSphère.');
  const entries = data.photos.filter((e) => e.file && has(e.file));
  const ids = new Set(entries.map((e) => key(e.file)));
  return entries.map((e) => {
    const params = { yaw: 0, pitch: 0, roll: 0, ...JSON.parse(JSON.stringify(DEFAULT_LENS_PARAMS)), ...(e.params || {}) };
    const rn = reliefNames(e.file);
    const relief = e.relief && e.relief.kind === 'ai' && has(rn.depth) ? e.relief : null;
    return {
      id: key(e.file),
      file: e.file,
      name: e.name || e.file,
      srcType: e.srcType || 'fisheye',
      params,
      hotspots: (e.hotspots || []).filter((h) => ids.has(key(h.target))).map((h) => ({ target: key(h.target), yaw: h.yaw, pitch: h.pitch, label: h.label || '', ...(h.arrive ? { arrive: h.arrive } : {}) })),
      relief,
      reliefKey: reliefKey(params),
      reliefFiles: relief ? { depth: rn.depth, bg: has(rn.bg) ? rn.bg : null } : null,
    };
  });
}

// Ouvre la visite. Renvoie { dispose, cache, photos }.
export async function openParcours(container, source, { onExit, title } = {}) {
  if (!source.has(SETTINGS_FILE_NAME)) throw new Error(`Le fichier « ${SETTINGS_FILE_NAME} » est absent : choisissez-le avec les photos.`);
  let data;
  try {
    data = JSON.parse(await (await source.get(SETTINGS_FILE_NAME)).text());
  } catch (e) {
    throw new Error(`« ${SETTINGS_FILE_NAME} » illisible : ${e.message}`);
  }
  const photos = tourFromSettings(data, source.has);
  if (!photos.length) throw new Error('Aucune des photos du parcours n’a été trouvée avec le fichier de réglages.');
  const cache = sessionCache(source);
  const byId = new Map(photos.map((p) => [p.id, p]));
  for (const p of photos) {
    p.src = () => cache.get(p.file);
    if (p.reliefFiles) {
      p.depthSrc = () => cache.get(p.reliefFiles.depth);
      if (p.reliefFiles.bg) p.depthBgSrc = () => cache.get(p.reliefFiles.bg);
    }
  }
  const filesOf = (p) => [p.file, ...(p.reliefFiles ? [p.reliefFiles.depth, p.reliefFiles.bg].filter(Boolean) : [])];
  // Photo de départ : celle indiquée dans le fichier, sinon la première prise qui a des liens (le début
  // du parcours ; les photos y sont rangées dans l'ordre de prise de vue), sinon la première.
  const start = (data.start && byId.get(key(data.start))) || photos.find((p) => p.hotspots.length) || photos[0];
  let disposed = false;
  const player = createPlayer(container, {
    photos,
    startId: start.id,
    title: title || data.title || 'Parcours',
    maxHalf: 4096, // pleine définition (casque)
    onShow: (photo) => {
      // Photos liées préchargées pendant qu'on regarde celle-ci.
      const next = photo.hotspots.map((h) => byId.get(h.target)).filter(Boolean);
      cache.prefetch(next.flatMap(filesOf));
    },
    onExit: () => {
      dispose();
      if (onExit) onExit();
    },
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    player.dispose();
    cache.clear(); // rien ne reste sur l'appareil
  }
  return { dispose, cache, photos };
}
