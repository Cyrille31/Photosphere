// Visionneuse plein écran : tactile, smartphone à bout de bras (gyroscope), casque VR (Cardboard / WebXR).
import { PanoRenderer } from './renderer.js';
import { ViewController, DEFAULT_HEADSET } from './controls.js';
import { DEG, vecDot, mat3Mul, mat3Apply, rotY, headingOf, dirFromLonLat } from './math.js';

const DWELL_MS = 1600;

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
export function createPlayer(container, { photos, startId, onExit, title }) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const root = el('div', 'ps-player');
  root.innerHTML = `
    <canvas class="ps-canvas"></canvas>
    <div class="ps-labels"></div>
    <div class="ps-eye-labels"><span></span><span></span></div>
    <div class="ps-fade"></div>
    <div class="ps-top">
      ${onExit ? '<button class="ps-btn ps-back" title="Retour">←</button>' : ''}
      <div class="ps-title"></div>
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
      <button class="ps-btn ps-close-panel">Fermer</button>
    </div>
    <div class="ps-toast" hidden></div>`;
  container.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const canvas = $('.ps-canvas');
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const renderer = new PanoRenderer(canvas, { xr: true, maxHalf: coarse ? 3072 : 4096 });
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

  async function go(id, keepView = true) {
    const photo = byId.get(id);
    if (!photo) return;
    const fade = $('.ps-fade');
    if (current) {
      fade.classList.add('on');
      await new Promise((r) => setTimeout(r, 220));
    }
    try {
      await renderer.load(photo.src, photo.srcType || 'equirect', photo.params || {});
    } catch (e) {
      toast('Impossible de charger « ' + photo.name + ' » : ' + e.message);
    }
    if (!keepView || !current) {
      controller.yaw = (photo.initialYaw || 0) * DEG;
      controller.pitch = 0;
    }
    current = photo;
    renderer.setHotspots(hotspotsOf(photo));
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

  function follow(i) {
    const h = hotspotsOf(current)[i];
    if (h) go(h.target);
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
      if (!p) {
        b.style.display = 'none';
        return;
      }
      b.style.display = '';
      b.style.transform = `translate(${p.x / dpr}px, ${p.y / dpr}px) translate(-50%, 26px)`;
    });
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
    const name = sel >= 0 ? hotspotsOf(current)[sel].label || byId.get(hotspotsOf(current)[sel].target).name : '';
    eyeLabels.forEach((s) => (s.textContent = controller.stereo ? name : ''));
  }

  function loop(now) {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    if (xrSession) return;
    updateGaze(now);
    if (!dirty && controller.mode !== 'gyro') return;
    dirty = false;
    const frame = controller.frame();
    renderer.draw({
      ...frame,
      hotSel: sel,
      dwell,
      hotSize: controller.stereo ? 0.09 : 0.07,
      reticle: controller.stereo || controller.mode === 'gyro' ? 9 * (canvas.width / canvas.clientWidth) : 0,
    });
    placeLabels(frame);
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
        const eyes = pose.views.map((view) => {
          const vp = layer.getViewport(view);
          const P = view.projectionMatrix;
          return {
            vp: [vp.x, vp.y, vp.width, vp.height],
            cam: mat3Mul(rot, toOurs(view.transform.matrix)),
            proj: [1 / P[0], P[8] / P[0], 1 / P[5], P[9] / P[5]],
          };
        });
        renderer.draw({ mode: 'persp', eyes, framebuffer: layer.framebuffer, hotSel: sel, dwell, hotSize: 0.09, reticle: 0 });
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

  const list = $('.ps-list');
  $('.ps-list-btn').addEventListener('click', () => {
    list.innerHTML = `<h3>${title || 'Photos'}</h3>`;
    photos.forEach((p) => {
      const b = el('button', 'ps-list-item' + (current && p.id === current.id ? ' active' : ''));
      b.textContent = p.name;
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
  });

  const hs = $('.ps-headset');
  const syncHeadset = () => {
    hs.querySelectorAll('input').forEach((i) => {
      i.value = controller.headset[i.name];
      i.previousElementSibling.textContent = i.name === 'eyeFov' ? i.value + '°' : i.value;
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
  setActive('touch');
  raf = requestAnimationFrame(loop);
  go(startId && byId.has(startId) ? startId : photos[0] && photos[0].id, false);

  return {
    go,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      if (xrSession) xrSession.end().catch(() => {});
      lockScreen(false);
      controller.dispose();
      renderer.dispose();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      root.remove();
    },
  };
}
