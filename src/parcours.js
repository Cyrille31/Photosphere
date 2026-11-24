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

// Source « adresse web » : le dossier du parcours publié tel quel sur un hébergement de fichiers
// (Cloudflare Pages, Netlify, serveur personnel…). Les cartes de relief sont dans « photosphere-relief ».
// L'hébergement doit autoriser la lecture depuis PhotoSphère (en-tête CORS : fichier « _headers » écrit
// par PhotoSphère dans le dossier).
export function webSource(base) {
  let root = String(base || '').trim();
  if (!/^https?:\/\//i.test(root)) throw new Error('Adresse web non reconnue (elle doit commencer par https://).');
  root = root.replace(/[?#].*$/, '').replace(/\/[^/]*\.json$/i, '/');
  if (!root.endsWith('/')) root += '/';
  const pathOf = (n) => (/\.(profondeur\.png|fond\.jpe?g)$/i.test(n) ? RELIEF_DIR + '/' : '') + encodeURIComponent(n);
  return {
    name: root,
    // On ne peut pas lister un dossier web : les fichiers sont ceux qu'annonce photosphere.json.
    has: () => true,
    get: async (n) => {
      let last;
      for (const wait of [0, 1000, 3000, 8000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        try {
          const res = await fetch(root + pathOf(n));
          if (res.ok) return await res.blob();
          last = new Error(`erreur ${res.status} pour « ${n} »`);
          if (res.status === 404) throw last;
          if (res.status < 500 && res.status !== 429) break;
        } catch (e) {
          last = e;
          if (/erreur 404/.test(e.message)) throw new Error(`fichier « ${n} » introuvable à cette adresse`);
        }
      }
      throw last || new Error('réseau indisponible');
    },
  };
}

// Mémoire de la visite : chaque fichier n'est téléchargé qu'une fois par visite. Il est rangé sur le
// disque de l'appareil (stockage du navigateur, sans limite de nombre : plus de 100 photos ne posent pas
// de problème) ; seuls les plus récents restent aussi en mémoire vive. Tout est effacé en quittant le
// parcours, et ce qui resterait d'une visite interrompue (onglet fermé) l'est au lancement suivant.
// Les préchargements passent l'un après l'autre, sans gêner la photo demandée.
const DISK = 'photosphere-parcours';
export async function clearParcoursDisk() {
  try {
    if (typeof caches !== 'undefined') await caches.delete(DISK);
  } catch (e) {
    // stockage indisponible
  }
}
const defaultCacheBytes = () => {
  const mobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
  return (mobile ? 200 : 500) * 1048576;
};
export function sessionCache(source, maxBytes = defaultCacheBytes()) {
  const entries = new Map(); // en mémoire vive : nom → { p: Promise<Blob>, t, size }
  const stored = new Set(); // noms rangés sur le disque pendant cette visite
  const downloads = new Map(); // nom → nombre de téléchargements (contrôle : 1 par fichier)
  let queue = Promise.resolve();
  let disk = null;
  const openDisk = () => (disk ||= typeof caches !== 'undefined' ? caches.open(DISK).catch(() => null) : Promise.resolve(null));
  const diskUrl = (k) => 'https://parcours.photosphere.invalid/' + encodeURIComponent(k);
  const trim = () => {
    let total = 0;
    for (const e of entries.values()) total += e.size || 0;
    if (total <= maxBytes) return;
    // Les plus anciennes quittent la mémoire vive (pas le disque), en gardant les 6 dernières utilisées.
    const old = [...entries.entries()].filter(([, e]) => e.size).sort((a, b) => a[1].t - b[1].t).slice(0, -6);
    for (const [k, e] of old) {
      if (total <= maxBytes) break;
      if (!stored.has(k)) continue; // pas sur le disque : on la garde, pour ne pas la retélécharger
      entries.delete(k);
      total -= e.size;
    }
  };
  const load = async (n, k) => {
    const c = await openDisk();
    if (c && stored.has(k)) {
      const r = await c.match(diskUrl(k)).catch(() => null);
      if (r) return r.blob();
    }
    downloads.set(k, (downloads.get(k) || 0) + 1);
    const b = await source.get(n);
    if (c) {
      try {
        await c.put(diskUrl(k), new Response(b, { headers: { 'content-type': b.type || 'application/octet-stream' } }));
        stored.add(k);
      } catch (e) {
        // disque plein ou indisponible : la photo reste en mémoire vive
      }
    }
    return b;
  };
  const get = (n) => {
    const k = key(n);
    let e = entries.get(k);
    if (!e) {
      e = { p: load(n, k) };
      e.p.then(
        (b) => {
          e.size = (b && b.size) || 1;
          trim();
        },
        () => entries.delete(k)
      );
      entries.set(k, e);
    }
    e.t = performance.now();
    return e.p;
  };
  return {
    get,
    has: (n) => entries.has(key(n)) || stored.has(key(n)),
    prefetch(names) {
      for (const n of names) queue = queue.then(() => get(n).then(() => {}, () => {}));
      return queue;
    },
    downloads: (n) => downloads.get(key(n)) || 0,
    clear() {
      entries.clear();
      stored.clear();
      disk = null;
      return clearParcoursDisk();
    },
    get size() {
      return new Set([...entries.keys(), ...stored]).size;
    },
  };
}

// Photos de la visite d'après le fichier de réglages (seules celles présentes dans la source).
export function tourFromSettings(data, has) {
  if (!data || !Array.isArray(data.photos)) throw new Error('Ce fichier n’est pas un fichier de réglages PhotoSphère.');
  // Les vidéos ne sont pas encore proposées dans un parcours partagé (étape suivante).
  const entries = data.photos.filter((e) => e.file && e.kind !== 'video' && has(e.file));
  // Liens vers les photos retirées du plan : plus proposés dans la navigation.
  const ids = new Set(entries.filter((e) => !e.mapHidden).map((e) => key(e.file)));
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
    // Sens du regard en entrant (choisi sur le plan, flèche autour de la photo de départ).
    ...(data.startYaw != null && start === byId.get(key(data.start)) ? { initialView: { yaw: (data.startYaw * Math.PI) / 180, pitch: 0 } } : {}),
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
