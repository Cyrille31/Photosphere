// Visionneuse plein écran : tactile, smartphone à bout de bras (gyroscope), casque VR (Cardboard / WebXR).
import { PanoRenderer } from './renderer.js';
import { ViewController, DEFAULT_HEADSET, HEADSET_PRESETS } from './controls.js';
import { DEG, vecDot, mat3Mul, mat3Apply, mat3Transpose, rotY, headingOf, dirFromLonLat } from './math.js';
import { estimateRelief, reliefKey } from './relief.js';

const DWELL_MS = 1600;
// Les cibles des liens n'apparaissent qu'à l'approche de la souris (ou du regard) : pleinement
// visibles à moins de HOT_NEAR degrés, invisibles au-delà de HOT_FAR, avec un fondu dans le temps.
const HOT_NEAR = 10, HOT_FAR = 32, HOT_FADE_MS = 160;
const EYE_HALF_GAP = 0.032; // demi-écart des yeux (m)
const DEFAULT_CAMERA_HEIGHT = 1.6;

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function loadHeadsetSettings() {
  try {
    return { ...DEFAULT_HEADSET, ...JSON.parse(localStorage.getItem('ps-headset') || '{}') };
  } catch (e) {
    return { ...DEFAULT_HEADSET };
  }
}

function saveHeadsetSettings(h) {
  try {
    localStorage.setItem('ps-headset', JSON.stringify(h));
  } catch (e) {
    // stockage indisponible : réglage limité à la session
  }
}

// photos : [{ id, name, src, srcType, params, hotspots: [{ target, yaw, pitch, label }] }]
// photo.relief : forme estimée de la pièce (relief.js), photo.reliefKey : redressement de l'image affichée.
// onRelief(id, relief) : relief calculé à la volée, à mémoriser.
// onEdit(id, vue) : ouvre l'éditeur sur la photo affichée ; initialView : { yaw, pitch } en radians.
export function createPlayer(container, { photos, startId, onExit, onEdit, onRelief, title, initialView }) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const root = el('div', 'ps-player');
  root.innerHTML = `
    <canvas class="ps-canvas"></canvas>
    <div class="ps-labels"></div>
    <div class="ps-cursor" hidden>
      <svg class="arrow" viewBox="-20 -14 40 28" width="40" height="28"><path d="M-14 -5 H4 V-12 L18 0 L4 12 V5 H-14 Z"/></svg>
      <svg class="enter" viewBox="-20 -20 40 40" width="40" height="40"><circle r="15"/><path d="M-6 -8 L6 0 L-6 8 Z"/></svg>
    </div>
    <div class="ps-eye-labels"><span></span><span></span></div>
    <div class="ps-fade"></div>
    <div class="ps-top">
      ${onExit ? '<button class="ps-btn ps-back" title="Retour">←</button>' : ''}
      <div class="ps-title"></div>
      ${onEdit ? '<button class="ps-btn ps-edit" title="Redresser cette photo ou y ajouter des liens">✏<span>Éditer</span></button>' : ''}
      <button class="ps-btn ps-list-btn" title="Liste des photos">☰</button>
    </div>
    <div class="ps-bottom">
      <button class="ps-btn ps-mode" data-mode="touch" title="Déplacer la vue au doigt ou à la souris">👆<span>Tactile</span></button>
      <button class="ps-btn ps-mode" data-mode="gyro" title="Bouger le téléphone tenu à bout de bras">📱<span>Bout de bras</span></button>
      <button class="ps-btn ps-mode" data-mode="cardboard" title="Téléphone dans un casque VR (type Cardboard)">🥽<span>Casque VR</span></button>
      <button class="ps-btn ps-mode ps-xr" data-mode="xr" title="Mode WebXR natif" hidden>✨<span>WebXR</span></button>
      <button class="ps-btn ps-fs" title="Plein écran">⛶</button>
    </div>
    <button class="ps-btn ps-exit-vr" title="Quitter le casque">✕</button>
    <button class="ps-btn ps-vr-settings" title="Réglages du casque">⚙</button>
    <div class="ps-panel ps-list" hidden></div>
    <div class="ps-panel ps-headset" hidden>
      <h3>Réglages du casque</h3>
      <label>Champ de vision par œil <output></output><input type="range" name="eyeFov" min="60" max="120" step="1"></label>
      <label>Correction des lentilles k1 <output></output><input type="range" name="k1" min="0" max="0.8" step="0.01"></label>
      <label>Correction des lentilles k2 <output></output><input type="range" name="k2" min="0" max="0.8" step="0.01"></label>
      <div class="ps-presets">
        <button class="ps-btn" data-preset="v1" title="k1 0,441 · k2 0,156">Cardboard v1</button>
        <button class="ps-btn" data-preset="v2" title="k1 0,34 · k2 0,55">Cardboard v2</button>
        <button class="ps-btn" data-preset="none">Sans correction</button>
      </div>
      <label>Écartement des centres des deux images <output></output><input type="range" name="sep" min="30" max="70" step="0.5"></label>
      <label>Relief (effet 3D, 0 = aucun) <output></output><input type="range" name="relief" min="0" max="2.5" step="0.1"></label>
      <p class="ps-note">Lentilles : les lignes droites doivent rester droites jusqu’au bord. Écartement : chaque œil doit voir le point de visée au centre de sa lentille.</p>
      <div class="ps-presets">
        <button class="ps-btn" data-preset="reset">↺ RAZ (valeurs par défaut)</button>
        <button class="ps-btn ps-close-panel">Fermer</button>
      </div>
    </div>
    <div class="ps-toast" hidden></div>`;
  container.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const canvas = $('.ps-canvas');
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const renderer = new PanoRenderer(canvas, {
    xr: true,
    maxHalf: coarse ? 3072 : 4096,
    onLost: () => {
      toast('La carte graphique a interrompu l’affichage : rechargement…');
      setTimeout(() => location.reload(), 1500);
    },
  });
  let current = null;
  let dirty = true;
  let sel = -1;
  let dwellStart = 0;
  let dwell = 0;
  let xrSession = null;
  let wakeLock = null;
  let raf = 0;
  let disposed = false;

  const controller = new ViewController(canvas, renderer, {
    headset: loadHeadsetSettings(),
    onChange: () => (dirty = true),
    onTap: (x, y) => onTap(x, y),
  });

  function toast(msg, ms = 3500) {
    const t = $('.ps-toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), ms);
  }

  function hotspotsOf(photo) {
    return (photo.hotspots || []).filter((h) => byId.has(h.target));
  }

  // arrive : vue d'arrivée réglée sur le lien suivi ({ yaw, pitch } en degrés), sinon on garde la vue.
  async function go(id, keepView = true, arrive = null) {
    const photo = byId.get(id);
    if (!photo) return;
    const fade = $('.ps-fade');
    if (current) {
      fade.classList.add('on');
      await new Promise((r) => setTimeout(r, 220));
    }
    try {
      await renderer.load(photo.src, photo.srcType || 'equirect', photo.params || {});
      renderer.setRelief(null);
      reliefFor = null;
      ensureRelief(photo);
    } catch (e) {
      toast('Impossible de charger « ' + photo.name + ' » : ' + e.message);
    }
    if (arrive && current) {
      if (controller.mode === 'gyro' && controller.gyroMat) {
        // Bout de bras / casque : on tourne l'image pour que la direction d'arrivée soit devant soi.
        controller.gyroOffset += arrive.yaw * DEG - headingOf(controller.camMatrix());
      } else {
        controller.yaw = arrive.yaw * DEG;
        controller.pitch = (arrive.pitch || 0) * DEG;
      }
    } else if (!current && initialView) {
      controller.yaw = initialView.yaw;
      controller.pitch = initialView.pitch;
    } else if (!keepView || !current) {
      controller.yaw = (photo.initialYaw || 0) * DEG;
      controller.pitch = 0;
    }
    current = photo;
    renderer.setHotspots(hotspotsOf(photo));
    hotAlpha = [];
    sel = -1;
    dwell = 0;
    $('.ps-title').textContent = photo.name;
    buildLabels();
    dirty = true;
    fade.classList.remove('on');
  }

  function hotDirs() {
    return hotspotsOf(current || { hotspots: [] }).map((h) => dirFromLonLat(h.yaw * DEG, h.pitch * DEG));
  }

  function nearestHotspot(dir, maxAng) {
    let best = -1, bestAng = maxAng;
    hotDirs().forEach((d, i) => {
      const a = Math.acos(Math.max(-1, Math.min(1, vecDot(d, dir))));
      if (a < bestAng) {
        bestAng = a;
        best = i;
      }
    });
    return best;
  }

  // Suivre un lien : on arrive orienté selon la vue d'arrivée réglée, sinon dos au lien qui ramène
  // à la photo d'où l'on vient (comme si l'on venait de franchir la porte).
  function follow(i) {
    const h = hotspotsOf(current)[i];
    if (!h) return;
    let arrive = h.arrive || null;
    if (!arrive) {
      const target = byId.get(h.target);
      const back = target && (target.hotspots || []).find((x) => x.target === current.id);
      if (back) arrive = { yaw: back.yaw + 180, pitch: 0 };
    }
    go(h.target, true, arrive);
  }

  function onTap(x, y) {
    if (!current) return;
    if (controller.stereo) {
      if (sel >= 0) follow(sel);
      return;
    }
    const dir = renderer.pick(x, y, controller.frame());
    if (!dir) return;
    const i = nearestHotspot(dir, Math.max(0.08, controller.fov * DEG * 0.08));
    if (i >= 0) follow(i);
  }

  function buildLabels() {
    const box = $('.ps-labels');
    box.innerHTML = '';
    if (!current) return;
    hotspotsOf(current).forEach((h, i) => {
      const target = byId.get(h.target);
      const b = el('button', 'ps-label');
      b.textContent = h.label || target.name;
      b.addEventListener('click', () => follow(i));
      box.appendChild(b);
    });
  }

  function placeLabels(frame) {
    const box = $('.ps-labels');
    const dpr = canvas.width / (canvas.clientWidth || 1);
    const dirs = hotDirs();
    [...box.children].forEach((b, i) => {
      const p = !controller.stereo && dirs[i] ? renderer.project(dirs[i], frame) : null;
      const a = hotAlpha[i] || 0;
      if (!p || a < 0.02) {
        b.style.display = 'none';
        return;
      }
      b.style.display = '';
      b.style.opacity = a.toFixed(2);
      b.style.transform = `translate(${p.x / dpr}px, ${p.y / dpr}px) translate(-50%, 26px)`;
    });
  }

  // Opacité des cibles selon leur distance à la souris (PC) ou au centre de la vue / au regard.
  let hotAlpha = [];
  let mouse = null;
  let lastAlphaTime = 0;
  function updateHotAlpha(now, frame) {
    const dirs = hotDirs();
    let ref = null;
    if (xrSession) ref = xrGaze;
    else if (mouse && !controller.stereo && controller.mode !== 'gyro' && frame) ref = renderer.pick(mouse.x, mouse.y, frame);
    if (!ref) ref = controller.gazeDir();
    const dt = lastAlphaTime ? Math.min(100, now - lastAlphaTime) : 16;
    lastAlphaTime = now;
    const k = Math.min(1, dt / HOT_FADE_MS);
    let moving = false;
    hotAlpha = dirs.map((d, i) => {
      const ang = Math.acos(Math.max(-1, Math.min(1, vecDot(d, ref)))) / DEG;
      const x = Math.min(1, Math.max(0, (HOT_FAR - ang) / (HOT_FAR - HOT_NEAR)));
      const target = i === sel ? 1 : x * x * (3 - 2 * x);
      const cur = hotAlpha[i] ?? 0;
      const next = cur + (target - cur) * k;
      if (Math.abs(target - next) > 0.01) moving = true;
      return next;
    });
    if (moving) dirty = true;
    return hotAlpha;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = canvas.getBoundingClientRect();
    const s = canvas.width / (r.width || 1);
    mouse = { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s };
    dirty = true;
  });
  canvas.addEventListener('pointerleave', () => {
    mouse = null;
    dirty = true;
  });

  // Curseur de la souris : une flèche orientée vers la cible de lien la plus proche ; au-dessus
  // d'une cible, elle devient un rond « entrer ». Sans lien, le curseur habituel est conservé.
  const cursorEl = root.querySelector('.ps-cursor');
  function updateCursor(frame) {
    const dirs = hotDirs();
    if (!mouse || controller.stereo || xrSession || !dirs.length || !frame) {
      cursorEl.hidden = true;
      canvas.style.cursor = '';
      return;
    }
    const ref = renderer.pick(mouse.x, mouse.y, frame);
    if (!ref) {
      cursorEl.hidden = true;
      canvas.style.cursor = '';
      return;
    }
    let best = 0, bestAng = Infinity;
    dirs.forEach((d, i) => {
      const a = Math.acos(Math.max(-1, Math.min(1, vecDot(d, ref))));
      if (a < bestAng) {
        bestAng = a;
        best = i;
      }
    });
    const dpr = canvas.width / (canvas.clientWidth || 1);
    const p = renderer.project(dirs[best], frame);
    let angle;
    if (p) angle = Math.atan2(p.y - mouse.y, p.x - mouse.x);
    else {
      // Cible hors de l'écran : direction indiquée depuis le centre, d'après sa position autour de soi.
      const c = mat3Apply(mat3Transpose(frame.eyes[0].cam), dirs[best]);
      angle = Math.atan2(-c[1], c[0]);
    }
    const over = p && Math.hypot(p.x - mouse.x, p.y - mouse.y) < 30 * dpr;
    cursorEl.hidden = false;
    cursorEl.classList.toggle('over', !!over);
    cursorEl.style.transform = `translate(${mouse.x / dpr}px, ${mouse.y / dpr}px)` + (over ? '' : ` rotate(${angle}rad)`);
    canvas.style.cursor = 'none';
  }

  function updateGaze(now) {
    const useGaze = controller.stereo || controller.mode === 'gyro' || xrSession;
    if (!useGaze || !current) {
      if (sel !== -1) dirty = true;
      sel = -1;
      dwell = 0;
      return;
    }
    const gaze = xrSession ? xrGaze : controller.gazeDir();
    if (!gaze) return;
    const i = nearestHotspot(gaze, 0.11);
    if (i !== sel) {
      sel = i;
      dwellStart = now;
      dirty = true;
    }
    dwell = sel >= 0 ? Math.min(1, (now - dwellStart) / DWELL_MS) : 0;
    if (sel >= 0) dirty = true;
    if (dwell >= 1) {
      const i2 = sel;
      sel = -1;
      dwell = 0;
      follow(i2);
    }
    const eyeLabels = root.querySelectorAll('.ps-eye-labels span');
    // Le nom du lien visé s'affiche sous le centre de chaque lentille.
    const sep = (controller.headset.sep ?? 50) / 2;
    eyeLabels.forEach((s, k) => (s.style.left = 50 + (k ? sep : -sep) - 25 + '%'));
    const name = sel >= 0 ? hotspotsOf(current)[sel].label || byId.get(hotspotsOf(current)[sel].target).name : '';
    eyeLabels.forEach((s) => (s.textContent = controller.stereo ? name : ''));
  }

  // Relief : forme de la pièce enregistrée, sinon estimée (une seule fois) dès qu'on passe au casque.
  let reliefFor = null;
  function ensureRelief(photo) {
    if (!photo || reliefFor === photo.id) return;
    const key = photo.reliefKey ?? reliefKey(photo.params);
    if (photo.relief && photo.relief.walls && photo.relief.key === key) {
      renderer.setRelief(photo.relief);
      reliefFor = photo.id;
      return;
    }
    if (!controller.stereo && !xrSession) return;
    try {
      const r = estimateRelief(renderer.readFlat(1024, 512), 1024, 512);
      photo.relief = { h: (photo.relief && photo.relief.h) || DEFAULT_CAMERA_HEIGHT, walls: r.walls, ceil: r.ceil, key };
      renderer.setRelief(photo.relief);
      reliefFor = photo.id;
      if (onRelief) onRelief(photo.id, photo.relief);
    } catch (e) {
      reliefFor = photo.id; // pas de relief pour cette photo
    }
  }
  // Position d'un œil par rapport au centre de prise de vue, en hauteurs d'objectif.
  function eyeOffset(vec) {
    const r = current && current.relief;
    const k = controller.headset.relief ?? 1;
    if (!r || !k) return null;
    const s = k / (r.h || DEFAULT_CAMERA_HEIGHT);
    return vec.map((v) => v * s);
  }

  function loop(now) {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    if (xrSession) return;
    updateGaze(now);
    if (!dirty && controller.mode !== 'gyro') return;
    dirty = false;
    const frame = controller.frame();
    if (frame.stereo) {
      ensureRelief(current);
      frame.eyes.forEach((e, k) => (e.offset = eyeOffset(mat3Apply(e.cam, [(k ? 1 : -1) * EYE_HALF_GAP, 0, 0]))));
    }
    renderer.draw({
      ...frame,
      hotAlpha: updateHotAlpha(now, frame),
      hotSel: sel,
      dwell,
      hotSize: controller.stereo ? 0.09 : 0.07,
      reticle: controller.stereo || controller.mode === 'gyro' ? 9 * (canvas.width / canvas.clientWidth) : 0,
    });
    placeLabels(frame);
    updateCursor(frame);
    // Cap de la vue (degrés), lisible par les tests et les outils d'accessibilité.
    root.dataset.yaw = (headingOf(controller.camMatrix()) / DEG).toFixed(1);
  }

  async function lockScreen(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) {
      wakeLock = null;
    }
  }

  async function enterFullscreen(landscape) {
    try {
      if (!document.fullscreenElement && root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
      if (landscape && screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
    } catch (e) {
      // non supporté (ex. iPhone) : on reste dans la page
    }
  }

  function setActive(mode) {
    root.querySelectorAll('.ps-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    root.classList.toggle('stereo', mode === 'cardboard');
  }

  async function setMode(mode) {
    if (mode === 'xr') return startXR();
    controller.stereo = false;
    if (mode === 'touch') {
      controller.disableGyro();
      controller.setMode('touch');
      lockScreen(false);
    } else {
      if (controller.mode !== 'gyro') {
        const ok = await controller.enableGyro();
        if (!ok) {
          toast('Gyroscope indisponible : utilisez un smartphone (et autorisez l’accès aux capteurs de mouvement).');
          if (mode === 'gyro') return setActive(controller.mode);
        }
      }
      if (mode === 'cardboard') {
        controller.stereo = true;
        controller.pitch = 0;
        await enterFullscreen(true);
        toast('Placez le téléphone dans le casque. Fixez un lien pour l’ouvrir, ou appuyez sur le bouton du casque.');
      }
      lockScreen(true);
    }
    setActive(mode);
    dirty = true;
  }

  let xrGaze = null;
  async function startXR() {
    if (!navigator.xr) return;
    const gl = renderer.gl;
    try {
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local'] });
      await gl.makeXRCompatible();
      const layer = new XRWebGLLayer(session, gl);
      session.updateRenderState({ baseLayer: layer });
      const ref = await session.requestReferenceSpace('local');
      xrSession = session;
      setActive('xr');
      let offset = null;
      session.addEventListener('select', () => {
        if (sel >= 0) follow(sel);
      });
      session.addEventListener('end', () => {
        xrSession = null;
        xrGaze = null;
        setActive(controller.mode);
        dirty = true;
      });
      const toOurs = (m) => [m[0], m[4], -m[8], m[1], m[5], -m[9], -m[2], -m[6], m[10]];
      const onFrame = (now, frame) => {
        if (!xrSession) return;
        session.requestAnimationFrame(onFrame);
        const pose = frame.getViewerPose(ref);
        if (!pose) return;
        const head = toOurs(pose.transform.matrix);
        if (offset === null) offset = headingOf(controller.camMatrix()) - headingOf(head);
        const rot = rotY(offset);
        xrGaze = mat3Apply(mat3Mul(rot, head), [0, 0, 1]);
        updateGaze(now);
        ensureRelief(current);
        const hp = pose.transform.position;
        const eyes = pose.views.map((view) => {
          const vp = layer.getViewport(view);
          const P = view.projectionMatrix;
          return {
            vp: [vp.x, vp.y, vp.width, vp.height],
            cam: mat3Mul(rot, toOurs(view.transform.matrix)),
            proj: [1 / P[0], P[8] / P[0], 1 / P[5], P[9] / P[5]],
            // Écart réel des yeux donné par le casque (repère WebXR : z vers l'arrière).
            offset: eyeOffset(mat3Apply(rot, [view.transform.position.x - hp.x, view.transform.position.y - hp.y, -(view.transform.position.z - hp.z)])),
          };
        });
        renderer.draw({ mode: 'persp', eyes, framebuffer: layer.framebuffer, hotAlpha: updateHotAlpha(now, null), hotSel: sel, dwell, hotSize: 0.09, reticle: 0 });
      };
      session.requestAnimationFrame(onFrame);
    } catch (e) {
      toast('WebXR : ' + e.message);
    }
  }

  // --- Interface ---
  root.querySelectorAll('.ps-mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('.ps-fs').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else enterFullscreen(false);
  });
  $('.ps-exit-vr').addEventListener('click', () => {
    setMode('touch');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  });
  if (onExit) $('.ps-back').addEventListener('click', () => onExit(current && current.id));
  if (onEdit) {
    $('.ps-edit').addEventListener('click', () => {
      if (!current) return;
      const m = controller.camMatrix();
      onEdit(current.id, { yaw: headingOf(m), pitch: Math.asin(Math.max(-1, Math.min(1, m[5]))) });
    });
  }

  const list = $('.ps-list');
  // Recherche insensible à la casse et aux accents (tous les mots doivent figurer).
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  $('.ps-list-btn').addEventListener('click', () => {
    list.innerHTML = `<h3>${title || 'Photos'}</h3>`;
    const search = el('input', 'ps-search');
    search.type = 'search';
    search.placeholder = '🔍 Rechercher une photo';
    list.appendChild(search);
    const items = [];
    search.addEventListener('input', () => {
      const words = norm(search.value).split(/\s+/).filter(Boolean);
      items.forEach(({ b, text }) => (b.hidden = !words.every((w) => text.includes(w))));
    });
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = items.find(({ b }) => !b.hidden);
      if (first) first.b.click();
    });
    photos.forEach((p) => {
      const b = el('button', 'ps-list-item' + (current && p.id === current.id ? ' active' : ''));
      b.textContent = p.name;
      items.push({ b, text: norm(p.name + ' ' + (p.fileName || '')) });
      b.addEventListener('click', () => {
        list.hidden = true;
        go(p.id);
      });
      list.appendChild(b);
    });
    const close = el('button', 'ps-btn ps-close-panel', 'Fermer');
    close.addEventListener('click', () => (list.hidden = true));
    list.appendChild(close);
    list.hidden = false;
    if (!matchMedia('(pointer: coarse)').matches) search.focus();
  });

  const hs = $('.ps-headset');
  const syncHeadset = () => {
    hs.querySelectorAll('input').forEach((i) => {
      i.value = controller.headset[i.name];
      i.previousElementSibling.textContent = i.name === 'eyeFov' ? i.value + '°' : i.name === 'sep' ? i.value + ' %' : i.name === 'relief' ? '× ' + i.value : i.value;
    });
  };
  hs.querySelectorAll('input').forEach((i) =>
    i.addEventListener('input', () => {
      controller.headset[i.name] = parseFloat(i.value);
      saveHeadsetSettings(controller.headset);
      syncHeadset();
      dirty = true;
    })
  );
  hs.querySelectorAll('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.preset;
      Object.assign(controller.headset, k === 'reset' ? DEFAULT_HEADSET : HEADSET_PRESETS[k]);
      saveHeadsetSettings(controller.headset);
      syncHeadset();
      dirty = true;
    })
  );
  $('.ps-vr-settings').addEventListener('click', () => {
    syncHeadset();
    hs.hidden = !hs.hidden;
  });
  hs.querySelector('.ps-close-panel').addEventListener('click', () => (hs.hidden = true));

  if (navigator.xr && navigator.xr.isSessionSupported) {
    navigator.xr.isSessionSupported('immersive-vr').then((ok) => ($('.ps-xr').hidden = !ok)).catch(() => {});
  }

  const onResize = () => (dirty = true);
  window.addEventListener('resize', onResize);
  // Flèches gauche / droite du clavier : photo précédente / suivante (la direction de vue est conservée).
  const onKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.target.closest && e.target.closest('input, select, textarea')) return;
    if (!current || photos.length < 2) return;
    e.preventDefault();
    const i = photos.findIndex((x) => x.id === current.id);
    go(photos[(i + (e.key === 'ArrowRight' ? 1 : -1) + photos.length) % photos.length].id);
  };
  window.addEventListener('keydown', onKey);
  setActive('touch');
  raf = requestAnimationFrame(loop);
  go(startId && byId.has(startId) ? startId : photos[0] && photos[0].id, false);

  return {
    go,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      if (xrSession) xrSession.end().catch(() => {});
      lockScreen(false);
      controller.dispose();
      renderer.dispose();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      root.remove();
    },
  };
}
