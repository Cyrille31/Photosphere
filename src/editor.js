// Éditeur : redressement (verticalité), calibrage des objectifs fisheye, liens entre photos.
import * as db from './db.js';
import { PanoRenderer } from './renderer.js';
import { ViewController } from './controls.js';
import { DEFAULT_LENS_PARAMS } from './gl-source.js';
import { calibrateFromBlob } from './importer.js';
import { DEG, dirFromLonLat, lonLatFromDir, upFromHorizon, upFromVerticals, applyUpCorrection, remapHotspot, wrapDeg, levelToViewTilt, viewTiltToLevel, withCap, cameraMatrix, levelMatrix, mat3Apply, vecDot } from './math.js';
import { autoLevel } from './autolevel.js';
import { edgeMap, fitCeilingRect, cornersFromFit, rectFromPoints, rectDistance, cornerXZ, photoRoom, guessRoomName } from './room.js';
import { reliefKey, depthAt, loadDepthImage, loadImageBitmap } from './depth.js';
import { computeDepth } from './depth-ai.js';
import { toast, escapeHtml, dialog } from './ui.js';
import { manualButton, bindManualButtons } from './manual.js';
import { pickPhoto } from './photo-picker.js';
import { chooseArrivalView } from './arrival-view.js';
import { newId } from './importer.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

// Points cardinaux affichés sur l'horizon : par convention, le nord est la longitude 0 de la photo
// corrigée (le centre de l'image à plat), l'est à droite.
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

function slider(name, label, min, max, step) {
  return `<label class="slider"><span>${label}</span>
    <input type="range" name="${name}" min="${min}" max="${max}" step="${step}">
    <input type="number" name="${name}" min="${min}" max="${max}" step="${step}"></label>`;
}

function lensFields(key, title) {
  return `<fieldset class="lens-group"><legend>${title}</legend>
    ${slider(key + '.cx', 'Centre horizontal', 0.4, 0.6, 0.001)}
    ${slider(key + '.cy', 'Centre vertical', 0.4, 0.6, 0.001)}
    ${slider(key + '.r', 'Rayon du cercle', 0.4, 0.6, 0.001)}
    ${slider(key + '.rot', 'Rotation (°)', -10, 10, 0.05)}
  </fieldset>`;
}

// onNavigate(sens, vue) : passe à la photo précédente (-1) ou suivante (+1), après enregistrement.
// onOpenPhoto(id, vue, focus) : ouvre une autre photo dans l'éditeur (ex. pour régler un lien retour).
// focus.linkTo : à l'ouverture, prépare le déplacement du lien qui pointe vers cette photo.
// onRenamed(id, nom) : appelé après l'enregistrement d'un nouveau nom (renommage du fichier).
export async function openEditor(container, photo, { photos, onDone, onNavigate, onOpenPhoto, onRenamed, initialView, focus }) {
  const p = clone(photo);
  p.params = { yaw: 0, pitch: 0, roll: 0, ...clone(DEFAULT_LENS_PARAMS), ...p.params };
  p.hotspots = p.hotspots || [];
  const others = photos.filter((x) => x.id !== p.id);
  const reverseLinks = []; // { target, yaw, pitch }
  let dirty = false;

  const index = photos.findIndex((x) => x.id === p.id);
  const navButtons =
    onNavigate && photos.length > 1
      ? `<button class="ed-nav prev" data-nav="-1" title="Photo précédente (flèche gauche)" aria-label="Photo précédente">‹</button>
         <button class="ed-nav next" data-nav="1" title="Photo suivante (flèche droite)" aria-label="Photo suivante">›</button>
         <div class="ed-count">${index + 1} / ${photos.length}</div>`
      : '';
  container.innerHTML = `<div class="editor">
    <div class="ed-stage">
      <canvas></canvas>
      <div class="ed-markers"></div>
      <div class="ed-overlay">
        <button class="btn small" data-view="persp">🌐 Vue 360</button>
        <button class="btn small" data-view="flat">🗺 Vue à plat</button>
        <button class="btn small" data-grid>▦ Grille</button>
        <button class="btn small" data-undo disabled title="Défaire la dernière action (Ctrl+Z)">↶ Défaire</button>
      </div>
      <div class="ed-hint" hidden></div>
      ${navButtons}
    </div>
    <aside class="ed-panel">
      <div class="ed-panel-head">
        <input type="text" name="title" value="${escapeHtml(p.name)}" aria-label="Nom de la photo">
        <div class="tabs">
          <button data-tab="level" class="active">Redresser</button>
          <button data-tab="lens">Objectifs</button>
          <button data-tab="links">Liens</button>
          <button data-tab="relief">Relief</button>
          <button data-tab="room">Pièce</button>
        </div>
      </div>
      <div class="ed-body">
        <section data-panel="level">
          <p class="note">La ligne orange (horizon) doit être plate et les verticales droites. ${manualButton('redresser')}</p>
          ${slider('tiltForward', 'Bascule avant / arrière, dans l’axe de la vue (°)', -45, 45, 0.1)}
          ${slider('tiltSide', 'Bascule gauche / droite, dans l’axe de la vue (°)', -45, 45, 0.1)}
          ${slider('cap', 'Cap : rotation horizontale (°)', -180, 180, 0.5)}
          <div class="tools">
            <button class="btn small" data-tool="horizon">📏 Horizon : 2 points</button>
            <button class="btn small primary" data-autolevel title="Redresse la photo d’après les verticales des murs et des meubles">✨ Auto (verticales)</button>
            <button class="btn small" data-tool="verticals">📐 Verticales : 1 ou 2 lignes</button>
            <button class="btn small" data-reset-level>↺ Réinitialiser</button>
          </div>
          <div class="tools">
            <button class="btn small" data-north>🧭 Indiquer le nord</button>
          </div>
          
        </section>
        <section data-panel="lens" hidden>
          <label class="field">Type d’image source
            <select name="srcType">
              <option value="fisheye">Double fisheye (brut Gear 360, carte SD)</option>
              <option value="equirect">Équirectangulaire (déjà assemblée)</option>
            </select></label>
          <div class="fisheye-only">
            ${slider('fov', 'Champ de vision des objectifs (°)', 180, 220, 0.1)}
            ${slider('blend', 'Largeur du fondu de couture (°)', 0.5, 10, 0.1)}
            ${slider('vignette', 'Correction du vignettage (bords plus sombres) : 0 = aucune, 1 = Gear 360', 0, 1.5, 0.05)}
            ${lensFields('lensA', 'Objectif de la moitié gauche')}
            ${lensFields('lensB', 'Objectif de la moitié droite')}
            <div class="tools">
              <button class="btn small primary" data-autodetect>🎯 Calibrage automatique</button>
              <button class="btn small" data-lens-default>⭐ Calibrage par défaut</button>
              <button class="btn small" data-lens-reset>↺ Valeurs d’usine</button>
            </div>
            <p class="note">Calibrage automatique fait à l’import ; relancez-le après une modification. ${manualButton('objectifs')}</p>
          </div>
        </section>
        <section data-panel="room" hidden>
          <p class="note">Les 4 coins du plafond donnent le plan de la pièce et la place de la photo dedans (plan → « 🏠 Placer les pièces »). ${manualButton('piece')}</p>
          <label class="field">Pièce (même nom pour toutes ses photos)<input type="text" name="roomName" list="room-names" placeholder="ex. Salle à manger" autocomplete="off"></label>
          <datalist id="room-names"></datalist>
          <div class="tools">
            <button class="btn small primary" data-room-pick>📐 Cliquer les 4 coins du plafond</button>
            <button class="btn small" data-room-detect title="Proposition automatique d’après la jonction plafond / mur (à vérifier)">✨ Détecter</button>
          </div>
          <div class="tools">
            <button class="btn small" data-room-floor title="Un coin du sol (pied d’un angle de mur) : donne la hauteur de l’appareil">➕ Coin au sol</button>
            <button class="btn small" data-room-clear>✕ Effacer les coins</button>
          </div>
          <label class="field">Hauteur sous plafond, commune à toutes les photos (m)<input type="number" name="ceilingH" min="1.8" max="8" step="0.05"></label>
          <label class="field">Hauteur de l’appareil (m)<input type="number" name="camH" min="0.3" max="3" step="0.05"></label>
          <p class="note room-info"></p>
        </section>
        <section data-panel="relief" hidden>
          <p class="note">Distances estimées par IA pour l’effet 3D dans le casque : <b style="color:#e5484d">proche</b>, <b style="color:#d6b600">moyen</b>, <b style="color:#2fa84f">loin</b>, <b style="color:#3b82f6">très loin</b>. ${manualButton('relief')}</p>
          <div class="tools">
            <button class="btn small primary" data-depth-compute>🧠 Calculer le relief (IA)</button>
            <label class="check"><input type="checkbox" data-depth-view checked> Colorer selon la distance</label>
          </div>
          <p class="note depth-status" hidden></p>
          <label class="slider relief-slider"><span>Hauteur de l’objectif au-dessus du sol (m)</span>
            <input type="range" name="reliefH" min="0.3" max="2.5" step="0.05">
            <input type="number" name="reliefH" min="0.3" max="2.5" step="0.05"></label>
          <p class="note relief-info"></p>
          
        </section>
        <section data-panel="links" hidden>
          <p class="note">Cliquez un lien sur l’image pour le retrouver ici ; <b>Ctrl + glisser</b> pour le déplacer. ${manualButton('liens')}</p>
          <div class="tools"><button class="btn primary small" data-add-link ${others.length ? '' : 'disabled'}>➕ Ajouter un lien</button></div>
          ${others.length ? '' : '<p class="note">Importez d’autres photos pour pouvoir créer des liens.</p>'}
          <div class="links-list"></div>
        </section>
      </div>
      <div class="ed-foot">
        <button class="btn" data-cancel>Annuler</button>
        <button class="btn primary" data-save>✔ Enregistrer</button>
      </div>
    </aside>
  </div>`;

  const $ = (s) => container.querySelector(s);
  const $$ = (s) => [...container.querySelectorAll(s)];
  bindManualButtons(container);
  const stage = $('.ed-stage');
  const canvas = stage.querySelector('canvas');
  const renderer = new PanoRenderer(canvas, {
    maxHalf: matchMedia('(pointer: coarse)').matches ? 2048 : 3072,
    onLost: () => {
      toast('La carte graphique a interrompu l’affichage : rechargement de l’éditeur…', true);
      setTimeout(() => location.reload(), 1500);
    },
  });
  let tool = null; // { kind, points: [] }
  let placing = null; // { kind: 'add' | 'move', index }
  let selLink = -1; // lien sélectionné (touché sur l'image ou dans la liste)
  let grid = true;
  let raf = 0;
  let depthView = true;
  const DEFAULT_CAMERA_HEIGHT = 1.6;
  // Carte de profondeur (IA) : valable pour le redressement actuel, sinon à refaire.
  let depthMaps = null; // { depth, bg } (Float32Array)
  let depthBgImage = null; // couleurs du fond reconstitué
  let depthPng = null, depthBgBlob = null; // nouvelle carte à enregistrer
  let depthBusy = false;
  const currentRelief = () => (p.relief && p.relief.kind === 'ai' && p.relief.key === reliefKey(p.params) && depthMaps ? p.relief : null);
  const reliefTabOpen = () => !$('[data-panel=relief]').hidden;

  const controller = new ViewController(canvas, renderer, {
    onChange: () => {
      redraw();
      syncInputs();
    },
    onTap: (x, y) => onTap(x, y),
  });
  controller.fov = 90;
  if (initialView) {
    controller.yaw = initialView.yaw;
    controller.pitch = initialView.pitch;
  }
  const currentView = () => ({ yaw: controller.yaw, pitch: controller.pitch });

  function redraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const frame = controller.frame();
      renderer.setParams(p.params, p.srcType);
      renderer.setHotspots(p.hotspots);
      const rel = currentRelief();
      renderer.setDepth(rel ? depthMaps.depth : null, rel ? depthMaps.bg : null);
      renderer.setBackgroundColor(rel ? depthBgImage : null);
      renderer.draw({ ...frame, grid, hotSel: selLink, hotSize: controller.mode === 'flat' ? 0.05 : 0.06, depthView: depthView && reliefTabOpen() });
      drawMarkers(frame);
      if (reliefTabOpen()) updateReliefInfo();
    });
  }

  function drawMarkers(frame) {
    const box = $('.ed-markers');
    const dpr = canvas.width / (canvas.clientWidth || 1);
    let html = '';
    const pts = tool ? tool.points : [];
    pts.forEach((d) => {
      const s = renderer.project(d, frame);
      if (s) html += `<div class="ed-marker" style="left:${s.x / dpr}px;top:${s.y / dpr}px"></div>`;
    });
    CARDINALS.forEach((name, k) => {
      const s = renderer.project(dirFromLonLat(k * 45 * DEG, 0), frame);
      if (s) html += `<div class="ed-cardinal${k === 0 ? ' north' : ''}${k % 2 ? ' minor' : ''}" style="left:${s.x / dpr}px;top:${s.y / dpr}px">${name}</div>`;
    });
    p.hotspots.forEach((h) => {
      const s = renderer.project(dirFromLonLat(h.yaw * DEG, h.pitch * DEG), frame);
      const t = photos.find((x) => x.id === h.target);
      if (s) html += `<div class="ed-hot-label" style="left:${s.x / dpr}px;top:${s.y / dpr}px">→ ${escapeHtml(h.label || (t ? t.name : '?'))}</div>`;
    });
    html += roomMarkers(frame, dpr);
    box.innerHTML = html;
  }

  function hint(msg) {
    const h = $('.ed-hint');
    h.hidden = !msg;
    h.innerHTML = msg || '';
    stage.classList.toggle('picking', !!msg);
  }

  // ---------- historique (Défaire) ----------
  // Un instantané est pris avant chaque action ; les réglages continus d'un même curseur sont regroupés.
  const history = [];
  let lastKey = '', lastTime = 0;
  function snapshot(key = '') {
    const now = performance.now();
    if (key && key === lastKey && now - lastTime < 1000) {
      lastTime = now;
      return;
    }
    lastKey = key;
    lastTime = now;
    history.push(clone({ params: p.params, srcType: p.srcType, hotspots: p.hotspots, room: p.room, reverse: reverseLinks.length }));
    if (history.length > 60) history.shift();
    updateUndo();
  }
  function undo() {
    const s = history.pop();
    if (!s) return;
    p.params = s.params;
    p.srcType = s.srcType;
    p.hotspots = s.hotspots;
    p.room = s.room;
    reverseLinks.length = Math.min(reverseLinks.length, s.reverse);
    lastKey = '';
    dirty = true;
    syncInputs();
    renderLinks();
    redraw();
    updateUndo();
  }
  function updateUndo() {
    $('[data-undo]').disabled = !history.length;
  }

  // ---------- redressement ----------
  function setLevel(level, keepHotspots = true) {
    const old = { yaw: p.params.yaw, pitch: p.params.pitch, roll: p.params.roll };
    const next = { yaw: wrapDeg(level.yaw), pitch: level.pitch, roll: level.roll };
    if (keepHotspots) p.hotspots = p.hotspots.map((h) => remapHotspot(h, old, next));
    // Coins de la pièce : ils restent sur les mêmes points de la scène.
    if (p.room) {
      p.room.corners = (p.room.corners || []).map((c) => remapHotspot(c, old, next));
      if (p.room.floor) p.room.floor = remapHotspot(p.room.floor, old, next);
    }
    Object.assign(p.params, next);
    dirty = true;
    syncInputs();
    redraw();
  }

  function startTool(kind) {
    tool = { kind, points: [] };
    $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === kind));
    updateToolHint();
    redraw();
  }

  function stopTool() {
    tool = null;
    $$('[data-tool]').forEach((b) => b.classList.remove('active'));
    hint('');
    redraw();
  }

  function updateToolHint() {
    if (!tool) return;
    const n = tool.points.length;
    const cancel = ' <button class="btn small" data-tool-cancel>Annuler</button>';
    if (tool.kind === 'horizon') hint(`Cliquez le point ${n + 1} / 2 sur l’horizon.` + cancel);
    else {
      const line = Math.floor(n / 2) + 1;
      const which = n % 2 === 0 ? 'le haut' : 'le bas';
      const apply = n === 2 ? ' <button class="btn small primary" data-tool-apply>Appliquer (1 ligne)</button>' : '';
      hint(`Ligne verticale ${line} / 2 : cliquez ${which}.` + apply + cancel);
    }
    const c = $('[data-tool-cancel]');
    if (c) c.addEventListener('click', stopTool);
    const a = $('[data-tool-apply]');
    if (a) a.addEventListener('click', () => applyTool());
  }

  function applyTool() {
    const pts = tool.points;
    let up;
    if (tool.kind === 'horizon') up = upFromHorizon(pts[0], pts[1]);
    else {
      const lines = [[pts[0], pts[1]]];
      if (pts.length >= 4) lines.push([pts[2], pts[3]]);
      up = upFromVerticals(lines);
    }
    if (!up.every(Number.isFinite)) {
      toast('Points trop proches : recommencez avec des points plus éloignés.', true);
    } else {
      const lvl = applyUpCorrection(p.params, up);
      snapshot();
      setLevel({ ...lvl, yaw: p.params.yaw + wrapDeg(lvl.yaw - p.params.yaw) });
      toast('Photo redressée. Vérifiez avec la grille, puis affinez si besoin.');
    }
    stopTool();
  }

  // ---------- clics sur l'image ----------
  function onTap(x, y) {
    const frame = controller.frame();
    const d = renderer.pick(x, y, frame);
    if (!d) return;
    if (roomPick) return roomTap(d);
    if (tool) {
      tool.points.push(d);
      const need = tool.kind === 'horizon' ? 2 : 4;
      if (tool.points.length >= need) applyTool();
      else {
        updateToolHint();
        redraw();
      }
      return;
    }
    if (placing) {
      const { lon, lat } = lonLatFromDir(d);
      const pos = { yaw: lon / DEG, pitch: lat / DEG };
      const kind = placing.kind, index = placing.index, placing_target = placing.target;
      placing = null;
      hint('');
      if (kind === 'north') {
        setNorth(pos.yaw);
      } else if (kind === 'add-to') {
        snapshot();
        p.hotspots.push({ id: newId(), target: placing_target, label: '', ...pos });
        dirty = true;
        renderLinks();
        redraw();
      } else if (kind === 'move') {
        snapshot();
        // Placé à la main : le lien ne suit plus le plan.
        Object.assign(p.hotspots[index], pos, { auto: false });
        dirty = true;
        renderLinks();
        redraw();
      } else chooseTarget(pos);
      return;
    }
    // Lien touché sur l'image : sélectionné, et la liste des liens défile pour le montrer en haut.
    const k = hotspotAt(d);
    if (k >= 0) selectLink(k, true);
  }

  // Indice du lien le plus proche d'une direction (à moins de ~6°), sinon -1.
  function hotspotAt(d) {
    let best = -1, bestAng = 0.11;
    p.hotspots.forEach((h, i) => {
      const ang = Math.acos(Math.max(-1, Math.min(1, vecDot(d, dirFromLonLat(h.yaw * DEG, h.pitch * DEG)))));
      if (ang < bestAng) {
        bestAng = ang;
        best = i;
      }
    });
    return best;
  }

  function selectLink(i, scroll) {
    selLink = i;
    if ($('[data-panel=links]').hidden) $('[data-tab=links]').click();
    $$('.link-item').forEach((el) => el.classList.toggle('active', +el.dataset.i === i));
    const item = $(`.link-item[data-i="${i}"]`);
    if (item && scroll) {
      // La liste (zone qui défile du panneau) amène ce lien tout en haut.
      const body = $('.ed-body');
      const want = body.scrollTop + item.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
      // Lien vers la fin de la liste : un espace sous la liste permet de l'amener quand même en haut.
      const list = $('.links-list');
      const lack = want - (body.scrollHeight - body.clientHeight);
      if (lack > 0) list.style.paddingBottom = (parseFloat(list.style.paddingBottom) || 0) + lack + 'px';
      body.scrollTo({ top: want, behavior: 'smooth' });
    }
    redraw();
  }

  // Ctrl + clic gauche sur un lien de l'image : on le fait glisser à sa nouvelle place.
  stage.addEventListener(
    'pointerdown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0 || tool || placing || e.target !== canvas) return;
      const r = canvas.getBoundingClientRect();
      const sx = canvas.width / r.width;
      const at = (ev) => renderer.pick((ev.clientX - r.left) * sx, (ev.clientY - r.top) * sx, controller.frame());
      const d = at(e);
      const k = d ? hotspotAt(d) : -1;
      if (k < 0) return;
      e.stopPropagation();
      e.preventDefault();
      snapshot();
      selectLink(k, true);
      canvas.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const nd = at(ev);
        if (!nd) return;
        const { lon, lat } = lonLatFromDir(nd);
        // Placé à la main : le lien ne suit plus le plan.
        Object.assign(p.hotspots[k], { yaw: lon / DEG, pitch: lat / DEG, auto: false });
        dirty = true;
        redraw();
      };
      const up = () => {
        canvas.removeEventListener('pointermove', move, true);
        canvas.removeEventListener('pointerup', up, true);
        canvas.removeEventListener('pointercancel', up, true);
        renderLinks();
        selectLink(k, false);
      };
      canvas.addEventListener('pointermove', move, true);
      canvas.addEventListener('pointerup', up, true);
      canvas.addEventListener('pointercancel', up, true);
    },
    true
  );

  async function chooseTarget(pos) {
    const target = await pickPhoto(others, { title: 'Lien vers quelle photo ?' });
    if (!target) return;
    const t = photos.find((x) => x.id === target);
    dialog(
      `<h2>Nouveau lien vers « ${escapeHtml(t ? t.name : '')} »</h2>
      <label class="field">Texte affiché (facultatif)<input type="text" name="label" placeholder="ex. Vers la cuisine"></label>
      <label class="check"><input type="checkbox" name="reverse" checked> Créer aussi le lien retour dans l’autre photo (placé dans la direction opposée ; « ↩ Lien retour » permet ensuite de le déplacer)</label>
      <div class="row"><button class="btn" data-close>Annuler</button><button class="btn primary" data-ok>Créer</button></div>`,
      (d) => {
        d.querySelector('[data-ok]').addEventListener('click', () => {
          const label = d.querySelector('[name=label]').value.trim();
          snapshot();
          p.hotspots.push({ id: newId(), target, label, ...pos });
          if (d.querySelector('[name=reverse]').checked) reverseLinks.push({ target, yaw: wrapDeg(pos.yaw + 180), pitch: pos.pitch });
          dirty = true;
          d.close();
          renderLinks();
          redraw();
        });
      }
    );
  }

  // Vignettes des photos de destination (libérées à la fermeture de l'éditeur).
  const thumbUrls = new Map();
  async function thumbOf(id) {
    if (!thumbUrls.has(id)) {
      const b = await db.getBlob(id + ':thumb');
      thumbUrls.set(id, b ? URL.createObjectURL(b) : '');
    }
    return thumbUrls.get(id);
  }

  function renderLinks() {
    const list = $('.links-list');
    if (!p.hotspots.length) {
      list.innerHTML = '<p class="note">Aucun lien pour l’instant.</p>';
      return;
    }
    list.innerHTML = p.hotspots
      .map((h, i) => {
        const t = photos.find((x) => x.id === h.target);
        const arrive = h.arrive
          ? `réglée (cap ${Math.round(h.arrive.yaw)}°)`
          : 'automatique (dos au lien retour, sinon même direction)';
        return `<div class="link-item${i === selLink ? ' active' : ''}" data-i="${i}">
        <button class="link-target" data-target title="Changer la photo de destination"><img alt=""><span>→ ${escapeHtml(t ? t.name : '?')}</span><small>changer</small></button>
        <div class="row2"><input type="text" name="label" value="${escapeHtml(h.label || '')}" placeholder="Texte affiché"></div>
        <div class="note">Vue à l’arrivée : ${arrive}</div>
        <label class="check small"><input type="checkbox" name="auto" ${h.auto ? 'checked' : ''}> Direction d’après le plan (lien automatique)</label>
        <div class="row2">
          <button class="btn small" data-arrive title="Orienter la photo d’arrivée">🎯 Vue d’arrivée</button>
          ${h.arrive ? '<button class="btn small" data-arrive-auto title="Revenir à l’orientation automatique">Auto</button>' : ''}
          <button class="btn small" data-back title="Ouvrir la photo de destination pour régler le lien qui revient ici">↩ Lien retour</button>
        </div>
        <div class="row2">
          <button class="btn small" data-look>👁 Voir</button>
          <button class="btn small" data-move>✥ Déplacer</button>
          <button class="btn small danger" data-del>🗑</button>
        </div></div>`;
      })
      .join('');
    list.querySelectorAll('.link-item').forEach(async (item) => {
      const i = +item.dataset.i;
      const h = p.hotspots[i];
      item.querySelector('[data-target]').addEventListener('click', async () => {
        const id = await pickPhoto(others, { title: 'Lien vers quelle photo ?', currentId: h.target });
        if (!id || id === h.target) return;
        snapshot();
        p.hotspots[i].target = id;
        delete p.hotspots[i].arrive;
        dirty = true;
        renderLinks();
        redraw();
      });
      item.querySelector('[name=label]').addEventListener('input', (e) => {
        snapshot('label' + i);
        p.hotspots[i].label = e.target.value;
        dirty = true;
        redraw();
      });
      item.querySelector('[name=auto]').addEventListener('change', (e) => {
        snapshot();
        p.hotspots[i].auto = e.target.checked;
        dirty = true;
      });
      item.querySelector('[data-arrive]').addEventListener('click', async () => {
        // Sans réglage, on arrive en regardant dans la direction du lien.
        // Sans réglage, on arrive dos au lien qui ramène ici (ou dans la direction du lien).
        const t = photos.find((x) => x.id === h.target);
        const back = t && (t.hotspots || []).find((x) => x.target === p.id);
        const v = await chooseArrivalView(h.target, h.arrive || (back ? { yaw: wrapDeg(back.yaw + 180), pitch: 0 } : { yaw: h.yaw, pitch: 0 }));
        if (!v) return;
        snapshot();
        p.hotspots[i].arrive = v;
        dirty = true;
        renderLinks();
      });
      const auto = item.querySelector('[data-arrive-auto]');
      if (auto)
        auto.addEventListener('click', () => {
          snapshot();
          delete p.hotspots[i].arrive;
          dirty = true;
          renderLinks();
        });
      item.querySelector('[data-back]').addEventListener('click', () => openOther(h.target, { linkTo: p.id }));
      item.querySelector('[data-look]').addEventListener('click', () => {
        if (controller.mode === 'flat') setView('persp');
        controller.yaw = h.yaw * DEG;
        controller.pitch = h.pitch * DEG;
        redraw();
      });
      item.querySelector('[data-move]').addEventListener('click', () => {
        placing = { kind: 'move', index: i };
        hint('Touchez le nouvel emplacement du lien. <button class="btn small" data-place-cancel>Annuler</button>');
        bindPlaceCancel();
      });
      item.addEventListener('click', (ev) => {
        if (ev.target.closest('button, input, label')) return;
        selectLink(i, false);
      });
      item.querySelector('[data-del]').addEventListener('click', () => {
        snapshot();
        if (selLink === i) selLink = -1;
        else if (selLink > i) selLink--;
        p.hotspots.splice(i, 1);
        dirty = true;
        renderLinks();
        redraw();
      });
      const url = await thumbOf(h.target);
      if (url) item.querySelector('.link-target img').src = url;
    });
  }

  function bindPlaceCancel() {
    const b = $('[data-place-cancel]');
    if (b)
      b.addEventListener('click', () => {
        placing = null;
        hint('');
      });
  }

  // ---------- champs ----------
  // Cap de la direction au centre de la vue affichée (vue 360 ou vue à plat).
  function viewHeading() {
    return controller.mode === 'flat' ? (controller.flatCx - 0.5) * 360 : controller.yaw / DEG;
  }

  const TILT = { tiltForward: 'forward', tiltSide: 'side', cap: 'cap' };

  function getPath(path) {
    if (TILT[path]) return levelToViewTilt(p.params, viewHeading())[TILT[path]];
    return path.split('.').reduce((o, k) => o[k], p.params);
  }
  function setPath(path, v) {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], p.params)[last] = v;
  }

  function syncInputs() {
    $$('.slider:not(.relief-slider) input').forEach((i) => {
      const v = getPath(i.name);
      if (document.activeElement !== i) i.value = i.type === 'number' ? +(+v).toFixed(3) : v;
    });
    $('[name=srcType]').value = p.srcType;
    $('.fisheye-only').hidden = p.srcType !== 'fisheye';
  }

  $$('.slider:not(.relief-slider) input').forEach((i) =>
    i.addEventListener('input', () => {
      const v = parseFloat(i.value);
      if (!Number.isFinite(v)) return;
      snapshot('slider:' + i.name);
      if (i.name === 'cap') {
        setLevel(withCap(p.params, v));
      } else if (TILT[i.name]) {
        const h = viewHeading();
        const t = levelToViewTilt(p.params, h);
        t[TILT[i.name]] = v;
        setLevel(viewTiltToLevel(t, h));
      } else {
        setPath(i.name, v);
        dirty = true;
        syncInputs();
        redraw();
      }
    })
  );

  $('[name=srcType]').addEventListener('change', (e) => {
    snapshot();
    p.srcType = e.target.value;
    dirty = true;
    syncInputs();
    redraw();
  });

  $$('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      $$('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $$('[data-panel]').forEach((s) => (s.hidden = s.dataset.panel !== b.dataset.tab));
      syncRelief();
      redraw();
    })
  );

  // ---------- pièce : coins du plafond ----------
  // p.room = { name, corners: [{ yaw, pitch }] ×4, floor: { yaw, pitch }, camH } dans le repère de la photo
  // redressée (comme les liens). La hauteur sous plafond est commune (réglage du plan).
  if (!p.room) p.room = { name: guessRoomName(p.name), corners: [] };
  if (!p.room.corners) p.room.corners = [];
  let roomPick = null; // 'ceiling' | 'floor'
  let ceilingH = 2.8;
  db.getPlanDrawing().then((d) => {
    if (d.ceilingH) ceilingH = d.ceilingH;
    syncRoom();
  });
  const roomTabOpen = () => !$('[data-panel=room]').hidden;
  const defaultCamH = () => (p.relief && p.relief.h) || 1.6;
  function roomInfo() {
    return photoRoom({ ...p.room, camH: p.room.camH || null }, ceilingH, defaultCamH());
  }
  function syncRoom() {
    const nameIn = $('[name=roomName]');
    if (document.activeElement !== nameIn) nameIn.value = p.room.name || '';
    const ch = $('[name=ceilingH]');
    if (document.activeElement !== ch) ch.value = ceilingH;
    const r = roomInfo();
    const cam = $('[name=camH]');
    if (document.activeElement !== cam) cam.value = +(r ? r.camH : p.room.camH || defaultCamH()).toFixed(2);
    const n = p.room.corners.length;
    $('.room-info').innerHTML = r
      ? `Pièce de <b>${r.rect.w.toFixed(2)} × ${r.rect.l.toFixed(2)} m</b> ; appareil à ${r.camH.toFixed(2)} m du sol${p.room.floor ? ' (d’après le coin au sol)' : ''}. Vérifiez que la ligne rouge suit la jonction plafond / mur ; faites glisser un coin pour le corriger.`
      : n
        ? `${n} coin(s) sur 4.`
        : 'Aucun coin pour l’instant.';
  }
  // Coins, ligne plafond / mur prévue (rouge) et ligne sol / mur (bleue) sur l'image.
  function roomMarkers(frame, dpr) {
    if (!roomTabOpen() || !p.room) return '';
    let html = '';
    p.room.corners.forEach((c, i) => {
      const sc = renderer.project(dirFromLonLat(c.yaw * DEG, c.pitch * DEG), frame);
      if (sc) html += `<div class="ed-room-corner" style="left:${sc.x / dpr}px;top:${sc.y / dpr}px">${i + 1}</div>`;
    });
    if (p.room.floor) {
      const sf = renderer.project(dirFromLonLat(p.room.floor.yaw * DEG, p.room.floor.pitch * DEG), frame);
      if (sf) html += `<div class="ed-room-corner floor" style="left:${sf.x / dpr}px;top:${sf.y / dpr}px">⌄</div>`;
    }
    const r = roomInfo();
    if (r) {
      const unit = rectFromPoints(p.room.corners.map((c) => cornerXZ(c, 1)));
      const k = r.camH / r.Hc;
      for (const [cls, f] of [['ceil', (rr) => Math.atan(1 / rr)], ['floor', (rr) => -Math.atan(k / rr)]]) {
        let seg = [], path = '';
        const flush = () => {
          if (seg.length > 1) path += `<polyline class="${cls}" points="${seg.join(' ')}"/>`;
          seg = [];
        };
        for (let a = -180; a <= 180; a += 1.5) {
          const rr = rectDistance(unit, a * DEG);
          const sp = Number.isFinite(rr) ? renderer.project(dirFromLonLat(a * DEG, f(rr)), frame) : null;
          if (!sp) {
            flush();
            continue;
          }
          const pt = `${(sp.x / dpr).toFixed(1)},${(sp.y / dpr).toFixed(1)}`;
          // Saut (bord de la vue à plat, arrière de la vue) : nouveau morceau.
          if (seg.length) {
            const [px, py] = seg[seg.length - 1].split(',').map(Number);
            if (Math.abs(px - sp.x / dpr) > 150 || Math.abs(py - sp.y / dpr) > 150) flush();
          }
          seg.push(pt);
        }
        flush();
        html += `<svg class="ed-room-lines">${path}</svg>`;
      }
    }
    return html;
  }
  function roomTap(d) {
    const { lon, lat } = lonLatFromDir(d);
    const pos = { yaw: +(lon / DEG).toFixed(2), pitch: +(lat / DEG).toFixed(2) };
    if (roomPick === 'ceiling') {
      if (pos.pitch < 2) return toast('Un coin du plafond est au-dessus de l’horizon : cliquez plus haut.', true);
      snapshot();
      p.room.corners.push(pos);
      dirty = true;
      if (p.room.corners.length >= 4) {
        roomPick = null;
        hint('');
      } else hint(`Cliquez le coin ${p.room.corners.length + 1} sur 4 (là où deux murs rencontrent le plafond). <button class="btn small" data-room-stop>Arrêter</button>`);
    } else if (roomPick === 'floor') {
      if (pos.pitch > -2) return toast('Un coin au sol est sous l’horizon : cliquez plus bas.', true);
      snapshot();
      p.room.floor = pos;
      delete p.room.camH;
      dirty = true;
      roomPick = null;
      hint('');
    }
    bindRoomStop();
    syncRoom();
    redraw();
  }
  function bindRoomStop() {
    const b = $('[data-room-stop]');
    if (b)
      b.addEventListener('click', () => {
        roomPick = null;
        hint('');
      });
  }
  $('[data-room-pick]').addEventListener('click', () => {
    stopTool();
    placing = null;
    snapshot();
    p.room.corners = [];
    roomPick = 'ceiling';
    if (controller.mode === 'flat') setView('persp');
    controller.pitch = 25 * DEG;
    hint('Cliquez le coin 1 sur 4 (là où deux murs rencontrent le plafond), puis les suivants en tournant la vue. <button class="btn small" data-room-stop>Arrêter</button>');
    bindRoomStop();
    syncRoom();
    redraw();
  });
  $('[data-room-floor]').addEventListener('click', () => {
    stopTool();
    roomPick = 'floor';
    hint('Cliquez un coin du sol (le pied d’un angle entre deux murs, bien visible). <button class="btn small" data-room-stop>Arrêter</button>');
    bindRoomStop();
  });
  $('[data-room-clear]').addEventListener('click', () => {
    snapshot();
    p.room.corners = [];
    delete p.room.floor;
    dirty = true;
    syncRoom();
    redraw();
  });
  $('[data-room-detect]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    hint('Recherche de la jonction plafond / mur…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      renderer.setParams(p.params, p.srcType);
      const W = 2048, H = 1024;
      const flat = renderer.readFlat(W, H);
      const rgba = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) rgba.set(flat.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
      const fit = fitCeilingRect(edgeMap(rgba, W, H));
      snapshot();
      p.room.corners = cornersFromFit(fit);
      dirty = true;
      toast('Coins proposés : vérifiez la ligne rouge et faites glisser les coins mal placés.', false, 6000);
    } catch (err) {
      toast('Détection impossible : ' + err.message, true);
    }
    hint('');
    btn.disabled = false;
    syncRoom();
    redraw();
  });
  $('[name=roomName]').addEventListener('input', (e) => {
    p.room.name = e.target.value.trim();
    dirty = true;
  });
  $('[name=ceilingH]').addEventListener('change', async (e) => {
    const v = parseFloat(e.target.value);
    if (!(v > 1.5)) return;
    ceilingH = v;
    const d = await db.getPlanDrawing();
    await db.putPlanDrawing({ ...d, ceilingH: v });
    syncRoom();
    redraw();
  });
  $('[name=camH]').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (!(v > 0.2)) return;
    snapshot();
    p.room.camH = v;
    delete p.room.floor;
    dirty = true;
    syncRoom();
    redraw();
  });
  // Noms de pièces déjà utilisés (proposés à la saisie).
  $('#room-names').innerHTML = [...new Set(photos.map((x) => x.room && x.room.name).filter(Boolean))].map((n) => `<option value="${escapeHtml(n)}">`).join('');
  // Faire glisser un coin pour le corriger (onglet Pièce ouvert).
  stage.addEventListener(
    'pointerdown',
    (e) => {
      if (!roomTabOpen() || e.button !== 0 || tool || placing || roomPick || e.target !== canvas) return;
      const r0 = canvas.getBoundingClientRect();
      const sx = canvas.width / r0.width;
      const at = (ev) => renderer.pick((ev.clientX - r0.left) * sx, (ev.clientY - r0.top) * sx, controller.frame());
      const d = at(e);
      if (!d) return;
      const all = [...p.room.corners.map((c, i) => ({ c, i })), ...(p.room.floor ? [{ c: p.room.floor, i: 'floor' }] : [])];
      let best = null, bestAng = 0.07;
      for (const it of all) {
        const ang = Math.acos(Math.max(-1, Math.min(1, vecDot(d, dirFromLonLat(it.c.yaw * DEG, it.c.pitch * DEG)))));
        if (ang < bestAng) (bestAng = ang), (best = it);
      }
      if (!best) return;
      e.stopPropagation();
      e.preventDefault();
      snapshot();
      canvas.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const nd = at(ev);
        if (!nd) return;
        const { lon, lat } = lonLatFromDir(nd);
        const pos = { yaw: +(lon / DEG).toFixed(2), pitch: +(lat / DEG).toFixed(2) };
        if (best.i === 'floor') {
          p.room.floor = pos;
          delete p.room.camH;
        } else p.room.corners[best.i] = pos;
        dirty = true;
        syncRoom();
        redraw();
      };
      const up = () => {
        canvas.removeEventListener('pointermove', move, true);
        canvas.removeEventListener('pointerup', up, true);
      };
      canvas.addEventListener('pointermove', move, true);
      canvas.addEventListener('pointerup', up, true);
    },
    true
  );
  syncRoom();

  // ---------- relief (profondeur par IA) ----------
  const depthStatus = (txt) => {
    const el = $('.depth-status');
    el.hidden = !txt;
    el.textContent = txt || '';
  };
  async function computeNow() {
    if (depthBusy) return;
    depthBusy = true;
    const btn = $('[data-depth-compute]');
    btn.disabled = true;
    try {
      renderer.setParams(p.params, p.srcType);
      const t0 = performance.now();
      const r = await computeDepth(renderer, depthStatus);
      depthMaps = { depth: r.depth, bg: r.bg };
      depthBgImage = r.bgCanvas;
      depthPng = r.png;
      depthBgBlob = r.bgImage;
      p.relief = { kind: 'ai', h: (p.relief && p.relief.h) || DEFAULT_CAMERA_HEIGHT, key: reliefKey(p.params), floor: r.floorOk };
      dirty = true;
      depthStatus('');
      toast(`Relief calculé en ${((performance.now() - t0) / 1000).toFixed(0)} s${r.floorOk ? '' : ' (sol peu visible : échelle approximative)'}. Enregistrez pour le garder.`, false, 6000);
    } catch (err) {
      depthStatus('');
      toast('Calcul du relief impossible : ' + err.message + '. Une connexion Internet est nécessaire la première fois.', true, 8000);
    }
    depthBusy = false;
    btn.disabled = false;
    syncRelief();
    redraw();
  }
  function syncRelief() {
    const r = p.relief || { h: DEFAULT_CAMERA_HEIGHT };
    $$('.relief-slider input').forEach((i) => {
      if (document.activeElement !== i) i.value = r.h || DEFAULT_CAMERA_HEIGHT;
    });
    $('[data-depth-compute]').textContent = currentRelief() ? '🧠 Recalculer le relief (IA)' : '🧠 Calculer le relief (IA)';
  }
  function updateReliefInfo() {
    const r = currentRelief();
    const info = $('.relief-info');
    if (!r) {
      info.textContent =
        p.relief && p.relief.kind === 'ai' && depthMaps ? 'Le redressement a changé : recalculez le relief.' : 'Pas encore de relief pour cette photo : appuyez sur « Calculer le relief ».';
      return;
    }
    let txt = r.floor === false ? 'Sol peu visible : l’échelle des distances est approximative.' : 'Échelle déduite du sol.';
    if (controller.mode !== 'flat') txt += ` Au centre de la vue : ${(depthAt(depthMaps.depth, controller.gazeDir()) * r.h).toFixed(2)} m.`;
    info.textContent = txt;
  }
  $('[data-depth-compute]').addEventListener('click', computeNow);
  $('[data-depth-view]').addEventListener('change', (e) => {
    depthView = e.target.checked;
    redraw();
  });
  // Carte déjà enregistrée pour cette photo.
  if (p.relief && p.relief.kind === 'ai') {
    db.getBlob(p.id + ':depthbg')
      .then((b) => (b ? loadImageBitmap(b) : null))
      .then((img) => {
        depthBgImage = img;
        redraw();
      })
      .catch(() => {});
    db.getBlob(p.id + ':depth')
      .then((b) => (b ? loadDepthImage(b) : null))
      .then((d) => {
        if (d) {
          depthMaps = d;
          syncRelief();
          redraw();
        }
      })
      .catch(() => {});
  }
  $$('.relief-slider input').forEach((i) =>
    i.addEventListener('input', () => {
      const v = parseFloat(i.value);
      if (!Number.isFinite(v)) return;
      p.relief = { ...(p.relief || {}), h: Math.max(0.3, v) };
      dirty = true;
      syncRelief();
      redraw();
    })
  );

  function setView(mode) {
    controller.setMode(mode === 'flat' ? 'flat' : 'touch');
    $$('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
    redraw();
  }
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('[data-grid]').addEventListener('click', (e) => {
    grid = !grid;
    e.currentTarget.classList.toggle('active', grid);
    redraw();
  });
  $('[data-grid]').classList.toggle('active', grid);

  $$('[data-tool]').forEach((b) => b.addEventListener('click', () => (tool && tool.kind === b.dataset.tool ? stopTool() : startTool(b.dataset.tool))));

  // Redressement automatique : 8 vues autour de la photo (telle qu'elle est redressée), relevé des
  // bords presque verticaux, puis verticale la mieux accordée. Refusé au-delà de 15°.
  $('[data-autolevel]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    stopTool();
    btn.disabled = true;
    hint('Recherche des verticales…');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const r = await autoLevel(renderer, p.params, p.srcType);
      if (!r.ok) {
        toast('Redressement automatique impossible : ' + r.reason + '. Utilisez les outils manuels.', true, 7000);
      } else if (r.total < 0.05) {
        toast('La photo est déjà droite.');
      } else {
        snapshot();
        setLevel(r.level);
        toast(`Photo redressée de ${r.total.toFixed(1)}° d’après ${r.support} points de verticales. Vérifiez avec la grille (Défaire pour annuler).`, false, 6000);
      }
    } catch (err) {
      toast('Redressement automatique impossible : ' + err.message, true);
    }
    hint('');
    btn.disabled = false;
    redraw();
  });
  $('[data-reset-level]').addEventListener('click', () => {
    snapshot();
    setLevel({ yaw: 0, pitch: 0, roll: 0 });
  });

  // Le nord est la direction de cap `h` (degrés, dans l'image affichée) : on ajuste le cap en
  // conséquence, sans toucher au redressement, et la vue suit pour que l'image ne saute pas.
  function setNorth(h) {
    snapshot();
    setLevel(withCap(p.params, levelToViewTilt(p.params, 0).cap + h));
    const shift = h * DEG;
    if (controller.mode === 'flat') controller.flatCx = 0.5;
    controller.yaw -= shift;
    syncInputs();
    redraw();
    toast('Nord enregistré : le « N » rouge indique maintenant cette direction.');
  }

  $('[data-north]').addEventListener('click', () => {
    stopTool();
    placing = { kind: 'north' };
    hint('Touchez dans l’image la direction du nord (sur l’horizon), ou <button class="btn small" data-north-center>prenez le centre de la vue</button> <button class="btn small" data-place-cancel>Annuler</button>');
    bindPlaceCancel();
    $('[data-north-center]').addEventListener('click', () => {
      placing = null;
      hint('');
      setNorth(viewHeading());
    });
  });

  $('[data-undo]').addEventListener('click', undo);

  $('[data-add-link]').addEventListener('click', () => {
    stopTool();
    placing = { kind: 'add' };
    hint('Touchez l’endroit de la photo où placer le lien (porte, passage…). <button class="btn small" data-place-cancel>Annuler</button>');
    bindPlaceCancel();
  });

  $('[data-autodetect]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    hint('Calibrage en cours…');
    try {
      const patch = await calibrateFromBlob(await db.getBlob(p.id + ':orig'), p.params);
      snapshot();
      Object.assign(p.params, clone(patch), { autoCalibrated: true });
      dirty = true;
      syncInputs();
      redraw();
      toast('Objectifs calibrés et exposition égalisée.');
    } catch (err) {
      toast('Calibrage impossible : ' + err.message, true);
    }
    hint('');
    btn.disabled = false;
  });

  $('[data-lens-default]').addEventListener('click', async () => {
    const { fov, blend, lensA, lensB } = p.params;
    const v = clone({ fov, blend, lensA, lensB });
    await db.putSetting('lens:' + (p.model || 'default'), v);
    if (!p.model) await db.putSetting('lens:default', v);
    toast('Calibrage mémorisé pour les prochains imports.');
  });

  $('[data-lens-reset]').addEventListener('click', () => {
    snapshot();
    Object.assign(p.params, clone(DEFAULT_LENS_PARAMS));
    dirty = true;
    syncInputs();
    redraw();
  });

  $('[name=title]').addEventListener('input', () => (dirty = true));

  $('[data-cancel]').addEventListener('click', () => {
    if (dirty && !confirm('Abandonner les modifications ?')) return;
    onDone(false, currentView());
  });

  async function save() {
    const cur = await db.getPhoto(p.id);
    const imageChanged = cur.srcType !== p.srcType || JSON.stringify(cur.params) !== JSON.stringify(p.params);
    const updated = {
      ...cur,
      name: $('[name=title]').value.trim() || cur.name,
      srcType: p.srcType,
      params: p.params,
      hotspots: p.hotspots,
      ...(p.room && (p.room.name || (p.room.corners || []).length) ? { room: p.room } : {}),
      // Relief : gardé s'il correspond au redressement (la carte est refaite sinon).
      ...(p.relief ? { relief: p.relief } : {}),
      status: imageChanged || cur.status !== 'done' ? 'pending' : 'done',
    };
    if (depthPng) {
      await db.putBlob(p.id + ':depth', depthPng);
      if (depthBgBlob) await db.putBlob(p.id + ':depthbg', depthBgBlob);
      depthPng = depthBgBlob = null;
    }
    await db.putPhoto(updated);
    for (const r of reverseLinks) {
      const t = await db.getPhoto(r.target);
      if (!t || !updated.hotspots.some((h) => h.target === r.target)) continue;
      if ((t.hotspots || []).some((h) => h.target === p.id)) continue;
      // Lien retour automatique : sa direction suit ensuite la position des photos sur le plan.
      await db.putPhoto({ ...t, hotspots: [...(t.hotspots || []), { id: newId(), target: p.id, label: '', yaw: r.yaw, pitch: r.pitch, auto: true }] });
    }
    dirty = false;
    if (onRenamed && updated.name !== cur.name) await onRenamed(p.id, updated.name);
    return imageChanged;
  }

  $('[data-save]').addEventListener('click', async () => {
    if (await save()) toast('Enregistré. La photo sera reconvertie dès le retour à la bibliothèque.');
    onDone(true, currentView());
  });

  // Ouvre une autre photo dans l'éditeur, après avoir enregistré celle-ci.
  async function openOther(id, focusOpt) {
    if (!onOpenPhoto) return;
    if (dirty) await save();
    onOpenPhoto(id, currentView(), focusOpt);
  }

  // Photo précédente / suivante : les modifications en cours sont enregistrées automatiquement.
  let navigating = false;
  async function navigate(dir) {
    if (navigating || !onNavigate || photos.length < 2) return;
    navigating = true;
    if (dirty) {
      await save();
      toast('Modifications de « ' + ($('[name=title]').value.trim() || p.name) + ' » enregistrées.');
    }
    onNavigate(dir, currentView());
  }
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => navigate(+b.dataset.nav)));
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      // Dans un champ texte, Ctrl+Z garde son rôle habituel.
      if (e.target.closest && e.target.closest('input[type=text], textarea')) return;
      e.preventDefault();
      undo();
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // Les flèches gardent leur rôle dans un champ (curseurs, nom de la photo) ou une fenêtre ouverte.
    if (e.target.closest && e.target.closest('input, select, textarea, dialog')) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    navigate(e.key === 'ArrowRight' ? 1 : -1);
  };
  window.addEventListener('keydown', onKey);

  const beforeUnload = (e) => {
    if (dirty) e.preventDefault();
  };
  window.addEventListener('beforeunload', beforeUnload);
  const onResize = () => redraw();
  window.addEventListener('resize', onResize);

  syncInputs();
  renderLinks();
  setView('persp');
  hint('Chargement de la photo originale…');
  const orig = await db.getBlob(p.id + ':orig');
  await renderer.load(orig, p.srcType, p.params);
  hint('');
  redraw();

  if (focus && focus.linkTo) {
    $('[data-tab=links]').click();
    const back = photos.find((x) => x.id === focus.linkTo);
    const idx = p.hotspots.findIndex((h) => h.target === focus.linkTo);
    const cancel = ' <button class="btn small" data-place-cancel>Annuler</button>';
    if (idx >= 0) {
      const h = p.hotspots[idx];
      controller.yaw = h.yaw * DEG;
      controller.pitch = h.pitch * DEG;
      placing = { kind: 'move', index: idx };
      hint(`Lien retour vers « ${escapeHtml(back ? back.name : '')} » : touchez son nouvel emplacement (par exemple la porte vue d’ici).` + cancel);
    } else {
      placing = { kind: 'add-to', target: focus.linkTo };
      hint(`Pas encore de lien retour vers « ${escapeHtml(back ? back.name : '')} » : touchez l’endroit où le placer.` + cancel);
    }
    bindPlaceCancel();
    redraw();
  }

  return {
    dispose() {
      cancelAnimationFrame(raf);
      thumbUrls.forEach((u) => u && URL.revokeObjectURL(u));
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('resize', onResize);
      controller.dispose();
      renderer.dispose();
    },
  };
}
