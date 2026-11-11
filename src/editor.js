// Éditeur : redressement (verticalité), calibrage des objectifs fisheye, liens entre photos.
import * as db from './db.js';
import { PanoRenderer } from './renderer.js';
import { ViewController } from './controls.js';
import { DEFAULT_LENS_PARAMS } from './gl-source.js';
import { calibrateFromBlob } from './importer.js';
import { DEG, dirFromLonLat, lonLatFromDir, upFromHorizon, upFromVerticals, applyUpCorrection, remapHotspot, wrapDeg, levelToViewTilt, viewTiltToLevel, withCap, cameraMatrix, levelMatrix, mat3Apply, vecDot } from './math.js';
import { edgeConstraints, solveUp } from './autolevel.js';
import { reliefKey, depthAt, loadDepthImage, loadImageBitmap } from './depth.js';
import { computeDepth } from './depth-ai.js';
import { toast, escapeHtml, dialog } from './ui.js';
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
        </div>
      </div>
      <div class="ed-body">
        <section data-panel="level">
          <p class="note">Corrigez une photo prise caméra penchée : la ligne orange (horizon) doit être plate et les verticales droites. Utilisez la vue à plat et la grille pour vérifier.</p>
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
          <p class="note"><b>Horizon</b> : cliquez deux points de l’horizon réel (mer, plaine), si possible éloignés d’environ 90°.<br>
          <b>Verticales</b> : cliquez le haut puis le bas d’un élément vertical (angle de mur, poteau, encadrement de porte), puis d’un second, de préférence dans une autre direction. Avec une seule ligne, appuyez sur « Appliquer ».<br>
          <b>Bascules</b> : elles s’appliquent par rapport au centre de la vue affichée. Tournez la vue vers un mur ou une porte, puis basculez jusqu’à ce que ses verticales soient droites ; les valeurs se mettent à jour quand vous tournez la vue.<br>
          <b>Nord / cap</b> : la caméra n’a pas de boussole, c’est à vous d’indiquer le nord (repéré sur un plan, une carte ou avec la boussole du téléphone). Cliquez « Indiquer le nord » puis touchez sa direction dans l’image ; le « N » rouge s’y place et le curseur de cap permet d’affiner. Avec le même nord sur toutes vos photos, on garde la bonne direction en passant de l’une à l’autre.<br>
          <b>Défaire</b> (Ctrl+Z) annule la dernière action : bascule, outil horizon ou verticales, lien…</p>
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
            <p class="note">Le calibrage automatique est fait à l’import : il aligne les deux objectifs sur la couture et égalise leur exposition. Relancez-le après une modification, ou si la couture reste visible ajustez à la main le rayon et la rotation (les objets très proches de la caméra, comme la main, restent légèrement dédoublés : c’est la parallaxe entre les deux objectifs). « Calibrage par défaut » mémorise ces valeurs pour les prochains imports de cet appareil${p.model ? ' (' + escapeHtml(p.model) + ')' : ''}.</p>
          </div>
        </section>
        <section data-panel="relief" hidden>
          <p class="note">Dans le casque, chaque œil voit la photo d’un point légèrement différent pour donner du relief. Une intelligence artificielle (Depth Anything V2, exécutée dans votre navigateur, sans envoi de la photo) estime la distance de chaque point : murs, sol, plafond, meubles, personnes. Les couleurs montrent les distances : <b style="color:#e5484d">proche</b>, <b style="color:#d6b600">moyen</b>, <b style="color:#2fa84f">loin</b>, <b style="color:#3b82f6">très loin</b>.</p>
          <div class="tools">
            <button class="btn small primary" data-depth-compute>🧠 Calculer le relief (IA)</button>
            <label class="check"><input type="checkbox" data-depth-view checked> Colorer selon la distance</label>
          </div>
          <p class="note depth-status" hidden></p>
          <label class="slider relief-slider"><span>Hauteur de l’objectif au-dessus du sol (m)</span>
            <input type="range" name="reliefH" min="0.3" max="2.5" step="0.05">
            <input type="number" name="reliefH" min="0.3" max="2.5" step="0.05"></label>
          <p class="note relief-info"></p>
          <p class="note">La première fois, le modèle (27 à 50 Mo) est téléchargé puis gardé par le navigateur. Le calcul prend quelques secondes avec une carte graphique récente (WebGPU), jusqu’à une minute ou deux sinon. L’échelle est déduite du sol, à la hauteur de l’objectif indiquée : plus elle est faible, plus le relief est marqué. L’intensité se règle aussi dans le casque (⚙, « Relief »).<br>Dans le casque, ce que vous regardez est placé sans décalage entre les deux yeux (comme quand les yeux convergent) et l’écart entre les deux images est limité pour rester confortable. Autour des personnes et des objets proches, le fond est prolongé plutôt que d’étirer l’objet.</p>
        </section>
        <section data-panel="links" hidden>
          <p class="note">Un lien est une pastille sur laquelle on touche (ou que l’on fixe du regard dans le casque) pour passer à une autre photo.</p>
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
      renderer.draw({ ...frame, grid, hotSel: -1, hotSize: controller.mode === 'flat' ? 0.05 : 0.06, depthView: depthView && reliefTabOpen() });
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
    history.push(clone({ params: p.params, srcType: p.srcType, hotspots: p.hotspots, reverse: reverseLinks.length }));
    if (history.length > 60) history.shift();
    updateUndo();
  }
  function undo() {
    const s = history.pop();
    if (!s) return;
    p.params = s.params;
    p.srcType = s.srcType;
    p.hotspots = s.hotspots;
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
    }
  }

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
        return `<div class="link-item" data-i="${i}">
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
      item.querySelector('[data-del]').addEventListener('click', () => {
        snapshot();
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
      // Plusieurs passes : chaque mesure est refaite sur l'image déjà corrigée, jusqu'à convergence.
      const startUp = mat3Apply(levelMatrix(p.params.yaw, p.params.pitch, p.params.roll), [0, 1, 0]);
      let lvl = { yaw: p.params.yaw, pitch: p.params.pitch, roll: p.params.roll };
      let result = null, support = 0;
      for (let pass = 0; pass < 3; pass++) {
        renderer.setParams({ ...p.params, ...lvl }, p.srcType);
        const constraints = [];
        for (let k = 0; k < 8; k++) {
          const cam = cameraMatrix(k * 45 * DEG, 0);
          constraints.push(...edgeConstraints(renderer.readView(cam, 75, 512), 512, cam, 75));
          await new Promise((r) => setTimeout(r, 0));
        }
        const r = solveUp(constraints);
        if (!r.ok) {
          if (pass === 0) result = r;
          break;
        }
        support = r.support;
        const next = applyUpCorrection(lvl, r.up);
        lvl = { ...next, yaw: lvl.yaw + wrapDeg(next.yaw - lvl.yaw) };
        result = { ok: true };
        if (r.tiltDeg < 0.1) break;
      }
      renderer.setParams(p.params, p.srcType);
      const endUp = mat3Apply(levelMatrix(lvl.yaw, lvl.pitch, lvl.roll), [0, 1, 0]);
      const total = Math.acos(Math.max(-1, Math.min(1, vecDot(startUp, endUp)))) / DEG;
      if (!result || !result.ok) {
        toast('Redressement automatique impossible : ' + (result ? result.reason : 'aucune mesure') + '. Utilisez les outils manuels.', true, 7000);
      } else if (total > 15) {
        toast(`Redressement automatique impossible : correction trouvée trop forte (${total.toFixed(1)}°), verticales peu fiables. Utilisez les outils manuels.`, true, 7000);
      } else if (total < 0.05) {
        toast('La photo est déjà droite.');
      } else {
        snapshot();
        setLevel(lvl);
        toast(`Photo redressée de ${total.toFixed(1)}° d’après ${support} points de verticales. Vérifiez avec la grille (Défaire pour annuler).`, false, 6000);
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
