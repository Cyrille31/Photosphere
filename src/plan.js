// Plan des photos : chaque photo est une mini-sphère placée sur un plan orienté nord en haut ; les
// traits sont les liens. Déplacer une photo réoriente ses liens « automatiques » (les liens retour
// créés automatiquement), qui pointent alors vers la position des photos voisines sur le plan.
import * as db from './db.js';
import { escapeHtml } from './ui.js';

const SPACING = 170; // distance entre deux photos liées lors de la disposition automatique

// Cap (degrés, 0 = nord, 90 = est) de b vu depuis a, sur le plan (y vers le bas = sud).
export function bearing(a, b) {
  return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
}

// Positions des photos qui n'en ont pas encore : en suivant les liens à partir des photos déjà
// placées (direction du lien = direction sur le plan), puis en ligne pour les photos isolées.
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

// container : élément où dessiner. onOpen(id, 'view' | 'edit').
export async function openPlan(container, { photos, onOpen }) {
  const list = photos.map((p) => JSON.parse(JSON.stringify(p)));
  const byId = new Map(list.map((p) => [p.id, p]));
  const pos = autoLayout(list);
  // Les positions calculées sont enregistrées pour rester stables.
  for (const p of list) {
    if (!p.mapPos) {
      p.mapPos = pos.get(p.id);
      await db.updatePhoto(p.id, (cur) => ({ ...cur, mapPos: p.mapPos }));
    }
  }

  container.innerHTML = `<div class="plan">
    <div class="plan-bar">
      <span class="plan-north" title="Le haut du plan est le nord">N ↑</span>
      <button class="btn small" data-fit>⤢ Tout afficher</button>
      <span class="note">Faites glisser une photo pour la placer : ses liens <span class="plan-key auto">automatiques</span> se réorientent vers les photos voisines ; les liens <span class="plan-key manual">placés à la main</span> ne bougent pas. Double-clic : voir la photo.</span>
    </div>
    <div class="plan-view">
      <div class="plan-world">
        <svg class="plan-links" width="1" height="1"></svg>
        ${list
          .map(
            (p) => `<div class="plan-node" data-id="${p.id}" tabindex="0">
              <div class="plan-ball"></div>
              <span>${escapeHtml(p.name)}</span>
              <div class="plan-actions"><button class="btn small" data-act="view">👁 Voir</button><button class="btn small" data-act="edit">✏ Éditer</button></div>
            </div>`
          )
          .join('')}
      </div>
    </div>
  </div>`;
  const view = container.querySelector('.plan-view');
  const world = container.querySelector('.plan-world');
  const svg = container.querySelector('.plan-links');
  let zoom = 1, panX = 0, panY = 0;
  const applyView = () => (world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`);

  function drawLinks() {
    let html = '';
    const seen = new Set();
    // Trait de fond pour chaque paire de photos liées.
    const pairs = new Set();
    list.forEach((p) =>
      (p.hotspots || []).forEach((h) => {
        if (!byId.has(h.target)) return;
        const k = [p.id, h.target].sort().join('|');
        if (pairs.has(k)) return;
        pairs.add(k);
        const a = pos.get(p.id), b = pos.get(h.target);
        html += `<line class="pair" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
      })
    );
    list.forEach((p) =>
      (p.hotspots || []).forEach((h) => {
        if (!byId.has(h.target)) return;
        const a = pos.get(p.id), b = pos.get(h.target);
        // Chaque sens est dessiné sur la moitié du trait qui part de sa photo.
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        html += `<line class="${h.auto ? 'auto' : 'manual'}" x1="${a.x}" y1="${a.y}" x2="${mx}" y2="${my}"/>`;
        seen.add(p.id + '>' + h.target);
      })
    );
    svg.innerHTML = html;
  }

  function placeNodes() {
    container.querySelectorAll('.plan-node').forEach((n) => {
      const q = pos.get(n.dataset.id);
      n.style.transform = `translate(${q.x}px, ${q.y}px)`;
    });
  }

  function fit() {
    const pts = [...pos.values()];
    const r = view.getBoundingClientRect();
    const minX = Math.min(...pts.map((q) => q.x)) - 110, maxX = Math.max(...pts.map((q) => q.x)) + 110;
    const minY = Math.min(...pts.map((q) => q.y)) - 90, maxY = Math.max(...pts.map((q) => q.y)) + 110;
    zoom = Math.min(1.6, Math.max(0.2, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    panX = r.width / 2 - ((minX + maxX) / 2) * zoom;
    panY = r.height / 2 - ((minY + maxY) / 2) * zoom;
    applyView();
  }

  // Mini-sphères : vignette de la photo plaquée sur un disque ombré.
  const urls = [];
  list.forEach(async (p) => {
    const b = await db.getBlob(p.id + ':thumb');
    if (!b) return;
    const u = URL.createObjectURL(b);
    urls.push(u);
    container.querySelector(`.plan-node[data-id="${p.id}"] .plan-ball`).style.backgroundImage = `url("${u}")`;
  });

  // Glisser une photo / le fond, molette pour zoomer.
  let drag = null;
  view.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const node = e.target.closest('.plan-node');
    view.setPointerCapture(e.pointerId);
    drag = node
      ? { kind: 'node', id: node.dataset.id, sx: e.clientX, sy: e.clientY, start: { ...pos.get(node.dataset.id) }, moved: false }
      : { kind: 'pan', sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false };
    container.querySelectorAll('.plan-node.selected').forEach((n) => n.classList.remove('selected'));
    if (node) node.classList.add('selected');
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (drag.kind === 'pan') {
      panX = drag.px + dx;
      panY = drag.py + dy;
      applyView();
    } else if (drag.moved) {
      pos.set(drag.id, { x: drag.start.x + dx / zoom, y: drag.start.y + dy / zoom });
      placeNodes();
      drawLinks();
    }
  });
  let lastTap = { id: null, t: 0 };
  view.addEventListener('pointerup', async () => {
    const d = drag;
    drag = null;
    if (d && d.kind === 'node' && !d.moved) {
      // Double-clic (ou double appui) sur une photo : on l'ouvre dans la visionneuse.
      const now = performance.now();
      if (lastTap.id === d.id && now - lastTap.t < 400) onOpen(d.id, 'view');
      lastTap = { id: d.id, t: now };
      return;
    }
    if (!d || d.kind !== 'node' || !d.moved) return;
    const p = pos.get(d.id);
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
  });
  view.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = view.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const f = Math.exp(-e.deltaY * 0.0015);
      const nz = Math.min(3, Math.max(0.15, zoom * f));
      panX = mx - ((mx - panX) * nz) / zoom;
      panY = my - ((my - panY) * nz) / zoom;
      zoom = nz;
      applyView();
    },
    { passive: false }
  );
  container.querySelectorAll('.plan-node').forEach((n) => {
    n.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => onOpen(n.dataset.id, b.dataset.act)));
  });
  container.querySelector('[data-fit]').addEventListener('click', fit);

  placeNodes();
  drawLinks();
  requestAnimationFrame(fit);
  return {
    dispose() {
      urls.forEach((u) => URL.revokeObjectURL(u));
    },
  };
}
