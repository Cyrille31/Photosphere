// Plan des photos : chaque photo est une mini-sphère placée sur un plan orienté nord en haut ; les
// traits sont les liens. Déplacer une photo réoriente ses liens « automatiques » (les liens retour
// créés automatiquement), qui pointent alors vers la position des photos voisines sur le plan.
import * as db from './db.js';
import { escapeHtml, toast } from './ui.js';

const SPACING = 170; // distance entre deux photos liées lors de la disposition automatique

// Cap (degrés, 0 = nord, 90 = est) de b vu depuis a, sur le plan (y vers le bas = sud).
export function bearing(a, b) {
  return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
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
          const yaw = ((n.yaw + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 25) * Math.PI) / 180;
          const x = a.x + SPACING * Math.sin(yaw), y = a.y - SPACING * Math.cos(yaw);
          if (free(x, y)) placed = { x, y };
        }
        if (!placed) placed = { x: a.x + SPACING * Math.sin((n.yaw * Math.PI) / 180) * 1.6, y: a.y - SPACING * Math.cos((n.yaw * Math.PI) / 180) * 1.6 };
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

// container : élément où dessiner. onOpen(id, 'view' | 'edit').
export async function openPlan(container, { photos, onOpen }) {
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
  list.forEach((p) => (p.hotspots = p.hotspots || []));

  // Positions : photos reliées d'après le plan (ou les liens), photos isolées dans la zone.
  async function layout() {
    const linked = list.filter((p) => isLinked(p.id));
    pool = new Set(list.filter((p) => !isLinked(p.id)).map((p) => p.id));
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
      <span class="plan-north" title="Le haut du plan est le nord">N ↑</span>
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
      <span class="plan-modes">
        <button class="btn small" data-mode="sphere" title="Photos en sphères">◯ Sphères</button>
        <button class="btn small" data-mode="rect" title="Photos à plat : chaque lien aboutit à sa position dans l’image">▭ Rectangles</button>
      </span>
      <span class="note plan-help">Glisser : déplacer · <b>Ctrl + glisser</b> sur une photo : la faire tourner · glisser un <b>point de contact</b> : placer le lien · <b>🔗 Relier</b> ou déposer une photo sur une autre : les relier · double-clic : voir. Liens <span class="plan-key auto">automatiques</span> (suivent le plan) et <span class="plan-key manual">placés à la main</span>.</span>
    </div>
    <div class="plan-view">
      <div class="plan-world"></div>
    </div>
  </div>`;
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
      ${zone ? `<div class="plan-pool" style="left:${zone.x}px;top:${zone.y}px;width:${zone.w}px;height:${zone.h}px"><span>Photos non reliées (${pool.size}) — déposez-en une sur une photo du plan pour les relier</span></div>` : ''}
      <svg class="plan-links" width="1" height="1"></svg>
      ${list
        .map(
          (p) => `<div class="plan-node ${mode}${p.id === selected ? ' selected' : ''}" data-id="${p.id}" style="width:${w}px;margin:${-h / 2}px 0 0 ${-w / 2}px">
            <div class="plan-pic" style="width:${w}px;height:${h}px;${thumbs.has(p.id) ? `background-image:url('${thumbs.get(p.id)}');` : ''}"></div>
            <span class="plan-name">${escapeHtml(p.name)}</span>
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
    line: '✏ <b>Traits</b> : cliquez chaque angle des murs ; <b>double-clic</b> ou <b>Échap</b> pour finir le trait. Les traits s’accrochent aux extrémités et à l’horizontale / verticale (<b>Alt</b> : sans accroche). Glisser : déplacer le plan.',
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
      n.style.transform = `translate(${q.x}px, ${q.y}px)`;
      // Texture décalée selon la rotation : le cap `rot` est au centre de la vignette.
      const pic = n.querySelector('.plan-pic');
      const tw = mode === 'rect' ? w : 2 * w;
      pic.style.backgroundSize = `${tw}px ${h}px`;
      pic.style.backgroundPositionX = `${w / 2 - (rot.get(id) / 360 + 0.5) * tw}px`;
    });
  }

  function contact(p, hs) {
    const o = contactOffset(mode, rot.get(p.id), hs.yaw, hs.pitch);
    const c = disp(pos.get(p.id));
    return { x: c.x + o.x, y: c.y + o.y, hidden: o.hidden };
  }

  function drawLinks() {
    let lines = '', over = '', dots = '';
    list.forEach((p) =>
      p.hotspots.forEach((hs, k) => {
        if (!byId.has(hs.target)) return;
        const q = byId.get(hs.target);
        const a = contact(p, hs);
        const back = q.hotspots.find((x) => x.target === p.id);
        const b = back ? contact(q, back) : disp(pos.get(q.id));
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const cls = hs.auto ? 'auto' : 'manual';
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
    world.querySelector('.plan-contacts').innerHTML = dots;
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
      const endEl = tool === 'move' && e.target.closest('[data-end]');
      const segEl = tool === 'move' && e.target.closest('[data-line]');
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
    const dot = e.target.closest('[data-contact]');
    const node = e.target.closest('.plan-node');
    view.setPointerCapture(e.pointerId);
    if (dot) {
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
    } else if (drag.kind === 'node') {
      pos.set(drag.id, { x: drag.start.x + dx / zoom / scale(), y: drag.start.y + dy / zoom / scale() });
      placeNodes();
      drawLinks();
    } else if (drag.kind === 'rotate') {
      // Faire glisser vers la droite fait tourner la vue vers la gauche, comme dans la visionneuse.
      const { w } = picSize(mode);
      const span = mode === 'rect' ? 360 : 180;
      rot.set(drag.id, wrap180(drag.start - (dx / zoom / w) * span));
      placeNodes();
      drawLinks();
    } else if (drag.kind === 'contact') {
      const p = byId.get(drag.id);
      const c = disp(pos.get(p.id));
      const m = toWorld(e);
      const d = contactFromOffset(mode, rot.get(p.id), m.x - c.x, m.y - c.y);
      Object.assign(p.hotspots[drag.k], d, { auto: false });
      drawLinks();
    }
  });

  view.addEventListener('pointerup', async (e) => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === 'dend' || d.kind === 'dseg') {
      if (!d.moved) return;
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
    if (d.kind === 'node' && !d.moved) {
      const now = performance.now();
      if (linkFrom && linkFrom !== d.id) {
        const from = linkFrom;
        stopLink();
        await createLink(from, d.id);
        return;
      }
      selected = d.id;
      world.querySelectorAll('.plan-node').forEach((n) => n.classList.toggle('selected', n.dataset.id === d.id));
      // Double-clic (ou double appui) : la photo s'ouvre dans la visionneuse.
      if (lastTap.id === d.id && now - lastTap.t < 400) onOpen(d.id, 'view');
      lastTap = { id: d.id, t: now };
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
      if (pool.has(d.id)) {
        // Une photo isolée reste dans sa zone tant qu'elle n'est reliée à aucune autre.
        pos.set(d.id, d.start);
        placeNodes();
        drawLinks();
        toast('Déposez la photo sur une photo du plan pour les relier.');
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoDrawing();
    }
  };
  window.addEventListener('keydown', onKey);
  container.querySelector('[data-fit]').addEventListener('click', fit);
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
