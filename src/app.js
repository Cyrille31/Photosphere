// Application PhotoSphère : bibliothèque, file de conversion, navigation.
import * as db from './db.js';
import { importFiles, convertPhoto } from './importer.js';
import { createPlayer } from './player.js';
import { openEditor } from './editor.js';
import { exportTourHtml, exportJpegZip, exportProject, importProject } from './tour-export.js';
import { toast, escapeHtml, dialog } from './ui.js';

const app = document.getElementById('app');
const state = {
  photos: [],
  settings: { outWidth: 7776, quality: 92 },
  converting: null,
  progress: 0,
  thumbs: new Map(),
  view: null,
};

// ---------- utilitaires ----------
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function busy(title) {
  const d = dialog(`<h2>${escapeHtml(title)}</h2><p class="busy-msg">…</p><progress max="1" value="0" style="width:100%"></progress>`);
  d.addEventListener('cancel', (e) => e.preventDefault());
  return {
    update(i, n, name) {
      d.querySelector('progress').value = n ? i / n : 0;
      d.querySelector('.busy-msg').textContent = name ? `${i + 1} / ${n} — ${name}` : 'Finalisation…';
    },
    close: () => d.close(),
  };
}

function sortPhotos(list) {
  return list.sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0) || a.name.localeCompare(b.name));
}

async function refresh() {
  state.photos = sortPhotos(await db.listPhotos());
  if (state.view === 'library') renderLibrary();
}

async function thumbUrl(p) {
  const key = p.id + ':' + (p.convertedAt || 0);
  if (!state.thumbs.has(key)) {
    const b = await db.getBlob(p.id + ':thumb');
    state.thumbs.set(key, b ? URL.createObjectURL(b) : '');
  }
  return state.thumbs.get(key);
}

// ---------- file de conversion ----------
async function processQueue() {
  if (state.converting) return;
  for (;;) {
    const next = (await db.listPhotos()).find((p) => p.status === 'pending');
    if (!next) break;
    state.converting = next.id;
    state.progress = 0;
    renderLibrary();
    try {
      await convertPhoto(next, state.settings, (f) => {
        state.progress = f;
        const bar = document.querySelector(`[data-id="${next.id}"] .progress`);
        if (bar) bar.style.width = Math.round(f * 100) + '%';
        const badge = document.querySelector(`[data-id="${next.id}"] .badge.status`);
        if (badge) badge.textContent = `Conversion ${Math.round(f * 100)} %`;
      });
    } catch (e) {
      console.error(e);
      const cur = await db.getPhoto(next.id);
      if (cur) await db.putPhoto({ ...cur, status: 'error', error: e.message });
      toast(`Échec de la conversion de « ${next.name} » : ${e.message}`, true, 8000);
    }
    state.converting = null;
    await refresh();
  }
}

export async function requeue(photo) {
  await db.putPhoto({ ...photo, status: 'pending' });
  await refresh();
  processQueue();
}

// ---------- import ----------
async function handleFiles(files) {
  if (!files || !files.length) return;
  const b = busy('Import des photos');
  try {
    const { added, skipped } = await importFiles(files, b.update);
    b.close();
    if (added.length) toast(`${added.length} photo(s) importée(s). Conversion en ${state.settings.outWidth} × ${state.settings.outWidth / 2} en cours…`);
    if (skipped.length) {
      const shown = skipped.filter((s) => s.reason !== 'déjà importée');
      if (shown.length)
        dialog(`<h2>Fichiers ignorés</h2><ul>${shown.slice(0, 30).map((s) => `<li><b>${escapeHtml(s.name)}</b> : ${escapeHtml(s.reason)}</li>`).join('')}</ul><div class="row"><button class="btn" data-close>OK</button></div>`);
      else toast(`${skipped.length} photo(s) déjà présente(s), ignorée(s).`);
    }
    db.requestPersistence();
  } catch (e) {
    b.close();
    toast('Import impossible : ' + e.message, true);
  }
  await refresh();
  processQueue();
}

function fileInput(attrs, onFiles) {
  const i = document.createElement('input');
  i.type = 'file';
  Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
  i.addEventListener('change', () => {
    onFiles([...i.files]);
    i.value = '';
  });
  return i;
}

const pickPhotos = fileInput({ accept: 'image/jpeg,.jpg,.jpeg', multiple: '' }, handleFiles);
const pickFolder = fileInput({ webkitdirectory: '', multiple: '' }, handleFiles);
const pickProject = fileInput({ accept: '.zip,application/zip' }, async (files) => {
  if (!files[0]) return;
  const b = busy('Restauration du projet');
  try {
    const r = await importProject(files[0], b.update);
    toast(`${r.total} photo(s) restaurée(s).`);
  } catch (e) {
    toast(e.message, true);
  }
  b.close();
  await refresh();
  processQueue();
});
document.body.append(pickPhotos, pickFolder, pickProject);
const supportsFolder = 'webkitdirectory' in document.createElement('input') && !matchMedia('(pointer: coarse)').matches;

// Glisser-déposer
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (state.view !== 'library') return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (state.view !== 'library') return;
  const files = [];
  const walk = async (entry) => {
    if (entry.isFile) files.push(await new Promise((r, j) => entry.file(r, j)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((r, j) => reader.readEntries(r, j));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  const items = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (items.length) for (const it of items) await walk(it);
  else files.push(...e.dataTransfer.files);
  handleFiles(files);
});

// ---------- bibliothèque ----------
function statusBadge(p) {
  if (state.converting === p.id) return `<span class="badge warn status">Conversion ${Math.round(state.progress * 100)} %</span>`;
  if (p.status === 'done') return `<span class="badge ok status">${p.outWidth} × ${p.outWidth / 2}</span>`;
  if (p.status === 'error') return `<span class="badge err status" title="${escapeHtml(p.error || '')}">Erreur</span>`;
  return '<span class="badge warn status">À convertir</span>';
}

function formatDate(t) {
  return t ? new Date(t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function importButtons() {
  return `
    <button class="btn primary" data-act="import">📂 Importer des photos</button>
    ${supportsFolder ? '<button class="btn" data-act="folder">💾 Carte micro SD (dossier)</button>' : ''}
    <button class="btn" data-act="wireless">📡 Gear 360 sans fil</button>`;
}

async function renderLibrary() {
  state.view = 'library';
  const photos = state.photos;
  if (!photos.length) {
    app.innerHTML = `<div class="wrap"><div class="empty">
      <img src="assets/logo.svg" alt="">
      <h2>Bienvenue dans PhotoSphère</h2>
      <p>Importez les photos de votre Gear 360 depuis la carte micro SD (dossier <code>DCIM</code>) ou depuis la galerie du téléphone.<br>
      Elles seront assemblées au format équirectangulaire 7776 × 3888, lisible par tous les visualiseurs 360°.</p>
      <p>Vous pouvez aussi glisser-déposer des fichiers ou un dossier ici.</p>
      <div class="toolbar">${importButtons()}
      <button class="btn" data-act="restore">♻ Restaurer une sauvegarde</button></div>
    </div></div>`;
    bindLibrary();
    return;
  }
  const links = photos.reduce((s, p) => s + (p.hotspots || []).length, 0);
  app.innerHTML = `<div class="wrap">
    <div class="toolbar">
      ${importButtons()}
      <span class="spacer"></span>
      <button class="btn primary" data-act="visit">🥽 Visiter</button>
      <div class="menu">
        <button class="btn" data-act="menu">⬇ Exporter ▾</button>
        <div class="menu-list" hidden>
          <button data-act="export-tour">🌐 Visite autonome (fichier HTML)<small>Un seul fichier à partager : s’ouvre sur smartphone, PC, casque VR</small></button>
          <button data-act="export-zip">🖼 Toutes les photos JPEG (ZIP)<small>${state.settings.outWidth} × ${state.settings.outWidth / 2}, métadonnées photosphère</small></button>
          <button data-act="export-project">💾 Sauvegarder le projet<small>Pour le transférer vers le téléphone ou un autre appareil</small></button>
          <button data-act="restore">♻ Restaurer une sauvegarde</button>
        </div>
      </div>
    </div>
    <p class="note">${photos.length} photo(s), ${links} lien(s). Astuce : réglez le « cap » de chaque photo dans l’éditeur pour que le nord soit commun à toutes — les transitions entre photos garderont alors la bonne direction.</p>
    <div class="grid">${photos
      .map(
        (p) => `<div class="card" data-id="${p.id}">
        <div class="thumb" data-act="view"><img alt="" loading="lazy">
          <div class="badges"><span class="badge">${p.srcType === 'fisheye' ? 'Double fisheye' : 'Équirectangulaire'}</span>${statusBadge(p)}
          ${(p.hotspots || []).length ? `<span class="badge">🔗 ${p.hotspots.length}</span>` : ''}</div>
          <div class="progress" style="width:${state.converting === p.id ? Math.round(state.progress * 100) : 0}%"></div>
        </div>
        <div class="card-body">
          <div class="card-title" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
          <div class="card-meta">${formatDate(p.takenAt)}${p.model ? ' · ' + escapeHtml(p.model) : ''} · source ${p.srcWidth} × ${p.srcHeight}</div>
          <div class="card-actions">
            <button class="btn small" data-act="view">👁 Voir</button>
            <button class="btn small" data-act="edit">✏ Éditer</button>
            <button class="btn small" data-act="jpeg" ${p.status === 'done' ? '' : 'disabled'}>⬇ JPEG</button>
            ${p.status === 'error' ? '<button class="btn small" data-act="retry">↻ Réessayer</button>' : ''}
            <button class="btn small danger" data-act="delete" title="Supprimer">🗑</button>
          </div>
        </div>
      </div>`
      )
      .join('')}</div></div>`;
  bindLibrary();
  for (const p of photos) {
    const img = app.querySelector(`[data-id="${p.id}"] img`);
    if (img) img.src = await thumbUrl(p);
  }
}

function bindLibrary() {
  app.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', (e) => {
      const card = b.closest('.card');
      const p = card && state.photos.find((x) => x.id === card.dataset.id);
      onAction(b.dataset.act, p, b, e);
    });
  });
}

async function onAction(act, p, el) {
  const menu = app.querySelector('.menu-list');
  if (menu && act !== 'menu') menu.hidden = true;
  switch (act) {
    case 'import':
      return pickPhotos.click();
    case 'folder':
      return pickFolder.click();
    case 'restore':
      return pickProject.click();
    case 'wireless':
      return showWirelessHelp();
    case 'menu':
      menu.hidden = !menu.hidden;
      return;
    case 'visit':
      location.hash = '#/view/' + (state.photos[0] && state.photos[0].id);
      return;
    case 'view':
      location.hash = '#/view/' + p.id;
      return;
    case 'edit':
      location.hash = '#/edit/' + p.id;
      return;
    case 'retry':
      return requeue(p);
    case 'jpeg': {
      const b = await db.getBlob(p.id + ':out');
      if (b) download(b, p.name + '.jpg');
      return;
    }
    case 'delete':
      if (!confirm(`Supprimer « ${p.name} » et ses liens ?`)) return;
      await db.deletePhoto(p.id);
      return refresh();
    case 'export-tour':
      return exportTourDialog();
    case 'export-zip': {
      const b = busy('Export des JPEG');
      try {
        download(await exportJpegZip(state.photos.filter((x) => x.status === 'done'), b.update), 'photospheres.zip');
      } catch (e) {
        toast(e.message, true);
      }
      return b.close();
    }
    case 'export-project': {
      const b = busy('Sauvegarde du projet');
      try {
        download(await exportProject(state.photos, b.update), `photosphere-projet-${new Date().toISOString().slice(0, 10)}.zip`);
      } catch (e) {
        toast(e.message, true);
      }
      return b.close();
    }
  }
}

document.addEventListener('click', (e) => {
  const menu = app.querySelector('.menu-list');
  if (menu && !menu.hidden && !e.target.closest('.menu')) menu.hidden = true;
});

function exportTourDialog() {
  const ready = state.photos.filter((p) => p.status === 'done');
  if (!ready.length) return toast('Aucune photo convertie pour le moment.', true);
  dialog(
    `<h2>Visite autonome</h2>
    <p>Crée un fichier <b>.html</b> unique contenant toutes les photos converties et leurs liens. Il s’ouvre dans n’importe quel navigateur (smartphone à bout de bras, casque VR, ordinateur), même sans connexion.</p>
    <label class="field">Titre<input type="text" name="title" value="Ma visite 360°"></label>
    <label class="field">Photo de départ<select name="start">${ready.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select></label>
    <label class="field">Résolution des photos dans la visite<select name="width">
      <option value="4096" selected>4096 × 2048 (recommandé, compatible tous smartphones)</option>
      <option value="6144">6144 × 3072 (plus net, fichier plus lourd)</option>
      <option value="${state.settings.outWidth}">${state.settings.outWidth} × ${state.settings.outWidth / 2} (pleine résolution)</option>
    </select></label>
    <div class="row"><button class="btn" data-close>Annuler</button><button class="btn primary" data-go>Créer la visite</button></div>`,
    (d) => {
      d.querySelector('[data-go]').addEventListener('click', async () => {
        const title = d.querySelector('[name=title]').value.trim() || 'Visite 360°';
        const startId = d.querySelector('[name=start]').value;
        const maxWidth = +d.querySelector('[name=width]').value;
        d.close();
        const b = busy('Création de la visite');
        try {
          const blob = await exportTourHtml(ready, { title, startId, maxWidth, onProgress: b.update });
          download(blob, title.replace(/[\\/:*?"<>|]+/g, '_') + '.html');
        } catch (e) {
          toast(e.message, true);
        }
        b.close();
      });
    }
  );
}

function showWirelessHelp() {
  dialog(`<h2>Récupérer les photos sans fil</h2>
    <p>La Gear 360 utilise le <b>Bluetooth</b> uniquement pour l’appairage et la télécommande ; les photos sont ensuite transférées par <b>Wi-Fi Direct</b> avec un protocole propriétaire Samsung, auquel un navigateur web n’a pas accès.</p>
    <p>Deux solutions fiables :</p>
    <ol>
      <li><b>Carte micro SD</b> : insérez-la dans l’ordinateur (ou dans le téléphone via un lecteur USB-OTG), puis « Importer » et choisissez les fichiers du dossier <code>DCIM/100PHOTO</code>. C’est la meilleure qualité (photos brutes double fisheye, assemblées ici).</li>
      <li><b>Application Samsung Gear 360</b> sur le téléphone : appairez la caméra en Bluetooth, transférez les photos (elles arrivent dans la galerie), puis « Importer des photos » depuis la galerie. PhotoSphère reconnaît les photos déjà assemblées et les met au format 7776 × 3888.</li>
    </ol>
    <div class="row"><button class="btn primary" data-close>Compris</button></div>`);
}

function showHelp() {
  dialog(`<h2>Mode d’emploi</h2>
    <ol>
      <li><b>Importer</b> les photos (carte SD ou galerie). Les doubles fisheye de la Gear 360 sont détectés et assemblés automatiquement en 7776 × 3888, avec les métadonnées « photosphère » (Google Photos, Facebook, VR…).</li>
      <li><b>Éditer</b> une photo pour la <b>redresser</b> si la caméra n’était pas verticale : curseurs, ou cliquez deux points de l’horizon, ou deux lignes verticales (angles de murs, poteaux). La grille aide à vérifier.</li>
      <li>Dans l’onglet <b>Liens</b>, touchez l’endroit (porte, chemin…) qui mène à une autre photo. Le lien retour peut être créé automatiquement.</li>
      <li><b>Visiter</b> : mode <i>Tactile</i> (doigt/souris), <i>Bout de bras</i> (bougez le téléphone), <i>Casque VR</i> (écran partagé pour casque type Cardboard : fixez un lien pendant 1,5 s pour y aller, ou appuyez sur le bouton du casque).</li>
      <li><b>Exporter</b> une visite autonome (.html), les JPEG, ou une sauvegarde pour passer sur le téléphone.</li>
    </ol>
    <p class="note">Sur smartphone, ajoutez PhotoSphère à l’écran d’accueil pour l’utiliser en plein écran et hors connexion. Les photos restent stockées sur l’appareil.</p>
    <div class="row"><button class="btn primary" data-close>Fermer</button></div>`);
}

async function showSettings() {
  const est = await db.storageEstimate();
  const mb = (n) => (n / 1048576).toFixed(0) + ' Mo';
  dialog(
    `<h2>Réglages</h2>
    <label class="field">Taille des photos converties<select name="outWidth">
      ${[7776, 5472, 4096].map((w) => `<option value="${w}" ${w === state.settings.outWidth ? 'selected' : ''}>${w} × ${w / 2}${w === 7776 ? ' (Gear 360, recommandé)' : ''}</option>`).join('')}
    </select></label>
    <label class="field">Qualité JPEG : <output>${state.settings.quality}</output><input type="range" name="quality" min="75" max="100" value="${state.settings.quality}"></label>
    ${est ? `<p class="note">Stockage utilisé : ${mb(est.usage || 0)} sur ${mb(est.quota || 0)} disponibles.</p>` : ''}
    <label class="check"><input type="checkbox" name="reconvert"> Reconvertir toutes les photos avec ces réglages</label>
    <div class="row"><button class="btn" data-close>Annuler</button><button class="btn primary" data-save>Enregistrer</button></div>`,
    (d) => {
      const q = d.querySelector('[name=quality]');
      q.addEventListener('input', () => (q.previousElementSibling.textContent = q.value));
      d.querySelector('[data-save]').addEventListener('click', async () => {
        state.settings = { outWidth: +d.querySelector('[name=outWidth]').value, quality: +q.value };
        await db.putSetting('app', state.settings);
        if (d.querySelector('[name=reconvert]').checked) {
          for (const p of await db.listPhotos()) await db.putPhoto({ ...p, status: 'pending' });
        }
        d.close();
        await refresh();
        processQueue();
      });
    }
  );
}

document.getElementById('btn-help').addEventListener('click', showHelp);
document.getElementById('btn-settings').addEventListener('click', showSettings);

// ---------- visionneuse et éditeur ----------
let active = null; // { dispose }

async function photoSources(photos) {
  const urls = [];
  const list = [];
  for (const p of photos) {
    const out = p.status === 'done' ? await db.getBlob(p.id + ':out') : null;
    const blob = out || (await db.getBlob(p.id + ':orig'));
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    urls.push(url);
    list.push({
      id: p.id,
      name: p.name,
      src: url,
      srcType: out ? 'equirect' : p.srcType,
      params: out ? {} : p.params,
      hotspots: p.hotspots || [],
    });
  }
  return { list, revoke: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

async function openViewer(id) {
  state.view = 'viewer';
  app.innerHTML = '';
  const { list, revoke } = await photoSources(state.photos);
  if (!list.length) {
    location.hash = '#/';
    return;
  }
  try {
    const player = createPlayer(document.body, {
      photos: list,
      startId: id,
      title: 'PhotoSphère',
      onExit: () => (location.hash = '#/'),
    });
    active = {
      dispose() {
        player.dispose();
        revoke();
      },
    };
  } catch (e) {
    revoke();
    toast(e.message, true);
    location.hash = '#/';
  }
}

async function openEditorView(id) {
  const photo = await db.getPhoto(id);
  if (!photo) {
    location.hash = '#/';
    return;
  }
  state.view = 'editor';
  app.innerHTML = '';
  try {
    active = await openEditor(app, photo, {
      photos: state.photos,
      onDone: async (changed) => {
        location.hash = '#/';
        await refresh();
        if (changed) processQueue();
      },
    });
  } catch (e) {
    toast(e.message, true);
    location.hash = '#/';
  }
}

async function route() {
  if (active) {
    const a = active;
    active = null;
    await a.dispose();
  }
  const m = location.hash.match(/^#\/(view|edit)\/(.+)$/);
  await refresh();
  if (m && m[1] === 'view') return openViewer(m[2]);
  if (m && m[1] === 'edit') return openEditorView(m[2]);
  state.view = 'library';
  renderLibrary();
}

window.addEventListener('hashchange', route);

(async function start() {
  state.settings = { ...state.settings, ...((await db.getSetting('app')) || {}) };
  // Une conversion interrompue (fermeture de l'onglet) est relancée.
  await route();
  processQueue();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
