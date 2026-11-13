// Application PhotoSphère : bibliothèque, file de conversion, navigation.
import * as db from './db.js';
import { importFiles, convertPhoto } from './importer.js';
import { createPlayer } from './player.js';
import { openEditor } from './editor.js';
import { openPlan } from './plan.js';
import * as ws from './workspace.js';
import { exportTourHtml, exportJpegZip, exportProject, importProject } from './tour-export.js';
import { toast, escapeHtml, dialog, matchesSearch } from './ui.js';
import { CALIB_VERSION } from './calibrate.js';
import { reliefKey } from './depth.js';
import { batchAutoLevel, batchRelief } from './batch.js';
import { showManual, manualButton as manualLink, bindManualButtons as bindManualLinks } from './manual.js';
import { openParcours, filesSource } from './parcours.js';
import { RELIEF_DIR, reliefNames } from './relief-files.js';
import { createZip } from './zip.js';
import { isSettingsFile, readSettingsFile, applySettings, settingsBlob, SETTINGS_FILE_NAME } from './settings-file.js';

const app = document.getElementById('app');
const state = {
  photos: [],
  settings: { outWidth: 7776, quality: 92 },
  converting: null,
  progress: 0,
  thumbs: new Map(),
  view: null,
  selected: new Set(), // photos cochées dans la bibliothèque
  lastSelected: null, // dernière photo cochée ou décochée (Maj + clic : toute la plage jusqu'à elle)
  batch: false, // traitement par lot en cours (la conversion attend)
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
// Les conversions ne tournent que sur la bibliothèque : dans la visionneuse ou l'éditeur, elles
// saccaderaient l'affichage et chargeraient la mémoire. Elles reprennent au retour.
const queuePaused = () => state.view !== 'library' || state.batch;

async function processQueue() {
  if (state.converting) return;
  for (;;) {
    if (queuePaused()) break;
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
      }, queuePaused);
    } catch (e) {
      if (e.aborted) {
        state.converting = null;
        break;
      }
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
  // Un fichier de réglages (photosphere.json) importé avec les photos est appliqué après elles.
  const settingsFiles = [...files].filter(isSettingsFile);
  const images = [...files].filter((f) => !isSettingsFile(f));
  const b = busy(images.length ? 'Import des photos' : 'Chargement des réglages');
  try {
    const { added, skipped } = images.length ? await importFiles(images, b.update) : { added: [], skipped: [] };
    let settingsMsg = '';
    for (const f of settingsFiles) {
      const r = await applySettings(await readSettingsFile(f));
      settingsMsg += `Réglages de « ${f.name} » appliqués à ${r.applied} photo(s).`;
      if (r.unmatched.length) settingsMsg += ` ${r.unmatched.length} photo(s) du fichier absente(s) de la bibliothèque (${r.unmatched.slice(0, 3).join(', ')}${r.unmatched.length > 3 ? '…' : ''}).`;
    }
    b.close();
    if (settingsMsg) toast(settingsMsg, false, 8000);
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

const pickPhotos = fileInput({ accept: 'image/jpeg,.jpg,.jpeg,.json,application/json', multiple: '' }, handleFiles);
const pickSettings = fileInput({ accept: '.json,application/json' }, handleFiles);
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
// Parcours partagé : dossier (PC) ou fichiers (smartphone) choisis sur l'appareil, rien n'est importé.
const openParcoursFiles = async (files) => {
  if (!files.length) return;
  try {
    const parcours = await openParcours(document.body, filesSource(files), {
      onExit: () => {
        active = null;
        // On revient à la page du parcours (déjà à cette adresse : on la réaffiche).
        if (location.hash === '#/parcours') openParcoursView();
        else location.hash = '#/parcours';
      },
    });
    active = parcours;
    window.photosphereParcours = parcours; // visite en cours (consultable par les tests)
    app.innerHTML = '';
  } catch (e) {
    toast(e.message, true, 8000);
  }
};
const pickParcoursFolder = fileInput({ webkitdirectory: '', multiple: '' }, openParcoursFiles);
const pickParcoursFiles = fileInput({ multiple: '' }, openParcoursFiles);
document.body.append(pickPhotos, pickFolder, pickProject, pickSettings, pickParcoursFolder, pickParcoursFiles);
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
    <button class="btn" data-act="wireless">📡 Gear 360 sans fil</button>
    ${ws.isSupported() ? `<button class="btn" data-act="workspace" title="Dossier des photos d’origine, avec enregistrement automatique de photosphere.json">${workspaceLabel()}</button>` : ''}`;
}

// ---------- dossier de travail ----------
function workspaceLabel() {
  const s = ws.getStatus();
  if (!s.linked) return '📁 Dossier de travail';
  if (!s.granted) return `📁 Reconnecter « ${escapeHtml(s.name)} »`;
  return `📁 ${escapeHtml(s.name)} ✓`;
}

function refreshWorkspaceButton() {
  const b = app.querySelector('[data-act=workspace]');
  if (b) b.innerHTML = workspaceLabel();
}

async function importFromWorkspace() {
  const files = await ws.listFiles();
  if (!files.length) return toast('Aucune photo JPEG trouvée dans ce dossier.', true);
  await handleFiles(files);
  await ws.saveNow();
}

function showWorkspace() {
  const s = ws.getStatus();
  const saved = s.lastSaved ? s.lastSaved.toLocaleTimeString('fr-FR') : 'pas encore';
  dialog(
    `<h2>Dossier de travail</h2>
    <p>Liez le dossier qui contient vos photos d’origine : PhotoSphère y lit les photos et y enregistre <b>automatiquement</b> le fichier <code>${'photosphere.json'}</code> (redressement, nord, liens, noms, plan) après chaque modification. Les photos elles-mêmes ne sont jamais modifiées.</p>
    ${
      s.linked
        ? `<p>Dossier lié : <b>${escapeHtml(s.name)}</b> — ${s.granted ? `enregistrement automatique actif (dernier : ${saved})` : 'accès à reconfirmer'}.</p>
           ${s.lastError ? `<p class="note">Dernière erreur : ${escapeHtml(s.lastError)}</p>` : ''}
           <div class="row" style="justify-content:flex-start">
             ${s.granted ? '<button class="btn" data-ws="import">📥 Importer les photos du dossier</button><button class="btn" data-ws="save">💾 Enregistrer maintenant</button>' : '<button class="btn primary" data-ws="reconnect">🔓 Reconnecter</button>'}
             <button class="btn danger" data-ws="unlink">Délier</button>
           </div>`
        : '<div class="row" style="justify-content:flex-start"><button class="btn primary" data-ws="link">📁 Choisir le dossier des photos</button></div>'
    }
    <p class="note">Disponible sur PC avec Chrome ou Edge. Le renommage des fichiers sur le disque se règle dans ⚙ Réglages.</p>
    <div class="row"><button class="btn" data-close>Fermer</button></div>`,
    (d) => {
      d.querySelectorAll('[data-ws]').forEach((b) =>
        b.addEventListener('click', async () => {
          const act = b.dataset.ws;
          try {
            if (act === 'link') {
              await ws.link();
              d.close();
              await importFromWorkspace();
            } else if (act === 'reconnect') {
              await ws.reconnect();
              d.close();
              if (ws.getStatus().granted) await importFromWorkspace();
            } else if (act === 'import') {
              d.close();
              await importFromWorkspace();
            } else if (act === 'save') {
              const ok = await ws.saveNow();
              toast(ok ? 'photosphere.json enregistré dans le dossier.' : 'Enregistrement impossible : ' + ws.getStatus().lastError, !ok);
              d.close();
            } else if (act === 'unlink') {
              await ws.unlink();
              d.close();
            }
          } catch (e) {
            if (e.name !== 'AbortError') toast(e.message, true);
          }
          refreshWorkspaceButton();
        })
      );
    }
  );
}

// Option : le fichier d'origine prend le nouveau nom de la photo (dossier de travail).
async function syncFileName(id, name) {
  if (!state.settings.renameFiles || !ws.getStatus().granted) return;
  const cur = await db.getPhoto(id);
  if (!cur) return;
  try {
    const file = await ws.renameFile(cur.fileName, name);
    if (file) {
      await db.updatePhoto(id, (c) => ({ ...c, fileName: file }));
      toast(`Fichier renommé sur le disque : ${file}`);
    }
  } catch (e) {
    toast('Fichier non renommé : ' + e.message, true);
  }
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
      <button class="btn" data-act="restore">♻ Restaurer une sauvegarde</button>
      <button class="btn" data-act="parcours">🔗 Visualiser un parcours partagé</button></div>
    </div></div>`;
    bindLibrary();
    return;
  }
  const links = photos.reduce((s, p) => s + (p.hotspots || []).length, 0);
  app.innerHTML = `<div class="wrap">
    <div class="toolbar">
      ${importButtons()}
      <span class="spacer"></span>
      <button class="btn" data-act="parcours" title="Visualiser un parcours préparé par quelqu’un d’autre (dossier partagé)">🔗 Parcours partagé</button>
      <button class="btn" data-act="plan" title="Plan des photos et de leurs liens">🗺 Plan</button>
      <button class="btn primary" data-act="visit">🥽 Visiter</button>
      <div class="menu">
        <button class="btn" data-act="menu">⬇ Exporter ▾</button>
        <div class="menu-list" hidden>
          <button data-act="export-tour">🌐 Visite autonome (fichier HTML)<small>Un seul fichier à partager : s’ouvre sur smartphone, PC, casque VR</small></button>
          <button data-act="export-zip">🖼 Toutes les photos JPEG (ZIP)<small>${state.settings.outWidth} × ${state.settings.outWidth / 2}, métadonnées photosphère</small></button>
          <button data-act="export-parcours">📦 Parcours à partager (réglages + reliefs, ZIP)<small>À décompresser dans le dossier des photos d’origine (OneDrive…) : on le visualise ensuite avec « Parcours partagé »</small></button>
          <button data-act="export-settings">📝 Exporter les réglages (${SETTINGS_FILE_NAME})<small>Fichier léger à ranger avec vos photos d’origine : réimportez le dossier pour tout retrouver</small></button>
          <button data-act="load-settings">📂 Charger des réglages (${SETTINGS_FILE_NAME})<small>Applique un fichier de réglages aux photos déjà importées</small></button>
          <button data-act="export-project">💾 Sauvegarder le projet complet (ZIP)<small>Photos comprises : volumineux, pour transférer vers un autre appareil</small></button>
          <button data-act="restore">♻ Restaurer une sauvegarde</button>
        </div>
      </div>
    </div>
    <div class="library-search">
      <input type="search" class="search-input" name="library-search" placeholder="🔍 Rechercher une photo par son nom" value="${escapeHtml(state.search || '')}" autocomplete="off">
      <span class="note search-count"></span>
    </div>
    <div class="selection-bar">
      <span class="note">${photos.length} photo(s), ${links} lien(s)</span>
      <button class="btn small" data-act="select-all" title="Cocher toutes les photos affichées">☑ Tout sélectionner</button>
      <span class="selection-actions" hidden>
        <b class="selection-count"></b>
        <button class="btn small" data-act="select-none">Aucune</button>
        <button class="btn small primary" data-act="batch-level" title="Redresser automatiquement les photos cochées d’après leurs verticales (celles déjà redressées sont ignorées)">✨ Redresser (auto)</button>
        <button class="btn small primary" data-act="batch-relief" title="Calculer le relief (IA) des photos cochées">🧠 Calculer le relief</button>
        <button class="btn small danger" data-act="batch-delete">🗑 Supprimer</button>
      </span>
    </div>
    <div class="grid">${photos
      .map(
        (p) => `<div class="card${state.selected.has(p.id) ? ' selected' : ''}" data-id="${p.id}" data-search="${escapeHtml(p.name + ' ' + (p.fileName || ''))}">
        <label class="card-select" title="Sélectionner"><input type="checkbox" data-select ${state.selected.has(p.id) ? 'checked' : ''}></label>
        <div class="thumb" data-act="view"><img alt="" loading="lazy">
          <div class="badges"><span class="badge">${p.srcType === 'fisheye' ? 'Double fisheye' : 'Équirectangulaire'}</span>${statusBadge(p)}
          ${(p.hotspots || []).length ? `<span class="badge">🔗 ${p.hotspots.length}</span>` : ''}
          ${p.relief && p.relief.kind === 'ai' && p.relief.key === reliefKey(p.params) ? '<span class="badge" title="Relief calculé">🧊 Relief</span>' : ''}</div>
          <div class="progress" style="width:${state.converting === p.id ? Math.round(state.progress * 100) : 0}%"></div>
        </div>
        <div class="card-body">
          <div class="card-title" data-act="rename" title="Cliquer pour renommer">${escapeHtml(p.name)} <span class="rename-icon">✏</span></div>
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

// Renommage directement sur la carte : Entrée valide, Échap annule.
function renamePhoto(p, titleEl) {
  if (titleEl.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = p.name;
  input.setAttribute('aria-label', 'Nom de la photo');
  titleEl.replaceChildren(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (save && name && name !== p.name) {
      const cur = await db.getPhoto(p.id);
      if (cur) await db.putPhoto({ ...cur, name });
      await syncFileName(p.id, name);
    }
    await refresh();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Filtre les cartes sans reconstruire la page (le champ de recherche garde la main).
function applyLibrarySearch() {
  const cards = [...app.querySelectorAll('.card')];
  let n = 0;
  cards.forEach((c) => {
    const ok = matchesSearch(state.search, c.dataset.search);
    c.hidden = !ok;
    n += ok;
  });
  const count = app.querySelector('.search-count');
  if (count) count.textContent = state.search ? `${n} photo(s) trouvée(s) sur ${cards.length}` : '';
}

// Barre de sélection : nombre de photos cochées et actions groupées.
function updateSelectionBar() {
  const ids = new Set(state.photos.map((p) => p.id));
  [...state.selected].forEach((id) => ids.has(id) || state.selected.delete(id));
  const bar = app.querySelector('.selection-actions');
  if (!bar) return;
  bar.hidden = !state.selected.size;
  bar.querySelector('.selection-count').textContent = `${state.selected.size} sélectionnée(s)`;
  app.querySelectorAll('.card').forEach((c) => {
    const on = state.selected.has(c.dataset.id);
    c.classList.toggle('selected', on);
    c.querySelector('[data-select]').checked = on;
  });
}

// Coche (ou décoche) une photo ; avec Maj, toutes les photos affichées entre la précédente et celle-ci.
function selectPhoto(id, on, range) {
  const ids = [...app.querySelectorAll('.card:not([hidden])')].map((c) => c.dataset.id);
  const a = ids.indexOf(state.lastSelected), b = ids.indexOf(id);
  const span = range && a >= 0 && b >= 0 ? ids.slice(Math.min(a, b), Math.max(a, b) + 1) : [id];
  span.forEach((x) => (on ? state.selected.add(x) : state.selected.delete(x)));
  state.lastSelected = id;
  updateSelectionBar();
}

// Traitement par lot avec progression et bouton d'arrêt, puis bilan.
async function runBatch(title, fn) {
  const ids = state.photos.filter((p) => state.selected.has(p.id)).map((p) => p.id);
  if (!ids.length) return;
  let cancelled = false;
  const d = dialog(`<h2>${escapeHtml(title)}</h2><p class="busy-msg">…</p><progress max="1" value="0" style="width:100%"></progress>
    <div class="row"><button class="btn" data-stop>Arrêter après cette photo</button></div>`);
  d.addEventListener('cancel', (e) => e.preventDefault());
  d.querySelector('[data-stop]').addEventListener('click', (e) => {
    cancelled = true;
    e.target.disabled = true;
    e.target.textContent = 'Arrêt demandé…';
  });
  state.batch = true;
  let results = [];
  try {
    results = await fn(ids, {
      isCancelled: () => cancelled,
      onProgress: (i, n, name, detail) => {
        d.querySelector('progress').value = n ? i / n : 0;
        d.querySelector('.busy-msg').textContent = `${i + 1} / ${n} — ${name}${detail ? ' : ' + detail : ''}`;
      },
    });
  } catch (e) {
    toast(e.message, true);
  }
  state.batch = false;
  d.close();
  await refresh();
  processQueue();
  const ok = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  dialog(`<h2>${escapeHtml(title)} : ${ok} / ${results.length - skipped} réussie(s)${skipped ? `, ${skipped} ignorée(s)` : ''}</h2>
    <ul class="batch-report">${results.map((r) => `<li class="${r.skipped ? 'skip' : r.ok ? 'ok' : 'ko'}">${r.skipped ? '–' : r.ok ? '✔' : '✘'} <b>${escapeHtml(r.name)}</b> : ${escapeHtml(r.message)}</li>`).join('')}</ul>
    ${cancelled ? '<p class="note">Arrêté avant la fin.</p>' : ''}
    <div class="row"><button class="btn primary" data-close>Fermer</button></div>`);
}

function bindLibrary() {
  app.querySelectorAll('[data-select]').forEach((cb) =>
    cb.addEventListener('click', (e) => selectPhoto(cb.closest('.card').dataset.id, cb.checked, e.shiftKey))
  );
  updateSelectionBar();
  const search = app.querySelector('[name=library-search]');
  if (search) {
    search.addEventListener('input', () => {
      state.search = search.value;
      applyLibrarySearch();
    });
    applyLibrarySearch();
  }
  app.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', (e) => {
      const card = b.closest('.card');
      const p = card && state.photos.find((x) => x.id === card.dataset.id);
      // Maj + clic (plage) ou Ctrl + clic sur une vignette : sélection, sans ouvrir la photo.
      if (p && b.classList.contains('thumb') && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        return selectPhoto(p.id, e.shiftKey ? true : !state.selected.has(p.id), e.shiftKey);
      }
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
    case 'workspace':
      if (ws.getStatus().linked && !ws.getStatus().granted) {
        await ws.reconnect();
        refreshWorkspaceButton();
        if (ws.getStatus().granted) await importFromWorkspace();
        return;
      }
      return showWorkspace();
    case 'wireless':
      return showWirelessHelp();
    case 'menu':
      menu.hidden = !menu.hidden;
      return;
    case 'visit':
      location.hash = '#/view/' + (state.photos[0] && state.photos[0].id);
      return;
    case 'plan':
      location.hash = '#/plan';
      return;
    case 'parcours':
      location.hash = '#/parcours';
      return;
    case 'export-parcours':
      return exportParcours();
    case 'view':
      location.hash = '#/view/' + p.id;
      return;
    case 'rename':
      return renamePhoto(p, el);
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
      state.selected.delete(p.id);
      return refresh();
    case 'select-all':
      app.querySelectorAll('.card:not([hidden])').forEach((c) => state.selected.add(c.dataset.id));
      return updateSelectionBar();
    case 'select-none':
      state.selected.clear();
      return updateSelectionBar();
    case 'batch-level':
      return runBatch('Redressement automatique', batchAutoLevel);
    case 'batch-relief':
      return runBatch('Calcul du relief (IA)', batchRelief);
    case 'batch-delete': {
      const n = state.selected.size;
      if (!n || !confirm(`Supprimer ${n} photo(s) et leurs liens ?`)) return;
      for (const id of [...state.selected]) await db.deletePhoto(id);
      state.selected.clear();
      return refresh();
    }
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
    case 'export-settings':
      download(settingsBlob(state.photos, await db.getPlanDrawing()), SETTINGS_FILE_NAME);
      toast(`Rangez « ${SETTINGS_FILE_NAME} » dans le dossier de vos photos d’origine. Pour tout retrouver, importez ce dossier (ou les photos avec ce fichier).`, false, 9000);
      return;
    case 'load-settings':
      return pickSettings.click();
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

async function showSettings() {
  const est = await db.storageEstimate();
  const mb = (n) => (n / 1048576).toFixed(0) + ' Mo';
  dialog(
    `<h2>Réglages</h2>
    <label class="field">Taille des photos converties<select name="outWidth">
      ${[7776, 7200, 5472, 4096].map((w) => `<option value="${w}" ${w === state.settings.outWidth ? 'selected' : ''}>${w} × ${w / 2}${{ 7776: ' (pleine résolution Gear 360)', 7200: ' (comme le logiciel Samsung)' }[w] || ''}</option>`).join('')}
    </select></label>
    <label class="field">Qualité JPEG : <output>${state.settings.quality}</output><input type="range" name="quality" min="75" max="100" value="${state.settings.quality}"></label>
    ${est ? `<p class="note">Stockage utilisé : ${mb(est.usage || 0)} sur ${mb(est.quota || 0)} disponibles.</p>` : ''}
    ${ws.isSupported() ? `<label class="check"><input type="checkbox" name="renameFiles" ${state.settings.renameFiles ? 'checked' : ''}> Quand je renomme une photo, renommer aussi son fichier dans le dossier de travail</label>` : ''}
    <label class="check"><input type="checkbox" name="reconvert"> Reconvertir toutes les photos avec ces réglages</label>
    <div class="row"><button class="btn" data-close>Annuler</button><button class="btn primary" data-save>Enregistrer</button></div>`,
    (d) => {
      const q = d.querySelector('[name=quality]');
      q.addEventListener('input', () => (q.previousElementSibling.textContent = q.value));
      d.querySelector('[data-save]').addEventListener('click', async () => {
        const rf = d.querySelector('[name=renameFiles]');
        state.settings = { outWidth: +d.querySelector('[name=outWidth]').value, quality: +q.value, renameFiles: rf ? rf.checked : !!state.settings.renameFiles };
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

document.getElementById('btn-help').addEventListener('click', () => showManual());
document.getElementById('btn-settings').addEventListener('click', showSettings);

// ---------- visionneuse et éditeur ----------
let active = null; // { dispose }
// Numéro de la navigation en cours : une vue qui finit de se charger après une navigation plus
// récente (clic rapide sur « Annuler », flèches…) est refermée aussitôt au lieu de rester active.
let routeGen = 0;
const stale = (gen) => gen !== routeGen;

async function photoSources(photos) {
  const urls = [];
  const list = [];
  for (const p of photos) {
    const out = p.status === 'done' ? await db.getBlob(p.id + ':out') : null;
    const blob = out || (await db.getBlob(p.id + ':orig'));
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const depth = p.relief && p.relief.kind === 'ai' ? await db.getBlob(p.id + ':depth') : null;
    const depthSrc = depth ? URL.createObjectURL(depth) : null;
    if (depthSrc) urls.push(depthSrc);
    const depthBg = depth ? await db.getBlob(p.id + ':depthbg') : null;
    const depthBgSrc = depthBg ? URL.createObjectURL(depthBg) : null;
    if (depthBgSrc) urls.push(depthBgSrc);
    list.push({
      id: p.id,
      name: p.name,
      fileName: p.fileName,
      src: url,
      srcType: out ? 'equirect' : p.srcType,
      params: out ? {} : p.params,
      hotspots: p.hotspots || [],
      relief: p.relief || null,
      reliefKey: reliefKey(p.params),
      depthSrc,
      depthBgSrc,
    });
  }
  return { list, revoke: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

async function openViewer(id, gen = routeGen) {
  state.view = 'viewer';
  app.innerHTML = '';
  const { list, revoke } = await photoSources(state.photos);
  if (stale(gen)) return revoke();
  if (!list.length) {
    location.hash = '#/';
    return;
  }
  try {
    const player = createPlayer(document.body, {
      photos: list,
      startId: id,
      title: 'PhotoSphère',
      initialView: state.lastView,
      onExit: () => (location.hash = state.origin === 'plan' ? '#/plan' : '#/'),
      onEdit: (photoId, view) => {
        state.lastView = view;
        state.returnToViewer = true;
        location.hash = '#/edit/' + photoId;
      },
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

async function openEditorView(id, gen = routeGen) {
  const photo = await db.getPhoto(id);
  if (stale(gen)) return;
  if (!photo) {
    location.hash = '#/';
    return;
  }
  state.view = 'editor';
  app.innerHTML = '';
  try {
    const fromViewer = state.returnToViewer;
    const navigated = state.editorNav;
    const focus = state.editorFocus;
    state.returnToViewer = false;
    state.editorNav = false;
    state.editorFocus = null;
    const editor = await openEditor(app, photo, {
      photos: state.photos,
      onRenamed: syncFileName,
      initialView: fromViewer || navigated ? state.lastView : null,
      focus,
      onOpenPhoto: (otherId, view, focusOpt) => {
        state.lastView = view;
        state.returnToViewer = fromViewer;
        state.editorNav = true;
        state.editorFocus = focusOpt || null;
        location.hash = '#/edit/' + otherId;
      },
      onNavigate: (dir, view) => {
        const list = state.photos;
        const i = list.findIndex((x) => x.id === id);
        const next = list[(i + dir + list.length) % list.length];
        state.lastView = view;
        state.returnToViewer = fromViewer;
        state.editorNav = true;
        location.hash = '#/edit/' + next.id;
      },
      onDone: async (changed, view) => {
        // Retour là d'où l'on vient : la visionneuse (même photo, même direction) ou la bibliothèque.
        if (fromViewer) {
          state.lastView = view;
          location.hash = '#/view/' + id;
        } else location.hash = state.origin === 'plan' ? '#/plan' : '#/';
      },
    });
    if (stale(gen)) await editor.dispose();
    else active = editor;
  } catch (e) {
    toast(e.message, true);
    location.hash = '#/';
  }
}

// Plan des photos : on peut y ouvrir une photo, et l'on y revient en quittant la visionneuse / l'éditeur.
// Parcours à partager : photosphere.json et cartes de relief, dans un ZIP à décompresser à côté des
// photos d'origine (le dossier de travail les y range déjà tout seul).
async function exportParcours() {
  const b = busy('Préparation du parcours');
  try {
    const photos = await db.listPhotos();
    const files = [{ name: SETTINGS_FILE_NAME, data: settingsBlob(photos, await db.getPlanDrawing()) }];
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      b.update(i, photos.length, p.name);
      if (!p.relief || p.relief.kind !== 'ai' || p.relief.key !== reliefKey(p.params) || !p.fileName) continue;
      const names = reliefNames(p.fileName);
      const depth = await db.getBlob(p.id + ':depth'), bg = await db.getBlob(p.id + ':depthbg');
      if (depth) files.push({ name: `${RELIEF_DIR}/${names.depth}`, data: depth });
      if (bg) files.push({ name: `${RELIEF_DIR}/${names.bg}`, data: bg });
    }
    download(await createZip(files), 'parcours-photosphere.zip');
    toast('Décompressez ce ZIP dans le dossier des photos d’origine (à côté des photos).', false, 8000);
  } catch (e) {
    toast(e.message, true);
  }
  b.close();
}

// Page « Visualiser un parcours partagé ».
function openParcoursView() {
  state.view = 'parcours';
  app.innerHTML = `<div class="wrap parcours-page">
    <h2>🔗 Visualiser un parcours partagé</h2>
    <p>Un parcours, c’est le dossier des <b>photos d’origine</b> avec son fichier <code>${SETTINGS_FILE_NAME}</code> (et le sous-dossier <code>${RELIEF_DIR}</code> pour le relief), préparé avec PhotoSphère sur PC. Les photos sont lues à la demande, en pleine définition, et <b>ne sont pas enregistrées</b> sur cet appareil.</p>
    <div class="toolbar">
      ${supportsFolder ? '<button class="btn primary" data-parcours-folder>📂 Choisir le dossier</button>' : ''}
      <button class="btn ${supportsFolder ? '' : 'primary'}" data-parcours-files>🖼 Choisir les fichiers</button>
      <button class="btn" data-parcours-back>← Bibliothèque</button>
    </div>
    <p class="note">Sur smartphone : « Choisir les fichiers », allez dans le dossier (OneDrive, Google Drive, carte SD…) et sélectionnez <b>toutes</b> les photos et <code>${SETTINGS_FILE_NAME}</code>, ainsi que le contenu de <code>${RELIEF_DIR}</code> pour le relief.</p>
    <p class="note">Bientôt : ouvrir directement un lien de dossier OneDrive partagé (connexion avec un compte Microsoft). ${manualLink('parcours')}</p>
  </div>`;
  const on = (sel, fn) => {
    const el = app.querySelector(sel);
    if (el) el.addEventListener('click', fn);
  };
  on('[data-parcours-folder]', () => pickParcoursFolder.click());
  on('[data-parcours-files]', () => pickParcoursFiles.click());
  on('[data-parcours-back]', () => (location.hash = '#/'));
  bindManualLinks(app);
}

async function openPlanView(gen = routeGen) {
  state.view = 'plan';
  state.origin = 'plan';
  app.innerHTML = '';
  if (!state.photos.length) {
    location.hash = '#/';
    return;
  }
  const plan = await openPlan(app, {
    photos: state.photos,
    onOpen: (id, mode) => (location.hash = (mode === 'edit' ? '#/edit/' : '#/view/') + id),
    // Renommage depuis le plan : comme dans la bibliothèque (fichier renommé aussi si l'option est active).
    onRename: async (id, name) => {
      await db.updatePhoto(id, (cur) => ({ ...cur, name }));
      await syncFileName(id, name);
    },
  });
  if (stale(gen)) plan.dispose();
  else active = plan;
}

async function route() {
  const gen = ++routeGen;
  const m = location.hash.match(/^#\/(view|edit)\/(.+)$/);
  const isPlan = location.hash === '#/plan';
  const isParcours = location.hash === '#/parcours';
  // Fixé tout de suite : une conversion en cours s'interrompt dès qu'on ouvre une photo ou le plan.
  state.view = m ? (m[1] === 'view' ? 'viewer' : 'editor') : isPlan ? 'plan' : isParcours ? 'parcours' : 'library';
  if (active) {
    const a = active;
    active = null;
    await a.dispose();
  }
  await refresh();
  if (stale(gen)) return;
  if (m && m[1] === 'view') return openViewer(m[2], gen);
  if (m && m[1] === 'edit') return openEditorView(m[2], gen);
  if (isPlan) return openPlanView(gen);
  if (isParcours) return openParcoursView();
  state.origin = 'library';
  renderLibrary();
  processQueue();
}

window.addEventListener('hashchange', route);

// Photos double fisheye importées avec la première version : nouvelle orientation (comme Samsung,
// centre = moitié droite), redressement et liens convertis, puis recalibrage et reconversion.
async function migratePhotos() {
  let n = 0;
  for (const p of await db.listPhotos()) {
    if (p.srcType !== 'fisheye') continue;
    if (p.layout === 2) {
      // Calibrage d'une version précédente : refait (couture et parallaxe plus fines).
      if (p.params.autoCalibrated && p.params.calibVersion !== CALIB_VERSION) {
        await db.putPhoto({ ...p, status: 'pending' });
        n++;
      }
      continue;
    }
    const params = { ...p.params, pitch: -(p.params.pitch || 0), roll: -(p.params.roll || 0) };
    delete params.autoCalibrated;
    const hotspots = (p.hotspots || []).map((h) => ({ ...h, yaw: ((h.yaw + 360) % 360) - 180 }));
    await db.putPhoto({ ...p, params, hotspots, layout: 2, status: 'pending' });
    n++;
  }
  if (n) toast(`${n} photo(s) recalibrée(s) avec le nouvel assemblage…`);
}

(async function start() {
  state.settings = { ...state.settings, ...((await db.getSetting('app')) || {}) };
  await migratePhotos();
  await ws.init();
  ws.onStatus(refreshWorkspaceButton);
  // Une conversion interrompue (fermeture de l'onglet) est relancée.
  await route();
  processQueue();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
