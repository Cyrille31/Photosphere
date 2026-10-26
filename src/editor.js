// Éditeur : redressement (verticalité), calibrage des objectifs fisheye, liens entre photos.
import * as db from './db.js';
import { PanoRenderer } from './renderer.js';
import { ViewController } from './controls.js';
import { DEFAULT_LENS_PARAMS, decodeImage } from './gl-source.js';
import { analyzeImage } from './importer.js';
import { DEG, dirFromLonLat, lonLatFromDir, upFromHorizon, upFromVerticals, applyUpCorrection, remapHotspot, wrapDeg } from './math.js';
import { toast, escapeHtml, dialog } from './ui.js';
import { newId } from './importer.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

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

export async function openEditor(container, photo, { photos, onDone }) {
  const p = clone(photo);
  p.params = { yaw: 0, pitch: 0, roll: 0, ...clone(DEFAULT_LENS_PARAMS), ...p.params };
  p.hotspots = p.hotspots || [];
  const others = photos.filter((x) => x.id !== p.id);
  const reverseLinks = []; // { target, yaw, pitch }
  let dirty = false;

  container.innerHTML = `<div class="editor">
    <div class="ed-stage">
      <canvas></canvas>
      <div class="ed-markers"></div>
      <div class="ed-overlay">
        <button class="btn small" data-view="persp">🌐 Vue 360</button>
        <button class="btn small" data-view="flat">🗺 Vue à plat</button>
        <button class="btn small" data-grid>▦ Grille</button>
      </div>
      <div class="ed-hint" hidden></div>
    </div>
    <aside class="ed-panel">
      <div class="ed-panel-head">
        <input type="text" name="title" value="${escapeHtml(p.name)}" aria-label="Nom de la photo">
        <div class="tabs">
          <button data-tab="level" class="active">Redresser</button>
          <button data-tab="lens">Objectifs</button>
          <button data-tab="links">Liens</button>
        </div>
      </div>
      <div class="ed-body">
        <section data-panel="level">
          <p class="note">Corrigez une photo prise caméra penchée : la ligne orange (horizon) doit être plate et les verticales droites. Utilisez la vue à plat et la grille pour vérifier.</p>
          ${slider('pitch', 'Bascule avant / arrière (°)', -45, 45, 0.1)}
          ${slider('roll', 'Bascule gauche / droite (°)', -45, 45, 0.1)}
          ${slider('yaw', 'Cap : rotation horizontale (°)', -180, 180, 0.5)}
          <div class="tools">
            <button class="btn small" data-tool="horizon">📏 Horizon : 2 points</button>
            <button class="btn small" data-tool="verticals">📐 Verticales : 1 ou 2 lignes</button>
            <button class="btn small" data-reset-level>↺ Réinitialiser</button>
          </div>
          <p class="note"><b>Horizon</b> : cliquez deux points de l’horizon réel (mer, plaine), si possible éloignés d’environ 90°.<br>
          <b>Verticales</b> : cliquez le haut puis le bas d’un élément vertical (angle de mur, poteau, encadrement de porte), puis d’un second, de préférence dans une autre direction. Avec une seule ligne, appuyez sur « Appliquer ».<br>
          <b>Cap</b> : alignez le nord (ou une direction commune) sur toutes vos photos pour des transitions naturelles entre elles.</p>
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
            ${lensFields('lensA', 'Objectif avant (moitié gauche)')}
            ${lensFields('lensB', 'Objectif arrière (moitié droite)')}
            <div class="tools">
              <button class="btn small" data-autodetect>🎯 Détecter les cercles</button>
              <button class="btn small" data-lens-default>⭐ Calibrage par défaut</button>
              <button class="btn small" data-lens-reset>↺ Valeurs d’usine</button>
            </div>
            <p class="note">Si la couture entre les deux objectifs est visible (objets dédoublés ou coupés), ajustez d’abord le champ de vision (≈ 195° pour la Gear 360 2016, ≈ 190–195° pour la 2017), puis la rotation et les centres. « Calibrage par défaut » mémorise ces valeurs pour les prochains imports de cet appareil${p.model ? ' (' + escapeHtml(p.model) + ')' : ''}.</p>
          </div>
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
  const renderer = new PanoRenderer(canvas, { maxHalf: matchMedia('(pointer: coarse)').matches ? 2048 : 4096 });
  let tool = null; // { kind, points: [] }
  let placing = null; // { kind: 'add' | 'move', index }
  let grid = true;
  let raf = 0;

  const controller = new ViewController(canvas, renderer, {
    onChange: () => redraw(),
    onTap: (x, y) => onTap(x, y),
  });
  controller.fov = 90;

  function redraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const frame = controller.frame();
      renderer.setParams(p.params, p.srcType);
      renderer.setHotspots(p.hotspots);
      renderer.draw({ ...frame, grid, hotSel: -1, hotSize: controller.mode === 'flat' ? 0.05 : 0.06 });
      drawMarkers(frame);
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
      const kind = placing.kind, index = placing.index;
      placing = null;
      hint('');
      if (kind === 'move') {
        Object.assign(p.hotspots[index], pos);
        dirty = true;
        renderLinks();
        redraw();
      } else chooseTarget(pos);
    }
  }

  function chooseTarget(pos) {
    dialog(
      `<h2>Nouveau lien</h2>
      <label class="field">Vers la photo<select name="target">${others.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select></label>
      <label class="field">Texte affiché (facultatif)<input type="text" name="label" placeholder="ex. Vers la cuisine"></label>
      <label class="check"><input type="checkbox" name="reverse" checked> Créer aussi le lien retour dans l’autre photo (placé dans la direction opposée, à ajuster si besoin)</label>
      <div class="row"><button class="btn" data-close>Annuler</button><button class="btn primary" data-ok>Créer</button></div>`,
      (d) => {
        d.querySelector('[data-ok]').addEventListener('click', () => {
          const target = d.querySelector('[name=target]').value;
          const label = d.querySelector('[name=label]').value.trim();
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

  function renderLinks() {
    const list = $('.links-list');
    if (!p.hotspots.length) {
      list.innerHTML = '<p class="note">Aucun lien pour l’instant.</p>';
      return;
    }
    list.innerHTML = p.hotspots
      .map(
        (h, i) => `<div class="link-item" data-i="${i}">
        <div class="row2"><select name="target">${others
          .map((o) => `<option value="${o.id}" ${o.id === h.target ? 'selected' : ''}>→ ${escapeHtml(o.name)}</option>`)
          .join('')}</select></div>
        <div class="row2"><input type="text" name="label" value="${escapeHtml(h.label || '')}" placeholder="Texte affiché"></div>
        <div class="row2">
          <button class="btn small" data-look>👁 Voir</button>
          <button class="btn small" data-move>✥ Déplacer</button>
          <button class="btn small danger" data-del>🗑</button>
        </div></div>`
      )
      .join('');
    list.querySelectorAll('.link-item').forEach((item) => {
      const i = +item.dataset.i;
      const h = p.hotspots[i];
      item.querySelector('[name=target]').addEventListener('change', (e) => {
        h.target = e.target.value;
        dirty = true;
        redraw();
      });
      item.querySelector('[name=label]').addEventListener('input', (e) => {
        h.label = e.target.value;
        dirty = true;
        redraw();
      });
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
        p.hotspots.splice(i, 1);
        dirty = true;
        renderLinks();
        redraw();
      });
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
  function getPath(path) {
    return path.split('.').reduce((o, k) => o[k], p.params);
  }
  function setPath(path, v) {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], p.params)[last] = v;
  }

  function syncInputs() {
    $$('.slider input').forEach((i) => {
      const v = getPath(i.name);
      if (document.activeElement !== i) i.value = i.type === 'number' ? +(+v).toFixed(3) : v;
    });
    $('[name=srcType]').value = p.srcType;
    $('.fisheye-only').hidden = p.srcType !== 'fisheye';
  }

  $$('.slider input').forEach((i) =>
    i.addEventListener('input', () => {
      const v = parseFloat(i.value);
      if (!Number.isFinite(v)) return;
      if (['yaw', 'pitch', 'roll'].includes(i.name)) {
        setLevel({ ...p.params, [i.name]: v });
      } else {
        setPath(i.name, v);
        dirty = true;
        syncInputs();
        redraw();
      }
    })
  );

  $('[name=srcType]').addEventListener('change', (e) => {
    p.srcType = e.target.value;
    dirty = true;
    syncInputs();
    redraw();
  });

  $$('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      $$('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $$('[data-panel]').forEach((s) => (s.hidden = s.dataset.panel !== b.dataset.tab));
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
  $('[data-reset-level]').addEventListener('click', () => setLevel({ yaw: 0, pitch: 0, roll: 0 }));

  $('[data-add-link]').addEventListener('click', () => {
    stopTool();
    placing = { kind: 'add' };
    hint('Touchez l’endroit de la photo où placer le lien (porte, passage…). <button class="btn small" data-place-cancel>Annuler</button>');
    bindPlaceCancel();
  });

  $('[data-autodetect]').addEventListener('click', async () => {
    const img = await decodeImage(await db.getBlob(p.id + ':orig'));
    const a = analyzeImage(img);
    if (img.close) img.close();
    if (a.lenses) {
      Object.assign(p.params, clone(a.lenses));
      p.params.lensA.rot = p.params.lensA.rot || 0;
      dirty = true;
      syncInputs();
      redraw();
      toast('Cercles détectés.');
    } else toast('Cercles non détectés (photo trop sombre ?). Réglez-les à la main.', true);
  });

  $('[data-lens-default]').addEventListener('click', async () => {
    const { fov, blend, lensA, lensB } = p.params;
    const v = clone({ fov, blend, lensA, lensB });
    await db.putSetting('lens:' + (p.model || 'default'), v);
    if (!p.model) await db.putSetting('lens:default', v);
    toast('Calibrage mémorisé pour les prochains imports.');
  });

  $('[data-lens-reset]').addEventListener('click', () => {
    Object.assign(p.params, clone(DEFAULT_LENS_PARAMS));
    dirty = true;
    syncInputs();
    redraw();
  });

  $('[name=title]').addEventListener('input', () => (dirty = true));

  $('[data-cancel]').addEventListener('click', () => {
    if (dirty && !confirm('Abandonner les modifications ?')) return;
    onDone(false);
  });

  $('[data-save]').addEventListener('click', async () => {
    const cur = await db.getPhoto(p.id);
    const imageChanged = cur.srcType !== p.srcType || JSON.stringify(cur.params) !== JSON.stringify(p.params);
    const updated = {
      ...cur,
      name: $('[name=title]').value.trim() || cur.name,
      srcType: p.srcType,
      params: p.params,
      hotspots: p.hotspots,
      status: imageChanged || cur.status !== 'done' ? 'pending' : 'done',
    };
    await db.putPhoto(updated);
    for (const r of reverseLinks) {
      const t = await db.getPhoto(r.target);
      if (!t || !updated.hotspots.some((h) => h.target === r.target)) continue;
      if ((t.hotspots || []).some((h) => h.target === p.id)) continue;
      await db.putPhoto({ ...t, hotspots: [...(t.hotspots || []), { id: newId(), target: p.id, label: '', yaw: r.yaw, pitch: r.pitch }] });
    }
    dirty = false;
    if (imageChanged) toast('Enregistré. Reconversion en cours…');
    onDone(true);
  });

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

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('resize', onResize);
      controller.dispose();
      renderer.dispose();
    },
  };
}
