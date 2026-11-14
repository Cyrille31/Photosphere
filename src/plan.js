// Plan des photos : chaque photo est une mini-sphère placée sur un plan orienté nord en haut ; les
// traits sont les liens. Déplacer une photo réoriente ses liens « automatiques » (les liens retour
// créés automatiquement), qui pointent alors vers la position des photos voisines sur le plan.
import * as db from './db.js';
import { escapeHtml, toast } from './ui.js';
import { manualButton, bindManualButtons } from './manual.js';
import { placeRooms, roomCorners } from './room.js';
import { levelToViewTilt, withCap, remapHotspot, wrapDeg } from './math.js';

const SPACING = 170; // distance entre deux photos liées lors de la disposition automatique

// Direction du nord sur le plan (degrés, sens horaire depuis le haut ; 0 : le nord est en haut). Réglée
// par la flèche nord-sud du plan.
let NORTH = 0;
export function setPlanNorth(deg) {
  NORTH = +deg || 0;
}
export const planNorth = () => NORTH;

// Cap (degrés, 0 = nord, 90 = est) de b vu depuis a, sur le plan (y vers le bas).
export function bearing(a, b) {
  const v = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI - NORTH;
  return ((v + 540) % 360) - 180;
}

// Positions des photos qui n'en ont pas encore : en suivant les liens à partir des photos déjà
// placées (direction du lien = direction sur le plan), groupe par groupe.
export function autoLayout(photos) {
  const pos = new Map();
  photos.forEach((p) => p.mapPos && pos.set(p.id, { ...p.mapPos }));
  const byId = new Map(photos.map((p) => [p.id, p]));
  const neighbours = (id) => {
    const out = [];
    (byId.get(id).hotspots || []).forEach((h) => byId.has(h.target) && out.push({ id: h.target, yaw: h.yaw }));
    photos.forEach((p) => (p.hotspots || []).forEach((h) => h.target === id && out.push({ id: p.id, yaw: h.yaw + 180 })));
    return out;
  };
  const free = (x, y) => [...pos.values()].every((q) => Math.hypot(q.x - x, q.y - y) > SPACING * 0.55);
  const spread = (from) => {
    const queue = [from];
    while (queue.length) {
      const id = queue.shift();
      const a = pos.get(id);
      for (const n of neighbours(id)) {
        if (pos.has(n.id)) continue;
        let placed = null;
        for (let k = 0; k < 12 && !placed; k++) {
          const yaw = ((n.yaw + NORTH + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 25) * Math.PI) / 180;
          const x = a.x + SPACING * Math.sin(yaw), y = a.y - SPACING * Math.cos(yaw);
          if (free(x, y)) placed = { x, y };
        }
        if (!placed) placed = { x: a.x + SPACING * Math.sin(((n.yaw + NORTH) * Math.PI) / 180) * 1.6, y: a.y - SPACING * Math.cos(((n.yaw + NORTH) * Math.PI) / 180) * 1.6 };
        pos.set(n.id, placed);
        queue.push(n.id);
      }
    }
  };
  [...pos.keys()].forEach(spread);
  // Groupes de photos liées entre elles mais encore non placées : côte à côte.
  let nextX = pos.size ? Math.max(...[...pos.values()].map((q) => q.x)) + SPACING * 1.5 : 0;
  photos.forEach((p) => {
    if (pos.has(p.id) || !neighbours(p.id).length) return;
    pos.set(p.id, { x: nextX, y: 0 });
    spread(p.id);
    nextX = Math.max(...[...pos.values()].map((q) => q.x)) + SPACING * 1.5;
  });
  // Photos sans lien : en ligne, sous le reste.
  const maxY = pos.size ? Math.max(...[...pos.values()].map((q) => q.y)) : 0;
  let col = 0;
  photos.forEach((p) => {
    if (pos.has(p.id)) return;
    pos.set(p.id, { x: col * SPACING * 0.9, y: maxY + SPACING * 1.4 });
    col++;
  });
  return pos;
}

// Réoriente les liens automatiques qui partent de / arrivent à `id`, d'après les positions.
export function retargetAutoLinks(photos, pos, id) {
  const changed = new Set();
  photos.forEach((p) => {
    (p.hotspots || []).forEach((h) => {
      if (!h.auto || (p.id !== id && h.target !== id)) return;
      const a = pos.get(p.id), b = pos.get(h.target);
      if (!a || !b) return;
      const yaw = +bearing(a, b).toFixed(2);
      if (Math.abs(yaw - h.yaw) > 0.01) {
        h.yaw = yaw;
        changed.add(p.id);
      }
    });
  });
  return changed;
}

// ---------- géométrie des vignettes ----------
// Chaque photo est dessinée en sphère (diamètre BALL, on voit la moitié tournée vers soi) ou en
// rectangle (photo à plat, RECT_W × RECT_H). `rot` est le cap affiché au centre (rotation de la
// vignette). Un lien part du point de la vignette qui correspond à sa direction dans la photo.
export const BALL = 84, RECT_W = 176, RECT_H = 88;

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export function picSize(mode) {
  return mode === 'rect' ? { w: RECT_W, h: RECT_H } : { w: BALL, h: BALL };
}

// Décalage (par rapport au centre de la vignette) du point de contact d'un lien de cap `yaw`,
// d'élévation `pitch`. Sur la sphère, un lien situé dans la moitié cachée est ramené au bord.
export function contactOffset(mode, rot, yaw, pitch) {
  const rel = wrap180(yaw - rot);
  if (mode === 'rect') return { x: (rel / 360) * RECT_W, y: (-pitch / 180) * RECT_H, hidden: false };
  return { x: (Math.max(-90, Math.min(90, rel)) / 180) * BALL, y: (-pitch / 180) * BALL, hidden: Math.abs(rel) > 90 };
}

// Inverse : direction (cap, élévation) d'un point de la vignette.
export function contactFromOffset(mode, rot, dx, dy) {
  const { w, h } = picSize(mode);
  const span = mode === 'rect' ? 360 : 180;
  const rel = Math.max(-span / 2, Math.min(span / 2, (dx / w) * span));
  return { yaw: +wrap180(rot + rel).toFixed(2), pitch: +Math.max(-85, Math.min(85, (-dy / h) * 180)).toFixed(2) };
}

// Photos sans lien : en grille dans une zone rectangulaire sous les photos reliées.
export function poolLayout(ids, linkedPositions, mode) {
  const { w, h } = picSize(mode);
  const cellW = w + 96, cellH = h + 84;
  const pts = [...linkedPositions];
  const left = pts.length ? Math.min(...pts.map((q) => q.x)) - w : 0;
  const top = pts.length ? Math.max(...pts.map((q) => q.y)) + h + 120 : 0;
  const cols = Math.max(3, Math.ceil(Math.sqrt(ids.length * 1.8)));
  const pos = new Map();
  // Marge du haut : place pour le titre de la zone (sur deux lignes au plus).
  ids.forEach((id, k) => pos.set(id, { x: left + cellW / 2 + (k % cols) * cellW, y: top + 72 + h / 2 + Math.floor(k / cols) * cellH }));
  const rows = Math.ceil(ids.length / cols);
  return { pos, zone: { x: left, y: top, w: Math.max(Math.min(cols, ids.length) * cellW, 380), h: rows * cellH + 52 } };
}

// container : élément où dessiner. onOpen(id, 'view' | 'edit'). onRename(id, nom) : enregistre un nouveau nom.
export async function openPlan(container, { photos, onOpen, onRename }) {
  const list = photos.map((p) => JSON.parse(JSON.stringify(p)));
  const byId = new Map(list.map((p) => [p.id, p]));
  let mode = 'sphere';
  try {
    mode = localStorage.getItem('ps-plan-mode') === 'rect' ? 'rect' : 'sphere';
  } catch (e) {
    // préférence non mémorisée
  }
  const rot = new Map(list.map((p) => [p.id, p.mapRot || 0]));
  let pos = new Map();
  let pool = new Set();
  let zone = null;
  let linkFrom = null;
  let selected = null;
  // La photo sélectionnée (un clic) est affichée en grand, avec son nom modifiable.
  // Facteur d'agrandissement réglable (mémorisé), 8 par défaut.
  let ZOOM = 8;
  try {
    ZOOM = +localStorage.getItem('ps-plan-zoom') || 8;
  } catch (e) {
    // préférence non mémorisée
  }
  const zf = (id) => (id === selected ? ZOOM : 1);
  // Lien sélectionné sur le plan : { from: id de la photo, hid: id du lien (ou indice) }.
  let selLink = null;
  // Dessin du plan (murs, textes), en coordonnées du plan comme les photos.
  let drawing = await db.getPlanDrawing();
  let tool = 'photos'; // photos | line | text | erase
  let poly = null; // trait en cours : { last: point }
  let hover = null; // point sous la souris (aperçu du trait)
  let lastClick = null;
  let textSize = 20;
  const undoStack = [];
  // Échelle d'affichage : les rectangles, plus larges, demandent plus d'écart entre les photos.
  // Les positions enregistrées (et donc les directions entre photos) ne changent pas.
  const scale = () => (mode === 'rect' ? 1.75 : 1);
  const disp = (q) => ({ x: q.x * scale(), y: q.y * scale() });

  const isLinked = (id) => byId.get(id).hotspots.some((h) => byId.has(h.target)) || list.some((p) => p.hotspots.some((h) => h.target === id));
  // Sur le plan : photo reliée à une autre, ou placée à la main (même sans lien, en attendant).
  const onPlan = (id) => isLinked(id) || !!(byId.get(id).mapPlaced && byId.get(id).mapPos);
  list.forEach((p) => (p.hotspots = p.hotspots || []));

  // Positions : photos reliées d'après le plan (ou les liens), photos isolées dans la zone.
  async function layout() {
    const linked = list.filter((p) => onPlan(p.id));
    pool = new Set(list.filter((p) => !onPlan(p.id)).map((p) => p.id));
    pos = autoLayout(linked);
    for (const p of linked) {
      if (!p.mapPos) {
        p.mapPos = pos.get(p.id);
        await db.updatePhoto(p.id, (cur) => ({ ...cur, mapPos: p.mapPos }));
      }
    }
    const pl = poolLayout([...pool], [...pos.values()].map(disp), mode);
    pl.pos.forEach((v, k) => pos.set(k, { x: v.x / scale(), y: v.y / scale() }));
    zone = pool.size ? pl.zone : null;
  }

  container.innerHTML = `<div class="plan">
    <div class="plan-bar">
      <span class="plan-north" title="La flèche nord-sud du plan se déplace (glisser son centre) et se tourne (glisser sa pointe N)">🧭 Nord</span>
      <button class="btn small" data-fit>⤢ Tout afficher</button>
      <span class="plan-tools">
        <button class="btn small" data-tool="photos" title="Déplacer, tourner et relier les photos">✋ Photos</button>
        <button class="btn small" data-tool="line" title="Tracer les murs des pièces : un clic par angle, double-clic ou Échap pour finir">✏ Traits</button>
        <button class="btn small" data-tool="text" title="Cliquez pour écrire ; cliquez un texte pour le modifier, glissez-le pour le déplacer">T Texte</button>
        <select class="plan-text-size" data-text-size title="Taille du texte" hidden>
          <option value="14">Petit</option><option value="20" selected>Moyen</option><option value="32">Grand</option><option value="48">Très grand</option>
        </select>
        <button class="btn small" data-tool="move" title="Glissez un trait pour le déplacer, ou une extrémité pour l’allonger ou le réorienter (les murs raccordés suivent)">✥ Déplacer</button>
        <button class="btn small" data-tool="erase" title="Cliquez un trait ou un texte pour l’effacer">⌫ Effacer</button>
        <button class="btn small" data-draw-undo disabled title="Défaire la dernière modification du dessin (Ctrl+Z)">↶ Défaire</button>
      </span>
      <span class="plan-rooms">
        <button class="btn small primary" data-place-rooms title="Dessine chaque pièce (d’après les coins du plafond indiqués dans l’éditeur, onglet Pièce), y place ses photos et les relie">🏠 Placer les pièces</button>
        <label title="Hauteur sous plafond, commune à toutes les pièces">↕ <input type="number" data-ceiling min="1.8" max="8" step="0.05"> m</label>
      </span>
      <label class="plan-zoom" title="Agrandissement d’une photo quand on clique dessus">🔍 ×<select data-zoom>${[3, 5, 8, 10, 12, 16].map((z) => `<option value="${z}" ${z === ZOOM ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
      <span class="plan-modes">
        <button class="btn small" data-mode="sphere" title="Photos en sphères">◯ Sphères</button>
        <button class="btn small" data-mode="rect" title="Photos à plat : chaque lien aboutit à sa position dans l’image">▭ Rectangles</button>
      </span>
      <span class="note plan-help">Glisser : déplacer · <b>Ctrl + glisser</b> une photo : la tourner · déposer une photo sur une autre : les relier. Liens <span class="plan-key auto">automatiques</span> et <span class="plan-key manual">placés à la main</span></span>
      ${manualButton('plan')}</span>
    </div>
    <div class="plan-view">
      <div class="plan-world"></div>
    </div>
  </div>`;
  bindManualButtons(container);
  const view = container.querySelector('.plan-view');
  const world = container.querySelector('.plan-world');
  const help = container.querySelector('.plan-help');
  const helpDefault = help.innerHTML;
  let zoom = 1, panX = 0, panY = 0;
  const applyView = () => (world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`);

  // Vignettes des photos.
  const thumbs = new Map();
  await Promise.all(
    list.map(async (p) => {
      const b = await db.getBlob(p.id + ':thumb');
      if (b) thumbs.set(p.id, URL.createObjectURL(b));
    })
  );

  function render() {
    const { w, h } = picSize(mode);
    world.innerHTML = `<svg class="plan-drawing" width="1" height="1"></svg>
      <svg class="plan-roomsel" width="1" height="1"></svg>
      ${zone ? `<div class="plan-pool" style="left:${zone.x}px;top:${zone.y}px;width:${zone.w}px;height:${zone.h}px"><span>Photos non placées (${pool.size}) — glissez-en une sur le plan pour la placer, ou sur une photo pour les relier</span></div>` : ''}
      <svg class="plan-links" width="1" height="1"></svg>
      ${list
        .map(
          (p) => `<div class="plan-node ${mode}${p.id === selected ? ' selected' : ''}" data-id="${p.id}" style="width:${w * zf(p.id)}px;margin:${(-h * zf(p.id)) / 2}px 0 0 ${(-w * zf(p.id)) / 2}px">
            <div class="plan-pic" style="width:${w * zf(p.id)}px;height:${h * zf(p.id)}px;${thumbs.has(p.id) ? `background-image:url('${thumbs.get(p.id)}');` : ''}"></div>
            ${p.id === selected ? `<input class="plan-name-input" value="${escapeHtml(p.name)}" aria-label="Nom de la photo" title="Modifier le nom (Entrée pour valider)">` : `<span class="plan-name">${escapeHtml(p.name)}</span>`}
            <div class="plan-actions"><button class="btn small" data-act="view">👁 Voir</button><button class="btn small" data-act="edit">✏ Éditer</button><button class="btn small" data-act="link">🔗 Relier</button></div>
          </div>`
        )
        .join('')}
      <svg class="plan-links over" width="1" height="1"></svg>
      <svg class="plan-contacts" width="1" height="1"></svg>`;
    container.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    world.querySelectorAll('.plan-node [data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.closest('.plan-node').dataset.id;
        if (b.dataset.act === 'link') startLink(id);
        else onOpen(id, b.dataset.act);
      })
    );
    placeNodes();
    drawLinks();
    drawDrawing();
    drawRooms();
    bindNameInput();
  }

  // Nom de la photo agrandie : Entrée ou clic ailleurs pour valider, Échap pour annuler.
  function bindNameInput() {
    const inp = world.querySelector('.plan-name-input');
    if (!inp) return;
    const id = inp.closest('.plan-node').dataset.id;
    const p = byId.get(id);
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') inp.blur();
      if (e.key === 'Escape') {
        inp.value = p.name;
        inp.blur();
      }
    });
    inp.addEventListener('blur', async () => {
      const name = inp.value.trim();
      if (!name || name === p.name) {
        inp.value = p.name;
        return;
      }
      p.name = name;
      if (onRename) await onRename(id, name);
      else await db.updatePhoto(id, (cur) => ({ ...cur, name }));
      toast(`Photo renommée « ${name} ».`);
    });
  }

  function select(id) {
    if (selected === id) return;
    selected = id;
    render();
    // La photo agrandie reste entièrement visible : on décale la vue si besoin.
    const pic = world.querySelector('.plan-node.selected .plan-pic');
    if (!pic) return;
    const r = pic.getBoundingClientRect(), v = view.getBoundingClientRect();
    const dx = r.left < v.left + 10 ? v.left + 10 - r.left : r.right > v.right - 10 ? Math.max(v.left + 10 - r.left, v.right - 10 - r.right) : 0;
    const dy = r.top < v.top + 10 ? v.top + 10 - r.top : r.bottom + 90 > v.bottom ? Math.max(v.top + 10 - r.top, v.bottom - 90 - r.bottom) : 0;
    if (dx || dy) {
      panX += dx;
      panY += dy;
      applyView();
    }
  }

  // ---------- dessin : murs et textes ----------
  function drawDrawing() {
    const svg = world.querySelector('.plan-drawing');
    if (!svg) return;
    const k = scale();
    let html = '';
    drawing.lines.forEach((l, i) => {
      const a = `x1="${l.x1 * k}" y1="${l.y1 * k}" x2="${l.x2 * k}" y2="${l.y2 * k}"`;
      html += `<line class="wall" ${a}/><line class="wall-hit" data-line="${i}" ${a}/>`;
    });
    drawing.texts.forEach((t, i) => {
      html += `<text class="plan-label" data-text="${i}" x="${t.x * k}" y="${t.y * k}" font-size="${(t.size || 20) * k}">${escapeHtml(t.text)}</text>`;
    });
    if (tool === 'line' || tool === 'move') {
      // Extrémités existantes (points d'accroche, poignées en mode Déplacer) et aperçu du trait en cours.
      const ends = new Set();
      drawing.lines.forEach((l) => [[l.x1, l.y1], [l.x2, l.y2]].forEach(([x, y]) => ends.add(x + ',' + y)));
      ends.forEach((s) => {
        const [x, y] = s.split(',').map(Number);
        html += `<circle class="wall-end" data-end="${s}" cx="${x * k}" cy="${y * k}" r="${tool === 'move' ? 6 : 3.5}"/>`;
      });
      if (poly && hover) html += `<line class="wall preview" x1="${poly.last.x * k}" y1="${poly.last.y * k}" x2="${hover.x * k}" y2="${hover.y * k}"/>`;
      if (hover) html += `<circle class="wall-cursor" cx="${hover.x * k}" cy="${hover.y * k}" r="5"/>`;
    }
    svg.innerHTML = html;
  }

  async function saveDrawing() {
    container.querySelector('[data-draw-undo]').disabled = !undoStack.length;
    await db.putPlanDrawing(drawing);
  }
  function pushUndo() {
    undoStack.push(JSON.stringify(drawing));
    if (undoStack.length > 100) undoStack.shift();
  }
  async function undoDrawing() {
    if (!undoStack.length) return;
    drawing = JSON.parse(undoStack.pop());
    poly = null;
    drawDrawing();
    await saveDrawing();
  }

  // Accroche : extrémité existante, sinon trait horizontal / vertical, sinon alignement sur une
  // extrémité (Alt : sans accroche).
  // exclude : extrémités (« i:1 » / « i:2 ») qui ne servent pas d'accroche (celles que l'on déplace).
  const endsOf = (exclude) =>
    drawing.lines.flatMap((l, i) => [
      ...(exclude && exclude.has(i + ':1') ? [] : [{ x: l.x1, y: l.y1 }]),
      ...(exclude && exclude.has(i + ':2') ? [] : [{ x: l.x2, y: l.y2 }]),
    ]);
  function snap(pt, from, free, exclude = null) {
    if (free) return { x: Math.round(pt.x), y: Math.round(pt.y) };
    const tol = 12 / zoom / scale();
    let best = null, bd = tol;
    const ends = endsOf(exclude);
    {
      for (const q of ends) {
        const d = Math.hypot(q.x - pt.x, q.y - pt.y);
        if (d < bd) (bd = d), (best = q);
      }
    }
    if (best) return { ...best };
    let { x, y } = pt;
    if (from) {
      const a = (Math.abs(Math.atan2(y - from.y, x - from.x)) * 180) / Math.PI;
      if (a < 7 || a > 173) y = from.y;
      else if (Math.abs(a - 90) < 7) x = from.x;
    }
    // Alignement sur l'extrémité la plus proche en x et en y (sauf axe déjà fixé par l'accroche).
    let bx = tol, by = tol, ax = x, ay = y;
    for (const q of ends) {
      if (x !== (from && from.x) && Math.abs(q.x - x) < bx) (bx = Math.abs(q.x - x)), (ax = q.x);
      if (y !== (from && from.y) && Math.abs(q.y - y) < by) (by = Math.abs(q.y - y)), (ay = q.y);
    }
    x = ax;
    y = ay;
    return { x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2 };
  }

  function endPoly() {
    poly = null;
    drawDrawing();
  }

  function editText(i, pt) {
    const t = i >= 0 ? drawing.texts[i] : null;
    const at = t ? { x: t.x, y: t.y } : pt;
    const inp = document.createElement('input');
    inp.className = 'plan-text-input';
    inp.placeholder = 'Texte (Entrée pour valider)';
    inp.value = t ? t.text : '';
    inp.style.left = at.x * scale() * zoom + panX + 'px';
    inp.style.top = at.y * scale() * zoom + panY + 'px';
    inp.style.fontSize = Math.max(12, Math.min(40, (t ? t.size : textSize) * scale() * zoom)) + 'px';
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    view.appendChild(inp);
    inp.focus();
    inp.select();
    let finished = false;
    const done = async (ok) => {
      if (finished) return;
      finished = true;
      const v = inp.value.trim();
      inp.remove();
      if (!ok || (t && v === t.text) || (!t && !v)) return;
      pushUndo();
      if (t && v) t.text = v;
      else if (t) drawing.texts.splice(i, 1);
      else drawing.texts.push({ x: Math.round(at.x), y: Math.round(at.y), text: v, size: textSize });
      drawDrawing();
      await saveDrawing();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => done(true));
  }

  async function drawClick(e, target) {
    const m = toWorld(e);
    const pt = { x: m.x / scale(), y: m.y / scale() };
    if (tool === 'line') {
      const now = performance.now();
      const dbl = lastClick && now - lastClick.t < 350 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 8;
      lastClick = { t: now, x: e.clientX, y: e.clientY };
      if (dbl) return endPoly();
      const q = snap(pt, poly && poly.last, e.altKey);
      if (poly && (q.x !== poly.last.x || q.y !== poly.last.y)) {
        pushUndo();
        drawing.lines.push({ x1: poly.last.x, y1: poly.last.y, x2: q.x, y2: q.y });
        await saveDrawing();
      }
      poly = { last: q };
      hover = q;
      drawDrawing();
    } else if (tool === 'text') {
      const tEl = target.closest && target.closest('[data-text]');
      editText(tEl ? +tEl.dataset.text : -1, pt);
    } else if (tool === 'erase') {
      const l = target.closest && target.closest('[data-line]');
      const t = target.closest && target.closest('[data-text]');
      if (!l && !t) return;
      pushUndo();
      if (l) drawing.lines.splice(+l.dataset.line, 1);
      else drawing.texts.splice(+t.dataset.text, 1);
      drawDrawing();
      await saveDrawing();
    }
  }

  const TOOL_HELP = {
    line: '✏ <b>Traits</b> : cliquez chaque angle des murs ; <b>double-clic</b> ou <b>Échap</b> pour finir. <b>Glissez un trait ou une extrémité</b> pour le déplacer. Accroches automatiques (<b>Alt</b> : sans).',
    text: 'T <b>Texte</b> : cliquez pour écrire (nom de pièce…), cliquez un texte pour le modifier (vide = supprimé), glissez-le pour le déplacer.',
    move: '✥ <b>Déplacer</b> : glissez un trait pour le déplacer, une extrémité (rond) pour l’allonger ou le réorienter, un texte pour le déplacer. Les murs raccordés suivent ; <b>Alt</b> : sans accroche.',
    erase: '⌫ <b>Effacer</b> : cliquez un trait ou un texte.',
  };
  function setTool(t) {
    tool = t;
    poly = null;
    hover = null;
    if (linkFrom) stopLink();
    view.classList.toggle('drawing', t !== 'photos');
    view.dataset.tool = t;
    container.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    container.querySelector('[data-text-size]').hidden = t !== 'text';
    help.innerHTML = TOOL_HELP[t] || helpDefault;
    drawDrawing();
  }

  function placeNodes() {
    const { w, h } = picSize(mode);
    world.querySelectorAll('.plan-node').forEach((n) => {
      const id = n.dataset.id;
      const q = disp(pos.get(id));
      const f = zf(id);
      n.style.transform = `translate(${q.x}px, ${q.y}px)`;
      // Texture décalée selon la rotation : le cap `rot` est au centre de la vignette.
      const pic = n.querySelector('.plan-pic');
      const tw = (mode === 'rect' ? w : 2 * w) * f;
      pic.style.backgroundSize = `${tw}px ${h * f}px`;
      pic.style.backgroundPositionX = `${(w * f) / 2 - (rot.get(id) / 360 + 0.5) * tw}px`;
    });
  }

  function contact(p, hs) {
    const o = contactOffset(mode, rot.get(p.id), hs.yaw, hs.pitch);
    const c = disp(pos.get(p.id));
    const f = zf(p.id);
    return { x: c.x + o.x * f, y: c.y + o.y * f, hidden: o.hidden };
  }

  function drawLinks() {
    let lines = '', over = '', dots = '', hits = '';
    const sel = selectedPair();
    list.forEach((p) =>
      p.hotspots.forEach((hs, k) => {
        if (!byId.has(hs.target)) return;
        const q = byId.get(hs.target);
        const a = contact(p, hs);
        const back = q.hotspots.find((x) => x.target === p.id);
        const b = back ? contact(q, back) : disp(pos.get(q.id));
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const cls = (hs.auto ? 'auto' : 'manual') + (sel && sel.some((x) => x.hs === hs) ? ' selected' : '');
        // Trait invisible, plus large, pour sélectionner le lien d'un clic.
        hits += `<line class="link-hit" data-link="${p.id}" data-k="${k}" x1="${a.x}" y1="${a.y}" x2="${mx}" y2="${my}"><title>Lien « ${escapeHtml(p.name)} » → « ${escapeHtml(q.name)} » : cliquer pour le sélectionner</title></line>`;
        // Chaque sens est dessiné sur la moitié du trait qui part de son point de contact.
        const seg = `<line class="${cls}${a.hidden ? ' hidden' : ''}" x1="${a.x}" y1="${a.y}" x2="${mx}" y2="${my}"/>`;
        lines += `<line class="pair" x1="${a.x}" y1="${a.y}" x2="${mx}" y2="${my}"/>` + seg;
        // Copie translucide au-dessus des photos : le lien reste visible là où il passe sur une image.
        over += seg;
        dots += `<circle class="contact ${cls}${a.hidden ? ' hidden' : ''}" data-contact="${p.id}" data-k="${k}" cx="${a.x}" cy="${a.y}" r="7"><title>Lien vers « ${escapeHtml(q.name)} » : glisser pour le placer</title></circle>`;
      })
    );
    world.querySelector('.plan-links').innerHTML = lines;
    world.querySelector('.plan-links.over').innerHTML = over;
    world.querySelector('.plan-contacts').innerHTML = hits + dots;
  }

  // ---------- sélection et suppression d'un lien ----------
  const hsKey = (hs, k) => hs.id || 'k' + k;
  // Lien sélectionné et son lien retour : [{ p, hs, k }].
  function selectedPair() {
    if (!selLink) return null;
    const p = byId.get(selLink.from);
    if (!p) return null;
    const k = p.hotspots.findIndex((h, i) => hsKey(h, i) === selLink.hid);
    if (k < 0) return null;
    const hs = p.hotspots[k];
    const out = [{ p, hs, k }];
    const q = byId.get(hs.target);
    if (q) {
      const kb = q.hotspots.findIndex((x) => x.target === p.id);
      if (kb >= 0) out.push({ p: q, hs: q.hotspots[kb], k: kb });
    }
    return out;
  }
  function selectLink(pid, k) {
    const p = byId.get(pid);
    selLink = { from: pid, hid: hsKey(p.hotspots[k], k) };
    const pair = selectedPair();
    const q = byId.get(p.hotspots[k].target);
    help.innerHTML = `Lien « ${escapeHtml(p.name)} » ${pair.length > 1 ? '↔' : '→'} « ${escapeHtml(q.name)} » sélectionné :
      <button class="btn small danger" data-del-link="both">🗑 Supprimer le lien${pair.length > 1 ? ' (les deux sens)' : ''}</button>
      ${pair.length > 1 ? `<button class="btn small" data-del-link="one">Supprimer seulement « ${escapeHtml(p.name)} » → « ${escapeHtml(q.name)} »</button>` : ''}
      <button class="btn small" data-del-link="cancel">Annuler</button>`;
    help.querySelectorAll('[data-del-link]').forEach((b) =>
      b.addEventListener('click', () => (b.dataset.delLink === 'cancel' ? unselectLink() : deleteLink(b.dataset.delLink === 'both')))
    );
    drawLinks();
  }
  function unselectLink() {
    if (!selLink) return;
    selLink = null;
    help.innerHTML = TOOL_HELP[tool] || helpDefault;
    drawLinks();
  }
  async function deleteLink(both) {
    const pair = selectedPair();
    if (!pair) return unselectLink();
    const gone = both ? pair : pair.slice(0, 1);
    for (const { p, hs } of gone) {
      p.hotspots = p.hotspots.filter((h) => h !== hs);
      // La photo reste à sa place sur le plan, même sans lien.
      if (pos.has(p.id)) {
        p.mapPos = p.mapPos || { x: Math.round(pos.get(p.id).x), y: Math.round(pos.get(p.id).y) };
        p.mapPlaced = true;
      }
      await db.updatePhoto(p.id, (cur) => ({
        ...cur,
        mapPos: p.mapPos || cur.mapPos,
        mapPlaced: p.mapPlaced || cur.mapPlaced,
        hotspots: (cur.hotspots || []).filter((h) => !(hs.id ? h.id === hs.id : h.target === hs.target && h.yaw === hs.yaw)),
      }));
    }
    const names = `« ${pair[0].p.name} » et « ${byId.get(pair[0].hs.target).name} »`;
    selLink = null;
    help.innerHTML = TOOL_HELP[tool] || helpDefault;
    await layout();
    render();
    toast(both ? `Lien supprimé entre ${names}.` : `Lien supprimé dans un sens (${names}).`);
  }

  function fit() {
    const pts = [...pos.values(), ...drawing.lines.flatMap((l) => [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]), ...drawing.texts].map(disp);
    if (!pts.length) return;
    const r = view.getBoundingClientRect();
    const { w, h } = picSize(mode);
    let minX = Math.min(...pts.map((q) => q.x)) - w, maxX = Math.max(...pts.map((q) => q.x)) + w;
    let minY = Math.min(...pts.map((q) => q.y)) - h, maxY = Math.max(...pts.map((q) => q.y)) + h + 40;
    if (zone) {
      minX = Math.min(minX, zone.x);
      maxX = Math.max(maxX, zone.x + zone.w);
      maxY = Math.max(maxY, zone.y + zone.h);
    }
    zoom = Math.min(1.5, Math.max(0.15, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    panX = r.width / 2 - ((minX + maxX) / 2) * zoom;
    panY = r.height / 2 - ((minY + maxY) / 2) * zoom;
    applyView();
  }

  // ---------- création de liens ----------
  function startLink(id) {
    // La photo agrandie reprend sa taille : les autres photos doivent rester accessibles au clic.
    if (selected) {
      selected = null;
      render();
    }
    linkFrom = id;
    view.classList.add('linking');
    help.innerHTML = `🔗 Cliquez la photo à relier à « ${escapeHtml(byId.get(id).name)} » — <button class="btn small" data-cancel-link>Annuler</button>`;
    help.querySelector('[data-cancel-link]').addEventListener('click', stopLink);
  }
  function stopLink() {
    linkFrom = null;
    view.classList.remove('linking');
    help.innerHTML = helpDefault;
  }

  // Place `id` près de `other`, dans la première direction libre.
  function placeNear(id, other) {
    const o = pos.get(other);
    for (const ang of [90, 0, 180, 270, 45, 135, 225, 315]) {
      const a = (ang * Math.PI) / 180;
      const c = { x: o.x + SPACING * Math.sin(a), y: o.y - SPACING * Math.cos(a) };
      const free = list.every((p) => p.id === id || pool.has(p.id) || Math.hypot(pos.get(p.id).x - c.x, pos.get(p.id).y - c.y) > SPACING * 0.6);
      if (free) return c;
    }
    return { x: o.x + SPACING * 1.5, y: o.y };
  }

  // Liens automatiques réciproques entre deux photos, orientés d'après le plan.
  async function createLink(aId, bId) {
    if (aId === bId) return;
    const a = byId.get(aId), b = byId.get(bId);
    if (pool.has(aId) && !pool.has(bId)) pos.set(aId, placeNear(aId, bId));
    else if (pool.has(bId)) pos.set(bId, placeNear(bId, aId));
    a.mapPos = { x: Math.round(pos.get(aId).x), y: Math.round(pos.get(aId).y) };
    b.mapPos = { x: Math.round(pos.get(bId).x), y: Math.round(pos.get(bId).y) };
    const add = (p, q) => {
      if (p.hotspots.some((x) => x.target === q.id)) return null;
      const hs = { id: newHotspotId(), target: q.id, yaw: +bearing(p.mapPos, q.mapPos).toFixed(2), pitch: 0, label: '', auto: true };
      p.hotspots.push(hs);
      return hs;
    };
    const ha = add(a, b), hb = add(b, a);
    for (const [p, hs] of [[a, ha], [b, hb]]) {
      await db.updatePhoto(p.id, (cur) => ({ ...cur, mapPos: p.mapPos, hotspots: hs ? [...(cur.hotspots || []), hs] : cur.hotspots || [] }));
    }
    toast(ha || hb ? `« ${a.name} » et « ${b.name} » sont reliées.` : 'Ces deux photos sont déjà reliées.');
    await layout();
    render();
  }

  // ---------- interactions ----------
  let drag = null;
  let lastTap = { id: null, t: 0 };
  const toWorld = (e) => {
    const r = view.getBoundingClientRect();
    return { x: (e.clientX - r.left - panX) / zoom, y: (e.clientY - r.top - panY) / zoom };
  };

  view.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, select')) return;
    if (tool !== 'photos') {
      view.setPointerCapture(e.pointerId);
      const tEl = (tool === 'text' || tool === 'move') && e.target.closest('[data-text]');
      // Déplacer un trait : outil Déplacer, ou outil Traits quand aucun trait n'est en cours.
      const canMove = tool === 'move' || (tool === 'line' && !poly);
      const endEl = canMove && e.target.closest('[data-end]');
      const segEl = canMove && e.target.closest('[data-line]');
      if (endEl || segEl) {
        // Extrémités concernées : celles qui coïncident avec le point saisi (ou avec les deux bouts du
        // trait saisi), pour que les murs raccordés suivent.
        const at = (x, y) => {
          const refs = [];
          drawing.lines.forEach((l, i) => {
            if (l.x1 === x && l.y1 === y) refs.push([i, 1]);
            if (l.x2 === x && l.y2 === y) refs.push([i, 2]);
          });
          return refs;
        };
        let groups;
        if (endEl) {
          const [x, y] = endEl.dataset.end.split(',').map(Number);
          groups = [{ x, y, refs: at(x, y) }];
        } else {
          const l = drawing.lines[+segEl.dataset.line];
          groups = [{ x: l.x1, y: l.y1, refs: at(l.x1, l.y1) }, { x: l.x2, y: l.y2, refs: at(l.x2, l.y2) }];
        }
        drag = { kind: endEl ? 'dend' : 'dseg', groups, before: JSON.stringify(drawing), sx: e.clientX, sy: e.clientY, moved: false };
        return;
      }
      if (tEl) {
        const i = +tEl.dataset.text;
        drag = { kind: 'dtext', i, sx: e.clientX, sy: e.clientY, start: { ...drawing.texts[i] }, moved: false, target: e.target };
      } else {
        drag = { kind: 'pan', draw: true, sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false, target: e.target };
      }
      return;
    }
    const crot = e.target.closest('[data-compass-rot]'), cmove = e.target.closest('[data-compass-move]');
    const rrot = e.target.closest('[data-room-rot]'), rcorner = e.target.closest('[data-room-corner]'), rhit = e.target.closest('[data-room]');
    if (crot || cmove) {
      view.setPointerCapture(e.pointerId);
      drag = { kind: crot ? 'compass-rot' : 'compass-move', sx: e.clientX, sy: e.clientY, start: { ...compassPos() }, moved: false };
      return;
    }
    if (rrot || rcorner || (rhit && !e.target.closest('.plan-node'))) {
      view.setPointerCapture(e.pointerId);
      const key = rhit ? rhit.dataset.room : selRoom;
      if (rhit && selRoom !== key) selectRoom(key);
      const m = toWorld(e);
      drag = { kind: rrot ? 'room-rot' : rcorner ? 'room-size' : 'room-move', key, corner: rcorner ? +rcorner.dataset.roomCorner : 0, sx: e.clientX, sy: e.clientY, p0: [m.x / scale(), m.y / scale()], snap: roomSnapshot(roomOf(key)), moved: false };
      return;
    }
    const dot = e.target.closest('[data-contact]');
    const node = e.target.closest('.plan-node');
    const hit = e.target.closest('[data-link]');
    view.setPointerCapture(e.pointerId);
    if (hit) {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false, link: { id: hit.dataset.link, k: +hit.dataset.k } };
    } else if (dot) {
      drag = { kind: 'contact', id: dot.dataset.contact, k: +dot.dataset.k, moved: false, sx: e.clientX, sy: e.clientY };
    } else if (node && (e.ctrlKey || e.metaKey) && e.target.closest('.plan-pic')) {
      drag = { kind: 'rotate', id: node.dataset.id, sx: e.clientX, start: rot.get(node.dataset.id), moved: false };
    } else if (node) {
      drag = { kind: 'node', id: node.dataset.id, sx: e.clientX, sy: e.clientY, start: { ...pos.get(node.dataset.id) }, moved: false };
    } else {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false };
    }
  });

  view.addEventListener('pointermove', (e) => {
    if (!drag) {
      if (tool === 'line') {
        const m = toWorld(e);
        hover = snap({ x: m.x / scale(), y: m.y / scale() }, poly && poly.last, e.altKey);
        drawDrawing();
      }
      return;
    }
    const dx = e.clientX - (drag.sx || 0), dy = e.clientY - (drag.sy || 0);
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.kind === 'dend' || drag.kind === 'dseg') {
      const set = (g, x, y) => g.refs.forEach(([i, w]) => Object.assign(drawing.lines[i], w === 1 ? { x1: x, y1: y } : { x2: x, y2: y }));
      const ddx = dx / zoom / scale(), ddy = dy / zoom / scale();
      if (drag.kind === 'dend') {
        const g = drag.groups[0];
        const exclude = new Set(g.refs.map(([i, w]) => i + ':' + w));
        // Un seul trait : accroche horizontale / verticale par rapport à son autre bout.
        let from = null;
        if (g.refs.length === 1) {
          const [i, w] = g.refs[0];
          const l = drawing.lines[i];
          from = w === 1 ? { x: l.x2, y: l.y2 } : { x: l.x1, y: l.y1 };
        }
        const q = snap({ x: g.x + ddx, y: g.y + ddy }, from, e.altKey, exclude);
        set(g, q.x, q.y);
      } else {
        const r = (v) => Math.round(v * 2) / 2;
        drag.groups.forEach((g) => set(g, r(g.x + ddx), r(g.y + ddy)));
      }
      drawDrawing();
    } else if (drag.kind === 'dtext') {
      const t = drawing.texts[drag.i];
      t.x = Math.round(drag.start.x + dx / zoom / scale());
      t.y = Math.round(drag.start.y + dy / zoom / scale());
      drawDrawing();
    } else if (drag.kind === 'pan') {
      panX = drag.px + dx;
      panY = drag.py + dy;
      applyView();
    } else if (drag.kind === 'room-move' || drag.kind === 'room-size' || drag.kind === 'room-rot') {
      roomDrag(e, drag);
    } else if (drag.kind === 'compass-move' || drag.kind === 'compass-rot') {
      if (drag.kind === 'compass-move') drawing.compass = { x: Math.round(drag.start.x + dx / zoom / scale()), y: Math.round(drag.start.y + dy / zoom / scale()) };
      else {
        const m = toWorld(e);
        const cp = compassPos();
        let n = (Math.atan2(m.x / scale() - cp.x, -(m.y / scale() - cp.y)) * 180) / Math.PI;
        n = Math.round(e.shiftKey ? n / 15 * 1 : n) * (e.shiftKey ? 15 : 1);
        setPlanNorth(((n % 360) + 360) % 360);
      }
      drawRooms();
    } else if (drag.kind === 'node') {
      // Dès qu'on déplace une photo, l'agrandissement disparaît.
      if (selected) {
        selected = null;
        render();
      }
      pos.set(drag.id, { x: drag.start.x + dx / zoom / scale(), y: drag.start.y + dy / zoom / scale() });
      placeNodes();
      drawLinks();
    } else if (drag.kind === 'rotate') {
      // Faire glisser vers la droite fait tourner la vue vers la gauche, comme dans la visionneuse.
      const { w } = picSize(mode);
      const span = mode === 'rect' ? 360 : 180;
      rot.set(drag.id, wrap180(drag.start - (dx / zoom / (w * zf(drag.id))) * span));
      placeNodes();
      drawLinks();
    } else if (drag.kind === 'contact') {
      const p = byId.get(drag.id);
      const c = disp(pos.get(p.id));
      const m = toWorld(e);
      const d = contactFromOffset(mode, rot.get(p.id), (m.x - c.x) / zf(p.id), (m.y - c.y) / zf(p.id));
      Object.assign(p.hotspots[drag.k], d, { auto: false });
      drawLinks();
    }
  });

  view.addEventListener('pointerup', async (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === 'dend' || d.kind === 'dseg') {
      // Outil Traits : un simple clic sur un trait commence un nouveau mur à cet endroit.
      if (!d.moved) return tool === 'line' ? drawClick(e, e.target) : undefined;
      // Traits devenus nuls (extrémité ramenée sur l'autre) : supprimés.
      drawing.lines = drawing.lines.filter((l) => l.x1 !== l.x2 || l.y1 !== l.y2);
      undoStack.push(d.before);
      drawDrawing();
      return saveDrawing();
    }
    if (d.kind === 'dtext') {
      if (!d.moved) return tool === 'text' ? editText(d.i) : undefined;
      const moved = drawing.texts[d.i];
      drawing.texts[d.i] = d.start;
      pushUndo();
      drawing.texts[d.i] = moved;
      return saveDrawing();
    }
    if (d.draw && !d.moved) return drawClick(e, d.target);
    if (d.kind.startsWith('room-')) return d.moved ? roomDrop(d) : undefined;
    if (d.kind.startsWith('compass-')) return d.moved ? compassDrop(d) : undefined;
    if (d.kind === 'node' && !d.moved) {
      const now = performance.now();
      if (linkFrom && linkFrom !== d.id) {
        const from = linkFrom;
        stopLink();
        await createLink(from, d.id);
        return;
      }
      // Double-clic (ou double appui) : la photo s'ouvre dans la visionneuse.
      if (lastTap.id === d.id && now - lastTap.t < 400) return onOpen(d.id, 'view');
      lastTap = { id: d.id, t: now };
      select(d.id);
      return;
    }
    // Clic sur un lien (trait ou point de contact) : il est sélectionné.
    if (!d.moved && (d.link || d.kind === 'contact')) {
      if (selected) {
        selected = null;
        render();
      }
      return d.link ? selectLink(d.link.id, d.link.k) : selectLink(d.id, d.k);
    }
    // Clic dans le vide : la photo agrandie reprend sa taille, le lien et la pièce sélectionnés sont oubliés.
    if (d.kind === 'pan' && !d.moved && !d.draw && selRoom) selectRoom(null);
    if (d.kind === 'pan' && !d.moved && !d.draw && (selected || selLink)) {
      unselectLink();
      if (selected) {
        selected = null;
        render();
      }
      return;
    }
    if (!d.moved) return;
    if (d.kind === 'rotate') {
      const r = +rot.get(d.id).toFixed(1);
      await db.updatePhoto(d.id, (cur) => ({ ...cur, mapRot: r }));
    } else if (d.kind === 'contact') {
      const hs = byId.get(d.id).hotspots[d.k];
      await db.updatePhoto(d.id, (cur) => ({
        ...cur,
        hotspots: (cur.hotspots || []).map((x, k) => ((hs.id ? x.id === hs.id : k === d.k) ? { ...x, yaw: hs.yaw, pitch: hs.pitch, auto: false } : x)),
      }));
    } else if (d.kind === 'node') {
      // Déposée sur une autre photo : on les relie.
      const p = pos.get(d.id);
      const target = list.find((q) => q.id !== d.id && Math.hypot(pos.get(q.id).x - p.x, pos.get(q.id).y - p.y) < 60 / scale());
      if (target) {
        if (pool.has(d.id)) pos.set(d.id, d.start);
        await createLink(d.id, target.id);
        return;
      }
      const q = disp(p);
      const inPool = zone && q.x > zone.x && q.x < zone.x + zone.w && q.y > zone.y && q.y < zone.y + zone.h;
      if (pool.has(d.id)) {
        // Photo non placée : déposée hors de sa zone, elle prend place sur le plan (sans lien).
        if (inPool) {
          pos.set(d.id, d.start);
          placeNodes();
          drawLinks();
          return;
        }
        const mp = { x: Math.round(p.x), y: Math.round(p.y) };
        Object.assign(byId.get(d.id), { mapPos: mp, mapPlaced: true });
        await db.updatePhoto(d.id, (cur) => ({ ...cur, mapPos: mp, mapPlaced: true }));
        await layout();
        render();
        return;
      }
      if (inPool && !isLinked(d.id)) {
        // Photo placée sans lien ramenée dans la zone : elle n'est plus sur le plan.
        const ph = byId.get(d.id);
        delete ph.mapPos;
        ph.mapPlaced = false;
        await db.updatePhoto(d.id, (cur) => {
          const { mapPos, ...rest } = cur;
          return { ...rest, mapPlaced: false };
        });
        await layout();
        render();
        return;
      }
      byId.get(d.id).mapPos = { x: Math.round(p.x), y: Math.round(p.y) };
      const changed = retargetAutoLinks(list, pos, d.id);
      drawLinks();
      await db.updatePhoto(d.id, (cur) => ({ ...cur, mapPos: byId.get(d.id).mapPos }));
      for (const id of changed) {
        const hs = byId.get(id).hotspots;
        // On ne recopie que les caps des liens automatiques, sans écraser le reste de la fiche.
        await db.updatePhoto(id, (cur) => ({
          ...cur,
          hotspots: (cur.hotspots || []).map((h) => {
            const n = hs.find((x) => x.id === h.id);
            return n && h.auto ? { ...h, yaw: n.yaw } : h;
          }),
        }));
      }
    }
  });

  view.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = view.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0015);
      const nz = Math.min(3, Math.max(0.1, zoom * f));
      panX = mx - ((mx - panX) * nz) / zoom;
      panY = my - ((my - panY) * nz) / zoom;
      zoom = nz;
      applyView();
    },
    { passive: false }
  );
  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input, select, textarea')) return;
    if (e.key === 'Escape' && linkFrom) stopLink();
    if (e.key === 'Escape' && poly) endPoly();
    if (e.key === 'Escape' && selected && !linkFrom && !poly) {
      selected = null;
      render();
    }
    if (e.key === 'Escape' && selLink) unselectLink();
    if ((e.key === 'Delete' || e.key === 'Backspace') && selLink) {
      e.preventDefault();
      deleteLink(true);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoDrawing();
    }
  };
  window.addEventListener('keydown', onKey);
  container.querySelector('[data-fit]').addEventListener('click', fit);
  // ---------- pièces sur le plan (sélection, déplacement, taille, rotation) et flèche nord ----------
  const PX = 50; // pixels du plan par mètre
  drawing.rooms = drawing.rooms || [];
  setPlanNorth(drawing.north || 0);
  let selRoom = null;
  const roomOf = (key) => drawing.rooms.find((r) => r.key === key);
  // Murs et nom d'une pièce, d'après son modèle (remplacent les précédents).
  function writeRoomWalls(r) {
    drawing.lines = drawing.lines.filter((l) => l.room !== r.key);
    drawing.texts = drawing.texts.filter((t) => t.room !== r.key);
    const c = roomCorners(r, PX);
    const rd = (v) => Math.round(v * 2) / 2;
    c.forEach((p, i) => {
      const q = c[(i + 1) % 4];
      drawing.lines.push({ x1: rd(p[0]), y1: rd(p[1]), x2: rd(q[0]), y2: rd(q[1]), room: r.key });
    });
    drawing.texts.push({ x: Math.round(r.cx), y: Math.round(Math.min(...c.map((p) => p[1])) + 20), text: `${r.name} (${r.w.toFixed(1)} × ${r.l.toFixed(1)} m)`, size: 14, room: r.key });
  }
  function compassPos() {
    if (drawing.compass) return drawing.compass;
    const pts = [...pos.values()];
    return pts.length ? { x: Math.min(...pts.map((q) => q.x)) - 90, y: Math.min(...pts.map((q) => q.y)) - 40 } : { x: -90, y: -60 };
  }
  function drawRooms() {
    const svg = world.querySelector('.plan-roomsel');
    if (!svg) return;
    const k = scale();
    const P = (p) => `${p[0] * k},${p[1] * k}`;
    let html = '';
    for (const r of drawing.rooms) {
      const c = roomCorners(r, PX);
      html += `<polygon class="room-hit" data-room="${escapeHtml(r.key)}" points="${c.map(P).join(' ')}"><title>${escapeHtml(r.name)} : cliquer pour la sélectionner</title></polygon>`;
      if (r.key !== selRoom) continue;
      html += `<polygon class="room-sel" points="${c.map(P).join(' ')}"/>`;
      c.forEach((p, i) => (html += `<rect class="room-corner" data-room-corner="${i}" x="${p[0] * k - 7}" y="${p[1] * k - 7}" width="14" height="14"><title>Glisser : changer la taille</title></rect>`));
      // Poignée de rotation : au-delà du milieu du premier côté.
      const m = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
      const d = [m[0] - r.cx, m[1] - r.cy], n = Math.hypot(d[0], d[1]) || 1;
      const h = [m[0] + (d[0] / n) * 30, m[1] + (d[1] / n) * 30];
      html += `<line class="room-rot-line" x1="${m[0] * k}" y1="${m[1] * k}" x2="${h[0] * k}" y2="${h[1] * k}"/><circle class="room-rot" data-room-rot="1" cx="${h[0] * k}" cy="${h[1] * k}" r="9"><title>Glisser : tourner la pièce (le nord de ses photos suit)</title></circle>`;
    }
    // Flèche nord-sud.
    const cp = compassPos();
    html += `<g class="compass" transform="translate(${cp.x * k},${cp.y * k}) rotate(${planNorth()})">
      <circle class="compass-base" data-compass-move="1" r="24"><title>Glisser : déplacer la flèche</title></circle>
      <path class="compass-n" d="M0,-38 L8,-6 L0,-10 L-8,-6 Z"/><path class="compass-s" d="M0,38 L8,6 L0,10 L-8,6 Z"/>
      <text class="compass-label" y="-44">N</text><text class="compass-label s" y="56">S</text>
      <circle class="compass-rot" data-compass-rot="1" cy="-38" r="10"><title>Glisser : orienter le nord</title></circle>
    </g>`;
    svg.innerHTML = html;
  }
  function selectRoom(key) {
    selRoom = key;
    const r = key && roomOf(key);
    help.innerHTML = r
      ? `Pièce « ${escapeHtml(r.name)} » (${r.w.toFixed(1)} × ${r.l.toFixed(1)} m) : glisser son contour pour la déplacer, les poignées carrées pour changer sa taille, la poignée ronde pour la tourner (le nord de ses photos suit). <button class="btn small" data-room-done>Terminer</button>`
      : TOOL_HELP[tool] || helpDefault;
    const done = help.querySelector('[data-room-done]');
    if (done) done.addEventListener('click', () => selectRoom(null));
    drawRooms();
  }
  // État de départ d'un geste sur une pièce : la pièce et la position de ses photos.
  function roomSnapshot(r) {
    return { room: { ...r }, photos: new Map(r.ids.filter((id) => pos.has(id)).map((id) => [id, { ...pos.get(id) }])) };
  }
  function roomDrag(e, d) {
    const r = roomOf(d.key);
    const s0 = d.snap.room;
    const m = toWorld(e);
    const P = [m.x / scale(), m.y / scale()];
    if (d.kind === 'room-move') {
      const ddx = (e.clientX - d.sx) / zoom / scale(), ddy = (e.clientY - d.sy) / zoom / scale();
      r.cx = s0.cx + ddx;
      r.cy = s0.cy + ddy;
      d.snap.photos.forEach((q, id) => pos.set(id, { x: q.x + ddx, y: q.y + ddy }));
    } else if (d.kind === 'room-size') {
      const c0 = roomCorners(s0, PX);
      const O = c0[(d.corner + 2) % 4];
      const U = [Math.cos(s0.ang), Math.sin(s0.ang)], V = [Math.sin(s0.ang), -Math.cos(s0.ang)];
      const sa = [-1, 1, 1, -1][d.corner], sb = [-1, -1, 1, 1][d.corner];
      const u = (P[0] - O[0]) * U[0] + (P[1] - O[1]) * U[1], v = (P[0] - O[0]) * V[0] + (P[1] - O[1]) * V[1];
      const wpx = Math.max(PX * 0.5, u * sa), lpx = Math.max(PX * 0.5, v * sb);
      r.w = wpx / PX;
      r.l = lpx / PX;
      r.cx = O[0] + (sa * wpx * U[0] + sb * lpx * V[0]) / 2;
      r.cy = O[1] + (sa * wpx * U[1] + sb * lpx * V[1]) / 2;
      const fu = r.w / s0.w, fv = r.l / s0.l;
      d.snap.photos.forEach((q, id) => {
        const qu = (q.x - O[0]) * U[0] + (q.y - O[1]) * U[1], qv = (q.x - O[0]) * V[0] + (q.y - O[1]) * V[1];
        pos.set(id, { x: O[0] + qu * fu * U[0] + qv * fv * V[0], y: O[1] + qu * fu * U[1] + qv * fv * V[1] });
      });
    } else if (d.kind === 'room-rot') {
      const a0 = Math.atan2(d.p0[1] - s0.cy, d.p0[0] - s0.cx), a1 = Math.atan2(P[1] - s0.cy, P[0] - s0.cx);
      let da = a1 - a0;
      if (e.shiftKey) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
      d.da = da;
      r.ang = s0.ang + da;
      const c = Math.cos(da), sn = Math.sin(da);
      d.snap.photos.forEach((q, id) => {
        const x = q.x - s0.cx, y = q.y - s0.cy;
        pos.set(id, { x: s0.cx + x * c - y * sn, y: s0.cy + x * sn + y * c });
      });
    }
    writeRoomWalls(r);
    placeNodes();
    drawLinks();
    drawDrawing();
    drawRooms();
  }
  // Fin d'un geste : positions, liens automatiques réorientés, et (rotation) nord des photos corrigé.
  async function roomDrop(d) {
    const r = roomOf(d.key);
    const ids = [...d.snap.photos.keys()];
    if (d.kind === 'room-rot' && d.da) {
      const dDeg = (d.da * 180) / Math.PI;
      for (const id of ids) {
        const upd = await db.updatePhoto(id, (cur) => {
          const pr = { yaw: 0, pitch: 0, roll: 0, ...cur.params };
          const old = { yaw: pr.yaw, pitch: pr.pitch, roll: pr.roll };
          // La pièce tourne de dDeg (sens horaire) : ce que la photo voyait au cap β est maintenant au cap
          // β + dDeg ; on corrige son nord en conséquence (liens et coins restent sur les mêmes points).
          const lvl = withCap(pr, levelToViewTilt(pr, 0).cap - dDeg);
          const next = { yaw: wrapDeg(lvl.yaw), pitch: lvl.pitch, roll: lvl.roll };
          const rm = (h) => remapHotspot(h, old, next);
          const room = cur.room ? { ...cur.room, corners: (cur.room.corners || []).map(rm), ...(cur.room.floor ? { floor: rm(cur.room.floor) } : {}) } : cur.room;
          return { ...cur, params: { ...cur.params, ...next }, hotspots: (cur.hotspots || []).map(rm), room, status: 'pending' };
        });
        if (upd) Object.assign(byId.get(id), { params: upd.params, hotspots: upd.hotspots, room: upd.room });
      }
    }
    for (const id of ids) {
      const mp = { x: Math.round(pos.get(id).x), y: Math.round(pos.get(id).y) };
      Object.assign(byId.get(id), { mapPos: mp, mapPlaced: true });
      await db.updatePhoto(id, (cur) => ({ ...cur, mapPos: mp, mapPlaced: true }));
    }
    await retargetAndSave(ids);
    await saveDrawing();
    drawLinks();
    selectRoom(d.key); // dimensions à jour dans la ligne d'aide
    if (d.kind === 'room-rot' && d.da) toast(`Pièce « ${r.name} » tournée de ${((d.da * 180) / Math.PI).toFixed(1)}° : le nord de ses ${ids.length} photo(s) a été corrigé (elles vont être reconverties).`, false, 7000);
  }
  // Liens automatiques des photos `ids` (et de leurs voisines) réorientés d'après le plan, enregistrés.
  async function retargetAndSave(ids) {
    const changed = new Set();
    for (const id of ids) retargetAutoLinks(list, pos, id).forEach((x) => changed.add(x));
    for (const id of changed) {
      const hs = byId.get(id).hotspots;
      await db.updatePhoto(id, (cur) => ({
        ...cur,
        hotspots: (cur.hotspots || []).map((h) => {
          const n = hs.find((x) => x.id === h.id);
          return n && h.auto ? { ...h, yaw: n.yaw } : h;
        }),
      }));
    }
  }
  async function compassDrop(d) {
    if (d.kind === 'compass-rot') {
      drawing.north = planNorth();
      // Le nord a tourné : tous les liens automatiques sont réorientés.
      await retargetAndSave(list.map((p) => p.id));
      drawLinks();
      toast(`Nord du plan orienté à ${Math.round(planNorth())}° : liens automatiques réorientés.`);
    }
    await saveDrawing();
  }

  // ---------- pièces : plan d'après les coins du plafond ----------
  const PX_PER_M = 50;
  const ceilIn = container.querySelector('[data-ceiling]');
  ceilIn.value = drawing.ceilingH || 2.8;
  ceilIn.addEventListener('change', async () => {
    const v = parseFloat(ceilIn.value);
    if (!(v > 1.5)) return;
    drawing.ceilingH = v;
    await saveDrawing();
  });
  container.querySelector('[data-place-rooms]').addEventListener('click', async () => {
    const withRoom = list.filter((p) => p.room && (p.room.corners || []).length >= 4);
    if (!withRoom.length) return toast('Aucune pièce : dans l’éditeur, onglet « Pièce », indiquez les 4 coins du plafond de chaque photo.', true, 8000);
    // Place libre à droite de ce qui est déjà sur le plan, pour les pièces nouvelles.
    const onPlanIds = list.filter((p) => !pool.has(p.id)).map((p) => p.id);
    const xs = [...onPlanIds.map((id) => pos.get(id).x), ...drawing.lines.flatMap((l) => [l.x1, l.x2])];
    const freeX = xs.length ? Math.max(...xs) + 150 : 0;
    const res = placeRooms(list, {
      ceilingH: drawing.ceilingH || 2.8,
      pxPerM: PX_PER_M,
      north: planNorth(),
      freeX,
      // Pièce dont une photo est déjà placée (pas dans la zone des photos non placées) : elle s'y raccroche.
      anchorOf: (p) => (!pool.has(p.id) && p.mapPos ? pos.get(p.id) : null),
    });
    pushUndo();
    // Pièces (modèle, murs et nom) : remplacent celles d'un placement précédent du même nom.
    for (const r of res.rooms) {
      const { corners, ...model } = r;
      drawing.rooms = drawing.rooms.filter((x) => x.key !== r.key).concat([model]);
      writeRoomWalls(model);
    }
    await saveDrawing();
    // Photos à leur place, sur le plan même sans lien.
    for (const [id, q] of res.positions) {
      const mp = { x: Math.round(q.x), y: Math.round(q.y) };
      Object.assign(byId.get(id), { mapPos: mp, mapPlaced: true });
      pos.set(id, { ...mp });
      await db.updatePhoto(id, (cur) => ({ ...cur, mapPos: mp, mapPlaced: true }));
    }
    // Liens entre les photos d'une même pièce (automatiques : ils suivent le plan).
    let made = 0;
    for (const [aId, bId] of res.pairs) {
      for (const [p, q] of [[byId.get(aId), byId.get(bId)], [byId.get(bId), byId.get(aId)]]) {
        const yaw = +bearing(p.mapPos, q.mapPos).toFixed(2);
        const ex = p.hotspots.find((h) => h.target === q.id);
        if (ex) {
          if (ex.auto) ex.yaw = yaw;
        } else {
          p.hotspots.push({ id: newHotspotId(), target: q.id, yaw, pitch: 0, label: '', auto: true });
          made++;
        }
      }
    }
    for (const id of new Set(res.pairs.flat())) {
      const hs = byId.get(id).hotspots;
      await db.updatePhoto(id, (cur) => ({ ...cur, hotspots: hs }));
    }
    await layout();
    render();
    fit();
    toast(`${res.rooms.length} pièce(s) dessinée(s), ${res.positions.size} photo(s) placée(s), ${made} lien(s) créé(s).`, false, 6000);
  });

  container.querySelector('[data-zoom]').addEventListener('change', (e) => {
    ZOOM = +e.target.value;
    try {
      localStorage.setItem('ps-plan-zoom', String(ZOOM));
    } catch (err) {
      // préférence non mémorisée
    }
    if (selected) {
      const id = selected;
      selected = null;
      select(id);
    }
  });
  container.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  container.querySelector('[data-text-size]').addEventListener('change', (e) => (textSize = +e.target.value));
  container.querySelector('[data-draw-undo]').addEventListener('click', undoDrawing);
  view.addEventListener('contextmenu', (e) => {
    if (tool === 'line' && poly) {
      e.preventDefault();
      endPoly();
    }
  });
  container.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', async () => {
      mode = b.dataset.mode;
      try {
        localStorage.setItem('ps-plan-mode', mode);
      } catch (e) {
        // préférence non mémorisée
      }
      await layout();
      render();
      fit();
    })
  );

  await layout();
  render();
  setTool('photos');
  requestAnimationFrame(fit);
  return {
    dispose() {
      window.removeEventListener('keydown', onKey);
      thumbs.forEach((u) => URL.revokeObjectURL(u));
    },
  };
}

function newHotspotId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
